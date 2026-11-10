import { posix } from 'node:path';
import { hashContent } from '../data-dir/hash.js';
import {
  WriteConflictError,
  type WriteGuard,
} from '../data-dir/write-guard.js';
import { sanitizeAuditPayload } from '../redaction/sanitize.js';
import type {
  JournaledStep,
  StepCheckResult,
  StepExecutionContext,
} from '../steps/types.js';
import { defaultNodeFileSystem, type FileSystem } from '../yaml/file.js';

/** How a mapping reacts when the remote file no longer matches the last sync (D-50). */
export type FileConflictPolicy = 'overwrite' | 'skip' | 'fetch' | 'prompt';

/** What an operator or a configured policy chooses for one file conflict. */
export type FileConflictDecision = 'overwrite' | 'skip' | 'fetch';

export interface RemoteFileSnapshot {
  readonly hash: string;
  readonly size?: number | undefined;
  readonly mode?: string | undefined;
}

export interface FileConflictInput {
  /** Absolute path inside the guest. */
  readonly destination: string;
  /** Source path relative to the data dir. */
  readonly source: string;
  /** Policy declared on the mapping. */
  readonly policy: FileConflictPolicy;
  /** Hash the source (or rendered output) would write. */
  readonly sourceHash: string;
  /** The file currently present at the destination. */
  readonly remote: RemoteFileSnapshot;
  /** Hash recorded for the destination at the last successful sync. */
  readonly baselineHash?: string | undefined;
}

/**
 * A destination whose content changed since the last sync. A remote that still
 * matches the baseline is a normal update, and an identical hash is in sync;
 * neither is a conflict (D-50).
 */
export interface FileConflict {
  readonly destination: string;
  readonly source: string;
  readonly policy: FileConflictPolicy;
  readonly sourceHash: string;
  readonly remoteHash: string;
  readonly remoteSize?: number | undefined;
  readonly remoteMode?: string | undefined;
  readonly baselineHash?: string | undefined;
  readonly reason: 'remote_changed' | 'no_baseline';
}

export class FileConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'FileConflictError';
  }
}

export function detectFileConflict(
  input: FileConflictInput,
): FileConflict | undefined {
  if (input.remote.hash === input.sourceHash) return undefined;
  if (
    input.baselineHash !== undefined &&
    input.remote.hash === input.baselineHash
  ) {
    return undefined;
  }
  return {
    destination: input.destination,
    source: input.source,
    policy: input.policy,
    sourceHash: input.sourceHash,
    remoteHash: input.remote.hash,
    ...(input.remote.size !== undefined
      ? { remoteSize: input.remote.size }
      : {}),
    ...(input.remote.mode !== undefined
      ? { remoteMode: input.remote.mode }
      : {}),
    ...(input.baselineHash !== undefined
      ? { baselineHash: input.baselineHash }
      : {}),
    reason: input.baselineHash === undefined ? 'no_baseline' : 'remote_changed',
  };
}

/** Operator-facing labels, shared by the API prompt and the UI. */
export const FILE_CONFLICT_LABELS = {
  fetch: 'Keep the remote file and fetch it into the data dir',
  overwrite: 'Overwrite the remote file with the YAML source',
  skip: 'Skip this file',
} as const satisfies Record<FileConflictDecision, string>;

export function fileConflictDecisionFromLabel(
  label: string,
): FileConflictDecision | undefined {
  for (const [decision, value] of Object.entries(FILE_CONFLICT_LABELS)) {
    if (value === label) return decision as FileConflictDecision;
  }
  return undefined;
}

export interface FileConflictPrompt {
  readonly kind: 'choice';
  readonly message: string;
  readonly payload: Record<string, unknown>;
  readonly options: readonly string[];
}

export interface FileConflictPromptOptions {
  /**
   * Whether the remote copy may be fetched back into the data dir. Rendered
   * `.env` files contain resolved secrets and must never be pulled (D-18).
   */
  readonly allowFetch?: boolean | undefined;
  /** Optional redacted, already-sanitized preview of the difference. */
  readonly diff?: string | undefined;
}

/** Build the choice prompt a job shows before touching a conflicting file. */
export function buildFileConflictPrompt(
  conflict: FileConflict,
  options: FileConflictPromptOptions = {},
): FileConflictPrompt {
  const allowFetch = options.allowFetch ?? conflict.source !== '.env.yaml';
  if (!allowFetch && conflict.policy === 'fetch') {
    throw new FileConflictError(
      `Mapping '${conflict.source}' requests the fetch policy, but rendered .env files may never be fetched back into the data dir (D-18).`,
    );
  }
  const decisions: FileConflictDecision[] = allowFetch
    ? ['fetch', 'overwrite', 'skip']
    : ['overwrite', 'skip'];
  const remoteMode =
    conflict.remoteMode !== undefined ? `, mode ${conflict.remoteMode}` : '';
  return {
    kind: 'choice',
    message: `'${conflict.destination}' changed on the guest since the last sync (source ${conflict.source}, sha256 ${conflict.remoteHash.slice(0, 12)}…${remoteMode}). Choose how to resolve the conflict.`,
    payload: sanitizeAuditPayload({
      destination: conflict.destination,
      source: conflict.source,
      policy: conflict.policy,
      reason: conflict.reason,
      sourceHash: conflict.sourceHash,
      remoteHash: conflict.remoteHash,
      ...(conflict.remoteSize !== undefined
        ? { remoteSize: conflict.remoteSize }
        : {}),
      ...(conflict.remoteMode !== undefined
        ? { remoteMode: conflict.remoteMode }
        : {}),
      ...(conflict.baselineHash !== undefined
        ? { baselineHash: conflict.baselineHash }
        : {}),
      ...(options.diff !== undefined
        ? { diff: sanitizeAuditPayload(options.diff) }
        : {}),
    }) as Record<string, unknown>,
    options: decisions.map((decision) => FILE_CONFLICT_LABELS[decision]),
  };
}

export interface FileConflictResolution {
  readonly conflict: FileConflict;
  readonly decision: FileConflictDecision;
}

/**
 * Validate an answer against the conflict. A decided policy must be honoured;
 * `prompt` accepts any allowed decision. Fetch is always refused for rendered
 * `.env` files so resolved secrets never reach Git-tracked paths (D-18).
 */
export function resolveFileConflict(
  conflict: FileConflict,
  decision: FileConflictDecision,
): FileConflictResolution {
  if (conflict.source === '.env.yaml' && decision === 'fetch') {
    throw new FileConflictError(
      'Rendered .env files may never be fetched back into the data dir (D-18).',
    );
  }
  if (conflict.policy !== 'prompt' && conflict.policy !== decision) {
    throw new FileConflictError(
      `Conflict policy '${conflict.policy}' does not allow the '${decision}' decision.`,
    );
  }
  return { conflict, decision };
}

function normalizeDataDir(dataDir: string): string {
  return dataDir.replaceAll('\\', '/').replace(/\/+$/, '');
}

function resolveDataDirFile(dataDir: string, relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/');
  if (
    normalized === '' ||
    normalized.startsWith('/') ||
    normalized.split('/').includes('..')
  ) {
    throw new FileConflictError(
      `Fetch target '${relativePath}' must be a relative path inside the data dir.`,
    );
  }
  const root = normalizeDataDir(dataDir);
  const absolute = posix.join(root, normalized);
  return absolute;
}

async function readBytes(
  fs: FileSystem,
  absolutePath: string,
): Promise<Uint8Array> {
  if (fs.readBinary) return fs.readBinary(absolutePath);
  return new TextEncoder().encode(await fs.readFile(absolutePath, 'utf8'));
}

export interface FetchFileConflictOptions {
  readonly dataDir: string;
  /** Source path from the conflict, relative to the data dir. */
  readonly source: string;
  /** Remote file content pulled from the guest. */
  readonly content: Uint8Array;
  /** Hash of the source file when the plan was created (write guard). */
  readonly expectedHash: string;
  readonly fs?: FileSystem | undefined;
  readonly writeGuard?: WriteGuard | undefined;
  /** Deterministic suffix for the temporary file; random by default. */
  readonly token?: string | undefined;
}

export interface FetchedFileConflict {
  readonly path: string;
  readonly relativePath: string;
  readonly previousHash: string;
  readonly hash: string;
  readonly size: number;
}

/**
 * Write a fetched remote file into the data dir through the external-edit
 * guard. The write is atomic and the result is re-read to confirm the hash.
 */
export async function fetchFileConflictToDataDir(
  options: FetchFileConflictOptions,
): Promise<FetchedFileConflict> {
  const fs = options.fs ?? defaultNodeFileSystem;
  const absolutePath = resolveDataDirFile(options.dataDir, options.source);
  const current = await readBytes(fs, absolutePath);
  const currentHash = await hashContent(current);
  if (currentHash !== options.expectedHash) {
    throw new WriteConflictError(
      absolutePath,
      options.expectedHash,
      currentHash,
    );
  }

  const contentHash = await hashContent(options.content);
  const token =
    options.token ??
    `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
  const tempPath = `${absolutePath}.tmp.${token}`;
  if (!fs.writeBinary) {
    throw new FileConflictError(
      'The injected FileSystem cannot write binary files; fetching a remote file needs writeBinary.',
    );
  }
  try {
    await fs.writeBinary(tempPath, options.content);
    await fs.rename(tempPath, absolutePath);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // The temporary file may not exist; the original error matters more.
    }
    throw error;
  }

  const writtenHash = await hashContent(await readBytes(fs, absolutePath));
  if (writtenHash !== contentHash) {
    throw new FileConflictError(
      `Fetched '${options.source}' was written with hash ${writtenHash} instead of ${contentHash}.`,
    );
  }
  options.writeGuard?.registerHash(absolutePath, writtenHash);
  return {
    path: absolutePath,
    relativePath: options.source,
    previousHash: currentHash,
    hash: writtenHash,
    size: options.content.byteLength,
  };
}

export interface FileConflictFetchInput {
  readonly dataDir: string;
  readonly source: string;
  readonly destination: string;
  /** Hash of the data dir file when the plan was made. */
  readonly expectedDataDirHash: string;
  /** Hash the remote file had when the plan was made. */
  readonly remoteHash: string;
  /** Pull the remote file; only called by the apply step. */
  readonly pull: (context: StepExecutionContext) => Promise<Uint8Array>;
  readonly fs?: FileSystem | undefined;
  readonly writeGuard?: WriteGuard | undefined;
}

export interface FileConflictFetchResult {
  readonly path: string;
  readonly relativePath: string;
  readonly hash: string;
  readonly size: number;
  /** Audit reason to record with the fetch (D-50, D-66). */
  readonly auditReason: 'conflict_resolution';
  readonly destination: string;
}

/**
 * Journaled step that pulls a conflicting remote file into the data dir. The
 * check is satisfied once the data dir already holds the remote content, so a
 * resumed job does not pull twice.
 */
export function createFileConflictFetchStep(
  input: FileConflictFetchInput,
): JournaledStep<undefined> {
  return {
    name: `fetch conflict ${input.source}`,
    async check(): Promise<StepCheckResult> {
      const absolutePath = resolveDataDirFile(input.dataDir, input.source);
      const fs = input.fs ?? defaultNodeFileSystem;
      try {
        const hash = await hashContent(await readBytes(fs, absolutePath));
        return hash === input.remoteHash
          ? { status: 'satisfied', detail: { hash } }
          : { status: 'required', detail: { hash } };
      } catch (error) {
        if ((error as { code?: unknown }).code === 'ENOENT') {
          return { status: 'required', detail: { missing: true } };
        }
        throw error;
      }
    },
    async apply(context) {
      if (context.dryRun) return { dryRun: true };
      const content = await input.pull(context);
      const fetched = await fetchFileConflictToDataDir({
        dataDir: input.dataDir,
        source: input.source,
        content,
        expectedHash: input.expectedDataDirHash,
        fs: input.fs,
        writeGuard: input.writeGuard,
      });
      return fetched;
    },
    async verify() {
      const absolutePath = resolveDataDirFile(input.dataDir, input.source);
      const fs = input.fs ?? defaultNodeFileSystem;
      const hash = await hashContent(await readBytes(fs, absolutePath));
      if (hash !== input.remoteHash) {
        throw new FileConflictError(
          `Fetched '${input.source}' has hash ${hash} instead of the planned ${input.remoteHash}.`,
        );
      }
      return { hash };
    },
    rollbackHint:
      'The data dir file now holds the copy fetched from the guest. Restore the previous content from Git if that was unintended (D-50).',
  };
}
