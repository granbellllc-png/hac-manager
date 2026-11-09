import { join } from 'node:path';
import type { FileSystem } from '../yaml/file.js';
import { defaultNodeFileSystem } from '../yaml/file.js';
import type {
  DeploymentDefaultsFile,
  GuestDeployment,
} from '../schema/deployment.js';
import { generateDeploymentYaml } from './generate.js';
import type { GuestImportPlan } from './types.js';

export interface PlanGuestImportOptions {
  readonly dataDir: string;
  readonly hostId: string;
  readonly guest: GuestDeployment;
  readonly defaults?: DeploymentDefaultsFile | undefined;
  readonly fs?: FileSystem | undefined;
}

export async function planGuestImport(
  options: PlanGuestImportOptions,
): Promise<GuestImportPlan> {
  const { dataDir, hostId, guest, defaults } = options;
  const fs = options.fs ?? defaultNodeFileSystem;

  const folderName = `${guest.id}-${guest.name}`;
  const relativeFolder = `hosts/${hostId}/${folderName}`;
  const relativeFile = `${relativeFolder}/deployment.yaml`;
  const fullPath = join(dataDir, ...relativeFile.split('/'));

  let alreadyExists = false;
  try {
    const stat = await fs.stat(fullPath);
    if (stat.isFile()) {
      alreadyExists = true;
    }
  } catch {
    alreadyExists = false;
  }

  const { yamlContent, omittedDefaults } = generateDeploymentYaml({
    guest,
    defaults,
  });

  return {
    hostId,
    vmid: guest.id,
    name: guest.name,
    type: guest.type,
    relativeFolder,
    relativeFile,
    fullPath,
    yamlContent,
    status: alreadyExists ? 'already_exists' : 'new',
    omittedDefaults,
  };
}
