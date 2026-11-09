import type { TagName } from '../schema/common.js';
import type { ProvenanceMap } from '../merge/types.js';
import type { GuestDeployment } from '../schema/deployment.js';

/** Broad grouping used by the UI to organise drift entries. */
export type DriftCategory =
  | 'config'
  | 'network'
  | 'disk'
  | 'mount'
  | 'feature'
  | 'tags'
  | 'protection'
  | 'cloud_init'
  | 'identity';

export type DriftChangeKind = 'changed' | 'missing_in_live' | 'missing_in_yaml';

export interface DriftProvenance {
  readonly layer: 'default' | 'override';
  readonly file: string;
  readonly path: string;
  readonly sourcePath: string;
}

/**
 * One redacted difference between the evaluated YAML and the live guest.
 *
 * `pullable` means "Pull live to YAML is allowed". Computed fields
 * (`!expr`, `!env`, `!secret`, `!cmd`, `!include`) and secret-valued fields
 * are never pullable: writing them back would replace a tag or leak a secret.
 */
export interface DriftChange {
  readonly path: string;
  readonly category: DriftCategory;
  readonly kind: DriftChangeKind;
  readonly desired: unknown;
  readonly actual: unknown;
  readonly pullable: boolean;
  readonly computed: boolean;
  readonly secret: boolean;
  readonly tag?: TagName | undefined;
  readonly provenance?: DriftProvenance | undefined;
  readonly desiredHash?: string | undefined;
  readonly actualHash?: string | undefined;
  readonly warnings?: readonly string[] | undefined;
}

export interface GuestDriftResult {
  readonly hostId: string;
  readonly vmid: number;
  readonly type: GuestDeployment['type'];
  readonly status: 'in_sync' | 'drifted';
  readonly changes: readonly DriftChange[];
  /** Paths whose value came from a tag and therefore cannot be pulled. */
  readonly computedFields: readonly string[];
  readonly ignoredPaths: readonly string[];
  readonly checkedAt: string;
}

export interface ComputeGuestDriftOptions {
  readonly hostId: string;
  readonly vmid: number;
  readonly type: GuestDeployment['type'];
  /** Evaluated YAML. Tags that could not be resolved are still accepted. */
  readonly desired: GuestDeployment;
  /** Canonical output of the Proxmox config codec. */
  readonly live: GuestDeployment;
  readonly provenance?: ProvenanceMap | undefined;
  /** Extra path prefixes to hide from the result. */
  readonly ignoredPaths?: readonly string[] | undefined;
  readonly checkedAt?: Date | string | undefined;
}

/**
 * Fields the live codec cannot compare meaningfully, or that are intentionally
 * managed only through their dedicated workflows (secrets, tasks, backup).
 */
export const defaultDriftIgnoredPaths: readonly string[] = [
  'schema_version',
  'id',
  'type',
  'installation',
  'ssh',
  'identity_checks',
  'update_commands',
  'backup_skip',
  'backup_storage',
  'extra',
];
