import { toErrorMessage } from '../errors.js';
import { evaluateExpression } from '../expr/index.js';
import { SecretRedactor } from '../redaction/index.js';
import { isTagValue } from '../schema/common.js';
import { Secret } from '../tags/secret.js';
import { resolveTag } from '../tags/resolver.js';
import type { ResolutionContext } from '../tags/types.js';
import {
  TransportAbortedError,
  type ExecResult,
  type Transport,
} from '../transport/types.js';
import {
  TaskRunError,
  type Task,
  type TaskResult,
  type TaskRunSummary,
  type TaskSkipReason,
} from './types.js';

export const DEFAULT_TASK_TIMEOUT_SECONDS = 600;
export const DEFAULT_TASK_MAX_OUTPUT_CHARS = 65_536;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHELL_NAME = /^[A-Za-z0-9_./-]+$/;

export interface RunTasksOptions {
  readonly tasks: readonly Task[];
  readonly transport: Transport;
  /** Context for `!env`, `!secret`, `!cmd`, `!expr` and `!include` tags. */
  readonly tagContext: ResolutionContext;
  readonly signal?: AbortSignal | undefined;
  /** Called after every task so the server can persist the per-task result. */
  readonly onResult?:
    ((result: TaskResult) => void | Promise<void>) | undefined;
  readonly redactor?: SecretRedactor | undefined;
  readonly defaultTimeoutSeconds?: number | undefined;
  readonly maxOutputChars?: number | undefined;
  /** Stop scheduling tasks after the first real failure (not `ignore_errors`). */
  readonly stopOnFailure?: boolean | undefined;
  readonly now?: (() => Date) | undefined;
}

/** POSIX single-quote quoting for values injected into a stdin script. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildTaskScript(
  task: Task,
  env: Readonly<Record<string, string>>,
): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    lines.push(`export ${name}=${shellQuote(value)}`);
  }
  lines.push(task.run);
  return `${lines.join('\n')}\n`;
}

function truthy(value: unknown): boolean {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized !== '' && normalized !== 'false' && normalized !== '0';
  }
  return Boolean(value);
}

async function resolveField(
  value: unknown,
  context: ResolutionContext,
  field: string,
): Promise<unknown> {
  if (!isTagValue(value)) return value;
  const resolved = await resolveTag(value, context);
  if (resolved.status !== 'resolved') {
    throw new TaskRunError(
      `Cannot resolve ${field} tag '!${value.tag} ${value.value}': ${
        resolved.status === 'error' ? resolved.error : resolved.reason
      }`,
    );
  }
  if (resolved.value instanceof Secret) {
    throw new TaskRunError(`${field} must not resolve to a secret.`);
  }
  return resolved.value;
}

async function evaluateWhen(
  when: Task['when'],
  context: ResolutionContext,
): Promise<boolean> {
  if (when === undefined) return true;
  const resolved = await resolveField(when, context, 'when');
  if (typeof resolved === 'boolean') return resolved;
  if (typeof resolved === 'number') return resolved !== 0;
  if (typeof resolved === 'string') {
    try {
      return truthy(
        evaluateExpression(resolved, context.evaluationContext ?? {}),
      );
    } catch (error) {
      throw new TaskRunError(
        `Cannot evaluate when '${resolved}': ${toErrorMessage(error)}`,
      );
    }
  }
  return Boolean(resolved);
}

async function positiveInteger(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
): Promise<number> {
  if (value === undefined) return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new TaskRunError(
      `${field} must be an integer of at least ${minimum}.`,
    );
  }
  return number;
}

function escapeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureResult(
  task: Task,
  attempts: number,
  error: string,
  now: () => Date,
  startedAt: Date,
): TaskResult {
  const finishedAt = now();
  return {
    name: task.name,
    status: 'failed',
    changed: false,
    attempts,
    exitCode: null,
    timedOut: false,
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    stdout: '',
    stderr: '',
    error,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
}

function limit(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… [truncated]` : text;
}

interface TaskExecution {
  readonly result: TaskResult;
}

class TaskExecutor {
  private readonly redactor: SecretRedactor;
  private readonly now: () => Date;

  public constructor(private readonly options: RunTasksOptions) {
    this.redactor = options.redactor ?? new SecretRedactor();
    this.now = options.now ?? (() => new Date());
  }

  public async execute(task: Task): Promise<TaskExecution> {
    const startedAt = this.now();
    let attempts = 0;
    try {
      if (!(await evaluateWhen(task.when, this.options.tagContext))) {
        return {
          result: this.skipped(task, startedAt, 'when'),
        };
      }

      if (task.creates !== undefined) {
        const exists = await this.options.transport.exec(
          ['test', '-e', task.creates],
          {
            timeoutMs: 5_000,
            ...(this.options.signal !== undefined
              ? { signal: this.options.signal }
              : {}),
          },
        );
        if (exists.exitCode === 0) {
          return {
            result: this.skipped(task, startedAt, 'creates'),
          };
        }
      }

      const env = await this.resolveEnv(task);
      const timeoutSeconds = await positiveInteger(
        await resolveField(task.timeout, this.options.tagContext, 'timeout'),
        'timeout',
        this.options.defaultTimeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS,
        1,
      );
      const retries = await positiveInteger(
        await resolveField(task.retries, this.options.tagContext, 'retries'),
        'retries',
        0,
        0,
      );
      const ignoreErrors = truthy(
        await resolveField(
          task.ignore_errors,
          this.options.tagContext,
          'ignore_errors',
        ),
      );
      const shell = task.shell ?? '/bin/sh';
      if (!SHELL_NAME.test(shell)) {
        throw new TaskRunError(
          `shell '${shell}' must be a plain interpreter path without arguments.`,
        );
      }

      const script = buildTaskScript(task, env);
      let last: ExecResult | undefined;
      let lastError: string | undefined;
      while (attempts <= retries) {
        attempts += 1;
        if (this.options.signal?.aborted) {
          return { result: this.cancelled(task, startedAt, attempts, last) };
        }
        try {
          last = await this.options.transport.exec([shell, '-s'], {
            stdin: script,
            timeoutMs: timeoutSeconds * 1_000,
            ...(this.options.signal !== undefined
              ? { signal: this.options.signal }
              : {}),
          });
        } catch (error) {
          if (
            this.options.signal?.aborted ||
            error instanceof TransportAbortedError
          ) {
            return { result: this.cancelled(task, startedAt, attempts, last) };
          }
          lastError = escapeError(error);
          last = undefined;
        }
        if (last?.exitCode === 0 && last.timedOut !== true) {
          return {
            result: this.finished(task, startedAt, {
              status: 'success',
              attempts,
              exitCode: 0,
              timedOut: false,
              changed: true,
              stdout: this.redact(last.stdout),
              stderr: this.redact(last.stderr),
            }),
          };
        }
        if (attempts > retries) break;
      }

      const timedOut = last?.timedOut === true;
      const status = ignoreErrors
        ? 'ignored'
        : timedOut
          ? 'timed_out'
          : 'failed';
      const error = timedOut
        ? `Task '${task.name}' timed out after ${timeoutSeconds}s.`
        : (lastError ??
          `Task '${task.name}' exited with code ${String(last?.exitCode)}.`);
      return {
        result: this.finished(task, startedAt, {
          status,
          attempts,
          exitCode: last?.exitCode ?? null,
          timedOut,
          changed: false,
          stdout: this.redact(last?.stdout ?? ''),
          stderr: this.redact(last?.stderr ?? ''),
          error,
        }),
      };
    } catch (error) {
      if (error instanceof TaskRunError) {
        return {
          result: failureResult(
            task,
            attempts,
            error.message,
            this.now,
            startedAt,
          ),
        };
      }
      return {
        result: failureResult(
          task,
          attempts,
          escapeError(error),
          this.now,
          startedAt,
        ),
      };
    }
  }

  private async resolveEnv(task: Task): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(task.env ?? {})) {
      if (!ENV_NAME.test(name)) {
        throw new TaskRunError(
          `env variable '${name}' is not a valid environment name.`,
        );
      }
      let resolved: unknown = value;
      if (isTagValue(value)) {
        const tagResult = await resolveTag(value, this.options.tagContext);
        if (tagResult.status !== 'resolved') {
          throw new TaskRunError(
            `Cannot resolve env.${name} tag '!${value.tag} ${value.value}': ${
              tagResult.status === 'error' ? tagResult.error : tagResult.reason
            }`,
          );
        }
        resolved = tagResult.value;
      }
      // Task env is the one place a secret is allowed: it is injected into the
      // script's environment and registered with the redactor before any
      // output can be persisted (D-10).
      if (resolved instanceof Secret) {
        this.redactor.register(resolved);
        resolved = resolved.unwrap();
      }
      const text = String(resolved);
      if (text.includes('\u0000')) {
        throw new TaskRunError(`env variable '${name}' must not contain NUL.`);
      }
      env[name] = text;
    }
    return env;
  }

  private redact(value: string): string {
    return limit(
      this.redactor.redact(value),
      this.options.maxOutputChars ?? DEFAULT_TASK_MAX_OUTPUT_CHARS,
    );
  }

  private cancelled(
    task: Task,
    startedAt: Date,
    attempts: number,
    last: ExecResult | undefined,
  ): TaskResult {
    return this.finished(task, startedAt, {
      status: 'cancelled',
      attempts,
      exitCode: last?.exitCode ?? null,
      timedOut: false,
      changed: false,
      stdout: this.redact(last?.stdout ?? ''),
      stderr: this.redact(last?.stderr ?? ''),
      error: 'Task was cancelled.',
    });
  }

  private skipped(
    task: Task,
    startedAt: Date,
    reason: TaskSkipReason,
  ): TaskResult {
    return this.finished(task, startedAt, {
      status: 'skipped',
      skippedReason: reason,
      attempts: 0,
      changed: false,
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
    });
  }

  private finished(
    task: Task,
    startedAt: Date,
    fields: Omit<
      TaskResult,
      'name' | 'durationMs' | 'startedAt' | 'finishedAt'
    >,
  ): TaskResult {
    const finishedAt = this.now();
    return {
      name: task.name,
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      ...fields,
    };
  }
}

function summary(
  results: readonly TaskResult[],
  cancelled: boolean,
): TaskRunSummary {
  return {
    results,
    success:
      !cancelled &&
      results.every(
        (result) => result.status !== 'failed' && result.status !== 'timed_out',
      ),
    changed: results.some((result) => result.changed),
    failed: results.filter(
      (result) => result.status === 'failed' || result.status === 'timed_out',
    ).length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    cancelled,
  };
}

/**
 * Run tasks in order. `creates` and `when` make tasks idempotent; retries and
 * `ignore_errors` follow the task fields; `onchange` tasks run once after the
 * changing task. Results are returned per task and mirrored to `onResult`.
 */
export async function runTasks(
  options: RunTasksOptions,
): Promise<TaskRunSummary> {
  const names = new Set<string>();
  for (const task of options.tasks) {
    if (names.has(task.name)) {
      throw new TaskRunError(`Duplicate task name '${task.name}'.`);
    }
    names.add(task.name);
  }
  const byName = new Map(options.tasks.map((task) => [task.name, task]));
  const executor = new TaskExecutor(options);
  const results: TaskResult[] = [];
  const executed = new Set<string>();
  let cancelled = false;

  const runOne = async (task: Task): Promise<boolean> => {
    if (cancelled || executed.has(task.name)) return false;
    executed.add(task.name);
    const { result } = await executor.execute(task);
    results.push(result);
    await options.onResult?.(result);
    if (result.status === 'cancelled') {
      cancelled = true;
      return false;
    }
    if (result.status !== 'success' || !result.changed) {
      return result.status === 'failed' || result.status === 'timed_out';
    }
    let failed = false;
    for (const name of task.onchange ?? []) {
      const next = byName.get(name);
      if (!next) {
        const now = options.now ?? (() => new Date());
        const startedAt = now();
        const unknown = failureResult(
          { ...task, name },
          0,
          `Task '${task.name}' triggers unknown task '${name}'.`,
          now,
          startedAt,
        );
        results.push(unknown);
        await options.onResult?.(unknown);
        failed = true;
        continue;
      }
      if (await runOne(next)) failed = true;
    }
    return failed;
  };

  for (const task of options.tasks) {
    if (cancelled) break;
    const failed = await runOne(task);
    if (failed && options.stopOnFailure === true) break;
  }

  return summary(results, cancelled);
}
