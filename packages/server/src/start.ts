import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';
import type { FastifyInstance } from 'fastify';
import type { DurableJobQueue } from './jobs/queue.js';
import type { DriftScheduler } from './scheduler/service.js';

type RuntimeApp = FastifyInstance & {
  readonly jobQueue: DurableJobQueue;
  readonly scheduler: DriftScheduler;
};

export async function startServer(
  config: ServerConfig,
  signal?: AbortSignal,
): Promise<FastifyInstance> {
  const app = await buildApp(config);
  const runtime = app as RuntimeApp;
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
    await runtime.jobQueue.start();
    runtime.scheduler.start();
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
