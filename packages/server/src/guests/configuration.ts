import { readFile } from 'node:fs/promises';
import {
  loadYamlDocument,
  mergeGuestDeployment,
  parseConfig,
  scanDataDir,
  toErrorMessage,
  yamlDocumentToJS,
  type GuestDeployment,
  type ParseResult,
} from '@hacm/core';

export class GuestConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GuestConfigurationError';
  }
}

export interface LoadedGuestDeployment {
  readonly deployment: GuestDeployment;
  readonly relativePath: string;
}

async function parseYamlConfig<K extends 'deployment' | 'deployment-defaults'>(
  fullPath: string,
  kind: K,
): Promise<ParseResult<K>> {
  let content: string;
  try {
    content = await readFile(fullPath, 'utf8');
  } catch (error) {
    throw new GuestConfigurationError(
      `Failed to read ${kind} file '${fullPath}': ${toErrorMessage(error)}`,
    );
  }
  return parseConfig(kind, yamlDocumentToJS(loadYamlDocument(content)));
}

/** Load and merge the guest YAML with its host defaults. */
export async function loadGuestDeployment(
  dataDir: string,
  hostId: string,
  vmid: number,
): Promise<LoadedGuestDeployment | null> {
  const scan = await scanDataDir(dataDir);
  const host = scan.dataDir.hosts.find((entry) => entry.id === hostId);
  if (!host) return null;
  const guest = host.guests.find((entry) => entry.vmid === vmid);
  if (!guest) return null;

  const parsedGuest = await parseYamlConfig(guest.deploymentFile, 'deployment');
  if (!parsedGuest.ok) {
    throw new GuestConfigurationError(
      `Deployment YAML '${guest.relativeDeploymentFile}' is invalid: ${parsedGuest.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    );
  }

  let parsedDefaults:
    Extract<ParseResult<'deployment-defaults'>, { ok: true }> | undefined;
  if (host.defaultDeploymentFile && host.relativeDefaultDeploymentFile) {
    const result = await parseYamlConfig(
      host.defaultDeploymentFile,
      'deployment-defaults',
    );
    if (!result.ok) {
      throw new GuestConfigurationError(
        `Default deployment '${host.relativeDefaultDeploymentFile}' is invalid: ${result.issues
          .map((issue) => issue.message)
          .join('; ')}`,
      );
    }
    parsedDefaults = result;
  }

  try {
    const merged = mergeGuestDeployment({
      ...(parsedDefaults && host.relativeDefaultDeploymentFile
        ? {
            defaultDeployment: {
              file: host.relativeDefaultDeploymentFile,
              data: parsedDefaults.value,
            },
          }
        : {}),
      guestDeployment: {
        file: guest.relativeDeploymentFile,
        data: parsedGuest.value,
      },
    });
    return {
      deployment: merged.deployment,
      relativePath: guest.relativeDeploymentFile,
    };
  } catch (error) {
    throw new GuestConfigurationError(
      `Merged deployment for guest ${vmid} is invalid: ${toErrorMessage(error)}`,
    );
  }
}
