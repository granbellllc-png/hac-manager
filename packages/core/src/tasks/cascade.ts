import type { ResolutionContext } from '../tags/types.js';
import type { Transport } from '../transport/types.js';
import {
  taskTargetsMatchHost,
  type TaskHostIdentity,
  type TaskTargets,
} from './order.js';
import { runTasks } from './runner.js';
import { TaskRunError, type Task, type TaskResult } from './types.js';

/** The declarative task tiers of D-51. */
export type TaskTier = 1 | 2 | 3;

/**
 * What happens after a task or tier fails.
 *
 * - `abort`: stop the remaining tasks of the failing tier and every later tier.
 * - `abort-tier`: stop the remaining tasks of the failing tier, then continue
 *   with the next tier.
 * - `continue`: keep running later tasks and tiers.
 *
 * A task with `ignore_errors` never fails the cascade (D-51).
 */
export type TaskFailurePolicy = 'abort' | 'abort-tier' | 'continue';

export type TierSkipReason =
  'empty' | 'target' | 'prerequisites' | 'resume' | 'aborted';

/**
 * Tier 3 only runs after a file sync and after identity and storage invariants
 * have been verified (D-51). Callers must state each prerequisite explicitly;
 * an omitted prerequisite is treated as not satisfied.
 */
export interface TaskTierPrerequisites {
  readonly fileSyncCompleted?: boolean | undefined;
  readonly identityVerified?: boolean | undefined;
  readonly invariantsVerified?: boolean | undefined;
}

export interface CascadeTier {
  readonly tier: TaskTier;
  readonly tasks: readonly Task[];
  /** Transport on the target: host transport for tiers 1/2, guest for tier 3. */
  readonly transport: Transport;
  readonly tagContext: ResolutionContext;
  /** Tier 1 only: select hosts by group or tag. */
  readonly targets?: TaskTargets | undefined;
  /** Tier 1 only: the host being evaluated. */
  readonly host?: TaskHostIdentity | undefined;
  /** Tier 3 only: proof that the guest is ready for post-sync tasks. */
  readonly prerequisites?: TaskTierPrerequisites | undefined;
  readonly label?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly defaultTimeoutSeconds?: number | undefined;
  readonly maxOutputChars?: number | undefined;
  readonly onResult?:
    ((result: TaskResult) => void | Promise<void>) | undefined;
}

export interface RunTaskCascadeOptions {
  readonly tiers: readonly CascadeTier[];
  readonly failurePolicy?: TaskFailurePolicy | undefined;
  /** Skip tiers below this one, for resuming an interrupted cascade. */
  readonly resumeFrom?: TaskTier | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface TierRunResult {
  readonly tier: TaskTier;
  readonly label: string | undefined;
  readonly status: 'ran' | 'skipped' | 'cancelled';
  readonly skipReason?: TierSkipReason | undefined;
  readonly results: readonly TaskResult[];
  readonly success: boolean;
  readonly changed: boolean;
  readonly failed: number;
  readonly skipped: number;
  readonly cancelled: boolean;
}

export interface CascadeRunResult {
  readonly tiers: readonly TierRunResult[];
  readonly failurePolicy: TaskFailurePolicy;
  readonly success: boolean;
  readonly changed: boolean;
  readonly failed: number;
  readonly skippedTiers: number;
  readonly cancelled: boolean;
  /** True when a tier was skipped because an earlier failure aborted the run. */
  readonly stopped: boolean;
}

export class TaskCascadeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TaskCascadeError';
  }
}

function skippedTier(tier: CascadeTier, reason: TierSkipReason): TierRunResult {
  return {
    tier: tier.tier,
    label: tier.label,
    status: 'skipped',
    skipReason: reason,
    results: [],
    success: true,
    changed: false,
    failed: 0,
    skipped: 0,
    cancelled: false,
  };
}

function prerequisitesSatisfied(tier: CascadeTier): boolean {
  if (tier.tier !== 3) return true;
  const prerequisites = tier.prerequisites;
  return (
    prerequisites?.fileSyncCompleted === true &&
    prerequisites.identityVerified === true &&
    prerequisites.invariantsVerified === true
  );
}

function tierTargetMatches(tier: CascadeTier): boolean {
  if (tier.tier !== 1) return true;
  if (tier.targets === undefined) return true;
  return tier.host !== undefined
    ? taskTargetsMatchHost(tier.targets, tier.host)
    : false;
}

/**
 * Run the three tiers in ascending order with resume and skip rules.
 *
 * Tier 1 files without targets apply to every host. Tier 3 is skipped unless
 * file sync, identity checks and invariant checks have all completed. A failure
 * is handled by the configured policy; skipped tiers are still reported so a UI
 * can show why nothing ran.
 */
export async function runTaskCascade(
  options: RunTaskCascadeOptions,
): Promise<CascadeRunResult> {
  const failurePolicy = options.failurePolicy ?? 'abort';
  const seen = new Set<TaskTier>();
  for (const tier of options.tiers) {
    if (seen.has(tier.tier)) {
      throw new TaskCascadeError(`Tier ${tier.tier} is configured twice.`);
    }
    seen.add(tier.tier);
  }
  const tiers = [...options.tiers].sort((a, b) => a.tier - b.tier);
  const results: TierRunResult[] = [];
  let aborted = false;
  let cancelled = false;
  let changed = false;
  let failed = 0;

  for (const tier of tiers) {
    if (aborted || cancelled) {
      results.push(skippedTier(tier, 'aborted'));
      continue;
    }
    if (options.resumeFrom !== undefined && tier.tier < options.resumeFrom) {
      results.push(skippedTier(tier, 'resume'));
      continue;
    }
    if (tier.tasks.length === 0) {
      results.push(skippedTier(tier, 'empty'));
      continue;
    }
    if (!tierTargetMatches(tier)) {
      results.push(skippedTier(tier, 'target'));
      continue;
    }
    if (!prerequisitesSatisfied(tier)) {
      results.push(skippedTier(tier, 'prerequisites'));
      continue;
    }

    const signal = tier.signal ?? options.signal;
    const summary = await runTasks({
      tasks: tier.tasks,
      transport: tier.transport,
      tagContext: tier.tagContext,
      ...(signal !== undefined ? { signal } : {}),
      ...(tier.defaultTimeoutSeconds !== undefined
        ? { defaultTimeoutSeconds: tier.defaultTimeoutSeconds }
        : {}),
      ...(tier.maxOutputChars !== undefined
        ? { maxOutputChars: tier.maxOutputChars }
        : {}),
      ...(tier.onResult !== undefined ? { onResult: tier.onResult } : {}),
      stopOnFailure: failurePolicy !== 'continue',
    });

    const tierResult: TierRunResult = {
      tier: tier.tier,
      label: tier.label,
      status: summary.cancelled ? 'cancelled' : 'ran',
      results: summary.results,
      success: summary.success,
      changed: summary.changed,
      failed: summary.failed,
      skipped: summary.skipped,
      cancelled: summary.cancelled,
    };
    results.push(tierResult);
    changed ||= summary.changed;
    failed += summary.failed;
    if (summary.cancelled) cancelled = true;
    if (!summary.success && failurePolicy === 'abort') aborted = true;
  }

  return {
    tiers: results,
    failurePolicy,
    success: !cancelled && failed === 0,
    changed,
    failed,
    skippedTiers: results.filter((tier) => tier.status === 'skipped').length,
    cancelled,
    stopped: aborted,
  };
}

/** Validate the failure policy name before it reaches a job or persisted setting. */
export function parseTaskFailurePolicy(value: unknown): TaskFailurePolicy {
  if (value === 'abort' || value === 'abort-tier' || value === 'continue') {
    return value;
  }
  throw new TaskRunError(
    `Task failure policy must be 'abort', 'abort-tier' or 'continue'.`,
  );
}
