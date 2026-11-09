import type {
  GuestDeployment,
  DeploymentDefaultsFile,
} from '../schema/deployment.js';

export interface GenerateDeploymentYamlOptions {
  readonly guest: GuestDeployment;
  readonly defaults?: DeploymentDefaultsFile | undefined;
}

export interface GenerateDeploymentYamlResult {
  readonly yamlContent: string;
  readonly omittedDefaults: readonly string[];
}

export interface GuestImportPlan {
  readonly hostId: string;
  readonly vmid: number;
  readonly name: string;
  readonly type: 'lxc' | 'vm';
  readonly relativeFolder: string;
  readonly relativeFile: string;
  readonly fullPath: string;
  readonly yamlContent: string;
  readonly status: 'new' | 'already_exists';
  readonly omittedDefaults: readonly string[];
}

export interface ApplyImportResult {
  readonly success: boolean;
  readonly relativeFile: string;
  readonly fullPath: string;
  readonly reason?: 'already_exists' | 'write_conflict' | undefined;
}
