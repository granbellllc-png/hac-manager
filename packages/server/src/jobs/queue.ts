import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { globalSecretRedactor, sanitizeAuditPayload } from '@hacm/core';
import type { DatabaseRepositories } from '../db/repositories/types.js';
import type { JobRow } from '../db/schema.js';
import {
  JOB_PRIORITY,
  JobCancelledError,
  JobInterruptedError,
  JobTimeoutError,
  type DurableJobQueueOptions,
  type EnqueueJobInput,
  type JobExecutionContext,
  type JobHandler,
  type JobStatusEvent,
  type NamedJobPriority,
} from './types.js';

const terminalStatuses = new Set<JobRow['status']>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

type StopReason = 'cancelled' | 'timeout' | 'interrupted' | null;

interface RunningJob {
  readonly controller: AbortController;
  completion: Promise<void>;
  stopReason: StopReason;
}

function resolvePriority(
  priority: NamedJobPriority | number | undefined,
  type: string,
): number {
  if (typeof priority === 'number') return priority;
  if (priority) return JOB_PRIORITY[priority];
  return type.startsWith('power.') ? JOB_PRIORITY.power : JOB_PRIORITY.normal;
}

function parsePayload(job: JobRow): unknown {
  if (!job.payloadJson) return undefined;
  return JSON.parse(job.payloadJson) as unknown;
}

export class DurableJobQueue extends EventEmitter {
  private readonly repos: DatabaseRepositories;
  private readonly defaultHostConcurrency: number;
  private readonly hostConcurrency: Readonly<Record<string, number>>;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly running = new Map<string, RunningJob>();
  private readonly runningByHost = new Map<string, number>();
  private readonly guestLocks = new Set<string>();
  private readonly hostLaneLocks = new Set<string>();
  private started = false;
  private draining = false;
  private drainRequested = false;

  public constructor(
    repos: DatabaseRepositories,
    options: DurableJobQueueOptions = {},
  ) {
    super();
    this.repos = repos;
    const defaultHostConcurrency = options.defaultHostConcurrency ?? 2;
    if (
      !Number.isInteger(defaultHostConcurrency) ||
      defaultHostConcurrency < 1
    ) {
      throw new Error('defaultHostConcurrency must be a positive integer');
    }
    for (const [hostId, limit] of Object.entries(
      options.hostConcurrency ?? {},
    )) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(
          `Host concurrency for '${hostId}' must be a positive integer`,
        );
      }
    }
    this.defaultHostConcurrency = defaultHostConcurrency;
    this.hostConcurrency = options.hostConcurrency ?? {};
  }

  public registerHandler(type: string, handler: JobHandler): void {
    if (!type) throw new Error('Job handler type must not be empty');
    this.handlers.set(type, handler);
  }

  public async start(): Promise<number> {
    if (this.started) return 0;
    const staleJobs = await this.repos.jobs.list({ statuses: ['running'] });
    const interrupted = await this.repos.jobs.interruptRunning();
    for (const job of staleJobs) {
      await this.repos.jobLogLines.append({
        jobId: job.id,
        stream: 'system',
        text: 'Job marked interrupted after backend restart',
      });
      const updated = await this.repos.jobs.get(job.id);
      if (updated) this.emitStatus(updated, 'running');
    }
    this.started = true;
    this.requestDrain();
    return interrupted;
  }

  public async stop(
    options: {
      readonly interruptRunning?: boolean | undefined;
    } = {},
  ): Promise<void> {
    this.started = false;
    if (options.interruptRunning ?? true) {
      for (const running of this.running.values()) {
        running.stopReason = 'interrupted';
        running.controller.abort(new JobInterruptedError());
      }
    }
    await Promise.allSettled(
      [...this.running.values()].map((running) => running.completion),
    );
  }

  public async enqueue(input: EnqueueJobInput): Promise<JobRow> {
    if (!input.hostId) throw new Error('hostId is required');
    if (!input.type) throw new Error('Job type is required');
    if (
      input.timeoutMs !== undefined &&
      (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1)
    ) {
      throw new Error('timeoutMs must be a positive integer');
    }
    if (input.dependsOnJobId) {
      const dependency = await this.repos.jobs.get(input.dependsOnJobId);
      if (!dependency) {
        throw new Error(
          `Dependency job '${input.dependsOnJobId}' was not found`,
        );
      }
    }

    const now = new Date();
    const job = await this.repos.jobs.create({
      id: input.id ?? randomUUID(),
      hostId: input.hostId,
      vmid: input.vmid ?? null,
      lane: input.vmid === undefined ? 'host' : 'guest',
      type: input.type,
      status: 'queued',
      priority: resolvePriority(input.priority, input.type),
      payloadJson:
        input.payload === undefined
          ? null
          : JSON.stringify(sanitizeAuditPayload(input.payload)),
      triggeredBy: input.triggeredBy ?? null,
      dependsOnJobId: input.dependsOnJobId ?? null,
      timeoutMs: input.timeoutMs ?? null,
      createdAt: now,
    });
    await this.repos.jobLogLines.append({
      jobId: job.id,
      stream: 'system',
      text: 'Job queued',
      ts: now,
    });
    this.emitStatus(job, 'queued');
    this.requestDrain();
    return job;
  }

  public async cancel(jobId: string): Promise<boolean> {
    const job = await this.repos.jobs.get(jobId);
    if (!job || terminalStatuses.has(job.status)) return false;
    const requestedAt = new Date();
    await this.repos.jobs.requestCancel(jobId, requestedAt);

    if (job.status === 'queued' || job.status === 'waiting_input') {
      await this.transition(job, 'cancelled', {
        finishedAt: requestedAt,
        cancelRequestedAt: requestedAt,
        error: null,
      });
      await this.repos.jobLogLines.append({
        jobId,
        stream: 'system',
        text: 'Job cancelled before execution',
        ts: requestedAt,
      });
      this.requestDrain();
      return true;
    }

    const running = this.running.get(jobId);
    if (running) {
      running.stopReason = 'cancelled';
      running.controller.abort(new JobCancelledError());
    }
    return true;
  }

  public async get(jobId: string): Promise<JobRow | null> {
    return this.repos.jobs.get(jobId);
  }

  public async waitForJob(jobId: string, timeoutMs = 5_000): Promise<JobRow> {
    const current = await this.repos.jobs.get(jobId);
    if (!current) throw new Error(`Job '${jobId}' was not found`);
    if (terminalStatuses.has(current.status)) return current;

    return new Promise<JobRow>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        this.off('status', onStatus);
      };
      const settle = (job: JobRow) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(job);
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Timed out waiting for job '${jobId}'`));
      }, timeoutMs);
      const onStatus = (event: JobStatusEvent) => {
        if (event.job.id !== jobId || !terminalStatuses.has(event.job.status)) {
          return;
        }
        settle(event.job);
      };
      this.on('status', onStatus);
      void this.repos.jobs
        .get(jobId)
        .then((latest) => {
          if (latest && terminalStatuses.has(latest.status)) settle(latest);
        })
        .catch((error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
    });
  }

  private requestDrain(): void {
    if (!this.started) return;
    this.drainRequested = true;
    queueMicrotask(() => {
      void this.drain().catch((error: unknown) => {
        this.emit('queueError', error);
      });
    });
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.started) return;
    this.draining = true;
    try {
      do {
        this.drainRequested = false;
        const queued = await this.repos.jobs.list({ statuses: ['queued'] });
        for (const job of queued) {
          if (!this.started) break;
          const dependencyReady = await this.resolveDependency(job);
          if (!dependencyReady || !this.canRun(job)) continue;
          this.reserve(job);
          const running: RunningJob = {
            controller: new AbortController(),
            completion: Promise.resolve(),
            stopReason: null,
          };
          this.running.set(job.id, running);
          running.completion = this.execute(job);
        }
      } while (this.drainRequested && this.started);
    } finally {
      this.draining = false;
    }
  }

  private async resolveDependency(job: JobRow): Promise<boolean> {
    if (!job.dependsOnJobId) return true;
    const dependency = await this.repos.jobs.get(job.dependsOnJobId);
    if (dependency?.status === 'completed') return true;
    if (dependency && !terminalStatuses.has(dependency.status)) return false;

    const message = dependency
      ? `Dependency '${dependency.id}' ended with status '${dependency.status}'`
      : `Dependency '${job.dependsOnJobId}' no longer exists`;
    await this.transition(job, 'failed', {
      finishedAt: new Date(),
      error: message,
    });
    await this.repos.jobLogLines.append({
      jobId: job.id,
      stream: 'system',
      text: message,
    });
    return false;
  }

  private canRun(job: JobRow): boolean {
    const runningCount = this.runningByHost.get(job.hostId) ?? 0;
    if (runningCount >= this.hostLimit(job.hostId)) return false;
    if (job.lane === 'host') return !this.hostLaneLocks.has(job.hostId);
    if (job.vmid === null) return false;
    return !this.guestLocks.has(`${job.hostId}:${job.vmid}`);
  }

  private reserve(job: JobRow): void {
    this.runningByHost.set(
      job.hostId,
      (this.runningByHost.get(job.hostId) ?? 0) + 1,
    );
    if (job.lane === 'host') this.hostLaneLocks.add(job.hostId);
    else this.guestLocks.add(`${job.hostId}:${job.vmid}`);
  }

  private release(job: JobRow): void {
    const next = (this.runningByHost.get(job.hostId) ?? 1) - 1;
    if (next <= 0) this.runningByHost.delete(job.hostId);
    else this.runningByHost.set(job.hostId, next);
    if (job.lane === 'host') this.hostLaneLocks.delete(job.hostId);
    else this.guestLocks.delete(`${job.hostId}:${job.vmid}`);
  }

  private hostLimit(hostId: string): number {
    return this.hostConcurrency[hostId] ?? this.defaultHostConcurrency;
  }

  private async execute(job: JobRow): Promise<void> {
    const running = this.running.get(job.id)!;
    const startedAt = new Date();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const claimed = await this.repos.jobs.claim(job.id, startedAt);
      if (!claimed) return;
      this.emitStatus(claimed, 'queued');
      await this.repos.jobLogLines.append({
        jobId: job.id,
        stream: 'system',
        text: 'Job started',
        ts: startedAt,
      });

      const handler = this.handlers.get(job.type);
      if (!handler) throw new Error(`No handler registered for '${job.type}'`);
      if (job.timeoutMs !== null) {
        timeout = setTimeout(() => {
          running.stopReason = 'timeout';
          running.controller.abort(new JobTimeoutError(job.timeoutMs!));
        }, job.timeoutMs);
      }

      const context: JobExecutionContext = {
        job: claimed,
        payload: parsePayload(job),
        signal: running.controller.signal,
        log: async (stream, text) => {
          const lines = text.replaceAll('\r\n', '\n').split('\n');
          if (lines.at(-1) === '') lines.pop();
          for (const line of lines) {
            await this.repos.jobLogLines.append({
              jobId: job.id,
              stream,
              text: line,
            });
          }
        },
      };
      await handler(context);

      if (running.stopReason === 'cancelled') throw new JobCancelledError();
      if (running.stopReason === 'timeout') {
        throw new JobTimeoutError(job.timeoutMs!);
      }
      if (running.stopReason === 'interrupted') throw new JobInterruptedError();
      await this.finish(job, 'completed', null);
    } catch (error) {
      if (
        running.stopReason === 'cancelled' ||
        error instanceof JobCancelledError
      ) {
        await this.finish(job, 'cancelled', null);
      } else if (
        running.stopReason === 'interrupted' ||
        error instanceof JobInterruptedError
      ) {
        await this.finish(
          job,
          'interrupted',
          error instanceof Error
            ? error.message
            : 'Job interrupted by backend shutdown',
        );
      } else {
        const message = globalSecretRedactor.redactLine(
          error instanceof Error ? error.message : String(error),
        );
        await this.finish(job, 'failed', message);
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      this.running.delete(job.id);
      this.release(job);
      this.requestDrain();
    }
  }

  private async finish(
    job: JobRow,
    status: Extract<
      JobRow['status'],
      'completed' | 'failed' | 'cancelled' | 'interrupted'
    >,
    error: string | null,
  ): Promise<void> {
    const finishedAt = new Date();
    await this.transition(job, status, { finishedAt, error });
    await this.repos.jobLogLines.append({
      jobId: job.id,
      stream: 'system',
      text: error ? `Job ${status}: ${error}` : `Job ${status}`,
      ts: finishedAt,
    });
  }

  private async transition(
    job: JobRow,
    status: JobRow['status'],
    patch: Parameters<DatabaseRepositories['jobs']['updateStatus']>[2] = {},
  ): Promise<JobRow> {
    const before = await this.repos.jobs.get(job.id);
    await this.repos.jobs.updateStatus(job.id, status, patch);
    const updated = await this.repos.jobs.get(job.id);
    if (!updated) throw new Error(`Job '${job.id}' disappeared`);
    this.emitStatus(updated, before?.status ?? job.status);
    return updated;
  }

  private emitStatus(job: JobRow, previousStatus: JobRow['status']): void {
    this.emit('status', { job, previousStatus } satisfies JobStatusEvent);
  }
}
