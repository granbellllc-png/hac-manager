import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProxmoxConfig } from '@hacm/core';
import { loadConfig } from '../../config.js';
import { buildApp } from '../../app.js';
import { createDatabase, createSqliteRepositories } from '../../db/index.js';
import { HostRegistry } from '../../hosts/registry.js';
import type { ConnectionManager } from '../../router/manager.js';
import type { LiveInventoryService } from '../../inventory/service.js';
import { DriftService } from '../../drift/service.js';
import type { PlanService } from '../../plans/service.js';
import { PlanStateError } from '../../plans/types.js';
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

const deploymentYaml = `schema_version: 1
id: 112
name: adguard
type: lxc
cpu: 2
ram: 2048
disks: []
network: []
`;

describe('Drift API endpoints', () => {
  it('checks a guest, persists the result and exposes it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hacm-drift-api-test-'));
    const stateDir = await mkdtemp(join(tmpdir(), 'hacm-drift-api-state-'));
    const hostDir = join(dataDir, 'hosts', 'pve-01');
    const guestDir = join(hostDir, '112-adguard-lxc');
    await mkdir(guestDir, { recursive: true });
    await writeFile(
      join(hostDir, 'host.yaml'),
      `schema_version: 1
id: pve-01
name: Proxmox Node 1
type: proxmox
index: 1
connection:
  ssh:
    host: 192.0.2.10
    port: 22
    username: root
`,
      'utf8',
    );
    await writeFile(join(guestDir, 'deployment.yaml'), deploymentYaml, 'utf8');

    const config = loadConfig({
      HACM_DATA_DIR: dataDir,
      HACM_STATE_DIR: stateDir,
      HACM_COOKIE_SECURE: 'false',
      HACM_SESSION_SECRET: 'c'.repeat(32),
      HACM_PORT: '3124',
    });
    const dbHandle = createDatabase({ path: ':memory:' });
    const repositories = createSqliteRepositories(dbHandle.db);
    const hostRegistry = new HostRegistry({
      dataDir,
      repos: repositories,
      autoWatch: false,
    });
    await hostRegistry.sync();

    const canonicalConfig = parseProxmoxConfig(
      'hostname: adguard\ncores: 2\nmemory: 4096\n',
      'lxc',
      112,
    );
    const getGuestLiveConfig = vi.fn(async () => ({
      summary: {
        hostId: 'pve-01',
        vmid: 112,
        name: 'adguard',
        type: 'lxc' as const,
        status: 'running',
        node: 'localhost',
      },
      rawConfig: '',
      canonicalConfig,
      source: 'ssh' as const,
    }));
    const inventoryService = {
      getGuestLiveConfig,
    } as unknown as LiveInventoryService;
    const connectionManager = {
      getRouter: vi.fn(),
      getApiClient: vi.fn(),
      close: vi.fn(),
    } as unknown as ConnectionManager;
    const driftService = new DriftService({
      repos: repositories,
      hostRegistry,
      inventoryService: { getGuestLiveConfig },
    });
    const app = await buildApp({
      config,
      repositories,
      hostRegistry,
      connectionManager,
      inventoryService,
      driftService,
    });

    try {
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { username: 'admin', password: 'Password123!' },
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

      const missingRes = await app.inject({
        method: 'GET',
        url: '/api/drift/pve-01/112',
        headers: authHeaders,
      });
      expect(missingRes.statusCode).toBe(404);

      const checkRes = await app.inject({
        method: 'POST',
        url: '/api/drift/pve-01/112/check',
        headers: authHeaders,
      });
      expect(checkRes.statusCode).toBe(200);
      const snapshot = checkRes.json();
      expect(snapshot).toMatchObject({
        hostId: 'pve-01',
        vmid: 112,
        type: 'lxc',
        status: 'drifted',
      });
      expect(snapshot.changes).toHaveLength(1);
      expect(snapshot.changes[0]).toMatchObject({
        path: 'ram',
        desired: 2048,
        actual: 4096,
      });

      const listRes = await app.inject({
        method: 'GET',
        url: '/api/drift?hostId=pve-01&status=drifted&limit=5',
        headers: authHeaders,
      });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().snapshots).toHaveLength(1);

      const unfilteredRes = await app.inject({
        method: 'GET',
        url: '/api/drift',
        headers: authHeaders,
      });
      expect(unfilteredRes.statusCode).toBe(200);
      expect(unfilteredRes.json().snapshots).toHaveLength(1);

      const detailRes = await app.inject({
        method: 'GET',
        url: '/api/drift/pve-01/112',
        headers: authHeaders,
      });
      expect(detailRes.statusCode).toBe(200);
      expect(detailRes.json().vmid).toBe(112);

      const hostRes = await app.inject({
        method: 'POST',
        url: '/api/drift/hosts/pve-01/check',
        headers: authHeaders,
      });
      expect(hostRes.statusCode).toBe(200);
      expect(hostRes.json()).toMatchObject({
        hostId: 'pve-01',
        checked: 1,
        failures: [],
      });

      const forbiddenList = await app.inject({
        method: 'GET',
        url: '/api/drift?hostId=other',
        headers: authHeaders,
      });
      expect(forbiddenList.statusCode).toBe(403);

      const forbiddenDetail = await app.inject({
        method: 'GET',
        url: '/api/drift/other/112',
        headers: authHeaders,
      });
      expect(forbiddenDetail.statusCode).toBe(403);

      const forbiddenCheck = await app.inject({
        method: 'POST',
        url: '/api/drift/other/112/check',
        headers: authHeaders,
      });
      expect(forbiddenCheck.statusCode).toBe(403);

      const forbiddenHost = await app.inject({
        method: 'POST',
        url: '/api/drift/hosts/other/check',
        headers: authHeaders,
      });
      expect(forbiddenHost.statusCode).toBe(403);

      const notFoundCheck = await app.inject({
        method: 'POST',
        url: '/api/drift/pve-01/999/check',
        headers: authHeaders,
      });
      expect(notFoundCheck.statusCode).toBe(404);

      const dryRunPull = await app.inject({
        method: 'POST',
        url: '/api/drift/pve-01/112/pull',
        headers: authHeaders,
        payload: { paths: ['ram'], dryRun: true },
      });
      expect(dryRunPull.statusCode).toBe(200);
      expect(dryRunPull.json()).toMatchObject({
        dryRun: true,
        applied: [{ path: 'ram', newValue: 4096 }],
        failures: [],
        snapshot: { status: 'drifted' },
      });
      expect(
        await readFile(join(guestDir, 'deployment.yaml'), 'utf8'),
      ).toContain('ram: 2048');

      const pull = await app.inject({
        method: 'POST',
        url: '/api/drift/pve-01/112/pull',
        headers: authHeaders,
        payload: {},
      });
      expect(pull.statusCode).toBe(200);
      expect(pull.json()).toMatchObject({
        dryRun: false,
        applied: [{ path: 'ram', newValue: 4096 }],
        failures: [],
        snapshot: { status: 'in_sync', changes: [] },
      });
      expect(
        await readFile(join(guestDir, 'deployment.yaml'), 'utf8'),
      ).toContain('ram: 4096');

      const forbiddenPull = await app.inject({
        method: 'POST',
        url: '/api/drift/other/112/pull',
        headers: authHeaders,
        payload: {},
      });
      expect(forbiddenPull.statusCode).toBe(403);

      const checkGuest = vi
        .spyOn(driftService, 'checkGuest')
        .mockRejectedValueOnce('plain failure');
      const plainFailure = await app.inject({
        method: 'POST',
        url: '/api/drift/pve-01/112/check',
        headers: authHeaders,
      });
      expect(plainFailure.statusCode).toBe(409);
      expect(plainFailure.json().message).toBe('Drift check failed');
      checkGuest.mockRestore();

      const unauthorized = await app.inject({
        method: 'GET',
        url: '/api/drift',
      });
      expect(unauthorized.statusCode).toBe(401);
    } finally {
      await app.close();
      dbHandle.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('builds an update plan and queues apply with the drift_push reason', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hacm-drift-enforce-'));
    const stateDir = await mkdtemp(join(tmpdir(), 'hacm-drift-enforce-state-'));
    const hostDir = join(dataDir, 'hosts', 'pve-01');
    const guestDir = join(hostDir, '112-adguard-lxc');
    await mkdir(guestDir, { recursive: true });
    await writeFile(
      join(hostDir, 'host.yaml'),
      `schema_version: 1
id: pve-01
name: Proxmox Node 1
type: proxmox
index: 1
connection:
  ssh:
    host: 192.0.2.10
    port: 22
    username: root
`,
      'utf8',
    );
    await writeFile(join(guestDir, 'deployment.yaml'), deploymentYaml, 'utf8');

    const config = loadConfig({
      HACM_DATA_DIR: dataDir,
      HACM_STATE_DIR: stateDir,
      HACM_COOKIE_SECURE: 'false',
      HACM_SESSION_SECRET: 'c'.repeat(32),
      HACM_PORT: '3124',
    });
    const dbHandle = createDatabase({ path: ':memory:' });
    const repositories = createSqliteRepositories(dbHandle.db);
    const hostRegistry = new HostRegistry({
      dataDir,
      repos: repositories,
      autoWatch: false,
    });
    await hostRegistry.sync();

    const createdAt = new Date('2026-11-09T10:00:00.000Z');
    const plan = {
      schemaVersion: 1 as const,
      id: 'plan-1',
      operation: 'guest.update',
      target: { hostId: 'pve-01', vmid: 112, resourceType: 'guest' as const },
      summary: 'Update LXC 112 (adguard)',
      changes: [],
      warnings: [],
      destructive: false,
      stateFingerprint: 'fingerprint',
      createdAt: createdAt.toISOString(),
      status: 'ready' as const,
    };
    const job = {
      id: 'job-1',
      hostId: 'pve-01',
      vmid: 112,
      lane: 'guest' as const,
      type: 'plan.apply',
      reason: 'drift_push' as const,
      status: 'queued' as const,
      priority: 0,
      triggeredBy: 'admin',
      createdAt,
    };
    const planService = {
      registerQueueHandler: vi.fn(),
      createGuestUpdatePlan: vi.fn(async () => plan),
      queueApply: vi.fn(async () => ({ plan, job })),
      get: vi.fn(),
      list: vi.fn(),
    } as unknown as PlanService;
    const inventoryService = {
      getGuestLiveConfig: vi.fn(),
    } as unknown as LiveInventoryService;
    const connectionManager = {
      getRouter: vi.fn(),
      getApiClient: vi.fn(),
      close: vi.fn(),
    } as unknown as ConnectionManager;
    const driftService = new DriftService({
      repos: repositories,
      hostRegistry,
      inventoryService,
    });
    const app = await buildApp({
      config,
      repositories,
      hostRegistry,
      connectionManager,
      inventoryService,
      planService,
      driftService,
    });

    try {
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { username: 'admin', password: 'Password123!' },
      });
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

      const res = await app.inject({
        method: 'POST',
        url: '/api/drift/pve-01/112/enforce',
        headers: authHeaders,
        payload: { dryRun: true },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({
        plan: { id: 'plan-1', operation: 'guest.update' },
        job: { id: 'job-1', reason: 'drift_push', status: 'queued' },
      });
      expect(planService.createGuestUpdatePlan).toHaveBeenCalledWith(
        expect.objectContaining({
          hostId: 'pve-01',
          vmid: 112,
          createdByRole: 'admin',
        }),
      );
      expect(planService.queueApply).toHaveBeenCalledWith(
        'plan-1',
        expect.objectContaining({
          dryRun: true,
          reason: 'drift_push',
          user: expect.objectContaining({ role: 'admin' }),
        }),
      );

      const forbidden = await app.inject({
        method: 'POST',
        url: '/api/drift/other/112/enforce',
        headers: authHeaders,
        payload: {},
      });
      expect(forbidden.statusCode).toBe(403);

      vi.mocked(planService.createGuestUpdatePlan).mockRejectedValueOnce(
        new PlanStateError('already in sync'),
      );
      const conflict = await app.inject({
        method: 'POST',
        url: '/api/drift/pve-01/112/enforce',
        headers: authHeaders,
        payload: {},
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().message).toBe('already in sync');
    } finally {
      await app.close();
      dbHandle.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('returns a conflict when the live config cannot be read', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hacm-drift-api-test-'));
    const stateDir = await mkdtemp(join(tmpdir(), 'hacm-drift-api-state-'));
    const hostDir = join(dataDir, 'hosts', 'pve-01');
    const guestDir = join(hostDir, '112-adguard-lxc');
    await mkdir(guestDir, { recursive: true });
    await writeFile(
      join(hostDir, 'host.yaml'),
      `schema_version: 1
id: pve-01
name: Proxmox Node 1
type: proxmox
index: 1
connection:
  ssh:
    host: 192.0.2.10
`,
      'utf8',
    );
    await writeFile(join(guestDir, 'deployment.yaml'), deploymentYaml, 'utf8');

    const config = loadConfig({
      HACM_DATA_DIR: dataDir,
      HACM_STATE_DIR: stateDir,
      HACM_COOKIE_SECURE: 'false',
      HACM_SESSION_SECRET: 'c'.repeat(32),
      HACM_PORT: '3124',
    });
    const dbHandle = createDatabase({ path: ':memory:' });
    const repositories = createSqliteRepositories(dbHandle.db);
    const hostRegistry = new HostRegistry({
      dataDir,
      repos: repositories,
      autoWatch: false,
    });
    await hostRegistry.sync();

    const getGuestLiveConfig = vi.fn(async () => {
      throw new Error('host unreachable');
    });
    const inventoryService = {
      getGuestLiveConfig,
    } as unknown as LiveInventoryService;
    const connectionManager = {
      getRouter: vi.fn(),
      getApiClient: vi.fn(),
      close: vi.fn(),
    } as unknown as ConnectionManager;
    const driftService = new DriftService({
      repos: repositories,
      hostRegistry,
      inventoryService: { getGuestLiveConfig },
    });
    const app = await buildApp({
      config,
      repositories,
      hostRegistry,
      connectionManager,
      inventoryService,
      driftService,
    });

    try {
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { username: 'admin', password: 'Password123!' },
      });
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

      const res = await app.inject({
        method: 'POST',
        url: '/api/drift/pve-01/112/check',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toBe('host unreachable');
    } finally {
      await app.close();
      dbHandle.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
