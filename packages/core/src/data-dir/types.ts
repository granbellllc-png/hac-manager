import type { ConfigIssue } from '../schema/parse.js';

export interface DiscoveredTaskFile {
  readonly name: string;
  readonly path: string;
  readonly relativePath: string;
  readonly tier: 1 | 2 | 3;
}

export interface DiscoveredGuest {
  readonly hostId: string;
  readonly vmid: number;
  readonly name: string;
  readonly folderName: string;
  readonly dir: string;
  readonly relativeDir: string;
  readonly deploymentFile: string;
  readonly relativeDeploymentFile: string;
  readonly filemappingsFile?: string | undefined;
  readonly relativeFilemappingsFile?: string | undefined;
  /** Tracked `.env.yaml`; rendered into the guest as `.env` (D-18). */
  readonly envFile?: string | undefined;
  readonly relativeEnvFile?: string | undefined;
  readonly appdataDir?: string | undefined;
  readonly relativeAppdataDir?: string | undefined;
  readonly tasks: readonly DiscoveredTaskFile[];
}

export interface DiscoveredHost {
  readonly id: string;
  readonly name: string;
  readonly dir: string;
  readonly relativeDir: string;
  readonly hostFile: string;
  readonly relativeHostFile: string;
  readonly defaultDeploymentFile?: string | undefined;
  readonly relativeDefaultDeploymentFile?: string | undefined;
  readonly defaultFilemappingsFile?: string | undefined;
  readonly relativeDefaultFilemappingsFile?: string | undefined;
  readonly tasks: readonly DiscoveredTaskFile[];
  readonly guests: readonly DiscoveredGuest[];
}

export interface DiscoveredDataDir {
  readonly dataDir: string;
  readonly secretsFile?: string | undefined;
  readonly relativeSecretsFile?: string | undefined;
  readonly globalTasks: readonly DiscoveredTaskFile[];
  readonly hosts: readonly DiscoveredHost[];
  readonly fileHashes: Readonly<Record<string, string>>;
  readonly versionHash: string;
}

export type DataDirIssueCode =
  | 'duplicate_vmid'
  | 'duplicate_host_id'
  | 'duplicate_host_index'
  | 'folder_name_mismatch'
  | 'missing_file'
  | 'invalid_config'
  | 'invalid_folder_name';

export interface DataDirValidationIssue {
  readonly code: DataDirIssueCode;
  readonly message: string;
  readonly path: string;
  readonly details?: readonly ConfigIssue[] | undefined;
}
