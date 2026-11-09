import type { MutationPlan } from '@hacm/core';
import type { JobRow, PlanRow } from '../db/schema.js';

export interface GuestImportPlanPayload {
  readonly overwrite: boolean;
  readonly generatedAt: string;
  readonly requiresAdmin: boolean;
}

export interface PublicPlan extends MutationPlan {
  readonly status: PlanRow['status'];
  readonly createdBy?: string | undefined;
  readonly approvedBy?: string | undefined;
  readonly lastJobId?: string | undefined;
  readonly error?: string | undefined;
  readonly approvedAt?: string | undefined;
  readonly appliedAt?: string | undefined;
}

export interface CreateGuestImportPlanInput {
  readonly hostId: string;
  readonly vmid: number;
  readonly overwrite?: boolean | undefined;
  readonly createdBy?: string | undefined;
  readonly createdByRole?: 'admin' | 'operator' | 'viewer' | undefined;
}

export interface QueuePlanApplyInput {
  readonly dryRun?: boolean | undefined;
  readonly confirmation?: string | undefined;
  readonly user: {
    readonly id: string;
    readonly username: string;
    readonly role: 'admin' | 'operator' | 'viewer';
  };
}

export interface QueuePlanApplyResult {
  readonly plan: PublicPlan;
  readonly job: JobRow;
}

export class PlanNotFoundError extends Error {
  public constructor(public readonly planId: string) {
    super(`Plan '${planId}' was not found`);
    this.name = 'PlanNotFoundError';
  }
}

export class PlanStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PlanStateError';
  }
}

export class PlanConfirmationError extends Error {
  public constructor(public readonly expectedText: string) {
    super(`Typed confirmation must exactly match '${expectedText}'`);
    this.name = 'PlanConfirmationError';
  }
}

export class PlanOverwriteRequiredError extends Error {
  public constructor(public readonly relativeFile: string) {
    super(
      `Deployment file '${relativeFile}' already exists; create the plan with overwrite enabled to review a destructive update`,
    );
    this.name = 'PlanOverwriteRequiredError';
  }
}

export class PlanAdminRequiredError extends Error {
  public constructor() {
    super(
      'This plan replaces configuration containing execution surfaces and requires an administrator',
    );
    this.name = 'PlanAdminRequiredError';
  }
}
