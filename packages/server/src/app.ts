import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import swagger from '@fastify/swagger';
import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import websocket from '@fastify/websocket';
import { SecretManager } from '@hacm/core';
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
import { inventoryModule } from './modules/inventory/index.js';
import { configEditorModule } from './modules/config-editor/index.js';
import { eventsModule } from './modules/events/index.js';
import { promptsModule } from './modules/prompts/index.js';
import { plansModule } from './modules/plans/index.js';
import { jobsModule } from './modules/jobs/index.js';
import { driftModule } from './modules/drift/index.js';
import { storageModule } from './modules/storage/index.js';
import { vaultModule } from './modules/vault/index.js';
import { consoleModule } from './modules/console/index.js';
import { tokensModule } from './modules/tokens/index.js';
import { HostRegistry } from './hosts/registry.js';
import { ConnectionManager } from './router/manager.js';
import { LiveInventoryService } from './inventory/service.js';
import { GuestLifecycleService } from './guests/service.js';
import { authModule } from './auth/module.js';
import { DurableJobQueue } from './jobs/queue.js';
import { JobEventBroker } from './events/job-events.js';
import { PromptService } from './prompts/service.js';
import { PlanService } from './plans/service.js';
import { DriftService } from './drift/service.js';
import { StorageInvariantService } from './storage/service.js';
import { DriftScheduler } from './scheduler/service.js';
import { VaultService } from './vault/service.js';
import { ConsoleService } from './console/service.js';
import { ApiTokenService } from './auth/api-token.js';
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
  readonly connectionManager?: ConnectionManager;
  readonly inventoryService?: LiveInventoryService;
  readonly guestLifecycleService?: GuestLifecycleService;
  readonly jobQueue?: DurableJobQueue;
  readonly eventBroker?: JobEventBroker;
  readonly eventsHeartbeatMs?: number | undefined;
  readonly promptService?: PromptService;
  readonly planService?: PlanService;
  readonly driftService?: DriftService;
  readonly storageInvariantService?: StorageInvariantService;
  readonly scheduler?: DriftScheduler;
  readonly vaultService?: VaultService;
  readonly consoleService?: ConsoleService;
  readonly apiTokenService?: ApiTokenService;
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
  await app.register(websocket, {
    options: { maxPayload: 64 * 1024 },
  });

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
  let closeOwnedDatabase: (() => void) | undefined;
  if ('repositories' in configOrOptions && configOrOptions.repositories) {
    repositories = configOrOptions.repositories;
  } else {
    const dbPath = join(config.HACM_STATE_DIR, 'hacm.sqlite');
    const dbHandle = createDatabase({ path: dbPath });
    closeOwnedDatabase = dbHandle.close;
    repositories = createSqliteRepositories(dbHandle.db);
  }

  const jobQueue =
    'jobQueue' in configOrOptions && configOrOptions.jobQueue
      ? configOrOptions.jobQueue
      : new DurableJobQueue(repositories);
  await jobQueue.recoverInterrupted();
  app.decorate('jobQueue', jobQueue);
  const eventBroker =
    'eventBroker' in configOrOptions && configOrOptions.eventBroker
      ? configOrOptions.eventBroker
      : new JobEventBroker(jobQueue);
  app.decorate('eventBroker', eventBroker);
  const promptService =
    'promptService' in configOrOptions && configOrOptions.promptService
      ? configOrOptions.promptService
      : new PromptService(repositories, eventBroker, (jobId) =>
          jobQueue.resumeWaitingJob(jobId),
        );
  jobQueue.setPromptHandler((job, request, signal) =>
    promptService.request({
      ...request,
      jobId: job.id,
      signal,
    }),
  );
  app.decorate('promptService', promptService);

  const sessionService = new SessionService(repositories, config);
  const rateLimiter = new LoginRateLimiter();
  const apiTokenService =
    'apiTokenService' in configOrOptions && configOrOptions.apiTokenService
      ? configOrOptions.apiTokenService
      : new ApiTokenService(repositories);
  app.decorate('apiTokenService', apiTokenService);

  const authenticateRequest = async (
    request: Parameters<SessionService['authenticate']>[0],
  ) => {
    const authorization = request.headers.authorization;
    const token = await apiTokenService.authenticate(
      typeof authorization === 'string' ? authorization : undefined,
    );
    if (token.status === 'authenticated') {
      request.user = token.user;
      request.authMethod = 'token';
      request.apiTokenId = token.tokenId;
      return true;
    }
    if (token.status === 'invalid') return false;
    const session = await sessionService.authenticate(request);
    if (!session) return false;
    request.user = session.user;
    request.sessionId = session.session.id;
    request.authMethod = 'session';
    return true;
  };

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
      if (
        request.headers.authorization ||
        request.cookies?.[SESSION_COOKIE_NAME]
      ) {
        await authenticateRequest(request);
      }
      if (
        request.authMethod === 'token' &&
        path.startsWith('/api/auth/') &&
        path !== '/api/auth/status'
      ) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'API tokens cannot manage browser authentication state',
        });
      }
      return;
    }

    if (!(await authenticateRequest(request))) {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }
    if (
      request.authMethod === 'token' &&
      path.startsWith('/api/auth/') &&
      path !== '/api/auth/status'
    ) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'API tokens cannot manage browser authentication state',
      });
    }

    const method = request.method.toUpperCase();
    if (
      request.authMethod === 'session' &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
    ) {
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

  const connectionManager =
    'connectionManager' in configOrOptions && configOrOptions.connectionManager
      ? configOrOptions.connectionManager
      : new ConnectionManager({
          dataDir: config.HACM_DATA_DIR,
          hostRegistry,
          secretManager: new SecretManager({
            dataDir: config.HACM_DATA_DIR,
            ttlMs: config.HACM_SECRET_TTL_SECONDS * 1000,
          }),
        });
  app.decorate('connectionManager', connectionManager);
  const consoleService =
    'consoleService' in configOrOptions && configOrOptions.consoleService
      ? configOrOptions.consoleService
      : new ConsoleService(connectionManager, repositories, {
          idleTimeoutMs: config.HACM_CONSOLE_IDLE_SECONDS * 1000,
        });
  app.decorate('consoleService', consoleService);
  const vaultService =
    'vaultService' in configOrOptions && configOrOptions.vaultService
      ? configOrOptions.vaultService
      : new VaultService(
          connectionManager.secretManager ??
            new SecretManager({
              dataDir: config.HACM_DATA_DIR,
              ttlMs: config.HACM_SECRET_TTL_SECONDS * 1000,
            }),
          hostRegistry,
          repositories,
        );
  jobQueue.setPreflightHandler((context) => vaultService.preflight(context));
  app.decorate('vaultService', vaultService);

  const inventoryService =
    'inventoryService' in configOrOptions && configOrOptions.inventoryService
      ? configOrOptions.inventoryService
      : new LiveInventoryService({
          hostRegistry,
          connectionManager,
        });
  app.decorate('inventoryService', inventoryService);
  const guestLifecycleService =
    'guestLifecycleService' in configOrOptions &&
    configOrOptions.guestLifecycleService
      ? configOrOptions.guestLifecycleService
      : new GuestLifecycleService({
          inventory: inventoryService,
          connections: connectionManager,
          hostRegistry,
          protectedGuest: {
            ...(config.HACM_PROTECTED_HOST_ID
              ? { hostId: config.HACM_PROTECTED_HOST_ID }
              : {}),
            ...(config.HACM_PROTECTED_GUEST_ID
              ? { vmid: config.HACM_PROTECTED_GUEST_ID }
              : {}),
          },
        });
  app.decorate('guestLifecycleService', guestLifecycleService);
  const planService =
    'planService' in configOrOptions && configOrOptions.planService
      ? configOrOptions.planService
      : new PlanService(
          repositories,
          jobQueue,
          inventoryService,
          hostRegistry,
          guestLifecycleService,
          connectionManager,
        );
  planService.registerQueueHandler();
  app.decorate('planService', planService);
  const driftService =
    'driftService' in configOrOptions && configOrOptions.driftService
      ? configOrOptions.driftService
      : new DriftService({
          repos: repositories,
          hostRegistry,
          inventoryService,
          connections: connectionManager,
        });
  app.decorate('driftService', driftService);
  const storageInvariantService =
    'storageInvariantService' in configOrOptions &&
    configOrOptions.storageInvariantService
      ? configOrOptions.storageInvariantService
      : new StorageInvariantService({
          repos: repositories,
          queue: jobQueue,
          hostRegistry,
          connections: connectionManager,
        });
  storageInvariantService.registerQueueHandler();
  app.decorate('storageInvariantService', storageInvariantService);
  const scheduler =
    'scheduler' in configOrOptions && configOrOptions.scheduler
      ? configOrOptions.scheduler
      : new DriftScheduler(
          repositories,
          jobQueue,
          hostRegistry,
          inventoryService,
          {
            onError: (error) =>
              app.log.error({ err: error }, 'Drift scheduler tick failed'),
            driftService,
          },
        );
  scheduler.registerQueueHandler();
  app.decorate('scheduler', scheduler);

  app.addHook('onClose', async () => {
    scheduler.stop();
    eventBroker.close();
    await jobQueue.stop({ interruptRunning: true });
    hostRegistry.close();
    await connectionManager.close();
    closeOwnedDatabase?.();
  });

  // Register Modules
  await app.register(healthModule);
  await app.register(usersModule, { repos: repositories });
  await app.register(auditModule, { repos: repositories });
  await app.register(hostsModule, {
    hostRegistry,
    connectionManager,
    repos: repositories,
  });
  await app.register(inventoryModule, {
    inventoryService,
    hostRegistry,
    repos: repositories,
    guestLifecycleService,
  });
  await app.register(driftModule, {
    driftService,
    planService,
    hostRegistry,
  });
  await app.register(storageModule, {
    storageInvariantService,
    hostRegistry,
  });
  await app.register(configEditorModule, {
    hostRegistry,
    repos: repositories,
  });
  await app.register(eventsModule, {
    repos: repositories,
    hostRegistry,
    broker: eventBroker,
    ...('eventsHeartbeatMs' in configOrOptions &&
    configOrOptions.eventsHeartbeatMs !== undefined
      ? { heartbeatMs: configOrOptions.eventsHeartbeatMs }
      : {}),
  });
  await app.register(promptsModule, {
    hostRegistry,
    promptService,
  });
  await app.register(vaultModule, {
    hostRegistry,
    vaultService,
  });
  await app.register(consoleModule, {
    hostRegistry,
    consoleService,
  });
  await app.register(tokensModule, {
    repos: repositories,
    tokenService: apiTokenService,
  });
  await app.register(plansModule, {
    hostRegistry,
    planService,
  });
  await app.register(jobsModule, {
    repos: repositories,
    hostRegistry,
    queue: jobQueue,
    promptService,
  });

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
