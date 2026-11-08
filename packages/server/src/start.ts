import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';
import type { FastifyInstance } from 'fastify';

export async function startServer(
  config: ServerConfig,
  signal?: AbortSignal,
): Promise<FastifyInstance> {
  const app = await buildApp(config);
  const close = () => {
    void app
      .close()
      .catch((error: unknown) =>
        app.log.error({ err: error }, 'Shutdown failed'),
      );
  };
  app.addHook('onClose', async () => {
    signal?.removeEventListener('abort', close);
  });
  try {
    await app.listen({ host: config.HACM_HOST, port: config.HACM_PORT });
    if (signal?.aborted) {
      await app.close();
    } else {
      signal?.addEventListener('abort', close, { once: true });
    }
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
