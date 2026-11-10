/**
 * One-click restore (D-56).
 *
 * `pct restore` / `qmrestore` only bring back the guest rootfs. Bind-mounted
 * host data (`mp0`) is not part of a `vzdump` archive, so a restore plan states
 * that mismatch explicitly and can restore matching host data from the backup
 * that the pre-update steps created. Current host data is displaced to a
 * timestamped path before anything is overwritten. Destructive plans require
 * the typed confirmation `RESTORE <vmid>`.
 */

import { posix } from 'node:path';
import { parseRawProxmoxConfig } from '../codec/raw.js';
import type { GuestDeployment } from '../schema/deployment.js';
import {
  assessGuestIdentity,
  type GuestIdentityAssessment,
  type LiveGuestIdentity,
} from '../guest/identity.js';
import { createMutationPlan } from '../plans/plan.js';
import type { MutationPlan, PlanChange } from '../plans/types.js';
import type { JournaledStep } from '../steps/types.js';
import {
  inspectStorageInvariants,
  type StorageInvariantOptions,
  type StorageInvariantReport,
} from '../storage/invariants.js';
import type { ExecResult, Transport } from '../transport/types.js';
import {
  backupSlug,
  DEFAULT_HOST_DATA_BACKUP_ROOT,
  formatBackupTimestamp,
} from './pre-update.js';

export const RESTORE_CONFIG_TIMEOUT_MS = 15_000;
export const RESTORE_LIST_TIMEOUT_MS = 30_000;
export const RESTORE_COMMAND_TIMEOUT_MS = 3_600_000;
export const RESTORE_START_TIMEOUT_MS = 300_000;

export type RestoreGuestType = 'lxc' | 'vm';
export type RestoreDataMethod = 'snapshot' | 'restic' | 'rsync';

export interface RestoreGuestTarget {
  readonly hostId: string;
  readonly vmid: number;
  readonly type: RestoreGuestType;
  readonly name: string;
  /** Live existence; defaults to true. */
  readonly exists?: boolean | undefined;
  /** Live status, for example `running` or `stopped`. */
  readonly status?: string | undefined;
  /** Proxmox protection flag. */
  readonly protection?: boolean | undefined;
  readonly mounts?:
    | readonly {
        readonly index?: number | undefined;
        readonly host_path: string;
        readonly guest_path: string;
        readonly backup?: boolean | undefined;
      }[]
    | undefined;
  readonly backup_storage?: string | undefined;
}

export interface RestoreBackupInfo {
  readonly volid: string;
  readonly storage: string;
  readonly type: RestoreGuestType;
  readonly vmid: number;
  /** ISO timestamp parsed from the vzdump file name. */
  readonly createdAt: string;
  readonly format?: string | undefined;
  readonly size?: string | undefined;
}

export interface RestoreBackupRef {
  readonly volid: string;
  /** Target storage for the restored rootfs; defaults to Proxmox' choice. */
  readonly storage?: string | undefined;
}

export interface RestoreHostDataEntry {
  readonly hostPath: string;
  readonly method: RestoreDataMethod;
  /** Pre-update protection target: a ZFS snapshot, BTRFS snapshot or copy. */
  readonly target: string;
  /** Backing file system, used to derive the ZFS snapshot path. */
  readonly filesystem?: string | undefined;
  readonly restic?:
    | {
        readonly repository: string;
        readonly passwordFile?: string | undefined;
      }
    | undefined;
  readonly resticTag?: string | undefined;
}

export interface RestoreHostDataPlan {
  readonly hostPath: string;
  readonly method: RestoreDataMethod;
  readonly source: string;
  readonly target: string;
  /** Where current host data is moved before the restore copy starts. */
  readonly displacedPath: string;
  /** Written only after the restore copy succeeds; used for resumability. */
  readonly markerPath: string;
  readonly stagingPath?: string | undefined;
  readonly restoreCommands: readonly (readonly string[])[];
  /** Human-readable command list, also used by the plan view. */
  readonly commands: readonly (readonly string[])[];
}

export interface RestoreOptions {
  /** Target storage for the restored disks. */
  readonly storage?: string | undefined;
  /** Allow restoring over an existing guest by stopping and destroying it. */
  readonly overwrite?: boolean | undefined;
  /** Explicitly lift Proxmox protection before an overwrite restore. */
  readonly unprotect?: boolean | undefined;
  /** Matching host data to restore after the guest rootfs. */
  readonly hostData?: readonly RestoreHostDataEntry[] | undefined;
  /** Root for displacement copies and restore markers. */
  readonly backupRoot?: string | undefined;
  /** Injected clock for deterministic displacement paths. */
  readonly now?: Date | undefined;
}

export interface RestorePlan {
  readonly summary: string;
  readonly target: {
    readonly hostId: string;
    readonly vmid: number;
    readonly type: RestoreGuestType;
    readonly name: string;
    readonly exists: boolean;
    readonly status?: string | undefined;
    readonly protection: boolean;
  };
  readonly backup: RestoreBackupInfo;
  readonly restoreArgv: readonly string[];
  readonly requiredConfirmation: string;
  readonly changes: readonly PlanChange[];
  readonly warnings: readonly string[];
  readonly commands: readonly (readonly string[])[];
  readonly hostData: readonly RestoreHostDataPlan[];
  readonly destructive: true;
  readonly blocked: boolean;
  readonly blockReason?: string | undefined;
}

export interface CreateRestoreMutationPlanInput {
  readonly plan: RestorePlan;
  readonly planId: string;
  readonly confirmationText: string;
  readonly createdAt?: Date | undefined;
}

export interface RestoreStepOptions {
  /** Full deployment, required for the post-restore storage invariant check. */
  readonly deployment?: GuestDeployment | undefined;
  readonly invariantOptions?:
    Omit<StorageInvariantOptions, 'hostId'> | undefined;
}

export class RestoreError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}

const VZDUMP_VOLUME_PATTERN =
  /vzdump-(lxc|qemu)-(\d+)-(\d{4})_(\d{2})_(\d{2})-(\d{2})_(\d{2})_(\d{2})/;

function guestTool(type: RestoreGuestType): 'pct' | 'qm' {
  return type === 'lxc' ? 'pct' : 'qm';
}

export function guestConfigPath(type: RestoreGuestType, vmid: number): string {
  return type === 'lxc'
    ? `/etc/pve/local/lxc/${vmid}.conf`
    : `/etc/pve/local/qemu-server/${vmid}.conf`;
}

function assertTarget(target: RestoreGuestTarget): void {
  if (!target.hostId.trim()) {
    throw new RestoreError('hostId must not be empty.');
  }
  if (!Number.isSafeInteger(target.vmid) || target.vmid < 1) {
    throw new RestoreError(
      `VMID '${String(target.vmid)}' is not a positive integer.`,
    );
  }
  if (!target.name.trim()) {
    throw new RestoreError('Guest name must not be empty.');
  }
  if (target.type !== 'lxc' && target.type !== 'vm') {
    throw new RestoreError(
      `Guest type must be 'lxc' or 'vm', received '${String(target.type)}'.`,
    );
  }
}

/** Parse a `vzdump` volume ID such as `store:backup/vzdump-lxc-112-...tar.zst`. */
export function parseVzdumpVolume(
  volid: string,
): RestoreBackupInfo | undefined {
  const colon = volid.indexOf(':');
  if (colon <= 0) return undefined;
  const storage = volid.slice(0, colon).trim();
  const match = VZDUMP_VOLUME_PATTERN.exec(volid.slice(colon + 1));
  if (!storage || !match) return undefined;
  const [, typeText, vmidText, year, month, day, hour, minute, second] = match;
  const createdAt = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  );
  return {
    volid,
    storage,
    type: typeText === 'lxc' ? 'lxc' : 'vm',
    vmid: Number(vmidText),
    createdAt: createdAt.toISOString(),
  };
}

/** Parse `pvesm list <storage>` output and keep valid vzdump volumes. */
export function parsePvesmList(stdout: string): readonly RestoreBackupInfo[] {
  const entries: RestoreBackupInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^volid\b/i.test(trimmed)) continue;
    const tokens = trimmed.split(/\s+/);
    const volid = tokens[0]!;
    const info = parseVzdumpVolume(volid);
    if (!info) continue;
    const last = tokens.at(-1) ?? '';
    const vmidColumn = /^\d+$/.test(last) ? Number(last) : undefined;
    if (vmidColumn !== undefined && vmidColumn !== info.vmid) continue;
    const format = tokens[1];
    const sizeTokens =
      vmidColumn !== undefined ? tokens.slice(3, -1) : tokens.slice(3);
    entries.push({
      ...info,
      ...(format !== undefined ? { format } : {}),
      ...(sizeTokens.length > 0 ? { size: sizeTokens.join(' ') } : {}),
    });
  }
  return entries;
}

/**
 * List restorable backups for one guest from its backup storage, newest first.
 */
export async function listGuestBackups(
  transport: Transport,
  target: Pick<RestoreGuestTarget, 'vmid' | 'type' | 'backup_storage'>,
  options: { readonly storage?: string | undefined } = {},
): Promise<readonly RestoreBackupInfo[]> {
  const storage = options.storage ?? target.backup_storage;
  if (!storage || storage.trim().length === 0) {
    throw new RestoreError(
      'A backup storage is required to list restorable backups.',
    );
  }
  const result = await transport.exec(['pvesm', 'list', storage], {
    timeoutMs: RESTORE_LIST_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new RestoreError(
      `Could not list backups on storage '${storage}': ${
        result.stderr.trim() || `exit code ${result.exitCode}`
      }`,
    );
  }
  return parsePvesmList(result.stdout)
    .filter((entry) => entry.vmid === target.vmid && entry.type === target.type)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function validateBackup(
  target: RestoreGuestTarget,
  backup: RestoreBackupRef,
): RestoreBackupInfo {
  const info = parseVzdumpVolume(backup.volid);
  if (!info) {
    throw new RestoreError(
      `'${backup.volid}' is not a vzdump backup volume ID.`,
    );
  }
  if (info.type !== target.type) {
    throw new RestoreError(
      `Backup '${backup.volid}' is a ${info.type.toUpperCase()} archive, but guest ${target.vmid} is a ${target.type.toUpperCase()}.`,
    );
  }
  if (info.vmid !== target.vmid) {
    throw new RestoreError(
      `Backup '${backup.volid}' belongs to VMID ${info.vmid}, not ${target.vmid}.`,
    );
  }
  return info;
}

/** `pct restore <vmid> <volid>` / `qmrestore <volid> <vmid>`. */
export function guestRestoreArgv(
  target: RestoreGuestTarget,
  backup: RestoreBackupRef,
  options: Pick<RestoreOptions, 'storage'> = {},
): readonly string[] {
  assertTarget(target);
  validateBackup(target, backup);
  const argv =
    target.type === 'lxc'
      ? ['pct', 'restore', String(target.vmid), backup.volid]
      : ['qmrestore', backup.volid, String(target.vmid)];
  if (options.storage !== undefined && options.storage.trim().length > 0) {
    argv.push('--storage', options.storage.trim());
  }
  return argv;
}

export function guestStopArgv(target: RestoreGuestTarget): readonly string[] {
  return [guestTool(target.type), 'stop', String(target.vmid)];
}

export function guestStartArgv(target: RestoreGuestTarget): readonly string[] {
  return [guestTool(target.type), 'start', String(target.vmid)];
}

export function guestDestroyArgv(
  target: RestoreGuestTarget,
): readonly string[] {
  const argv = [
    guestTool(target.type),
    'destroy',
    String(target.vmid),
    '--purge',
    '1',
  ];
  if (target.type === 'vm') {
    argv.push('--destroy-unreferenced-disks', '1');
  }
  return argv;
}

export function guestStatusArgv(target: RestoreGuestTarget): readonly string[] {
  return [guestTool(target.type), 'status', String(target.vmid)];
}

export function guestConfigArgv(target: RestoreGuestTarget): readonly string[] {
  return [guestTool(target.type), 'config', String(target.vmid)];
}

function isZfsSnapshot(entry: RestoreHostDataEntry): boolean {
  const filesystem = (entry.filesystem ?? '').toLowerCase();
  if (filesystem === 'zfs' || filesystem === 'zfspool') return true;
  if (filesystem === 'btrfs') return false;
  return entry.method === 'snapshot' && entry.target.includes('@');
}

/** Resolve the directory a snapshot or copy can be read from. */
export function hostDataRestoreSource(entry: RestoreHostDataEntry): string {
  if (entry.method !== 'snapshot') return entry.target;
  if (!isZfsSnapshot(entry)) return entry.target;
  const at = entry.target.lastIndexOf('@');
  if (at <= 0) {
    throw new RestoreError(
      `ZFS snapshot '${entry.target}' has no '@snapshot' suffix.`,
    );
  }
  const dataset = entry.target.slice(0, at).replace(/^\/+/, '');
  const snapshot = entry.target.slice(at + 1);
  return `/${dataset}/.zfs/snapshot/${snapshot}`;
}

export interface HostDataRestorePlanOptions {
  readonly backupRoot?: string | undefined;
  readonly now?: Date | undefined;
  readonly index?: number | undefined;
}

/** Build the displace-then-copy plan for one host path. */
export function planHostDataRestore(
  entry: RestoreHostDataEntry,
  options: HostDataRestorePlanOptions = {},
): RestoreHostDataPlan {
  if (!entry.hostPath.startsWith('/')) {
    throw new RestoreError(`Host path '${entry.hostPath}' must be absolute.`);
  }
  const backupRoot = options.backupRoot ?? DEFAULT_HOST_DATA_BACKUP_ROOT;
  const timestamp = formatBackupTimestamp(options.now ?? new Date());
  const suffix =
    options.index !== undefined && options.index > 0 ? `-${options.index}` : '';
  const slug = backupSlug(entry.hostPath);
  const displacedPath = posix.join(
    backupRoot,
    `${slug}-before-restore-${timestamp}${suffix}`,
  );
  const markerPath = posix.join(
    backupRoot,
    `.restore-${slug}-${timestamp}${suffix}.done`,
  );
  const source = hostDataRestoreSource(entry);
  const prepare: (readonly string[])[] = [
    ['mkdir', '-p', backupRoot],
    ['mv', entry.hostPath, displacedPath],
    ['mkdir', '-p', entry.hostPath],
  ];

  let restoreCommands: (readonly string[])[];
  let stagingPath: string | undefined;
  if (entry.method === 'restic') {
    if (!entry.restic || !entry.restic.repository.trim()) {
      throw new RestoreError(
        `Restoring host data '${entry.hostPath}' from restic requires a repository.`,
      );
    }
    stagingPath = posix.join(
      backupRoot,
      `restore-${slug}-${timestamp}${suffix}`,
    );
    const base = ['restic', '-r', entry.restic.repository];
    if (entry.restic.passwordFile !== undefined) {
      base.push('--password-file', entry.restic.passwordFile);
    }
    const restore = [...base, 'restore', 'latest'];
    if (entry.resticTag !== undefined && entry.resticTag.trim().length > 0) {
      restore.push('--tag', entry.resticTag.trim());
    }
    restore.push('--target', stagingPath);
    restoreCommands = [
      ['mkdir', '-p', stagingPath],
      restore,
      [
        'rsync',
        '-aAXH',
        '--numeric-ids',
        `${stagingPath}${entry.hostPath}/`,
        `${entry.hostPath}/`,
      ],
    ];
  } else {
    restoreCommands = [
      ['rsync', '-aAXH', '--numeric-ids', `${source}/`, `${entry.hostPath}/`],
    ];
  }

  const commands: (readonly string[])[] = [
    ...prepare,
    ...restoreCommands,
    ['touch', markerPath],
  ];

  return {
    hostPath: entry.hostPath,
    method: entry.method,
    source,
    target: entry.target,
    displacedPath,
    markerPath,
    ...(stagingPath !== undefined ? { stagingPath } : {}),
    restoreCommands,
    commands,
  };
}

function mountWarnings(
  target: RestoreGuestTarget,
  hostData: readonly RestoreHostDataPlan[],
  backup: RestoreBackupInfo,
): readonly string[] {
  const warnings: string[] = [];
  const mounts = target.mounts ?? [];
  if (mounts.length === 0) return warnings;

  if (target.type === 'vm') {
    warnings.push(
      'VMs have no bind-mounted host data; mounts were ignored for this restore.',
    );
    return warnings;
  }

  warnings.push(
    `vzdump archive '${backup.volid}' contains the rootfs only; bind-mounted host data is not included.`,
  );
  const restored = new Set(hostData.map((entry) => entry.hostPath));
  for (const mount of mounts) {
    if (mount.backup === false) {
      warnings.push(
        `Host data '${mount.host_path}' was excluded from backups and is not restored.`,
      );
      continue;
    }
    if (!restored.has(mount.host_path)) {
      warnings.push(
        `Host data '${mount.host_path}' (mp${mount.index ?? 0} at '${mount.guest_path}') is not covered by this restore. The restored rootfs may still contain an older copy at that guest path, and mp0 will shadow it once the guest starts.`,
      );
    }
  }
  return warnings;
}

/**
 * Pure restore plan. It never runs a command; `createGuestRestoreSteps` runs
 * exactly the commands listed here. An existing guest blocks the plan unless
 * the caller opts in to stopping and destroying it first.
 */
export function planGuestRestore(
  target: RestoreGuestTarget,
  backup: RestoreBackupRef,
  options: RestoreOptions = {},
): RestorePlan {
  assertTarget(target);
  const info = validateBackup(target, backup);
  const exists = target.exists ?? true;
  const protection = target.protection ?? false;
  const status = target.status;
  const hostData = (options.hostData ?? []).map((entry, index) =>
    planHostDataRestore(entry, {
      ...(options.backupRoot !== undefined
        ? { backupRoot: options.backupRoot }
        : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      index,
    }),
  );

  const warnings: string[] = [...mountWarnings(target, hostData, info)];
  const restored = new Set(hostData.map((entry) => entry.hostPath));
  for (const entry of options.hostData ?? []) {
    const declared = (target.mounts ?? []).some(
      (mount) => mount.host_path === entry.hostPath,
    );
    if (!declared && target.type === 'lxc') {
      warnings.push(
        `Host data '${entry.hostPath}' is not declared as a mount on guest ${target.vmid}; it is restored anyway because it was requested explicitly.`,
      );
    }
  }
  if (restored.size > 0) {
    warnings.push(
      'Current host data is moved to a timestamped path before it is replaced; it is not deleted.',
    );
  }

  const summary = `Restore ${target.type.toUpperCase()} ${target.vmid} (${target.name}) from ${backup.volid} on ${target.hostId}`;
  const requiredConfirmation = `RESTORE ${target.vmid}`;
  const restoreArgv = guestRestoreArgv(target, backup, {
    ...(options.storage !== undefined ? { storage: options.storage } : {}),
  });
  const planTarget = {
    hostId: target.hostId,
    vmid: target.vmid,
    type: target.type,
    name: target.name,
    exists,
    ...(status !== undefined ? { status } : {}),
    protection,
  } as const;

  const blockedWarnings = [...warnings];
  let blockReason: string | undefined;
  if (exists && options.overwrite !== true) {
    blockReason = `Guest ${target.vmid} already exists. Enable overwrite to stop and destroy it before restoring.`;
  } else if (exists && protection && options.unprotect !== true) {
    blockReason = `Guest ${target.vmid} has Proxmox protection enabled. Choose an explicit unprotect action to restore over it.`;
  }
  if (blockReason !== undefined) {
    if (exists && options.overwrite !== true) {
      blockedWarnings.push(
        'The existing guest is left untouched until overwrite is enabled.',
      );
    }
    if (protection) {
      blockedWarnings.push('Protection blocks destructive changes (D-56).');
    }
    return {
      summary,
      target: planTarget,
      backup: info,
      restoreArgv,
      requiredConfirmation,
      changes: [],
      warnings: blockedWarnings,
      commands: [],
      hostData,
      destructive: true,
      blocked: true,
      blockReason,
    };
  }

  const changes: PlanChange[] = [];
  const commands: (readonly string[])[] = [];

  if (exists && status === 'running') {
    warnings.push('The guest is stopped before it is restored.');
    changes.push({
      id: 'stop',
      action: 'update',
      summary: `Stop ${target.type.toUpperCase()} ${target.vmid} before restoring it`,
      before: 'running',
      after: 'stopped',
    });
    commands.push(guestStopArgv(target));
  }

  if (exists) {
    warnings.push(
      'The existing guest and its disks are destroyed before the restore; this cannot be undone.',
    );
    changes.push({
      id: 'destroy',
      action: 'delete',
      summary: `Destroy ${target.type.toUpperCase()} ${target.vmid} (${target.name}) before the restore`,
      before: {
        vmid: target.vmid,
        name: target.name,
        status: status ?? 'unknown',
      },
      after: null,
      destructive: true,
    });
    commands.push(guestDestroyArgv(target));
  }

  changes.push({
    id: 'restore',
    action: 'execute',
    summary: `Restore ${target.type.toUpperCase()} ${target.vmid} from ${backup.volid}`,
    before: null,
    after: {
      volid: backup.volid,
      ...(options.storage !== undefined ? { storage: options.storage } : {}),
    },
    destructive: true,
  });
  commands.push(restoreArgv);

  for (const [index, entry] of hostData.entries()) {
    changes.push({
      id: `restore-host-data-${index}`,
      action: 'update',
      summary: `Restore host data '${entry.hostPath}' from ${entry.method}`,
      path: entry.hostPath,
      before: { path: entry.hostPath, displacedTo: entry.displacedPath },
      after: { source: entry.source },
      destructive: true,
    });
    commands.push(...entry.commands);
  }

  warnings.push('The restored guest is started and then identity-checked.');
  changes.push({
    id: 'start',
    action: 'update',
    summary: `Start ${target.type.toUpperCase()} ${target.vmid} after the restore`,
    before: 'stopped',
    after: 'running',
  });
  commands.push(guestStartArgv(target));

  return {
    summary,
    target: planTarget,
    backup: info,
    restoreArgv,
    requiredConfirmation,
    changes,
    warnings,
    commands,
    hostData,
    destructive: true,
    blocked: false,
  };
}

function assertNotBlocked(plan: RestorePlan): void {
  if (plan.blocked) {
    throw new RestoreError(plan.blockReason ?? 'The restore plan is blocked.');
  }
}

/** Wrap a restore plan in a mutation plan that enforces `RESTORE <vmid>`. */
export function createRestoreMutationPlan(
  input: CreateRestoreMutationPlanInput,
): MutationPlan {
  assertNotBlocked(input.plan);
  const expected = input.plan.requiredConfirmation;
  if (input.confirmationText.trim() !== expected) {
    throw new RestoreError(`Typed confirmation must be exactly '${expected}'.`);
  }
  return createMutationPlan({
    id: input.planId,
    operation: 'restore',
    target: {
      hostId: input.plan.target.hostId,
      vmid: input.plan.target.vmid,
      resourceType: 'guest',
    },
    summary: input.plan.summary,
    changes: input.plan.changes,
    warnings: input.plan.warnings,
    currentState: {
      target: input.plan.target,
      backup: input.plan.backup,
      hostData: input.plan.hostData.map((entry) => ({
        hostPath: entry.hostPath,
        method: entry.method,
        target: entry.target,
      })),
    },
    confirmationText: input.confirmationText,
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
  });
}

async function runCommand(
  transport: Transport,
  argv: readonly string[],
  signal: AbortSignal,
  timeoutMs = RESTORE_COMMAND_TIMEOUT_MS,
): Promise<ExecResult> {
  return transport.exec(argv, { timeoutMs, signal });
}

function commandFailure(what: string, result: ExecResult): RestoreError {
  return new RestoreError(
    `${what} failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`,
  );
}

function parseStatus(stdout: string): string | undefined {
  const match = /^status:\s*(\S+)/m.exec(stdout);
  return match?.[1];
}

async function guestIsRunning(
  transport: Transport,
  target: RestoreGuestTarget,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await runCommand(
    transport,
    guestStatusArgv(target),
    signal,
    RESTORE_CONFIG_TIMEOUT_MS,
  );
  return result.exitCode === 0 && parseStatus(result.stdout) === 'running';
}

async function guestConfigExists(
  transport: Transport,
  target: RestoreGuestTarget,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await runCommand(
    transport,
    ['test', '-f', guestConfigPath(target.type, target.vmid)],
    signal,
    RESTORE_CONFIG_TIMEOUT_MS,
  );
  return result.exitCode === 0;
}

/** Read the restored guest config and assess its managed identity (D-38). */
export async function verifyRestoredIdentity(
  transport: Transport,
  target: RestoreGuestTarget,
  signal: AbortSignal = new AbortController().signal,
): Promise<GuestIdentityAssessment> {
  const result = await runCommand(
    transport,
    guestConfigArgv(target),
    signal,
    RESTORE_CONFIG_TIMEOUT_MS,
  );
  if (result.exitCode !== 0) {
    throw new RestoreError(
      `Failed to read the configuration of restored ${target.type.toUpperCase()} ${target.vmid}: ${
        result.stderr.trim() || `exit code ${result.exitCode}`
      }`,
    );
  }
  const main = parseRawProxmoxConfig(result.stdout).main;
  const name = target.type === 'lxc' ? main['hostname'] : main['name'];
  if (!name || name.trim().length === 0) {
    throw new RestoreError(
      `Restored ${target.type.toUpperCase()} ${target.vmid} has no name in its configuration.`,
    );
  }
  const tags = (main['tags'] ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  const live: LiveGuestIdentity = {
    exists: true,
    vmid: target.vmid,
    name,
    type: target.type,
    tags,
    ...(main['description'] !== undefined
      ? { description: main['description'] }
      : {}),
  };
  return assessGuestIdentity(
    {
      hostId: target.hostId,
      vmid: target.vmid,
      name: target.name,
      type: target.type,
    },
    live,
  );
}

/** Run the post-restore storage invariant check and reject unsafe states. */
export async function verifyRestoredInvariants(
  deployment: GuestDeployment,
  transport: Transport,
  options: Omit<StorageInvariantOptions, 'hostId'> & {
    readonly hostId?: string | undefined;
  },
): Promise<StorageInvariantReport> {
  if (deployment.type !== 'lxc' || (deployment.mounts ?? []).length === 0) {
    throw new RestoreError(
      `Storage invariants only apply to LXC guests with declared host data; guest ${deployment.id} is a ${deployment.type}.`,
    );
  }
  if (!options.hostId || options.hostId.trim().length === 0) {
    throw new RestoreError('A hostId is required for the invariant check.');
  }
  const report = await inspectStorageInvariants(
    deployment,
    transport,
    options as StorageInvariantOptions,
  );
  if (report.status !== 'ok') {
    throw new RestoreError(
      `Post-restore storage check failed for ${deployment.name}: ${report.message}${
        report.warnings.length > 0 ? ` ${report.warnings.join(' ')}` : ''
      }`,
    );
  }
  return report;
}

async function applyHostDataRestore(
  transport: Transport,
  plan: RestoreHostDataPlan,
  signal: AbortSignal,
): Promise<unknown> {
  const backupRoot = posix.dirname(plan.markerPath);
  const mkdirRoot = await runCommand(
    transport,
    ['mkdir', '-p', backupRoot],
    signal,
  );
  if (mkdirRoot.exitCode !== 0) {
    throw commandFailure(
      `Creating the displacement root '${backupRoot}'`,
      mkdirRoot,
    );
  }
  const exists = await runCommand(
    transport,
    ['test', '-d', plan.hostPath],
    signal,
    RESTORE_CONFIG_TIMEOUT_MS,
  );
  if (exists.exitCode === 0) {
    const moved = await runCommand(
      transport,
      ['mv', plan.hostPath, plan.displacedPath],
      signal,
    );
    if (moved.exitCode !== 0) {
      throw commandFailure(
        `Displacing '${plan.hostPath}' to '${plan.displacedPath}'`,
        moved,
      );
    }
  }
  const mkdirHost = await runCommand(
    transport,
    ['mkdir', '-p', plan.hostPath],
    signal,
  );
  if (mkdirHost.exitCode !== 0) {
    throw commandFailure(`Creating '${plan.hostPath}'`, mkdirHost);
  }

  for (const argv of plan.restoreCommands) {
    const result = await runCommand(transport, argv, signal);
    if (result.exitCode !== 0) {
      throw commandFailure(
        `Restoring host data '${plan.hostPath}' with ${plan.method}`,
        result,
      );
    }
  }

  const touched = await runCommand(
    transport,
    ['touch', plan.markerPath],
    signal,
  );
  if (touched.exitCode !== 0) {
    throw commandFailure(
      `Writing the restore marker '${plan.markerPath}'`,
      touched,
    );
  }
  return {
    hostPath: plan.hostPath,
    method: plan.method,
    displacedPath: plan.displacedPath,
    markerPath: plan.markerPath,
  };
}

/**
 * Journaled restore steps: stop, destroy (when overwriting), restore, restore
 * host data, start, then identity and storage invariant checks.
 */
export function createGuestRestoreSteps(
  plan: RestorePlan,
  options: RestoreStepOptions = {},
): readonly JournaledStep<undefined>[] {
  assertNotBlocked(plan);
  const steps: JournaledStep<undefined>[] = [];
  const { target } = plan;

  if (target.exists) {
    steps.push({
      name: `stop ${target.type.toUpperCase()} ${target.vmid} before restore`,
      check: async ({ transport, signal }) =>
        (await guestIsRunning(transport, target, signal))
          ? { status: 'required', detail: { status: 'running' } }
          : { status: 'satisfied', detail: { status: 'stopped' } },
      apply: async ({ transport, signal }) => {
        const result = await runCommand(
          transport,
          guestStopArgv(target),
          signal,
          RESTORE_START_TIMEOUT_MS,
        );
        if (result.exitCode !== 0) {
          throw commandFailure(
            `Stopping ${target.type.toUpperCase()} ${target.vmid}`,
            result,
          );
        }
        return { stopped: true };
      },
      verify: async ({ transport, signal }) => ({
        running: await guestIsRunning(transport, target, signal),
      }),
      rollbackHint: `Start ${target.type.toUpperCase()} ${target.vmid} again or retry the restore.`,
    });

    steps.push({
      name: `destroy ${target.type.toUpperCase()} ${target.vmid} before restore`,
      check: async ({ transport, signal }) =>
        (await guestConfigExists(transport, target, signal))
          ? { status: 'required', detail: { exists: true } }
          : { status: 'satisfied', detail: { exists: false } },
      apply: async ({ transport, signal }) => {
        const result = await runCommand(
          transport,
          guestDestroyArgv(target),
          signal,
        );
        if (result.exitCode !== 0) {
          throw commandFailure(
            `Destroying ${target.type.toUpperCase()} ${target.vmid}`,
            result,
          );
        }
        return { destroyed: true };
      },
      verify: async ({ transport, signal }) => {
        if (await guestConfigExists(transport, target, signal)) {
          throw new RestoreError(
            `Guest ${target.vmid} still exists after it was destroyed.`,
          );
        }
        return { destroyed: true };
      },
      rollbackHint: `The guest was destroyed before the restore. Use the archive '${plan.backup.volid}' to retry.`,
    });
  }

  steps.push({
    name: `restore ${target.type.toUpperCase()} ${target.vmid} from ${plan.backup.volid}`,
    check: async ({ transport, signal }) =>
      (await guestConfigExists(transport, target, signal))
        ? { status: 'satisfied', detail: { exists: true } }
        : { status: 'required', detail: { exists: false } },
    apply: async ({ transport, logger, signal }) => {
      const result = await runCommand(transport, plan.restoreArgv, signal);
      if (result.exitCode !== 0) {
        throw commandFailure(
          `Restoring ${target.type.toUpperCase()} ${target.vmid}`,
          result,
        );
      }
      await logger.info(
        `Restored ${target.type.toUpperCase()} ${target.vmid} from ${plan.backup.volid}`,
      );
      return { volid: plan.backup.volid };
    },
    verify: async ({ transport, signal }) => {
      if (!(await guestConfigExists(transport, target, signal))) {
        throw new RestoreError(
          `Guest ${target.vmid} has no configuration after the restore.`,
        );
      }
      return { exists: true };
    },
    rollbackHint: `Inspect the restore task for '${plan.backup.volid}'. The archive is unchanged.`,
  });

  for (const entry of plan.hostData) {
    steps.push({
      name: `restore host data '${entry.hostPath}' from ${entry.method}`,
      check: async ({ transport, signal }) =>
        (
          await runCommand(
            transport,
            ['test', '-f', entry.markerPath],
            signal,
            RESTORE_CONFIG_TIMEOUT_MS,
          )
        ).exitCode === 0
          ? { status: 'satisfied', detail: { markerPath: entry.markerPath } }
          : { status: 'required', detail: { markerPath: entry.markerPath } },
      apply: async ({ transport, signal }) =>
        applyHostDataRestore(transport, entry, signal),
      verify: async ({ transport, signal }) => {
        const marker = await runCommand(
          transport,
          ['test', '-f', entry.markerPath],
          signal,
          RESTORE_CONFIG_TIMEOUT_MS,
        );
        const host = await runCommand(
          transport,
          ['test', '-d', entry.hostPath],
          signal,
          RESTORE_CONFIG_TIMEOUT_MS,
        );
        if (marker.exitCode !== 0 || host.exitCode !== 0) {
          throw new RestoreError(
            `Host data '${entry.hostPath}' was not restored to '${entry.hostPath}'. Any previous data was moved to '${entry.displacedPath}'.`,
          );
        }
        return { hostPath: entry.hostPath, markerPath: entry.markerPath };
      },
      rollbackHint: `Previous host data is at '${entry.displacedPath}'. Move it back only after inspecting the failed restore.`,
    });
  }

  steps.push({
    name: `start ${target.type.toUpperCase()} ${target.vmid} after restore`,
    check: async ({ transport, signal }) =>
      (await guestIsRunning(transport, target, signal))
        ? { status: 'satisfied', detail: { status: 'running' } }
        : { status: 'required', detail: { status: 'stopped' } },
    apply: async ({ transport, signal }) => {
      const result = await runCommand(
        transport,
        guestStartArgv(target),
        signal,
        RESTORE_START_TIMEOUT_MS,
      );
      if (result.exitCode !== 0) {
        throw commandFailure(
          `Starting ${target.type.toUpperCase()} ${target.vmid}`,
          result,
        );
      }
      return { started: true };
    },
    verify: async ({ transport, signal }) => {
      if (!(await guestIsRunning(transport, target, signal))) {
        throw new RestoreError(
          `Guest ${target.vmid} is not running after the restore.`,
        );
      }
      return { running: true };
    },
    rollbackHint: `Inspect the guest console and task log; the rootfs came from '${plan.backup.volid}'.`,
  });

  steps.push({
    name: `verify the identity of restored ${target.type.toUpperCase()} ${target.vmid}`,
    check: async () => ({ status: 'required' }),
    apply: async ({ transport, signal }) => {
      const assessment = await verifyRestoredIdentity(
        transport,
        target,
        signal,
      );
      if (!assessment.ok) {
        throw new RestoreError(
          `Post-restore identity check failed: ${assessment.messages.join(' ')}`,
        );
      }
      return assessment;
    },
    verify: async ({ transport, signal }) => {
      const assessment = await verifyRestoredIdentity(
        transport,
        target,
        signal,
      );
      if (!assessment.ok) {
        throw new RestoreError(
          `Post-restore identity check failed: ${assessment.messages.join(' ')}`,
        );
      }
      return assessment;
    },
    rollbackHint: `The restored data does not belong to the YAML workload. Current host data was displaced, not deleted.`,
  });

  const deployment = options.deployment;
  if (
    deployment !== undefined &&
    deployment.type === 'lxc' &&
    (deployment.mounts ?? []).length > 0
  ) {
    const invariantOptions = {
      ...(options.invariantOptions ?? {}),
      hostId: target.hostId,
    } as StorageInvariantOptions;
    steps.push({
      name: `verify storage invariants of restored LXC ${target.vmid}`,
      check: async () => ({ status: 'required' }),
      apply: async ({ transport }) =>
        verifyRestoredInvariants(deployment, transport, invariantOptions),
      verify: async ({ transport }) =>
        verifyRestoredInvariants(deployment, transport, invariantOptions),
      rollbackHint: `Compare '${deployment.mounts?.[0]?.host_path ?? 'the host path'}' with the rootfs before starting application services.`,
    });
  }

  return steps;
}
