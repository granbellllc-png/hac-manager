import type { GuestDeployment } from '../schema/deployment.js';
import { parseOptionString } from '../codec/options.js';
import type { Transport } from '../transport/types.js';
import { defaultHostDataPath } from './host-dirs.js';
import {
  readLxcConfig,
  readPowerState,
  type LxcMigrationPlan,
} from '../provision/lxc-migrate.js';

/** Where the temporary rootfs probe is bind-mounted inside the CT namespace. */
export const DEFAULT_ROOTFS_PROBE_PATH = '/run/hacm-rootfs-probe';
/** Daemons that keep an old mount namespace after the guest was reconfigured. */
export const DEFAULT_LONG_RUNNING_DAEMONS = [
  'dockerd',
  'containerd',
  'postgres',
  'postmaster',
] as const;

export type StorageResolution = 'keep-host-data' | 'migrate-rootfs-to-host';

export const STORAGE_RESOLUTION_LABELS: Readonly<
  Record<StorageResolution, string>
> = {
  'keep-host-data': 'Keep Host Data',
  'migrate-rootfs-to-host': 'Migrate Rootfs to Host',
};

export function storageResolutionFromLabel(
  label: string,
): StorageResolution | undefined {
  return (
    Object.entries(STORAGE_RESOLUTION_LABELS) as [StorageResolution, string][]
  ).find(([, value]) => value === label)?.[0];
}

export type StorageInvariantStatus =
  | 'ok'
  | 'split-brain'
  | 'shadowed'
  | 'not-mounted'
  | 'not-migrated'
  | 'missing-host-data'
  | 'stale-mount'
  | 'guest-stopped'
  | 'not-applicable'
  | 'unknown';

export interface StorageSideSummary {
  readonly exists: boolean;
  /** Number of entries below the path; 0 when the path is missing or empty. */
  readonly fileCount: number;
  readonly bytes: number;
  /** ISO timestamp of the newest entry, when the path has any entries. */
  readonly newestTimestamp?: string | undefined;
}

export interface StorageDaemonObservation {
  readonly name: string;
  readonly pid: number;
  /** True when the daemon's mount namespace still has a mount at the guest path. */
  readonly mountedInDaemon: boolean;
  /** True when this disagrees with the current CT mount namespace. */
  readonly stale: boolean;
}

export interface StorageInvariantReport {
  readonly hostId: string;
  readonly vmid: number;
  readonly guestName: string;
  readonly guestType: GuestDeployment['type'];
  readonly guestPath: string;
  readonly hostPath: string;
  readonly mp0Value?: string | undefined;
  readonly status: StorageInvariantStatus;
  readonly message: string;
  readonly host: StorageSideSummary;
  readonly rootfs: StorageSideSummary;
  readonly mounted: boolean;
  readonly rootfsProbe: 'bind-mount' | 'visible' | 'skipped';
  readonly daemons: readonly StorageDaemonObservation[];
  readonly staleDaemons: readonly StorageDaemonObservation[];
  readonly warnings: readonly string[];
  readonly requiresResolution: boolean;
  readonly resolutionOptions: readonly StorageResolution[];
  readonly recommendedResolution?: StorageResolution | undefined;
  readonly checkedAt: string;
}

export interface StorageInvariantOptions {
  readonly hostId: string;
  /** Override the mp0 guest path; defaults to the deployment or `/opt`. */
  readonly guestPath?: string | undefined;
  /** Override the host data path; defaults to the deployment or D-43. */
  readonly hostPath?: string | undefined;
  /** Mount point of the temporary non-recursive bind mount. */
  readonly rootfsProbePath?: string | undefined;
  readonly daemonNames?: readonly string[] | undefined;
  readonly now?: (() => Date) | undefined;
  /** Test hook: skip the `lxc-info` lookup and use this pid. */
  readonly pid?: number | undefined;
}

const EMPTY_SUMMARY: StorageSideSummary = {
  exists: false,
  fileCount: 0,
  bytes: 0,
};

export function storageSummaryScript(): string {
  return [
    'set -eu',
    'root=$1',
    'if [ ! -e "$root" ]; then',
    "  printf 'exists=0\\nfiles=0\\nbytes=0\\n'",
    '  exit 0',
    'fi',
    'files=$(find "$root" -mindepth 1 2>/dev/null | wc -l)',
    "bytes=$(find \"$root\" -mindepth 1 -type f -printf '%s\\n' 2>/dev/null | awk '{ total += $1 } END { print total + 0 }')",
    'newest=$(find "$root" -mindepth 1 -printf \'%T@\\n\' 2>/dev/null | sort -nr | head -n 1 || true)',
    'printf \'exists=1\\nfiles=%s\\nbytes=%s\\nnewest=%s\\n\' "$files" "$bytes" "$newest"',
  ].join('\n');
}

export function storageHostSummaryArgv(hostPath: string): readonly string[] {
  return ['bash', '-s', '--', hostPath];
}

export function storageInitPidArgv(vmid: number): readonly string[] {
  return ['lxc-info', '-n', String(vmid), '-p', '-H'];
}

/**
 * D-46: make a non-recursive bind mount of `/` inside the CT mount namespace
 * so the raw rootfs path is visible even while mp0 shadows it. The probe falls
 * back to the visible path when the bind mount is not permitted.
 */
export function storageRootfsProbeScript(): string {
  return [
    'set -eu',
    'guest_path=$1',
    'probe=$2',
    'mode=visible',
    'root="$guest_path"',
    'cleanup() {',
    '  if [ "$mode" = "bind" ]; then',
    '    umount "$probe" 2>/dev/null || true',
    '    rmdir "$probe" 2>/dev/null || true',
    '  fi',
    '}',
    'trap cleanup EXIT',
    'if mkdir -p "$probe" 2>/dev/null && mount --bind / "$probe" 2>/dev/null; then',
    '  mode=bind',
    '  root="$probe$guest_path"',
    'fi',
    'printf \'probe=%s\\n\' "$mode"',
    'if [ ! -e "$root" ]; then',
    "  printf 'exists=0\\nfiles=0\\nbytes=0\\n'",
    '  exit 0',
    'fi',
    'files=$(find "$root" -mindepth 1 2>/dev/null | wc -l)',
    "bytes=$(find \"$root\" -mindepth 1 -type f -printf '%s\\n' 2>/dev/null | awk '{ total += $1 } END { print total + 0 }')",
    'newest=$(find "$root" -mindepth 1 -printf \'%T@\\n\' 2>/dev/null | sort -nr | head -n 1 || true)',
    'printf \'exists=1\\nfiles=%s\\nbytes=%s\\nnewest=%s\\n\' "$files" "$bytes" "$newest"',
  ].join('\n');
}

export function storageRootfsProbeArgv(
  pid: number,
  guestPath: string,
  probePath = DEFAULT_ROOTFS_PROBE_PATH,
): readonly string[] {
  return [
    'nsenter',
    '-t',
    String(pid),
    '-m',
    '--',
    'bash',
    '-s',
    '--',
    guestPath,
    probePath,
  ];
}

export function storageMountpointArgv(
  pid: number,
  guestPath: string,
): readonly string[] {
  return [
    'nsenter',
    '-t',
    String(pid),
    '-m',
    '--',
    'mountpoint',
    '-q',
    guestPath,
  ];
}

/**
 * `/proc/<pid>/mountinfo` is read from the host pid namespace. Only daemons
 * whose cgroup belongs to this VMID are considered, which avoids matching a
 * host-wide container runtime.
 */
export function storageDaemonProbeScript(): string {
  return [
    'set -eu',
    'guest_path=$1',
    'vmid=$2',
    'shift 2',
    'for name in "$@"; do',
    '  for pid in $(pgrep -x "$name" 2>/dev/null || true); do',
    '    if ! grep -q "$vmid" "/proc/$pid/cgroup" 2>/dev/null; then',
    '      continue',
    '    fi',
    '    if grep -q " $guest_path " "/proc/$pid/mountinfo" 2>/dev/null; then',
    '      printf \'%s %s 1\\n\' "$name" "$pid"',
    '    else',
    '      printf \'%s %s 0\\n\' "$name" "$pid"',
    '    fi',
    '  done',
    'done',
  ].join('\n');
}

export function storageDaemonProbeArgv(
  guestPath: string,
  vmid: number,
  daemonNames: readonly string[] = DEFAULT_LONG_RUNNING_DAEMONS,
): readonly string[] {
  return ['bash', '-s', '--', guestPath, String(vmid), ...daemonNames];
}

export function parseStorageInitPid(stdout: string): number | undefined {
  const value = Number(stdout.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function parseStorageSummary(
  stdout: string,
): StorageSideSummary | undefined {
  const fields = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) {
      fields.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
    }
  }
  if (!fields.has('exists')) return undefined;
  const exists = fields.get('exists') === '1';
  if (!exists) return EMPTY_SUMMARY;
  const fileCount = Number(fields.get('files') ?? '0');
  const bytes = Number(fields.get('bytes') ?? '0');
  if (!Number.isFinite(fileCount) || !Number.isFinite(bytes)) {
    return undefined;
  }
  const newestText = fields.get('newest') ?? '';
  const newest = Number(newestText);
  return {
    exists: true,
    fileCount,
    bytes,
    ...(newestText !== '' && Number.isFinite(newest) && newest > 0
      ? { newestTimestamp: new Date(newest * 1_000).toISOString() }
      : {}),
  };
}

export function parseStorageProbeMode(
  stdout: string,
): 'bind-mount' | 'visible' | undefined {
  const match = /^probe=(bind|visible)$/m.exec(stdout);
  if (!match) return undefined;
  return match[1] === 'bind' ? 'bind-mount' : 'visible';
}

export function parseStorageDaemons(
  stdout: string,
  mounted: boolean,
): readonly StorageDaemonObservation[] {
  const observations: StorageDaemonObservation[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [name, pidText, mountedText] = line.trim().split(/\s+/);
    if (!name || !pidText || !mountedText) continue;
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const mountedInDaemon = mountedText === '1';
    observations.push({
      name,
      pid,
      mountedInDaemon,
      stale: mountedInDaemon !== mounted,
    });
  }
  return observations;
}

export interface ResolvedStoragePaths {
  readonly guestPath: string;
  readonly hostPath: string;
  readonly mp0Value?: string | undefined;
}

/** Read the live mp0 value from `pct config` output. */
export function liveLxcMp0(config: string): string | undefined {
  const line = config
    .split(/\r?\n/)
    .find((candidate) => /^mp0\s*:/.test(candidate));
  return line?.slice(line.indexOf(':') + 1).trim();
}

/**
 * Resolve the guest and host paths for the invariant check. YAML wins over the
 * live config; a script-created CT without mp0 uses the D-43 default.
 */
export function resolveStoragePaths(
  guest: GuestDeployment,
  hostId: string,
  config: string,
): ResolvedStoragePaths {
  const declared =
    guest.type === 'lxc'
      ? guest.mounts?.find((mount) => mount.index === 0)
      : undefined;
  const live = liveLxcMp0(config);
  const parsedLive = live ? parseOptionString(live) : undefined;
  const guestPath = declared?.guest_path ?? parsedLive?.options.mp ?? '/opt';
  const hostPath =
    declared?.host_path ??
    parsedLive?.positional ??
    defaultHostDataPath(hostId, guest.name, guestPath);
  return {
    guestPath,
    hostPath,
    ...(live ? { mp0Value: live } : {}),
  };
}

function hasData(summary: StorageSideSummary): boolean {
  return summary.exists && summary.fileCount > 0;
}

function newest(summary: StorageSideSummary): number {
  return summary.newestTimestamp
    ? new Date(summary.newestTimestamp).getTime()
    : 0;
}

function recommendedResolution(
  status: StorageInvariantStatus,
  host: StorageSideSummary,
  rootfs: StorageSideSummary,
): StorageResolution | undefined {
  if (status === 'shadowed') return 'keep-host-data';
  if (status !== 'split-brain') return undefined;
  return newest(rootfs) > newest(host)
    ? 'migrate-rootfs-to-host'
    : 'keep-host-data';
}

function classify(
  host: StorageSideSummary,
  rootfs: StorageSideSummary,
  mounted: boolean,
  staleDaemons: readonly StorageDaemonObservation[],
): StorageInvariantStatus {
  if (!mounted) {
    if (hasData(host) && hasData(rootfs)) return 'split-brain';
    if (hasData(host)) return 'not-mounted';
    if (hasData(rootfs)) return 'not-migrated';
    return 'ok';
  }
  if (!host.exists) return 'missing-host-data';
  if (hasData(rootfs)) return 'shadowed';
  if (staleDaemons.length > 0) return 'stale-mount';
  return 'ok';
}

function messageFor(
  status: StorageInvariantStatus,
  guestPath: string,
  hostPath: string,
  mounted: boolean,
): string {
  switch (status) {
    case 'ok':
      return `Host data and the guest view of ${guestPath} agree.`;
    case 'split-brain':
      return `${guestPath} exists both in the rootfs and in ${hostPath} while mp0 is not active; the guest currently sees the rootfs copy.`;
    case 'shadowed':
      return `mp0 exposes ${hostPath} at ${guestPath}, but the rootfs still contains a hidden copy of ${guestPath}.`;
    case 'not-mounted':
      return `Host data exists at ${hostPath}, but mp0 is not mounted at ${guestPath}; the guest sees the rootfs copy.`;
    case 'not-migrated':
      return `The rootfs contains data at ${guestPath} and ${hostPath} is empty; the guest has not been migrated to host storage yet.`;
    case 'missing-host-data':
      return `mp0 is mounted at ${guestPath}, but the host path ${hostPath} does not exist.`;
    case 'stale-mount':
      return `A long-running daemon still sees the old mount namespace for ${guestPath}.`;
    case 'guest-stopped':
      return 'Storage invariants cannot be inspected while the guest is stopped; start it and retry.';
    case 'not-applicable':
      return 'Storage invariants only apply to LXC guests with mp0 host data.';
    case 'unknown':
      return (
        'Storage invariants could not be determined' +
        (mounted ? ' for the currently mounted guest data.' : '.')
      );
  }
}

function warningsFor(
  status: StorageInvariantStatus,
  staleDaemons: readonly StorageDaemonObservation[],
  rootfsProbe: StorageInvariantReport['rootfsProbe'],
): readonly string[] {
  const warnings: string[] = [];
  if (rootfsProbe === 'visible') {
    warnings.push(
      'The raw rootfs probe could not bind-mount / inside the CT namespace; the visible guest path was inspected instead. Shadowed data may be missed.',
    );
  }
  if (staleDaemons.length > 0) {
    warnings.push(
      `Long-running daemons with a stale mount namespace: ${staleDaemons
        .map((daemon) => `${daemon.name} (pid ${daemon.pid})`)
        .join(', ')}. Restart the guest stack before syncing files.`,
    );
  }
  if (status === 'not-migrated' || status === 'not-mounted') {
    warnings.push(
      'Run a storage migration or guest update plan to attach mp0 before file sync or stack startup.',
    );
  }
  if (status === 'missing-host-data') {
    warnings.push(
      'The declared host path is missing. Recreate the host directory plan before starting the service.',
    );
  }
  return warnings;
}

function reportBase(
  guest: GuestDeployment,
  options: StorageInvariantOptions,
  paths: ResolvedStoragePaths,
  checkedAt: string,
): Omit<
  StorageInvariantReport,
  | 'status'
  | 'message'
  | 'host'
  | 'rootfs'
  | 'mounted'
  | 'rootfsProbe'
  | 'daemons'
  | 'staleDaemons'
  | 'warnings'
  | 'requiresResolution'
  | 'resolutionOptions'
  | 'recommendedResolution'
> {
  return {
    hostId: options.hostId,
    vmid: guest.id,
    guestName: guest.name,
    guestType: guest.type,
    guestPath: paths.guestPath,
    hostPath: paths.hostPath,
    ...(paths.mp0Value !== undefined ? { mp0Value: paths.mp0Value } : {}),
    checkedAt,
  };
}

function simpleReport(
  guest: GuestDeployment,
  options: StorageInvariantOptions,
  paths: ResolvedStoragePaths,
  checkedAt: string,
  status: StorageInvariantStatus,
  warnings: readonly string[] = [],
): StorageInvariantReport {
  return {
    ...reportBase(guest, options, paths, checkedAt),
    status,
    message: messageFor(status, paths.guestPath, paths.hostPath, false),
    host: EMPTY_SUMMARY,
    rootfs: EMPTY_SUMMARY,
    mounted: false,
    rootfsProbe: 'skipped',
    daemons: [],
    staleDaemons: [],
    warnings,
    requiresResolution: false,
    resolutionOptions: [],
  };
}

/**
 * Storage-agnostic invariant check (D-46). It compares the host-backed mp0
 * directory with the raw rootfs path and reports split-brain or shadowed data
 * before file sync or stack startup. Read-only: it never changes a mount.
 */
export async function inspectStorageInvariants(
  guest: GuestDeployment,
  transport: Transport,
  options: StorageInvariantOptions,
): Promise<StorageInvariantReport> {
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  if (guest.type !== 'lxc') {
    return simpleReport(
      guest,
      options,
      {
        guestPath: options.guestPath ?? '/opt',
        hostPath: options.hostPath ?? '',
      },
      checkedAt,
      'not-applicable',
    );
  }

  let config: string;
  try {
    config = await readLxcConfig(transport, guest.id);
  } catch (error) {
    const paths: ResolvedStoragePaths = {
      guestPath: options.guestPath ?? '/opt',
      hostPath:
        options.hostPath ??
        defaultHostDataPath(
          options.hostId,
          guest.name,
          options.guestPath ?? '/opt',
        ),
    };
    return simpleReport(guest, options, paths, checkedAt, 'unknown', [
      error instanceof Error ? error.message : String(error),
    ]);
  }

  const resolved = resolveStoragePaths(guest, options.hostId, config);
  const paths: ResolvedStoragePaths = {
    guestPath: options.guestPath ?? resolved.guestPath,
    hostPath: options.hostPath ?? resolved.hostPath,
    ...(resolved.mp0Value !== undefined ? { mp0Value: resolved.mp0Value } : {}),
  };

  const power = await readPowerState(transport, guest.id);
  if (power !== 'running') {
    return simpleReport(
      guest,
      options,
      paths,
      checkedAt,
      'guest-stopped',
      power === undefined
        ? ['The guest power state could not be determined.']
        : [],
    );
  }

  const pid =
    options.pid ??
    parseStorageInitPid(
      (
        await transport.exec(storageInitPidArgv(guest.id), {
          timeoutMs: 10_000,
        })
      ).stdout,
    );
  if (pid === undefined) {
    return simpleReport(guest, options, paths, checkedAt, 'unknown', [
      'The container init pid could not be determined; the rootfs probe was skipped.',
    ]);
  }

  const hostResult = await transport.exec(
    storageHostSummaryArgv(paths.hostPath),
    { timeoutMs: 60_000, stdin: storageSummaryScript() },
  );
  const host = parseStorageSummary(hostResult.stdout);
  if (!host) {
    return simpleReport(guest, options, paths, checkedAt, 'unknown', [
      'The host data summary could not be parsed.',
    ]);
  }

  const probePath = options.rootfsProbePath ?? DEFAULT_ROOTFS_PROBE_PATH;
  const rootfsResult = await transport.exec(
    storageRootfsProbeArgv(pid, paths.guestPath, probePath),
    { timeoutMs: 120_000, stdin: storageRootfsProbeScript() },
  );
  const rootfs = parseStorageSummary(rootfsResult.stdout);
  if (!rootfs) {
    return simpleReport(guest, options, paths, checkedAt, 'unknown', [
      'The rootfs summary could not be parsed.',
    ]);
  }
  const rootfsProbe = parseStorageProbeMode(rootfsResult.stdout) ?? 'visible';

  const mountResult = await transport.exec(
    storageMountpointArgv(pid, paths.guestPath),
    { timeoutMs: 10_000 },
  );
  const mounted = mountResult.exitCode === 0;

  const daemonResult = await transport.exec(
    storageDaemonProbeArgv(
      paths.guestPath,
      guest.id,
      options.daemonNames ?? DEFAULT_LONG_RUNNING_DAEMONS,
    ),
    { timeoutMs: 30_000, stdin: storageDaemonProbeScript() },
  );
  const daemons = parseStorageDaemons(daemonResult.stdout, mounted);
  const staleDaemons = daemons.filter((daemon) => daemon.stale);
  const status = classify(host, rootfs, mounted, staleDaemons);
  const resolutionOptions: readonly StorageResolution[] =
    status === 'split-brain' || status === 'shadowed'
      ? ['keep-host-data', 'migrate-rootfs-to-host']
      : [];
  return {
    ...reportBase(guest, options, paths, checkedAt),
    status,
    message: messageFor(status, paths.guestPath, paths.hostPath, mounted),
    host,
    rootfs,
    mounted,
    rootfsProbe,
    daemons,
    staleDaemons,
    warnings: warningsFor(status, staleDaemons, rootfsProbe),
    requiresResolution: resolutionOptions.length > 0,
    resolutionOptions,
    ...(recommendedResolution(status, host, rootfs) !== undefined
      ? {
          recommendedResolution: recommendedResolution(status, host, rootfs)!,
        }
      : {}),
  };
}

/** Turn a job's stable creation time into the deterministic migration suffix. */
export function storageResolutionTimestamp(createdAt: Date): string {
  return createdAt
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replaceAll(':', '');
}

export function storagePlanMatchesReport(
  plan: LxcMigrationPlan,
  report: Pick<StorageInvariantReport, 'guestPath' | 'hostPath'>,
): boolean {
  return (
    plan.guestPath === report.guestPath && plan.hostPath === report.hostPath
  );
}
