/**
 * Host backup drift and journaled apply (D-57).
 *
 * Applying is idempotent: every managed file is compared by SHA-256 and mode
 * before it is written. A file is written to a sibling temporary path, given
 * its final mode, then renamed over the destination, so a failed apply cannot
 * leave a truncated `vzdump.conf`, script or cron file.
 */

import { hashContent } from '../data-dir/hash.js';
import type { HostBackupConfig } from '../schema/host-backup.js';
import type { JournaledStep } from '../steps/types.js';
import {
  TransportFileNotFoundError,
  type Transport,
} from '../transport/types.js';
import {
  HostBackupError,
  renderHostBackupFiles,
  type HostBackupFileKind,
  type RenderedHostBackupFile,
} from './render.js';

export const HOST_BACKUP_READ_TIMEOUT_MS = 15_000;
export const HOST_BACKUP_WRITE_TIMEOUT_MS = 60_000;

export type HostBackupFileStatus = 'create' | 'update' | 'in-sync';

export interface HostBackupRemoteFile {
  readonly exists: boolean;
  readonly hash?: string | undefined;
  readonly mode?: string | undefined;
}

export interface HostBackupFilePlan {
  readonly kind: HostBackupFileKind;
  readonly path: string;
  readonly mode: string;
  readonly content: string;
  readonly contentHash: string;
  readonly status: HostBackupFileStatus;
  readonly remote: HostBackupRemoteFile;
  readonly modeDrifted: boolean;
}

export interface HostBackupPlan {
  readonly hostId: string;
  readonly checkedAt: string;
  readonly files: readonly HostBackupFilePlan[];
  readonly changes: readonly {
    readonly id: string;
    readonly action: 'create' | 'update';
    readonly summary: string;
    readonly path: string;
    readonly before?: unknown;
    readonly after?: unknown;
  }[];
  readonly warnings: readonly string[];
  readonly inSync: boolean;
}

export interface HostBackupPlanOptions {
  readonly hostId: string;
  readonly now?: Date | undefined;
}

function normalizeMode(mode: string): string {
  return mode.replace(/^0+/, '') || '0';
}

function modesEqual(left: string, right: string): boolean {
  return normalizeMode(left) === normalizeMode(right);
}

async function readOptionalFile(
  transport: Transport,
  path: string,
): Promise<string | undefined> {
  try {
    return await transport.readFile(path);
  } catch (error) {
    if (error instanceof TransportFileNotFoundError) return undefined;
    throw error;
  }
}

async function readRemoteMode(
  transport: Transport,
  path: string,
): Promise<string | undefined> {
  const result = await transport.exec(['stat', '-c', '%a', path], {
    timeoutMs: HOST_BACKUP_READ_TIMEOUT_MS,
  });
  const mode = result.stdout.trim();
  return result.exitCode === 0 && mode.length > 0 ? mode : undefined;
}

async function inspectFile(
  transport: Transport,
  file: RenderedHostBackupFile,
): Promise<{
  readonly remote: HostBackupRemoteFile;
  readonly contentHash: string;
}> {
  const contentHash = await hashContent(file.content);
  const content = await readOptionalFile(transport, file.path);
  if (content === undefined) {
    return {
      remote: { exists: false },
      contentHash,
    };
  }
  const hash = await hashContent(content);
  const mode = await readRemoteMode(transport, file.path);
  return {
    remote: {
      exists: true,
      hash,
      ...(mode !== undefined ? { mode } : {}),
    },
    contentHash,
  };
}

/** Compare the declarative host backup config with the live host files. */
export async function planHostBackup(
  config: HostBackupConfig,
  transport: Transport,
  options: HostBackupPlanOptions,
): Promise<HostBackupPlan> {
  if (!options.hostId.trim()) {
    throw new HostBackupError('hostId must not be empty.');
  }
  const rendered = renderHostBackupFiles(config);
  const files: HostBackupFilePlan[] = [];
  const changes: HostBackupPlan['changes'][number][] = [];
  const warnings: string[] = [];

  for (const file of rendered) {
    const { remote, contentHash } = await inspectFile(transport, file);
    const modeDrifted =
      remote.exists &&
      remote.mode !== undefined &&
      !modesEqual(remote.mode, file.mode);
    let status: HostBackupFileStatus;
    if (!remote.exists) {
      status = 'create';
    } else if (remote.hash !== contentHash || modeDrifted) {
      status = 'update';
    } else {
      status = 'in-sync';
    }

    files.push({
      kind: file.kind,
      path: file.path,
      mode: file.mode,
      content: file.content,
      contentHash,
      status,
      remote,
      modeDrifted,
    });

    if (remote.exists && remote.mode === undefined) {
      warnings.push(
        `Could not read the mode of ${file.path}; only content drift is checked.`,
      );
    }
    if (status === 'in-sync') continue;
    const id = `${file.kind}:${file.path}`;
    changes.push({
      id,
      action: status,
      summary:
        status === 'create'
          ? `Create the managed ${file.kind} file at ${file.path}`
          : modeDrifted && remote.hash === contentHash
            ? `Fix the mode of ${file.path} to ${file.mode}`
            : `Update the managed ${file.kind} file at ${file.path}`,
      path: file.path,
      ...(remote.exists
        ? {
            before: {
              hash: remote.hash,
              ...(remote.mode !== undefined ? { mode: remote.mode } : {}),
            },
          }
        : {}),
      after: { hash: contentHash, mode: file.mode },
    });
    if (modeDrifted) {
      warnings.push(
        `The live mode of ${file.path} is ${remote.mode ?? 'unknown'}, expected ${file.mode}.`,
      );
    }
  }

  if (rendered.length === 0) {
    warnings.push(
      'No host backup files are managed for this host; enable vzdump or restic in host.yaml.',
    );
  }

  return {
    hostId: options.hostId,
    checkedAt: (options.now ?? new Date()).toISOString(),
    files,
    changes,
    warnings,
    inSync: changes.length === 0,
  };
}

async function remoteMatches(
  transport: Transport,
  file: HostBackupFilePlan,
): Promise<boolean> {
  const content = await readOptionalFile(transport, file.path);
  if (content === undefined) return false;
  if ((await hashContent(content)) !== file.contentHash) return false;
  const mode = await readRemoteMode(transport, file.path);
  return mode !== undefined && modesEqual(mode, file.mode);
}

function tempPath(path: string): string {
  return `${path}.hacm-tmp`;
}

/** Journaled, idempotent apply of every drifted managed file. */
export function createHostBackupSteps(
  plan: HostBackupPlan,
): readonly JournaledStep<undefined>[] {
  return plan.files.map((file) => ({
    name: `apply managed host backup file ${file.path}`,
    check: async ({ transport }) =>
      (await remoteMatches(transport, file))
        ? { status: 'satisfied', detail: { path: file.path } }
        : { status: 'required', detail: { path: file.path } },
    apply: async ({ transport, signal }) => {
      const temp = tempPath(file.path);
      try {
        await transport.writeFile(temp, file.content, { signal });
      } catch (error) {
        throw new HostBackupError(
          `Could not write '${temp}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const chmod = await transport.exec(['chmod', file.mode, temp], {
        timeoutMs: HOST_BACKUP_WRITE_TIMEOUT_MS,
        signal,
      });
      if (chmod.exitCode !== 0) {
        throw new HostBackupError(
          `Could not set the mode of '${temp}' to ${file.mode}: ${
            chmod.stderr.trim() || `exit code ${chmod.exitCode}`
          }`,
        );
      }
      const moved = await transport.exec(['mv', temp, file.path], {
        timeoutMs: HOST_BACKUP_WRITE_TIMEOUT_MS,
        signal,
      });
      if (moved.exitCode !== 0) {
        throw new HostBackupError(
          `Could not replace '${file.path}': ${
            moved.stderr.trim() || `exit code ${moved.exitCode}`
          }`,
        );
      }
      return {
        path: file.path,
        hash: file.contentHash,
        mode: file.mode,
      };
    },
    verify: async ({ transport }) => {
      if (!(await remoteMatches(transport, file))) {
        throw new HostBackupError(
          `Managed host backup file '${file.path}' does not match the declared content or mode after apply.`,
        );
      }
      return { path: file.path, hash: file.contentHash, mode: file.mode };
    },
    rollbackHint: `Restore the previous contents of '${file.path}' from your host backup if the new file is wrong. The managed file was replaced atomically.`,
  }));
}
