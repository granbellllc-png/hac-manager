import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../config.js';
import { buildApp } from '../../app.js';
import { createDatabase, createSqliteRepositories } from '../../db/index.js';
import { HostRegistry } from '../../hosts/registry.js';
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

describe('Hosts API endpoints', () => {
  it('enforces RBAC, lists hosts, shows detail, and allows sync', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'hacm-hosts-api-test-'));
    const stateDir = await mkdtemp(join(tmpdir(), 'hacm-hosts-state-test-'));
    const hostsDir = join(tempDir, 'hosts');
    const h1Dir = join(hostsDir, 'pve-01');
    const h2Dir = join(hostsDir, 'pve-02');
    await mkdir(h1Dir, { recursive: true });
    await mkdir(h2Dir, { recursive: true });

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

    await writeFile(
      join(h2Dir, 'host.yaml'),
      `schema_version: 1
id: pve-02
name: Proxmox Node 2
type: proxmox
index: 2
connection:
  ssh:
    host: 192.168.1.52
    port: 22
    username: root
`,
      'utf8',
    );

    const config = loadConfig({
      HACM_DATA_DIR: tempDir,
      HACM_STATE_DIR: stateDir,
      HACM_COOKIE_SECURE: 'false',
      HACM_SESSION_SECRET: 'c'.repeat(32),
    });

    const dbHandle = createDatabase({ path: ':memory:' });
    const repos = createSqliteRepositories(dbHandle.db);
    const hostRegistry = new HostRegistry({ dataDir: tempDir, repos });

    const app = await buildApp({
      config,
      repositories: repos,
      hostRegistry,
    });

    try {
      // 1. Setup Admin
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: {
          username: 'admin',
          password: 'AdminPassword123!',
        },
      });
      expect(setupRes.statusCode).toBe(201);
      const adminCookie = parseCookie(
        setupRes.headers['set-cookie'],
        SESSION_COOKIE_NAME,
      );
      const adminCsrf = parseCookie(
        setupRes.headers['set-cookie'],
        CSRF_COOKIE_NAME,
      );

      // Admin lists hosts -> sees both
      const adminListRes = await app.inject({
        method: 'GET',
        url: '/api/hosts',
        cookies: { [SESSION_COOKIE_NAME]: adminCookie! },
      });
      expect(adminListRes.statusCode).toBe(200);
      const adminListJson = adminListRes.json();
      expect(adminListJson.hosts).toHaveLength(2);

      // 2. Create viewer user
      const createUserRes = await app.inject({
        method: 'POST',
        url: '/api/users',
        cookies: {
          [SESSION_COOKIE_NAME]: adminCookie!,
          [CSRF_COOKIE_NAME]: adminCsrf!,
        },
        headers: {
          [CSRF_HEADER_NAME]: adminCsrf!,
        },
        payload: {
          username: 'viewer-alice',
          password: 'ViewerPassword123!',
          role: 'viewer',
          grantedHosts: ['pve-01'], // Alice only has access to pve-01
        },
      });
      expect(createUserRes.statusCode).toBe(201);

      // Login as viewer-alice
      const viewerLoginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'viewer-alice',
          password: 'ViewerPassword123!',
        },
      });
      expect(viewerLoginRes.statusCode).toBe(200);
      const viewerCookie = parseCookie(
        viewerLoginRes.headers['set-cookie'],
        SESSION_COOKIE_NAME,
      );
      const viewerCsrf = parseCookie(
        viewerLoginRes.headers['set-cookie'],
        CSRF_COOKIE_NAME,
      );

      // Viewer lists hosts -> sees only pve-01
      const viewerListRes = await app.inject({
        method: 'GET',
        url: '/api/hosts',
        cookies: { [SESSION_COOKIE_NAME]: viewerCookie! },
      });
      expect(viewerListRes.statusCode).toBe(200);
      const viewerListJson = viewerListRes.json();
      expect(viewerListJson.hosts).toHaveLength(1);
      expect(viewerListJson.hosts[0].id).toBe('pve-01');

      // Viewer details for pve-01 -> 200
      const viewerDetailPve1 = await app.inject({
        method: 'GET',
        url: '/api/hosts/pve-01',
        cookies: { [SESSION_COOKIE_NAME]: viewerCookie! },
      });
      expect(viewerDetailPve1.statusCode).toBe(200);
      expect(viewerDetailPve1.json().host.id).toBe('pve-01');

      // Viewer details for pve-02 -> 403 Forbidden
      const viewerDetailPve2 = await app.inject({
        method: 'GET',
        url: '/api/hosts/pve-02',
        cookies: { [SESSION_COOKIE_NAME]: viewerCookie! },
      });
      expect(viewerDetailPve2.statusCode).toBe(403);

      // Viewer cannot trigger sync -> 403
      const viewerSyncRes = await app.inject({
        method: 'POST',
        url: '/api/hosts/sync',
        cookies: {
          [SESSION_COOKIE_NAME]: viewerCookie!,
          [CSRF_COOKIE_NAME]: viewerCsrf!,
        },
        headers: {
          [CSRF_HEADER_NAME]: viewerCsrf!,
        },
      });
      expect(viewerSyncRes.statusCode).toBe(403);

      // Admin triggers sync -> 200
      const adminSyncRes = await app.inject({
        method: 'POST',
        url: '/api/hosts/sync',
        cookies: {
          [SESSION_COOKIE_NAME]: adminCookie!,
          [CSRF_COOKIE_NAME]: adminCsrf!,
        },
        headers: {
          [CSRF_HEADER_NAME]: adminCsrf!,
        },
      });
      expect(adminSyncRes.statusCode).toBe(200);
      expect(adminSyncRes.json().ok).toBe(true);
    } finally {
      await app.close();
      dbHandle.close();
      await rm(tempDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
