import { afterEach, describe, expect, it, vi } from 'vitest';
import { globalSecretRedactor } from '@hacm/core';
import { createDatabase } from '../db/connection.js';
import { createSqliteRepositories } from '../db/repositories/sqlite.js';
import { DurableJobQueue } from './queue.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('DurableJobQueue', () => {
  const queues: DurableJobQueue[] = [];

  async function stopQueuesAndClose(
    handle: ReturnType<typeof createDatabase>,
  ): Promise<void> {
    await Promise.all(
      queues.splice(0).map((queue) => queue.stop({ interruptRunning: true })),
    );
    handle.close();
  }

  afterEach(async () => {
    await Promise.all(
      queues.splice(0).map((queue) => queue.stop({ interruptRunning: true })),
    );
    vi.restoreAllMocks();
  });

  it('runs different guests concurrently while serialising the same guest', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const queue = new DurableJobQueue(repos, { defaultHostConcurrency: 3 });
      queues.push(queue);
      const gates = new Map<string, ReturnType<typeof deferred>>();
      const started: string[] = [];
      queue.registerHandler('work', async ({ job }) => {
        started.push(job.id);
        const gate = gates.get(job.id);
        if (!gate) throw new Error(`Missing gate for ${job.id}`);
        await gate.promise;
      });

      for (const id of ['same-a', 'same-b', 'other']) {
        gates.set(id, deferred());
      }
      await queue.enqueue({
        id: 'same-a',
        hostId: 'pve-01',
        vmid: 112,
        type: 'work',
      });
      await queue.enqueue({
        id: 'same-b',
        hostId: 'pve-01',
        vmid: 112,
        type: 'work',
      });
      await queue.enqueue({
        id: 'other',
        hostId: 'pve-01',
        vmid: 113,
        type: 'work',
      });

      await queue.start();
      await waitUntil(
        () => started.includes('same-a') && started.includes('other'),
      );
      expect(started).not.toContain('same-b');

      gates.get('same-a')!.resolve();
      await waitUntil(() => started.includes('same-b'));
      gates.get('same-b')!.resolve();
      gates.get('other')!.resolve();

      await expect(queue.waitForJob('same-a')).resolves.toMatchObject({
        status: 'completed',
      });
      await expect(queue.waitForJob('same-b')).resolves.toMatchObject({
        status: 'completed',
      });
      await expect(queue.waitForJob('other')).resolves.toMatchObject({
        status: 'completed',
      });
    } finally {
      await stopQueuesAndClose(handle);
    }
  });

  it('prioritises power work and gives host jobs a separate serial lane', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const queue = new DurableJobQueue(repos, {
        defaultHostConcurrency: 3,
        hostConcurrency: { 'pve-01': 2 },
      });
      queues.push(queue);
      const started: string[] = [];
      const gates = new Map<string, ReturnType<typeof deferred>>();
      queue.registerHandler('work', async ({ job }) => {
        started.push(job.id);
        await gates.get(job.id)!.promise;
      });
      queue.registerHandler('power.stop', async ({ job }) => {
        started.push(job.id);
        await gates.get(job.id)!.promise;
      });
      for (const id of ['normal', 'power', 'host-a', 'host-b']) {
        gates.set(id, deferred());
      }

      await queue.enqueue({
        id: 'normal',
        hostId: 'pve-01',
        vmid: 112,
        type: 'work',
      });
      await queue.enqueue({
        id: 'power',
        hostId: 'pve-01',
        vmid: 112,
        type: 'power.stop',
      });
      await queue.enqueue({ id: 'host-a', hostId: 'pve-01', type: 'work' });
      await queue.enqueue({ id: 'host-b', hostId: 'pve-01', type: 'work' });
      await queue.start();

      await waitUntil(() => started.length === 2);
      expect(started[0]).toBe('power');
      expect(started).toContain('host-a');
      expect(started).not.toContain('normal');
      expect(started).not.toContain('host-b');

      gates.get('power')!.resolve();
      gates.get('host-a')!.resolve();
      await waitUntil(
        () => started.includes('normal') && started.includes('host-b'),
      );
      gates.get('normal')!.resolve();
      gates.get('host-b')!.resolve();
      await Promise.all([
        queue.waitForJob('normal'),
        queue.waitForJob('power'),
        queue.waitForJob('host-a'),
        queue.waitForJob('host-b'),
      ]);
    } finally {
      await stopQueuesAndClose(handle);
    }
  });

  it('recovers running jobs as interrupted without losing existing logs', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const now = new Date();
      await repos.jobs.create({
        id: 'stale',
        hostId: 'pve-01',
        vmid: 112,
        lane: 'guest',
        type: 'work',
        status: 'running',
        priority: 0,
        createdAt: now,
        startedAt: now,
      });
      await repos.jobLogLines.append({
        jobId: 'stale',
        stream: 'stdout',
        text: 'preserved output',
      });
      const queue = new DurableJobQueue(repos);
      queues.push(queue);

      await expect(queue.start()).resolves.toBe(1);
      expect(await queue.get('stale')).toMatchObject({ status: 'interrupted' });
      expect(
        (await repos.jobLogLines.list('stale')).map((line) => line.text),
      ).toEqual([
        'preserved output',
        'Job marked interrupted after backend restart',
      ]);
      await expect(queue.start()).resolves.toBe(0);
    } finally {
      await stopQueuesAndClose(handle);
    }
  });

  it('supports queued/running cancellation, timeouts, shutdown interruption, and failures', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const queue = new DurableJobQueue(repos, { defaultHostConcurrency: 4 });
      queues.push(queue);
      queue.registerHandler('abortable', async ({ signal }) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
          if (signal.aborted) resolve();
        });
      });
      queue.registerHandler('failure', async () => {
        throw new Error('fixture failure');
      });

      await queue.enqueue({
        id: 'running-cancel',
        hostId: 'pve-01',
        vmid: 112,
        type: 'abortable',
      });
      await queue.enqueue({
        id: 'queued-cancel',
        hostId: 'pve-01',
        vmid: 112,
        type: 'abortable',
      });
      await queue.enqueue({
        id: 'timeout',
        hostId: 'pve-01',
        vmid: 113,
        type: 'abortable',
        timeoutMs: 20,
      });
      await queue.enqueue({
        id: 'failure',
        hostId: 'pve-01',
        vmid: 114,
        type: 'failure',
      });
      await queue.enqueue({
        id: 'unregistered',
        hostId: 'pve-01',
        vmid: 115,
        type: 'missing-handler',
      });
      await queue.start();
      await waitUntil(
        async () => (await queue.get('running-cancel'))?.status === 'running',
      );
      await expect(queue.cancel('queued-cancel')).resolves.toBe(true);
      await expect(queue.cancel('running-cancel')).resolves.toBe(true);

      await expect(queue.waitForJob('queued-cancel')).resolves.toMatchObject({
        status: 'cancelled',
      });
      await expect(queue.waitForJob('running-cancel')).resolves.toMatchObject({
        status: 'cancelled',
      });
      await expect(queue.waitForJob('timeout')).resolves.toMatchObject({
        status: 'failed',
        error: expect.stringContaining('timeout'),
      });
      await expect(queue.waitForJob('failure')).resolves.toMatchObject({
        status: 'failed',
        error: 'fixture failure',
      });
      await expect(queue.waitForJob('unregistered')).resolves.toMatchObject({
        status: 'failed',
        error: "No handler registered for 'missing-handler'",
      });
      await expect(queue.cancel('failure')).resolves.toBe(false);

      await queue.enqueue({
        id: 'shutdown',
        hostId: 'pve-01',
        vmid: 116,
        type: 'abortable',
      });
      await waitUntil(
        async () => (await queue.get('shutdown'))?.status === 'running',
      );
      await queue.stop({ interruptRunning: true });
      expect(await queue.get('shutdown')).toMatchObject({
        status: 'interrupted',
      });
    } finally {
      await stopQueuesAndClose(handle);
    }
  });

  it('cancels persisted prompt waits and fails when no prompt handler is configured', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const queue = new DurableJobQueue(repos);
      queues.push(queue);
      await repos.jobs.create({
        id: 'persisted-wait',
        hostId: 'pve-01',
        vmid: 112,
        lane: 'guest',
        type: 'prompted',
        status: 'waiting_input',
        priority: 0,
        createdAt: new Date(),
      });

      await expect(queue.cancel('persisted-wait')).resolves.toBe(true);
      expect(await queue.get('persisted-wait')).toMatchObject({
        status: 'cancelled',
      });
      expect(
        (await repos.jobLogLines.list('persisted-wait')).map(
          (line) => line.text,
        ),
      ).toContain('Job cancelled while waiting for input');
      await expect(queue.resumeWaitingJob('persisted-wait')).resolves.toBe(
        false,
      );
      await expect(queue.resumeWaitingJob('missing')).resolves.toBe(false);

      queue.registerHandler('prompted', async ({ prompt }) => {
        await prompt({ kind: 'confirm', message: 'Continue?' });
      });
      await queue.enqueue({
        id: 'missing-prompt-handler',
        hostId: 'pve-01',
        vmid: 113,
        type: 'prompted',
      });
      await queue.start();

      await expect(
        queue.waitForJob('missing-prompt-handler'),
      ).resolves.toMatchObject({
        status: 'failed',
        error: 'No prompt handler configured',
      });

      queue.setPromptHandler(
        (_job, _request, signal) =>
          new Promise<unknown>((_resolve, reject) => {
            const abort = () => reject(new Error('Prompt wait aborted'));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          }),
      );
      queue.registerHandler('prompt-timeout', async ({ prompt }) => {
        await prompt({ kind: 'confirm', message: 'Wait forever?' });
      });
      await queue.enqueue({
        id: 'prompt-timeout',
        hostId: 'pve-01',
        vmid: 114,
        type: 'prompt-timeout',
        timeoutMs: 20,
      });
      await expect(queue.waitForJob('prompt-timeout')).resolves.toMatchObject({
        status: 'failed',
        error: expect.stringContaining('timeout'),
      });
    } finally {
      await stopQueuesAndClose(handle);
    }
  });

  it('orders dependencies, rejects missing dependencies, and redacts persisted payloads and logs', async () => {
    const handle = createDatabase({ path: ':memory:' });
    globalSecretRedactor.register('fixture-resolved-secret');
    try {
      const repos = createSqliteRepositories(handle.db);
      const queue = new DurableJobQueue(repos);
      queues.push(queue);
      const order: string[] = [];
      queue.registerHandler('success', async ({ job, payload, log }) => {
        order.push(job.id);
        expect(payload).toEqual({ token: '***', message: '***' });
        await log('stdout', 'first\nfixture-resolved-secret\n');
      });
      queue.registerHandler('failure', async () => {
        throw new Error('dependency failed');
      });

      await queue.enqueue({
        id: 'first',
        hostId: 'pve-01',
        vmid: 112,
        type: 'success',
        payload: {
          token: 'literal-token',
          message: 'fixture-resolved-secret',
        },
      });
      await queue.enqueue({
        id: 'second',
        hostId: 'pve-01',
        vmid: 113,
        type: 'success',
        payload: {
          token: 'literal-token',
          message: 'fixture-resolved-secret',
        },
        dependsOnJobId: 'first',
        priority: 'high',
      });
      await queue.enqueue({
        id: 'bad-dependency',
        hostId: 'pve-01',
        vmid: 114,
        type: 'failure',
      });
      await queue.enqueue({
        id: 'blocked',
        hostId: 'pve-01',
        vmid: 115,
        type: 'success',
        payload: {
          token: 'literal-token',
          message: 'fixture-resolved-secret',
        },
        dependsOnJobId: 'bad-dependency',
      });
      await repos.jobs.create({
        id: 'orphan-dependency',
        hostId: 'pve-01',
        vmid: 116,
        lane: 'guest',
        type: 'success',
        status: 'queued',
        priority: 0,
        dependsOnJobId: 'deleted-job',
        createdAt: new Date(),
      });
      await expect(
        queue.enqueue({
          id: 'missing',
          hostId: 'pve-01',
          type: 'success',
          dependsOnJobId: 'does-not-exist',
        }),
      ).rejects.toThrow("Dependency job 'does-not-exist' was not found");

      await queue.start();
      await expect(queue.waitForJob('second')).resolves.toMatchObject({
        status: 'completed',
      });
      await expect(queue.waitForJob('blocked')).resolves.toMatchObject({
        status: 'failed',
        error: expect.stringContaining("Dependency 'bad-dependency'"),
      });
      await expect(
        queue.waitForJob('orphan-dependency'),
      ).resolves.toMatchObject({
        status: 'failed',
        error: expect.stringContaining('no longer exists'),
      });
      expect(order.slice(0, 2)).toEqual(['first', 'second']);
      expect(
        (await repos.jobLogLines.list('first')).map((line) => line.text),
      ).toEqual(expect.arrayContaining(['first', '***']));
    } finally {
      globalSecretRedactor.unregister('fixture-resolved-secret');
      await stopQueuesAndClose(handle);
    }
  });

  it('validates configuration and wait requests', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      expect(
        () => new DurableJobQueue(repos, { defaultHostConcurrency: 0 }),
      ).toThrow('positive integer');
      expect(
        () =>
          new DurableJobQueue(repos, {
            hostConcurrency: { 'pve-01': 1.5 },
          }),
      ).toThrow("Host concurrency for 'pve-01'");

      const queue = new DurableJobQueue(repos);
      queues.push(queue);
      expect(() => queue.registerHandler('', async () => undefined)).toThrow(
        'must not be empty',
      );
      await expect(queue.enqueue({ hostId: '', type: 'work' })).rejects.toThrow(
        'hostId is required',
      );
      await expect(
        queue.enqueue({ hostId: 'pve-01', type: '' }),
      ).rejects.toThrow('Job type is required');
      await expect(
        queue.enqueue({ hostId: 'pve-01', type: 'work', timeoutMs: 0 }),
      ).rejects.toThrow('timeoutMs must be a positive integer');
      await expect(queue.waitForJob('missing')).rejects.toThrow(
        'was not found',
      );

      await queue.enqueue({
        id: 'never-started',
        hostId: 'pve-01',
        type: 'work',
      });
      await expect(queue.waitForJob('never-started', 10)).rejects.toThrow(
        'Timed out waiting',
      );
      expect(await queue.cancel('never-started')).toBe(true);
      await queue.stop({ interruptRunning: false });
    } finally {
      await stopQueuesAndClose(handle);
    }
  });

  it('reports background repository failures and safely retries an unclaimed job', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const queue = new DurableJobQueue(repos);
      queues.push(queue);
      queue.registerHandler('work', async () => undefined);
      await queue.enqueue({
        id: 'retry-claim',
        hostId: 'pve-01',
        vmid: 112,
        type: 'work',
      });
      await repos.jobs.create({
        id: 'malformed-guest-target',
        hostId: 'pve-01',
        vmid: null,
        lane: 'guest',
        type: 'work',
        status: 'queued',
        priority: 200,
        createdAt: new Date(),
      });

      const claim = vi.spyOn(repos.jobs, 'claim');
      claim.mockResolvedValueOnce(null);
      await queue.start();
      await expect(queue.waitForJob('retry-claim')).resolves.toMatchObject({
        status: 'completed',
      });
      await expect(queue.cancel('malformed-guest-target')).resolves.toBe(true);

      await queue.stop({ interruptRunning: false });
      const queueWithFailure = new DurableJobQueue(repos);
      queues.push(queueWithFailure);
      const list = vi.spyOn(repos.jobs, 'list');
      list
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('db offline'));
      const queueError = new Promise<unknown>((resolve) => {
        queueWithFailure.once('queueError', resolve);
      });
      await queueWithFailure.start();
      await expect(queueError).resolves.toEqual(new Error('db offline'));

      await repos.jobs.create({
        id: 'wait-failure',
        hostId: 'pve-01',
        lane: 'host',
        type: 'work',
        status: 'queued',
        priority: 0,
        createdAt: new Date(),
      });
      const waitJob = await repos.jobs.get('wait-failure');
      const get = vi.spyOn(repos.jobs, 'get');
      get
        .mockResolvedValueOnce(waitJob)
        .mockRejectedValueOnce(new Error('wait lookup failed'));
      await expect(queueWithFailure.waitForJob('wait-failure')).rejects.toThrow(
        'wait lookup failed',
      );
    } finally {
      await stopQueuesAndClose(handle);
    }
  });
});
