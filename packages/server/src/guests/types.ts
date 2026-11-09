import type { GuestDeployment } from '@hacm/core';
import type { LiveGuestSummary } from '../inventory/types.js';

export interface GuestSnapshot {
  readonly hostId: string;
  readonly vmid: number;
  readonly type: GuestDeployment['type'];
  readonly summary: LiveGuestSummary;
  readonly deployment: GuestDeployment;
  readonly status: string;
}

export interface GuestIdentityCheckResult {
  readonly check: string;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stderr: string;
}

export interface GuestIdentityReport {
  readonly hostId: string;
  readonly vmid: number;
  readonly name: string;
  readonly type: GuestDeployment['type'];
  readonly status: GuestIdentityStatus;
  readonly managed: boolean;
  readonly expectedUuid: string;
  readonly actualUuid?: string | undefined;
  readonly messages: readonly string[];
  readonly checks: readonly GuestIdentityCheckResult[];
}

export type GuestIdentityStatus =
  | 'missing'
  | 'verified'
  | 'unmanaged'
  | 'name-mismatch'
  | 'type-mismatch'
  | 'stamp-mismatch';

export interface GuestLifecycleProtectedConfig {
  readonly hostId?: string | undefined;
  readonly vmid?: number | undefined;
}

export class GuestNotFoundError extends Error {
  public constructor(
    public readonly hostId: string,
    public readonly vmid: number,
  ) {
    super(`Guest ${vmid} was not found on host '${hostId}'`);
    this.name = 'GuestNotFoundError';
  }
}

export class GuestStateUnavailableError extends Error {
  public constructor(
    public readonly hostId: string,
    message: string,
  ) {
    super(`Unable to inspect guests on host '${hostId}': ${message}`);
    this.name = 'GuestStateUnavailableError';
  }
}

export class ProtectedGuestError extends Error {
  public constructor(
    public readonly hostId: string,
    public readonly vmid: number,
    reason = 'This is the guest hosting HAC Manager',
  ) {
    super(
      `Guest ${vmid} on host '${hostId}' is protected: ${reason}. Self-management is blocked.`,
    );
    this.name = 'ProtectedGuestError';
  }
}

export class GuestProtectionEnabledError extends Error {
  public constructor(
    public readonly hostId: string,
    public readonly vmid: number,
  ) {
    super(
      `Guest ${vmid} on host '${hostId}' has protection enabled. Lift protection explicitly before a destructive action.`,
    );
    this.name = 'GuestProtectionEnabledError';
  }
}

export class GuestIdentityError extends Error {
  public constructor(public readonly report: GuestIdentityReport) {
    super(report.messages.join(' '));
    this.name = 'GuestIdentityError';
  }
}

export class GuestStoppedIdentityError extends Error {
  public constructor(
    public readonly hostId: string,
    public readonly vmid: number,
  ) {
    super(
      `Guest ${vmid} on host '${hostId}' is stopped. Start it before running identity checks, then retry the guarded operation.`,
    );
    this.name = 'GuestStoppedIdentityError';
  }
}

export class GuestIdentityCheckError extends Error {
  public constructor(public readonly result: GuestIdentityCheckResult) {
    super(
      `Identity check failed in guest ${result.check}: exit code ${result.exitCode}${result.stderr ? ` (${result.stderr})` : ''}. Refusing to touch this workload.`,
    );
    this.name = 'GuestIdentityCheckError';
  }
}
