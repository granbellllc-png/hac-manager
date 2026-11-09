export type PlanChangeAction = 'create' | 'update' | 'delete' | 'execute';

export interface PlanTarget {
  readonly hostId: string;
  readonly vmid?: number | undefined;
  readonly resourceType?: 'host' | 'guest' | 'file' | undefined;
}

export interface PlanChange {
  readonly id: string;
  readonly action: PlanChangeAction;
  readonly summary: string;
  readonly path?: string | undefined;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly warnings?: readonly string[] | undefined;
  readonly destructive?: boolean | undefined;
}

export interface MutationPlan {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly operation: string;
  readonly target: PlanTarget;
  readonly summary: string;
  readonly changes: readonly PlanChange[];
  readonly warnings: readonly string[];
  readonly destructive: boolean;
  readonly stateFingerprint: string;
  readonly confirmationText?: string | undefined;
  readonly createdAt: string;
}

export interface CreateMutationPlanInput {
  readonly id: string;
  readonly operation: string;
  readonly target: PlanTarget;
  readonly summary: string;
  readonly changes: readonly PlanChange[];
  readonly warnings?: readonly string[] | undefined;
  readonly currentState: unknown;
  readonly confirmationText?: string | undefined;
  readonly createdAt?: Date | undefined;
}

export interface PlanExecutionContext {
  readonly plan: MutationPlan;
  readonly dryRun: boolean;
  readonly signal: AbortSignal;
}

export interface PlanChangeExecution {
  readonly changeId: string;
  readonly status: 'applied' | 'skipped';
  readonly detail?: unknown;
}

export interface ExecuteMutationPlanOptions {
  readonly plan: MutationPlan;
  readonly dryRun: boolean;
  readonly signal: AbortSignal;
  readonly getCurrentState: () => Promise<unknown>;
  readonly executeChange: (
    change: PlanChange,
    context: PlanExecutionContext,
  ) => Promise<Omit<PlanChangeExecution, 'changeId'>>;
}

export interface MutationPlanExecutionResult {
  readonly planId: string;
  readonly dryRun: boolean;
  readonly changes: readonly PlanChangeExecution[];
}

export class StalePlanError extends Error {
  public constructor(
    public readonly planId: string,
    public readonly expectedFingerprint: string,
    public readonly actualFingerprint: string,
  ) {
    super(
      `Plan '${planId}' is stale: expected state fingerprint '${expectedFingerprint}', got '${actualFingerprint}'`,
    );
    this.name = 'StalePlanError';
  }
}

export class PlanValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

export class PlanCancelledError extends Error {
  public constructor(public readonly reason?: unknown) {
    super('Plan execution cancelled');
    this.name = 'PlanCancelledError';
  }
}
