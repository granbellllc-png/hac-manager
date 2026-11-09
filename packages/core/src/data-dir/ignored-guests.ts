import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isMap, isScalar, isSeq, type Document, type YAMLMap } from 'yaml';
import {
  defaultNodeFileSystem,
  readYamlFile,
  writeYamlFile,
  type FileSystem,
} from '../yaml/file.js';
import { appendToList, insertKey, removeFromList } from '../yaml/mutate.js';

export interface IgnoredGuestIdentity {
  readonly vmid: number;
  readonly name: string;
  readonly type: 'lxc' | 'vm';
  readonly node: string;
}

export interface IgnoredGuestEntry {
  readonly vmid: number;
  readonly name: string;
  readonly fingerprint?: string | undefined;
}

export interface IgnoredGuestResult {
  readonly ignored: boolean;
  readonly file?: string | undefined;
}

export type IgnoredGuestWriteReason =
  'host_file_missing' | 'not_inline' | 'already_ignored';

export interface IgnoredGuestWriteResult extends IgnoredGuestResult {
  /** True when the file was rewritten. */
  readonly changed: boolean;
  /** True when an existing entry was updated because its identity changed. */
  readonly replaced: boolean;
  readonly reason?: IgnoredGuestWriteReason | undefined;
}

function hostFilePath(dataDir: string, hostId: string): string {
  return join(dataDir, 'hosts', hostId, 'host.yaml');
}

function scalarValue(node: unknown): unknown {
  return isScalar(node) ? node.value : undefined;
}

function mapValue(map: YAMLMap, key: string): unknown {
  const pair = map.items.find(
    (item) => isScalar(item.key) && String(item.key.value) === key,
  );
  return pair ? scalarValue(pair.value) : undefined;
}

/**
 * Read a value as text, preserving the raw source token. A SHA-256 hex digest
 * made only of digits would otherwise be resolved as a YAML number (with its
 * leading zeroes lost), which would turn a fingerprinted entry into a legacy
 * name-only entry.
 */
function scalarText(node: unknown): string | undefined {
  if (!isScalar(node)) return undefined;
  return typeof node.source === 'string' ? node.source : undefined;
}

/**
 * Identity beyond the bare VMID (D-62). The live name, type and node are
 * hashed so a reused VMID with a different identity is not silently ignored.
 */
export function ignoredGuestFingerprint(
  identity: IgnoredGuestIdentity,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        name: identity.name,
        type: identity.type,
        node: identity.node,
      }),
    )
    .digest('hex');
}

function entriesFromDocument(
  document: Document,
): readonly (IgnoredGuestEntry & { readonly index: number })[] {
  const node = document.getIn(['ignored_guests'], true);
  if (!isSeq(node)) return [];
  const entries: (IgnoredGuestEntry & { index: number })[] = [];
  node.items.forEach((item, index) => {
    if (!isMap(item)) return;
    const vmid = Number(mapValue(item, 'vmid'));
    const name = mapValue(item, 'name');
    if (!Number.isFinite(vmid) || typeof name !== 'string') return;
    const fingerprint = scalarText(
      item.items.find(
        (pair) =>
          isScalar(pair.key) && String(pair.key.value) === 'fingerprint',
      )?.value,
    );
    entries.push({
      index,
      vmid,
      name,
      ...(fingerprint ? { fingerprint } : {}),
    });
  });
  return entries;
}

/**
 * Read the inline `ignored_guests` entries from `hosts/<host>/host.yaml`.
 * Values supplied with `!include` are not inlined and are reported as no
 * entries; callers must edit the included file explicitly.
 */
export async function listIgnoredGuests(
  dataDir: string,
  hostId: string,
  fs: FileSystem = defaultNodeFileSystem,
): Promise<readonly IgnoredGuestEntry[]> {
  try {
    const { document } = await readYamlFile(hostFilePath(dataDir, hostId), fs);
    return entriesFromDocument(document).map((entry) => ({
      vmid: entry.vmid,
      name: entry.name,
      ...(entry.fingerprint ? { fingerprint: entry.fingerprint } : {}),
    }));
  } catch {
    return [];
  }
}

/** True when the stored entry still describes the same live guest. */
export function ignoredGuestMatches(
  entry: IgnoredGuestEntry,
  identity: IgnoredGuestIdentity,
): boolean {
  if (entry.vmid !== identity.vmid) return false;
  if (entry.fingerprint) {
    return entry.fingerprint === ignoredGuestFingerprint(identity);
  }
  // Legacy entries created before fingerprints existed only carry a name.
  return entry.name === identity.name;
}

/**
 * True when `hosts/<host>/host.yaml` lists the guest inline in
 * `ignored_guests`. When `identity` is supplied, a stale entry (reused VMID
 * with a different fingerprint) is treated as not ignored.
 */
export async function isIgnoredGuest(
  dataDir: string,
  hostId: string,
  vmid: number,
  identity?: IgnoredGuestIdentity | undefined,
  fs: FileSystem = defaultNodeFileSystem,
): Promise<boolean> {
  const entries = await listIgnoredGuests(dataDir, hostId, fs);
  const entry = entries.find((candidate) => candidate.vmid === vmid);
  if (!entry) return false;
  return identity ? ignoredGuestMatches(entry, identity) : true;
}

/**
 * Add or refresh an inline `ignored_guests` entry in `host.yaml` using the CST
 * layer so comments, ordering and tags survive. When the VMID already exists
 * with a different identity, its name and fingerprint are replaced.
 */
export async function addIgnoredGuest(
  dataDir: string,
  hostId: string,
  identity: IgnoredGuestIdentity,
  fs: FileSystem = defaultNodeFileSystem,
): Promise<IgnoredGuestWriteResult> {
  const file = hostFilePath(dataDir, hostId);
  let loaded;
  try {
    loaded = await readYamlFile(file, fs);
  } catch {
    return {
      ignored: false,
      changed: false,
      replaced: false,
      file,
      reason: 'host_file_missing',
    };
  }

  const { document } = loaded;
  let node = document.getIn(['ignored_guests'], true);
  if (node === undefined) {
    insertKey(document, [], 'ignored_guests', []);
    node = document.getIn(['ignored_guests'], true);
  }
  if (!isSeq(node)) {
    return {
      ignored: false,
      changed: false,
      replaced: false,
      file,
      reason: 'not_inline',
    };
  }

  const fingerprint = ignoredGuestFingerprint(identity);
  const entries = entriesFromDocument(document);
  const existing = entries.find((entry) => entry.vmid === identity.vmid);
  if (
    existing &&
    existing.name === identity.name &&
    existing.fingerprint === fingerprint
  ) {
    return {
      ignored: true,
      changed: false,
      replaced: false,
      file,
      reason: 'already_ignored',
    };
  }

  if (existing) {
    const item = node.items[existing.index];
    if (isMap(item)) {
      item.set('vmid', identity.vmid);
      item.set('name', identity.name);
      item.set('fingerprint', fingerprint);
    }
  } else {
    appendToList(document, ['ignored_guests'], {
      vmid: identity.vmid,
      name: identity.name,
      fingerprint,
    });
  }

  await writeYamlFile(file, document, {
    atomic: true,
    eol: loaded.eol,
    mode: loaded.mode,
    fs,
  });
  return {
    ignored: true,
    changed: true,
    replaced: Boolean(existing),
    file,
  };
}

/**
 * Remove a guest from the inline `ignored_guests` list in `host.yaml` using
 * the CST layer so comments, ordering and tags survive. Entries supplied via
 * `!include` are left untouched; callers should edit that file explicitly.
 */
export async function removeIgnoredGuest(
  dataDir: string,
  hostId: string,
  vmid: number,
  fs: FileSystem = defaultNodeFileSystem,
): Promise<IgnoredGuestResult> {
  const file = hostFilePath(dataDir, hostId);
  let loaded;
  try {
    loaded = await readYamlFile(file, fs);
  } catch {
    return { ignored: false };
  }
  const index = inlineIgnoreIndex(loaded.document, vmid);
  if (index === -1) return { ignored: false, file };

  removeFromList(loaded.document, ['ignored_guests'], index);
  await writeYamlFile(file, loaded.document, {
    atomic: true,
    eol: loaded.eol,
    mode: loaded.mode,
    fs,
  });
  return { ignored: true, file };
}

function inlineIgnoreIndex(document: Document, vmid: number): number {
  const node = document.getIn(['ignored_guests'], true);
  if (!isSeq(node)) return -1;
  return node.items.findIndex((item) => {
    if (!isMap(item)) return false;
    const entry = item.items.find(
      (pair) => isScalar(pair.key) && String(pair.key.value) === 'vmid',
    );
    return Boolean(
      entry && isScalar(entry.value) && Number(entry.value.value) === vmid,
    );
  });
}
