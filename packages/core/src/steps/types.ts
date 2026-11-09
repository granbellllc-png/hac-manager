import type { Transport } from '../transport/types.js';

export type StepJournalStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface StepJournalEntry {
  readonly operationId: string;
  readonly stepIndex: number;
  readonly name: string;
  readonly status: StepJournalStatus;
  readonly result?: unknown;
  readonly rollbackHint?: string | undefined;
  readonly startedAt?: Date | undefined;
  readonly finishedAt?: Date | undefined;
}

export interface StepJournal {
  list(operationId: string): Promise<readonly StepJournalEntry[]>;
  save(entry: StepJournalEntry): Promise<void>;
}

export interface StepLogger {
  info(message: string): Promise<void> | void;
  warn(message: string): Promise<void> | void;
  error(message: string): Promise<void> | void;
}

export interface StepExecutionContext<TInput = unknown> {
  readonly operationId: string;
  readonly input: TInput;
  readonly transport: Transport;
  readonly logger: StepLogger;
  readonly dryRun: boolean;
  readonly signal: AbortSignal;
}

export type StepCheckResult =
  | { readonly status: 'satisfied'; readonly detail?: unknown }
  | { readonly status: 'required'; readonly detail?: unknown };

export interface JournaledStep<TInput = unknown> {
  readonly name: string;
  readonly check: (
    context: StepExecutionContext<TInput>,
  ) => Promise<StepCheckResult>;
  readonly apply: (context: StepExecutionContext<TInput>) => Promise<unknown>;
  readonly verify: (context: StepExecutionContext<TInput>) => Promise<unknown>;
  readonly rollbackHint:
    | string
    | ((context: StepExecutionContext<TInput>, error: unknown) => string);
}

export interface StepRunnerOptions<
  TInput = unknown,
> extends StepExecutionContext<TInput> {
  readonly steps: readonly JournaledStep<TInput>[];
  readonly journal: StepJournal;
}

export interface StepRunResult {
  readonly operationId: string;
  readonly dryRun: boolean;
  readonly entries: readonly StepJournalEntry[];
}

export class StepExecutionError extends Error {
  public constructor(
    public readonly stepIndex: number,
    public readonly stepName: string,
    public readonly rollbackHint: string,
    public override readonly cause: unknown,
  ) {
    super(
      `Step ${stepIndex + 1} '${stepName}' failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'StepExecutionError';
  }
}

export class StepRunnerCancelledError extends Error {
  public constructor(public readonly reason?: unknown) {
    super('Step runner cancelled');
    this.name = 'StepRunnerCancelledError';
  }
}

export class StepJournalMismatchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'StepJournalMismatchError';
  }
}
