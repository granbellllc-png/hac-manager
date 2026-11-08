import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { projectName } from '@hacm/core';

export const healthSchema = z.object({
  status: z.literal('ok'),
  service: z.literal(projectName),
});

export async function healthModule(app: FastifyInstance): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/health',
    {
      schema: {
        operationId: 'getHealth',
        tags: ['health'],
        response: { 200: healthSchema },
      },
    },
    async () => ({ status: 'ok', service: projectName }) as const,
  );
}
