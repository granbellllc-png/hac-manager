import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../config.js';
import { buildApp } from '../../app.js';
import { createDatabase, createSqliteRepositories } from '../../db/index.js';
import { HostRegistry } from '../../hosts/registry.js';
import type { ConnectionManager } from '../../router/manager.js';
import type { LiveInventoryService } from '../../inventory/service.js';
import {
  StorageGuestNotFoundError,
  StorageInvariantJobError,
  type StorageInvariantService,
} from '../../storage/index.js';
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

function authHeaders(setCookie: string | string[] | undefined): {
  cookie: string;
  [CSRF_HEADER_NAME]: string;
} {
  const sessionCookie = parseCookie(setCookie, SESSION_COOKIE_NAME);
  const csrfCookie = parseCookie(setCookie, CSRF_COOKIE_NAME);
  return {
    cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}; ${CSRF_COOKIE_NAME}=${csrfCookie}`,
    [CSRF_HEADER_NAME]: csrfCookie!,
  };
}

async function login(
  app: FastifyInstance,
  username: string,
  password: string,
): Promise<{ cookie: string; [CSRF_HEADER_NAME]: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return authHeaders(response.headers['set-cookie']);
}

function fakeJob() {
  return {
    id: 'job-1',
    hostId: 'pve-01',
    vmid: 112,
    lane: 'guest' as const,
    type: 'guest.storage.invariant',
    reason: 'manual' as const,
    status: 'queued' as const,
    priority: -50,
    payloadJson: null,
    triggeredBy: null,
    dependsOnJobId: null,
    timeoutMs: null,
    cancelRequestedAt: null,
    error: null,
    createdAt: new Date('2026-11-10T12:00:00.000Z'),
    startedAt: null,
    finishedAt: null,
  };
}

describe('Storage API endpoints', () => {
  it('queues checks and resolutions with role and host access enforcement', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hacm-storage-api-'));
    const stateDir = await mkdtemp(join(tmpdir(), 'hacm-storage-api-state-'));
    const hostDir = join(dataDir, 'hosts', 'pve-01');
    const guestDir = join(hostDir, '112-adguard');
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
    await writeFile(
      join(guestDir, 'deployment.yaml'),
      `schema_version: 1
id: 112
name: adguard
type: lxc
cpu: 2
ram: 1024
disks: []
network: []
`,
      'utf8',
    );

    const config = loadConfig({
      HACM_DATA_DIR: dataDir,
      HACM_STATE_DIR: stateDir,
      HACM_COOKIE_SECURE: 'false',
      HACM_SESSION_SECRET: 'c'.repeat(32),
      HACM_PORT: '3129',
    });
    const dbHandle = createDatabase({ path: ':memory:' });
    const repositories = createSqliteRepositories(dbHandle.db);
    const hostRegistry = new HostRegistry({
      dataDir,
      repos: repositories,
      autoWatch: false,
    });
    await hostRegistry.sync();

    const enqueueCheck = vi.fn(async () => fakeJob() as never);
    const enqueueResolution = vi.fn(async () => fakeJob() as never);
    const storageInvariantService = {
      enqueueCheck,
      enqueueResolution,
      registerQueueHandler: vi.fn(),
    } as unknown as StorageInvariantService;

    const app = await buildApp({
      config,
      repositories,
      hostRegistry,
      connectionManager: {
        getRouter: vi.fn(),
        getApiClient: vi.fn(),
        close: vi.fn(),
      } as unknown as ConnectionManager,
      inventoryService: {} as LiveInventoryService,
      storageInvariantService,
    });

    try {
      const setup = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { username: 'admin', password: 'Password123!' },
      });
      expect(setup.statusCode).toBe(201);
      const admin = authHeaders(setup.headers['set-cookie']);

      const check = await app.inject({
        method: 'POST',
        url: '/api/hosts/pve-01/guests/112/storage/check',
        headers: admin,
      });
      expect(check.statusCode).toBe(202);
      expect(check.json()).toMatchObject({ job: { id: 'job-1' } });
      expect(enqueueCheck).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: 'pve-01', vmid: 112 }),
      );

      const resolve = await app.inject({
        method: 'POST',
        url: '/api/hosts/pve-01/guests/112/storage/resolve',
        headers: admin,
        payload: { resolution: 'keep-host-data' },
      });
      expect(resolve.statusCode).toBe(202);
      expect(enqueueResolution).toHaveBeenCalledWith(
        expect.objectContaining({
          hostId: 'pve-01',
          vmid: 112,
          resolution: 'keep-host-data',
        }),
      );

      enqueueCheck.mockRejectedValueOnce(
        new StorageGuestNotFoundError('pve-01', 999),
      );
      const missing = await app.inject({
        method: 'POST',
        url: '/api/hosts/pve-01/guests/999/storage/check',
        headers: admin,
      });
      expect(missing.statusCode).toBe(404);

      enqueueResolution.mockRejectedValueOnce(
        new StorageInvariantJobError('resolution not available'),
      );
      const conflict = await app.inject({
        method: 'POST',
        url: '/api/hosts/pve-01/guests/112/storage/resolve',
        headers: admin,
        payload: { resolution: 'migrate-rootfs-to-host' },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().message).toBe('resolution not available');

      enqueueCheck.mockRejectedValueOnce(new Error('boom'));
      const failed = await app.inject({
        method: 'POST',
        url: '/api/hosts/pve-01/guests/112/storage/check',
        headers: admin,
      });
      expect(failed.statusCode).toBe(409);
      expect(failed.json().message).toBe('boom');

      const createViewer = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: admin,
        payload: {
          username: 'viewer',
          password: 'Password123!',
          role: 'viewer',
          grantedHosts: ['pve-01'],
        },
      });
      expect(createViewer.statusCode).toBe(201);
      const viewer = await login(app, 'viewer', 'Password123!');
      const viewerCheck = await app.inject({
        method: 'POST',
        url: '/api/hosts/pve-01/guests/112/storage/check',
        headers: viewer,
      });
      expect(viewerCheck.statusCode).toBe(403);
      expect(viewerCheck.json().message).toContain('Viewer role');
      const viewerResolve = await app.inject({
        method: 'POST',
        url: '/api/hosts/pve-01/guests/112/storage/resolve',
        headers: viewer,
        payload: { resolution: 'keep-host-data' },
      });
      expect(viewerResolve.statusCode).toBe(403);
      expect(viewerResolve.json().message).toContain('Viewer role');

      const createOperator = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: admin,
        payload: {
          username: 'operator',
          password: 'Password123!',
          role: 'operator',
          grantedHosts: [],
        },
      });
      expect(createOperator.statusCode).toBe(201);
      const operator = await login(app, 'operator', 'Password123!');
      const noHost = await app.inject({
        method: 'POST',
        url: '/api/hosts/pve-01/guests/112/storage/check',
        headers: operator,
      });
      expect(noHost.statusCode).toBe(403);
      expect(noHost.json().message).toContain('Access denied');
    } finally {
      await app.close();
      dbHandle.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
