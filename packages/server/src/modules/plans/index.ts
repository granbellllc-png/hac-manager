import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { StalePlanError } from '@hacm/core';
import type { HostRegistry } from '../../hosts/registry.js';
import type { JobRow } from '../../db/schema.js';
import { PlanService } from '../../plans/service.js';
import {
  PlanConfirmationError,
  PlanAdminRequiredError,
  PlanNotFoundError,
  PlanOverwriteRequiredError,
  PlanStateError,
} from '../../plans/types.js';
import {
  GuestConfigurationError,
  GuestIdentityCheckError,
  GuestIdentityError,
  GuestNotFoundError,
  GuestProtectionEnabledError,
  GuestStateUnavailableError,
  GuestStoppedIdentityError,
  ProtectedGuestError,
} from '../../guests/index.js';

export interface PlansModuleOptions {
  readonly hostRegistry: HostRegistry;
  readonly planService: PlanService;
}

const planStatusSchema = z.enum([
  'ready',
  'applying',
  'applied',
  'stale',
  'failed',
]);

const planChangeSchema = z.object({
  id: z.string(),
  action: z.enum(['create', 'update', 'delete', 'execute']),
  summary: z.string(),
  path: z.string().optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  warnings: z.array(z.string()).readonly().optional(),
  destructive: z.boolean().optional(),
});

const planSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  operation: z.string(),
  target: z.object({
    hostId: z.string(),
    vmid: z.number().optional(),
    resourceType: z.enum(['host', 'guest', 'file']).optional(),
  }),
  summary: z.string(),
  changes: z.array(planChangeSchema).readonly(),
  warnings: z.array(z.string()).readonly(),
  destructive: z.boolean(),
  stateFingerprint: z.string(),
  confirmationText: z.string().optional(),
  createdAt: z.string(),
  status: planStatusSchema,
  createdBy: z.string().optional(),
  approvedBy: z.string().optional(),
  lastJobId: z.string().optional(),
  error: z.string().optional(),
  approvedAt: z.string().optional(),
  appliedAt: z.string().optional(),
});

const jobSchema = z.object({
  id: z.string(),
  hostId: z.string(),
  vmid: z.number().optional(),
  lane: z.enum(['guest', 'host']),
  type: z.string(),
  reason: z.enum([
    'manual',
    'drift_push',
    'drift_pull',
    'schedule',
    'conflict_resolution',
    'orphan_action',
  ]),
  status: z.enum([
    'queued',
    'running',
    'waiting_input',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
  ]),
  priority: z.number(),
  triggeredBy: z.string().optional(),
  createdAt: z.string(),
});

const errorSchema = z.object({
  statusCode: z.number(),
  error: z.string(),
  message: z.string(),
  confirmationText: z.string().optional(),
});

function publicJob(job: JobRow) {
  return {
    id: job.id,
    hostId: job.hostId,
    ...(job.vmid !== null ? { vmid: job.vmid } : {}),
    lane: job.lane,
    type: job.type,
    reason: job.reason,
    status: job.status,
    priority: job.priority,
    ...(job.triggeredBy !== null ? { triggeredBy: job.triggeredBy } : {}),
    createdAt: job.createdAt.toISOString(),
  };
}

function knownRole(
  role: string | undefined,
): 'admin' | 'operator' | 'viewer' | undefined {
  return role === 'admin' || role === 'operator' || role === 'viewer'
    ? role
    : undefined;
}

function planError(error: unknown): {
  code: 400 | 403 | 404 | 409;
  error: string;
  message: string;
  confirmationText?: string;
} | null {
  if (error instanceof PlanNotFoundError) {
    return { code: 404, error: 'Not Found', message: error.message };
  }
  if (error instanceof PlanConfirmationError) {
    return {
      code: 400,
      error: 'Bad Request',
      message: error.message,
      confirmationText: error.expectedText,
    };
  }
  if (error instanceof PlanOverwriteRequiredError) {
    return { code: 409, error: 'Conflict', message: error.message };
  }
  if (error instanceof PlanAdminRequiredError) {
    return { code: 403, error: 'Forbidden', message: error.message };
  }
  if (error instanceof StalePlanError || error instanceof PlanStateError) {
    return { code: 409, error: 'Conflict', message: error.message };
  }
  if (error instanceof GuestNotFoundError) {
    return { code: 404, error: 'Not Found', message: error.message };
  }
  if (error instanceof ProtectedGuestError) {
    return { code: 403, error: 'Forbidden', message: error.message };
  }
  if (
    error instanceof GuestProtectionEnabledError ||
    error instanceof GuestIdentityError ||
    error instanceof GuestStoppedIdentityError ||
    error instanceof GuestIdentityCheckError
  ) {
    return { code: 409, error: 'Conflict', message: error.message };
  }
  if (error instanceof GuestConfigurationError) {
    return { code: 400, error: 'Bad Request', message: error.message };
  }
  if (error instanceof GuestStateUnavailableError) {
    return { code: 409, error: 'Conflict', message: error.message };
  }
  return null;
}

export const plansModule: FastifyPluginAsyncZod<PlansModuleOptions> = async (
  app,
  options,
) => {
  app.post(
    '/api/plans/guest-import',
    {
      schema: {
        tags: ['Plans'],
        summary: 'Create a durable guest-import plan',
        body: z.object({
          hostId: z.string(),
          vmid: z.number().int(),
          overwrite: z.boolean().optional(),
        }),
        response: {
          201: planSchema,
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const allowed = await options.hostRegistry.listHosts(request.user);
      if (!allowed.some((host) => host.id === request.body.hostId)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${request.body.hostId}'`,
        });
      }
      try {
        const plan = await options.planService.createGuestImportPlan({
          ...request.body,
          createdBy: request.user?.id,
          createdByRole: knownRole(request.user?.role),
        });
        return reply.code(201).send(plan);
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
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.post(
    '/api/plans/guest-power',
    {
      schema: {
        tags: ['Plans'],
        summary: 'Create a durable guest power plan',
        body: z.object({
          hostId: z.string(),
          vmid: z.number().int(),
          action: z.enum(['start', 'stop', 'shutdown', 'reboot']),
        }),
        response: {
          201: planSchema,
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const allowed = await options.hostRegistry.listHosts(request.user);
      if (!allowed.some((host) => host.id === request.body.hostId)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${request.body.hostId}'`,
        });
      }
      try {
        const plan = await options.planService.createGuestPowerPlan({
          ...request.body,
          createdBy: request.user?.id,
          createdByRole: knownRole(request.user?.role),
        });
        return reply.code(201).send(plan);
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
    '/api/plans/guest-stamp',
    {
      schema: {
        tags: ['Plans'],
        summary: 'Create a durable plan to stamp a guest as managed',
        body: z.object({
          hostId: z.string(),
          vmid: z.number().int(),
        }),
        response: {
          201: planSchema,
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const allowed = await options.hostRegistry.listHosts(request.user);
      if (!allowed.some((host) => host.id === request.body.hostId)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${request.body.hostId}'`,
        });
      }
      try {
        const plan = await options.planService.createGuestStampPlan({
          ...request.body,
          createdBy: request.user?.id,
          createdByRole: knownRole(request.user?.role),
        });
        return reply.code(201).send(plan);
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

  const registerCreateRoute = (path: string, guestType: 'lxc' | 'vm'): void => {
    const label = guestType === 'lxc' ? 'LXC' : 'VM';
    app.post(
      path,
      {
        schema: {
          tags: ['Plans'],
          summary: `Create a durable ${label} creation plan from data-dir YAML`,
          body: z.object({
            hostId: z.string(),
            vmid: z.number().int().min(100),
          }),
          response: {
            201: planSchema,
            400: errorSchema,
            403: errorSchema,
            404: errorSchema,
            409: errorSchema,
          },
        },
      },
      async (request, reply) => {
        if (knownRole(request.user?.role) !== 'admin') {
          return reply.code(403).send({
            statusCode: 403,
            error: 'Forbidden',
            message: 'Creating guests is restricted to administrators',
          });
        }
        const allowed = await options.hostRegistry.listHosts(request.user);
        if (!allowed.some((host) => host.id === request.body.hostId)) {
          return reply.code(403).send({
            statusCode: 403,
            error: 'Forbidden',
            message: `Access denied to host '${request.body.hostId}'`,
          });
        }
        try {
          const plan = await options.planService.createGuestCreatePlan({
            ...request.body,
            guestType,
            createdBy: request.user?.id,
            createdByRole: knownRole(request.user?.role),
          });
          return reply.code(201).send(plan);
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
  };

  registerCreateRoute('/api/plans/lxc-create', 'lxc');
  registerCreateRoute('/api/plans/vm-create', 'vm');

  app.post(
    '/api/plans/guest-update',
    {
      schema: {
        tags: ['Plans'],
        summary: 'Create a durable LXC configuration update plan',
        body: z.object({
          hostId: z.string(),
          vmid: z.number().int(),
        }),
        response: {
          201: planSchema,
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const allowed = await options.hostRegistry.listHosts(request.user);
      if (!allowed.some((host) => host.id === request.body.hostId)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${request.body.hostId}'`,
        });
      }
      try {
        const plan = await options.planService.createGuestUpdatePlan({
          ...request.body,
          createdBy: request.user?.id,
          createdByRole: knownRole(request.user?.role),
        });
        return reply.code(201).send(plan);
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

  app.get(
    '/api/plans',
    {
      schema: {
        tags: ['Plans'],
        summary: 'List plans for granted hosts',
        querystring: z.object({
          hostId: z.string().optional(),
          status: planStatusSchema.optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
        response: {
          200: z.object({ plans: z.array(planSchema) }),
          403: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const allowed = new Set(
        (await options.hostRegistry.listHosts(request.user)).map(
          (host) => host.id,
        ),
      );
      if (request.query.hostId && !allowed.has(request.query.hostId)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${request.query.hostId}'`,
        });
      }
      const plans = await options.planService.list({
        ...(request.query.hostId ? { hostId: request.query.hostId } : {}),
        ...(request.query.status ? { statuses: [request.query.status] } : {}),
        ...(request.query.limit ? { limit: request.query.limit } : {}),
      });
      return { plans: plans.filter((plan) => allowed.has(plan.target.hostId)) };
    },
  );

  app.get(
    '/api/plans/:planId',
    {
      schema: {
        tags: ['Plans'],
        summary: 'View one plan',
        params: z.object({ planId: z.string() }),
        response: {
          200: planSchema,
          403: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const plan = await options.planService.get(request.params.planId);
      if (!plan) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Plan '${request.params.planId}' was not found`,
        });
      }
      const allowed = await options.hostRegistry.listHosts(request.user);
      if (!allowed.some((host) => host.id === plan.target.hostId)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${plan.target.hostId}'`,
        });
      }
      return plan;
    },
  );

  app.post(
    '/api/plans/:planId/apply',
    {
      schema: {
        tags: ['Plans'],
        summary: 'Approve a plan and queue its apply job',
        params: z.object({ planId: z.string() }),
        body: z.object({
          dryRun: z.boolean().optional(),
          confirmation: z.string().optional(),
        }),
        response: {
          202: z.object({ plan: planSchema, job: jobSchema }),
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const role = knownRole(request.user?.role);
      if (!role || role === 'viewer') {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Viewer role cannot apply plans',
        });
      }
      const plan = await options.planService.get(request.params.planId);
      if (!plan) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Plan '${request.params.planId}' was not found`,
        });
      }
      const allowed = await options.hostRegistry.listHosts(request.user);
      if (!allowed.some((host) => host.id === plan.target.hostId)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${plan.target.hostId}'`,
        });
      }
      try {
        const queued = await options.planService.queueApply(
          request.params.planId,
          {
            ...request.body,
            user: {
              id: request.user!.id,
              username: request.user!.username,
              role,
            },
          },
        );
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
};
