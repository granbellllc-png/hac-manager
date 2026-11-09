import type {
  JournaledStep,
  StepExecutionContext,
  StepJournalEntry,
  StepRunResult,
  StepRunnerOptions,
} from './types.js';
import {
  StepExecutionError,
  StepJournalMismatchError,
  StepRunnerCancelledError,
} from './types.js';

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new StepRunnerCancelledError(signal.reason);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rollbackHint<TInput>(
  step: JournaledStep<TInput>,
  context: StepExecutionContext<TInput>,
  error: unknown,
): string {
  try {
    return typeof step.rollbackHint === 'function'
      ? step.rollbackHint(context, error)
      : step.rollbackHint;
  } catch (hintError) {
    return `Rollback guidance failed to render: ${errorMessage(hintError)}`;
  }
}

export async function runJournaledSteps<TInput>(
  options: StepRunnerOptions<TInput>,
): Promise<StepRunResult> {
  const {
    operationId,
    input,
    transport,
    logger,
    dryRun,
    signal,
    steps,
    journal,
  } = options;
  const context: StepExecutionContext<TInput> = {
    operationId,
    input,
    transport,
    logger,
    dryRun,
    signal,
  };
  const existingEntries = await journal.list(operationId);
  const existingByIndex = new Map(
    existingEntries.map((entry) => [entry.stepIndex, entry]),
  );

  for (const entry of existingEntries) {
    const step = steps[entry.stepIndex];
    if (!step) {
      throw new StepJournalMismatchError(
        `Journal contains unknown step index ${entry.stepIndex}`,
      );
    }
    if (step.name !== entry.name) {
      throw new StepJournalMismatchError(
        `Journal step ${entry.stepIndex} is '${entry.name}', but the runner defines '${step.name}'`,
      );
    }
  }

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex]!;
    const existing = existingByIndex.get(stepIndex);
    let currentStartedAt = existing?.startedAt;
    throwIfCancelled(signal);
    await logger.info(`Checking step ${stepIndex + 1}: ${step.name}`);

    try {
      const check = await step.check(context);
      throwIfCancelled(signal);
      if (check.status === 'satisfied') {
        const entry: StepJournalEntry = {
          operationId,
          stepIndex,
          name: step.name,
          status: 'completed',
          result: { check: check.detail, resumed: Boolean(existing) },
          startedAt: existing?.startedAt,
          finishedAt: new Date(),
        };
        await journal.save(entry);
        existingByIndex.set(stepIndex, entry);
        await logger.info(`Step already satisfied: ${step.name}`);
        continue;
      }

      if (dryRun) {
        const entry: StepJournalEntry = {
          operationId,
          stepIndex,
          name: step.name,
          status: 'skipped',
          result: { dryRun: true, wouldApply: true, check: check.detail },
          finishedAt: new Date(),
        };
        await journal.save(entry);
        existingByIndex.set(stepIndex, entry);
        await logger.info(`Dry-run would apply step: ${step.name}`);
        continue;
      }

      const startedAt = new Date();
      currentStartedAt = startedAt;
      await journal.save({
        operationId,
        stepIndex,
        name: step.name,
        status: 'running',
        startedAt,
      });
      await logger.info(`Applying step ${stepIndex + 1}: ${step.name}`);
      const applyResult = await step.apply(context);
      throwIfCancelled(signal);
      const verifyResult = await step.verify(context);
      throwIfCancelled(signal);
      const completed: StepJournalEntry = {
        operationId,
        stepIndex,
        name: step.name,
        status: 'completed',
        result: {
          check: check.detail,
          apply: applyResult,
          verify: verifyResult,
        },
        startedAt,
        finishedAt: new Date(),
      };
      await journal.save(completed);
      existingByIndex.set(stepIndex, completed);
      await logger.info(`Completed step: ${step.name}`);
    } catch (error) {
      const hint = rollbackHint(step, context, error);
      const failed: StepJournalEntry = {
        operationId,
        stepIndex,
        name: step.name,
        status: 'failed',
        result: { error: errorMessage(error) },
        rollbackHint: hint,
        startedAt: currentStartedAt ?? new Date(),
        finishedAt: new Date(),
      };
      await journal.save(failed);
      await logger.error(`Step failed: ${step.name}. Rollback hint: ${hint}`);
      if (error instanceof StepRunnerCancelledError) throw error;
      throw new StepExecutionError(stepIndex, step.name, hint, error);
    }
  }

  return {
    operationId,
    dryRun,
    entries: await journal.list(operationId),
  };
}
