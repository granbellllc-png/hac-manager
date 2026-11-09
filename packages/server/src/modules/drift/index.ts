import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { HostRegistry } from '../../hosts/registry.js';
import {
  DriftGuestNotFoundError,
  type DriftService,
} from '../../drift/index.js';

export interface DriftModuleOptions {
  readonly driftService: DriftService;
  readonly hostRegistry: HostRegistry;
}

const driftCategorySchema = z.enum([
  'config',
  'network',
  'disk',
  'mount',
  'feature',
  'tags',
  'protection',
  'cloud_init',
  'identity',
]);

const driftChangeSchema = z.object({
  path: z.string(),
  category: driftCategorySchema,
  kind: z.enum(['changed', 'missing_in_live', 'missing_in_yaml']),
  desired: z.unknown(),
  actual: z.unknown(),
  pullable: z.boolean(),
  computed: z.boolean(),
  secret: z.boolean(),
  tag: z.enum(['env', 'secret', 'expr', 'cmd', 'include']).optional(),
  provenance: z
    .object({
      layer: z.enum(['default', 'override']),
      file: z.string(),
      path: z.string(),
      sourcePath: z.string(),
    })
    .optional(),
  desiredHash: z.string().optional(),
  actualHash: z.string().optional(),
  warnings: z.array(z.string()).readonly().optional(),
});

const driftSnapshotSchema = z.object({
  id: z.string(),
  hostId: z.string(),
  vmid: z.number(),
  type: z.enum(['lxc', 'vm']),
  status: z.enum(['in_sync', 'drifted']),
  changes: z.array(driftChangeSchema).readonly(),
  computedFields: z.array(z.string()).readonly(),
  ignoredPaths: z.array(z.string()).readonly(),
  checkedAt: z.string(),
});

const forbiddenSchema = z.object({
  statusCode: z.number(),
  error: z.string(),
  message: z.string(),
});

const notFoundSchema = forbiddenSchema;
const conflictSchema = forbiddenSchema;

export const driftModule: FastifyPluginAsyncZod<DriftModuleOptions> = async (
  app,
  options,
) => {
  const { driftService, hostRegistry } = options;

  const canAccessHost = async (
    user: Parameters<HostRegistry['listHosts']>[0],
    hostId: string,
  ): Promise<boolean> => {
    const hosts = await hostRegistry.listHosts(user);
    return hosts.some((host) => host.id === hostId);
  };

  app.get(
    '/api/drift',
    {
      schema: {
        tags: ['Drift'],
        summary: 'List the latest persisted drift snapshots',
        querystring: z.object({
          hostId: z.string().optional(),
          status: z.enum(['in_sync', 'drifted']).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
        response: {
          200: z.object({
            snapshots: z.array(driftSnapshotSchema).readonly(),
          }),
          403: forbiddenSchema,
        },
      },
    },
    async (request, reply) => {
      const { hostId, status, limit } = request.query;
      if (hostId && !(await canAccessHost(request.user, hostId))) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${hostId}'`,
        });
      }

      const allowedHosts = await hostRegistry.listHosts(request.user);
      const allowedIds = new Set(allowedHosts.map((host) => host.id));
      const snapshots = await driftService.list({
        ...(hostId ? { hostId } : {}),
        ...(status ? { statuses: [status] } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return {
        snapshots: snapshots.filter((snapshot) =>
          allowedIds.has(snapshot.hostId),
        ),
      };
    },
  );

  app.get(
    '/api/drift/:hostId/:vmid',
    {
      schema: {
        tags: ['Drift'],
        summary: 'Get the latest persisted drift snapshot for a guest',
        params: z.object({
          hostId: z.string(),
          vmid: z.coerce.number().int().positive(),
        }),
        response: {
          200: driftSnapshotSchema,
          403: forbiddenSchema,
          404: notFoundSchema,
        },
      },
    },
    async (request, reply) => {
      const { hostId, vmid } = request.params;
      if (!(await canAccessHost(request.user, hostId))) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${hostId}'`,
        });
      }

      const snapshot = await driftService.get(hostId, vmid);
      if (!snapshot) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `No drift snapshot for guest ${vmid} on host '${hostId}'`,
        });
      }
      return snapshot;
    },
  );

  app.post(
    '/api/drift/:hostId/:vmid/check',
    {
      schema: {
        tags: ['Drift'],
        summary: 'Run an on-demand drift check for one guest',
        params: z.object({
          hostId: z.string(),
          vmid: z.coerce.number().int().positive(),
        }),
        response: {
          200: driftSnapshotSchema,
          403: forbiddenSchema,
          404: notFoundSchema,
          409: conflictSchema,
        },
      },
    },
    async (request, reply) => {
      const { hostId, vmid } = request.params;
      if (!(await canAccessHost(request.user, hostId))) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${hostId}'`,
        });
      }

      try {
        return await driftService.checkGuest(hostId, vmid);
      } catch (error) {
        if (error instanceof DriftGuestNotFoundError) {
          return reply.code(404).send({
            statusCode: 404,
            error: 'Not Found',
            message: error.message,
          });
        }
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message:
            error instanceof Error ? error.message : 'Drift check failed',
        });
      }
    },
  );

  app.post(
    '/api/drift/hosts/:hostId/check',
    {
      schema: {
        tags: ['Drift'],
        summary:
          'Run on-demand drift checks for every configured guest on a host',
        params: z.object({
          hostId: z.string(),
        }),
        response: {
          200: z.object({
            hostId: z.string(),
            checked: z.number(),
            snapshots: z.array(driftSnapshotSchema).readonly(),
            failures: z
              .array(
                z.object({
                  vmid: z.number(),
                  message: z.string(),
                }),
              )
              .readonly(),
          }),
          403: forbiddenSchema,
        },
      },
    },
    async (request, reply) => {
      const { hostId } = request.params;
      if (!(await canAccessHost(request.user, hostId))) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${hostId}'`,
        });
      }
      return driftService.checkHost(hostId);
    },
  );
};
