import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { JournaledStep } from '../steps/types.js';
import type { ExecResult, Transport } from '../transport/types.js';
import type { ArchiveFormat } from './plan.js';
import { buildTarGz, type TarEntry } from './tar.js';

/** Directory inside the VM used for staging uploads and archives. */
export const VM_TRANSFER_GUEST_ROOT = '/var/tmp';
export const VM_TRANSFER_TIMEOUT_MS = 3_600_000;
/** `qm guest exec --pass-stdin` accepts at most 1 MiB per invocation. */
export const VM_AGENT_STDIN_LIMIT = 1_048_576;
/** Raw chunk size; base64 stays below the agent stdin limit. */
export const VM_AGENT_CHUNK_BYTES = 512 * 1024;

export type VmTransferStrategy = 'ssh' | 'agent';

export interface VmTransferRuntime {
  /** Host transport used for `qm` commands. */
  readonly host: Transport;
  /** Guest SSH/SFTP transport when it is available. */
  readonly guest?: Transport | undefined;
  readonly vmid: number;
  readonly strategy?: VmTransferStrategy | undefined;
  readonly token?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface VmTransferFile {
  /** Relative path below the destination directory. */
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly mode?: string | undefined;
  readonly owner?: number | undefined;
  readonly group?: number | undefined;
  readonly mtime?: Date | undefined;
}

export interface VmTransferOptions {
  /** Absolute path inside the guest. */
  readonly destination: string;
  readonly mode?: string | undefined;
  readonly owner?: number | undefined;
  readonly group?: number | undefined;
  readonly token?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly strategy?: VmTransferStrategy | undefined;
}

export interface VmFileTransferOptions extends VmTransferOptions {
  readonly content: string | Uint8Array;
}

export interface VmDirectoryTransferOptions extends VmTransferOptions {
  readonly files: readonly VmTransferFile[];
  /** Absolute guest paths to remove after the transfer. */
  readonly deletePaths?: readonly string[] | undefined;
}

export interface VmArchiveTransferOptions extends VmTransferOptions {
  readonly archive: string | Uint8Array;
  readonly format: ArchiveFormat;
}

export interface PullVmFileOptions {
  /** Absolute path inside the guest. */
  readonly path: string;
  readonly token?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly strategy?: VmTransferStrategy | undefined;
  readonly signal?: AbortSignal | undefined;
}

export class VmTransferUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'VmTransferUnavailableError';
  }
}

export class VmFileTransferError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'VmFileTransferError';
  }
}

interface AgentCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function assertVmid(vmid: number): void {
  if (!Number.isSafeInteger(vmid) || vmid < 1) {
    throw new VmFileTransferError(`VMID '${vmid}' is not a positive integer.`);
  }
}

function assertAbsolutePath(value: string, label: string): string {
  if (
    !value.startsWith('/') ||
    value === '/' ||
    posix.normalize(value) !== value ||
    value.split('/').includes('..')
  ) {
    throw new VmFileTransferError(
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
    throw new VmFileTransferError(
      `Transfer path '${value}' must be a normalized relative path.`,
    );
  }
  return value;
}

function assertMode(mode: string | undefined): string {
  if (mode === undefined) return '0644';
  if (!/^[0-7]{3,4}$/.test(mode)) {
    throw new VmFileTransferError(`Mode '${mode}' is not octal.`);
  }
  return mode;
}

function assertId(value: number | undefined, label: string): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < 0 || value > 4_294_967_295)
  ) {
    throw new VmFileTransferError(`${label} '${value}' is not a valid id.`);
  }
}

function transferToken(runtime: VmTransferRuntime, token?: string): string {
  const value =
    token ?? runtime.token ?? randomUUID().replaceAll('-', '').slice(0, 16);
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new VmFileTransferError(
      `Transfer token '${value}' may only contain letters, digits, dot, underscore or dash.`,
    );
  }
  return value;
}

function stagingPath(token: string, suffix: string): string {
  return posix.join(VM_TRANSFER_GUEST_ROOT, `hacm-${token}.${suffix}`);
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string'
    ? new TextEncoder().encode(content)
    : content;
}

function toBase64(content: string | Uint8Array): string {
  return Buffer.from(toBytes(content)).toString('base64');
}

function timeoutOf(
  runtime: VmTransferRuntime,
  options: VmTransferOptions | PullVmFileOptions,
): number {
  return options.timeoutMs ?? runtime.timeoutMs ?? VM_TRANSFER_TIMEOUT_MS;
}

/**
 * Pick the VM transfer path. SSH/SFTP wins when a guest transport is provided,
 * otherwise the QEMU guest agent must answer a ping. When neither works the
 * caller gets an actionable error instead of a silent partial sync.
 */
export async function resolveVmTransferStrategy(
  runtime: VmTransferRuntime,
  signal?: AbortSignal,
): Promise<VmTransferStrategy> {
  assertVmid(runtime.vmid);
  if (runtime.strategy === 'ssh') {
    if (!runtime.guest) {
      throw new VmTransferUnavailableError(
        `SSH/SFTP transfer was requested for VM ${runtime.vmid} but no guest SSH transport is configured.`,
      );
    }
    return 'ssh';
  }
  if (runtime.strategy === 'agent') return 'agent';
  if (runtime.guest) return 'ssh';

  const ping = await runtime.host.exec(
    ['qm', 'agent', String(runtime.vmid), 'ping'],
    {
      timeoutMs: 10_000,
      ...(signal ? { signal } : {}),
    },
  );
  if (ping.exitCode === 0) return 'agent';
  throw new VmTransferUnavailableError(
    `VM ${runtime.vmid} has neither a reachable QEMU guest agent nor SSH/SFTP access: ${ping.stderr.trim() || `qm agent ping exited with ${ping.exitCode}`}. Enable the guest agent or configure guest SSH.`,
  );
}

function parseAgentJson(stdout: string, vmid: number): AgentCommandResult {
  const text = stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VmFileTransferError(
      `The QEMU guest agent response for VM ${vmid} was not JSON: ${text.slice(0, 200)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new VmFileTransferError(
      `The QEMU guest agent response for VM ${vmid} was not an object.`,
    );
  }
  const record = parsed as Record<string, unknown>;
  const exitCode =
    typeof record['exitcode'] === 'number' ? record['exitcode'] : 0;
  return {
    exitCode,
    stdout: typeof record['out-data'] === 'string' ? record['out-data'] : '',
    stderr: typeof record['err-data'] === 'string' ? record['err-data'] : '',
  };
}

async function agentExec(
  runtime: VmTransferRuntime,
  argv: readonly string[],
  options: {
    readonly stdin?: string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<AgentCommandResult> {
  assertVmid(runtime.vmid);
  if (
    options.stdin !== undefined &&
    Buffer.byteLength(options.stdin, 'utf8') > VM_AGENT_STDIN_LIMIT
  ) {
    throw new VmFileTransferError(
      `The guest agent stdin payload is larger than ${VM_AGENT_STDIN_LIMIT} bytes.`,
    );
  }
  const command = [
    'qm',
    'guest',
    'exec',
    String(runtime.vmid),
    '--synchronous',
    '1',
    '--timeout',
    '0',
    ...(options.stdin !== undefined ? ['--pass-stdin', '1'] : []),
    '--',
    ...argv,
  ];
  const result: ExecResult = await runtime.host.exec(command, {
    timeoutMs: options.timeoutMs ?? VM_TRANSFER_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
  });
  if (result.exitCode !== 0) {
    throw new VmFileTransferError(
      `qm guest exec ${runtime.vmid} failed: ${
        result.stderr.trim() || `exit code ${result.exitCode}`
      }`,
    );
  }
  return parseAgentJson(result.stdout, runtime.vmid);
}

async function agentChecked(
  runtime: VmTransferRuntime,
  argv: readonly string[],
  options: {
    readonly stdin?: string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<AgentCommandResult> {
  const result = await agentExec(runtime, argv, options);
  if (result.exitCode !== 0) {
    throw new VmFileTransferError(
      `Guest command '${argv.join(' ')}' failed: ${
        result.stderr.trim() ||
        result.stdout.trim() ||
        `exit code ${result.exitCode}`
      }`,
    );
  }
  return result;
}

async function agentScript(
  runtime: VmTransferRuntime,
  script: string,
  args: readonly string[],
  options: {
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<AgentCommandResult> {
  return agentChecked(runtime, ['sh', '-s', '--', ...args], {
    ...options,
    stdin: script,
  });
}

async function sshChecked(
  runtime: VmTransferRuntime,
  argv: readonly string[],
  options: {
    readonly stdin?: string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<ExecResult> {
  const guest = runtime.guest;
  if (!guest) {
    throw new VmTransferUnavailableError(
      `SSH/SFTP transfer was requested for VM ${runtime.vmid} but no guest SSH transport is configured.`,
    );
  }
  const result = await guest.exec(argv, {
    timeoutMs: options.timeoutMs ?? VM_TRANSFER_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
  });
  if (result.exitCode !== 0) {
    throw new VmFileTransferError(
      `Guest command '${argv.join(' ')}' failed: ${
        result.stderr.trim() || `exit code ${result.exitCode}`
      }`,
    );
  }
  return result;
}

const TRUNCATE_SCRIPT = ['set -euo pipefail', 'umask 077', ': > "$1"', ''].join(
  '\n',
);

const APPEND_SCRIPT_PREFIX = [
  'set -euo pipefail',
  'umask 077',
  "printf '%s' '",
].join('\n');
const APPEND_SCRIPT_SUFFIX = ['\' | base64 -d >> "$1"', ''].join('\n');

function appendScript(base64: string): string {
  return `${APPEND_SCRIPT_PREFIX}${base64}${APPEND_SCRIPT_SUFFIX}`;
}

const INSTALL_SCRIPT = [
  'set -euo pipefail',
  'source="$1"',
  'destination="$2"',
  'mode="$3"',
  'owner="${4:-}"',
  'group="${5:-}"',
  'install -d -- "$(dirname -- "$destination")"',
  'install -m "$mode" -- "$source" "$destination"',
  'if [ -n "$owner" ] && [ -n "$group" ]; then',
  '  chown -- "$owner:$group" "$destination"',
  'elif [ -n "$owner" ]; then',
  '  chown -- "$owner" "$destination"',
  'elif [ -n "$group" ]; then',
  '  chown -- ":$group" "$destination"',
  'fi',
  'rm -f -- "$source"',
  '',
].join('\n');

const DECODE_INSTALL_SCRIPT = [
  'set -euo pipefail',
  'encoded="$1"',
  'destination="$2"',
  'mode="$3"',
  'owner="${4:-}"',
  'group="${5:-}"',
  'temporary="${encoded}.decoded"',
  'umask 077',
  'base64 -d -- "$encoded" > "$temporary"',
  'rm -f -- "$encoded"',
  'install -d -- "$(dirname -- "$destination")"',
  'install -m "$mode" -- "$temporary" "$destination"',
  'if [ -n "$owner" ] && [ -n "$group" ]; then',
  '  chown -- "$owner:$group" "$destination"',
  'elif [ -n "$owner" ]; then',
  '  chown -- "$owner" "$destination"',
  'elif [ -n "$group" ]; then',
  '  chown -- ":$group" "$destination"',
  'fi',
  'rm -f -- "$temporary"',
  '',
].join('\n');

const EXTRACT_SCRIPT = [
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

const DECODE_EXTRACT_SCRIPT = [
  'set -euo pipefail',
  'encoded="$1"',
  'archive="$2"',
  'destination="$3"',
  'shift 3',
  'umask 077',
  'base64 -d -- "$encoded" > "$archive"',
  'rm -f -- "$encoded"',
  'mkdir -p -- "$destination"',
  'tar -xpzf "$archive" -C "$destination"',
  'rm -f -- "$archive"',
  'if [ "$#" -gt 0 ]; then rm -f -- "$@"; fi',
  '',
].join('\n');

const ARCHIVE_SCRIPT = [
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

const DECODE_ARCHIVE_SCRIPT = [
  'set -euo pipefail',
  'encoded="$1"',
  'archive="$2"',
  'destination="$3"',
  'format="$4"',
  'umask 077',
  'base64 -d -- "$encoded" > "$archive"',
  'rm -f -- "$encoded"',
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

const DELETE_SCRIPT = ['set -euo pipefail', 'rm -f -- "$@"', ''].join('\n');

async function stageAgentBytes(
  runtime: VmTransferRuntime,
  content: string | Uint8Array,
  remotePath: string,
  options: {
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<void> {
  await agentScript(runtime, TRUNCATE_SCRIPT, [remotePath], options);
  const bytes = toBytes(content);
  for (let offset = 0; offset < bytes.length; offset += VM_AGENT_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + VM_AGENT_CHUNK_BYTES);
    await agentScript(
      runtime,
      appendScript(Buffer.from(chunk).toString('base64')),
      [remotePath],
      options,
    );
  }
}

async function stageSshBase64(
  runtime: VmTransferRuntime,
  content: string | Uint8Array,
  remotePath: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const guest = runtime.guest;
  if (!guest) {
    throw new VmTransferUnavailableError(
      `SSH/SFTP transfer was requested for VM ${runtime.vmid} but no guest SSH transport is configured.`,
    );
  }
  await guest.writeFile(remotePath, toBase64(content), {
    ...(signal ? { signal } : {}),
  });
}

async function deleteTransferPaths(
  runtime: VmTransferRuntime,
  strategy: VmTransferStrategy,
  deletePaths: readonly string[],
  options: {
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<void> {
  if (deletePaths.length === 0) return;
  for (const path of deletePaths) assertAbsolutePath(path, 'Delete path');
  if (strategy === 'ssh') {
    await sshChecked(runtime, ['sh', '-s', '--', ...deletePaths], {
      ...options,
      stdin: DELETE_SCRIPT,
    });
  } else {
    await agentScript(runtime, DELETE_SCRIPT, deletePaths, options);
  }
}

function directoryEntries(
  files: readonly VmTransferFile[],
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

/** Transfer one file into a VM over SSH/SFTP or the QEMU guest agent. */
export async function transferVmFile(
  runtime: VmTransferRuntime,
  options: VmFileTransferOptions,
  signal?: AbortSignal,
): Promise<void> {
  const strategy = await resolveVmTransferStrategy(
    { ...runtime, strategy: options.strategy ?? runtime.strategy },
    signal,
  );
  const destination = assertAbsolutePath(options.destination, 'Destination');
  const mode = assertMode(options.mode);
  assertId(options.owner, 'Owner');
  assertId(options.group, 'Group');
  const token = transferToken(runtime, options.token);
  const timeoutMs = timeoutOf(runtime, options);
  const staging = stagingPath(token, 'upload');
  const ownership = [
    options.owner === undefined ? '' : String(options.owner),
    options.group === undefined ? '' : String(options.group),
  ];

  if (strategy === 'ssh') {
    const encoded = stagingPath(token, 'b64');
    await stageSshBase64(runtime, options.content, encoded, signal);
    await sshChecked(
      runtime,
      ['sh', '-s', '--', encoded, destination, mode, ...ownership],
      { stdin: DECODE_INSTALL_SCRIPT, timeoutMs, signal },
    );
    return;
  }

  await stageAgentBytes(runtime, options.content, staging, {
    timeoutMs,
    signal,
  });
  await agentScript(
    runtime,
    INSTALL_SCRIPT,
    [staging, destination, mode, ...ownership],
    { timeoutMs, signal },
  );
}

/** Transfer a whole directory as one tar stream, then apply the delete policy. */
export async function transferVmDirectory(
  runtime: VmTransferRuntime,
  options: VmDirectoryTransferOptions,
  signal?: AbortSignal,
): Promise<void> {
  const strategy = await resolveVmTransferStrategy(
    { ...runtime, strategy: options.strategy ?? runtime.strategy },
    signal,
  );
  const destination = assertAbsolutePath(options.destination, 'Destination');
  const deletePaths = options.deletePaths ?? [];
  for (const path of deletePaths) assertAbsolutePath(path, 'Delete path');
  const files = directoryEntries(options.files);
  if (files.length === 0) {
    await deleteTransferPaths(runtime, strategy, deletePaths, {
      timeoutMs: timeoutOf(runtime, options),
      signal,
    });
    return;
  }

  const token = transferToken(runtime, options.token);
  const timeoutMs = timeoutOf(runtime, options);
  const archive = buildTarGz(files);

  if (strategy === 'ssh') {
    const encoded = stagingPath(token, 'tar.gz.b64');
    const archivePath = stagingPath(token, 'tar.gz');
    await stageSshBase64(runtime, archive, encoded, signal);
    await sshChecked(
      runtime,
      ['sh', '-s', '--', encoded, archivePath, destination, ...deletePaths],
      { stdin: DECODE_EXTRACT_SCRIPT, timeoutMs, signal },
    );
    return;
  }

  const archivePath = stagingPath(token, 'tar.gz');
  await stageAgentBytes(runtime, archive, archivePath, { timeoutMs, signal });
  await agentScript(
    runtime,
    EXTRACT_SCRIPT,
    [archivePath, destination, ...deletePaths],
    { timeoutMs, signal },
  );
}

/** Extract a zip or tarball inside a VM. */
export async function transferVmArchive(
  runtime: VmTransferRuntime,
  options: VmArchiveTransferOptions,
  signal?: AbortSignal,
): Promise<void> {
  const strategy = await resolveVmTransferStrategy(
    { ...runtime, strategy: options.strategy ?? runtime.strategy },
    signal,
  );
  const destination = assertAbsolutePath(options.destination, 'Destination');
  const token = transferToken(runtime, options.token);
  const timeoutMs = timeoutOf(runtime, options);
  const suffix = options.format.replace('+', '');

  if (strategy === 'ssh') {
    const encoded = stagingPath(token, `${suffix}.b64`);
    const archivePath = stagingPath(token, suffix);
    await stageSshBase64(runtime, options.archive, encoded, signal);
    await sshChecked(
      runtime,
      ['sh', '-s', '--', encoded, archivePath, destination, options.format],
      { stdin: DECODE_ARCHIVE_SCRIPT, timeoutMs, signal },
    );
    return;
  }

  const archivePath = stagingPath(token, suffix);
  await stageAgentBytes(runtime, options.archive, archivePath, {
    timeoutMs,
    signal,
  });
  await agentScript(
    runtime,
    ARCHIVE_SCRIPT,
    [archivePath, destination, options.format],
    { timeoutMs, signal },
  );
}

async function vmPathExists(
  runtime: VmTransferRuntime,
  strategy: VmTransferStrategy,
  path: string,
  kind: 'file' | 'directory',
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const flag = kind === 'directory' ? '-d' : '-f';
  if (strategy === 'ssh') {
    const result = await runtime.guest!.exec(['test', flag, path], {
      ...(signal ? { signal } : {}),
    });
    return result.exitCode === 0;
  }
  const result = await agentExec(runtime, ['test', flag, path], {
    signal,
    timeoutMs: 10_000,
  });
  return result.exitCode === 0;
}

/**
 * Read a file out of a VM. SSH reads it with `base64`, while the agent streams
 * fixed-size chunks so the guest-agent response limit is never exceeded.
 */
export async function pullVmFile(
  runtime: VmTransferRuntime,
  options: PullVmFileOptions,
): Promise<Uint8Array> {
  const strategy = await resolveVmTransferStrategy(
    { ...runtime, strategy: options.strategy ?? runtime.strategy },
    options.signal,
  );
  const path = assertAbsolutePath(options.path, 'Guest path');
  const timeoutMs = timeoutOf(runtime, options);

  if (strategy === 'ssh') {
    const result = await sshChecked(runtime, ['sh', '-s', '--', path], {
      stdin: ['set -euo pipefail', 'base64 -- "$1"', ''].join('\n'),
      timeoutMs,
      signal: options.signal,
    });
    return Buffer.from(result.stdout.replaceAll(/\s+/g, ''), 'base64');
  }

  const sizeResult = await agentScript(
    runtime,
    ['set -euo pipefail', 'wc -c < "$1"', ''].join('\n'),
    [path],
    { timeoutMs, signal: options.signal },
  );
  const sizeText = sizeResult.stdout.trim();
  if (!/^\d+$/.test(sizeText)) {
    throw new VmFileTransferError(
      `Could not read the size of '${path}' in VM ${runtime.vmid}: ${sizeText}`,
    );
  }
  const size = Number(sizeText);
  const chunks: Buffer[] = [];
  const chunkCount = Math.ceil(size / VM_AGENT_CHUNK_BYTES);
  for (let index = 0; index < chunkCount; index += 1) {
    const result = await agentScript(
      runtime,
      [
        'set -euo pipefail',
        `dd if="$1" bs=${VM_AGENT_CHUNK_BYTES} skip=$2 count=1 2>/dev/null | base64 | tr -d '\\n'`,
        '',
      ].join('\n'),
      [path, String(index)],
      { timeoutMs, signal: options.signal },
    );
    chunks.push(Buffer.from(result.stdout.replaceAll(/\s+/g, ''), 'base64'));
  }
  return Buffer.concat(chunks);
}

export interface VmTransferStepOptions {
  readonly vmid: number;
  /** Guest SSH/SFTP transport when available. */
  readonly guest?: Transport | undefined;
  readonly strategy?: VmTransferStrategy | undefined;
  readonly token?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

function stepRuntime(
  host: Transport,
  options: VmTransferStepOptions,
): VmTransferRuntime {
  return {
    host,
    vmid: options.vmid,
    ...(options.guest ? { guest: options.guest } : {}),
    ...(options.strategy ? { strategy: options.strategy } : {}),
    ...(options.token ? { token: options.token } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  };
}

function stepStrategy(options: VmTransferStepOptions): VmTransferStrategy {
  return options.strategy ?? (options.guest ? 'ssh' : 'agent');
}

function targetLabel(strategy: VmTransferStrategy, vmid: number): string {
  return strategy === 'ssh'
    ? `VM ${vmid} over SSH`
    : `VM ${vmid} via the guest agent`;
}

/** Journaled step for a single VM file destination. */
export function createVmFileTransferStep(
  options: VmTransferStepOptions & VmFileTransferOptions,
): JournaledStep<undefined> {
  const strategy = stepStrategy(options);
  return {
    name: `transfer ${options.destination} to ${targetLabel(strategy, options.vmid)}`,
    check: async () => ({ status: 'required' }),
    apply: async ({ transport, signal }) => {
      await transferVmFile(stepRuntime(transport, options), options, signal);
      return { destination: options.destination };
    },
    verify: async ({ transport, signal }) => {
      if (
        !(await vmPathExists(
          stepRuntime(transport, options),
          strategy,
          assertAbsolutePath(options.destination, 'Destination'),
          'file',
          signal,
        ))
      ) {
        throw new VmFileTransferError(
          `File '${options.destination}' is missing after the transfer.`,
        );
      }
      return { destination: options.destination, transferred: true };
    },
    rollbackHint: `The transfer may have written '${options.destination}' partially. Re-run the sync; no destination file is deleted automatically.`,
  };
}

/** Journaled step for a VM directory sync, sent as one tar archive. */
export function createVmDirectoryTransferStep(
  options: VmTransferStepOptions & VmDirectoryTransferOptions,
): JournaledStep<undefined> {
  const strategy = stepStrategy(options);
  return {
    name: `sync ${options.files.length} file(s) to ${options.destination} on ${targetLabel(strategy, options.vmid)}`,
    check: async () =>
      options.files.length === 0 && (options.deletePaths?.length ?? 0) === 0
        ? { status: 'satisfied' }
        : { status: 'required' },
    apply: async ({ transport, signal }) => {
      await transferVmDirectory(
        stepRuntime(transport, options),
        options,
        signal,
      );
      return {
        destination: options.destination,
        files: options.files.length,
        deleted: options.deletePaths?.length ?? 0,
      };
    },
    verify: async ({ transport, signal }) => {
      if (
        !(await vmPathExists(
          stepRuntime(transport, options),
          strategy,
          assertAbsolutePath(options.destination, 'Destination'),
          'directory',
          signal,
        ))
      ) {
        throw new VmFileTransferError(
          `Directory '${options.destination}' is missing after the sync.`,
        );
      }
      return { destination: options.destination, synced: true };
    },
    rollbackHint: `The tar extraction may be partial. Re-run the sync; files removed by the delete policy are not restored automatically.`,
  };
}

/** Journaled step that extracts a zip or tarball at the destination. */
export function createVmArchiveTransferStep(
  options: VmTransferStepOptions & VmArchiveTransferOptions,
): JournaledStep<undefined> {
  const strategy = stepStrategy(options);
  return {
    name: `extract ${options.format} archive into ${options.destination} on ${targetLabel(strategy, options.vmid)}`,
    check: async () => ({ status: 'required' }),
    apply: async ({ transport, signal }) => {
      await transferVmArchive(stepRuntime(transport, options), options, signal);
      return { destination: options.destination, format: options.format };
    },
    verify: async ({ transport, signal }) => {
      if (
        !(await vmPathExists(
          stepRuntime(transport, options),
          strategy,
          assertAbsolutePath(options.destination, 'Destination'),
          'directory',
          signal,
        ))
      ) {
        throw new VmFileTransferError(
          `Directory '${options.destination}' is missing after archive extraction.`,
        );
      }
      return { destination: options.destination, extracted: true };
    },
    rollbackHint: `Archive extraction may be partial. Re-run the extraction; existing files may have been overwritten.`,
  };
}
