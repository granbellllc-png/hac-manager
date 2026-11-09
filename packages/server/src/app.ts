import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import swagger from '@fastify/swagger';
import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import {
  validatorCompiler,
  serializerCompiler,
  jsonSchemaTransform,
  jsonSchemaTransformObject,
} from 'fastify-type-provider-zod';
import type { ServerConfig } from './config.js';
import { createLogger } from './logger.js';
import { healthModule } from './modules/health/index.js';
import { usersModule } from './modules/users/index.js';
import { auditModule } from './modules/audit/index.js';
import { hostsModule } from './modules/hosts/index.js';
import { HostRegistry } from './hosts/registry.js';
import { authModule } from './auth/module.js';
import {
  SessionService,
  SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CSRF_COOKIE_NAME,
} from './auth/session.js';
import { LoginRateLimiter } from './auth/rate-limit.js';
import {
  createDatabase,
  createSqliteRepositories,
  type DatabaseRepositories,
} from './db/index.js';

export interface BuildAppOptions {
  readonly config: ServerConfig;
  readonly logger?: FastifyBaseLogger;
  readonly repositories?: DatabaseRepositories;
  readonly hostRegistry?: HostRegistry;
}

export async function buildApp(
  configOrOptions: ServerConfig | BuildAppOptions,
  legacyLogger?: FastifyBaseLogger,
): Promise<FastifyInstance> {
  const config =
    'HACM_DATA_DIR' in configOrOptions
      ? configOrOptions
      : configOrOptions.config;
  const logger =
    legacyLogger ??
    ('logger' in configOrOptions && configOrOptions.logger
      ? configOrOptions.logger
      : createLogger(config));

  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    bodyLimit: 1024 * 1024,
  });

  // Security headers with Helmet (CSP configured for SPA)
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    frameguard: { action: 'deny' },
    crossOriginEmbedderPolicy: false,
  });

  // Cookies plugin
  if (config.HACM_SESSION_SECRET) {
    await app.register(cookie, {
      secret: config.HACM_SESSION_SECRET,
    });
  } else {
    await app.register(cookie);
  }

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      info: { title: 'HAC Manager API', version: '0.0.0' },
      openapi: '3.1.0',
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  // Setup database & repositories
  let repositories: DatabaseRepositories;
  if ('repositories' in configOrOptions && configOrOptions.repositories) {
    repositories = configOrOptions.repositories;
  } else {
    const dbPath = join(config.HACM_STATE_DIR, 'hacm.sqlite');
    const dbHandle = createDatabase({ path: dbPath });
    app.addHook('onClose', async () => {
      dbHandle.close();
    });
    repositories = createSqliteRepositories(dbHandle.db);
  }

  const sessionService = new SessionService(repositories, config);
  const rateLimiter = new LoginRateLimiter();

  // Authentication & CSRF Hook at app level so routes added anywhere are protected
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '/';

    const isPublic =
      path === '/api/health' ||
      path === '/api/openapi.json' ||
      path === '/api/auth/status' ||
      path === '/api/auth/setup' ||
      path === '/api/auth/login' ||
      !path.startsWith('/api/');

    if (isPublic) {
      if (request.cookies?.[SESSION_COOKIE_NAME]) {
        const sessionCtx = await sessionService.authenticate(request);
        if (sessionCtx) {
          request.user = sessionCtx.user;
          request.sessionId = sessionCtx.session.id;
        }
      }
      return;
    }

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

  const hostRegistry =
    'hostRegistry' in configOrOptions && configOrOptions.hostRegistry
      ? configOrOptions.hostRegistry
      : new HostRegistry({
          dataDir: config.HACM_DATA_DIR,
          repos: repositories,
          autoWatch: false,
        });

  await hostRegistry.sync();
  app.decorate('hostRegistry', hostRegistry);
  app.addHook('onClose', async () => {
    hostRegistry.close();
  });

  // Register Modules
  await app.register(healthModule);
  await app.register(usersModule, { repos: repositories });
  await app.register(auditModule, { repos: repositories });
  await app.register(hostsModule, { hostRegistry, repos: repositories });

  await app.register(authModule, {
    repos: repositories,
    config,
    sessionService,
    rateLimiter,
  });

  app.get('/api/openapi.json', { schema: { hide: true } }, async () =>
    app.swagger(),
  );

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  if (config.HACM_WEB_DIR) {
    await app.register(fastifyStatic, {
      root: config.HACM_WEB_DIR,
      wildcard: false,
      dotfiles: 'deny',
    });
    app.setNotFoundHandler(async (request, reply) => {
      const path = request.url.split('?')[0] ?? '/';
      if (
        request.method === 'GET' &&
        !path.startsWith('/api') &&
        !path.includes('.') &&
        request.headers.accept?.includes('text/html')
      ) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Route not found',
      });
    });
  }
  return app;
}
