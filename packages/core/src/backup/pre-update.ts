/**
 * Pre-update backups (D-54, D-55).
 *
 * `vzdump` snapshots the guest disks but never bind-mounted host data, so every
 * protected host path gets its own snapshot, restic or rsync step. The plan
 * states exactly which paths are covered and which are not, and a failing
 * backup step throws so the update job stops before touching the guest.
 */

import { posix } from 'node:path';
import type { PlanChange } from '../plans/types.js';
import type { JournaledStep } from '../steps/types.js';
import type { ExecResult, Transport } from '../transport/types.js';

export const DEFAULT_HOST_DATA_BACKUP_ROOT = '/var/backups/hacm';
export const VZDUMP_TIMEOUT_MS = 1_800_000;
export const DATA_PROTECTION_TIMEOUT_MS = 3_600_000;
export const PROBE_TIMEOUT_MS = 15_000;

export type PreUpdateGuestType = 'lxc' | 'vm';

export interface PreUpdateMount {
  readonly index?: number | undefined;
  readonly host_path: string;
  readonly guest_path?: string | undefined;
  /** Explicit opt-out: this host path is not protected before the update. */
  readonly backup?: boolean | undefined;
  /** Backing file system, for example `zfs`, `btrfs` or `ext4`. */
  readonly filesystem?: string | undefined;
  /** ZFS dataset backing the path; required for a ZFS snapshot. */
  readonly dataset?: string | undefined;
}

export interface PreUpdateBackupGuest {
  readonly hostId: string;
  readonly vmid: number;
  readonly type: PreUpdateGuestType;
  readonly name: string;
  readonly backup_skip?: boolean | undefined;
  readonly backup_storage?: string | undefined;
  readonly mounts?: readonly PreUpdateMount[] | undefined;
}

export interface PreUpdateResticOptions {
  readonly repository: string;
  readonly passwordFile?: string | undefined;
  /** Tag applied to the restic snapshot; defaults to `hacm-<label>`. */
  readonly tag?: string | undefined;
}

export type PreUpdateDataProtection = 'auto' | 'snapshot' | 'restic' | 'rsync';

export interface PreUpdateBackupOptions {
  /** Injected clock so the backup label is deterministic in tests. */
  readonly now?: Date | undefined;
  /** Override the deployment's guest name in the label. */
  readonly appName?: string | undefined;
  /** Override the deployment's `backup_storage`. */
  readonly backupStorage?: string | undefined;
  /** Root for btrfs snapshots and rsync copies. */
  readonly backupRoot?: string | undefined;
  readonly restic?: PreUpdateResticOptions | undefined;
  /** Force a host-data protection method; `auto` picks one per path. */
  readonly dataProtection?: PreUpdateDataProtection | undefined;
}

export type DataProtectionMethod = 'snapshot' | 'restic' | 'rsync' | 'skip';

export interface DataProtectionEntry {
  readonly id: string;
  readonly hostPath: string;
  readonly guestPath?: string | undefined;
  readonly method: DataProtectionMethod;
  readonly target?: string | undefined;
  readonly probe: readonly string[];
  readonly commands: readonly (readonly string[])[];
  readonly resticTag?: string | undefined;
  readonly reason?: string | undefined;
}

export interface PreUpdateGuestBackup {
  readonly included: boolean;
  readonly argv: readonly string[];
  readonly storage?: string | undefined;
  readonly verification: 'pvesm' | 'exit-code';
  readonly warning?: string | undefined;
}

export interface PreUpdateBackupPlan {
  readonly label: string;
  readonly summary: string;
  readonly target: {
    readonly hostId: string;
    readonly vmid: number;
    readonly type: PreUpdateGuestType;
    readonly name: string;
  };
  readonly skipped: boolean;
  readonly guestBackup: PreUpdateGuestBackup;
  readonly dataProtection: readonly DataProtectionEntry[];
  /** Host paths protected by a separate snapshot, restic or rsync step. */
  readonly covered: readonly string[];
  /** Host paths the plan explicitly does not protect. */
  readonly uncovered: readonly string[];
  readonly warnings: readonly string[];
  readonly changes: readonly PlanChange[];
  readonly commands: readonly (readonly string[])[];
}

export class PreUpdateBackupError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PreUpdateBackupError';
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `YYYY-MM-DD_HH-MM-SS` in UTC, matching the D-54 label shape. */
export function formatBackupTimestamp(now: Date): string {
  return [
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(
      now.getUTCDate(),
    )}`,
    `${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(
      now.getUTCSeconds(),
    )}`,
  ].join('_');
}

/** Replace characters that are unsafe in backup labels and paths. */
export function backupSlug(value: string): string {
  const slug = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'guest';
}

/** `VMID_YYYY-MM-DD_HH-MM-SS_AppName` (D-54). */
export function backupLabel(vmid: number, appName: string, now: Date): string {
  return `${vmid}_${formatBackupTimestamp(now)}_${backupSlug(appName)}`;
}

function assertGuest(guest: PreUpdateBackupGuest): void {
  if (!Number.isSafeInteger(guest.vmid) || guest.vmid < 1) {
    throw new PreUpdateBackupError(
      `VMID '${String(guest.vmid)}' is not a positive integer.`,
    );
  }
  if (!guest.hostId.trim()) {
    throw new PreUpdateBackupError('hostId must not be empty.');
  }
  if (guest.type !== 'lxc' && guest.type !== 'vm') {
    throw new PreUpdateBackupError(
      `Guest type must be 'lxc' or 'vm', received '${String(guest.type)}'.`,
    );
  }
}

/** `vzdump` argv with snapshot mode, zstd, a note label and optional storage. */
export function preUpdateVzdumpArgv(
  guest: PreUpdateBackupGuest,
  label: string,
  storage?: string | undefined,
): readonly string[] {
  const argv = [
    'vzdump',
    String(guest.vmid),
    '--mode',
    'snapshot',
    '--compress',
    'zstd',
    '--notes-template',
    label,
  ];
  if (storage !== undefined && storage.length > 0) {
    argv.push('--storage', storage);
  }
  return argv;
}

function resticBase(options: PreUpdateResticOptions): string[] {
  const argv = ['restic', '-r', options.repository];
  if (options.passwordFile !== undefined) {
    argv.push('--password-file', options.passwordFile);
  }
  return argv;
}

interface ResolvedProtection {
  readonly method: Exclude<DataProtectionMethod, 'skip'>;
  readonly target: string;
  readonly probe: readonly string[];
  readonly commands: readonly (readonly string[])[];
  readonly resticTag?: string | undefined;
  readonly warning?: string | undefined;
}

function snapshotTarget(
  mount: PreUpdateMount,
  label: string,
  backupRoot: string,
): { readonly target: string; readonly command: readonly string[] } {
  const filesystem = (mount.filesystem ?? '').toLowerCase();
  if (filesystem === 'zfs' || filesystem === 'zfspool') {
    if (!mount.dataset || mount.dataset.trim().length === 0) {
      throw new PreUpdateBackupError(
        `Cannot snapshot '${mount.host_path}': a ZFS dataset is required.`,
      );
    }
    const target = `${mount.dataset.trim()}@hacm-${label}`;
    return { target, command: ['zfs', 'snapshot', target] };
  }
  if (filesystem !== 'btrfs') {
    throw new PreUpdateBackupError(
      `Cannot snapshot '${mount.host_path}': unsupported file system '${mount.filesystem ?? 'unknown'}'.`,
    );
  }
  const target = posix.join(
    backupRoot,
    `${backupSlug(mount.host_path)}-${label}`,
  );
  return {
    target,
    command: ['btrfs', 'subvolume', 'snapshot', '-r', mount.host_path, target],
  };
}

function resolveProtection(
  mount: PreUpdateMount,
  label: string,
  options: PreUpdateBackupOptions,
  backupRoot: string,
): ResolvedProtection {
  const forced = options.dataProtection ?? 'auto';
  const filesystem = (mount.filesystem ?? '').toLowerCase();
  const snapshotCapable =
    (filesystem === 'zfs' || filesystem === 'zfspool') &&
    mount.dataset !== undefined
      ? true
      : filesystem === 'btrfs';
  const restic = options.restic;

  let method: Exclude<DataProtectionMethod, 'skip'>;
  let warning: string | undefined;
  if (forced === 'snapshot') {
    method = 'snapshot';
  } else if (forced === 'restic') {
    if (!restic) {
      throw new PreUpdateBackupError(
        'restic data protection was requested but no restic repository is configured.',
      );
    }
    method = 'restic';
  } else if (forced === 'rsync') {
    method = 'rsync';
  } else if (snapshotCapable) {
    method = 'snapshot';
  } else if (restic) {
    method = 'restic';
  } else {
    method = 'rsync';
    if (
      filesystem === 'zfs' ||
      filesystem === 'zfspool' ||
      filesystem === 'btrfs'
    ) {
      warning = `'${mount.host_path}' looks snapshot-capable (${mount.filesystem}) but no dataset was declared; falling back to an rsync copy.`;
    }
  }

  if (method === 'snapshot') {
    const snapshot = snapshotTarget(mount, label, backupRoot);
    const probe =
      (filesystem === 'zfs' || filesystem === 'zfspool') &&
      mount.dataset !== undefined
        ? ['zfs', 'list', '-H', '-o', 'name', '-t', 'snapshot', snapshot.target]
        : ['test', '-d', snapshot.target];
    return {
      method,
      target: snapshot.target,
      probe,
      commands: [snapshot.command],
      ...(warning !== undefined ? { warning } : {}),
    };
  }

  if (method === 'restic') {
    if (!restic) {
      throw new PreUpdateBackupError(
        'restic data protection requires a repository.',
      );
    }
    const tag = restic.tag ?? `hacm-${label}`;
    const base = resticBase(restic);
    return {
      method,
      target: `${restic.repository}#${tag}`,
      resticTag: tag,
      probe: [...base, 'snapshots', '--tag', tag, '--last', '1', '--json'],
      commands: [resticBackupCommand(restic, tag, mount.host_path)],
      ...(warning !== undefined ? { warning } : {}),
    };
  }

  const target = posix.join(
    backupRoot,
    `${backupSlug(mount.host_path)}-${label}`,
  );
  return {
    method,
    target,
    probe: ['test', '-d', target],
    commands: [
      ['mkdir', '-p', target],
      ['rsync', '-aAXH', '--numeric-ids', `${mount.host_path}/`, `${target}/`],
    ],
    ...(warning !== undefined ? { warning } : {}),
  };
}

function resticBackupCommand(
  restic: PreUpdateResticOptions,
  tag: string,
  hostPath: string,
): readonly string[] {
  return [...resticBase(restic), 'backup', '--tag', tag, hostPath];
}

function dedupeMounts(
  mounts: readonly PreUpdateMount[],
): readonly PreUpdateMount[] {
  const seen = new Map<string, PreUpdateMount>();
  for (const mount of mounts) {
    const existing = seen.get(mount.host_path);
    if (!existing || (existing.backup === false && mount.backup !== false)) {
      seen.set(mount.host_path, mount);
    }
  }
  return [...seen.values()];
}

/**
 * Pure pre-update backup plan. It never runs a command; the journaled steps in
 * `createPreUpdateBackupSteps` execute exactly the commands listed here.
 */
export function planPreUpdateBackup(
  guest: PreUpdateBackupGuest,
  options: PreUpdateBackupOptions = {},
): PreUpdateBackupPlan {
  assertGuest(guest);
  const now = options.now ?? new Date();
  const label = backupLabel(guest.vmid, options.appName ?? guest.name, now);
  const storage = options.backupStorage ?? guest.backup_storage;
  const backupRoot = options.backupRoot ?? DEFAULT_HOST_DATA_BACKUP_ROOT;
  const target = {
    hostId: guest.hostId,
    vmid: guest.vmid,
    type: guest.type,
    name: guest.name,
  } as const;

  if (guest.backup_skip === true) {
    const mounts = dedupeMounts(guest.mounts ?? []);
    return {
      label,
      summary: `Skip the pre-update backup of ${guest.type.toUpperCase()} ${guest.vmid} (${guest.name}) on ${guest.hostId}`,
      target,
      skipped: true,
      guestBackup: {
        included: false,
        argv: [],
        verification: 'exit-code',
        warning:
          'backup_skip is enabled: no guest or host-data backup is taken before this update.',
      },
      dataProtection: mounts.map((mount, index) => ({
        id: `protect-data-${index}`,
        hostPath: mount.host_path,
        ...(mount.guest_path !== undefined
          ? { guestPath: mount.guest_path }
          : {}),
        method: 'skip' as const,
        probe: [],
        commands: [],
        reason: 'backup_skip is enabled for this guest',
      })),
      covered: [],
      uncovered: mounts.map((mount) => mount.host_path),
      warnings: [
        'backup_skip is enabled: no guest or host-data backup is taken before this update.',
        'The update proceeds without a verified restore point.',
      ],
      changes: [],
      commands: [],
    };
  }

  const warnings: string[] = [];
  const argv = preUpdateVzdumpArgv(guest, label, storage);
  const guestBackup: PreUpdateGuestBackup = {
    included: true,
    argv,
    ...(storage !== undefined && storage.length > 0 ? { storage } : {}),
    verification:
      storage !== undefined && storage.length > 0 ? 'pvesm' : 'exit-code',
  };
  const changes: PlanChange[] = [
    {
      id: 'guest-backup',
      action: 'execute',
      summary: `Back up ${guest.type.toUpperCase()} ${guest.vmid} (${guest.name}) with vzdump snapshot mode`,
      after: {
        label,
        storage: storage ?? null,
        mode: 'snapshot',
        compress: 'zstd',
      },
    },
  ];

  if (guest.type === 'vm' && (guest.mounts ?? []).length > 0) {
    warnings.push(
      'VMs have no bind-mounted host data; mounts were ignored for the pre-update backup.',
    );
  }
  const mounts = guest.type === 'lxc' ? dedupeMounts(guest.mounts ?? []) : [];

  const dataProtection: DataProtectionEntry[] = [];
  const covered: string[] = [];
  const uncovered: string[] = [];
  const commands: (readonly string[])[] = [[...argv]];

  for (const mount of mounts) {
    const id = `protect-data-${dataProtection.length}`;
    if (mount.backup === false) {
      dataProtection.push({
        id,
        hostPath: mount.host_path,
        ...(mount.guest_path !== undefined
          ? { guestPath: mount.guest_path }
          : {}),
        method: 'skip',
        probe: [],
        commands: [],
        reason: 'backup: false',
      });
      uncovered.push(mount.host_path);
      warnings.push(
        `Host data '${mount.host_path}' is not protected because the mount sets backup: false.`,
      );
      continue;
    }

    const resolved = resolveProtection(mount, label, options, backupRoot);
    const entry: DataProtectionEntry = {
      id,
      hostPath: mount.host_path,
      ...(mount.guest_path !== undefined
        ? { guestPath: mount.guest_path }
        : {}),
      method: resolved.method,
      target: resolved.target,
      probe: resolved.probe,
      commands: resolved.commands,
      ...(resolved.resticTag !== undefined
        ? { resticTag: resolved.resticTag }
        : {}),
    };
    dataProtection.push(entry);
    covered.push(mount.host_path);
    commands.push(...resolved.commands);
    if (resolved.warning !== undefined) warnings.push(resolved.warning);
    changes.push({
      id,
      action: 'execute',
      summary: `Protect host data '${mount.host_path}' with ${resolved.method}`,
      after: { method: resolved.method, target: resolved.target },
    });
  }

  if (mounts.length > 0) {
    warnings.push(
      'vzdump does not include bind-mounted host data; the host paths above are protected by separate steps.',
    );
  }

  return {
    label,
    summary: `Back up ${guest.type.toUpperCase()} ${guest.vmid} (${guest.name}) before updating it on ${guest.hostId}`,
    target,
    skipped: false,
    guestBackup,
    dataProtection,
    covered,
    uncovered,
    warnings,
    changes,
    commands,
  };
}

async function protectionPresent(
  transport: Transport,
  entry: DataProtectionEntry,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await transport.exec(entry.probe, {
    timeoutMs: PROBE_TIMEOUT_MS,
    signal,
  });
  if (result.exitCode !== 0) return false;
  if (entry.method === 'restic') {
    const text = result.stdout.trim();
    return text.length > 0 && text !== '[]';
  }
  return true;
}

function backupFailureMessage(
  label: string,
  what: string,
  result: ExecResult,
): string {
  return `Pre-update backup '${label}' (${what}) failed; the update is aborted: ${
    result.stderr.trim() || `exit code ${result.exitCode}`
  }`;
}

function guestConfigPath(type: PreUpdateGuestType, vmid: number): string {
  return type === 'lxc'
    ? `/etc/pve/local/lxc/${vmid}.conf`
    : `/etc/pve/local/qemu-server/${vmid}.conf`;
}

async function guestConfigPresent(
  transport: Transport,
  plan: PreUpdateBackupPlan,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await transport.exec(
    ['test', '-f', guestConfigPath(plan.target.type, plan.target.vmid)],
    { timeoutMs: PROBE_TIMEOUT_MS, signal },
  );
  return result.exitCode === 0;
}

async function backupListed(
  transport: Transport,
  plan: PreUpdateBackupPlan,
  signal: AbortSignal,
): Promise<boolean> {
  const storage = plan.guestBackup.storage;
  if (storage === undefined) return true;
  const result = await transport.exec(['pvesm', 'list', storage], {
    timeoutMs: PROBE_TIMEOUT_MS,
    signal,
  });
  if (result.exitCode !== 0) {
    throw new PreUpdateBackupError(
      `Could not verify the backup on storage '${storage}': ${
        result.stderr.trim() || `exit code ${result.exitCode}`
      }`,
    );
  }
  const pattern = new RegExp(`vzdump-(?:lxc|qemu)-${plan.target.vmid}-`);
  return pattern.test(result.stdout);
}

/**
 * Journaled pre-update backups. The guest backup runs first and every data
 * protection step follows it; any failure throws, so the caller's update steps
 * never run.
 */
export function createPreUpdateBackupSteps(
  plan: PreUpdateBackupPlan,
): readonly JournaledStep<undefined>[] {
  const steps: JournaledStep<undefined>[] = [];
  const { label } = plan;

  if (!plan.skipped && plan.guestBackup.included) {
    const argv = plan.guestBackup.argv;
    steps.push({
      name: `back up ${plan.target.type.toUpperCase()} ${plan.target.vmid} with vzdump before update`,
      check: async () => ({ status: 'required' }),
      apply: async ({ transport, logger, signal }) => {
        const result = await transport.exec(argv, {
          timeoutMs: VZDUMP_TIMEOUT_MS,
          signal,
          onOutput: (stream, chunk) => {
            void logger.info(`vzdump ${stream}: ${chunk}`);
          },
        });
        if (result.exitCode !== 0) {
          throw new PreUpdateBackupError(
            backupFailureMessage(
              label,
              `vzdump ${plan.target.type.toUpperCase()} ${plan.target.vmid}`,
              result,
            ),
          );
        }
        return { backup: true, label };
      },
      verify: async ({ transport, signal }) => {
        if (!(await guestConfigPresent(transport, plan, signal))) {
          throw new PreUpdateBackupError(
            `Guest ${plan.target.vmid} disappeared while taking its pre-update backup.`,
          );
        }
        if (!(await backupListed(transport, plan, signal))) {
          throw new PreUpdateBackupError(
            `No vzdump archive for guest ${plan.target.vmid} was found on storage '${plan.guestBackup.storage}' after the backup completed.`,
          );
        }
        return { backup: true, verification: plan.guestBackup.verification };
      },
      rollbackHint: `Inspect the vzdump task and notes label '${label}' on ${plan.target.hostId}. The guest was not modified.`,
    });
  }

  for (const entry of plan.dataProtection) {
    if (entry.method === 'skip') continue;
    const commands = entry.commands;
    steps.push({
      name: `protect host data '${entry.hostPath}' with ${entry.method} before update`,
      check: async ({ transport, signal }) =>
        (await protectionPresent(transport, entry, signal))
          ? { status: 'satisfied', detail: { target: entry.target } }
          : { status: 'required', detail: { target: entry.target } },
      apply: async ({ transport, logger, signal }) => {
        for (const argv of commands) {
          const result = await transport.exec(argv, {
            timeoutMs: DATA_PROTECTION_TIMEOUT_MS,
            signal,
            onOutput: (stream, chunk) => {
              void logger.info(`${entry.method} ${stream}: ${chunk}`);
            },
          });
          if (result.exitCode !== 0) {
            throw new PreUpdateBackupError(
              backupFailureMessage(
                label,
                `${entry.method} '${entry.hostPath}'`,
                result,
              ),
            );
          }
        }
        return { method: entry.method, target: entry.target };
      },
      verify: async ({ transport, signal }) => {
        if (!(await protectionPresent(transport, entry, signal))) {
          throw new PreUpdateBackupError(
            `Host data protection for '${entry.hostPath}' was not found at '${entry.target ?? entry.method}' after the backup completed.`,
          );
        }
        return { method: entry.method, target: entry.target };
      },
      rollbackHint: `The host path '${entry.hostPath}' was protected at '${entry.target ?? entry.method}' before the update; restore from there if needed.`,
    });
  }

  return steps;
}
