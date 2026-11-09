import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createDatabase, createSqliteRepositories } from '../../db/index.js';
import { HostRegistry } from '../../hosts/registry.js';
import { DurableJobQueue } from '../../jobs/queue.js';
import { JobEventBroker } from '../../events/job-events.js';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../auth/session.js';

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

function cookieFromResponse(headers: Record<string, unknown>): {
  readonly cookie: string;
  readonly csrf: string;
} {
  const setCookie = headers['set-cookie'] as string | string[] | undefined;
  const session = parseCookie(setCookie, SESSION_COOKIE_NAME)!;
  const csrf = parseCookie(setCookie, CSRF_COOKIE_NAME)!;
  return {
    cookie: `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`,
    csrf,
  };
}

async function createFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'hacm-events-data-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'hacm-events-state-'));
  tempDirs.push(dataDir, stateDir);
  for (const [id, index] of [
    ['pve-01', 1],
    ['pve-02', 2],
  ] as const) {
    const hostDir = join(dataDir, 'hosts', id);
    await mkdir(hostDir, { recursive: true });
    await writeFile(
      join(hostDir, 'host.yaml'),
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
    HACM_SESSION_SECRET: 's'.repeat(32),
  });
  const handle = createDatabase({ path: ':memory:' });
  const repos = createSqliteRepositories(handle.db);
  const hostRegistry = new HostRegistry({
    dataDir,
    repos,
    autoWatch: false,
  });
  await hostRegistry.sync();
  const queue = new DurableJobQueue(repos);
  const broker = new JobEventBroker(queue);
  const app = await buildApp({
    config,
    repositories: repos,
    hostRegistry,
    jobQueue: queue,
    eventBroker: broker,
    eventsHeartbeatMs: 20,
  });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'admin', password: 'Password123!' },
  });
  const admin = cookieFromResponse(setup.headers);
  const createOperator = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: {
      cookie: admin.cookie,
      [CSRF_HEADER_NAME]: admin.csrf,
    },
    payload: {
      username: 'operator',
      password: 'PasswordOperator123!',
      role: 'operator',
      grantedHosts: ['pve-01'],
    },
  });
  expect(createOperator.statusCode).toBe(201);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'operator', password: 'PasswordOperator123!' },
  });
  const operator = cookieFromResponse(login.headers);
  const operatorUser = await repos.users.getByUsername('operator');

  return {
    app,
    handle,
    repos,
    queue,
    broker,
    operator,
    operatorUser: operatorUser!,
  };
}

async function readUntil(
  response: Response,
  predicate: (text: string) => boolean,
  timeoutMs = 2_000,
): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (!predicate(text)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out reading SSE: ${text}`);
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('SSE read timeout')), remaining),
        ),
      ]);
      if (result.done) break;
      text += decoder.decode(result.value, { stream: true });
    }
    return text;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('SSE job events', () => {
  it('replays line logs from query/header cursors without gaps or duplicates and enforces host access', async () => {
    const fixture = await createFixture();
    try {
      const now = new Date();
      for (const [id, hostId] of [
        ['job-1', 'pve-01'],
        ['job-2', 'pve-02'],
      ] as const) {
        await fixture.repos.jobs.create({
          id,
          hostId,
          vmid: 112,
          lane: 'guest',
          type: 'test',
          status: 'completed',
          priority: 0,
          createdAt: now,
          finishedAt: now,
        });
      }
      for (const text of ['one', 'two', 'three']) {
        await fixture.repos.jobLogLines.append({
          jobId: 'job-1',
          stream: 'stdout',
          text,
        });
      }

      const replay = await fixture.app.inject({
        method: 'GET',
        url: '/api/jobs/job-1/events?after=1&follow=false',
        headers: { cookie: fixture.operator.cookie },
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.headers['content-type']).toContain('text/event-stream');
      expect(replay.body).not.toContain('id: 1');
      expect(replay.body.match(/id: 2/g)).toHaveLength(1);
      expect(replay.body.match(/id: 3/g)).toHaveLength(1);
      expect(replay.body).toContain('"text":"two"');
      expect(replay.body).toContain('"text":"three"');

      const headerReplay = await fixture.app.inject({
        method: 'GET',
        url: '/api/jobs/job-1/events?follow=false',
        headers: {
          cookie: fixture.operator.cookie,
          'last-event-id': '2',
        },
      });
      expect(headerReplay.body).not.toContain('id: 2');
      expect(headerReplay.body.match(/id: 3/g)).toHaveLength(1);

      const denied = await fixture.app.inject({
        method: 'GET',
        url: '/api/jobs/job-2/events?follow=false',
        headers: { cookie: fixture.operator.cookie },
      });
      expect(denied.statusCode).toBe(403);
      const missing = await fixture.app.inject({
        method: 'GET',
        url: '/api/jobs/missing/events?follow=false',
        headers: { cookie: fixture.operator.cookie },
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await fixture.app.close();
      fixture.handle.close();
    }
  });

  it('streams live logs, status, prompts, and heartbeats only to permitted users', async () => {
    const fixture = await createFixture();
    const abort = new AbortController();
    try {
      fixture.queue.registerHandler('stream-test', async ({ log }) => {
        await log('stdout', 'hello\nworld\n');
      });
      const job = await fixture.queue.enqueue({
        id: 'live-job',
        hostId: 'pve-01',
        vmid: 112,
        type: 'stream-test',
      });
      const address = await fixture.app.listen({
        host: '127.0.0.1',
        port: 0,
      });
      const response = await fetch(`${address}/api/jobs/${job.id}/events`, {
        headers: { cookie: fixture.operator.cookie },
        signal: abort.signal,
      });
      expect(response.status).toBe(200);
      await fixture.queue.start();
      fixture.broker.publishPrompt({
        id: 'prompt-live',
        jobId: job.id,
        hostId: 'pve-01',
        userId: fixture.operatorUser.id,
        type: 'confirm',
        data: { question: 'Continue?' },
        createdAt: new Date().toISOString(),
      });
      const stream = await readUntil(
        response,
        (text) =>
          text.includes('"text":"hello"') &&
          text.includes('"text":"world"') &&
          text.includes('event: job') &&
          text.includes('event: prompt') &&
          text.includes(': heartbeat'),
      );
      expect(stream.match(/"text":"hello"/g)).toHaveLength(1);
      expect(stream.match(/"text":"world"/g)).toHaveLength(1);
      await expect(fixture.queue.waitForJob(job.id)).resolves.toMatchObject({
        status: 'completed',
      });

      const globalAbort = new AbortController();
      const globalResponse = await fetch(`${address}/api/events`, {
        headers: { cookie: fixture.operator.cookie },
        signal: globalAbort.signal,
      });
      fixture.broker.publishPrompt({
        id: 'wrong-host',
        jobId: 'job-2',
        hostId: 'pve-02',
        type: 'confirm',
        data: {},
        createdAt: new Date().toISOString(),
      });
      fixture.broker.publishPrompt({
        id: 'wrong-user',
        jobId: job.id,
        hostId: 'pve-01',
        userId: 'another-user',
        type: 'confirm',
        data: {},
        createdAt: new Date().toISOString(),
      });
      fixture.broker.publishPrompt({
        id: 'visible-prompt',
        jobId: job.id,
        hostId: 'pve-01',
        userId: fixture.operatorUser.id,
        type: 'confirm',
        data: {},
        createdAt: new Date().toISOString(),
      });
      const globalStream = await readUntil(globalResponse, (text) =>
        text.includes('visible-prompt'),
      );
      expect(globalStream).not.toContain('wrong-host');
      expect(globalStream).not.toContain('wrong-user');
      globalAbort.abort();
    } finally {
      abort.abort();
      await fixture.app.close();
      fixture.handle.close();
    }
  });
});
