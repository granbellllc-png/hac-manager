import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { HostRegistry } from '../../hosts/registry.js';
import type { DatabaseRepositories } from '../../db/repositories/types.js';

export interface HostsModuleOptions {
  readonly hostRegistry: HostRegistry;
  readonly repos?: DatabaseRepositories | undefined;
}

const channelStatusSchema = z.object({
  status: z.enum(['unknown', 'connected', 'unreachable', 'error']),
  error: z.string().optional(),
  lastCheckedAt: z.string().optional(),
});

const runtimeStatusSchema = z.object({
  overall: z.enum(['unknown', 'healthy', 'degraded', 'unreachable', 'error']),
  ssh: channelStatusSchema,
  api: channelStatusSchema.extend({
    configured: z.boolean(),
  }),
  vault: z.object({
    status: z.enum(['not_configured', 'unlocked', 'locked']),
    error: z.string().optional(),
  }),
  queue: z.object({
    status: z.enum(['idle', 'busy', 'paused']),
    activeJobId: z.string().optional(),
  }),
  lastSeenAt: z.string().optional(),
  issues: z.array(z.string()).readonly(),
});

const hostSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.literal('proxmox'),
  index: z.number(),
  status: z.enum(['unknown', 'healthy', 'degraded', 'unreachable', 'error']),
  runtime: runtimeStatusSchema,
  updatedAt: z.string(),
});

const hostDetailSchema = hostSummarySchema.extend({
  connection: z.object({
    ssh: z.object({
      host: z.string(),
      port: z.number(),
      username: z.string(),
      fingerprint: z.string().optional(),
      authMethod: z.enum(['key', 'password', 'none']),
    }),
    api: z
      .object({
        url: z.string(),
        tokenId: z.string(),
        fingerprint: z.string().optional(),
        configured: z.boolean(),
      })
      .optional(),
  }),
  ignoredGuestsCount: z.number(),
  defaults: z
    .object({
      deployment: z.string().optional(),
      filemappings: z.string().optional(),
    })
    .optional(),
});

export const hostsModule: FastifyPluginAsyncZod<HostsModuleOptions> = async (
  app,
  options,
) => {
  const { hostRegistry } = options;

  app.get(
    '/api/hosts',
    {
      schema: {
        tags: ['Hosts'],
        summary: 'List available hosts',
        response: {
          200: z.object({
            hosts: z.array(hostSummarySchema),
          }),
        },
      },
    },
    async (request) => {
      const hosts = await hostRegistry.listHosts(request.user);
      return { hosts: [...hosts] };
    },
  );

  app.get(
    '/api/hosts/:id',
    {
      schema: {
        tags: ['Hosts'],
        summary: 'Get details for a single host',
        params: z.object({
          id: z.string(),
        }),
        response: {
          200: z.object({
            host: hostDetailSchema,
          }),
          403: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
          404: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const host = await hostRegistry.getHost(id, request.user);

      if (!host) {
        // Distinguish whether host exists but forbidden, or doesn't exist
        const raw = hostRegistry.getRawHost(id);
        if (raw) {
          return reply.status(403).send({
            statusCode: 403,
            error: 'Forbidden',
            message: `Access denied to host '${id}'`,
          });
        }
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Host '${id}' not found`,
        });
      }

      return { host };
    },
  );

  app.post(
    '/api/hosts/sync',
    {
      schema: {
        tags: ['Hosts'],
        summary: 'Trigger synchronization from host.yaml files',
        response: {
          200: z.object({
            ok: z.literal(true),
            synced: z.number(),
            removed: z.number(),
            issues: z.array(z.string()),
          }),
          403: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      if (request.user?.role === 'viewer') {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Viewers cannot trigger host synchronization',
        });
      }

      const result = await hostRegistry.sync();
      return {
        ok: true as const,
        synced: result.synced,
        removed: result.removed,
        issues: [...result.issues],
      };
    },
  );
};
