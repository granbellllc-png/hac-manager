import { sanitizeAuditPayload } from '../redaction/sanitize.js';
import { fingerprintPlanState } from './fingerprint.js';
import {
  PlanCancelledError,
  PlanValidationError,
  StalePlanError,
  type CreateMutationPlanInput,
  type ExecuteMutationPlanOptions,
  type MutationPlan,
  type MutationPlanExecutionResult,
  type PlanChange,
} from './types.js';

function validateInput(input: CreateMutationPlanInput): void {
  if (!input.id.trim()) throw new PlanValidationError('Plan ID is required');
  if (!input.operation.trim()) {
    throw new PlanValidationError('Plan operation is required');
  }
  if (!input.target.hostId.trim()) {
    throw new PlanValidationError('Plan target hostId is required');
  }
  if (!input.summary.trim()) {
    throw new PlanValidationError('Plan summary is required');
  }
  if (input.changes.length === 0) {
    throw new PlanValidationError('A plan requires at least one change');
  }
  const ids = new Set<string>();
  for (const change of input.changes) {
    if (!change.id.trim()) {
      throw new PlanValidationError('Every plan change requires an ID');
    }
    if (ids.has(change.id)) {
      throw new PlanValidationError(
        `Plan change ID '${change.id}' is duplicated`,
      );
    }
    ids.add(change.id);
    if (!change.summary.trim()) {
      throw new PlanValidationError(
        `Plan change '${change.id}' requires a summary`,
      );
    }
  }
}

function sanitizeChange(change: PlanChange): PlanChange {
  return {
    id: change.id,
    action: change.action,
    summary: sanitizeAuditPayload(change.summary),
    ...(change.path !== undefined
      ? { path: sanitizeAuditPayload(change.path) }
      : {}),
    ...(change.before !== undefined
      ? { before: sanitizeAuditPayload(change.before) }
      : {}),
    ...(change.after !== undefined
      ? { after: sanitizeAuditPayload(change.after) }
      : {}),
    ...(change.warnings !== undefined
      ? { warnings: sanitizeAuditPayload([...change.warnings]) }
      : {}),
    ...(change.destructive !== undefined
      ? { destructive: change.destructive }
      : {}),
  };
}

export function createMutationPlan(
  input: CreateMutationPlanInput,
): MutationPlan {
  validateInput(input);
  const changes = input.changes.map(sanitizeChange);
  const destructive = changes.some((change) => change.destructive === true);
  const confirmationText = input.confirmationText?.trim();
  if (destructive && !confirmationText) {
    throw new PlanValidationError(
      'Destructive plans require typed confirmation text',
    );
  }
  const safeConfirmationText = confirmationText
    ? sanitizeAuditPayload(confirmationText)
    : undefined;
  if (
    confirmationText !== undefined &&
    safeConfirmationText !== confirmationText
  ) {
    throw new PlanValidationError(
      'Typed confirmation text must not contain a resolved secret',
    );
  }

  return {
    schemaVersion: 1,
    id: input.id,
    operation: input.operation,
    target: { ...input.target },
    summary: sanitizeAuditPayload(input.summary),
    changes,
    warnings: sanitizeAuditPayload([...(input.warnings ?? [])]),
    destructive,
    stateFingerprint: fingerprintPlanState(input.currentState),
    ...(safeConfirmationText ? { confirmationText: safeConfirmationText } : {}),
    createdAt: (input.createdAt ?? new Date()).toISOString(),
  };
}

export function assertPlanFresh(
  plan: MutationPlan,
  currentState: unknown,
): string {
  const actual = fingerprintPlanState(currentState);
  if (actual !== plan.stateFingerprint) {
    throw new StalePlanError(plan.id, plan.stateFingerprint, actual);
  }
  return actual;
}

export async function executeMutationPlan(
  options: ExecuteMutationPlanOptions,
): Promise<MutationPlanExecutionResult> {
  if (options.signal.aborted) {
    throw new PlanCancelledError(options.signal.reason);
  }
  assertPlanFresh(options.plan, await options.getCurrentState());
  const context = {
    plan: options.plan,
    dryRun: options.dryRun,
    signal: options.signal,
  };
  const changes = [];
  for (const change of options.plan.changes) {
    if (options.signal.aborted) {
      throw new PlanCancelledError(options.signal.reason);
    }
    const result = await options.executeChange(change, context);
    changes.push({
      changeId: change.id,
      status: result.status,
      ...(result.detail !== undefined
        ? { detail: sanitizeAuditPayload(result.detail) }
        : {}),
    });
  }
  return {
    planId: options.plan.id,
    dryRun: options.dryRun,
    changes,
  };
}
