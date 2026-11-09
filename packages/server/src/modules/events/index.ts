import type { ServerResponse } from 'node:http';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { HostRegistry } from '../../hosts/registry.js';
import type { DatabaseRepositories } from '../../db/repositories/types.js';
import type { JobLogLineRow, JobRow } from '../../db/schema.js';
import {
  encodeSseEvent,
  publicJobEvent,
  type JobEventBroker,
  type JobPromptEvent,
} from '../../events/job-events.js';

export interface EventsModuleOptions {
  readonly repos: DatabaseRepositories;
  readonly hostRegistry: HostRegistry;
  readonly broker: JobEventBroker;
  readonly heartbeatMs?: number | undefined;
}

function openSse(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.flushHeaders();
  response.write(encodeSseEvent({ retry: 2_000 }));
}

function parseEventCursor(
  queryAfter: number | undefined,
  lastEventId: string | string[] | undefined,
): number {
  const header = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
  const headerValue = header ? Number.parseInt(header, 10) : 0;
  return Math.max(
    queryAfter ?? 0,
    Number.isFinite(headerValue) ? headerValue : 0,
  );
}

async function replayLogs(
  repos: DatabaseRepositories,
  jobId: string,
  afterSeq: number,
  send: (line: JobLogLineRow) => void,
): Promise<number> {
  let cursor = afterSeq;
  while (true) {
    const lines = await repos.jobLogLines.list(jobId, {
      afterSeq: cursor,
      limit: 1_000,
    });
    for (const line of lines) {
      if (line.seq <= cursor) continue;
      send(line);
      cursor = line.seq;
    }
    if (lines.length < 1_000) return cursor;
  }
}

function sendLog(response: ServerResponse, line: JobLogLineRow): void {
  response.write(
    encodeSseEvent({
      id: line.seq,
      event: 'log',
      data: {
        jobId: line.jobId,
        seq: line.seq,
        ts: line.ts.toISOString(),
        stream: line.stream,
        text: line.text,
      },
    }),
  );
}

function sendJob(response: ServerResponse, job: JobRow): void {
  response.write(encodeSseEvent({ event: 'job', data: publicJobEvent(job) }));
}

function sendPrompt(response: ServerResponse, prompt: JobPromptEvent): void {
  response.write(encodeSseEvent({ event: 'prompt', data: prompt }));
}

export const eventsModule: FastifyPluginAsyncZod<EventsModuleOptions> = async (
  app,
  options,
) => {
  const heartbeatMs = options.heartbeatMs ?? 15_000;

  app.get(
    '/api/jobs/:jobId/events',
    {
      schema: {
        tags: ['Jobs'],
        summary: 'Replay and follow one job event stream',
        params: z.object({ jobId: z.string() }),
        querystring: z.object({
          after: z.coerce.number().int().min(0).optional(),
          follow: z.enum(['true', 'false']).optional(),
        }),
        response: {
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
      const job = await options.repos.jobs.get(request.params.jobId);
      if (!job) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Job '${request.params.jobId}' was not found`,
        });
      }
      const allowedHosts = await options.hostRegistry.listHosts(request.user);
      if (!allowedHosts.some((host) => host.id === job.hostId)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${job.hostId}'`,
        });
      }

      reply.hijack();
      const response = reply.raw;
      openSse(response);
      let lastSentSeq = parseEventCursor(
        request.query.after,
        request.headers['last-event-id'],
      );
      let replaying = true;
      const bufferedLogs = new Map<number, JobLogLineRow>();
      const bufferedEvents: Array<JobRow | JobPromptEvent> = [];

      const onLog = (line: JobLogLineRow) => {
        if (line.jobId !== job.id || line.seq <= lastSentSeq) return;
        if (replaying) bufferedLogs.set(line.seq, line);
        else {
          sendLog(response, line);
          lastSentSeq = line.seq;
        }
      };
      const onJob = (updated: JobRow) => {
        if (updated.id !== job.id) return;
        if (replaying) bufferedEvents.push(updated);
        else sendJob(response, updated);
      };
      const onPrompt = (prompt: JobPromptEvent) => {
        if (prompt.jobId !== job.id) return;
        if (prompt.userId && prompt.userId !== request.user?.id) return;
        if (replaying) bufferedEvents.push(prompt);
        else sendPrompt(response, prompt);
      };

      options.broker.on('log', onLog);
      options.broker.on('job', onJob);
      options.broker.on('prompt', onPrompt);

      const cleanup = () => {
        clearInterval(heartbeat);
        options.broker.off('log', onLog);
        options.broker.off('job', onJob);
        options.broker.off('prompt', onPrompt);
      };
      const heartbeat = setInterval(() => {
        response.write(encodeSseEvent({ comment: 'heartbeat' }));
      }, heartbeatMs);
      request.raw.once('close', cleanup);

      lastSentSeq = await replayLogs(
        options.repos,
        job.id,
        lastSentSeq,
        (line) => sendLog(response, line),
      );
      replaying = false;
      for (const line of [...bufferedLogs.values()].sort(
        (left, right) => left.seq - right.seq,
      )) {
        if (line.seq <= lastSentSeq) continue;
        sendLog(response, line);
        lastSentSeq = line.seq;
      }
      for (const event of bufferedEvents) {
        if ('status' in event) sendJob(response, event);
        else sendPrompt(response, event);
      }

      if (request.query.follow === 'false') {
        cleanup();
        response.end();
      }
      return reply;
    },
  );

  app.get(
    '/api/events',
    {
      schema: {
        tags: ['Jobs'],
        summary: 'Follow queue state and prompt events for granted hosts',
        querystring: z.object({
          follow: z.enum(['true', 'false']).optional(),
        }),
      },
    },
    async (request, reply) => {
      const allowedHosts = new Set(
        (await options.hostRegistry.listHosts(request.user)).map(
          (host) => host.id,
        ),
      );
      reply.hijack();
      const response = reply.raw;
      openSse(response);

      const onJob = (job: JobRow) => {
        if (allowedHosts.has(job.hostId)) sendJob(response, job);
      };
      const onPrompt = (prompt: JobPromptEvent) => {
        if (!allowedHosts.has(prompt.hostId)) return;
        if (prompt.userId && prompt.userId !== request.user?.id) return;
        sendPrompt(response, prompt);
      };
      options.broker.on('job', onJob);
      options.broker.on('prompt', onPrompt);
      const heartbeat = setInterval(() => {
        response.write(encodeSseEvent({ comment: 'heartbeat' }));
      }, heartbeatMs);
      const cleanup = () => {
        clearInterval(heartbeat);
        options.broker.off('job', onJob);
        options.broker.off('prompt', onPrompt);
      };
      request.raw.once('close', cleanup);

      if (request.query.follow === 'false') {
        cleanup();
        response.end();
      }
      return reply;
    },
  );
};

export const eventsModuleInternals = {
  parseEventCursor,
  replayLogs,
};
