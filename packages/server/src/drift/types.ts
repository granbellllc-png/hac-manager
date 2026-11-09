import type { DriftChange, GuestDeployment } from '@hacm/core';

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
