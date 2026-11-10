import type { JobRow } from '../db/schema.js';
import type { JobLogStream } from '../db/repositories/types.js';
import type { AuditReason } from '../db/repositories/types.js';

export const JOB_PRIORITY = {
  low: -50,
  normal: 0,
  high: 50,
  power: 100,
} as const;

export type NamedJobPriority = keyof typeof JOB_PRIORITY;

export interface EnqueueJobInput {
  readonly id?: string | undefined;
  readonly hostId: string;
  readonly vmid?: number | undefined;
  readonly type: string;
  readonly reason?: AuditReason | undefined;
  readonly payload?: unknown;
  readonly priority?: NamedJobPriority | number | undefined;
  readonly triggeredBy?: string | undefined;
  readonly dependsOnJobId?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface JobExecutionContext {
  readonly job: JobRow;
  readonly payload: unknown;
  readonly signal: AbortSignal;
  readonly log: (stream: JobLogStream, text: string) => Promise<void>;
  readonly prompt: (request: JobPromptRequest) => Promise<unknown>;
}

export type JobHandler = (context: JobExecutionContext) => Promise<void>;
export type JobPreflightHandler = (
  context: JobExecutionContext,
) => Promise<void>;

export interface JobPromptRequest {
  readonly id?: string | undefined;
  readonly kind: 'choice' | 'confirm' | 'typed_confirmation';
  readonly message: string;
  readonly payload?: unknown;
  readonly options?: readonly string[] | undefined;
  readonly expectedText?: string | undefined;
  readonly expiresAt?: Date | undefined;
}

export type JobPromptHandler = (
  job: JobRow,
  request: JobPromptRequest,
  signal: AbortSignal,
) => Promise<unknown>;

export interface DurableJobQueueOptions {
  readonly defaultHostConcurrency?: number | undefined;
  readonly hostConcurrency?: Readonly<Record<string, number>> | undefined;
}

export interface JobStatusEvent {
  readonly job: JobRow;
  readonly previousStatus: JobRow['status'];
}

export class JobCancelledError extends Error {
  public constructor(message = 'Job cancelled') {
    super(message);
    this.name = 'JobCancelledError';
  }
}

export class JobTimeoutError extends Error {
  public constructor(public readonly timeoutMs: number) {
    super(`Job exceeded its ${timeoutMs}ms timeout`);
    this.name = 'JobTimeoutError';
  }
}

export class JobInterruptedError extends Error {
  public constructor(message = 'Job interrupted by backend shutdown') {
    super(message);
    this.name = 'JobInterruptedError';
  }
}
