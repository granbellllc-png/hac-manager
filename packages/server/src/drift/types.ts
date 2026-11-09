import type {
  DriftChange,
  GuestDeployment,
  PatchRefusalReason,
} from '@hacm/core';

/** A persisted, redacted drift result for one guest. */
export interface DriftSnapshot {
  readonly id: string;
  readonly hostId: string;
  readonly vmid: number;
  readonly type: GuestDeployment['type'];
  readonly status: 'in_sync' | 'drifted';
  readonly changes: readonly DriftChange[];
  readonly computedFields: readonly string[];
  readonly ignoredPaths: readonly string[];
  readonly checkedAt: string;
}

export interface DriftSnapshotFilter {
  readonly hostId?: string | undefined;
  readonly vmid?: number | undefined;
  readonly statuses?: readonly DriftSnapshot['status'][] | undefined;
  readonly limit?: number | undefined;
}

export interface GuestDriftFailure {
  readonly vmid: number;
  readonly message: string;
}

export interface HostDriftCheckResult {
  readonly hostId: string;
  readonly checked: number;
  readonly snapshots: readonly DriftSnapshot[];
  readonly failures: readonly GuestDriftFailure[];
}

export type DriftResolutionRole = 'admin' | 'operator' | 'viewer';

export interface DriftResolutionUser {
  readonly id: string;
  readonly role: DriftResolutionRole;
}

export interface DriftPullInput {
  readonly user: DriftResolutionUser;
  /** Optional subset of drift paths. Omit to pull every pullable change. */
  readonly paths?: readonly string[] | undefined;
  readonly dryRun?: boolean | undefined;
}

export type DriftPullFailureReason =
  | 'not_pullable'
  | 'missing_in_live'
  | 'path_not_found'
  | 'apply_failed'
  | PatchRefusalReason;

export interface DriftPullFailure {
  readonly path: string;
  readonly reason: DriftPullFailureReason;
  readonly message: string;
}

export interface DriftPullApplied {
  readonly path: string;
  readonly targetFile: string;
  readonly layer: 'override' | 'default';
  readonly previousValue: unknown;
  readonly newValue: unknown;
}

export interface DriftPullResult {
  readonly hostId: string;
  readonly vmid: number;
  readonly dryRun: boolean;
  readonly applied: readonly DriftPullApplied[];
  readonly failures: readonly DriftPullFailure[];
  /** Fresh drift snapshot taken after the pull (or the pre-pull snapshot on dry-run). */
  readonly snapshot: DriftSnapshot;
}
