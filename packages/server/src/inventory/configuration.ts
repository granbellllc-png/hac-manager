import { readFile } from 'node:fs/promises';
import {
  hashContent,
  loadYamlDocument,
  parseConfig,
  scanDataDir,
  yamlDocumentToJS,
  type ConfigIssue,
  type GuestDeploymentFile,
} from '@hacm/core';

export interface ConfiguredGuestIndexEntry {
  readonly hostId: string;
  readonly vmid: number;
  readonly name: string;
  readonly relativePath: string;
  readonly deploymentFile: string;
}

export type GuestConfigurationSnapshot =
  | { readonly status: 'orphan' }
  | {
      readonly status: 'configured';
      readonly relativePath: string;
      readonly rawYaml: string;
      readonly hash: string;
      readonly config?: GuestDeploymentFile | undefined;
      readonly issues: readonly ConfigIssue[];
    };

function guestKey(hostId: string, vmid: number): string {
  return `${hostId}:${vmid}`;
}

export async function indexConfiguredGuests(
  dataDir: string,
): Promise<ReadonlyMap<string, ConfiguredGuestIndexEntry>> {
  const scan = await scanDataDir(dataDir);
  const entries = new Map<string, ConfiguredGuestIndexEntry>();

  for (const host of scan.dataDir.hosts) {
    for (const guest of host.guests) {
      entries.set(guestKey(host.id, guest.vmid), {
        hostId: host.id,
        vmid: guest.vmid,
        name: guest.name,
        relativePath: guest.relativeDeploymentFile,
        deploymentFile: guest.deploymentFile,
      });
    }
  }

  return entries;
}

export function getConfiguredGuestFromIndex(
  index: ReadonlyMap<string, ConfiguredGuestIndexEntry>,
  hostId: string,
  vmid: number,
): ConfiguredGuestIndexEntry | undefined {
  return index.get(guestKey(hostId, vmid));
}

export async function readGuestConfiguration(
  dataDir: string,
  hostId: string,
  vmid: number,
): Promise<GuestConfigurationSnapshot> {
  const index = await indexConfiguredGuests(dataDir);
  const guest = getConfiguredGuestFromIndex(index, hostId, vmid);

  if (!guest) {
    return { status: 'orphan' };
  }

  const rawYaml = await readFile(guest.deploymentFile, 'utf8');
  const document = loadYamlDocument(rawYaml);
  const parsed = parseConfig('deployment', yamlDocumentToJS<unknown>(document));

  return {
    status: 'configured',
    relativePath: guest.relativePath,
    rawYaml,
    hash: await hashContent(rawYaml),
    ...(parsed.ok ? { config: parsed.value } : {}),
    issues: parsed.ok ? [] : parsed.issues,
  };
}
