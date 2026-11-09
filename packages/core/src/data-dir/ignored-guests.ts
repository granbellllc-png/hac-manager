import { join } from 'node:path';
import { isMap, isScalar, isSeq } from 'yaml';
import {
  defaultNodeFileSystem,
  readYamlFile,
  writeYamlFile,
  type FileSystem,
} from '../yaml/file.js';
import { removeFromList } from '../yaml/mutate.js';

export interface IgnoredGuestResult {
  readonly ignored: boolean;
  readonly file?: string | undefined;
}

function hostFilePath(dataDir: string, hostId: string): string {
  return join(dataDir, 'hosts', hostId, 'host.yaml');
}

function inlineIgnoreIndex(
  document: Awaited<ReturnType<typeof readYamlFile>>['document'],
  vmid: number,
): number {
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

/** True when `hosts/<host>/host.yaml` lists the guest inline in `ignored_guests`. */
export async function isIgnoredGuest(
  dataDir: string,
  hostId: string,
  vmid: number,
  fs: FileSystem = defaultNodeFileSystem,
): Promise<boolean> {
  try {
    const { document } = await readYamlFile(hostFilePath(dataDir, hostId), fs);
    return inlineIgnoreIndex(document, vmid) !== -1;
  } catch {
    return false;
  }
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
