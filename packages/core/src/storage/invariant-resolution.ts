import { posix } from 'node:path';
import {
  createHostDirectoryStep,
  type HostDirectoryPlan,
} from './host-dirs.js';
import {
  createLxcAttachMp0Step,
  createLxcDisplaceGuestPathStep,
  createLxcFinalVerifyStep,
  createLxcMigrationSteps,
  createLxcMountStep,
  createLxcStartStep,
  createLxcStopStep,
  createLxcUnmountStep,
  planLxcMigration,
  type LxcMigrationOptions,
  type LxcMigrationPlan,
} from '../provision/lxc-migrate.js';
import type { GuestDeployment } from '../schema/deployment.js';
import type { JournaledStep } from '../steps/types.js';
import type { ExecResult, Transport } from '../transport/types.js';
import {
  storagePlanMatchesReport,
  type StorageInvariantReport,
  type StorageResolution,
} from './invariants.js';

/** Archived copies of the displaced side live below this root (D-47). */
export const DEFAULT_STORAGE_BACKUP_ROOT = '/opt/server-data/.backups';

export interface StorageResolutionOptions {
  /** Deterministic suffix; the job's creation time is used in production. */
  readonly timestamp?: string | undefined;
  readonly backupRoot?: string | undefined;
  /** Take a `vzdump` before the rootfs-to-host migration. Defaults to true. */
  readonly guestBackup?: boolean | undefined;
  readonly backupStorage?: string | undefined;
  readonly rootfsMountPath?: string | undefined;
}

export interface StorageResolutionPlan {
  readonly resolution: StorageResolution;
  readonly status: StorageInvariantReport['status'];
  readonly guestPath: string;
  readonly hostPath: string;
  readonly vmid: number;
  readonly hostId: string;
  readonly timestamp: string;
  readonly rootfsMountPath: string;
  readonly guestOptPath: string;
  readonly hostDisplacedPath: string;
  readonly rootfsDisplacedPath: string;
  readonly hostBackupPath?: string | undefined;
  readonly rootfsBackupPath?: string | undefined;
  readonly hostDirectory: HostDirectoryPlan;
  readonly mp0Value: string;
  readonly changes: readonly string[];
  readonly warnings: readonly string[];
  readonly commands: readonly (readonly string[])[];
  readonly destructive: false;
  readonly migration: LxcMigrationPlan;
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(
      `${label} '${value}' cannot be used in a storage backup path; expected letters, digits, dot, underscore or dash.`,
    );
  }
  return value;
}

function assertAbsolutePath(value: string, label: string): void {
  if (!value.startsWith('/') || posix.normalize(value) !== value) {
    throw new Error(`${label} '${value}' must be a normalized absolute path.`);
  }
}

function defaultTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replaceAll(':', '');
}

export function storageHostDisplacedPath(
  hostPath: string,
  timestamp: string,
): string {
  return `${hostPath}.migrated-${safeSegment(timestamp, 'timestamp')}`;
}

export function storageBackupArgv(
  sourcePath: string,
  backupPath: string,
): readonly string[] {
  return [
    'tar',
    '--xattrs',
    '--acls',
    '--numeric-owner',
    '-cpzf',
    backupPath,
    '-C',
    sourcePath,
    '.',
  ];
}

export function storageHostDisplaceArgv(
  hostPath: string,
  displacedPath: string,
): readonly string[] {
  return ['mv', hostPath, displacedPath];
}

export function storageBackupPath(
  backupRoot: string,
  hostId: string,
  vmid: number,
  timestamp: string,
  side: 'host' | 'rootfs',
): string {
  assertAbsolutePath(backupRoot, 'backupRoot');
  return posix.join(
    backupRoot,
    safeSegment(hostId, 'hostId'),
    String(vmid),
    `${safeSegment(timestamp, 'timestamp')}-${side}-data.tar.gz`,
  );
}

/**
 * Pure plan for a D-47 resolution. The losing side is always archived and
 * renamed, never deleted; both paths are surfaced to the job log and prompt.
 */
export function planStorageResolution(
  guest: GuestDeployment,
  report: StorageInvariantReport,
  resolution: StorageResolution,
  options: StorageResolutionOptions = {},
): StorageResolutionPlan {
  if (guest.type !== 'lxc') {
    throw new Error('Storage resolution only applies to LXC guests.');
  }
  if (!report.requiresResolution) {
    throw new Error(
      `Storage invariant status '${report.status}' does not require a resolution.`,
    );
  }
  if (!report.resolutionOptions.includes(resolution)) {
    throw new Error(
      `Resolution '${resolution}' is not available for status '${report.status}'.`,
    );
  }
  const timestamp = safeSegment(
    options.timestamp ?? defaultTimestamp(),
    'timestamp',
  );
  const backupRoot = options.backupRoot ?? DEFAULT_STORAGE_BACKUP_ROOT;
  const migrationOptions: LxcMigrationOptions = {
    hostId: report.hostId,
    guestPath: report.guestPath,
    timestamp,
    backup:
      resolution === 'migrate-rootfs-to-host'
        ? (options.guestBackup ?? true)
        : false,
    ...(options.backupStorage !== undefined
      ? { backupStorage: options.backupStorage }
      : {}),
    ...(options.rootfsMountPath !== undefined
      ? { rootfsMountPath: options.rootfsMountPath }
      : {}),
  };
  const migration = planLxcMigration(guest, migrationOptions);
  if (!storagePlanMatchesReport(migration, report)) {
    throw new Error(
      `The deployment paths changed since the invariant check (expected ${report.guestPath} -> ${report.hostPath}, planned ${migration.guestPath} -> ${migration.hostPath}). Re-run the check.`,
    );
  }

  const hostDisplacedPath = storageHostDisplacedPath(
    report.hostPath,
    timestamp,
  );
  const rootfsDisplacedPath = migration.displacedPath;
  const hostBackupPath =
    resolution === 'migrate-rootfs-to-host'
      ? storageBackupPath(
          backupRoot,
          report.hostId,
          report.vmid,
          timestamp,
          'host',
        )
      : undefined;
  const rootfsBackupPath =
    resolution === 'keep-host-data'
      ? storageBackupPath(
          backupRoot,
          report.hostId,
          report.vmid,
          timestamp,
          'rootfs',
        )
      : undefined;

  const changes: string[] = [];
  const commands: (readonly string[])[] = [];
  const warnings: string[] = [];

  if (resolution === 'keep-host-data') {
    changes.push(
      `Stop LXC ${report.vmid} before mounting its rootfs`,
      `Archive the rootfs copy of ${report.guestPath} to ${rootfsBackupPath}`,
      `Rename ${report.guestPath} to ${posix.basename(rootfsDisplacedPath)} inside the rootfs`,
      `Attach mp0 ${report.mp0Value ?? migration.mp0Value} at ${report.guestPath}`,
      `Start LXC ${report.vmid} with the host data`,
    );
    commands.push(
      ['pct', 'mount', String(report.vmid)],
      storageBackupArgv(migration.guestOptPath, rootfsBackupPath!),
      ['mv', migration.guestOptPath, rootfsDisplacedPath],
      ['pct', 'unmount', String(report.vmid)],
      ['pct', 'set', String(report.vmid), '--mp0', migration.mp0Value],
      ['pct', 'start', String(report.vmid)],
    );
    warnings.push(
      `The rootfs copy is archived at ${rootfsBackupPath} and renamed to ${rootfsDisplacedPath}; it is never deleted automatically.`,
    );
  } else {
    changes.push(
      `Stop LXC ${report.vmid} before touching the host data`,
      `Archive the host data at ${report.hostPath} to ${hostBackupPath}`,
      `Rename ${report.hostPath} to ${hostDisplacedPath}`,
      `Copy the rootfs ${report.guestPath} into ${report.hostPath}`,
      `Attach mp0 and start LXC ${report.vmid}`,
    );
    commands.push(
      storageBackupArgv(report.hostPath, hostBackupPath!),
      storageHostDisplaceArgv(report.hostPath, hostDisplacedPath),
      ...migration.commands,
    );
    warnings.push(
      `The previous host data is archived at ${hostBackupPath} and renamed to ${hostDisplacedPath}; it is never deleted automatically.`,
      'vzdump does not include bind-mounted host data; the host archive above is the backup for this side.',
    );
    if (!migration.backup) {
      warnings.push('No vzdump snapshot was taken before the migration.');
    }
  }

  if (guest.protection) {
    warnings.push(
      'The guest protection flag is set. A storage resolution still stops and reconfigures the guest; review the plan before applying.',
    );
  }

  return {
    resolution,
    status: report.status,
    guestPath: report.guestPath,
    hostPath: report.hostPath,
    vmid: report.vmid,
    hostId: report.hostId,
    timestamp,
    rootfsMountPath: migration.rootfsMountPath,
    guestOptPath: migration.guestOptPath,
    hostDisplacedPath,
    rootfsDisplacedPath,
    ...(hostBackupPath !== undefined ? { hostBackupPath } : {}),
    ...(rootfsBackupPath !== undefined ? { rootfsBackupPath } : {}),
    hostDirectory: migration.hostDirectory,
    mp0Value: migration.mp0Value,
    changes,
    warnings,
    commands,
    destructive: false,
    migration,
  };
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

async function backupExists(
  transport: Transport,
  path: string,
): Promise<boolean> {
  const result = await transport.exec(['test', '-s', path], {
    timeoutMs: 5_000,
  });
  return result.exitCode === 0;
}

function archiveFailure(
  sourcePath: string,
  backupPath: string,
  result: ExecResult,
): Error {
  return new Error(
    `Failed to archive '${sourcePath}' to '${backupPath}': ${
      result.stderr.trim() || `exit code ${result.exitCode}`
    }. Nothing was displaced.`,
  );
}

/** Archive a path with ownership, ACLs and xattrs before it is displaced. */
export function createStorageArchiveStep(options: {
  readonly name: string;
  readonly sourcePath: string;
  readonly backupPath: string;
}): JournaledStep<undefined> {
  const directory = posix.dirname(options.backupPath);
  const tarArgv = storageBackupArgv(options.sourcePath, options.backupPath);
  const skipped = { skipped: true, reason: 'source-missing' } as const;
  return {
    name: options.name,
    check: async ({ transport }) => {
      if (await backupExists(transport, options.backupPath)) {
        return {
          status: 'satisfied',
          detail: { backupPath: options.backupPath },
        };
      }
      if (!(await pathExists(transport, options.sourcePath))) {
        return { status: 'satisfied', detail: skipped };
      }
      return { status: 'required', detail: { sourcePath: options.sourcePath } };
    },
    apply: async ({ transport, logger }) => {
      if (await backupExists(transport, options.backupPath)) {
        return { backupPath: options.backupPath };
      }
      if (!(await pathExists(transport, options.sourcePath))) return skipped;
      const install = await transport.exec(
        ['install', '-d', '-m', '0700', directory],
        { timeoutMs: 30_000 },
      );
      if (install.exitCode !== 0) {
        throw archiveFailure(options.sourcePath, options.backupPath, install);
      }
      const result = await transport.exec(tarArgv, {
        timeoutMs: 3_600_000,
        onOutput: (stream, line) => {
          void logger.info(`archive ${stream}: ${line}`);
        },
      });
      if (result.exitCode !== 0) {
        throw archiveFailure(options.sourcePath, options.backupPath, result);
      }
      return { backupPath: options.backupPath };
    },
    verify: async ({ transport }) => {
      if (!(await pathExists(transport, options.sourcePath))) {
        return skipped;
      }
      if (!(await backupExists(transport, options.backupPath))) {
        throw new Error(
          `Backup '${options.backupPath}' is missing or empty after archiving '${options.sourcePath}'.`,
        );
      }
      return { backupPath: options.backupPath };
    },
    rollbackHint: `Inspect '${options.backupPath}' and '${options.sourcePath}'. Nothing is deleted automatically.`,
  };
}

/** Rename the old host directory out of the way before a fresh migration. */
export function createHostDataDisplaceStep(
  hostPath: string,
  displacedPath: string,
): JournaledStep<undefined> {
  const argv = storageHostDisplaceArgv(hostPath, displacedPath);
  return {
    name: `displace host data ${hostPath} without deleting it`,
    check: async ({ transport }) => {
      const source = await pathExists(transport, hostPath);
      const displaced = await pathExists(transport, displacedPath);
      if (!source && displaced) {
        return { status: 'satisfied', detail: { displaced: displacedPath } };
      }
      if (source && displaced) {
        throw new Error(
          `Refusing to overwrite '${displacedPath}': it already exists. Re-run with a new timestamp.`,
        );
      }
      if (!source) {
        return { status: 'satisfied', detail: { missing: true } };
      }
      return { status: 'required', detail: { source: hostPath } };
    },
    apply: async ({ transport }) => {
      const source = await pathExists(transport, hostPath);
      const displaced = await pathExists(transport, displacedPath);
      if (!source && displaced) return { changed: false };
      if (!source) return { changed: false, missing: true };
      if (displaced) {
        throw new Error(
          `Refusing to overwrite '${displacedPath}': it already exists.`,
        );
      }
      const result = await transport.exec(argv, { timeoutMs: 120_000 });
      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to displace '${hostPath}' to '${displacedPath}': ${
            result.stderr.trim() || `exit code ${result.exitCode}`
          }.`,
        );
      }
      return { displaced: displacedPath };
    },
    verify: async ({ transport }) => {
      const source = await pathExists(transport, hostPath);
      const displaced = await pathExists(transport, displacedPath);
      if (!source && !displaced) return { skipped: true };
      if (source || !displaced) {
        throw new Error(
          `Host data was not displaced correctly: expected '${hostPath}' to be gone and '${displacedPath}' to exist.`,
        );
      }
      return { displaced: displacedPath };
    },
    rollbackHint: `Rename '${displacedPath}' back to '${hostPath}' to undo the displacement.`,
  };
}

/**
 * Journaled D-47 resolution. The losing side is archived first, then displaced
 * by rename. A failure leaves the original data or the archive in place.
 */
export function createStorageResolutionSteps(
  guest: GuestDeployment,
  report: StorageInvariantReport,
  resolution: StorageResolution,
  options: StorageResolutionOptions = {},
): readonly JournaledStep<undefined>[] {
  const plan = planStorageResolution(guest, report, resolution, options);

  if (resolution === 'keep-host-data') {
    return [
      createHostDirectoryStep(plan.hostDirectory),
      createLxcStopStep(plan.migration),
      createLxcMountStep(plan.migration),
      createStorageArchiveStep({
        name: `archive rootfs ${plan.guestOptPath} before keeping host data`,
        sourcePath: plan.guestOptPath,
        backupPath: plan.rootfsBackupPath!,
      }),
      createLxcDisplaceGuestPathStep(plan.migration),
      createLxcUnmountStep(plan.migration),
      createLxcAttachMp0Step(plan.migration),
      createLxcStartStep(plan.migration),
      createLxcFinalVerifyStep(plan.migration),
    ];
  }

  const migrationOptions: LxcMigrationOptions = {
    hostId: plan.hostId,
    guestPath: plan.guestPath,
    timestamp: plan.timestamp,
    backup: options.guestBackup ?? true,
    ...(options.backupStorage !== undefined
      ? { backupStorage: options.backupStorage }
      : {}),
    ...(options.rootfsMountPath !== undefined
      ? { rootfsMountPath: options.rootfsMountPath }
      : {}),
  };
  return [
    createLxcStopStep(plan.migration),
    createStorageArchiveStep({
      name: `archive host data ${plan.hostPath} before rootfs migration`,
      sourcePath: plan.hostPath,
      backupPath: plan.hostBackupPath!,
    }),
    createHostDataDisplaceStep(plan.hostPath, plan.hostDisplacedPath),
    ...createLxcMigrationSteps(guest, migrationOptions),
  ];
}
