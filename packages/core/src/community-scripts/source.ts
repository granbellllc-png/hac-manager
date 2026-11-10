import { hashContent } from '../data-dir/hash.js';
import { defaultNodeFileSystem, type FileSystem } from '../yaml/file.js';
import {
  COMMUNITY_SCRIPT_MAX_BYTES,
  ScriptFetchError,
  ScriptSourceError,
  ScriptTooLargeError,
  UnpinnedScriptUrlError,
  type CachedCommunityScript,
  type CommunityScriptSource,
  type ScriptCache,
} from './types.js';

export interface ScriptFetchResponse {
  readonly status: number;
  readonly body: string;
}

export type ScriptFetcher = (url: string) => Promise<ScriptFetchResponse>;

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;
const SHA256_INPUT_PATTERN = /^(?:sha256:)?([0-9a-f]{64})$/i;

/** Normalize `sha256:<hex>` (or bare hex) to a bare lowercase hash. */
export function normalizeScriptHash(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const match = SHA256_INPUT_PATTERN.exec(value.trim());
  if (!match?.[1]) {
    throw new ScriptSourceError(
      `Content hash '${value}' must be 'sha256:<64 hex characters>'.`,
    );
  }
  return match[1].toLowerCase();
}

/** A full commit SHA embedded in the URL path or fragment counts as a pin. */
export function scriptUrlCommit(url: string): string | undefined {
  const parsed = new URL(url);
  const fragment = parsed.hash.replace(/^#/, '');
  if (COMMIT_PATTERN.test(fragment)) return fragment;
  for (const segment of parsed.pathname.split('/')) {
    if (/^[0-9a-f]{40}$/i.test(segment)) return segment;
  }
  return undefined;
}

export function isCommunityScriptPinned(
  source: CommunityScriptSource,
): boolean {
  return Boolean(
    source.pinnedCommit ?? source.contentHash ?? scriptUrlCommit(source.url),
  );
}

function assertSecureUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ScriptSourceError(`Community script URL '${url}' is invalid.`);
  }
  if (parsed.protocol !== 'https:') {
    throw new ScriptSourceError(
      `Community script URL '${url}' must use https; scripts are never fetched over plaintext HTTP.`,
    );
  }
  return parsed;
}

export interface ValidateCommunityScriptSourceOptions {
  /** Explicit administrator opt-in for unpinned sources (D-41). */
  readonly allowUnpinned?: boolean | undefined;
}

export function validateCommunityScriptSource(
  source: CommunityScriptSource,
  options: ValidateCommunityScriptSourceOptions = {},
): {
  readonly commit?: string | undefined;
  readonly hash?: string | undefined;
} {
  assertSecureUrl(source.url);
  if (
    source.pinnedCommit !== undefined &&
    !COMMIT_PATTERN.test(source.pinnedCommit)
  ) {
    throw new ScriptSourceError(
      `Pinned commit '${source.pinnedCommit}' must be 7 to 40 hexadecimal characters.`,
    );
  }
  const hash = normalizeScriptHash(source.contentHash);
  const commit = source.pinnedCommit ?? scriptUrlCommit(source.url);
  if (!commit && !hash && options.allowUnpinned !== true) {
    throw new UnpinnedScriptUrlError(source.url);
  }
  return { commit, hash };
}

export class MemoryScriptCache implements ScriptCache {
  private readonly scripts = new Map<string, CachedCommunityScript>();

  public async get(key: string): Promise<CachedCommunityScript | undefined> {
    return this.scripts.get(key);
  }

  public async put(script: CachedCommunityScript): Promise<void> {
    this.scripts.set(script.key, script);
  }
}

/** Filesystem cache for fetched scripts; lives in the state dir, never Git. */
export class FileScriptCache implements ScriptCache {
  public constructor(
    private readonly directory: string,
    private readonly fs: FileSystem = defaultNodeFileSystem,
  ) {}

  private pathFor(key: string): Promise<string> {
    return hashContent(key).then(
      (hash) => `${this.directory.replace(/\/+$/, '')}/${hash}.json`,
    );
  }

  public async get(key: string): Promise<CachedCommunityScript | undefined> {
    const path = await this.pathFor(key);
    try {
      const content = await this.fs.readFile(path, 'utf8');
      const parsed = JSON.parse(content) as CachedCommunityScript;
      return parsed.key === key ? parsed : undefined;
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  public async put(script: CachedCommunityScript): Promise<void> {
    const path = await this.pathFor(script.key);
    await this.fs.writeFile(path, `${JSON.stringify(script, null, 2)}\n`);
  }
}

export interface FetchCommunityScriptOptions {
  readonly source: CommunityScriptSource;
  /** Injected HTTP client; core never performs network I/O itself. */
  readonly fetch: ScriptFetcher;
  readonly cache?: ScriptCache | undefined;
  readonly allowUnpinned?: boolean | undefined;
  /** Hashes an administrator previously approved for this source. */
  readonly approvedHashes?: readonly string[] | undefined;
  readonly maxBytes?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export type CommunityScriptFetchResult =
  | {
      readonly status: 'ready';
      readonly script: CachedCommunityScript;
      readonly fromCache: boolean;
      readonly approved: boolean;
    }
  | {
      readonly status: 'approval_required';
      readonly script: CachedCommunityScript;
      readonly previous?: CachedCommunityScript | undefined;
      readonly reason: 'pinned_hash_mismatch' | 'upstream_changed';
      readonly diff: string;
    };

function cacheKey(source: CommunityScriptSource, commit?: string): string {
  const ref = commit ?? scriptUrlCommit(source.url) ?? 'any';
  return `${source.url}@${ref}`;
}

function approved(
  hash: string,
  approvedHashes: readonly string[] | undefined,
): boolean {
  if (!approvedHashes) return false;
  return approvedHashes.some((candidate) => {
    try {
      return normalizeScriptHash(candidate) === hash;
    } catch {
      return false;
    }
  });
}

/**
 * Fetch and verify a community script. Pinned hashes are enforced, cached
 * content avoids repeated downloads, and a changed upstream needs approval.
 */
export async function fetchCommunityScript(
  options: FetchCommunityScriptOptions,
): Promise<CommunityScriptFetchResult> {
  const { commit, hash: pinnedHash } = validateCommunityScriptSource(
    options.source,
    { allowUnpinned: options.allowUnpinned },
  );
  const key = cacheKey(options.source, commit);
  const cache = options.cache;
  const cached = await cache?.get(key);
  const maxBytes = options.maxBytes ?? COMMUNITY_SCRIPT_MAX_BYTES;

  const trustedCache =
    cached !== undefined &&
    (pinnedHash !== undefined
      ? cached.hash === pinnedHash
      : commit !== undefined);
  if (cached && trustedCache) {
    return {
      status: 'ready',
      script: cached,
      fromCache: true,
      approved: false,
    };
  }

  let response: ScriptFetchResponse;
  try {
    response = await options.fetch(options.source.url);
  } catch (error) {
    throw new ScriptFetchError(
      options.source.url,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ScriptFetchError(
      options.source.url,
      `unexpected HTTP status ${response.status}`,
    );
  }
  const bytes = new TextEncoder().encode(response.body).byteLength;
  if (bytes > maxBytes) {
    throw new ScriptTooLargeError(options.source.url, bytes, maxBytes);
  }
  const hash = await hashContent(response.body);
  const script: CachedCommunityScript = {
    url: options.source.url,
    key,
    content: response.body,
    hash,
    ...(commit !== undefined ? { commit } : {}),
    fetchedAt: (options.now?.() ?? new Date()).toISOString(),
  };
  await cache?.put(script);

  if (pinnedHash !== undefined) {
    if (pinnedHash === hash) {
      return { status: 'ready', script, fromCache: false, approved: false };
    }
    if (approved(hash, options.approvedHashes)) {
      return { status: 'ready', script, fromCache: false, approved: true };
    }
    return {
      status: 'approval_required',
      script,
      ...(cached !== undefined ? { previous: cached } : {}),
      reason: 'pinned_hash_mismatch',
      diff: unifiedScriptDiff(cached?.content ?? '', response.body),
    };
  }

  if (cached !== undefined && cached.hash !== hash) {
    if (approved(hash, options.approvedHashes)) {
      return { status: 'ready', script, fromCache: false, approved: true };
    }
    return {
      status: 'approval_required',
      script,
      previous: cached,
      reason: 'upstream_changed',
      diff: unifiedScriptDiff(cached.content, response.body),
    };
  }

  return { status: 'ready', script, fromCache: false, approved: false };
}

const DIFF_LINE_LIMIT = 4000;

/**
 * Small line diff used by the approval prompt. Above the line limit it falls
 * back to a whole-file replacement so the UI never hangs on a huge script.
 */
export function unifiedScriptDiff(
  before: string,
  after: string,
  context = 3,
): string {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  if (oldLines.length > DIFF_LINE_LIMIT || newLines.length > DIFF_LINE_LIMIT) {
    return [
      `--- previous (${oldLines.length} lines)`,
      `+++ fetched (${newLines.length} lines)`,
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
    ].join('\n');
  }

  const rows = oldLines.length + 1;
  const columns = newLines.length + 1;
  const lcs: number[][] = Array.from({ length: rows }, () =>
    new Array<number>(columns).fill(0),
  );
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        oldLines[i] === newLines[j]
          ? (lcs[i + 1]![j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]![j] ?? 0, lcs[i]![j + 1] ?? 0);
    }
  }

  const ops: { readonly kind: ' ' | '-' | '+'; readonly line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: ' ', line: oldLines[i]! });
      i++;
      j++;
    } else if ((lcs[i + 1]![j] ?? 0) >= (lcs[i]![j + 1] ?? 0)) {
      ops.push({ kind: '-', line: oldLines[i]! });
      i++;
    } else {
      ops.push({ kind: '+', line: newLines[j]! });
      j++;
    }
  }
  while (i < oldLines.length) ops.push({ kind: '-', line: oldLines[i++]! });
  while (j < newLines.length) ops.push({ kind: '+', line: newLines[j++]! });

  const changed = ops
    .map((op, index) => ({ op, index }))
    .filter(({ op }) => op.kind !== ' ');
  if (changed.length === 0) return 'No textual changes.';

  const keep = new Set<number>();
  for (const { index } of changed) {
    for (
      let cursor = Math.max(0, index - context);
      cursor <= Math.min(ops.length - 1, index + context);
      cursor++
    ) {
      keep.add(cursor);
    }
  }

  const output: string[] = [];
  let previousKept: number | undefined;
  for (let index = 0; index < ops.length; index++) {
    if (!keep.has(index)) continue;
    if (previousKept !== undefined && index > previousKept + 1) {
      output.push('…');
    }
    output.push(`${ops[index]!.kind}${ops[index]!.line}`);
    previousKept = index;
  }
  return output.join('\n');
}
