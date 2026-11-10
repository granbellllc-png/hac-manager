import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { DatabaseRepositories } from '../../db/repositories/types.js';
import { verifyPassword } from '../../auth/password.js';
import { ApiTokenService } from '../../auth/api-token.js';

export interface TokensModuleOptions {
  readonly repos: DatabaseRepositories;
  readonly tokenService: ApiTokenService;
}

const scopeSchema = z.enum(['admin', 'operator', 'viewer']);
const tokenItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scope: scopeSchema,
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  lastUsedAt: z.string().optional(),
  revokedAt: z.string().optional(),
});
const errorSchema = z.object({
  statusCode: z.number(),
  error: z.string(),
  message: z.string(),
});

function sessionOnly(request: { readonly authMethod?: string }): boolean {
  return request.authMethod === 'session';
}

function validateExpiry(value: string | undefined, now: Date): Date | null {
  if (!value) return null;
  const expiry = new Date(value);
  const maximum = now.getTime() + 365 * 24 * 60 * 60 * 1000;
  if (
    Number.isNaN(expiry.getTime()) ||
    expiry.getTime() <= now.getTime() ||
    expiry.getTime() > maximum
  ) {
    return null;
  }
  return expiry;
}

export const tokensModule: FastifyPluginAsyncZod<TokensModuleOptions> = async (
  app,
  options,
) => {
  app.get(
    '/api/tokens',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'List personal API tokens',
        response: {
          200: z.object({
            items: z.array(tokenItemSchema),
            allowedScopes: z.array(scopeSchema),
          }),
          403: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!sessionOnly(request)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'API tokens can only be managed from a browser session',
        });
      }
      return {
        items: [...(await options.tokenService.list(request.user!.id))],
        allowedScopes: [...options.tokenService.scopesFor(request.user!.role)],
      };
    },
  );

  app.post(
    '/api/tokens',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Create a personal API token',
        body: z.object({
          name: z.string().trim().min(1).max(64),
          scope: scopeSchema,
          password: z.string().min(1).max(128),
          expiresAt: z.string().optional(),
        }),
        response: {
          201: z.object({ token: z.string(), item: tokenItemSchema }),
          400: errorSchema,
          403: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!sessionOnly(request)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'API tokens can only be created from a browser session',
        });
      }
      const user = await options.repos.users.getById(request.user!.id);
      if (
        !user ||
        !(await verifyPassword(user.passwordHash, request.body.password))
      ) {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Password does not match',
        });
      }
      const allowed = options.tokenService.scopesFor(user.role);
      if (!allowed.includes(request.body.scope)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Token scope '${request.body.scope}' exceeds the current user role`,
        });
      }
      const now = new Date();
      const expiresAt = validateExpiry(request.body.expiresAt, now);
      if (request.body.expiresAt && !expiresAt) {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Token expiry must be in the future and within one year',
        });
      }
      const created = await options.tokenService.create({
        user,
        name: request.body.name,
        scope: request.body.scope,
        ...(expiresAt ? { expiresAt } : {}),
      });
      await options.repos.auditLogs.append({
        userId: user.id,
        username: user.username,
        action: 'token.create',
        reason: 'manual',
        diff: {
          tokenId: created.item.id,
          name: created.item.name,
          scope: created.item.scope,
          expiresAt: created.item.expiresAt ?? null,
        },
      });
      return reply.code(201).send(created);
    },
  );

  app.delete(
    '/api/tokens/:tokenId',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Revoke a personal API token',
        params: z.object({ tokenId: z.string() }),
        response: {
          200: z.object({ revoked: z.literal(true) }),
          403: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!sessionOnly(request)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'API tokens can only be revoked from a browser session',
        });
      }
      const revoked = await options.tokenService.revoke(
        request.params.tokenId,
        request.user!.id,
      );
      if (!revoked) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'API token was not found or is already revoked',
        });
      }
      await options.repos.auditLogs.append({
        userId: request.user!.id,
        username: request.user!.username,
        action: 'token.revoke',
        reason: 'manual',
        diff: { tokenId: request.params.tokenId },
      });
      return { revoked: true as const };
    },
  );
};

export const tokenModuleInternals = {
  sessionOnly,
  validateExpiry,
  tokenItemSchema,
};
