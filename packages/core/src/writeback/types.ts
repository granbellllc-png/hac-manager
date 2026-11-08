import type { DiscoveredGuest, DiscoveredHost } from '../data-dir/types.js';
import type { WriteGuard } from '../data-dir/write-guard.js';
import type { FileSystem } from '../yaml/file.js';

export type PatchTarget =
  | DiscoveredGuest
  | {
      readonly deploymentFile: string;
      readonly defaultDeploymentFile?: string | undefined;
      readonly relativeDeploymentFile?: string | undefined;
      readonly relativeDefaultDeploymentFile?: string | undefined;
      readonly dir?: string | undefined;
      readonly vmid?: number | undefined;
      readonly name?: string | undefined;
    };

export interface ApplyPatchOptions {
  /**
   * If true, always write the change into the guest's own file as an override,
   * even if the value currently originates from defaults.
   * Default: false (writes to the originating layer).
   */
  readonly forceOverride?: boolean | undefined;

  /**
   * WriteGuard instance to check file hashes and prevent overwrite conflicts.
   */
  readonly writeGuard?: WriteGuard | undefined;

  /**
   * Expected file hash for the target file before writing. If provided and doesn't match,
   * write conflict is detected.
   */
  readonly expectedHash?: string | undefined;

  /**
   * Injected FileSystem. Default: defaultNodeFileSystem.
   */
  readonly fs?: FileSystem | undefined;

  /**
   * Host context if passing a DiscoveredGuest.
   */
  readonly host?: DiscoveredHost | undefined;

  /**
   * Explicit path to default-deployment.yaml if not provided on host/target.
   */
  readonly defaultDeploymentFile?: string | undefined;

  /**
   * If true, simulate the patch and return the result without modifying files on disk.
   */
  readonly dryRun?: boolean | undefined;

  /**
   * If true, throw WriteConflictError instead of returning { success: false, reason: 'write_conflict' }.
   */
  readonly throwOnConflict?: boolean | undefined;
}

export type PatchRefusalReason =
  'tag_protected' | 'target_not_found' | 'write_conflict' | 'invalid_path';

export interface ApplyPatchSuccess {
  readonly success: true;
  readonly targetFile: string;
  readonly layer: 'override' | 'default';
  readonly path: readonly (string | number)[];
  readonly pathString: string;
  readonly previousValue: unknown;
  readonly newValue: unknown;
  readonly newHash?: string | undefined;
  readonly overriddenInGuest: boolean;
}

export interface ApplyPatchRefused {
  readonly success: false;
  readonly reason: PatchRefusalReason;
  readonly message: string;
  readonly targetFile?: string | undefined;
  readonly layer?: ('override' | 'default') | undefined;
  readonly tag?: string | undefined;
  readonly rawTagValue?: string | undefined;
}

export type ApplyPatchResult = ApplyPatchSuccess | ApplyPatchRefused;
