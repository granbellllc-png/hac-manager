import { posix } from 'node:path';
import { formatOptionString, parseOptionString } from '../codec/options.js';
import type { PlanChange } from '../plans/types.js';
import type { GuestDeployment } from '../schema/deployment.js';
import type { JournaledStep } from '../steps/types.js';
import {
  createHostDirectoryStep,
  defaultHostDataPath,
  hostDirectoryMatches,
  planHostDirectory,
  readHostDirectory,
  resolveGuestIdMap,
  type GuestIdMap,
  type HostDirectoryPlan,
} from '../storage/host-dirs.js';
import type { ExecResult, Transport } from '../transport/types.js';

type Lxc = Extract<GuestDeployment, { type: 'lxc' }>;
type LxcMount = NonNullable<Lxc['mounts']>[number];

/** Where `pct mount` exposes a container rootfs on the host. */
export const LXC_ROOTFS_MOUNT_ROOT = '/var/lib/lxc';
/** Standard unprivileged idmap size when the deployment declares none. */
export const DEFAULT_IDMAP_SIZE = 65_536;
/** Graceful shutdown budget before migration fails instead of forcing a stop. */
export const LXC_MIGRATION_SHUTDOWN_TIMEOUT_S = 120;

/** A rejected or failed rootfs migration. */
export class LxcMigrationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LxcMigrationError';
  }
}

export interface LxcMigrationOptions {
  readonly hostId: string;
  /** Take a `vzdump` snapshot before stopping the guest. Defaults to true. */
  readonly backup?: boolean | undefined;
  /** Override the deployment's backup storage. */
  readonly backupStorage?: string | undefined;
  /** Deterministic suffix for `/opt.migrated-<timestamp>`; tests pass one. */
  readonly timestamp?: string | undefined;
  /** Guest path to migrate. Defaults to mp0's `guest_path` or `/opt`. */
  readonly guestPath?: string | undefined;
  /** Override the `pct mount` path; tests use a fixture path. */
  readonly rootfsMountPath?: string | undefined;
}

export interface LxcMigrationPlan {
  readonly summary: string;
  readonly vmid: number;
  readonly hostId: string;
  readonly guestPath: string;
  readonly hostPath: string;
  readonly rootfsMountPath: string;
  /** Raw rootfs path of the guest data, for example `/var/lib/lxc/112/rootfs/opt`. */
  readonly guestOptPath: string;
  /** Non-destructive rename target inside the rootfs. */
  readonly displacedPath: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: string;
  readonly idmap: GuestIdMap & { readonly size: number };
  readonly hostDirectory: HostDirectoryPlan;
  /** Canonical Proxmox `mp0` value attached after the copy. */
  readonly mp0Value: string;
  readonly backup: boolean;
  readonly readOnly: boolean;
  readonly changes: readonly PlanChange[];
  readonly warnings: readonly string[];
  readonly commands: readonly (readonly string[])[];
  readonly destructive: false;
  readonly blocked: boolean;
  readonly blockReason?: string | undefined;
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new LxcMigrationError(
      `${label} '${value}' cannot be used in a migration path; expected letters, digits, dot, underscore or dash.`,
    );
  }
  return value;
}

function assertGuestPath(guestPath: string): void {
  if (!guestPath.startsWith('/') || guestPath === '/') {
    throw new LxcMigrationError(
      `Migration guest path '${guestPath}' must be an absolute path below the filesystem root.`,
    );
  }
  for (const segment of guestPath.slice(1).split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new LxcMigrationError(
        `Migration guest path '${guestPath}' must not contain empty, '.' or '..' segments.`,
      );
    }
  }
}

function assertAbsolutePath(value: string, label: string): void {
  if (!value.startsWith('/') || posix.normalize(value) !== value) {
    throw new LxcMigrationError(
      `${label} '${value}' must be a normalized absolute path.`,
    );
  }
}

/** Host system paths that must never become a migration destination. */
const PROTECTED_HOST_ROOTS = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib64',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
] as const;

/** Reject a destination that overlaps the mounted rootfs it is copied from. */
function assertMigrationPaths(hostPath: string, rootfsMountPath: string): void {
  assertAbsolutePath(hostPath, 'hostPath');
  assertAbsolutePath(rootfsMountPath, 'rootfsMountPath');
  if (hostPath === '/') {
    throw new LxcMigrationError('hostPath must not be the filesystem root.');
  }
  if (
    PROTECTED_HOST_ROOTS.some(
      (root) => hostPath === root || hostPath.startsWith(`${root}/`),
    )
  ) {
    throw new LxcMigrationError(
      `hostPath '${hostPath}' is a host system path and cannot receive migrated guest data.`,
    );
  }
  if (
    hostPath === rootfsMountPath ||
    hostPath.startsWith(`${rootfsMountPath}/`) ||
    rootfsMountPath.startsWith(`${hostPath}/`)
  ) {
    throw new LxcMigrationError(
      `hostPath '${hostPath}' overlaps the mounted rootfs '${rootfsMountPath}'; choose a separate host directory.`,
    );
  }
}

function defaultTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replaceAll(':', '');
}

export function lxcRootfsMountPath(vmid: number): string {
  return `${LXC_ROOTFS_MOUNT_ROOT}/${vmid}/rootfs`;
}

/** Path inside the mounted rootfs, never resolved through the host root. */
export function lxcGuestRootfsPath(
  rootfsMountPath: string,
  guestPath: string,
): string {
  return posix.join(rootfsMountPath, guestPath);
}

export function lxcMigrationBackupArgv(
  vmid: number,
  options: LxcMigrationOptions,
): readonly string[] {
  const argv = [
    'vzdump',
    String(vmid),
    '--mode',
    'snapshot',
    '--compress',
    'zstd',
  ];
  if (options.backupStorage) argv.push('--storage', options.backupStorage);
  return argv;
}

export function lxcMigrationStopArgv(vmid: number): readonly string[] {
  return [
    'pct',
    'shutdown',
    String(vmid),
    '--timeout',
    String(LXC_MIGRATION_SHUTDOWN_TIMEOUT_S),
  ];
}

export function lxcMigrationMountArgv(vmid: number): readonly string[] {
  return ['pct', 'mount', String(vmid)];
}

export function lxcMigrationUnmountArgv(vmid: number): readonly string[] {
  return ['pct', 'unmount', String(vmid)];
}

export function lxcMigrationRsyncArgv(
  plan: Pick<LxcMigrationPlan, 'guestOptPath' | 'hostPath'>,
): readonly string[] {
  return [
    'rsync',
    '-aAXH',
    '--numeric-ids',
    `${plan.guestOptPath}/`,
    `${plan.hostPath}/`,
  ];
}

export function lxcMigrationDisplaceArgv(
  plan: Pick<LxcMigrationPlan, 'guestOptPath' | 'displacedPath'>,
): readonly string[] {
  return ['mv', plan.guestOptPath, plan.displacedPath];
}

export function lxcMigrationAttachArgv(
  vmid: number,
  mp0Value: string,
): readonly string[] {
  return ['pct', 'set', String(vmid), '--mp0', mp0Value];
}

export function lxcMigrationStartArgv(vmid: number): readonly string[] {
  return ['pct', 'start', String(vmid)];
}

/**
 * Canonical mp0 value for the migrated data. Mirrors the LXC codec: the host
 * path is positional, followed by `mp`, `backup` and `ro`.
 */
export function lxcMigrationMp0Value(
  hostPath: string,
  guestPath: string,
  backup: boolean,
  readOnly: boolean,
): string {
  return formatOptionString(hostPath, {
    mp: guestPath,
    ...(backup ? { backup: '1' } : {}),
    ...(readOnly ? { ro: '1' } : {}),
  });
}

/**
 * Generated script sent on stdin (never a nested `bash -c`). It shifts guest
 * UIDs/GIDs by the idmap only when the copied tree still uses guest IDs, and
 * then enforces the planned root ownership and mode. Re-running is safe.
 */
export function lxcUidShiftScript(): string {
  return [
    'set -eu',
    'root=$1',
    'uid_base=$2',
    'gid_base=$3',
    'idmap_size=$4',
    'root_uid=$5',
    'root_gid=$6',
    'root_mode=$7',
    'default_acl=$8',
    '',
    'if [ ! -d "$root" ]; then',
    '  echo "migration destination \'$root\' is missing" >&2',
    '  exit 1',
    'fi',
    '',
    'min_uid=$(find "$root" -printf \'%U\\n\' | sort -n | head -n 1)',
    'min_gid=$(find "$root" -printf \'%G\\n\' | sort -n | head -n 1)',
    '',
    'if [ "$uid_base" -gt 0 ] && [ "$min_uid" -lt "$uid_base" ]; then',
    '  find "$root" -printf \'%U\\n\' | sort -nu | while read -r uid; do',
    '    if [ "$uid" -lt "$idmap_size" ]; then',
    '      find "$root" -uid "$uid" -exec chown -h "$((uid + uid_base))" {} +',
    '    fi',
    '  done',
    'fi',
    '',
    'if [ "$gid_base" -gt 0 ] && [ "$min_gid" -lt "$gid_base" ]; then',
    '  find "$root" -printf \'%G\\n\' | sort -nu | while read -r gid; do',
    '    if [ "$gid" -lt "$idmap_size" ]; then',
    '      find "$root" -gid "$gid" -exec chgrp -h "$((gid + gid_base))" {} +',
    '    fi',
    '  done',
    'fi',
    '',
    'chown -h "$root_uid:$root_gid" "$root"',
    'chmod "$root_mode" "$root"',
    'if [ "$default_acl" = "1" ]; then',
    '  setfacl -d -m u::rwx,g::rwx,o::rwx "$root"',
    'fi',
  ].join('\n');
}

export function lxcUidShiftArgv(
  plan: Pick<
    LxcMigrationPlan,
    'hostPath' | 'uid' | 'gid' | 'mode' | 'idmap' | 'hostDirectory'
  >,
): readonly string[] {
  return [
    'bash',
    '-s',
    '--',
    plan.hostPath,
    String(plan.idmap.uidBase),
    String(plan.idmap.gidBase),
    String(plan.idmap.size),
    String(plan.uid),
    String(plan.gid),
    plan.mode,
    plan.hostDirectory.defaultAcl ? '1' : '0',
  ];
}

/**
 * Pure migration plan (D-45). The original data is displaced by rename and is
 * never deleted here; deleting `/opt.migrated-<timestamp>` is a later,
 * explicit action.
 */
export function planLxcMigration(
  guest: GuestDeployment,
  options: LxcMigrationOptions,
): LxcMigrationPlan {
  if (guest.type !== 'lxc') {
    throw new LxcMigrationError(
      `Rootfs-to-host migration only applies to LXC containers, not ${guest.type}.`,
    );
  }
  const vmid = guest.id;
  const declared = (guest.mounts ?? []).find((mount) => mount.index === 0);
  const guestPath = options.guestPath ?? declared?.guest_path ?? '/opt';
  assertGuestPath(guestPath);
  const hostPath =
    declared?.host_path ??
    defaultHostDataPath(options.hostId, guest.name, guestPath);
  const rootfsMountPath = options.rootfsMountPath ?? lxcRootfsMountPath(vmid);
  assertMigrationPaths(hostPath, rootfsMountPath);

  const idmap = resolveGuestIdMap(guest);
  const size = idmap.size ?? DEFAULT_IDMAP_SIZE;
  if (size <= 0) {
    throw new LxcMigrationError('The LXC idmap size must be positive.');
  }
  if (idmap.uidBase > 0 && idmap.uidBase < size) {
    throw new LxcMigrationError(
      `The idmap uid_base ${idmap.uidBase} overlaps the idmap size ${size}; automatic UID shifting cannot be idempotent. Choose a base of 0 or at least ${size}.`,
    );
  }
  if (idmap.gidBase > 0 && idmap.gidBase < size) {
    throw new LxcMigrationError(
      `The idmap gid_base ${idmap.gidBase} overlaps the idmap size ${size}; automatic GID shifting cannot be idempotent. Choose a base of 0 or at least ${size}.`,
    );
  }
  if (idmap.uidBase + size > 4_294_967_296) {
    throw new LxcMigrationError(
      `The idmap uid_base ${idmap.uidBase} plus size ${size} exceeds the UID range.`,
    );
  }
  if (idmap.gidBase + size > 4_294_967_296) {
    throw new LxcMigrationError(
      `The idmap gid_base ${idmap.gidBase} plus size ${size} exceeds the GID range.`,
    );
  }
  const effectiveIdmap: GuestIdMap & { readonly size: number } = {
    ...idmap,
    size,
  };

  const mount: LxcMount = declared ?? {
    index: 0,
    host_path: hostPath,
    guest_path: guestPath,
    permissions: 'minimal',
    backup: true,
  };
  const hostDirectory = planHostDirectory(
    { ...mount, host_path: hostPath, guest_path: guestPath },
    effectiveIdmap,
  );
  const backup = options.backup !== false;
  const readOnly = mount.readonly === true;
  const timestamp = safeSegment(
    options.timestamp ?? defaultTimestamp(),
    'timestamp',
  );
  const guestOptPath = lxcGuestRootfsPath(rootfsMountPath, guestPath);
  const displacedPath = lxcGuestRootfsPath(
    rootfsMountPath,
    `${guestPath}.migrated-${timestamp}`,
  );
  const mp0Value = lxcMigrationMp0Value(
    hostPath,
    guestPath,
    mount.backup === true,
    readOnly,
  );

  const changes: PlanChange[] = [];
  const warnings: string[] = [];
  if (backup) {
    changes.push({
      id: 'backup',
      action: 'execute',
      summary: `Back up LXC ${vmid} with vzdump snapshot mode before migration`,
    });
  } else {
    warnings.push(
      'No backup is taken before migration. The displaced rootfs copy is the only recovery source.',
    );
  }
  changes.push(
    {
      id: 'stop',
      action: 'update',
      summary: `Stop LXC ${vmid} before mounting its rootfs`,
      before: 'running',
      after: 'stopped',
    },
    {
      id: 'mount',
      action: 'execute',
      summary: `Mount the rootfs of LXC ${vmid} at ${rootfsMountPath}`,
    },
    {
      id: 'copy',
      action: 'execute',
      summary: `Copy ${guestPath} into ${hostPath} with rsync -aAXH`,
    },
    {
      id: 'uid-shift',
      action: 'update',
      summary: `Apply the guest idmap ownership to ${hostPath}`,
    },
    {
      id: 'displace',
      action: 'update',
      summary: `Rename ${guestPath} to ${guestPath}.migrated-${timestamp}`,
      before: guestOptPath,
      after: displacedPath,
    },
    {
      id: 'unmount',
      action: 'execute',
      summary: `Unmount the rootfs of LXC ${vmid}`,
    },
    {
      id: 'mp0',
      action: 'update',
      summary: `Attach mp0 ${hostPath} at ${guestPath} while the guest is stopped`,
      after: mp0Value,
    },
    {
      id: 'start',
      action: 'update',
      summary: `Start LXC ${vmid} with the host-backed ${guestPath}`,
      before: 'stopped',
      after: 'running',
    },
  );

  warnings.push(
    `The original ${guestPath} is renamed to ${guestPath}.migrated-${timestamp} inside the rootfs; it is never deleted automatically.`,
    'vzdump does not include other bind-mounted host data. Back those paths up separately if they matter.',
    'The guest is started after the migration; verify the application before deleting the displaced copy.',
  );
  if (!declared) {
    warnings.push(
      `No mp0 is declared in the deployment; a default mp0 at ${hostPath} with backup enabled is attached. Add it to the YAML before the next plan.`,
    );
  }

  const commands: (readonly string[])[] = [];
  if (backup) commands.push(lxcMigrationBackupArgv(vmid, options));
  commands.push(
    lxcMigrationStopArgv(vmid),
    lxcMigrationMountArgv(vmid),
    lxcMigrationRsyncArgv({ guestOptPath, hostPath }),
    lxcUidShiftArgv({
      hostPath,
      uid: hostDirectory.uid,
      gid: hostDirectory.gid,
      mode: hostDirectory.mode,
      idmap: effectiveIdmap,
      hostDirectory,
    }),
    lxcMigrationDisplaceArgv({ guestOptPath, displacedPath }),
    lxcMigrationUnmountArgv(vmid),
    lxcMigrationAttachArgv(vmid, mp0Value),
    lxcMigrationStartArgv(vmid),
  );

  return {
    summary: `Migrate ${guestPath} of LXC ${vmid} (${guest.name}) to ${hostPath} on ${options.hostId}`,
    vmid,
    hostId: options.hostId,
    guestPath,
    hostPath,
    rootfsMountPath,
    guestOptPath,
    displacedPath,
    uid: hostDirectory.uid,
    gid: hostDirectory.gid,
    mode: hostDirectory.mode,
    idmap: effectiveIdmap,
    hostDirectory,
    mp0Value,
    backup,
    readOnly,
    changes,
    warnings,
    commands,
    destructive: false,
    blocked: false,
  };
}

export function parseLxcPowerState(
  stdout: string,
): 'running' | 'stopped' | undefined {
  if (/^status:\s*running$/m.test(stdout)) return 'running';
  if (/^status:\s*stopped$/m.test(stdout)) return 'stopped';
  return undefined;
}

async function readPowerState(
  transport: Transport,
  vmid: number,
): Promise<'running' | 'stopped' | undefined> {
  const result = await transport.exec(['pct', 'status', String(vmid)], {
    timeoutMs: 10_000,
  });
  return result.exitCode === 0 ? parseLxcPowerState(result.stdout) : undefined;
}

async function readLxcConfig(
  transport: Transport,
  vmid: number,
): Promise<string> {
  const result = await transport.exec(['pct', 'config', String(vmid)], {
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) {
    throw new LxcMigrationError(
      `Failed to read the configuration of LXC ${vmid}: ${
        result.stderr.trim() || `exit code ${result.exitCode}`
      }`,
    );
  }
  return result.stdout;
}

function lxcMp0Line(config: string): string | undefined {
  const line = config
    .split(/\r?\n/)
    .find((candidate) => /^mp0\s*:/.test(candidate));
  return line?.slice(line.indexOf(':') + 1).trim();
}

function optionMapsEqual(left: string, right: string): boolean {
  const a = parseOptionString(left);
  const b = parseOptionString(right);
  if (a.positional !== b.positional) return false;
  const aKeys = Object.keys(a.options).sort();
  const bKeys = Object.keys(b.options).sort();
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key, index) => key === bKeys[index] && a.options[key] === b.options[key],
    )
  );
}

/** Compare the live `mp0` value with the canonical migration value. */
export function lxcMp0Matches(config: string, expected: string): boolean {
  const line = lxcMp0Line(config);
  return line !== undefined && optionMapsEqual(line, expected);
}

export function lxcHasPendingConfig(config: string): boolean {
  return config.includes('[PENDING]');
}

function commandFailure(
  vmid: number,
  argv: readonly string[],
  result: ExecResult,
): LxcMigrationError {
  return new LxcMigrationError(
    `Command '${argv.join(' ')}' failed for LXC ${vmid}: ${
      result.stderr.trim() || `exit code ${result.exitCode}`
    }`,
  );
}

async function configExists(
  transport: Transport,
  vmid: number,
): Promise<boolean> {
  const result = await transport.exec(
    ['test', '-f', `/etc/pve/local/lxc/${vmid}.conf`],
    { timeoutMs: 5_000 },
  );
  return result.exitCode === 0;
}

async function pathExists(
  transport: Transport,
  path: string,
): Promise<boolean> {
  const result = await transport.exec(['test', '-e', path], {
    timeoutMs: 5_000,
  });
  return result.exitCode === 0;
}

async function rootfsMounted(
  transport: Transport,
  mountPath: string,
): Promise<boolean> {
  const result = await transport.exec(['mountpoint', '-q', mountPath], {
    timeoutMs: 5_000,
  });
  return result.exitCode === 0;
}

async function requireStopped(
  transport: Transport,
  vmid: number,
  action: string,
): Promise<void> {
  const state = await readPowerState(transport, vmid);
  if (state !== 'stopped') {
    throw new LxcMigrationError(
      `Refusing to ${action} on LXC ${vmid}: the guest must be stopped, but its power state is ${
        state ?? 'unknown'
      }. mp0 is never hot-applied.`,
    );
  }
}

/**
 * Journaled, non-destructive rootfs-to-host migration (D-45). Every step is
 * idempotent where possible and the original data is never deleted. A failure
 * leaves either the untouched rootfs or the displaced copy in place.
 */
export function createLxcMigrationSteps(
  guest: GuestDeployment,
  options: LxcMigrationOptions,
): readonly JournaledStep<undefined>[] {
  const plan = planLxcMigration(guest, options);
  const { vmid } = plan;
  const steps: JournaledStep<undefined>[] = [
    createHostDirectoryStep(plan.hostDirectory),
  ];

  if (plan.backup) {
    const argv = lxcMigrationBackupArgv(vmid, options);
    steps.push({
      name: `back up LXC ${vmid} before rootfs migration`,
      check: async ({ transport }) => {
        if (!(await configExists(transport, vmid))) {
          throw new LxcMigrationError(
            `LXC ${vmid} does not exist on host '${plan.hostId}'.`,
          );
        }
        return { status: 'required', detail: { argv } };
      },
      apply: async ({ transport, logger }) => {
        const result = await transport.exec(argv, {
          timeoutMs: 1_800_000,
          onOutput: (stream, line) => {
            void logger.info(`vzdump ${stream}: ${line}`);
          },
        });
        if (result.exitCode !== 0) {
          throw new LxcMigrationError(
            `Backup of LXC ${vmid} failed; nothing was migrated: ${
              result.stderr.trim() || `exit code ${result.exitCode}`
            }`,
          );
        }
        return { backup: true };
      },
      verify: async ({ transport }) => {
        if (!(await configExists(transport, vmid))) {
          throw new LxcMigrationError(
            `LXC ${vmid} disappeared while taking its pre-migration backup.`,
          );
        }
        return { backup: true };
      },
      rollbackHint: `Inspect the vzdump log on ${plan.hostId}. The guest was not modified.`,
    });
  }

  const stopArgv = lxcMigrationStopArgv(vmid);
  steps.push({
    name: `stop LXC ${vmid} before rootfs migration`,
    check: async ({ transport }) => {
      const state = await readPowerState(transport, vmid);
      if (!state) {
        throw new LxcMigrationError(
          `Refusing to migrate LXC ${vmid}: its power state could not be determined. Stop it explicitly and retry.`,
        );
      }
      return state === 'stopped'
        ? { status: 'satisfied', detail: { state } }
        : { status: 'required', detail: { state } };
    },
    apply: async ({ transport, logger }) => {
      const state = await readPowerState(transport, vmid);
      if (state === 'stopped') return { changed: false };
      if (state !== 'running') {
        throw new LxcMigrationError(
          `Refusing to migrate LXC ${vmid}: its power state could not be determined. Stop it explicitly and retry.`,
        );
      }
      const result = await transport.exec(stopArgv, {
        timeoutMs: 180_000,
        onOutput: (stream, line) => {
          void logger.info(`pct shutdown ${stream}: ${line}`);
        },
      });
      if (result.exitCode !== 0) {
        throw new LxcMigrationError(
          `Failed to stop LXC ${vmid} before migration: ${
            result.stderr.trim() || `exit code ${result.exitCode}`
          }. The data was not touched.`,
        );
      }
      return { changed: true };
    },
    verify: async ({ transport }) => {
      const state = await readPowerState(transport, vmid);
      if (state !== 'stopped') {
        throw new LxcMigrationError(
          `LXC ${vmid} is '${state ?? 'unknown'}' after shutdown; migration requires it to be stopped.`,
        );
      }
      return { state };
    },
    rollbackHint: `Start LXC ${vmid} again if the migration is aborted; its rootfs is unchanged.`,
  });

  const mountArgv = lxcMigrationMountArgv(vmid);
  steps.push({
    name: `mount the rootfs of LXC ${vmid}`,
    check: async ({ transport }) =>
      (await rootfsMounted(transport, plan.rootfsMountPath))
        ? {
            status: 'satisfied',
            detail: { mountPath: plan.rootfsMountPath },
          }
        : { status: 'required', detail: { mountPath: plan.rootfsMountPath } },
    apply: async ({ transport }) => {
      if (await rootfsMounted(transport, plan.rootfsMountPath)) {
        return { changed: false };
      }
      const result = await transport.exec(mountArgv, { timeoutMs: 120_000 });
      if (result.exitCode !== 0) {
        throw commandFailure(vmid, mountArgv, result);
      }
      return { mountPath: plan.rootfsMountPath };
    },
    verify: async ({ transport }) => {
      if (!(await rootfsMounted(transport, plan.rootfsMountPath))) {
        throw new LxcMigrationError(
          `Rootfs of LXC ${vmid} is not mounted at '${plan.rootfsMountPath}' after pct mount.`,
        );
      }
      return { mountPath: plan.rootfsMountPath };
    },
    rollbackHint: `Run 'pct unmount ${vmid}' on ${plan.hostId} if the migration is aborted while mounted.`,
  });

  const rsyncArgv = lxcMigrationRsyncArgv(plan);
  steps.push({
    name: `copy ${plan.guestPath} of LXC ${vmid} to ${plan.hostPath}`,
    check: async ({ transport }) => {
      const source = await pathExists(transport, plan.guestOptPath);
      const displaced = await pathExists(transport, plan.displacedPath);
      if (!source) {
        if (displaced) {
          return {
            status: 'satisfied',
            detail: { sourceMissing: true, displaced: plan.displacedPath },
          };
        }
        throw new LxcMigrationError(
          `Rootfs path '${plan.guestOptPath}' and its displaced copy '${plan.displacedPath}' are both missing; refusing to continue.`,
        );
      }
      return { status: 'required', detail: { source: plan.guestOptPath } };
    },
    apply: async ({ transport, logger }) => {
      const source = await pathExists(transport, plan.guestOptPath);
      const displaced = await pathExists(transport, plan.displacedPath);
      if (!source && displaced) return { changed: false };
      if (!source) {
        throw new LxcMigrationError(
          `Rootfs path '${plan.guestOptPath}' disappeared before the copy; the displaced copy is also missing.`,
        );
      }
      const result = await transport.exec(rsyncArgv, {
        timeoutMs: 3_600_000,
        onOutput: (stream, line) => {
          void logger.info(`rsync ${stream}: ${line}`);
        },
      });
      if (result.exitCode !== 0) {
        throw commandFailure(vmid, rsyncArgv, result);
      }
      return { hostPath: plan.hostPath };
    },
    verify: async ({ transport }) => {
      if (!(await pathExists(transport, plan.hostPath))) {
        throw new LxcMigrationError(
          `Host directory '${plan.hostPath}' is missing after the rsync copy.`,
        );
      }
      return { hostPath: plan.hostPath, copied: true };
    },
    rollbackHint: `The rootfs is untouched and '${plan.hostPath}' may be partially copied. Re-run the copy before displacing anything.`,
  });

  const shiftArgv = lxcUidShiftArgv(plan);
  steps.push({
    name: `apply the guest idmap to ${plan.hostPath}`,
    check: async ({ transport }) => {
      const stat = await readHostDirectory(transport, plan.hostPath);
      if (!stat) return { status: 'required' };
      const rootReady = hostDirectoryMatches(plan.hostDirectory, stat);
      const uidShifted =
        plan.idmap.uidBase === 0 || stat.uid >= plan.idmap.uidBase;
      const gidShifted =
        plan.idmap.gidBase === 0 || stat.gid >= plan.idmap.gidBase;
      return rootReady && uidShifted && gidShifted
        ? { status: 'satisfied', detail: { stat } }
        : { status: 'required', detail: { stat } };
    },
    apply: async ({ transport, logger }) => {
      const result = await transport.exec(shiftArgv, {
        timeoutMs: 3_600_000,
        stdin: lxcUidShiftScript(),
        onOutput: (stream, line) => {
          void logger.info(`uid shift ${stream}: ${line}`);
        },
      });
      if (result.exitCode !== 0) {
        throw commandFailure(vmid, shiftArgv, result);
      }
      return { uid: plan.uid, gid: plan.gid, mode: plan.mode };
    },
    verify: async ({ transport }) => {
      const stat = await readHostDirectory(transport, plan.hostPath);
      if (!stat || !hostDirectoryMatches(plan.hostDirectory, stat)) {
        throw new LxcMigrationError(
          `Host directory '${plan.hostPath}' does not have the planned ownership or mode after the UID shift.`,
        );
      }
      if (
        (plan.idmap.uidBase > 0 && stat.uid < plan.idmap.uidBase) ||
        (plan.idmap.gidBase > 0 && stat.gid < plan.idmap.gidBase)
      ) {
        throw new LxcMigrationError(
          `Host directory '${plan.hostPath}' still contains unmapped ownership after the UID shift.`,
        );
      }
      return { stat };
    },
    rollbackHint: `Re-run the shift script or chown '${plan.hostPath}' manually; the rootfs copy is still intact.`,
  });

  const displaceArgv = lxcMigrationDisplaceArgv(plan);
  steps.push({
    name: `displace ${plan.guestPath} of LXC ${vmid} without deleting it`,
    check: async ({ transport }) => {
      const source = await pathExists(transport, plan.guestOptPath);
      const displaced = await pathExists(transport, plan.displacedPath);
      if (!source && displaced) {
        return {
          status: 'satisfied',
          detail: { displaced: plan.displacedPath },
        };
      }
      if (source && displaced) {
        throw new LxcMigrationError(
          `Refusing to overwrite '${plan.displacedPath}': it already exists. Re-plan with a new timestamp.`,
        );
      }
      if (!source) {
        throw new LxcMigrationError(
          `Neither '${plan.guestOptPath}' nor '${plan.displacedPath}' exists; the rootfs copy is in an unknown state.`,
        );
      }
      return { status: 'required', detail: { source: plan.guestOptPath } };
    },
    apply: async ({ transport }) => {
      const source = await pathExists(transport, plan.guestOptPath);
      const displaced = await pathExists(transport, plan.displacedPath);
      if (!source && displaced) return { changed: false };
      if (!source) {
        throw new LxcMigrationError(
          `'${plan.guestOptPath}' disappeared before it could be displaced.`,
        );
      }
      if (displaced) {
        throw new LxcMigrationError(
          `Refusing to overwrite '${plan.displacedPath}': it already exists.`,
        );
      }
      const result = await transport.exec(displaceArgv, { timeoutMs: 120_000 });
      if (result.exitCode !== 0) {
        throw commandFailure(vmid, displaceArgv, result);
      }
      return { displaced: plan.displacedPath };
    },
    verify: async ({ transport }) => {
      if (
        (await pathExists(transport, plan.guestOptPath)) ||
        !(await pathExists(transport, plan.displacedPath))
      ) {
        throw new LxcMigrationError(
          `LXC ${vmid} was not displaced correctly: expected '${plan.guestOptPath}' to be gone and '${plan.displacedPath}' to exist.`,
        );
      }
      return { displaced: plan.displacedPath };
    },
    rollbackHint: `Rename '${plan.displacedPath}' back to '${plan.guestOptPath}' on the mounted rootfs to undo the displacement.`,
  });

  const unmountArgv = lxcMigrationUnmountArgv(vmid);
  steps.push({
    name: `unmount the rootfs of LXC ${vmid}`,
    check: async ({ transport }) =>
      (await rootfsMounted(transport, plan.rootfsMountPath))
        ? { status: 'required' }
        : { status: 'satisfied' },
    apply: async ({ transport }) => {
      if (!(await rootfsMounted(transport, plan.rootfsMountPath))) {
        return { changed: false };
      }
      const result = await transport.exec(unmountArgv, { timeoutMs: 120_000 });
      if (result.exitCode !== 0) {
        throw commandFailure(vmid, unmountArgv, result);
      }
      return { mountPath: plan.rootfsMountPath };
    },
    verify: async ({ transport }) => {
      if (await rootfsMounted(transport, plan.rootfsMountPath)) {
        throw new LxcMigrationError(
          `Rootfs of LXC ${vmid} is still mounted at '${plan.rootfsMountPath}'.`,
        );
      }
      return { mounted: false };
    },
    rollbackHint: `Run 'pct unmount ${vmid}' on ${plan.hostId} before attaching mp0 or starting the guest.`,
  });

  const attachArgv = lxcMigrationAttachArgv(vmid, plan.mp0Value);
  steps.push({
    name: `attach mp0 to LXC ${vmid} while stopped`,
    check: async ({ transport }) => {
      const config = await readLxcConfig(transport, vmid);
      if (
        lxcMp0Matches(config, plan.mp0Value) &&
        !lxcHasPendingConfig(config)
      ) {
        return { status: 'satisfied', detail: { mp0: plan.mp0Value } };
      }
      await requireStopped(transport, vmid, 'attach mp0');
      return { status: 'required', detail: { mp0: plan.mp0Value } };
    },
    apply: async ({ transport }) => {
      const config = await readLxcConfig(transport, vmid);
      if (
        lxcMp0Matches(config, plan.mp0Value) &&
        !lxcHasPendingConfig(config)
      ) {
        return { changed: false };
      }
      await requireStopped(transport, vmid, 'attach mp0');
      const result = await transport.exec(attachArgv, { timeoutMs: 120_000 });
      if (result.exitCode !== 0) {
        throw commandFailure(vmid, attachArgv, result);
      }
      return { mp0: plan.mp0Value };
    },
    verify: async ({ transport }) => {
      const config = await readLxcConfig(transport, vmid);
      if (lxcHasPendingConfig(config)) {
        throw new LxcMigrationError(
          `LXC ${vmid} still has a pending configuration after attaching mp0. [PENDING] must be empty.`,
        );
      }
      if (!lxcMp0Matches(config, plan.mp0Value)) {
        throw new LxcMigrationError(
          `LXC ${vmid} does not have the planned mp0 value after attaching it.`,
        );
      }
      return { mp0: plan.mp0Value };
    },
    rollbackHint: `Inspect 'pct config ${vmid}' on ${plan.hostId}; detach mp0 only while the guest is stopped.`,
  });

  const startArgv = lxcMigrationStartArgv(vmid);
  steps.push({
    name: `start LXC ${vmid} with host-backed ${plan.guestPath}`,
    check: async ({ transport }) => {
      const state = await readPowerState(transport, vmid);
      if (!state) {
        throw new LxcMigrationError(
          `Refusing to start LXC ${vmid}: its power state could not be determined.`,
        );
      }
      return state === 'running'
        ? { status: 'satisfied', detail: { state } }
        : { status: 'required', detail: { state } };
    },
    apply: async ({ transport }) => {
      if ((await readPowerState(transport, vmid)) === 'running') {
        return { changed: false };
      }
      const result = await transport.exec(startArgv, { timeoutMs: 180_000 });
      if (result.exitCode !== 0) {
        throw commandFailure(vmid, startArgv, result);
      }
      return { changed: true };
    },
    verify: async ({ transport }) => {
      const state = await readPowerState(transport, vmid);
      if (state !== 'running') {
        throw new LxcMigrationError(
          `LXC ${vmid} is '${state ?? 'unknown'}' after starting it with the host-backed ${plan.guestPath}.`,
        );
      }
      return { state };
    },
    rollbackHint: `Inspect 'pct config ${vmid}' and the guest console. The displaced copy remains in the rootfs.`,
  });

  steps.push({
    name: `verify the host-backed ${plan.guestPath} of LXC ${vmid}`,
    check: async () => ({ status: 'required' }),
    apply: async ({ transport }) => {
      const config = await readLxcConfig(transport, vmid);
      const state = await readPowerState(transport, vmid);
      const stat = await readHostDirectory(transport, plan.hostPath);
      if (lxcHasPendingConfig(config)) {
        throw new LxcMigrationError(
          `LXC ${vmid} still has a pending configuration after migration. [PENDING] must be empty.`,
        );
      }
      if (!lxcMp0Matches(config, plan.mp0Value)) {
        throw new LxcMigrationError(
          `LXC ${vmid} does not expose the planned mp0 after migration.`,
        );
      }
      if (state !== 'running') {
        throw new LxcMigrationError(
          `LXC ${vmid} is not running after migration.`,
        );
      }
      if (!stat || !hostDirectoryMatches(plan.hostDirectory, stat)) {
        throw new LxcMigrationError(
          `Host directory '${plan.hostPath}' does not match the planned ownership or mode.`,
        );
      }
      return {
        mp0: plan.mp0Value,
        hostPath: plan.hostPath,
        displaced: plan.displacedPath,
      };
    },
    verify: async ({ transport }) => {
      const stat = await readHostDirectory(transport, plan.hostPath);
      if (!stat || !hostDirectoryMatches(plan.hostDirectory, stat)) {
        throw new LxcMigrationError(
          `Host directory '${plan.hostPath}' changed during migration verification.`,
        );
      }
      return { stat, mp0: plan.mp0Value };
    },
    rollbackHint: `The original data is still at '${plan.displacedPath}' inside the rootfs; rename it back after unmounting.`,
  });

  return steps;
}
