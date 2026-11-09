import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { DatabaseRepositories } from '../../db/repositories/types.js';
import type { JobRow } from '../../db/schema.js';
import type { HostRegistry } from '../../hosts/registry.js';
import type { DurableJobQueue } from '../../jobs/queue.js';
import type { PromptService } from '../../prompts/service.js';

export interface JobsModuleOptions {
  readonly repos: DatabaseRepositories;
  readonly hostRegistry: HostRegistry;
  readonly queue: DurableJobQueue;
  readonly promptService: PromptService;
}

const jobStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_input',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

const jobSchema = z.object({
  id: z.string(),
  hostId: z.string(),
  vmid: z.number().optional(),
  lane: z.enum(['guest', 'host']),
  type: z.string(),
  status: jobStatusSchema,
  priority: z.number(),
  triggeredBy: z.string().optional(),
  dependsOnJobId: z.string().optional(),
  timeoutMs: z.number().optional(),
  cancelRequestedAt: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});

const logSchema = z.object({
  jobId: z.string(),
  seq: z.number(),
  ts: z.string(),
  stream: z.enum(['stdout', 'stderr', 'system']),
  text: z.string(),
});

const stepSchema = z.object({
  jobId: z.string(),
  stepIndex: z.number(),
  name: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped']),
  result: z.unknown().optional(),
  rollbackHint: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});

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

function publicJob(job: JobRow) {
  return {
    id: job.id,
    hostId: job.hostId,
    ...(job.vmid !== null ? { vmid: job.vmid } : {}),
    lane: job.lane,
    type: job.type,
    status: job.status,
    priority: job.priority,
    ...(job.triggeredBy !== null ? { triggeredBy: job.triggeredBy } : {}),
    ...(job.dependsOnJobId !== null
      ? { dependsOnJobId: job.dependsOnJobId }
      : {}),
    ...(job.timeoutMs !== null ? { timeoutMs: job.timeoutMs } : {}),
    ...(job.cancelRequestedAt !== null
      ? { cancelRequestedAt: job.cancelRequestedAt.toISOString() }
      : {}),
    ...(job.error !== null ? { error: job.error } : {}),
    createdAt: job.createdAt.toISOString(),
    ...(job.startedAt !== null
      ? { startedAt: job.startedAt.toISOString() }
      : {}),
    ...(job.finishedAt !== null
      ? { finishedAt: job.finishedAt.toISOString() }
      : {}),
  };
}

function parseResult(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

async function canAccessHost(
  registry: HostRegistry,
  user: Parameters<HostRegistry['listHosts']>[0],
  hostId: string,
): Promise<boolean> {
  return (await registry.listHosts(user)).some((host) => host.id === hostId);
}

export const jobsModule: FastifyPluginAsyncZod<JobsModuleOptions> = async (
  app,
  options,
) => {
  app.get(
    '/api/jobs',
    {
      schema: {
        tags: ['Jobs'],
        summary: 'List durable jobs for granted hosts',
        querystring: z.object({
          hostId: z.string().optional(),
          vmid: z.coerce.number().int().optional(),
          status: jobStatusSchema.optional(),
          limit: z.coerce.number().int().min(1).max(1_000).optional(),
        }),
        response: {
          200: z.object({ jobs: z.array(jobSchema) }),
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
      const jobs = await options.repos.jobs.list({
        ...(request.query.hostId ? { hostId: request.query.hostId } : {}),
        ...(request.query.vmid !== undefined
          ? { vmid: request.query.vmid }
          : {}),
        ...(request.query.status ? { statuses: [request.query.status] } : {}),
        ...(request.query.limit ? { limit: request.query.limit } : {}),
      });
      return {
        jobs: jobs.filter((job) => allowed.has(job.hostId)).map(publicJob),
      };
    },
  );

  app.get(
    '/api/jobs/:jobId',
    {
      schema: {
        tags: ['Jobs'],
        summary: 'Get job details, steps, and prompts',
        params: z.object({ jobId: z.string() }),
        response: {
          200: z.object({
            job: jobSchema,
            steps: z.array(stepSchema),
            prompts: z.array(promptSchema),
          }),
          403: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const job = await options.repos.jobs.get(request.params.jobId);
      if (!job) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Job '${request.params.jobId}' was not found`,
        });
      }
      if (
        !(await canAccessHost(options.hostRegistry, request.user, job.hostId))
      ) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${job.hostId}'`,
        });
      }
      const [steps, prompts] = await Promise.all([
        options.repos.jobSteps.list(job.id),
        options.promptService.listForJob(job.id),
      ]);
      return {
        job: publicJob(job),
        steps: steps.map((step) => ({
          jobId: step.jobId,
          stepIndex: step.stepIndex,
          name: step.name,
          status: step.status,
          ...(step.resultJson !== null
            ? { result: parseResult(step.resultJson) }
            : {}),
          ...(step.rollbackHint !== null
            ? { rollbackHint: step.rollbackHint }
            : {}),
          ...(step.startedAt !== null
            ? { startedAt: step.startedAt.toISOString() }
            : {}),
          ...(step.finishedAt !== null
            ? { finishedAt: step.finishedAt.toISOString() }
            : {}),
        })),
        prompts: [...prompts],
      };
    },
  );

  app.get(
    '/api/jobs/:jobId/logs',
    {
      schema: {
        tags: ['Jobs'],
        summary: 'Page through persisted job log lines',
        params: z.object({ jobId: z.string() }),
        querystring: z.object({
          after: z.coerce.number().int().min(0).optional(),
          limit: z.coerce.number().int().min(1).max(2_000).optional(),
        }),
        response: {
          200: z.object({ logs: z.array(logSchema), nextCursor: z.number() }),
          403: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const job = await options.repos.jobs.get(request.params.jobId);
      if (!job) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Job '${request.params.jobId}' was not found`,
        });
      }
      if (
        !(await canAccessHost(options.hostRegistry, request.user, job.hostId))
      ) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${job.hostId}'`,
        });
      }
      const logs = await options.repos.jobLogLines.list(job.id, {
        afterSeq: request.query.after ?? 0,
        limit: request.query.limit ?? 1_000,
      });
      return {
        logs: logs.map((line) => ({
          jobId: line.jobId,
          seq: line.seq,
          ts: line.ts.toISOString(),
          stream: line.stream,
          text: line.text,
        })),
        nextCursor: logs.at(-1)?.seq ?? request.query.after ?? 0,
      };
    },
  );

  app.post(
    '/api/jobs/:jobId/cancel',
    {
      schema: {
        tags: ['Jobs'],
        summary: 'Cancel a queued or running job',
        params: z.object({ jobId: z.string() }),
        response: {
          200: z.object({ job: jobSchema }),
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (request.user?.role === 'viewer') {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Viewer role cannot cancel jobs',
        });
      }
      const job = await options.repos.jobs.get(request.params.jobId);
      if (!job) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Job '${request.params.jobId}' was not found`,
        });
      }
      if (
        !(await canAccessHost(options.hostRegistry, request.user, job.hostId))
      ) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${job.hostId}'`,
        });
      }
      if (!(await options.queue.cancel(job.id))) {
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: `Job '${job.id}' can no longer be cancelled`,
        });
      }
      const updated = await options.repos.jobs.get(job.id);
      if (!updated) throw new Error(`Job '${job.id}' disappeared`);
      return { job: publicJob(updated) };
    },
  );
};
