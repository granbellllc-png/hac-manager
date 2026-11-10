/**
 * Host backup status view (D-57).
 *
 * Restic status comes from the key/value file the generated script writes.
 * `vzdump` status comes from the five most recent Proxmox tasks. A missing or
 * unreadable status source is reported as unknown, not as a failure.
 */

import type { HostBackupConfig } from '../schema/host-backup.js';
import type { Transport } from '../transport/types.js';

export const HOST_BACKUP_STATUS_TIMEOUT_MS = 30_000;

export interface HostBackupRunStatus {
  readonly enabled: boolean;
  readonly known: boolean;
  readonly lastRun?: string | undefined;
  readonly lastSuccess?: string | undefined;
  readonly lastStatus?: string | undefined;
}

export interface HostBackupStatus {
  readonly hostId: string;
  readonly checkedAt: string;
  readonly vzdump: HostBackupRunStatus;
  readonly restic: HostBackupRunStatus;
  readonly warnings: readonly string[];
}

export interface HostBackupStatusOptions {
  readonly hostId: string;
  readonly node?: string | undefined;
  readonly now?: Date | undefined;
}

function disabled(): HostBackupRunStatus {
  return { enabled: false, known: false };
}

function parseKeyValues(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) {
      values.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
    }
  }
  return values;
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

interface ProxmoxTask {
  readonly starttime?: unknown;
  readonly endtime?: unknown;
  readonly status?: unknown;
}

function epochIso(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value * 1_000).toISOString();
}

function parseVzdumpTasks(stdout: string): ProxmoxTask[] | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is ProxmoxTask =>
            typeof entry === 'object' && entry !== null,
        )
      : undefined;
  } catch {
    return undefined;
  }
}

async function readResticStatus(
  transport: Transport,
  config: HostBackupConfig,
  warnings: string[],
): Promise<HostBackupRunStatus> {
  const restic = config.restic;
  if (!restic || restic.enabled === false) return disabled();
  const result = await transport.exec(['cat', restic.status_file], {
    timeoutMs: HOST_BACKUP_STATUS_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    warnings.push(
      `The restic status file '${restic.status_file}' is not readable yet.`,
    );
    return { enabled: true, known: false };
  }
  const values = parseKeyValues(result.stdout);
  const lastRun = isoOrUndefined(values.get('last_run'));
  const lastSuccess = isoOrUndefined(values.get('last_success'));
  if (lastRun === undefined && lastSuccess === undefined) {
    warnings.push(
      `The restic status file '${restic.status_file}' contains no run timestamps.`,
    );
    return { enabled: true, known: false };
  }
  return {
    enabled: true,
    known: true,
    ...(lastRun !== undefined ? { lastRun } : {}),
    ...(lastSuccess !== undefined ? { lastSuccess } : {}),
  };
}

async function readVzdumpStatus(
  transport: Transport,
  config: HostBackupConfig,
  node: string,
  warnings: string[],
): Promise<HostBackupRunStatus> {
  const vzdump = config.vzdump;
  if (!vzdump || vzdump.enabled === false) return disabled();
  const result = await transport.exec(
    [
      'pvesh',
      'get',
      `/nodes/${node}/tasks`,
      '--typefilter',
      'vzdump',
      '--limit',
      '5',
      '--output-format',
      'json',
    ],
    { timeoutMs: HOST_BACKUP_STATUS_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) {
    warnings.push(
      `The vzdump task list could not be read: ${
        result.stderr.trim() || `exit code ${result.exitCode}`
      }`,
    );
    return { enabled: true, known: false };
  }
  const tasks = parseVzdumpTasks(result.stdout);
  if (!tasks) {
    warnings.push('The vzdump task list was not valid JSON.');
    return { enabled: true, known: false };
  }
  const sorted = tasks
    .filter((task) => epochIso(task.starttime) !== undefined)
    .sort(
      (left, right) => (right.starttime as number) - (left.starttime as number),
    );
  const latest = sorted[0];
  if (!latest) {
    return { enabled: true, known: true };
  }
  const lastRun = epochIso(latest.starttime);
  const success = sorted.find(
    (task) =>
      typeof task.status === 'string' && task.status.toLowerCase() === 'ok',
  );
  const lastSuccess = success ? epochIso(success.starttime) : undefined;
  const lastStatus =
    typeof latest.status === 'string' ? latest.status : undefined;
  return {
    enabled: true,
    known: true,
    ...(lastRun !== undefined ? { lastRun } : {}),
    ...(lastSuccess !== undefined ? { lastSuccess } : {}),
    ...(lastStatus !== undefined ? { lastStatus } : {}),
  };
}

/** Read the last run and last success for both host backup mechanisms. */
export async function readHostBackupStatus(
  config: HostBackupConfig,
  transport: Transport,
  options: HostBackupStatusOptions,
): Promise<HostBackupStatus> {
  if (!options.hostId.trim()) {
    throw new Error('hostId must not be empty.');
  }
  const warnings: string[] = [];
  const [vzdump, restic] = await Promise.all([
    readVzdumpStatus(transport, config, options.node ?? 'localhost', warnings),
    readResticStatus(transport, config, warnings),
  ]);
  return {
    hostId: options.hostId,
    checkedAt: (options.now ?? new Date()).toISOString(),
    vzdump,
    restic,
    warnings,
  };
}
