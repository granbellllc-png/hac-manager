import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { HostRegistry } from '../../hosts/registry.js';
import { PromptService } from '../../prompts/service.js';
import {
  PromptExpiredError,
  PromptValidationError,
} from '../../prompts/types.js';

export interface PromptsModuleOptions {
  readonly hostRegistry: HostRegistry;
  readonly promptService: PromptService;
}

const resolutionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('choice'), choice: z.string() }),
  z.object({ kind: z.literal('confirm'), confirmed: z.boolean() }),
  z.object({ kind: z.literal('typed_confirmation'), text: z.string() }),
]);

const promptSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  hostId: z.string(),
  vmid: z.number().optional(),
  kind: z.enum(['choice', 'confirm', 'typed_confirmation']),
  status: z.enum(['pending', 'resolved', 'expired']),
  message: z.string(),
  payload: z.unknown(),
  options: z.array(z.string()).readonly(),
  resolution: resolutionSchema.optional(),
  resolvedBy: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  resolvedAt: z.string().optional(),
});

const errorSchema = z.object({
  statusCode: z.number(),
  error: z.string(),
  message: z.string(),
});

export const promptsModule: FastifyPluginAsyncZod<
  PromptsModuleOptions
> = async (app, options) => {
  app.get(
    '/api/prompts',
    {
      schema: {
        tags: ['Jobs'],
        summary: 'List pending prompts for granted hosts',
        response: {
          200: z.object({ prompts: z.array(promptSchema) }),
        },
      },
    },
    async (request) => {
      const allowed = new Set(
        (await options.hostRegistry.listHosts(request.user)).map(
          (host) => host.id,
        ),
      );
      const prompts = (await options.promptService.listPending()).filter(
        (prompt) => allowed.has(prompt.hostId),
      );
      return { prompts };
    },
  );

  app.get(
    '/api/prompts/:promptId',
    {
      schema: {
        tags: ['Jobs'],
        summary: 'Get one prompt',
        params: z.object({ promptId: z.string() }),
        response: {
          200: promptSchema,
          403: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const prompt = await options.promptService.get(request.params.promptId);
      if (!prompt) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Prompt '${request.params.promptId}' was not found`,
        });
      }
      const allowed = await options.hostRegistry.listHosts(request.user);
      if (!allowed.some((host) => host.id === prompt.hostId)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${prompt.hostId}'`,
        });
      }
      return prompt;
    },
  );

  app.post(
    '/api/prompts/:promptId/resolve',
    {
      schema: {
        tags: ['Jobs'],
        summary: 'Resolve a pending prompt',
        params: z.object({ promptId: z.string() }),
        body: resolutionSchema,
        response: {
          200: promptSchema,
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          410: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (request.user?.role === 'viewer') {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Viewer role cannot resolve prompts',
        });
      }
      const prompt = await options.promptService.get(request.params.promptId);
      if (!prompt) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Prompt '${request.params.promptId}' was not found`,
        });
      }
      const allowed = await options.hostRegistry.listHosts(request.user);
      if (!allowed.some((host) => host.id === prompt.hostId)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${prompt.hostId}'`,
        });
      }

      try {
        return await options.promptService.resolve(
          request.params.promptId,
          {
            id: request.user!.id,
            username: request.user!.username,
          },
          request.body,
        );
      } catch (error) {
        if (error instanceof PromptExpiredError) {
          return reply.code(410).send({
            statusCode: 410,
            error: 'Gone',
            message: error.message,
          });
        }
        if (error instanceof PromptValidationError) {
          return reply.code(400).send({
            statusCode: 400,
            error: 'Bad Request',
            message: error.message,
          });
        }
        throw error;
      }
    },
  );
};
