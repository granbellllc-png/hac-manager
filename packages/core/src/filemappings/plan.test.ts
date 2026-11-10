import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashContent } from '../data-dir/hash.js';
import { renderEnvFile } from '../env/render.js';
import { mergeGuestDeployment } from '../merge/guest-merge.js';
import { mergeGuestFilemappings } from '../merge/guest-merge.js';
import { PlanValidationError } from '../plans/types.js';
import type {
  DeploymentDefaultsFile,
  GuestDeployment,
  GuestDeploymentFile,
} from '../schema/deployment.js';
import type { FilemappingsFile } from '../schema/filemappings.js';
import type { FileStat, FileSystem } from '../yaml/file.js';
import { loadYamlDocument, yamlDocumentToJS } from '../yaml/index.js';
import {
  archiveFormat,
  planFilemappings,
  type FileMappingPlanOptions,
} from './plan.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const examplesData = join(repoRoot, 'examples/data');
const goldenPath = resolve(
  import.meta.dirname,
  '../../fixtures/plans/filemappings-example-plan.json',
);
const fixedCreatedAt = new Date('2026-11-10T12:00:00.000Z');

function loadYamlObject<T>(content: string): T {
  return yamlDocumentToJS<T>(loadYamlDocument(content));
}

async function examplePlan(): Promise<FileMappingPlanOptions> {
  const hostDir = join(examplesData, 'hosts/example-host');
  const guestDir = join(hostDir, '112-example-lxc');
  const defaults = loadYamlObject<DeploymentDefaultsFile>(
    await readFile(join(hostDir, 'default-deployment.yaml'), 'utf8'),
  );
  const guest = loadYamlObject<GuestDeploymentFile>(
    await readFile(join(guestDir, 'deployment.yaml'), 'utf8'),
  );
  const merged = mergeGuestDeployment({
    defaultDeployment: {
      file: 'hosts/example-host/default-deployment.yaml',
      data: defaults,
    },
    guestDeployment: {
      file: 'hosts/example-host/112-example-lxc/deployment.yaml',
      data: guest,
    },
  });
  const defaultMappings = loadYamlObject<FilemappingsFile>(
    await readFile(join(hostDir, 'default-filemappings.yaml'), 'utf8'),
  );
  const guestMappings = loadYamlObject<FilemappingsFile>(
    await readFile(join(guestDir, 'filemappings.yaml'), 'utf8'),
  );
  const mergedMappings = mergeGuestFilemappings({
    defaultFilemappings: {
      file: 'hosts/example-host/default-filemappings.yaml',
      data: defaultMappings,
    },
    guestFilemappings: {
      file: 'hosts/example-host/112-example-lxc/filemappings.yaml',
      data: guestMappings,
    },
  });
  return {
    dataDir: examplesData,
    hostId: 'example-host',
    guest: merged.deployment,
    filemappings: mergedMappings.filemappings,
    renderEnv: ({ text }) =>
      renderEnvFile(loadYamlObject<unknown>(text), {
        dataDir: examplesData,
        secretProvider: {
          resolveSecret: (key) =>
            key === 'example_db_password'
              ? { status: 'found' as const, value: 'example-secret-value' }
              : { status: 'not_found' as const },
        },
      }),
    planId: 'plan-filemappings-example',
    createdAt: fixedCreatedAt,
  };
}

class MemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, Uint8Array>();
  private readonly directories = new Set<string>(['/']);
  private readonly failures = new Set<string>();

  public fail(path: string): this {
    this.failures.add(path);
    return this;
  }

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

  public addDirectory(path: string): this {
    this.directories.add(path);
    return this;
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

  public async writeFile(): Promise<void> {
    throw new Error('not used');
  }

  public async stat(path: string): Promise<FileStat> {
    if (this.failures.has(path)) throw new Error(`stat failed: ${path}`);
    if (this.files.has(path)) {
      return {
        mode: 0o644,
        isDirectory: () => false,
        isFile: () => true,
      };
    }
    if (this.directories.has(path)) {
      return {
        mode: 0o755,
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

  public async rename(): Promise<void> {
    throw new Error('not used');
  }

  public async unlink(): Promise<void> {
    throw new Error('not used');
  }
}

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
}

function guest(overrides: Record<string, unknown> = {}): GuestDeployment {
  const base: Record<string, unknown> = {
    schema_version: 1,
    id: 112,
    name: 'example',
    type: 'lxc',
    unprivileged: true,
    cpu: 2,
    ram: 1024,
    disks: [],
    network: [],
    ...overrides,
  };
  if (base['type'] === 'vm') delete base['unprivileged'];
  return base as unknown as GuestDeployment;
}

function mappings(entries: readonly unknown[]): FilemappingsFile {
  return {
    schema_version: 1,
    mappings: entries as FilemappingsFile['mappings'],
  };
}

function planOptions(
  fs: FileSystem,
  filemappings: FilemappingsFile,
  options: Partial<FileMappingPlanOptions> = {},
): FileMappingPlanOptions {
  return {
    dataDir: '/data',
    hostId: 'pve-01',
    guest: guest(),
    filemappings,
    fs,
    planId: 'plan-test',
    createdAt: fixedCreatedAt,
    ...options,
  };
}

describe('planFilemappings', () => {
  it('matches the golden plan for examples/data', async () => {
    const plan = await planFilemappings(await examplePlan());
    expect(plan.operation).toBe('files.sync');
    expect(plan.changes).toHaveLength(2);
    expect(plan.warnings).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain('example-secret-value');
    expect(JSON.parse(await readFile(goldenPath, 'utf8'))).toEqual(
      JSON.parse(JSON.stringify(plan)),
    );
  });

  it('renders .env templates with the rendered hash and 0600', async () => {
    const fs = new MemoryFileSystem();
    fs.addFile(
      '/data/hosts/pve-01/112-example/.env.yaml',
      'schema_version: 1\nvalues:\n  APP_PORT: "8080"\n  DB_PASSWORD: !secret db\n',
    );
    const plan = await planFilemappings(
      planOptions(
        fs,
        mappings([
          {
            type: 'template',
            source: '.env.yaml',
            destination: '/opt/app/.env',
            mode: '0600',
            conflict: 'prompt',
          },
        ]),
        {
          renderEnv: ({ text }) =>
            renderEnvFile(loadYamlObject<unknown>(text), {
              dataDir: '/data',
              secretProvider: {
                resolveSecret: () => ({
                  status: 'found' as const,
                  value: 's3cr3t-value',
                }),
              },
            }),
        },
      ),
    );

    expect(plan.changes).toHaveLength(1);
    const change = plan.changes[0]!;
    expect(change).toMatchObject({
      id: 'mapping-0',
      action: 'create',
      path: '/opt/app/.env',
      after: {
        mode: '0600',
        render: 'dotenv',
        mappingType: 'template',
        variables: ['APP_PORT', 'DB_PASSWORD'],
        target: { kind: 'guest', path: '/opt/app/.env' },
      },
    });
    expect(JSON.stringify(plan)).not.toContain('s3cr3t-value');
    expect(JSON.stringify(plan)).not.toContain('DB_PASSWORD="');
    expect(JSON.stringify(plan)).toContain(
      (change.after as { hash: string }).hash,
    );
  });

  it('skips an unchanged rendered .env and re-creates a wrongly chmodded one', async () => {
    const fs = new MemoryFileSystem();
    const envYaml = 'schema_version: 1\nvalues:\n  APP_PORT: "8080"\n';
    fs.addFile('/data/hosts/pve-01/112-example/.env.yaml', envYaml);
    const renderEnv = ({ text }: { text: string }) =>
      renderEnvFile(loadYamlObject<unknown>(text), { dataDir: '/data' });
    const rendered = await renderEnv({ text: envYaml });
    const mapping = {
      type: 'template',
      source: '.env.yaml',
      destination: '/opt/app/.env',
      conflict: 'prompt',
    } as const;

    const unchanged = await planFilemappings(
      planOptions(fs, mappings([mapping]), {
        renderEnv,
        remote: {
          '/opt/app/.env': { hash: rendered.hash, mode: '0600' },
        },
      }),
    );
    expect(unchanged.changes.map((change) => change.id)).toEqual(['noop']);

    const wrongMode = await planFilemappings(
      planOptions(fs, mappings([mapping]), {
        renderEnv,
        remote: {
          '/opt/app/.env': { hash: rendered.hash, mode: '0644' },
        },
      }),
    );
    expect(wrongMode.changes).toHaveLength(1);
    expect(wrongMode.changes[0]?.action).toBe('update');
    expect(wrongMode.changes[0]?.summary).toContain('rendered dotenv');
  });

  it('rejects unsafe rendered .env targets', async () => {
    const fs = new MemoryFileSystem();
    fs.addFile(
      '/data/hosts/pve-01/112-example/.env.yaml',
      'schema_version: 1\nvalues:\n  APP_PORT: "8080"\n',
    );
    const renderEnv = ({ text }: { text: string }) =>
      renderEnvFile(loadYamlObject<unknown>(text), { dataDir: '/data' });
    const base = {
      type: 'template',
      source: '.env.yaml',
      conflict: 'prompt',
    } as const;

    await expect(
      planFilemappings(
        planOptions(fs, mappings([{ ...base, destination: '/opt/app/env' }]), {
          renderEnv,
        }),
      ),
    ).rejects.toThrow("may only target a file named '.env'");

    await expect(
      planFilemappings(
        planOptions(
          fs,
          mappings([{ ...base, destination: '/opt/app/.env', mode: '0644' }]),
          { renderEnv },
        ),
      ),
    ).rejects.toThrow('rendered .env files are always 0600');

    await expect(
      planFilemappings(
        planOptions(fs, mappings([{ ...base, destination: '/opt/app/.env' }]), {
          renderEnv: undefined,
        }),
      ),
    ).rejects.toThrow('needs a tag resolution context');

    const mountedFs = new MemoryFileSystem();
    mountedFs.addFile(
      '/data/hosts/pve-01/112-example/.env.yaml',
      'schema_version: 1\nvalues:\n  APP_PORT: "8080"\n',
    );
    await expect(
      planFilemappings(
        planOptions(
          mountedFs,
          mappings([{ ...base, destination: '/data/.env' }]),
          { renderEnv },
        ),
      ),
    ).rejects.toThrow('may not be written into the data dir');
  });

  it('warns for a template that is not a tracked .env.yaml', async () => {
    const fs = new MemoryFileSystem();
    fs.addFile('/data/templates/app.conf.tpl', 'listen $PORT;\n');
    const plan = await planFilemappings(
      planOptions(
        fs,
        mappings([
          {
            type: 'template',
            source: 'templates/app.conf.tpl',
            destination: '/etc/app.conf',
            conflict: 'prompt',
          },
        ]),
      ),
    );
    expect(plan.changes).toHaveLength(1);
    expect(plan.warnings.join('\n')).toContain('not a tracked .env.yaml');
  });

  it('warns when a source is missing and still returns a viewable plan', async () => {
    const fs = new MemoryFileSystem();
    const plan = await planFilemappings(
      planOptions(
        fs,
        mappings([
          {
            type: 'file',
            source: 'appdata/missing.conf',
            destination: '/etc/missing.conf',
            conflict: 'prompt',
          },
        ]),
      ),
    );
    expect(plan.changes).toEqual([
      {
        id: 'noop',
        action: 'execute',
        summary: 'No file changes were planned',
      },
    ]);
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('was not found under the guest folder'),
        'No file changes were planned.',
      ]),
    );
  });

  it('prefers the guest folder over the data dir and writes mp0 paths directly', async () => {
    const fs = new MemoryFileSystem()
      .addFile('/data/appdata/app.conf', 'data-root')
      .addFile('/data/hosts/pve-01/112-example/appdata/app.conf', 'guest');
    const plan = await planFilemappings(
      planOptions(
        fs,
        mappings([
          {
            type: 'file',
            source: 'appdata/app.conf',
            destination: '/opt/example/app.conf',
            mode: '0600',
            owner: '1000',
            group: '1001',
            conflict: 'overwrite',
          },
        ]),
        {
          guest: guest({
            mounts: [
              {
                index: 0,
                host_path: '/opt/server-data/pve-01/example/opt',
                guest_path: '/opt',
                permissions: 'minimal',
              },
            ],
          }),
        },
      ),
    );

    const change = plan.changes[0]!;
    expect(change.action).toBe('create');
    expect(change.path).toBe('/opt/example/app.conf');
    expect(change.after).toMatchObject({
      hash: await hashContent('guest'),
      mode: '0600',
      target: {
        kind: 'host',
        path: '/opt/server-data/pve-01/example/opt/example/app.conf',
        guestPath: '/opt/example/app.conf',
        mountIndex: 0,
      },
      hostOwner: { uid: 101000, gid: 101001 },
    });
  });

  it('plans directory creates, updates and destructive deletes', async () => {
    const fs = new MemoryFileSystem()
      .addFile('/data/hosts/pve-01/112-example/appdata/config/a.conf', 'new-a')
      .addFile(
        '/data/hosts/pve-01/112-example/appdata/config/nested/b.conf',
        'same-b',
      );
    const directoryMapping = {
      type: 'directory' as const,
      source: 'appdata/config',
      destination: '/srv/config',
      delete: true,
      conflict: 'prompt' as const,
    };
    const options = planOptions(fs, mappings([directoryMapping]), {
      baseline: {
        '/srv/config/a.conf': await hashContent('old-a'),
        '/srv/config/nested/b.conf': await hashContent('same-b'),
        '/srv/config/stale.conf': await hashContent('stale'),
      },
      remote: {
        '/srv/config/a.conf': { hash: await hashContent('old-a'), size: 5 },
        '/srv/config/nested/b.conf': {
          hash: await hashContent('same-b'),
          size: 6,
        },
        '/srv/config/stale.conf': { hash: await hashContent('stale') },
        '/srv/config-other/keep.conf': { hash: await hashContent('keep') },
      },
      confirmationText: 'delete /srv/config',
    });

    const plan = await planFilemappings(options);
    expect(plan.destructive).toBe(true);
    expect(plan.confirmationText).toBe('delete /srv/config');
    expect(plan.changes.map((change) => [change.action, change.path])).toEqual([
      ['update', '/srv/config/a.conf'],
      ['delete', '/srv/config/stale.conf'],
    ]);
    expect(plan.changes[1]).toMatchObject({
      destructive: true,
      before: { hash: await hashContent('stale') },
      after: null,
    });
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('will delete 1 file(s)'),
      ]),
    );
    expect(plan.changes.some((change) => change.path?.includes('keep'))).toBe(
      false,
    );

    await expect(
      planFilemappings({ ...options, confirmationText: undefined }),
    ).rejects.toBeInstanceOf(PlanValidationError);
  });

  it('hashes binary archives and records their format', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const fs = new MemoryFileSystem().addFile(
      '/data/bundles/app.tar.gz',
      bytes,
    );
    const plan = await planFilemappings(
      planOptions(
        fs,
        mappings([
          {
            type: 'archive',
            source: 'bundles/app.tar.gz',
            destination: '/opt/app',
            conflict: 'prompt',
          },
        ]),
      ),
    );
    expect(plan.changes[0]!.after).toMatchObject({
      hash: await hashContent(bytes),
      size: bytes.byteLength,
      archive: 'tar.gz',
      mappingType: 'archive',
    });
    expect(archiveFormat('app.tgz')).toBe('tgz');
    expect(archiveFormat('app.tar.bz2')).toBe('tar.bz2');
    expect(archiveFormat('app.tar.xz')).toBe('tar.xz');
    expect(archiveFormat('app.zip')).toBe('zip');
    expect(archiveFormat('app.conf')).toBeUndefined();
  });

  it('warns about templates and unresolved includes', async () => {
    const fs = new MemoryFileSystem().addFile(
      '/data/templates/app.env',
      'TOKEN=${TOKEN}',
    );
    const plan = await planFilemappings(
      planOptions(
        fs,
        mappings([
          {
            type: 'template',
            source: 'templates/app.env',
            destination: '/opt/app/.env',
            mode: '0600',
            conflict: 'prompt',
          },
          { tag: 'include', value: 'extra-mappings.yaml' },
        ]),
      ),
    );
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('not a tracked .env.yaml'),
        expect.stringContaining('unresolved !include'),
      ]),
    );
    expect(plan.changes[0]!.action).toBe('create');
  });

  it('leaves an existing identical file out of the plan', async () => {
    const content = 'unchanged';
    const fs = new MemoryFileSystem().addFile(
      '/data/appdata/app.conf',
      content,
    );
    const plan = await planFilemappings(
      planOptions(
        fs,
        mappings([
          {
            type: 'file',
            source: 'appdata/app.conf',
            destination: '/etc/app.conf',
            conflict: 'prompt',
          },
        ]),
        {
          remote: {
            '/etc/app.conf': { hash: await hashContent(content), size: 9 },
          },
        },
      ),
    );
    expect(plan.changes[0]!.id).toBe('noop');
    expect(plan.warnings).toContain('No file changes were planned.');
  });

  it('keeps VM destinations inside the guest', async () => {
    const fs = new MemoryFileSystem().addFile('/data/appdata/app.conf', 'vm');
    const plan = await planFilemappings(
      planOptions(
        fs,
        mappings([
          {
            type: 'file',
            source: 'appdata/app.conf',
            destination: '/etc/app.conf',
            conflict: 'prompt',
          },
        ]),
        {
          guest: guest({ type: 'vm' }),
          baseline: { '/etc/app.conf': await hashContent('old') },
          remote: {
            '/etc/app.conf': { hash: await hashContent('old'), size: 3 },
          },
        },
      ),
    );
    expect(plan.changes[0]!.action).toBe('update');
    expect(plan.changes[0]!.after).toMatchObject({
      target: { kind: 'guest', path: '/etc/app.conf' },
    });
    expect(plan.destructive).toBe(false);
  });

  it('warns when a directory source is missing or unreadable', async () => {
    const fs = new MemoryFileSystem();
    const missing = await planFilemappings(
      planOptions(
        fs,
        mappings([
          {
            type: 'directory',
            source: 'appdata/missing',
            destination: '/srv/missing',
            delete: false,
            conflict: 'prompt',
          },
        ]),
      ),
    );
    expect(missing.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('source directory'),
        'No file changes were planned.',
      ]),
    );

    const failing = new MemoryFileSystem().fail(
      '/data/hosts/pve-01/112-example/appdata/boom',
    );
    await expect(
      planFilemappings(
        planOptions(
          failing,
          mappings([
            {
              type: 'directory',
              source: 'appdata/boom',
              destination: '/srv/boom',
              delete: false,
              conflict: 'prompt',
            },
          ]),
        ),
      ),
    ).rejects.toThrow('stat failed');

    const failingFile = new MemoryFileSystem().fail(
      '/data/hosts/pve-01/112-example/appdata/boom.conf',
    );
    await expect(
      planFilemappings(
        planOptions(
          failingFile,
          mappings([
            {
              type: 'file',
              source: 'appdata/boom.conf',
              destination: '/etc/boom.conf',
              conflict: 'prompt',
            },
          ]),
        ),
      ),
    ).rejects.toThrow('stat failed');
  });

  it('skips a directory found where a single file was expected', async () => {
    const fs = new MemoryFileSystem().addDirectory(
      '/data/hosts/pve-01/112-example/appdata/nested',
    );
    const plan = await planFilemappings(
      planOptions(
        fs,
        mappings([
          {
            type: 'file',
            source: 'appdata/nested',
            destination: '/etc/nested',
            conflict: 'prompt',
          },
        ]),
      ),
    );
    expect(plan.changes[0]!.id).toBe('noop');
    expect(plan.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('was not found')]),
    );
  });

  it('falls back to UTF-8 hashing when the filesystem is text only', async () => {
    const fs = new MemoryFileSystem().addFile('/data/a.conf', 'text');
    Object.defineProperty(fs, 'readBinary', { value: undefined });
    const plan = await planFilemappings(
      planOptions(
        fs,
        mappings([
          {
            type: 'file',
            source: 'a.conf',
            destination: '/etc/a.conf',
            conflict: 'prompt',
          },
        ]),
        { dataDir: '/data/\\' },
      ),
    );
    expect(plan.changes[0]!.after).toMatchObject({
      hash: await hashContent('text'),
      size: 4,
    });
  });

  it('picks the longest matching mount and handles a mount root destination', async () => {
    const fs = new MemoryFileSystem().addFile('/data/opt.conf', 'opt');
    const plan = await planFilemappings(
      planOptions(
        fs,
        mappings([
          {
            type: 'file',
            source: 'opt.conf',
            destination: '/opt',
            conflict: 'prompt',
          },
        ]),
        {
          guest: guest({
            mounts: [
              {
                index: 1,
                host_path: '/srv/shared',
                guest_path: '/',
                permissions: 'minimal',
              },
              {
                index: 0,
                host_path: '/srv/opt',
                guest_path: '/opt',
                permissions: 'minimal',
              },
            ],
          }),
        },
      ),
    );
    expect(plan.changes[0]!.after).toMatchObject({
      target: {
        kind: 'host',
        path: '/srv/opt',
        mountIndex: 0,
      },
    });
  });

  it('warns about named owners on mp0 files and hashes a real data dir', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hacm-filemappings-'));
    try {
      const guestDir = join(dataDir, 'hosts/pve-01/112-example');
      await mkdir(join(guestDir, 'appdata'), { recursive: true });
      await writeFile(join(guestDir, 'appdata/app.conf'), 'content');
      const plan = await planFilemappings({
        dataDir,
        hostId: 'pve-01',
        guest: guest({
          mounts: [
            {
              index: 0,
              host_path: '/srv/opt',
              guest_path: '/opt',
              permissions: 'minimal',
            },
          ],
        }),
        filemappings: mappings([
          {
            type: 'file',
            source: 'appdata/app.conf',
            destination: '/opt/app.conf',
            owner: 'app',
            group: '1000',
            conflict: 'prompt',
          },
        ]),
        planId: 'plan-real',
        createdAt: fixedCreatedAt,
      });
      expect(plan.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('named owner')]),
      );
      expect(plan.changes[0]!.after).toMatchObject({
        hostOwner: { uid: 100000, gid: 101000 },
        mode: '0644',
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
