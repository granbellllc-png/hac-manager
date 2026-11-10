import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { JournaledStep } from '../steps/types.js';
import type { ExecOptions, ExecResult, Transport } from '../transport/types.js';
import { buildTarGz, type TarEntry } from './tar.js';
import type { ArchiveFormat } from './plan.js';

/** Directory on the Proxmox host used to stage uploads before `pct push`. */
export const LXC_TRANSFER_STAGING_ROOT = '/var/tmp';
/** Directory inside the guest used for tar archives and extracted files. */
export const LXC_TRANSFER_GUEST_ROOT = '/var/tmp';
export const LXC_TRANSFER_TIMEOUT_MS = 3_600_000;

export type LxcTransferTarget =
  { readonly kind: 'guest'; readonly vmid: number } | { readonly kind: 'host' };

export interface LxcTransferFile {
  /** Relative path below the destination directory. */
  readonly path: string;
  readonly content: string | Uint8Array;
  /** Octal mode at the destination, defaults to `0644`. */
  readonly mode?: string | undefined;
  /** Numeric UID/GID at the destination (already idmap-shifted for host paths). */
  readonly owner?: number | undefined;
  readonly group?: number | undefined;
  readonly mtime?: Date | undefined;
}

export interface LxcTransferOptions {
  readonly target: LxcTransferTarget;
  /** Absolute destination file or directory inside the guest, or on the host. */
  readonly destination: string;
  readonly stagingRoot?: string | undefined;
  /** Deterministic safe token for staging paths; generated when omitted. */
  readonly token?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface LxcDirectoryTransferOptions extends LxcTransferOptions {
  readonly files: readonly LxcTransferFile[];
  /** Absolute destination paths to remove after the transfer. */
  readonly deletePaths?: readonly string[] | undefined;
}

export interface LxcFileTransferOptions extends LxcTransferOptions {
  readonly content: string | Uint8Array;
  readonly mode?: string | undefined;
  readonly owner?: number | undefined;
  readonly group?: number | undefined;
}

export interface LxcArchiveTransferOptions extends LxcTransferOptions {
  readonly archive: string | Uint8Array;
  readonly format: ArchiveFormat;
}

export class LxcFileTransferError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LxcFileTransferError';
  }
}

function assertAbsolutePath(value: string, label: string): string {
  if (
    !value.startsWith('/') ||
    value === '/' ||
    posix.normalize(value) !== value ||
    value.split('/').includes('..')
  ) {
    throw new LxcFileTransferError(
      `${label} '${value}' must be a normalized absolute path below '/'.`,
    );
  }
  return value;
}

function assertRelativePath(value: string): string {
  if (
    value === '' ||
    value.startsWith('/') ||
    posix.normalize(value) !== value ||
    value.split('/').includes('..')
  ) {
    throw new LxcFileTransferError(
      `Transfer path '${value}' must be a normalized relative path.`,
    );
  }
  return value;
}

function assertVmid(vmid: number): void {
  if (!Number.isSafeInteger(vmid) || vmid < 1) {
    throw new LxcFileTransferError(`VMID '${vmid}' is not a positive integer.`);
  }
}

function assertMode(mode: string | undefined): string {
  if (mode === undefined) return '0644';
  if (!/^[0-7]{3,4}$/.test(mode)) {
    throw new LxcFileTransferError(`Mode '${mode}' is not octal.`);
  }
  return mode;
}

function assertId(value: number | undefined, label: string): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < 0 || value > 4_294_967_295)
  ) {
    throw new LxcFileTransferError(`${label} '${value}' is not a valid id.`);
  }
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string'
    ? new TextEncoder().encode(content)
    : content;
}

function stagingRoot(options: LxcTransferOptions): string {
  return assertAbsolutePath(
    options.stagingRoot ?? LXC_TRANSFER_STAGING_ROOT,
    'Staging root',
  );
}

function transferToken(options: LxcTransferOptions): string {
  const token = options.token ?? randomUUID().replaceAll('-', '').slice(0, 16);
  if (!/^[A-Za-z0-9._-]+$/.test(token)) {
    throw new LxcFileTransferError(
      `Transfer token '${token}' may only contain letters, digits, dot, underscore or dash.`,
    );
  }
  return token;
}

function hostStagingPath(options: LxcTransferOptions, suffix: string): string {
  return posix.join(
    stagingRoot(options),
    `hacm-${transferToken(options)}.${suffix}`,
  );
}

function guestStagingPath(options: LxcTransferOptions, suffix: string): string {
  return posix.join(
    LXC_TRANSFER_GUEST_ROOT,
    `hacm-${transferToken(options)}.${suffix}`,
  );
}

async function run(
  transport: Transport,
  argv: readonly string[],
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly timeoutMs?: number | undefined;
    readonly stdin?: string | undefined;
  } = {},
): Promise<ExecResult> {
  const execOptions: ExecOptions = {
    timeoutMs: options.timeoutMs ?? LXC_TRANSFER_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
  };
  const result = await transport.exec(argv, execOptions);
  if (result.exitCode !== 0) {
    throw new LxcFileTransferError(
      `Command '${argv.join(' ')}' failed: ${
        result.stderr.trim() || `exit code ${result.exitCode}`
      }`,
    );
  }
  return result;
}

async function stageBase64(
  transport: Transport,
  content: Uint8Array,
  base64Path: string,
  binaryPath: string,
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly timeoutMs?: number | undefined;
  },
): Promise<void> {
  await transport.writeFile(
    base64Path,
    Buffer.from(content).toString('base64'),
    {
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  await run(transport, ['bash', '-s', '--', base64Path, binaryPath], {
    ...options,
    stdin: 'set -euo pipefail\nbase64 -d -- "$1" > "$2"\n',
  });
}

async function cleanupHostFiles(
  transport: Transport,
  paths: readonly string[],
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<void> {
  await transport
    .exec(['rm', '-f', '--', ...paths], {
      timeoutMs: 30_000,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    .catch(() => undefined);
}

function targetArgv(
  target: LxcTransferTarget,
  argv: readonly string[],
): readonly string[] {
  return target.kind === 'guest'
    ? ['pct', 'exec', String(target.vmid), '--', ...argv]
    : argv;
}

async function runInTarget(
  transport: Transport,
  target: LxcTransferTarget,
  argv: readonly string[],
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly timeoutMs?: number | undefined;
    readonly stdin?: string | undefined;
  } = {},
): Promise<ExecResult> {
  return run(transport, targetArgv(target, argv), options);
}

async function deleteTargetPaths(
  transport: Transport,
  target: LxcTransferTarget,
  paths: readonly string[],
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<void> {
  if (paths.length === 0) return;
  for (const path of paths) assertAbsolutePath(path, 'Delete path');
  await runInTarget(transport, target, ['rm', '-f', '--', ...paths], options);
}

async function targetExists(
  transport: Transport,
  target: LxcTransferTarget,
  path: string,
  kind: 'file' | 'directory',
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<boolean> {
  const result = await runInTarget(
    transport,
    target,
    ['test', kind === 'directory' ? '-d' : '-f', path],
    options,
  ).catch(() => undefined);
  return result !== undefined;
}

function targetLabel(target: LxcTransferTarget): string {
  return target.kind === 'guest' ? `LXC ${target.vmid}` : 'the host';
}

/** Stage, decode and install one file on the host path (mp0 destinations). */
async function transferHostFile(
  transport: Transport,
  options: LxcFileTransferOptions,
  signal: AbortSignal | undefined,
): Promise<void> {
  const destination = assertAbsolutePath(options.destination, 'Destination');
  const mode = assertMode(options.mode);
  assertId(options.owner, 'Owner');
  assertId(options.group, 'Group');
  const base64Path = hostStagingPath(options, 'b64');
  const binaryPath = hostStagingPath(options, 'upload');
  try {
    await stageBase64(
      transport,
      toBytes(options.content),
      base64Path,
      binaryPath,
      { signal, timeoutMs: options.timeoutMs },
    );
    await run(
      transport,
      [
        'bash',
        '-s',
        '--',
        binaryPath,
        destination,
        mode,
        options.owner === undefined ? '' : String(options.owner),
        options.group === undefined ? '' : String(options.group),
      ],
      {
        signal,
        timeoutMs: options.timeoutMs,
        stdin: [
          'set -euo pipefail',
          'install -d -- "$(dirname -- "$2")"',
          'if [ -n "$4" ] && [ -n "$5" ]; then',
          '  install -m "$3" -o "$4" -g "$5" -- "$1" "$2"',
          'else',
          '  install -m "$3" -- "$1" "$2"',
          'fi',
          'rm -f -- "$1"',
          '',
        ].join('\n'),
      },
    );
  } finally {
    await cleanupHostFiles(transport, [base64Path, binaryPath], { signal });
  }
}

/** Upload one file with `pct push`, preserving mode and numeric ownership. */
async function transferGuestFile(
  transport: Transport,
  options: LxcFileTransferOptions,
  vmid: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const destination = assertAbsolutePath(options.destination, 'Destination');
  const mode = assertMode(options.mode);
  assertId(options.owner, 'Owner');
  assertId(options.group, 'Group');
  const base64Path = hostStagingPath(options, 'b64');
  const binaryPath = hostStagingPath(options, 'upload');
  try {
    await stageBase64(
      transport,
      toBytes(options.content),
      base64Path,
      binaryPath,
      { signal, timeoutMs: options.timeoutMs },
    );
    await runInTarget(
      transport,
      { kind: 'guest', vmid },
      ['sh', '-s', '--', posix.dirname(destination)],
      {
        signal,
        stdin: 'set -euo pipefail\nmkdir -p -- "$1"\n',
      },
    );
    await run(
      transport,
      [
        'pct',
        'push',
        String(vmid),
        binaryPath,
        destination,
        '--perms',
        mode,
        ...(options.owner !== undefined
          ? ['--user', String(options.owner)]
          : []),
        ...(options.group !== undefined
          ? ['--group', String(options.group)]
          : []),
      ],
      { signal, timeoutMs: options.timeoutMs },
    );
  } finally {
    await cleanupHostFiles(transport, [base64Path, binaryPath], { signal });
  }
}

function directoryTarEntries(
  files: readonly LxcTransferFile[],
): readonly TarEntry[] {
  return files.map((file) => {
    assertRelativePath(file.path);
    assertMode(file.mode);
    assertId(file.owner, 'Owner');
    assertId(file.group, 'Group');
    return {
      name: file.path,
      content: toBytes(file.content),
      ...(file.mode !== undefined ? { mode: file.mode } : {}),
      ...(file.owner !== undefined ? { uid: file.owner } : {}),
      ...(file.group !== undefined ? { gid: file.group } : {}),
      ...(file.mtime !== undefined ? { mtime: file.mtime } : {}),
    };
  });
}

const DIRECTORY_EXTRACT_SCRIPT = [
  'set -euo pipefail',
  'archive="$1"',
  'destination="$2"',
  'shift 2',
  'mkdir -p -- "$destination"',
  'tar -xpzf "$archive" -C "$destination"',
  'rm -f -- "$archive"',
  'if [ "$#" -gt 0 ]; then rm -f -- "$@"; fi',
  '',
].join('\n');

const ARCHIVE_EXTRACT_SCRIPT = [
  'set -euo pipefail',
  'archive="$1"',
  'destination="$2"',
  'format="$3"',
  'mkdir -p -- "$destination"',
  'case "$format" in',
  '  zip) unzip -oq "$archive" -d "$destination" ;;',
  '  tar.gz|tgz) tar -xpzf "$archive" -C "$destination" ;;',
  '  tar.bz2) tar -xpjf "$archive" -C "$destination" ;;',
  '  tar.xz) tar -xpJf "$archive" -C "$destination" ;;',
  '  *) echo "Unsupported archive format: $format" >&2; exit 2 ;;',
  'esac',
  'rm -f -- "$archive"',
  '',
].join('\n');

/** Stream one directory as a single tar archive, then apply the delete list. */
export async function transferDirectory(
  transport: Transport,
  options: LxcDirectoryTransferOptions,
  signal?: AbortSignal,
): Promise<void> {
  const destination = assertAbsolutePath(options.destination, 'Destination');
  const files = directoryTarEntries(options.files);
  const deletePaths = options.deletePaths ?? [];
  for (const path of deletePaths) assertAbsolutePath(path, 'Delete path');
  if (files.length === 0) {
    await deleteTargetPaths(transport, options.target, deletePaths, {
      signal,
    });
    return;
  }

  const tar = buildTarGz(files);
  const base64Path = hostStagingPath(options, 'b64');
  const hostTarPath = hostStagingPath(options, 'tar.gz');
  try {
    await stageBase64(transport, tar, base64Path, hostTarPath, {
      signal,
      timeoutMs: options.timeoutMs,
    });
    if (options.target.kind === 'guest') {
      assertVmid(options.target.vmid);
      const guestTarPath = guestStagingPath(options, 'tar.gz');
      await run(
        transport,
        ['pct', 'push', String(options.target.vmid), hostTarPath, guestTarPath],
        { signal, timeoutMs: options.timeoutMs },
      );
      await runInTarget(
        transport,
        options.target,
        ['sh', '-s', '--', guestTarPath, destination, ...deletePaths],
        {
          signal,
          timeoutMs: options.timeoutMs,
          stdin: DIRECTORY_EXTRACT_SCRIPT,
        },
      );
    } else {
      await run(
        transport,
        ['bash', '-s', '--', hostTarPath, destination, ...deletePaths],
        {
          signal,
          timeoutMs: options.timeoutMs,
          stdin: DIRECTORY_EXTRACT_SCRIPT,
        },
      );
    }
  } finally {
    await cleanupHostFiles(transport, [base64Path, hostTarPath], { signal });
  }
}

/** Extract a pushed archive inside the guest, or directly on the host path. */
export async function transferArchive(
  transport: Transport,
  options: LxcArchiveTransferOptions,
  signal?: AbortSignal,
): Promise<void> {
  const destination = assertAbsolutePath(options.destination, 'Destination');
  const base64Path = hostStagingPath(options, 'b64');
  const hostArchivePath = hostStagingPath(
    options,
    options.format.replace('+', ''),
  );
  try {
    await stageBase64(
      transport,
      toBytes(options.archive),
      base64Path,
      hostArchivePath,
      { signal, timeoutMs: options.timeoutMs },
    );
    if (options.target.kind === 'guest') {
      assertVmid(options.target.vmid);
      const guestArchivePath = guestStagingPath(
        options,
        options.format.replace('+', ''),
      );
      await run(
        transport,
        [
          'pct',
          'push',
          String(options.target.vmid),
          hostArchivePath,
          guestArchivePath,
        ],
        { signal, timeoutMs: options.timeoutMs },
      );
      await runInTarget(
        transport,
        options.target,
        ['sh', '-s', '--', guestArchivePath, destination, options.format],
        {
          signal,
          timeoutMs: options.timeoutMs,
          stdin: ARCHIVE_EXTRACT_SCRIPT,
        },
      );
    } else {
      await run(
        transport,
        ['bash', '-s', '--', hostArchivePath, destination, options.format],
        {
          signal,
          timeoutMs: options.timeoutMs,
          stdin: ARCHIVE_EXTRACT_SCRIPT,
        },
      );
    }
  } finally {
    await cleanupHostFiles(transport, [base64Path, hostArchivePath], {
      signal,
    });
  }
}

function emptyTransfer(
  files: readonly unknown[],
  deletePaths: readonly unknown[] | undefined,
): boolean {
  return files.length === 0 && (deletePaths?.length ?? 0) === 0;
}

/** Journaled step for a single file destination (LXC guest or host path). */
export function createLxcFileTransferStep(
  options: LxcFileTransferOptions,
): JournaledStep<undefined> {
  return {
    name: `transfer ${options.destination} to ${targetLabel(options.target)}`,
    check: async () => ({ status: 'required' }),
    apply: async ({ transport, signal }) => {
      if (options.target.kind === 'guest') {
        assertVmid(options.target.vmid);
        await transferGuestFile(
          transport,
          options,
          options.target.vmid,
          signal,
        );
      } else {
        await transferHostFile(transport, options, signal);
      }
      return { destination: options.destination };
    },
    verify: async ({ transport, signal }) => {
      if (
        !(await targetExists(
          transport,
          options.target,
          assertAbsolutePath(options.destination, 'Destination'),
          'file',
          { signal },
        ))
      ) {
        throw new LxcFileTransferError(
          `File '${options.destination}' is missing after the transfer.`,
        );
      }
      return { destination: options.destination, transferred: true };
    },
    rollbackHint: `The transfer may have written '${options.destination}' partially. Re-run the sync; no destination file is deleted automatically.`,
  };
}

/** Journaled step for a directory sync, sent as one tar archive. */
export function createLxcDirectoryTransferStep(
  options: LxcDirectoryTransferOptions,
): JournaledStep<undefined> {
  return {
    name: `sync ${options.files.length} file(s) to ${options.destination} on ${targetLabel(options.target)}`,
    check: async () =>
      emptyTransfer(options.files, options.deletePaths)
        ? { status: 'satisfied' }
        : { status: 'required' },
    apply: async ({ transport, signal }) => {
      await transferDirectory(transport, options, signal);
      return {
        destination: options.destination,
        files: options.files.length,
        deleted: options.deletePaths?.length ?? 0,
      };
    },
    verify: async ({ transport, signal }) => {
      if (
        !(await targetExists(
          transport,
          options.target,
          assertAbsolutePath(options.destination, 'Destination'),
          'directory',
          { signal },
        ))
      ) {
        throw new LxcFileTransferError(
          `Directory '${options.destination}' is missing after the sync.`,
        );
      }
      return { destination: options.destination, synced: true };
    },
    rollbackHint: `The tar extraction may be partial. Re-run the sync; files removed by the delete policy are not restored automatically.`,
  };
}

/** Journaled step that extracts a zip or tarball at the destination. */
export function createLxcArchiveTransferStep(
  options: LxcArchiveTransferOptions,
): JournaledStep<undefined> {
  return {
    name: `extract ${options.format} archive into ${options.destination} on ${targetLabel(options.target)}`,
    check: async () => ({ status: 'required' }),
    apply: async ({ transport, signal }) => {
      await transferArchive(transport, options, signal);
      return { destination: options.destination, format: options.format };
    },
    verify: async ({ transport, signal }) => {
      if (
        !(await targetExists(
          transport,
          options.target,
          assertAbsolutePath(options.destination, 'Destination'),
          'directory',
          { signal },
        ))
      ) {
        throw new LxcFileTransferError(
          `Directory '${options.destination}' is missing after archive extraction.`,
        );
      }
      return { destination: options.destination, extracted: true };
    },
    rollbackHint: `Archive extraction may be partial. Re-run the extraction; existing files may have been overwritten.`,
  };
}

export interface PullLxcFileOptions {
  readonly vmid: number;
  /** Absolute path inside the guest. */
  readonly path: string;
  readonly stagingRoot?: string | undefined;
  readonly token?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Pull one file out of an LXC guest with `pct pull`. The staging file is
 * base64-encoded so the result works for binary archives too.
 */
export async function pullLxcFile(
  transport: Transport,
  options: PullLxcFileOptions,
): Promise<Uint8Array> {
  assertVmid(options.vmid);
  const guestPath = assertAbsolutePath(options.path, 'Guest path');
  const stagingOptions: LxcTransferOptions = {
    target: { kind: 'guest', vmid: options.vmid },
    destination: guestPath,
    ...(options.stagingRoot !== undefined
      ? { stagingRoot: options.stagingRoot }
      : {}),
    ...(options.token !== undefined ? { token: options.token } : {}),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
  };
  const pulledPath = hostStagingPath(stagingOptions, 'pull');
  try {
    await run(
      transport,
      ['pct', 'pull', String(options.vmid), guestPath, pulledPath],
      { signal: options.signal, timeoutMs: options.timeoutMs },
    );
    const base64 = await transport.readFile(pulledPath, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return Buffer.from(base64, 'base64');
  } finally {
    await cleanupHostFiles(transport, [pulledPath], {
      signal: options.signal,
    });
  }
}
