import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretManager } from '@hacm/core';
import { createDatabase, createSqliteRepositories } from '../db/index.js';
import { HostRegistry } from '../hosts/registry.js';
import { SshPool } from '../ssh/pool.js';
import { HostConnectionRouter } from './router.js';
import { ConnectionManager } from './manager.js';

let directory: string;
let database: ReturnType<typeof createDatabase>;
let registry: HostRegistry;
let manager: ConnectionManager;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hacm-connection-manager-'));
  database = createDatabase({ path: ':memory:' });
  registry = new HostRegistry({
    dataDir: directory,
    repos: createSqliteRepositories(database.db),
  });
  manager = new ConnectionManager({
    dataDir: directory,
    hostRegistry: registry,
  });
});
afterEach(async () => {
  await manager.close();
  registry.close();
  database.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe('connection manager credential and lifecycle boundaries', () => {
  it('supports ticket fallback when computed token fields are empty', async () => {
    await mkdir(join(directory, 'hosts/fixture'), { recursive: true });
    await writeFile(
      join(directory, 'hosts/fixture/host.yaml'),
      'schema_version: 1\nid: fixture\nname: Fixture\ntype: proxmox\nindex: 1\nconnection:\n  ssh:\n    host: 192.0.2.10\n    username: !expr "null"\n    password: !expr "null"\n  api:\n    url: https://fixture.invalid\n    token_id: !expr "null"\n    token_secret: !expr "null"\n    ca_file: fixture-ca\n',
    );
    await registry.sync();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).endsWith('/access/ticket')
        ? Response.json({
            data: {
              ticket: 'fixture-ticket',
              CSRFPreventionToken: 'fixture-csrf',
            },
          })
        : Response.json({ data: [] }),
    );
    vi.stubGlobal('fetch', fetchFn);
    const client = await manager.getApiClient('fixture');
    await client!.getNodes();
    expect(manager.sshPool.get('fixture')?.config.username).toBe('root');
    expect(fetchFn.mock.calls[0]?.[1]?.body).toBe(
      'username=root%40pam&password=',
    );
  });
  it('unwraps secret credentials only for the transport and caches a host router', async () => {
    await mkdir(join(directory, 'hosts/fixture'), { recursive: true });
    await writeFile(
      join(directory, 'hosts/fixture/host.yaml'),
      'schema_version: 1\nid: fixture\nname: Fixture\ntype: proxmox\nindex: 1\nconnection:\n  ssh:\n    host: 192.0.2.10\n    private_key: !secret ssh-key\n    password: !secret password\n  api:\n    url: https://fixture.invalid\n    token_id: !secret token-id\n    token_secret: !secret token-secret\n',
    );
    await writeFile(
      join(directory, 'secrets.yaml'),
      'schema_version: 1\nvalues:\n  ssh-key: fake-private-key\n  password: fake-password\n  token-id: fixture!test\n  token-secret: fake-token\n',
    );
    await registry.sync();
    const router = await manager.getRouter('fixture');
    expect(await manager.getRouter('fixture')).toBe(router);
    const transport = manager.sshPool.get('fixture');
    expect(transport?.config.privateKey).toBe('fake-private-key');
    expect(transport?.config.password).toBe('fake-password');
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [] }));
    // Rebuild with the isolated fetch fixture before constructing the API client.
    await manager.close();
    vi.stubGlobal('fetch', fetchFn);
    const client = await manager.getApiClient('fixture');
    await client!.getNodes();
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'PVEAPIToken=fixture!test=fake-token',
    });
    await expect(manager.getRouter('absent')).rejects.toThrow('not found');
  });

  it('supports a plain SSH-only host with injected dependencies', async () => {
    await mkdir(join(directory, 'hosts/fixture'), { recursive: true });
    await writeFile(
      join(directory, 'hosts/fixture/host.yaml'),
      'schema_version: 1\nid: fixture\nname: Fixture\ntype: proxmox\nindex: 1\nconnection:\n  ssh:\n    host: 192.0.2.10\n    username: fixture-user\n    password: fake-password\n',
    );
    await registry.sync();
    await manager.close();
    manager = new ConnectionManager({
      dataDir: directory,
      hostRegistry: registry,
      secretManager: new SecretManager({ dataDir: directory }),
      sshPool: new SshPool(),
    });
    const router = await manager.getRouter('fixture');
    expect(router.client).toBeUndefined();
    expect(manager.sshPool.get('fixture')?.config.username).toBe(
      'fixture-user',
    );
    expect(manager.sshPool.get('fixture')?.config.privateKey).toBeUndefined();
  });

  it.each([
    {
      ok: true,
      ssh: { ok: true, status: 'connected' as const },
      expected: 'healthy',
    },
    {
      ok: false,
      ssh: { ok: false, status: 'unreachable' as const },
      expected: 'unreachable',
    },
    {
      ok: true,
      ssh: { ok: true, status: 'connected' as const },
      api: { ok: false, status: 'unreachable' as const },
      expected: 'degraded',
    },
    {
      ok: true,
      ssh: { ok: true, status: 'connected' as const },
      api: { ok: true, status: 'connected' as const },
      expected: 'healthy',
    },
  ])(
    'updates cached host health to $expected',
    async ({ expected, ...result }) => {
      const router = new HostConnectionRouter('fixture');
      vi.spyOn(router, 'testConnection').mockResolvedValue(result);
      const update = vi.spyOn(registry, 'updateRuntimeStatus');
      manager.registerRouter('fixture', router);
      expect(await manager.testConnection('fixture')).toEqual(result);
      expect(update).toHaveBeenCalledWith(
        'fixture',
        expect.objectContaining({ overall: expected }),
      );
    },
  );
});
