import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { HostRegistry } from '../../hosts/registry.js';
import {
  DriftGuestNotFoundError,
  DriftResolutionForbiddenError,
  type DriftService,
  type DriftResolutionRole,
} from '../../drift/index.js';
import { planError } from '../../plans/errors.js';
import type { PlanService } from '../../plans/service.js';
import {
  errorSchema as planErrorSchema,
  jobSchema,
  planSchema,
  publicJob,
} from '../plans/index.js';

export interface DriftModuleOptions {
  readonly driftService: DriftService;
  readonly planService: PlanService;
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

const driftPullFailureSchema = z.object({
  path: z.string(),
  reason: z.enum([
    'not_pullable',
    'missing_in_live',
    'path_not_found',
    'apply_failed',
    'tag_protected',
    'target_not_found',
    'write_conflict',
    'invalid_path',
  ]),
  message: z.string(),
});

const driftPullAppliedSchema = z.object({
  path: z.string(),
  targetFile: z.string(),
  layer: z.enum(['override', 'default']),
  previousValue: z.unknown(),
  newValue: z.unknown(),
});

const driftPullResultSchema = z.object({
  hostId: z.string(),
  vmid: z.number(),
  dryRun: z.boolean(),
  applied: z.array(driftPullAppliedSchema).readonly(),
  failures: z.array(driftPullFailureSchema).readonly(),
  snapshot: driftSnapshotSchema,
});

function resolutionRole(
  role: string | undefined,
): DriftResolutionRole | undefined {
  return role === 'admin' || role === 'operator' || role === 'viewer'
    ? role
    : undefined;
}

export const driftModule: FastifyPluginAsyncZod<DriftModuleOptions> = async (
  app,
  options,
) => {
  const { driftService, planService, hostRegistry } = options;

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
    '/api/drift/:hostId/:vmid/pull',
    {
      schema: {
        tags: ['Drift'],
        summary:
          'Pull live values into the guest YAML, preserving comments and tags',
        params: z.object({
          hostId: z.string(),
          vmid: z.coerce.number().int().positive(),
        }),
        body: z.object({
          paths: z.array(z.string().min(1)).min(1).max(200).optional(),
          dryRun: z.boolean().optional(),
        }),
        response: {
          200: driftPullResultSchema,
          403: forbiddenSchema,
          404: notFoundSchema,
          409: conflictSchema,
        },
      },
    },
    async (request, reply) => {
      const { hostId, vmid } = request.params;
      const role = resolutionRole(request.user?.role);
      if (!role || role === 'viewer') {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Viewer role cannot resolve drift',
        });
      }
      if (!(await canAccessHost(request.user, hostId))) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${hostId}'`,
        });
      }

      try {
        return await driftService.pull(hostId, vmid, {
          user: { id: request.user!.id, role },
          ...(request.body.paths ? { paths: request.body.paths } : {}),
          ...(request.body.dryRun !== undefined
            ? { dryRun: request.body.dryRun }
            : {}),
        });
      } catch (error) {
        if (error instanceof DriftGuestNotFoundError) {
          return reply.code(404).send({
            statusCode: 404,
            error: 'Not Found',
            message: error.message,
          });
        }
        if (error instanceof DriftResolutionForbiddenError) {
          return reply.code(403).send({
            statusCode: 403,
            error: 'Forbidden',
            message: error.message,
          });
        }
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: error instanceof Error ? error.message : 'Drift pull failed',
        });
      }
    },
  );

  app.post(
    '/api/drift/:hostId/:vmid/enforce',
    {
      schema: {
        tags: ['Drift'],
        summary: 'Build and queue a plan that enforces YAML on the live guest',
        params: z.object({
          hostId: z.string(),
          vmid: z.coerce.number().int().positive(),
        }),
        body: z.object({
          dryRun: z.boolean().optional(),
          confirmation: z.string().optional(),
        }),
        response: {
          202: z.object({ plan: planSchema, job: jobSchema }),
          400: planErrorSchema,
          403: planErrorSchema,
          404: planErrorSchema,
          409: planErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { hostId, vmid } = request.params;
      const role = resolutionRole(request.user?.role);
      if (!role || role === 'viewer') {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Viewer role cannot resolve drift',
        });
      }
      if (!(await canAccessHost(request.user, hostId))) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${hostId}'`,
        });
      }

      try {
        const plan = await planService.createGuestUpdatePlan({
          hostId,
          vmid,
          createdBy: request.user?.id,
          createdByRole: role,
        });
        const queued = await planService.queueApply(plan.id, {
          ...(request.body.dryRun !== undefined
            ? { dryRun: request.body.dryRun }
            : {}),
          ...(request.body.confirmation
            ? { confirmation: request.body.confirmation }
            : {}),
          reason: 'drift_push',
          user: {
            id: request.user!.id,
            username: request.user!.username,
            role,
          },
        });
        return reply.code(202).send({
          plan: queued.plan,
          job: publicJob(queued.job),
        });
      } catch (error) {
        const mapped = planError(error);
        if (mapped) {
          return reply.code(mapped.code).send({
            statusCode: mapped.code,
            error: mapped.error,
            message: mapped.message,
            ...(mapped.confirmationText
              ? { confirmationText: mapped.confirmationText }
              : {}),
          });
        }
        throw error;
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
