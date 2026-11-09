import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataDirWatcher } from '@hacm/core';
import { createDatabase, createSqliteRepositories } from '../db/index.js';
import { HostRegistry } from './registry.js';

let directory: string;
let database: ReturnType<typeof createDatabase>;
let repos: ReturnType<typeof createSqliteRepositories>;
let registry: HostRegistry;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hacm-host-lifecycle-'));
  database = createDatabase({ path: ':memory:' });
  repos = createSqliteRepositories(database.db);
  registry = new HostRegistry({ dataDir: directory, repos });
});
afterEach(async () => {
  registry.close();
  database.close();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
async function host(id: string, index = 1, extra = '') {
  await mkdir(join(directory, 'hosts', id), { recursive: true });
  await writeFile(
    join(directory, 'hosts', id, 'host.yaml'),
    `schema_version: 1\nid: ${id}\nname: ${id}\ntype: proxmox\nindex: ${index}\nconnection:\n  ssh:\n    host: 192.0.2.10\n${extra}`,
  );
}

describe('host registry access and rescan lifecycle', () => {
  it('filters hosts by grants, auto-grants eligible users, and keeps runtime updates across rescans', async () => {
    const user = await repos.users.create({
      id: 'fixture-user',
      username: 'fixture-user',
      passwordHash: 'fake-hash',
      role: 'viewer',
      autoGrantNewHosts: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await host('alpha', 1, '    password: fake-password\n');
    await host('beta', 2);
    const first = registry.sync();
    expect((await registry.sync()).synced).toBe(0);
    await first;
    expect((await registry.listHosts(user)).map((entry) => entry.id)).toEqual([
      'alpha',
      'beta',
    ]);
    await repos.userHostAccess.revoke(user.id, 'beta');
    expect((await registry.listHosts(user)).map((entry) => entry.id)).toEqual([
      'alpha',
    ]);
    expect(await registry.getHost('beta', user)).toBeUndefined();
    expect(
      (await registry.getHost('alpha', user))?.connection.ssh.authMethod,
    ).toBe('password');
    expect(await registry.getHost('missing')).toBeUndefined();
    expect((await registry.listHosts({ ...user, role: 'admin' })).length).toBe(
      2,
    );
    registry.updateRuntimeStatus('alpha', {
      overall: 'healthy',
      ssh: { status: 'connected' },
      api: { configured: false, status: 'unknown' },
      vault: { status: 'unlocked' },
      queue: { status: 'busy' },
      issues: ['fixture warning'],
    });
    await registry.sync();
    expect((await registry.getHost('alpha'))?.runtime).toMatchObject({
      overall: 'healthy',
      vault: { status: 'unlocked' },
    });
    registry.updateRuntimeStatus('alpha', {});
    registry.updateRuntimeStatus('missing', {});
  });

  it('watches host changes only and closes its watcher', async () => {
    const empty = {
      dataDir: directory,
      hosts: [],
      globalTasks: [],
      fileHashes: {},
      versionHash: 'fixture',
    };
    const start = vi
      .spyOn(DataDirWatcher.prototype, 'start')
      .mockResolvedValue({ dataDir: empty, issues: [] });
    const close = vi.spyOn(DataDirWatcher.prototype, 'close');
    registry.close();
    registry = new HostRegistry({ dataDir: directory, repos, autoWatch: true });
    const watcher = start.mock.contexts[0] as DataDirWatcher;
    const sync = vi
      .spyOn(registry, 'sync')
      .mockResolvedValue({ synced: 0, removed: 0, issues: [] });
    for (const file of [
      'hosts/alpha/host.yaml',
      'hosts\\alpha\\host.yaml',
      'hosts',
    ])
      watcher!.emit('change', { changedFiles: [file] });
    watcher!.emit('change', { changedFiles: ['global-tasks/fixture.yaml'] });
    expect(sync).toHaveBeenCalledTimes(3);
    registry.close();
    expect(close).toHaveBeenCalled();
  });

  it('keeps invalid host definitions out of the operational cache', async () => {
    await host('invalid');
    await writeFile(
      join(directory, 'hosts/invalid/host.yaml'),
      'schema_version: 99\nid: invalid\n',
    );
    expect((await registry.sync()).issues.length).toBeGreaterThan(0);
    expect(await registry.listHosts()).toEqual([]);
  });
});
