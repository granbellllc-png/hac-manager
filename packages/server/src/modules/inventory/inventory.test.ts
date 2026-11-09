import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../config.js';
import { buildApp } from '../../app.js';
import { createDatabase, createSqliteRepositories } from '../../db/index.js';
import { HostRegistry } from '../../hosts/registry.js';
import { ConnectionManager } from '../../router/manager.js';
import { LiveInventoryService } from '../../inventory/service.js';
import type { HostConnectionRouter } from '../../router/router.js';
import type { ProxmoxClient } from '../../proxmox/client.js';
import {
  SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CSRF_COOKIE_NAME,
} from '../../auth/session.js';

function parseCookie(
  cookieHeader: string | string[] | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  const headers = Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader];
  for (const h of headers) {
    const match = h.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (match) return match[1];
  }
  return undefined;
}

describe('Inventory API endpoints', () => {
  it('lists inventory hosts, guests, guest details, and triggers refresh', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'hacm-inv-api-test-'));
    const stateDir = await mkdtemp(join(tmpdir(), 'hacm-inv-state-test-'));
    const hostsDir = join(tempDir, 'hosts');
    const h1Dir = join(hostsDir, 'pve-01');
    const configuredGuestDir = join(h1Dir, '112-adguard-lxc');
    await mkdir(h1Dir, { recursive: true });
    await mkdir(configuredGuestDir, { recursive: true });

    await writeFile(
      join(h1Dir, 'host.yaml'),
      `schema_version: 1
id: pve-01
name: Proxmox Node 1
type: proxmox
index: 1
connection:
  ssh:
    host: 192.168.1.51
    port: 22
    username: root
`,
      'utf8',
    );

    const configuredYaml = `# This comment and tag must reach the read-only editor unchanged.
schema_version: 1
id: 112
name: adguard-lxc
type: lxc
cpu: !expr "host.index + 1"
`;
    await writeFile(
      join(configuredGuestDir, 'deployment.yaml'),
      configuredYaml,
      'utf8',
    );

    const config = loadConfig({
      HACM_DATA_DIR: tempDir,
      HACM_STATE_DIR: stateDir,
      HACM_COOKIE_SECURE: 'false',
      HACM_SESSION_SECRET: 'c'.repeat(32),
      HACM_PORT: '3123',
    });

    const dbHandle = createDatabase({ path: ':memory:' });
    const repositories = createSqliteRepositories(dbHandle.db);

    const hostRegistry = new HostRegistry({
      dataDir: tempDir,
      repos: repositories,
      autoWatch: false,
    });
    await hostRegistry.sync();

    const mockRouter = {
      health: {
        ssh: { ok: true, status: 'connected' },
        api: { ok: true, status: 'connected' },
      },
      readGuestConfig: vi.fn().mockResolvedValue({
        raw: 'hostname: adguard-lxc\ncores: 2\nmemory: 1024\nrootfs: local-lvm:vm-112-disk-0,size=8G\nnet0: name=eth0,bridge=vmbr0,ip=dhcp\n',
        source: 'ssh',
      }),
    } as unknown as HostConnectionRouter;

    const mockApiClient = {
      listLxc: vi.fn().mockResolvedValue([
        {
          vmid: 112,
          name: 'adguard-lxc',
          status: 'running',
          cpu: 0.05,
          cpus: 2,
          mem: 512 * 1024 * 1024,
          maxmem: 1024 * 1024 * 1024,
          uptime: 3600,
        },
      ]),
      listQemu: vi.fn().mockResolvedValue([
        {
          vmid: 212,
          name: 'homeassistant-vm',
          status: 'stopped',
          cpus: 4,
          maxmem: 4096 * 1024 * 1024,
        },
      ]),
    } as unknown as ProxmoxClient;

    const mockConnManager = {
      getRouter: vi.fn().mockResolvedValue(mockRouter),
      getApiClient: vi.fn().mockResolvedValue(mockApiClient),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConnectionManager;

    const inventoryService = new LiveInventoryService({
      hostRegistry,
      connectionManager: mockConnManager,
      ttlMs: 10_000,
    });

    const app = await buildApp({
      config,
      repositories,
      hostRegistry,
      connectionManager: mockConnManager,
      inventoryService,
    });

    try {
      // Setup admin user
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: {
          username: 'admin',
          password: 'Password123!',
        },
      });
      expect(setupRes.statusCode).toBe(201);
      const sessionCookie = parseCookie(
        setupRes.headers['set-cookie'],
        SESSION_COOKIE_NAME,
      );
      const csrfCookie = parseCookie(
        setupRes.headers['set-cookie'],
        CSRF_COOKIE_NAME,
      );

      const authHeaders = {
        cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}; ${CSRF_COOKIE_NAME}=${csrfCookie}`,
        [CSRF_HEADER_NAME]: csrfCookie!,
      };

      // 1. GET /api/inventory/hosts
      const hostsRes = await app.inject({
        method: 'GET',
        url: '/api/inventory/hosts',
        headers: authHeaders,
      });
      expect(hostsRes.statusCode).toBe(200);
      const hostsJson = hostsRes.json();
      expect(hostsJson.hosts).toHaveLength(1);
      expect(hostsJson.hosts[0].hostId).toBe('pve-01');
      expect(hostsJson.hosts[0].status).toBe('online');
      expect(hostsJson.hosts[0].guestCount).toBe(2);
      expect(hostsJson.hosts[0].orphanCount).toBe(1);
      expect(hostsJson.hosts[0].ignoredCount).toBe(0);

      // 2. GET /api/inventory/guests
      const guestsRes = await app.inject({
        method: 'GET',
        url: '/api/inventory/guests',
        headers: authHeaders,
      });
      expect(guestsRes.statusCode).toBe(200);
      const guestsJson = guestsRes.json();
      expect(guestsJson.guests).toHaveLength(2);
      expect(guestsJson.guests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            vmid: 112,
            configuration: expect.objectContaining({
              status: 'configured',
              relativePath: 'hosts/pve-01/112-adguard-lxc/deployment.yaml',
            }),
          }),
          expect.objectContaining({
            vmid: 212,
            configuration: { status: 'orphan' },
          }),
        ]),
      );

      // 3. GET /api/inventory/guests with filter
      const filteredRes = await app.inject({
        method: 'GET',
        url: '/api/inventory/guests?type=lxc',
        headers: authHeaders,
      });
      expect(filteredRes.statusCode).toBe(200);
      expect(filteredRes.json().guests).toHaveLength(1);
      expect(filteredRes.json().guests[0].name).toBe('adguard-lxc');

      // 4. GET /api/inventory/guests/:hostId/:vmid
      const detailRes = await app.inject({
        method: 'GET',
        url: '/api/inventory/guests/pve-01/112',
        headers: authHeaders,
      });
      expect(detailRes.statusCode).toBe(200);
      const detailJson = detailRes.json();
      expect(detailJson.summary.name).toBe('adguard-lxc');
      expect(detailJson.canonicalConfig.cpu).toBe(2);
      expect(detailJson.canonicalConfig.ram).toBe(1024);
      expect(detailJson.source).toBe('ssh');
      expect(detailJson.configuration).toMatchObject({
        status: 'configured',
        rawYaml: configuredYaml,
        config: { id: 112, type: 'lxc' },
        issues: [],
      });

      // The remaining import assertions exercise an unmanaged guest.
      await rm(configuredGuestDir, { recursive: true, force: true });

      // 5. POST /api/inventory/refresh
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/api/inventory/refresh',
        headers: authHeaders,
        payload: { hostId: 'pve-01' },
      });
      expect(refreshRes.statusCode).toBe(200);
      expect(refreshRes.json().refreshed).toBe(true);

      // 6. POST /api/inventory/hosts/:hostId/refresh
      const hostRefreshRes = await app.inject({
        method: 'POST',
        url: '/api/inventory/hosts/pve-01/refresh',
        headers: authHeaders,
      });
      expect(hostRefreshRes.statusCode).toBe(200);
      expect(hostRefreshRes.json().host.hostId).toBe('pve-01');
      expect(hostRefreshRes.json().host).toMatchObject({
        orphanCount: 2,
        ignoredCount: 0,
      });

      // 7. POST /api/inventory/guests/:hostId/:vmid/import (dryRun)
      const dryImportRes = await app.inject({
        method: 'POST',
        url: '/api/inventory/guests/pve-01/112/import',
        headers: authHeaders,
        payload: { dryRun: true },
      });
      expect(dryImportRes.statusCode).toBe(200);
      const dryJson = dryImportRes.json();
      expect(dryJson.status).toBe('new');
      expect(dryJson.relativeFile).toContain('112-adguard-lxc/deployment.yaml');

      // Actual import
      const importRes = await app.inject({
        method: 'POST',
        url: '/api/inventory/guests/pve-01/112/import',
        headers: authHeaders,
        payload: {},
      });
      expect(importRes.statusCode).toBe(200);
      const importJson = importRes.json();
      expect(importJson.success).toBe(true);

      // Re-run import: refuses overwrite
      const rerunRes = await app.inject({
        method: 'POST',
        url: '/api/inventory/guests/pve-01/112/import',
        headers: authHeaders,
        payload: {},
      });
      expect(rerunRes.statusCode).toBe(200);
      expect(rerunRes.json().success).toBe(false);
      expect(rerunRes.json().reason).toBe('already_exists');

      // 8. Bulk import POST /api/inventory/import
      const bulkRes = await app.inject({
        method: 'POST',
        url: '/api/inventory/import',
        headers: authHeaders,
        payload: {
          hostId: 'pve-01',
          vmids: [112],
          dryRun: true,
        },
      });
      expect(bulkRes.statusCode).toBe(200);
      expect(bulkRes.json().results).toHaveLength(1);
      expect(bulkRes.json().results[0].vmid).toBe(112);

      // 9. Ignore the unmanaged VM (212) and keep the entry in host.yaml.
      const dryIgnore = await app.inject({
        method: 'POST',
        url: '/api/inventory/guests/pve-01/212/ignore',
        headers: authHeaders,
        payload: { dryRun: true },
      });
      expect(dryIgnore.statusCode).toBe(200);
      expect(dryIgnore.json()).toMatchObject({
        status: 'ignored',
        dryRun: true,
        changed: true,
        relativeFile: 'hosts/pve-01/host.yaml',
      });
      expect(await readFile(join(h1Dir, 'host.yaml'), 'utf8')).not.toContain(
        'ignored_guests',
      );

      const ignored = await app.inject({
        method: 'POST',
        url: '/api/inventory/guests/pve-01/212/ignore',
        headers: authHeaders,
        payload: {},
      });
      expect(ignored.statusCode).toBe(200);
      expect(ignored.json()).toMatchObject({
        status: 'ignored',
        dryRun: false,
        changed: true,
        replaced: false,
      });
      const hostYaml = await readFile(join(h1Dir, 'host.yaml'), 'utf8');
      expect(hostYaml).toContain('ignored_guests:');
      expect(hostYaml).toContain('vmid: 212');
      expect(hostYaml).toContain('name: homeassistant-vm');
      expect(hostYaml).toContain('fingerprint:');

      const repeated = await app.inject({
        method: 'POST',
        url: '/api/inventory/guests/pve-01/212/ignore',
        headers: authHeaders,
        payload: {},
      });
      expect(repeated.statusCode).toBe(200);
      expect(repeated.json()).toMatchObject({
        changed: false,
        replaced: false,
      });

      const afterIgnore = await app.inject({
        method: 'GET',
        url: '/api/inventory/guests',
        headers: authHeaders,
      });
      expect(afterIgnore.json().guests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            vmid: 212,
            configuration: expect.objectContaining({
              status: 'ignored',
              entry: expect.objectContaining({
                vmid: 212,
                name: 'homeassistant-vm',
              }),
            }),
          }),
        ]),
      );

      const ignoredDetail = await app.inject({
        method: 'GET',
        url: '/api/inventory/guests/pve-01/212',
        headers: authHeaders,
      });
      expect(ignoredDetail.statusCode).toBe(200);
      expect(ignoredDetail.json().configuration).toEqual({
        status: 'ignored',
      });

      const afterIgnoreHost = await app.inject({
        method: 'POST',
        url: '/api/inventory/hosts/pve-01/refresh',
        headers: authHeaders,
      });
      expect(afterIgnoreHost.json().host).toMatchObject({
        orphanCount: 0,
        ignoredCount: 1,
      });

      expect(
        await repositories.auditLogs.search({ action: 'orphan.ignore' }),
      ).toMatchObject({
        total: 1,
        items: [
          expect.objectContaining({
            hostId: 'pve-01',
            vmid: 212,
            reason: 'orphan_action',
          }),
        ],
      });

      // A reused VMID with a different identity surfaces as an orphan again.
      const stale = hostYaml.replace(
        /fingerprint: [0-9a-f]+/,
        `fingerprint: ${'0'.repeat(64)}`,
      );
      await writeFile(join(h1Dir, 'host.yaml'), stale, 'utf8');
      const staleList = await app.inject({
        method: 'GET',
        url: '/api/inventory/guests',
        headers: authHeaders,
      });
      expect(staleList.json().guests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            vmid: 212,
            configuration: { status: 'orphan' },
          }),
        ]),
      );
      const replaced = await app.inject({
        method: 'POST',
        url: '/api/inventory/guests/pve-01/212/ignore',
        headers: authHeaders,
        payload: {},
      });
      expect(replaced.statusCode).toBe(200);
      expect(replaced.json()).toMatchObject({
        changed: true,
        replaced: true,
      });

      // A configured guest cannot be ignored.
      const configuredIgnore = await app.inject({
        method: 'POST',
        url: '/api/inventory/guests/pve-01/112/ignore',
        headers: authHeaders,
        payload: { dryRun: true },
      });
      expect(configuredIgnore.statusCode).toBe(409);

      const deniedHost = await app.inject({
        method: 'POST',
        url: '/api/inventory/guests/other-host/212/ignore',
        headers: authHeaders,
        payload: { dryRun: true },
      });
      expect(deniedHost.statusCode).toBe(403);
    } finally {
      await app.close();
      await rm(tempDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
