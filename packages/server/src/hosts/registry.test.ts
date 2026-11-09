import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostRegistry } from './registry.js';
import { createDatabase, createSqliteRepositories } from '../db/index.js';

describe('HostRegistry', () => {
  it('syncs hosts from data directory and handles host lifecycle', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'hacm-host-registry-test-'));
    const hostsDir = join(tempDir, 'hosts');
    const host1Dir = join(hostsDir, 'alpha-host');
    await mkdir(host1Dir, { recursive: true });

    await writeFile(
      join(host1Dir, 'host.yaml'),
      `schema_version: 1
id: alpha-host
name: Alpha Host
type: proxmox
index: 1
connection:
  ssh:
    host: 192.168.1.10
    port: 22
    username: root
    private_key: !secret ssh_key
  api:
    url: https://192.168.1.10:8006
    token_id: root@pam!hacm
    token_secret: !secret api_token
`,
      'utf8',
    );

    const dbHandle = createDatabase({ path: ':memory:' });
    const repos = createSqliteRepositories(dbHandle.db);
    const registry = new HostRegistry({ dataDir: tempDir, repos });

    try {
      const syncResult = await registry.sync();
      expect(syncResult.synced).toBe(1);
      expect(syncResult.removed).toBe(0);
      expect(syncResult.issues).toEqual([]);

      const hosts = await registry.listHosts();
      expect(hosts).toHaveLength(1);
      expect(hosts[0]?.id).toBe('alpha-host');
      expect(hosts[0]?.index).toBe(1);
      expect(hosts[0]?.status).toBe('unknown');

      const detail = await registry.getHost('alpha-host');
      expect(detail).toBeDefined();
      expect(detail?.name).toBe('Alpha Host');
      expect(detail?.connection.ssh.authMethod).toBe('key');
      expect(detail?.connection.api?.configured).toBe(true);
      // Secrets must NOT be in the connection output
      expect(
        (detail?.connection.ssh as unknown as Record<string, unknown>)
          .private_key,
      ).toBeUndefined();
      expect(
        (detail?.connection.api as unknown as Record<string, unknown>)
          ?.token_secret,
      ).toBeUndefined();

      // Verify DB cache
      const cached = await repos.hostsCache.get('alpha-host');
      expect(cached).toBeDefined();
      expect(cached?.name).toBe('Alpha Host');
      expect(cached?.cachedConfigJson).not.toContain('!secret');

      // Add a second host with a DUPLICATE host.index
      const host2Dir = join(hostsDir, 'beta-host');
      await mkdir(host2Dir, { recursive: true });
      await writeFile(
        join(host2Dir, 'host.yaml'),
        `schema_version: 1
id: beta-host
name: Beta Host
type: proxmox
index: 1
connection:
  ssh:
    host: 192.168.1.11
    port: 22
`,
        'utf8',
      );

      const syncResult2 = await registry.sync();
      expect(
        syncResult2.issues.some((i) => i.includes('duplicate host.index')),
      ).toBe(true);
      const betaHost = await registry.getHost('beta-host');
      expect(betaHost?.status).toBe('error');
      expect(
        betaHost?.runtime.issues.some((i) =>
          i.includes('duplicate host.index'),
        ),
      ).toBe(true);

      // Now remove alpha-host directory
      await rm(host1Dir, { recursive: true, force: true });
      const syncResult3 = await registry.sync();
      expect(syncResult3.removed).toBe(1);

      const cachedAfterRemove = await repos.hostsCache.get('alpha-host');
      expect(cachedAfterRemove).toBeNull();
    } finally {
      registry.close();
      dbHandle.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
