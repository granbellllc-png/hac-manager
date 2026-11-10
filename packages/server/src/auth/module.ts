import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { DatabaseRepositories } from '../db/repositories/types.js';
import type { ServerConfig } from '../config.js';
import { hashPassword, verifyPassword } from './password.js';
import { resolveAppKey, encryptSecret, decryptSecret } from './encryption.js';
import {
  generateTotpSecret,
  generateTotpUri,
  generateTotpQrCode,
  verifyTotp,
  generateRecoveryCodes,
  hashRecoveryCode,
} from './totp.js';
import {
  SessionService,
  SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CSRF_COOKIE_NAME,
  type AuthenticatedUser,
} from './session.js';
import { LoginRateLimiter } from './rate-limit.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    sessionId?: string;
    authMethod?: 'session' | 'token';
    apiTokenId?: string;
  }
}

export interface AuthPluginOptions {
  readonly repos: DatabaseRepositories;
  readonly config: ServerConfig;
  readonly sessionService?: SessionService;
  readonly rateLimiter?: LoginRateLimiter;
}

export const authModule: FastifyPluginAsync<AuthPluginOptions> = async (
  fastify,
  options,
) => {
  const { repos, config } = options;
  const sessionService =
    options.sessionService ?? new SessionService(repos, config);
  const rateLimiter = options.rateLimiter ?? new LoginRateLimiter();
  const appKey = resolveAppKey(config);

  // Authentication & CSRF Hook
  fastify.addHook('onRequest', async (request, reply) => {
    if (request.user) return;
    const path = request.url.split('?')[0] ?? '/';

    // Public endpoints that do not require authentication:
    // /api/health, /api/auth/setup, /api/auth/status, /api/auth/login, /api/openapi.json
    const isPublic =
      path === '/api/health' ||
      path === '/api/openapi.json' ||
      path === '/api/auth/status' ||
      path === '/api/auth/setup' ||
      path === '/api/auth/login' ||
      !path.startsWith('/api/');

    if (isPublic) {
      // Still try to authenticate if session cookie is provided
      if (request.cookies?.[SESSION_COOKIE_NAME]) {
        const sessionCtx = await sessionService.authenticate(request);
        if (sessionCtx) {
          request.user = sessionCtx.user;
          request.sessionId = sessionCtx.session.id;
        }
      }
      return;
    }

    // Authenticate request
    const sessionCtx = await sessionService.authenticate(request);
    if (!sessionCtx) {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    request.user = sessionCtx.user;
    request.sessionId = sessionCtx.session.id;

    // CSRF verification for mutating requests (POST, PUT, PATCH, DELETE)
    const method = request.method.toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const headerCsrf = request.headers[CSRF_HEADER_NAME] as
        string | undefined;
      const cookieCsrf = request.cookies[CSRF_COOKIE_NAME];

      if (!headerCsrf || !cookieCsrf || headerCsrf !== cookieCsrf) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Invalid or missing CSRF token',
        });
      }
    }
  });

  const typedFastify = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/auth/status: Check if initial setup is needed, and return current user if logged in
  typedFastify.get(
    '/api/auth/status',
    {
      schema: {
        description: 'Check auth setup state and current session',
        tags: ['auth'],
        response: {
          200: z.object({
            setupNeeded: z.boolean(),
            user: z
              .object({
                id: z.string(),
                username: z.string(),
                role: z.string(),
                totpEnabled: z.boolean(),
              })
              .nullable(),
          }),
        },
      },
    },
    async (request) => {
      const userCount = await repos.users.count();
      return {
        setupNeeded: userCount === 0,
        user: request.user
          ? {
              id: request.user.id,
              username: request.user.username,
              role: request.user.role,
              totpEnabled: Boolean(request.user.totpEnabled),
            }
          : null,
      };
    },
  );

  // POST /api/auth/setup: First-run initial admin creation flow (locked after first user exists)
  typedFastify.post(
    '/api/auth/setup',
    {
      schema: {
        description: 'First-run setup: create the initial admin user',
        tags: ['auth'],
        body: z.object({
          username: z.string().trim().min(3).max(64),
          password: z.string().min(8).max(128),
        }),
        response: {
          201: z.object({
            message: z.string(),
            user: z.object({
              id: z.string(),
              username: z.string(),
              role: z.string(),
            }),
          }),
          409: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const userCount = await repos.users.count();
      if (userCount > 0) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Initial admin already exists. Setup is locked.',
        });
      }

      const { username, password } = request.body;
      const passwordHash = await hashPassword(password);
      const now = new Date();

      const user = await repos.users.create({
        id: randomUUID(),
        username,
        passwordHash,
        role: 'admin',
        autoGrantNewHosts: true,
        createdAt: now,
        updatedAt: now,
      });

      // Automatically log in the newly created admin
      await sessionService.createSession(user, request, reply);

      return reply.status(201).send({
        message: 'Admin user created successfully',
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
        },
      });
    },
  );

  // POST /api/auth/login: Local account login with rate limiting & lockout
  typedFastify.post(
    '/api/auth/login',
    {
      schema: {
        description: 'Log in with local credentials',
        tags: ['auth'],
        body: z.object({
          username: z.string().trim().min(1),
          password: z.string().min(1),
          totpCode: z.string().trim().optional(),
          recoveryCode: z.string().trim().optional(),
        }),
        response: {
          200: z.object({
            message: z.string(),
            totpRequired: z.boolean().optional(),
            user: z
              .object({
                id: z.string(),
                username: z.string(),
                role: z.string(),
              })
              .optional(),
          }),
          401: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
          429: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { username, password, totpCode, recoveryCode } = request.body;
      const rateKey = `${request.ip}:${username.toLowerCase()}`;

      if (rateLimiter.isLocked(rateKey)) {
        return reply.status(429).send({
          statusCode: 429,
          error: 'Too Many Requests',
          message:
            'Too many failed login attempts. Account temporarily locked.',
        });
      }

      const user = await repos.users.getByUsername(username);
      if (!user) {
        rateLimiter.recordFailure(rateKey);
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Invalid username or password',
        });
      }

      const valid = await verifyPassword(user.passwordHash, password);
      if (!valid) {
        const { locked } = rateLimiter.recordFailure(rateKey);
        if (locked) {
          return reply.status(429).send({
            statusCode: 429,
            error: 'Too Many Requests',
            message:
              'Too many failed login attempts. Account temporarily locked.',
          });
        }
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Invalid username or password',
        });
      }

      if (user.totpEnabled) {
        if (!totpCode && !recoveryCode) {
          return {
            message: 'Two-factor authentication code required',
            totpRequired: true,
          };
        }

        if (totpCode) {
          if (!user.totpSecret) {
            return reply.status(401).send({
              statusCode: 401,
              error: 'Unauthorized',
              message: 'Two-factor authentication secret missing',
            });
          }

          let secretPlain: string;
          try {
            secretPlain = decryptSecret(user.totpSecret, appKey);
          } catch {
            return reply.status(401).send({
              statusCode: 401,
              error: 'Unauthorized',
              message: 'Failed to decrypt two-factor authentication secret',
            });
          }

          const validTotp = verifyTotp(secretPlain, totpCode);
          if (!validTotp) {
            const { locked } = rateLimiter.recordFailure(rateKey);
            if (locked) {
              return reply.status(429).send({
                statusCode: 429,
                error: 'Too Many Requests',
                message:
                  'Too many failed login attempts. Account temporarily locked.',
              });
            }
            return reply.status(401).send({
              statusCode: 401,
              error: 'Unauthorized',
              message: 'Invalid two-factor authentication code',
            });
          }
        } else if (recoveryCode) {
          const used = await repos.recoveryCodes.useCode(user.id, recoveryCode);
          if (!used) {
            const { locked } = rateLimiter.recordFailure(rateKey);
            if (locked) {
              return reply.status(429).send({
                statusCode: 429,
                error: 'Too Many Requests',
                message:
                  'Too many failed login attempts. Account temporarily locked.',
              });
            }
            return reply.status(401).send({
              statusCode: 401,
              error: 'Unauthorized',
              message: 'Invalid recovery code',
            });
          }
        }
      }

      rateLimiter.recordSuccess(rateKey);
      await sessionService.createSession(user, request, reply);

      return {
        message: recoveryCode
          ? 'Logged in successfully with recovery code'
          : 'Logged in successfully',
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
        },
      };
    },
  );

  // POST /api/auth/logout: Destroy active session
  typedFastify.post(
    '/api/auth/logout',
    {
      schema: {
        description: 'Log out current session',
        tags: ['auth'],
        response: {
          200: z.object({
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      await sessionService.destroySession(request, reply);
      return { message: 'Logged out successfully' };
    },
  );

  // POST /api/auth/logout-everywhere: Invalidate all sessions for current user
  typedFastify.post(
    '/api/auth/logout-everywhere',
    {
      schema: {
        description: 'Log out all sessions for the current user',
        tags: ['auth'],
        response: {
          200: z.object({
            message: z.string(),
            count: z.number(),
          }),
          401: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Authentication required',
        });
      }

      const count = await sessionService.destroyAllUserSessions(
        request.user.id,
        reply,
      );
      return {
        message: 'All sessions invalidated',
        count,
      };
    },
  );

  // POST /api/auth/password: Change password for current user
  typedFastify.post(
    '/api/auth/password',
    {
      schema: {
        description: 'Change password for current user',
        tags: ['auth'],
        body: z.object({
          currentPassword: z.string().min(1),
          newPassword: z.string().min(8).max(128),
        }),
        response: {
          200: z.object({
            message: z.string(),
          }),
          400: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
          401: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Authentication required',
        });
      }

      const user = await repos.users.getById(request.user.id);
      if (!user) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'User not found',
        });
      }

      const { currentPassword, newPassword } = request.body;
      const valid = await verifyPassword(user.passwordHash, currentPassword);
      if (!valid) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Current password does not match',
        });
      }

      const newHash = await hashPassword(newPassword);
      await repos.users.updatePassword(user.id, newHash);

      return { message: 'Password updated successfully' };
    },
  );

  // GET /api/auth/totp/status: Get current user 2FA status
  typedFastify.get(
    '/api/auth/totp/status',
    {
      schema: {
        description: 'Get current user two-factor authentication status',
        tags: ['auth'],
        response: {
          200: z.object({
            enabled: z.boolean(),
            remainingRecoveryCodes: z.number(),
          }),
          401: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Authentication required',
        });
      }
      const user = await repos.users.getById(request.user.id);
      const remainingRecoveryCodes = await repos.recoveryCodes.countRemaining(
        request.user.id,
      );
      return {
        enabled: Boolean(user?.totpEnabled),
        remainingRecoveryCodes,
      };
    },
  );

  // POST /api/auth/totp/setup: Initiate enrollment (generates secret, QR code, and recovery codes)
  typedFastify.post(
    '/api/auth/totp/setup',
    {
      schema: {
        description:
          'Initialize two-factor authentication setup for current user',
        tags: ['auth'],
        response: {
          200: z.object({
            secret: z.string(),
            uri: z.string(),
            qrCode: z.string(),
            recoveryCodes: z.array(z.string()),
          }),
          401: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Authentication required',
        });
      }

      const secret = generateTotpSecret();
      const uri = generateTotpUri(request.user.username, secret);
      const qrCode = await generateTotpQrCode(uri);
      const recoveryCodes = generateRecoveryCodes(8);

      const encryptedSecret = encryptSecret(secret, appKey);
      const hashedCodes = recoveryCodes.map((code) => hashRecoveryCode(code));

      await repos.users.setTotpSecret(request.user.id, encryptedSecret);
      await repos.recoveryCodes.setCodes(request.user.id, hashedCodes);

      return {
        secret,
        uri,
        qrCode,
        recoveryCodes,
      };
    },
  );

  // POST /api/auth/totp/enable: Verify code and activate 2FA
  typedFastify.post(
    '/api/auth/totp/enable',
    {
      schema: {
        description:
          'Confirm and enable two-factor authentication with initial verification code',
        tags: ['auth'],
        body: z.object({
          code: z.string().trim().min(6).max(8),
        }),
        response: {
          200: z.object({
            message: z.string(),
          }),
          400: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
          401: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Authentication required',
        });
      }

      const user = await repos.users.getById(request.user.id);
      if (!user || !user.totpSecret) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Two-factor authentication setup not initiated',
        });
      }

      let secretPlain: string;
      try {
        secretPlain = decryptSecret(user.totpSecret, appKey);
      } catch {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Failed to decrypt two-factor authentication secret',
        });
      }

      const valid = verifyTotp(secretPlain, request.body.code);
      if (!valid) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Invalid verification code',
        });
      }

      await repos.users.setTotpEnabled(request.user.id, true);

      return {
        message: 'Two-factor authentication enabled successfully',
      };
    },
  );

  // POST /api/auth/totp/disable: Disable 2FA with password confirmation
  typedFastify.post(
    '/api/auth/totp/disable',
    {
      schema: {
        description:
          'Disable two-factor authentication with user password confirmation',
        tags: ['auth'],
        body: z.object({
          password: z.string().min(1),
        }),
        response: {
          200: z.object({
            message: z.string(),
          }),
          400: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
          401: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Authentication required',
        });
      }

      const user = await repos.users.getById(request.user.id);
      if (!user) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'User not found',
        });
      }

      const validPassword = await verifyPassword(
        user.passwordHash,
        request.body.password,
      );
      if (!validPassword) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Password does not match',
        });
      }

      await repos.users.setTotpEnabled(request.user.id, false);
      await repos.users.setTotpSecret(request.user.id, null);
      await repos.recoveryCodes.deleteByUser(request.user.id);

      return {
        message: 'Two-factor authentication disabled successfully',
      };
    },
  );

  // POST /api/auth/totp/recovery-codes: Regenerate recovery codes
  typedFastify.post(
    '/api/auth/totp/recovery-codes',
    {
      schema: {
        description: 'Regenerate recovery codes with password verification',
        tags: ['auth'],
        body: z.object({
          password: z.string().min(1),
        }),
        response: {
          200: z.object({
            recoveryCodes: z.array(z.string()),
          }),
          400: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
          401: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Authentication required',
        });
      }

      const user = await repos.users.getById(request.user.id);
      if (!user) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'User not found',
        });
      }

      if (!user.totpEnabled) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Two-factor authentication is not enabled',
        });
      }

      const validPassword = await verifyPassword(
        user.passwordHash,
        request.body.password,
      );
      if (!validPassword) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Password does not match',
        });
      }

      const newCodes = generateRecoveryCodes(8);
      const hashedCodes = newCodes.map((code) => hashRecoveryCode(code));
      await repos.recoveryCodes.setCodes(request.user.id, hashedCodes);

      return {
        recoveryCodes: newCodes,
      };
    },
  );
};
