import { readFile } from 'node:fs/promises';
import {
  defaultNodeFileSystem,
  hashContent,
  isTagValue,
  loadYamlDocument,
  parseConfig,
  readYamlFile,
  scanDataDir,
  WriteGuard,
  yamlDocumentToJS,
  type ConfigIssue,
  type GuestDeploymentFile,
} from '@hacm/core';

type YamlDocument = ReturnType<typeof loadYamlDocument>;

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

export type AdminOnlyConfigSurface =
  'tasks' | 'cmd' | 'include' | 'installation_url';

export type ParsedGuestConfiguration =
  | {
      readonly ok: false;
      readonly issues: readonly ConfigIssue[];
      readonly adminOnly: readonly AdminOnlyConfigSurface[];
    }
  | {
      readonly ok: true;
      readonly document: YamlDocument;
      readonly config: GuestDeploymentFile;
      readonly issues: readonly [];
      readonly adminOnly: readonly AdminOnlyConfigSurface[];
    };

export interface GuestConfigurationIdentity {
  readonly vmid: number;
  readonly name: string;
  readonly relativePath: string;
}

export interface SavedGuestConfiguration {
  readonly rawYaml: string;
  readonly hash: string;
  readonly config: GuestDeploymentFile;
}

function guestKey(hostId: string, vmid: number): string {
  return `${hostId}:${vmid}`;
}

function collectAdminOnlySurfaces(
  value: unknown,
  relativePath: string,
): readonly AdminOnlyConfigSurface[] {
  const surfaces = new Set<AdminOnlyConfigSurface>();
  const seen = new WeakSet<object>();
  const normalizedPath = relativePath.replaceAll('\\', '/');
  if (/(^|\/)tasks\//.test(normalizedPath)) {
    surfaces.add('tasks');
  }

  function walk(current: unknown, path: readonly string[]): void {
    if (isTagValue(current)) {
      if (current.tag === 'cmd') surfaces.add('cmd');
      if (current.tag === 'include') surfaces.add('include');
      return;
    }

    if (typeof current !== 'object' || current === null) return;
    if (seen.has(current)) return;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) walk(item, path);
      return;
    }

    for (const [key, child] of Object.entries(
      current as Record<string, unknown>,
    )) {
      const childPath = [...path, key];
      if (key === 'tasks') surfaces.add('tasks');
      if (
        key === 'url' &&
        childPath.length >= 2 &&
        childPath[childPath.length - 2] === 'installation'
      ) {
        surfaces.add('installation_url');
      }
      walk(child, childPath);
    }
  }

  walk(value, []);
  return [...surfaces].sort();
}

function hasReferenceCycle(value: unknown): boolean {
  const visited = new WeakSet<object>();
  const active = new WeakSet<object>();

  function visit(current: unknown): boolean {
    if (typeof current !== 'object' || current === null) return false;
    if (active.has(current)) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    active.add(current);
    const children = Array.isArray(current)
      ? current
      : Object.values(current as Record<string, unknown>);
    for (const child of children) {
      if (visit(child)) return true;
    }
    active.delete(current);
    return false;
  }

  return visit(value);
}

export function parseGuestConfigurationForEditor(
  rawYaml: string,
  identity: GuestConfigurationIdentity,
): ParsedGuestConfiguration {
  let document: YamlDocument;
  try {
    document = loadYamlDocument(rawYaml);
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          path: '',
          code: 'yaml_parse',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      adminOnly: [],
    };
  }

  if (document.errors.length > 0) {
    return {
      ok: false,
      issues: document.errors.map(
        (error: { code: string; message: string }) => ({
          path: '',
          code: error.code,
          message: error.message,
        }),
      ),
      adminOnly: [],
    };
  }

  let rawValue: unknown;
  try {
    rawValue = yamlDocumentToJS<unknown>(document);
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          path: '',
          code: 'yaml_parse',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      adminOnly: [],
    };
  }
  if (hasReferenceCycle(rawValue)) {
    return {
      ok: false,
      issues: [
        {
          path: '',
          code: 'yaml_cycle',
          message: 'YAML aliases must not create reference cycles',
        },
      ],
      adminOnly: [],
    };
  }
  const adminOnly = collectAdminOnlySurfaces(rawValue, identity.relativePath);

  const parsed = parseConfig('deployment', rawValue);
  if (!parsed.ok) {
    return { ok: false, issues: parsed.issues, adminOnly };
  }

  const identityIssues: ConfigIssue[] = [];
  if (parsed.value.id !== identity.vmid) {
    identityIssues.push({
      path: 'id',
      code: 'identity_mismatch',
      message: `VMID must remain ${identity.vmid}`,
    });
  }
  if (parsed.value.name !== identity.name) {
    identityIssues.push({
      path: 'name',
      code: 'identity_mismatch',
      message: `Guest name must remain '${identity.name}' until directory rename support is available`,
    });
  }
  if (identityIssues.length > 0) {
    return { ok: false, issues: identityIssues, adminOnly };
  }

  return {
    ok: true,
    document,
    config: parsed.value,
    issues: [],
    adminOnly,
  };
}

export async function saveGuestConfiguration(
  guest: ConfiguredGuestIndexEntry,
  parsed: Extract<ParsedGuestConfiguration, { readonly ok: true }>,
  expectedHash: string,
): Promise<SavedGuestConfiguration> {
  const current = await readYamlFile(guest.deploymentFile);
  const writeGuard = new WriteGuard();
  await writeGuard.writeWithGuard(
    guest.deploymentFile,
    parsed.document,
    expectedHash,
    defaultNodeFileSystem,
    { eol: current.eol, mode: current.mode },
  );
  const rawYaml = await readFile(guest.deploymentFile, 'utf8');
  return {
    rawYaml,
    hash: await hashContent(rawYaml),
    config: parsed.config,
  };
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
  if (document.errors.length > 0) {
    return {
      status: 'configured',
      relativePath: guest.relativePath,
      rawYaml,
      hash: await hashContent(rawYaml),
      issues: document.errors.map(
        (error: { code: string; message: string }) => ({
          path: '',
          code: error.code,
          message: error.message,
        }),
      ),
    };
  }
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
