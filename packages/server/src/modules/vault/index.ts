import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { HostRegistry } from '../../hosts/registry.js';
import { VaultService } from '../../vault/service.js';
import {
  VaultProviderNotRequiredError,
  VaultUnlockFailedError,
} from '../../vault/types.js';

export interface VaultModuleOptions {
  readonly hostRegistry: HostRegistry;
  readonly vaultService: VaultService;
}

const providerSchema = z.object({
  id: z.string(),
  name: z.string(),
  commands: z.array(z.string()).readonly(),
  tokenLabel: z.string(),
  helpText: z.string(),
  status: z.enum(['unlocked', 'locked', 'unavailable']),
  reason: z.string().optional(),
});

const errorSchema = z.object({
  statusCode: z.number(),
  error: z.string(),
  message: z.string(),
});

export const vaultModule: FastifyPluginAsyncZod<VaultModuleOptions> = async (
  app,
  options,
) => {
  app.get(
    '/api/hosts/:hostId/vault/providers',
    {
      schema: {
        tags: ['Secrets'],
        summary: 'List unlockable vault providers required by a host',
        params: z.object({ hostId: z.string() }),
        response: {
          200: z.object({ providers: z.array(providerSchema) }),
          403: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const host = await options.hostRegistry.getHost(
        request.params.hostId,
        request.user,
      );
      if (!host) {
        if (options.hostRegistry.getRawHost(request.params.hostId)) {
          return reply.code(403).send({
            statusCode: 403,
            error: 'Forbidden',
            message: `Access denied to host '${request.params.hostId}'`,
          });
        }
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Host '${request.params.hostId}' not found`,
        });
      }
      return {
        providers: [...(await options.vaultService.listForHost(host.id))],
      };
    },
  );

  app.post(
    '/api/hosts/:hostId/vault/providers/:providerId/unlock',
    {
      schema: {
        tags: ['Secrets'],
        summary: 'Unlock a vault provider with an in-memory token',
        params: z.object({ hostId: z.string(), providerId: z.string() }),
        body: z.object({
          token: z
            .string()
            .min(1)
            .max(16 * 1024),
        }),
        response: {
          200: providerSchema,
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (request.user?.role !== 'admin') {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Only administrators may unlock vault providers',
        });
      }
      const host = await options.hostRegistry.getHost(
        request.params.hostId,
        request.user,
      );
      if (!host) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Host '${request.params.hostId}' not found`,
        });
      }
      try {
        return await options.vaultService.unlock(
          host.id,
          request.params.providerId,
          request.body.token,
          {
            id: request.user.id,
            username: request.user.username,
          },
        );
      } catch (error) {
        if (error instanceof VaultProviderNotRequiredError) {
          return reply.code(404).send({
            statusCode: 404,
            error: 'Not Found',
            message: error.message,
          });
        }
        if (error instanceof VaultUnlockFailedError) {
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
