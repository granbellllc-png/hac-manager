import { describe, expect, it } from 'vitest';
import { hashContent } from '../data-dir/hash.js';
import type { FileStat, FileSystem } from '../yaml/file.js';
import {
  fetchCommunityScript,
  FileScriptCache,
  isCommunityScriptPinned,
  MemoryScriptCache,
  normalizeScriptHash,
  scriptUrlCommit,
  unifiedScriptDiff,
  validateCommunityScriptSource,
  type ScriptFetcher,
} from './source.js';
import {
  ScriptFetchError,
  ScriptSourceError,
  ScriptTooLargeError,
  UnpinnedScriptUrlError,
  type CommunityScriptSource,
} from './types.js';

const PINNED_COMMIT = 'a'.repeat(40);

class MemoryFileSystem implements FileSystem {
  public readonly files = new Map<string, string>();
  public readonly writes: string[] = [];

  public async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      const error = new Error(`ENOENT: ${path}`) as Error & { code: string };
      error.code = 'ENOENT';
      throw error;
    }
    return content;
  }

  public async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    this.writes.push(path);
  }

  public async stat(): Promise<FileStat> {
    throw new Error('not implemented');
  }

  public async readdir(): Promise<string[]> {
    return [];
  }

  public async rename(): Promise<void> {}

  public async unlink(): Promise<void> {}
}

function fetcher(body: string, status = 200): ScriptFetcher {
  return async () => ({ status, body });
}

const pinnedSource: CommunityScriptSource = {
  url: `https://example.test/install.sh/${PINNED_COMMIT}`,
  pinnedCommit: PINNED_COMMIT,
};

describe('normalizeScriptHash', () => {
  it('returns undefined for an absent value', () => {
    expect(normalizeScriptHash(undefined)).toBeUndefined();
  });

  it('accepts bare and prefixed sha256 values', () => {
    const hash = 'C'.repeat(64);
    expect(normalizeScriptHash(hash)).toBe(hash.toLowerCase());
    expect(normalizeScriptHash(`sha256:${hash}`)).toBe(hash.toLowerCase());
    expect(normalizeScriptHash(` sha256:${hash} `)).toBe(hash.toLowerCase());
  });

  it('rejects malformed hashes', () => {
    expect(() => normalizeScriptHash('deadbeef')).toThrow(ScriptSourceError);
    expect(() => normalizeScriptHash('sha256:nothex')).toThrow(
      /must be 'sha256:<64 hex characters>'/,
    );
  });
});

describe('scriptUrlCommit', () => {
  it('reads a commit from the URL fragment', () => {
    expect(
      scriptUrlCommit(`https://example.test/install.sh#${PINNED_COMMIT}`),
    ).toBe(PINNED_COMMIT);
  });

  it('reads a full commit from a path segment', () => {
    expect(
      scriptUrlCommit(`https://example.test/${PINNED_COMMIT}/install.sh`),
    ).toBe(PINNED_COMMIT);
  });

  it('ignores branches and short path fragments', () => {
    expect(
      scriptUrlCommit('https://example.test/main/install.sh'),
    ).toBeUndefined();
    expect(
      scriptUrlCommit('https://example.test/install.sh#main'),
    ).toBeUndefined();
  });

  it('rejects an invalid URL', () => {
    expect(() => scriptUrlCommit('not a url')).toThrow();
  });
});

describe('isCommunityScriptPinned', () => {
  it('detects every pin form', () => {
    expect(
      isCommunityScriptPinned({
        url: 'https://x.test/a',
        pinnedCommit: PINNED_COMMIT,
      }),
    ).toBe(true);
    expect(
      isCommunityScriptPinned({
        url: 'https://x.test/a',
        contentHash: `sha256:${'a'.repeat(64)}`,
      }),
    ).toBe(true);
    expect(
      isCommunityScriptPinned({ url: `https://x.test/${PINNED_COMMIT}/a` }),
    ).toBe(true);
    expect(isCommunityScriptPinned({ url: 'https://x.test/main/a' })).toBe(
      false,
    );
  });
});

describe('validateCommunityScriptSource', () => {
  it('accepts a pinned source and normalizes the hash', () => {
    const hash = 'A'.repeat(64);
    expect(
      validateCommunityScriptSource({
        url: `https://x.test/${PINNED_COMMIT}/a`,
        contentHash: `sha256:${hash}`,
      }),
    ).toEqual({ commit: PINNED_COMMIT, hash: hash.toLowerCase() });
  });

  it('rejects invalid and plaintext URLs', () => {
    expect(() =>
      validateCommunityScriptSource({
        url: 'not-a-url',
        pinnedCommit: PINNED_COMMIT,
      }),
    ).toThrow(/is invalid/);
    expect(() =>
      validateCommunityScriptSource({
        url: 'http://x.test/a',
        pinnedCommit: PINNED_COMMIT,
      }),
    ).toThrow(/must use https/);
  });

  it('rejects a malformed commit pin', () => {
    expect(() =>
      validateCommunityScriptSource({
        url: 'https://x.test/a',
        pinnedCommit: 'xyz',
      }),
    ).toThrow(/7 to 40 hexadecimal/);
  });

  it('rejects an unpinned URL unless an admin opts in', () => {
    expect(() =>
      validateCommunityScriptSource({ url: 'https://x.test/main/a' }),
    ).toThrow(UnpinnedScriptUrlError);
    expect(
      validateCommunityScriptSource(
        { url: 'https://x.test/main/a' },
        { allowUnpinned: true },
      ),
    ).toEqual({ commit: undefined, hash: undefined });
  });
});

describe('MemoryScriptCache', () => {
  it('stores and returns scripts by key', async () => {
    const cache = new MemoryScriptCache();
    const script = {
      url: 'https://x.test/a',
      key: 'key',
      content: 'echo hi',
      hash: await hashContent('echo hi'),
      fetchedAt: new Date(0).toISOString(),
    };
    expect(await cache.get('key')).toBeUndefined();
    await cache.put(script);
    expect(await cache.get('key')).toEqual(script);
  });
});

describe('FileScriptCache', () => {
  it('reads and writes under hashed filenames', async () => {
    const fs = new MemoryFileSystem();
    const cache = new FileScriptCache('/state/scripts/', fs);
    const script = {
      url: 'https://x.test/a',
      key: 'https://x.test/a@main',
      content: 'echo hi',
      hash: await hashContent('echo hi'),
      fetchedAt: new Date(0).toISOString(),
    };
    await cache.put(script);
    const expected = `/state/scripts/${await hashContent(script.key)}.json`;
    expect(fs.writes).toEqual([expected]);
    expect(await cache.get(script.key)).toEqual(script);
  });

  it('returns undefined for a missing or foreign cache entry', async () => {
    const fs = new MemoryFileSystem();
    const cache = new FileScriptCache('/state', fs);
    expect(await cache.get('missing')).toBeUndefined();

    const script = {
      url: 'https://x.test/a',
      key: 'other',
      content: 'x',
      hash: 'h',
      fetchedAt: new Date(0).toISOString(),
    };
    const path = `/state/${await hashContent('wanted')}.json`;
    fs.files.set(path, JSON.stringify(script));
    expect(await cache.get('wanted')).toBeUndefined();
  });

  it('propagates unexpected read errors', async () => {
    const fs = {
      async readFile(): Promise<string> {
        throw new Error('disk on fire');
      },
    } as unknown as FileSystem;
    await expect(new FileScriptCache('/state', fs).get('key')).rejects.toThrow(
      'disk on fire',
    );
  });
});

describe('fetchCommunityScript', () => {
  it('rejects unpinned sources without fetching', async () => {
    let called = false;
    await expect(
      fetchCommunityScript({
        source: { url: 'https://x.test/main/a' },
        fetch: async () => {
          called = true;
          return { status: 200, body: '' };
        },
      }),
    ).rejects.toThrow(UnpinnedScriptUrlError);
    expect(called).toBe(false);
  });

  it('allows unpinned sources when an admin opts in', async () => {
    const result = await fetchCommunityScript({
      source: { url: 'https://x.test/main/a' },
      fetch: fetcher('echo hi'),
      allowUnpinned: true,
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.fromCache).toBe(false);
    expect(result.script.hash).toBe(await hashContent('echo hi'));
  });

  it('reuses cached content for pinned sources', async () => {
    const cache = new MemoryScriptCache();
    const first = await fetchCommunityScript({
      source: pinnedSource,
      fetch: fetcher('echo one'),
      cache,
    });
    if (first.status !== 'ready') throw new Error('unreachable');
    const second = await fetchCommunityScript({
      source: pinnedSource,
      fetch: async () => {
        throw new Error('network should not be used');
      },
      cache,
    });
    expect(second.status).toBe('ready');
    if (second.status !== 'ready') throw new Error('unreachable');
    expect(second.fromCache).toBe(true);
    expect(second.script).toEqual(first.script);
  });

  it('does not trust a cache entry that misses the pinned hash', async () => {
    const cache = new MemoryScriptCache();
    const pinned: CommunityScriptSource = {
      url: `https://example.test/install.sh/${PINNED_COMMIT}`,
      contentHash: `sha256:${await hashContent('echo fresh')}`,
    };
    await cache.put({
      url: pinned.url,
      key: `${pinned.url}@${PINNED_COMMIT}`,
      content: 'tampered',
      hash: '0'.repeat(64),
      commit: PINNED_COMMIT,
      fetchedAt: new Date(0).toISOString(),
    });
    const result = await fetchCommunityScript({
      source: pinned,
      fetch: fetcher('echo fresh'),
      cache,
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.script.content).toBe('echo fresh');
  });

  it('wraps transport failures', async () => {
    await expect(
      fetchCommunityScript({
        source: pinnedSource,
        fetch: async () => {
          throw new Error('dns failure');
        },
      }),
    ).rejects.toThrow(ScriptFetchError);
  });

  it('rejects non-2xx responses', async () => {
    await expect(
      fetchCommunityScript({
        source: pinnedSource,
        fetch: fetcher('nope', 404),
      }),
    ).rejects.toThrow(/HTTP status 404/);
  });

  it('enforces the size limit', async () => {
    await expect(
      fetchCommunityScript({
        source: pinnedSource,
        fetch: fetcher('x'.repeat(11)),
        maxBytes: 10,
      }),
    ).rejects.toThrow(ScriptTooLargeError);
  });

  it('accepts a content hash pin', async () => {
    const content = 'echo pinned';
    const result = await fetchCommunityScript({
      source: {
        url: 'https://x.test/main/a',
        contentHash: `sha256:${await hashContent(content)}`,
      },
      fetch: fetcher(content),
    });
    expect(result.status).toBe('ready');
  });

  it('requires approval when a pinned hash does not match', async () => {
    const cache = new MemoryScriptCache();
    await cache.put({
      url: pinnedSource.url,
      key: `${pinnedSource.url}@${PINNED_COMMIT}`,
      content: 'echo old',
      hash: await hashContent('echo old'),
      fetchedAt: new Date(0).toISOString(),
    });
    const result = await fetchCommunityScript({
      source: {
        ...pinnedSource,
        contentHash: `sha256:${'f'.repeat(64)}`,
      },
      fetch: fetcher('echo new'),
      cache,
    });
    expect(result.status).toBe('approval_required');
    if (result.status !== 'approval_required') throw new Error('unreachable');
    expect(result.reason).toBe('pinned_hash_mismatch');
    expect(result.previous?.content).toBe('echo old');
    expect(result.diff).toContain('-echo old');
  });

  it('requires approval when an unpinned upstream changes', async () => {
    const cache = new MemoryScriptCache();
    const source: CommunityScriptSource = { url: 'https://x.test/main/a' };
    await fetchCommunityScript({
      source,
      fetch: fetcher('echo v1'),
      cache,
      allowUnpinned: true,
    });
    const result = await fetchCommunityScript({
      source,
      fetch: fetcher('echo v2'),
      cache,
      allowUnpinned: true,
    });
    expect(result.status).toBe('approval_required');
    if (result.status !== 'approval_required') throw new Error('unreachable');
    expect(result.reason).toBe('upstream_changed');
  });

  it('reports approval without a previous copy when none is cached', async () => {
    const result = await fetchCommunityScript({
      source: {
        ...pinnedSource,
        contentHash: `sha256:${'f'.repeat(64)}`,
      },
      fetch: fetcher('echo new'),
    });
    expect(result.status).toBe('approval_required');
    if (result.status !== 'approval_required') throw new Error('unreachable');
    expect(result.previous).toBeUndefined();
    expect(result.diff).toContain('+echo new');
  });

  it('accepts an administrator-approved hash for a pinned mismatch', async () => {
    const content = 'echo approved';
    const result = await fetchCommunityScript({
      source: { ...pinnedSource, contentHash: `sha256:${'f'.repeat(64)}` },
      fetch: fetcher(content),
      approvedHashes: [`sha256:${await hashContent(content)}`],
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.approved).toBe(true);
  });

  it('accepts an approved upstream change and ignores invalid approvals', async () => {
    const cache = new MemoryScriptCache();
    const source: CommunityScriptSource = { url: 'https://x.test/main/a' };
    await fetchCommunityScript({
      source,
      fetch: fetcher('echo v1'),
      cache,
      allowUnpinned: true,
    });
    const result = await fetchCommunityScript({
      source,
      fetch: fetcher('echo v2'),
      cache,
      allowUnpinned: true,
      approvedHashes: ['not-a-hash', `sha256:${await hashContent('echo v2')}`],
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.approved).toBe(true);
  });

  it('stamps fetchedAt from the injected clock', async () => {
    const result = await fetchCommunityScript({
      source: pinnedSource,
      fetch: fetcher('echo hi'),
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.script.fetchedAt).toBe('2026-01-02T03:04:05.000Z');
  });
});

describe('unifiedScriptDiff', () => {
  it('reports identical content', () => {
    expect(unifiedScriptDiff('a\nb', 'a\nb')).toBe('No textual changes.');
  });

  it('shows changes with context', () => {
    const diff = unifiedScriptDiff('a\nb\nc\nd', 'a\nb\nX\nd', 0);
    expect(diff).toContain('-c');
    expect(diff).toContain('+X');
    expect(diff).not.toContain(' a');
  });

  it('elides large unchanged regions', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const after = [...before];
    after[1] = 'X';
    after[8] = 'Y';
    const diff = unifiedScriptDiff(before.join('\n'), after.join('\n'), 0);
    expect(diff).toContain('…');
  });

  it('falls back to whole-file output above the line limit', () => {
    const before = Array.from(
      { length: 4001 },
      (_, index) => `old ${index}`,
    ).join('\n');
    const diff = unifiedScriptDiff(before, 'new');
    expect(diff.startsWith('--- previous (4001 lines)')).toBe(true);
    expect(diff).toContain('+new');
  });
});
