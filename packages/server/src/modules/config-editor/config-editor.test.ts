import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createDatabase, createSqliteRepositories } from '../../db/index.js';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../auth/session.js';
import { readGuestConfiguration } from '../../inventory/configuration.js';

const tempDirs: string[] = [];

function parseCookie(
  cookieHeader: string | string[] | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  const headers = Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader];
  for (const header of headers) {
    const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (match) return match[1];
  }
  return undefined;
}

function authHeaders(cookieHeader: string, csrf: string) {
  return {
    cookie: cookieHeader,
    [CSRF_HEADER_NAME]: csrf,
  };
}

async function createFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'hacm-config-editor-data-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'hacm-config-editor-state-'));
  tempDirs.push(dataDir, stateDir);
  const hostDir = join(dataDir, 'hosts', 'pve-01');
  const guestDir = join(hostDir, '112-adguard');
  await mkdir(guestDir, { recursive: true });
  await writeFile(
    join(hostDir, 'host.yaml'),
    `schema_version: 1
id: pve-01
name: Proxmox 01
type: proxmox
index: 1
connection:
  ssh:
    host: 192.0.2.10
`,
    'utf8',
  );
  const deploymentPath = join(guestDir, 'deployment.yaml');
  await writeFile(
    deploymentPath,
    `# Keep this editor comment
schema_version: 1
id: 112
name: adguard
type: lxc
cpu: 1
`,
    'utf8',
  );

  const config = loadConfig({
    HACM_DATA_DIR: dataDir,
    HACM_STATE_DIR: stateDir,
    HACM_COOKIE_SECURE: 'false',
    HACM_SESSION_SECRET: 'e'.repeat(32),
  });
  const handle = createDatabase({ path: ':memory:' });
  const repos = createSqliteRepositories(handle.db);
  const app = await buildApp({ config, repositories: repos });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'admin', password: 'Password123!' },
  });
  const adminSession = parseCookie(
    setup.headers['set-cookie'],
    SESSION_COOKIE_NAME,
  )!;
  const adminCsrf = parseCookie(setup.headers['set-cookie'], CSRF_COOKIE_NAME)!;
  const adminCookie = `${SESSION_COOKIE_NAME}=${adminSession}; ${CSRF_COOKIE_NAME}=${adminCsrf}`;

  return {
    app,
    handle,
    repos,
    dataDir,
    deploymentPath,
    adminCookie,
    adminCsrf,
  };
}

async function createUserAndLogin(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  role: 'operator' | 'viewer',
  grantedHosts: readonly string[],
) {
  const username = `${role}-${grantedHosts.length}`;
  const password = `Password-${role}-123!`;
  const create = await fixture.app.inject({
    method: 'POST',
    url: '/api/users',
    headers: authHeaders(fixture.adminCookie, fixture.adminCsrf),
    payload: { username, password, role, grantedHosts },
  });
  expect(create.statusCode).toBe(201);
  const login = await fixture.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  expect(login.statusCode).toBe(200);
  const session = parseCookie(
    login.headers['set-cookie'],
    SESSION_COOKIE_NAME,
  )!;
  const csrf = parseCookie(login.headers['set-cookie'], CSRF_COOKIE_NAME)!;
  return {
    cookie: `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`,
    csrf,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('configuration editor API', () => {
  it('serves JSON Schema, validates identity, saves comments, audits hashes, and detects conflicts', async () => {
    const fixture = await createFixture();
    try {
      const schema = await fixture.app.inject({
        method: 'GET',
        url: '/api/config/schema/deployment',
        headers: { cookie: fixture.adminCookie },
      });
      expect(schema.statusCode).toBe(200);
      expect(schema.json().schema.oneOf).toHaveLength(2);

      const invalid = await fixture.app.inject({
        method: 'POST',
        url: '/api/config/guests/pve-01/112/validate',
        headers: authHeaders(fixture.adminCookie, fixture.adminCsrf),
        payload: {
          rawYaml: 'schema_version: 1\nid: 113\nname: adguard\ntype: lxc\n',
        },
      });
      expect(invalid.statusCode).toBe(200);
      expect(invalid.json()).toMatchObject({ valid: false });
      expect(invalid.json().issues[0].path).toBe('id');

      const snapshot = await readGuestConfiguration(
        fixture.dataDir,
        'pve-01',
        112,
      );
      expect(snapshot.status).toBe('configured');
      if (snapshot.status !== 'configured') return;
      const rawYaml = snapshot.rawYaml.replace('cpu: 1', 'cpu: 2');
      const dryRun = await fixture.app.inject({
        method: 'PUT',
        url: '/api/config/guests/pve-01/112',
        headers: authHeaders(fixture.adminCookie, fixture.adminCsrf),
        payload: { rawYaml, expectedHash: snapshot.hash, dryRun: true },
      });
      expect(dryRun.statusCode).toBe(200);
      expect(dryRun.json()).toMatchObject({ success: true, dryRun: true });
      expect(await readFile(fixture.deploymentPath, 'utf8')).toBe(
        snapshot.rawYaml,
      );
      expect(
        await fixture.repos.auditLogs.search({ action: 'config.guest.save' }),
      ).toMatchObject({ total: 0 });

      const save = await fixture.app.inject({
        method: 'PUT',
        url: '/api/config/guests/pve-01/112',
        headers: authHeaders(fixture.adminCookie, fixture.adminCsrf),
        payload: { rawYaml, expectedHash: snapshot.hash },
      });
      expect(save.statusCode).toBe(200);
      expect(save.json()).toMatchObject({
        success: true,
        dryRun: false,
        config: { id: 112, cpu: 2 },
      });
      expect(await readFile(fixture.deploymentPath, 'utf8')).toContain(
        '# Keep this editor comment',
      );

      const audit = await fixture.repos.auditLogs.search({
        action: 'config.guest.save',
      });
      expect(audit.items).toHaveLength(1);
      expect(audit.items[0]?.diffJson).toContain(save.json().hash);

      const conflict = await fixture.app.inject({
        method: 'PUT',
        url: '/api/config/guests/pve-01/112',
        headers: authHeaders(fixture.adminCookie, fixture.adminCsrf),
        payload: { rawYaml, expectedHash: snapshot.hash },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().message).toContain('changed outside this editor');
    } finally {
      await fixture.app.close();
      fixture.handle.close();
    }
  });

  it('allows safe operator edits but rejects !cmd, tasks, ungranted hosts, and viewer writes', async () => {
    const fixture = await createFixture();
    try {
      const operator = await createUserAndLogin(fixture, 'operator', [
        'pve-01',
      ]);
      let snapshot = await readGuestConfiguration(
        fixture.dataDir,
        'pve-01',
        112,
      );
      expect(snapshot.status).toBe('configured');
      if (snapshot.status !== 'configured') return;

      const safeYaml = snapshot.rawYaml.replace('cpu: 1', 'cpu: 2');
      const safeSave = await fixture.app.inject({
        method: 'PUT',
        url: '/api/config/guests/pve-01/112',
        headers: authHeaders(operator.cookie, operator.csrf),
        payload: { rawYaml: safeYaml, expectedHash: snapshot.hash },
      });
      expect(safeSave.statusCode).toBe(200);

      snapshot = await readGuestConfiguration(fixture.dataDir, 'pve-01', 112);
      expect(snapshot.status).toBe('configured');
      if (snapshot.status !== 'configured') return;
      const cmdSave = await fixture.app.inject({
        method: 'PUT',
        url: '/api/config/guests/pve-01/112',
        headers: authHeaders(operator.cookie, operator.csrf),
        payload: {
          rawYaml: snapshot.rawYaml.replace('cpu: 2', 'cpu: !cmd "vault cpu"'),
          expectedHash: snapshot.hash,
        },
      });
      expect(cmdSave.statusCode).toBe(403);
      expect(cmdSave.json().adminOnly).toContain('cmd');

      const taskSave = await fixture.app.inject({
        method: 'PUT',
        url: '/api/config/guests/pve-01/112',
        headers: authHeaders(operator.cookie, operator.csrf),
        payload: {
          rawYaml: `${snapshot.rawYaml}tasks: []\n`,
          expectedHash: snapshot.hash,
        },
      });
      expect(taskSave.statusCode).toBe(403);
      expect(taskSave.json().adminOnly).toContain('tasks');

      const ungranted = await createUserAndLogin(fixture, 'operator', []);
      const deniedRead = await fixture.app.inject({
        method: 'POST',
        url: '/api/config/guests/pve-01/112/validate',
        headers: authHeaders(ungranted.cookie, ungranted.csrf),
        payload: { rawYaml: snapshot.rawYaml },
      });
      expect(deniedRead.statusCode).toBe(403);

      const viewer = await createUserAndLogin(fixture, 'viewer', ['pve-01']);
      const viewerSave = await fixture.app.inject({
        method: 'PUT',
        url: '/api/config/guests/pve-01/112',
        headers: authHeaders(viewer.cookie, viewer.csrf),
        payload: { rawYaml: snapshot.rawYaml, expectedHash: snapshot.hash },
      });
      expect(viewerSave.statusCode).toBe(403);
      expect(viewerSave.json().message).toContain('Viewer role');
    } finally {
      await fixture.app.close();
      fixture.handle.close();
    }
  });

  it('returns not-found and validation responses without writing', async () => {
    const fixture = await createFixture();
    try {
      const missing = await fixture.app.inject({
        method: 'POST',
        url: '/api/config/guests/pve-01/999/validate',
        headers: authHeaders(fixture.adminCookie, fixture.adminCsrf),
        payload: { rawYaml: 'type: lxc\n' },
      });
      expect(missing.statusCode).toBe(404);

      const snapshot = await readGuestConfiguration(
        fixture.dataDir,
        'pve-01',
        112,
      );
      expect(snapshot.status).toBe('configured');
      if (snapshot.status !== 'configured') return;
      const invalidSave = await fixture.app.inject({
        method: 'PUT',
        url: '/api/config/guests/pve-01/112',
        headers: authHeaders(fixture.adminCookie, fixture.adminCsrf),
        payload: {
          rawYaml: snapshot.rawYaml.replace('cpu: 1', 'cpu: invalid'),
          expectedHash: snapshot.hash,
        },
      });
      expect(invalidSave.statusCode).toBe(400);
      expect(invalidSave.json().issues).not.toHaveLength(0);

      const missingSave = await fixture.app.inject({
        method: 'PUT',
        url: '/api/config/guests/pve-01/999',
        headers: authHeaders(fixture.adminCookie, fixture.adminCsrf),
        payload: {
          rawYaml: snapshot.rawYaml,
          expectedHash: snapshot.hash,
        },
      });
      expect(missingSave.statusCode).toBe(404);
    } finally {
      await fixture.app.close();
      fixture.handle.close();
    }
  });
});
