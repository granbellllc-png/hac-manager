/**
 * Community script pinning, caching and approval (D-41, ADR 0011).
 *
 * Scripts run with root-equivalent power on a host, so a mutable URL is never
 * executed directly: the source is pinned by commit and/or content hash, cached
 * locally, and any upstream change needs an explicit approval.
 */

export const COMMUNITY_SCRIPT_MAX_BYTES = 1_048_576;
/** Unpinned scripts are only allowed when an administrator opted in. */
export const COMMUNITY_SCRIPT_DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

export interface CommunityScriptSource {
  readonly url: string;
  /** Commit SHA from `installation.pinned_commit`. */
  readonly pinnedCommit?: string | undefined;
  /** `sha256:<hex>` from `installation.content_hash`. */
  readonly contentHash?: string | undefined;
}

export interface CachedCommunityScript {
  readonly url: string;
  readonly key: string;
  readonly content: string;
  /** Bare lowercase SHA-256 of the content. */
  readonly hash: string;
  readonly commit?: string | undefined;
  readonly fetchedAt: string;
}

export interface ScriptCache {
  get(key: string): Promise<CachedCommunityScript | undefined>;
  put(script: CachedCommunityScript): Promise<void>;
}

export class ScriptSourceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ScriptSourceError';
  }
}

export class UnpinnedScriptUrlError extends ScriptSourceError {
  public constructor(url: string) {
    super(
      `Community script URL '${url}' is not pinned to a commit or content hash. Set installation.pinned_commit or installation.content_hash, or let an administrator explicitly allow unpinned scripts (D-41).`,
    );
    this.name = 'UnpinnedScriptUrlError';
  }
}

export class ScriptFetchError extends ScriptSourceError {
  public constructor(url: string, message: string) {
    super(`Failed to fetch community script '${url}': ${message}`);
    this.name = 'ScriptFetchError';
  }
}

export class ScriptTooLargeError extends ScriptSourceError {
  public constructor(url: string, bytes: number, limit: number) {
    super(
      `Community script '${url}' is ${bytes} bytes, above the ${limit} byte limit.`,
    );
    this.name = 'ScriptTooLargeError';
  }
}
