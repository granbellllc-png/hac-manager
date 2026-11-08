import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import swagger from '@fastify/swagger';
import fastifyStatic from '@fastify/static';
import {
  validatorCompiler,
  serializerCompiler,
  jsonSchemaTransform,
  jsonSchemaTransformObject,
} from 'fastify-type-provider-zod';
import type { ServerConfig } from './config.js';
import { createLogger } from './logger.js';
import { healthModule } from './modules/health/index.js';

export async function buildApp(
  config: ServerConfig,
  logger: FastifyBaseLogger = createLogger(config),
): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    bodyLimit: 1024 * 1024,
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
  await app.register(healthModule);
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
