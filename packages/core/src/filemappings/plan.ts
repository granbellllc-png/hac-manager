import { posix } from 'node:path';
import { hashContent } from '../data-dir/hash.js';
import { createMutationPlan } from '../plans/plan.js';
import type { MutationPlan, PlanChange } from '../plans/types.js';
import { isTagValue } from '../schema/common.js';
import {
  guestDeploymentSchema,
  type GuestDeployment,
} from '../schema/deployment.js';
import {
  filemappingsFileSchema,
  type FilemappingsFile,
} from '../schema/filemappings.js';
import { resolveGuestIdMap } from '../storage/host-dirs.js';
import {
  defaultNodeFileSystem,
  type FileStat,
  type FileSystem,
} from '../yaml/file.js';

export type ArchiveFormat = 'zip' | 'tar.gz' | 'tgz' | 'tar.bz2' | 'tar.xz';

export interface FileMappingRemoteEntry {
  /** SHA-256 of the file currently present at the destination. */
  readonly hash: string;
  readonly size?: number | undefined;
  readonly mode?: string | undefined;
}

export interface FileMappingPlanOptions {
  readonly dataDir: string;
  readonly hostId: string;
  readonly guest: GuestDeployment;
  readonly filemappings: FilemappingsFile;
  /** Optional manifest of the destinations currently present in the guest. */
  readonly remote?:
    Readonly<Record<string, FileMappingRemoteEntry>> | undefined;
  readonly fs?: FileSystem | undefined;
  readonly planId?: string | undefined;
  readonly createdAt?: Date | undefined;
  /** Required by the plan model when a directory mapping deletes files. */
  readonly confirmationText?: string | undefined;
}

export interface FileMappingPlanTarget {
  readonly kind: 'guest' | 'host';
  /** Absolute path written at apply time. */
  readonly path: string;
  /** The declared destination inside the guest. */
  readonly guestPath: string;
  readonly mountIndex?: number | undefined;
}

export interface FileMappingPlanState {
  readonly hostId: string;
  readonly vmid: number;
  readonly sources: readonly {
    readonly path: string;
    readonly hash: string;
    readonly size: number;
  }[];
  readonly remote: readonly (FileMappingRemoteEntry & {
    readonly path: string;
  })[];
}

interface SourceFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly hash: string;
  readonly size: number;
  readonly mode: string;
}

interface WalkedFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly stat: FileStat;
}

function normalizeDataDir(dataDir: string): string {
  return dataDir.replaceAll('\\', '/').replace(/\/+$/, '');
}

/**
 * A source is looked up in the guest folder first and then at the data dir
 * root (D-48). This keeps per-guest overrides next to the deployment file.
 */
function sourceCandidates(
  dataDir: string,
  hostId: string,
  guest: GuestDeployment,
  relativePath: string,
): readonly string[] {
  const root = normalizeDataDir(dataDir);
  const guestFolder = posix.join(
    root,
    'hosts',
    hostId,
    `${guest.id}-${guest.name}`,
    relativePath,
  );
  return [guestFolder, posix.join(root, relativePath)];
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

async function readHash(
  fs: FileSystem,
  absolutePath: string,
): Promise<{ readonly hash: string; readonly size: number }> {
  if (fs.readBinary) {
    const data = await fs.readBinary(absolutePath);
    return { hash: await hashContent(data), size: data.byteLength };
  }
  const content = await fs.readFile(absolutePath, 'utf8');
  return {
    hash: await hashContent(content),
    size: new TextEncoder().encode(content).byteLength,
  };
}

function modeString(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, '0');
}

async function readSourceFile(
  fs: FileSystem,
  relativePath: string,
  absolutePath: string,
  stat: FileStat,
): Promise<SourceFile> {
  const { hash, size } = await readHash(fs, absolutePath);
  return {
    relativePath,
    absolutePath,
    hash,
    size,
    mode: modeString(stat.mode),
  };
}

async function resolveSourceFile(
  fs: FileSystem,
  dataDir: string,
  hostId: string,
  guest: GuestDeployment,
  relativePath: string,
): Promise<{
  readonly file?: SourceFile;
  readonly searched: readonly string[];
}> {
  const searched = sourceCandidates(dataDir, hostId, guest, relativePath);
  for (const absolutePath of searched) {
    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) continue;
      return {
        file: await readSourceFile(fs, relativePath, absolutePath, stat),
        searched,
      };
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
  }
  return { searched };
}

async function resolveSourceDirectory(
  fs: FileSystem,
  dataDir: string,
  hostId: string,
  guest: GuestDeployment,
  relativePath: string,
): Promise<string | undefined> {
  for (const candidate of sourceCandidates(
    dataDir,
    hostId,
    guest,
    relativePath,
  )) {
    try {
      if ((await fs.stat(candidate)).isDirectory()) return candidate;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return undefined;
}

async function walkDirectory(
  fs: FileSystem,
  root: string,
  relative = '',
): Promise<readonly WalkedFile[]> {
  const directory = relative === '' ? root : posix.join(root, relative);
  const names = await fs.readdir(directory);
  const entries: WalkedFile[] = [];
  for (const name of [...names].sort()) {
    const childRelative = relative === '' ? name : posix.join(relative, name);
    const childAbsolute = posix.join(root, childRelative);
    const stat = await fs.stat(childAbsolute);
    if (stat.isDirectory()) {
      entries.push(...(await walkDirectory(fs, root, childRelative)));
    } else if (stat.isFile()) {
      entries.push({
        relativePath: childRelative,
        absolutePath: childAbsolute,
        stat,
      });
    }
  }
  return entries;
}

/** Detect the archive format from the source name, if it is an archive. */
export function archiveFormat(source: string): ArchiveFormat | undefined {
  const lower = source.toLowerCase();
  if (lower.endsWith('.tar.gz')) return 'tar.gz';
  if (lower.endsWith('.tar.bz2')) return 'tar.bz2';
  if (lower.endsWith('.tar.xz')) return 'tar.xz';
  if (lower.endsWith('.tgz')) return 'tgz';
  if (lower.endsWith('.zip')) return 'zip';
  return undefined;
}

function isWithin(parent: string, child: string): boolean {
  const root = parent.replace(/\/+$/, '');
  return child === root || child.startsWith(`${root}/`);
}

/**
 * Resolve a guest destination to its apply path. Anything below an mp0 (or
 * another LXC mount) is written directly on the host path, where the idmap
 * shift applies; other destinations are written inside the guest.
 */
function mappingTarget(
  guest: GuestDeployment,
  destination: string,
): FileMappingPlanTarget {
  if (guest.type === 'lxc') {
    const mount = (guest.mounts ?? [])
      .filter((candidate) => isWithin(candidate.guest_path, destination))
      .sort(
        (left, right) => right.guest_path.length - left.guest_path.length,
      )[0];
    if (mount) {
      const relative = destination
        .slice(mount.guest_path.length)
        .replace(/^\/+/, '');
      return {
        kind: 'host',
        path:
          relative === ''
            ? mount.host_path
            : posix.join(mount.host_path, relative),
        guestPath: destination,
        mountIndex: mount.index,
      };
    }
  }
  return { kind: 'guest', path: destination, guestPath: destination };
}

function numericOwner(value: unknown): number | undefined {
  const candidate =
    typeof value === 'string'
      ? value
      : isTagValue(value)
        ? value.value
        : undefined;
  return candidate !== undefined && /^\d+$/.test(candidate)
    ? Number(candidate)
    : undefined;
}

function isComputedOrNamed(value: unknown): boolean {
  return value !== undefined && numericOwner(value) === undefined;
}

function hostOwnership(
  guest: GuestDeployment,
  target: FileMappingPlanTarget,
  owner: unknown,
  group: unknown,
  warnings: string[],
): { readonly uid: number; readonly gid: number } | undefined {
  if (target.kind !== 'host') return undefined;
  if (isComputedOrNamed(owner) || isComputedOrNamed(group)) {
    warnings.push(
      `Mapping '${target.guestPath}' uses a computed or named owner; the plan falls back to the guest idmap base. Use numeric ids for exact ownership.`,
    );
  }
  const idmap = resolveGuestIdMap(guest);
  return {
    uid: idmap.uidBase + (numericOwner(owner) ?? 0),
    gid: idmap.gidBase + (numericOwner(group) ?? 0),
  };
}

function sourceLabel(file: SourceFile): string {
  return `${file.relativePath} (sha256 ${file.hash.slice(0, 12)}…)`;
}

function remoteBefore(
  entry: FileMappingRemoteEntry | undefined,
): FileMappingRemoteEntry | null {
  if (!entry) return null;
  return {
    hash: entry.hash,
    ...(entry.size !== undefined ? { size: entry.size } : {}),
    ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
  };
}

interface PlannerContext {
  readonly guest: GuestDeployment;
  readonly remote: Readonly<Record<string, FileMappingRemoteEntry>>;
  readonly changes: PlanChange[];
  readonly warnings: string[];
  readonly sources: FileMappingPlanState['sources'][number][];
}

function planSingleFile(
  context: PlannerContext,
  options: {
    readonly mappingIndex: number;
    readonly mapping: {
      readonly type: 'file' | 'archive' | 'template';
      readonly source: string;
      readonly destination: string;
      readonly mode?: string | undefined;
      readonly owner?: unknown;
      readonly group?: unknown;
    };
    readonly source: SourceFile;
  },
): void {
  const { mapping, mappingIndex, source } = options;
  const target = mappingTarget(context.guest, mapping.destination);
  const hostOwner = hostOwnership(
    context.guest,
    target,
    mapping.owner,
    mapping.group,
    context.warnings,
  );
  const desiredMode = mapping.mode ?? source.mode;
  const previous = context.remote[mapping.destination];
  context.sources.push({
    path: source.relativePath,
    hash: source.hash,
    size: source.size,
  });

  if (previous !== undefined && previous.hash === source.hash) return;

  const action = previous === undefined ? 'create' : 'update';
  const format =
    mapping.type === 'archive' ? archiveFormat(mapping.source) : undefined;
  if (mapping.type === 'template') {
    context.warnings.push(
      `Mapping '${mapping.source}' is a template; the plan hashes the source, while secret rendering happens at apply time (D-48/D-60).`,
    );
  }
  context.changes.push({
    id: `mapping-${mappingIndex}`,
    action,
    path: mapping.destination,
    summary:
      action === 'create'
        ? `Create ${mapping.destination} from ${sourceLabel(source)}`
        : `Update ${mapping.destination} from ${sourceLabel(source)}`,
    before: remoteBefore(previous),
    after: {
      hash: source.hash,
      size: source.size,
      mode: desiredMode,
      source: source.relativePath,
      destination: mapping.destination,
      target,
      mappingType: mapping.type,
      ...(format ? { archive: format } : {}),
      ...(hostOwner ? { hostOwner } : {}),
    },
  });
}

async function planDirectory(
  context: PlannerContext,
  fs: FileSystem,
  mappingIndex: number,
  mapping: {
    readonly source: string;
    readonly destination: string;
    readonly mode?: string | undefined;
    readonly owner?: unknown;
    readonly group?: unknown;
    readonly delete: boolean;
  },
  entries: readonly WalkedFile[],
): Promise<void> {
  const localDestinations = new Set<string>();
  for (const entry of entries) {
    const source = await readSourceFile(
      fs,
      posix.join(mapping.source, entry.relativePath),
      entry.absolutePath,
      entry.stat,
    );
    context.sources.push({
      path: source.relativePath,
      hash: source.hash,
      size: source.size,
    });
    const destination = posix.join(mapping.destination, entry.relativePath);
    localDestinations.add(destination);
    const target = mappingTarget(context.guest, destination);
    const hostOwner = hostOwnership(
      context.guest,
      target,
      mapping.owner,
      mapping.group,
      context.warnings,
    );
    const previous = context.remote[destination];
    if (previous !== undefined && previous.hash === source.hash) continue;
    const action = previous === undefined ? 'create' : 'update';
    context.changes.push({
      id: `mapping-${mappingIndex}:file:${entry.relativePath}`,
      action,
      path: destination,
      summary:
        action === 'create'
          ? `Create ${destination} from ${source.relativePath}`
          : `Update ${destination} from ${source.relativePath}`,
      before: remoteBefore(previous),
      after: {
        hash: source.hash,
        size: source.size,
        mode: mapping.mode ?? source.mode,
        source: source.relativePath,
        destination,
        target,
        mappingType: 'directory',
        ...(hostOwner ? { hostOwner } : {}),
      },
    });
  }

  if (!mapping.delete) return;
  const extra = Object.keys(context.remote)
    .filter(
      (path) =>
        isWithin(mapping.destination, path) && !localDestinations.has(path),
    )
    .sort();
  for (const path of extra) {
    const previous = context.remote[path]!;
    context.changes.push({
      id: `mapping-${mappingIndex}:delete:${path.slice(mapping.destination.length + 1)}`,
      action: 'delete',
      path,
      summary: `Delete ${path} because it is not present in ${mapping.source}`,
      before: remoteBefore(previous),
      after: null,
      destructive: true,
    });
  }
  if (extra.length > 0) {
    context.warnings.push(
      `Directory mapping '${mapping.source}' will delete ${extra.length} file(s) under '${mapping.destination}' that are not in the source.`,
    );
  }
}

/**
 * Plan a filemappings sync (D-48/D-49). The plan is local and deterministic:
 * it hashes every source file, lists create/update/delete against an optional
 * remote manifest, and resolves mp-backed destinations to the host path with
 * the mapped owner. Applying the plan is a separate job.
 */
export async function planFilemappings(
  options: FileMappingPlanOptions,
): Promise<MutationPlan> {
  const guest = guestDeploymentSchema.parse(options.guest) as GuestDeployment;
  const filemappings = filemappingsFileSchema.parse(options.filemappings);
  const fs = options.fs ?? defaultNodeFileSystem;
  const context: PlannerContext = {
    guest,
    remote: options.remote ?? {},
    changes: [],
    warnings: [],
    sources: [],
  };

  for (const [index, mapping] of filemappings.mappings.entries()) {
    if (isTagValue(mapping)) {
      context.warnings.push(
        `Mapping ${index} is an unresolved !${mapping.tag} include and was skipped; resolve includes before planning.`,
      );
      continue;
    }

    if (mapping.type === 'directory') {
      const root = await resolveSourceDirectory(
        fs,
        options.dataDir,
        options.hostId,
        guest,
        mapping.source,
      );
      if (!root) {
        context.warnings.push(
          `Mapping ${index} source directory '${mapping.source}' was not found under the guest folder or data dir; nothing will be synced.`,
        );
        continue;
      }
      await planDirectory(
        context,
        fs,
        index,
        mapping,
        await walkDirectory(fs, root),
      );
      continue;
    }

    const resolved = await resolveSourceFile(
      fs,
      options.dataDir,
      options.hostId,
      guest,
      mapping.source,
    );
    if (!resolved.file) {
      context.warnings.push(
        `Mapping ${index} source '${mapping.source}' was not found under the guest folder or data dir; searched ${resolved.searched.join(', ')}.`,
      );
      continue;
    }
    planSingleFile(context, {
      mappingIndex: index,
      mapping,
      source: resolved.file,
    });
  }

  if (context.changes.length === 0) {
    context.warnings.push('No file changes were planned.');
  }

  const state: FileMappingPlanState = {
    hostId: options.hostId,
    vmid: guest.id,
    sources: [...context.sources].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    remote: Object.entries(context.remote)
      .map(([path, entry]) => ({ path, ...entry }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };

  return createMutationPlan({
    id: options.planId ?? `files-${options.hostId}-${guest.id}`,
    operation: 'files.sync',
    target: {
      hostId: options.hostId,
      vmid: guest.id,
      resourceType: 'file',
    },
    summary: `Sync ${filemappings.mappings.length} file mapping(s) to ${
      guest.type === 'lxc' ? 'LXC' : 'VM'
    } ${guest.id}`,
    changes:
      context.changes.length > 0
        ? context.changes
        : [
            {
              id: 'noop',
              action: 'execute',
              summary: 'No file changes were planned',
            },
          ],
    warnings: context.warnings,
    currentState: state,
    ...(options.confirmationText !== undefined
      ? { confirmationText: options.confirmationText }
      : {}),
    ...(options.createdAt !== undefined
      ? { createdAt: options.createdAt }
      : {}),
  });
}
