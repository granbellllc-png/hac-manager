import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../auth/session.js';
import { loadConfig } from '../../config.js';
import { createDatabase, createSqliteRepositories } from '../../db/index.js';
import { DurableJobQueue } from '../../jobs/queue.js';

const tempDirs: string[] = [];

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
  const dataDir = await mkdtemp(join(tmpdir(), 'hacm-jobs-data-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'hacm-jobs-state-'));
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
    HACM_SESSION_SECRET: 'j'.repeat(32),
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

describe('jobs API', () => {
  it('lists scoped jobs, returns detail/log pages, and enforces cancellation', async () => {
    const fixture = await createFixture();
    try {
      const now = new Date('2026-01-01T00:00:00.000Z');
      await fixture.repos.jobs.create({
        id: 'job-1',
        hostId: 'pve-01',
        vmid: 112,
        lane: 'guest',
        type: 'update',
        status: 'queued',
        priority: 0,
        triggeredBy: 'operator-1',
        createdAt: now,
      });
      await fixture.repos.jobs.create({
        id: 'job-2',
        hostId: 'pve-02',
        lane: 'host',
        type: 'probe',
        status: 'completed',
        priority: 0,
        createdAt: now,
        finishedAt: now,
      });
      await fixture.repos.jobLogLines.append({
        jobId: 'job-1',
        stream: 'system',
        text: 'queued',
        ts: now,
      });
      await fixture.repos.jobLogLines.append({
        jobId: 'job-1',
        stream: 'stdout',
        text: 'next',
        ts: new Date(now.getTime() + 1),
      });
      await fixture.repos.jobSteps.upsert({
        jobId: 'job-1',
        stepIndex: 0,
        name: 'check identity',
        status: 'completed',
        resultJson: '{"ok":true}',
        startedAt: now,
        finishedAt: now,
      });
      await fixture.repos.prompts.create({
        id: 'prompt-1',
        jobId: 'job-1',
        kind: 'confirm',
        status: 'pending',
        message: 'Continue?',
        createdAt: now,
      });

      const list = await fixture.app.inject({
        method: 'GET',
        url: '/api/jobs?hostId=pve-01&status=queued&vmid=112&limit=10',
        headers: { cookie: fixture.operator.cookie },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().jobs).toEqual([
        expect.objectContaining({ id: 'job-1', status: 'queued' }),
      ]);
      const deniedList = await fixture.app.inject({
        method: 'GET',
        url: '/api/jobs?hostId=pve-02',
        headers: { cookie: fixture.operator.cookie },
      });
      expect(deniedList.statusCode).toBe(403);

      const detail = await fixture.app.inject({
        method: 'GET',
        url: '/api/jobs/job-1',
        headers: { cookie: fixture.operator.cookie },
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        job: { id: 'job-1' },
        steps: [{ name: 'check identity', result: { ok: true } }],
        prompts: [{ id: 'prompt-1', status: 'pending' }],
      });
      const logs = await fixture.app.inject({
        method: 'GET',
        url: '/api/jobs/job-1/logs?after=1&limit=10',
        headers: { cookie: fixture.operator.cookie },
      });
      expect(logs.statusCode).toBe(200);
      expect(logs.json()).toMatchObject({
        logs: [{ seq: 2, text: 'next' }],
        nextCursor: 2,
      });

      const viewerCancel = await fixture.app.inject({
        method: 'POST',
        url: '/api/jobs/job-1/cancel',
        headers: {
          cookie: fixture.viewer.cookie,
          [CSRF_HEADER_NAME]: fixture.viewer.csrf,
        },
      });
      expect(viewerCancel.statusCode).toBe(403);
      const cancelled = await fixture.app.inject({
        method: 'POST',
        url: '/api/jobs/job-1/cancel',
        headers: {
          cookie: fixture.operator.cookie,
          [CSRF_HEADER_NAME]: fixture.operator.csrf,
        },
      });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json().job).toMatchObject({ status: 'cancelled' });
      const repeated = await fixture.app.inject({
        method: 'POST',
        url: '/api/jobs/job-1/cancel',
        headers: {
          cookie: fixture.operator.cookie,
          [CSRF_HEADER_NAME]: fixture.operator.csrf,
        },
      });
      expect(repeated.statusCode).toBe(409);

      for (const [url, status] of [
        ['/api/jobs/missing', 404],
        ['/api/jobs/job-2', 403],
        ['/api/jobs/missing/logs', 404],
        ['/api/jobs/job-2/logs', 403],
      ] as const) {
        const response = await fixture.app.inject({
          method: 'GET',
          url,
          headers: { cookie: fixture.operator.cookie },
        });
        expect(response.statusCode).toBe(status);
      }
    } finally {
      await fixture.app.close();
      fixture.handle.close();
    }
  });
});
