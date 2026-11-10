import { describe, expect, it } from 'vitest';
import { hashContent } from '../data-dir/hash.js';
import { WriteConflictError, WriteGuard } from '../data-dir/write-guard.js';
import type { StepExecutionContext } from '../steps/types.js';
import type { FileStat, FileSystem } from '../yaml/file.js';
import type { FilemappingsFile } from '../schema/filemappings.js';
import type { GuestDeployment } from '../schema/deployment.js';
import { Secret } from '../tags/secret.js';
import type { Transport } from '../transport/types.js';
import {
  buildFileConflictPrompt,
  createFileConflictFetchStep,
  detectFileConflict,
  fetchFileConflictToDataDir,
  FILE_CONFLICT_LABELS,
  FileConflictError,
  fileConflictDecisionFromLabel,
  resolveFileConflict,
  type FileConflict,
} from './conflict.js';
import { planFilemappings } from './plan.js';

class MemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, Uint8Array>();
  private readonly directories = new Set<string>(['/']);

  public addFile(path: string, content: string | Uint8Array): this {
    const data =
      typeof content === 'string' ? new TextEncoder().encode(content) : content;
    this.files.set(path, data);
    let parent = path;
    while (parent !== '/') {
      parent = parent.slice(0, parent.lastIndexOf('/')) || '/';
      this.directories.add(parent);
    }
    return this;
  }

  public get(path: string): Uint8Array | undefined {
    return this.files.get(path);
  }

  public async readFile(path: string): Promise<string> {
    const data = this.files.get(path);
    if (!data) throw enoent(path);
    return new TextDecoder().decode(data);
  }

  public async readBinary(path: string): Promise<Uint8Array> {
    const data = this.files.get(path);
    if (!data) throw enoent(path);
    return data;
  }

  public async writeFile(path: string, content: string): Promise<void> {
    this.addFile(path, content);
  }

  public async writeBinary(path: string, content: Uint8Array): Promise<void> {
    this.addFile(path, content);
  }

  public async stat(path: string): Promise<FileStat> {
    if (this.files.has(path)) {
      return {
        mode: 0o100644,
        isDirectory: () => false,
        isFile: () => true,
      };
    }
    if (this.directories.has(path)) {
      return {
        mode: 0o40755,
        isDirectory: () => true,
        isFile: () => false,
      };
    }
    throw enoent(path);
  }

  public async readdir(path: string): Promise<string[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const names = new Set<string>();
    for (const candidate of [...this.files.keys(), ...this.directories]) {
      if (!candidate.startsWith(prefix)) continue;
      const name = candidate.slice(prefix.length).split('/')[0]!;
      if (name) names.add(name);
    }
    return [...names];
  }

  public async rename(oldPath: string, newPath: string): Promise<void> {
    const data = this.files.get(oldPath);
    if (!data) throw enoent(oldPath);
    this.files.delete(oldPath);
    this.files.set(newPath, data);
  }

  public async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }
}

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
}

const transport = {
  async exec() {
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  },
  async readFile() {
    return '';
  },
  async writeFile() {},
} satisfies Transport;

function stepContext(dryRun = false): StepExecutionContext<undefined> {
  return {
    operationId: 'job-1',
    input: undefined,
    transport,
    logger: { info() {}, warn() {}, error() {} },
    dryRun,
    signal: new AbortController().signal,
  };
}

function conflict(overrides: Partial<FileConflict> = {}): FileConflict {
  return {
    destination: '/etc/app.conf',
    source: 'appdata/app.conf',
    policy: 'prompt',
    sourceHash: 'a'.repeat(64),
    remoteHash: 'b'.repeat(64),
    reason: 'remote_changed',
    ...overrides,
  };
}

describe('detectFileConflict', () => {
  const base = {
    destination: '/etc/app.conf',
    source: 'appdata/app.conf',
    policy: 'prompt' as const,
    sourceHash: 'a'.repeat(64),
    remote: { hash: 'b'.repeat(64), size: 4, mode: '0644' },
  };

  it('treats identical content as in sync', () => {
    expect(
      detectFileConflict({
        ...base,
        remote: { hash: base.sourceHash },
      }),
    ).toBeUndefined();
  });

  it('treats an untouched remote as a normal update', () => {
    expect(
      detectFileConflict({ ...base, baselineHash: base.remote.hash }),
    ).toBeUndefined();
  });

  it('reports a remote edit when the baseline no longer matches', () => {
    expect(
      detectFileConflict({ ...base, baselineHash: 'c'.repeat(64) }),
    ).toMatchObject({
      destination: '/etc/app.conf',
      remoteHash: base.remote.hash,
      remoteSize: 4,
      remoteMode: '0644',
      baselineHash: 'c'.repeat(64),
      reason: 'remote_changed',
    });
  });

  it('reports an unknown baseline as a conflict', () => {
    expect(detectFileConflict(base)).toMatchObject({ reason: 'no_baseline' });
  });
});

describe('conflict prompts', () => {
  it('round-trips labels and orders fetch first by default', () => {
    for (const decision of ['fetch', 'overwrite', 'skip'] as const) {
      expect(
        fileConflictDecisionFromLabel(FILE_CONFLICT_LABELS[decision]),
      ).toBe(decision);
    }
    expect(fileConflictDecisionFromLabel('nonsense')).toBeUndefined();
    const prompt = buildFileConflictPrompt(conflict());
    expect(prompt.kind).toBe('choice');
    expect(prompt.options).toEqual([
      FILE_CONFLICT_LABELS.fetch,
      FILE_CONFLICT_LABELS.overwrite,
      FILE_CONFLICT_LABELS.skip,
    ]);
    expect(prompt.payload).toMatchObject({
      destination: '/etc/app.conf',
      source: 'appdata/app.conf',
      remoteHash: 'b'.repeat(64),
    });
    expect(JSON.stringify(prompt)).not.toContain('***');
  });

  it('never offers fetch for rendered .env files', () => {
    const envConflict = conflict({ source: '.env.yaml' });
    expect(buildFileConflictPrompt(envConflict).options).toEqual([
      FILE_CONFLICT_LABELS.overwrite,
      FILE_CONFLICT_LABELS.skip,
    ]);
    expect(() =>
      buildFileConflictPrompt(
        conflict({ source: '.env.yaml', policy: 'fetch' }),
      ),
    ).toThrow(FileConflictError);
  });

  it('includes sizes, modes, baselines and a sanitized diff when available', () => {
    const prompt = buildFileConflictPrompt(
      conflict({
        remoteSize: 12,
        remoteMode: '0600',
        baselineHash: 'c'.repeat(64),
      }),
      { diff: '-old\n+new\n' },
    );
    expect(prompt.payload).toMatchObject({
      remoteSize: 12,
      remoteMode: '0600',
      baselineHash: 'c'.repeat(64),
      diff: '-old\n+new\n',
    });
    expect(prompt.message).toContain('mode 0600');
  });

  it('validates decisions against the policy', () => {
    expect(resolveFileConflict(conflict(), 'fetch').decision).toBe('fetch');
    expect(() =>
      resolveFileConflict(conflict({ policy: 'overwrite' }), 'skip'),
    ).toThrow("does not allow the 'skip' decision");
    expect(() =>
      resolveFileConflict(conflict({ source: '.env.yaml' }), 'fetch'),
    ).toThrow('may never be fetched');
  });
});

describe('fetchFileConflictToDataDir', () => {
  it('writes binary content through the write guard and registers the hash', async () => {
    const fs = new MemoryFileSystem().addFile('/data/appdata/app.conf', 'old');
    const guard = new WriteGuard();
    const content = new TextEncoder().encode('new\0binary');
    const fetched = await fetchFileConflictToDataDir({
      dataDir: '/data',
      source: 'appdata/app.conf',
      content,
      expectedHash: await hashContent('old'),
      fs,
      writeGuard: guard,
      token: 'test',
    });

    expect(fetched).toMatchObject({
      relativePath: 'appdata/app.conf',
      previousHash: await hashContent('old'),
      hash: await hashContent(content),
      size: content.byteLength,
    });
    expect(fs.get('/data/appdata/app.conf')).toEqual(content);
    expect(fs.get('/data/appdata/app.conf.tmp.test')).toBeUndefined();
    expect(guard.getHash('/data/appdata/app.conf')).toBe(fetched.hash);
  });

  it('refuses to overwrite a data dir file edited after planning', async () => {
    const fs = new MemoryFileSystem().addFile(
      '/data/appdata/app.conf',
      'edited by hand',
    );
    await expect(
      fetchFileConflictToDataDir({
        dataDir: '/data',
        source: 'appdata/app.conf',
        content: new TextEncoder().encode('remote'),
        expectedHash: await hashContent('old'),
        fs,
      }),
    ).rejects.toThrow(WriteConflictError);
    expect(new TextDecoder().decode(fs.get('/data/appdata/app.conf'))).toBe(
      'edited by hand',
    );
  });

  it('confines fetch targets to the data dir', async () => {
    const fs = new MemoryFileSystem();
    for (const source of ['../escape.conf', '/etc/passwd', '', 'a/../../b']) {
      await expect(
        fetchFileConflictToDataDir({
          dataDir: '/data',
          source,
          content: new Uint8Array(),
          expectedHash: await hashContent(''),
          fs,
        }),
      ).rejects.toThrow(FileConflictError);
    }
  });

  it('falls back to a UTF-8 read when the file system has no binary read', async () => {
    const fs = new MemoryFileSystem().addFile('/data/app.conf', 'old');
    const textOnly: FileSystem = {
      readFile: fs.readFile.bind(fs),
      writeFile: fs.writeFile.bind(fs),
      writeBinary: fs.writeBinary.bind(fs),
      stat: fs.stat.bind(fs),
      readdir: fs.readdir.bind(fs),
      rename: fs.rename.bind(fs),
      unlink: fs.unlink.bind(fs),
    };
    const fetched = await fetchFileConflictToDataDir({
      dataDir: '/data',
      source: 'app.conf',
      content: new TextEncoder().encode('new'),
      expectedHash: await hashContent('old'),
      fs: textOnly,
    });
    expect(new TextDecoder().decode(fs.get('/data/app.conf'))).toBe('new');
    expect(fetched.hash).toBe(await hashContent('new'));
  });

  it('requires a binary write and cleans up after a failed write', async () => {
    const fs = new MemoryFileSystem().addFile('/data/app.conf', 'old');
    const noWrite: FileSystem = {
      readFile: fs.readFile.bind(fs),
      readBinary: fs.readBinary.bind(fs),
      writeFile: fs.writeFile.bind(fs),
      stat: fs.stat.bind(fs),
      readdir: fs.readdir.bind(fs),
      rename: fs.rename.bind(fs),
      unlink: fs.unlink.bind(fs),
    };
    await expect(
      fetchFileConflictToDataDir({
        dataDir: '/data',
        source: 'app.conf',
        content: new TextEncoder().encode('new'),
        expectedHash: await hashContent('old'),
        fs: noWrite,
      }),
    ).rejects.toThrow('cannot write binary files');

    const removed: string[] = [];
    const failing: FileSystem = {
      ...noWrite,
      async writeBinary() {
        throw new Error('disk full');
      },
      async unlink(path) {
        removed.push(path);
      },
    };
    await expect(
      fetchFileConflictToDataDir({
        dataDir: '/data',
        source: 'app.conf',
        content: new TextEncoder().encode('new'),
        expectedHash: await hashContent('old'),
        fs: failing,
        token: 'boom',
      }),
    ).rejects.toThrow('disk full');
    expect(removed).toEqual(['/data/app.conf.tmp.boom']);
    expect(new TextDecoder().decode(fs.get('/data/app.conf'))).toBe('old');
  });

  it('rejects a write that does not match the fetched content', async () => {
    const fs = new MemoryFileSystem().addFile('/data/app.conf', 'old');
    const corrupting: FileSystem = {
      readFile: fs.readFile.bind(fs),
      readBinary: fs.readBinary.bind(fs),
      writeFile: fs.writeFile.bind(fs),
      stat: fs.stat.bind(fs),
      readdir: fs.readdir.bind(fs),
      rename: async (oldPath, newPath) => {
        await fs.rename(oldPath, newPath);
        await fs.writeFile(newPath, 'corrupted');
      },
      unlink: fs.unlink.bind(fs),
      async writeBinary(path, content) {
        await fs.writeBinary?.(path, content);
      },
    };
    await expect(
      fetchFileConflictToDataDir({
        dataDir: '/data',
        source: 'app.conf',
        content: new TextEncoder().encode('new'),
        expectedHash: await hashContent('old'),
        fs: corrupting,
      }),
    ).rejects.toThrow('was written with hash');
  });

  it('propagates unexpected read errors', async () => {
    const fs = new MemoryFileSystem().addFile('/data/app.conf', 'old');
    const broken: FileSystem = {
      readFile: fs.readFile.bind(fs),
      readBinary: async () => {
        throw new Error('disk failure');
      },
      writeFile: fs.writeFile.bind(fs),
      stat: fs.stat.bind(fs),
      readdir: fs.readdir.bind(fs),
      rename: fs.rename.bind(fs),
      unlink: fs.unlink.bind(fs),
    };
    await expect(
      fetchFileConflictToDataDir({
        dataDir: '/data',
        source: 'app.conf',
        content: new TextEncoder().encode('new'),
        expectedHash: await hashContent('old'),
        fs: broken,
      }),
    ).rejects.toThrow('disk failure');
  });
});

describe('createFileConflictFetchStep', () => {
  const source = 'appdata/app.conf';
  const remoteContent = new TextEncoder().encode('remote version');

  it('pulls once, writes through the guard and verifies the hash', async () => {
    const fs = new MemoryFileSystem().addFile(`/data/${source}`, 'local');
    let pulls = 0;
    const step = createFileConflictFetchStep({
      dataDir: '/data',
      source,
      destination: '/etc/app.conf',
      expectedDataDirHash: await hashContent('local'),
      remoteHash: await hashContent(remoteContent),
      pull: async () => {
        pulls += 1;
        return remoteContent;
      },
      fs,
    });

    expect(await step.check(stepContext())).toMatchObject({
      status: 'required',
    });
    expect(await step.apply(stepContext())).toMatchObject({
      relativePath: source,
    });
    expect(pulls).toBe(1);
    expect(await step.verify(stepContext())).toMatchObject({
      hash: await hashContent(remoteContent),
    });
    expect(await step.check(stepContext())).toMatchObject({
      status: 'satisfied',
    });
  });

  it('does not pull in a dry run', async () => {
    const fs = new MemoryFileSystem().addFile(`/data/${source}`, 'local');
    let pulls = 0;
    const step = createFileConflictFetchStep({
      dataDir: '/data',
      source,
      destination: '/etc/app.conf',
      expectedDataDirHash: await hashContent('local'),
      remoteHash: await hashContent(remoteContent),
      pull: async () => {
        pulls += 1;
        return remoteContent;
      },
      fs,
    });

    expect(await step.apply(stepContext(true))).toEqual({ dryRun: true });
    expect(pulls).toBe(0);
    expect(new TextDecoder().decode(fs.get(`/data/${source}`))).toBe('local');
  });

  it('surfaces pull failures and post-write mismatches', async () => {
    const fs = new MemoryFileSystem().addFile(`/data/${source}`, 'local');
    const failingPull = createFileConflictFetchStep({
      dataDir: '/data',
      source,
      destination: '/etc/app.conf',
      expectedDataDirHash: await hashContent('local'),
      remoteHash: await hashContent(remoteContent),
      pull: async () => {
        throw new Error('guest unreachable');
      },
      fs,
    });
    await expect(failingPull.apply(stepContext())).rejects.toThrow(
      'guest unreachable',
    );

    const step = createFileConflictFetchStep({
      dataDir: '/data',
      source,
      destination: '/etc/app.conf',
      expectedDataDirHash: await hashContent('local'),
      remoteHash: await hashContent(remoteContent),
      pull: async () => remoteContent,
      fs,
    });
    await step.apply(stepContext());
    await fs.writeBinary?.(
      `/data/${source}`,
      new TextEncoder().encode('tampered'),
    );
    await expect(step.verify(stepContext())).rejects.toThrow(
      'instead of the planned',
    );
  });

  it('rethrows unexpected read errors during the check', async () => {
    const fs = new MemoryFileSystem().addFile(`/data/${source}`, 'local');
    const step = createFileConflictFetchStep({
      dataDir: '/data',
      source,
      destination: '/etc/app.conf',
      expectedDataDirHash: await hashContent('local'),
      remoteHash: await hashContent(remoteContent),
      pull: async () => remoteContent,
      fs: {
        readFile: fs.readFile.bind(fs),
        readBinary: async () => {
          throw new Error('disk failure');
        },
        writeFile: fs.writeFile.bind(fs),
        stat: fs.stat.bind(fs),
        readdir: fs.readdir.bind(fs),
        rename: fs.rename.bind(fs),
        unlink: fs.unlink.bind(fs),
      },
    });
    await expect(step.check(stepContext())).rejects.toThrow('disk failure');
  });
});

function guest(): GuestDeployment {
  return {
    schema_version: 1,
    id: 112,
    name: 'example',
    type: 'lxc',
    unprivileged: true,
    cpu: 2,
    ram: 1024,
    disks: [],
    network: [],
  } as unknown as GuestDeployment;
}

function planOptions(
  fs: FileSystem,
  conflictPolicy: 'overwrite' | 'skip' | 'fetch' | 'prompt',
  options: Record<string, unknown> = {},
) {
  const filemappings: FilemappingsFile = {
    schema_version: 1,
    mappings: [
      {
        type: 'file',
        source: 'appdata/app.conf',
        destination: '/etc/app.conf',
        conflict: conflictPolicy,
      },
    ],
  };
  return {
    dataDir: '/data',
    hostId: 'pve-01',
    guest: guest(),
    filemappings,
    fs,
    planId: 'plan-conflict',
    ...options,
  };
}

describe('planFilemappings conflicts', () => {
  const localHash = hashContent('local');
  const remoteHash = hashContent('remote');

  it('overwrites only after warning when the policy says so', async () => {
    const fs = new MemoryFileSystem().addFile(
      '/data/appdata/app.conf',
      'local',
    );
    const plan = await planFilemappings(
      planOptions(fs, 'overwrite', {
        remote: { '/etc/app.conf': { hash: await remoteHash } },
      }),
    );
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({
      action: 'update',
      path: '/etc/app.conf',
    });
    expect(plan.warnings.join('\n')).toContain('policy overwrite');
  });

  it('skips a conflicting file and plans nothing', async () => {
    const fs = new MemoryFileSystem().addFile(
      '/data/appdata/app.conf',
      'local',
    );
    const plan = await planFilemappings(
      planOptions(fs, 'skip', {
        remote: { '/etc/app.conf': { hash: await remoteHash } },
      }),
    );
    expect(plan.changes.map((change) => change.id)).toEqual(['noop']);
    expect(plan.warnings.join('\n')).toContain('policy skip');
  });

  it('plans a fetch into the data dir with hashes only', async () => {
    const fs = new MemoryFileSystem().addFile(
      '/data/appdata/app.conf',
      'local',
    );
    const plan = await planFilemappings(
      planOptions(fs, 'fetch', {
        remote: { '/etc/app.conf': { hash: await remoteHash, size: 6 } },
      }),
    );
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({
      action: 'execute',
      path: '/etc/app.conf',
      after: {
        direction: 'fetch',
        source: 'appdata/app.conf',
        remoteHash: await remoteHash,
        expectedDataDirHash: await localHash,
      },
    });
    expect(
      plan.changes[0]!.after as Record<string, unknown>,
    ).not.toHaveProperty('content');
  });

  it('plans a prompt that pauses the job', async () => {
    const fs = new MemoryFileSystem().addFile(
      '/data/appdata/app.conf',
      'local',
    );
    const plan = await planFilemappings(
      planOptions(fs, 'prompt', {
        remote: { '/etc/app.conf': { hash: await remoteHash } },
      }),
    );
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({
      action: 'execute',
      after: { requiresPrompt: true, allowFetch: true },
    });
    expect(plan.warnings.join('\n')).toContain('policy prompt');
  });

  it('applies a normal update when the remote still matches the baseline', async () => {
    const fs = new MemoryFileSystem().addFile(
      '/data/appdata/app.conf',
      'local',
    );
    const plan = await planFilemappings(
      planOptions(fs, 'prompt', {
        remote: { '/etc/app.conf': { hash: await remoteHash } },
        baseline: { '/etc/app.conf': await remoteHash },
      }),
    );
    expect(plan.changes[0]).toMatchObject({ action: 'update' });
    expect(plan.warnings).toEqual([]);
  });

  it('rejects fetch for rendered .env conflicts', async () => {
    const fs = new MemoryFileSystem().addFile(
      '/data/hosts/pve-01/112-example/.env.yaml',
      'schema_version: 1\nvalues:\n  APP_PORT: "8080"\n',
    );
    const options = planOptions(fs, 'fetch', {
      remote: { '/opt/app/.env': { hash: await remoteHash } },
    });
    options.filemappings = {
      schema_version: 1,
      mappings: [
        {
          type: 'template',
          source: '.env.yaml',
          destination: '/opt/app/.env',
          conflict: 'fetch',
        },
      ],
    };
    await expect(
      planFilemappings({
        ...options,
        renderEnv: async () => ({
          content: new Secret('APP_PORT="8080"\n'),
          hash: await localHash,
          mode: '0600',
          variables: ['APP_PORT'],
          size: 15,
        }),
      }),
    ).rejects.toThrow('may never be fetched back into the data dir');
  });
});
