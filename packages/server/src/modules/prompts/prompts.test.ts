import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createDatabase, createSqliteRepositories } from '../../db/index.js';
import { DurableJobQueue } from '../../jobs/queue.js';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../auth/session.js';

const tempDirs: string[] = [];

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function parseCookie(
  header: string | string[] | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const value of Array.isArray(header) ? header : [header]) {
    const match = value.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (match) return match[1];
  }
  return undefined;
}

function session(headers: Record<string, unknown>) {
  const setCookie = headers['set-cookie'] as string | string[] | undefined;
  const sessionId = parseCookie(setCookie, SESSION_COOKIE_NAME)!;
  const csrf = parseCookie(setCookie, CSRF_COOKIE_NAME)!;
  return {
    cookie: `${SESSION_COOKIE_NAME}=${sessionId}; ${CSRF_COOKIE_NAME}=${csrf}`,
    csrf,
  };
}

async function createFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'hacm-prompts-data-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'hacm-prompts-state-'));
  tempDirs.push(dataDir, stateDir);
  for (const [id, index] of [
    ['pve-01', 1],
    ['pve-02', 2],
  ] as const) {
    const dir = join(dataDir, 'hosts', id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'host.yaml'),
      `schema_version: 1
id: ${id}
name: ${id}
type: proxmox
index: ${index}
connection:
  ssh:
    host: 192.0.2.${index}
`,
      'utf8',
    );
  }
  const config = loadConfig({
    HACM_DATA_DIR: dataDir,
    HACM_STATE_DIR: stateDir,
    HACM_COOKIE_SECURE: 'false',
    HACM_SESSION_SECRET: 'p'.repeat(32),
  });
  const handle = createDatabase({ path: ':memory:' });
  const repos = createSqliteRepositories(handle.db);
  const queue = new DurableJobQueue(repos);
  const app = await buildApp({ config, repositories: repos, jobQueue: queue });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'admin', password: 'Password123!' },
  });
  const admin = session(setup.headers);

  for (const [username, role] of [
    ['operator', 'operator'],
    ['viewer', 'viewer'],
  ] as const) {
    await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: {
        cookie: admin.cookie,
        [CSRF_HEADER_NAME]: admin.csrf,
      },
      payload: {
        username,
        password: `Password-${username}-123!`,
        role,
        grantedHosts: ['pve-01'],
      },
    });
  }
  const operatorLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'operator', password: 'Password-operator-123!' },
  });
  const viewerLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'viewer', password: 'Password-viewer-123!' },
  });
  return {
    app,
    handle,
    repos,
    queue,
    operator: session(operatorLogin.headers),
    viewer: session(viewerLogin.headers),
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('prompts API', () => {
  it('wires queue prompts through the app and resumes after REST resolution', async () => {
    const fixture = await createFixture();
    try {
      let resolution: unknown;
      fixture.queue.registerHandler('prompted', async (context) => {
        resolution = await context.prompt({
          kind: 'choice',
          message: 'Choose a source',
          options: ['host', 'rootfs'],
        });
      });
      await fixture.queue.enqueue({
        id: 'app-prompt-job',
        hostId: 'pve-01',
        vmid: 112,
        type: 'prompted',
      });
      await fixture.queue.start();
      await waitUntil(
        async () =>
          (await fixture.queue.get('app-prompt-job'))?.status ===
          'waiting_input',
      );

      const list = await fixture.app.inject({
        method: 'GET',
        url: '/api/prompts',
        headers: { cookie: fixture.operator.cookie },
      });
      expect(list.statusCode).toBe(200);
      const prompt = list.json().prompts[0] as { id: string };
      expect(prompt.id).toMatch(/^app-prompt-job:/);

      const resolved = await fixture.app.inject({
        method: 'POST',
        url: `/api/prompts/${prompt.id}/resolve`,
        headers: {
          cookie: fixture.operator.cookie,
          [CSRF_HEADER_NAME]: fixture.operator.csrf,
        },
        payload: { kind: 'choice', choice: 'host' },
      });
      expect(resolved.statusCode).toBe(200);
      await expect(
        fixture.queue.waitForJob('app-prompt-job'),
      ).resolves.toMatchObject({ status: 'completed' });
      expect(resolution).toEqual({ kind: 'choice', choice: 'host' });
    } finally {
      await fixture.app.close();
      fixture.handle.close();
    }
  });

  it('scopes prompts by host, validates resolution, audits, and enforces roles and expiry', async () => {
    const fixture = await createFixture();
    try {
      const now = new Date();
      for (const [jobId, hostId] of [
        ['job-1', 'pve-01'],
        ['job-2', 'pve-02'],
      ] as const) {
        await fixture.repos.jobs.create({
          id: jobId,
          hostId,
          vmid: 112,
          lane: 'guest',
          type: 'test',
          status: 'waiting_input',
          priority: 0,
          createdAt: now,
        });
      }
      await fixture.repos.prompts.create({
        id: 'choice',
        jobId: 'job-1',
        kind: 'choice',
        status: 'pending',
        message: 'Choose',
        optionsJson: '["a","b"]',
        createdAt: now,
      });
      await fixture.repos.prompts.create({
        id: 'denied',
        jobId: 'job-2',
        kind: 'confirm',
        status: 'pending',
        message: 'Denied',
        createdAt: now,
      });
      await fixture.repos.prompts.create({
        id: 'expired',
        jobId: 'job-1',
        kind: 'confirm',
        status: 'pending',
        message: 'Expired',
        createdAt: now,
        expiresAt: new Date(now.getTime() - 1),
      });

      const list = await fixture.app.inject({
        method: 'GET',
        url: '/api/prompts',
        headers: { cookie: fixture.operator.cookie },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().prompts).toEqual([
        expect.objectContaining({ id: 'choice', hostId: 'pve-01' }),
      ]);
      const denied = await fixture.app.inject({
        method: 'GET',
        url: '/api/prompts/denied',
        headers: { cookie: fixture.operator.cookie },
      });
      expect(denied.statusCode).toBe(403);
      const missing = await fixture.app.inject({
        method: 'GET',
        url: '/api/prompts/missing',
        headers: { cookie: fixture.operator.cookie },
      });
      expect(missing.statusCode).toBe(404);

      const invalid = await fixture.app.inject({
        method: 'POST',
        url: '/api/prompts/choice/resolve',
        headers: {
          cookie: fixture.operator.cookie,
          [CSRF_HEADER_NAME]: fixture.operator.csrf,
        },
        payload: { kind: 'choice', choice: 'not-allowed' },
      });
      expect(invalid.statusCode).toBe(400);
      const resolved = await fixture.app.inject({
        method: 'POST',
        url: '/api/prompts/choice/resolve',
        headers: {
          cookie: fixture.operator.cookie,
          [CSRF_HEADER_NAME]: fixture.operator.csrf,
        },
        payload: { kind: 'choice', choice: 'a' },
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json()).toMatchObject({
        status: 'resolved',
        resolution: { kind: 'choice', choice: 'a' },
      });
      expect(
        await fixture.repos.auditLogs.search({ action: 'prompt.resolve' }),
      ).toMatchObject({ total: 1 });

      const viewer = await fixture.app.inject({
        method: 'POST',
        url: '/api/prompts/denied/resolve',
        headers: {
          cookie: fixture.viewer.cookie,
          [CSRF_HEADER_NAME]: fixture.viewer.csrf,
        },
        payload: { kind: 'confirm', confirmed: true },
      });
      expect(viewer.statusCode).toBe(403);
      const expired = await fixture.app.inject({
        method: 'POST',
        url: '/api/prompts/expired/resolve',
        headers: {
          cookie: fixture.operator.cookie,
          [CSRF_HEADER_NAME]: fixture.operator.csrf,
        },
        payload: { kind: 'confirm', confirmed: true },
      });
      expect(expired.statusCode).toBe(410);
    } finally {
      await fixture.app.close();
      fixture.handle.close();
    }
  });
});
