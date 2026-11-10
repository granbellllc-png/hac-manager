import type { Task as SchemaTask } from '../schema/tasks.js';
import type { TaskTargets } from './order.js';

/** A parsed task definition from a tasks file. */
export type Task = SchemaTask;

export type TaskStatus =
  'success' | 'failed' | 'ignored' | 'skipped' | 'timed_out' | 'cancelled';

export type TaskSkipReason = 'when' | 'creates';

/** Stored result for one task run (the acceptance criterion "per task"). */
export interface TaskResult {
  readonly name: string;
  readonly status: TaskStatus;
  /** A successful task that actually ran is a change; skipped tasks are not. */
  readonly changed: boolean;
  readonly attempts: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** Redacted and length-limited. */
  readonly stdout: string;
  /** Redacted and length-limited. */
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly skippedReason?: TaskSkipReason | undefined;
  readonly error?: string | undefined;
}

export interface TaskRunSummary {
  readonly results: readonly TaskResult[];
  readonly success: boolean;
  readonly changed: boolean;
  readonly failed: number;
  readonly skipped: number;
  readonly cancelled: boolean;
}

export interface LoadedTaskFile {
  readonly file: string;
  readonly absolutePath: string;
  readonly targets?: TaskTargets | undefined;
  readonly tasks: readonly Task[];
}

export class TaskLoadError extends Error {
  public constructor(
    public readonly file: string,
    message: string,
  ) {
    super(`Invalid tasks file '${file}': ${message}`);
    this.name = 'TaskLoadError';
  }
}

export class TaskRunError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TaskRunError';
  }
}
