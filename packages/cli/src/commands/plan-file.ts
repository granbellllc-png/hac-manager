import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  deploymentDefaultsFileSchema,
  hashContent,
  loadYamlDocument,
  type DeploymentDefaultsFile,
} from '@hacm/core';

export interface LocalTargetState {
  readonly exists: boolean;
  readonly hash: string | null;
  readonly value: unknown;
}

function isMissingFile(error: unknown): boolean {
  return (error as { code?: string }).code === 'ENOENT';
}

export async function loadDeploymentDefaults(
  dataDir: string,
  hostId: string,
): Promise<DeploymentDefaultsFile | undefined> {
  try {
    const content = await readFile(
      join(dataDir, 'hosts', hostId, 'default-deployment.yaml'),
      'utf8',
    );
    return deploymentDefaultsFileSchema.parse(
      loadYamlDocument(content).toJSON(),
    );
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

export async function readLocalTarget(
  fullPath: string,
): Promise<LocalTargetState> {
  try {
    const raw = await readFile(fullPath, 'utf8');
    const document = loadYamlDocument(raw);
    return {
      exists: true,
      hash: await hashContent(raw),
      value:
        document.errors.length === 0
          ? document.toJSON()
          : { invalidYaml: true },
    };
  } catch (error) {
    if (isMissingFile(error)) {
      return { exists: false, hash: null, value: null };
    }
    throw error;
  }
}
