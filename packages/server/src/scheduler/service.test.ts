import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostFile } from '@hacm/core';
import { createDatabase } from '../db/connection.js';
import { createSqliteRepositories } from '../db/repositories/sqlite.js';
import type { HostDetail, HostSummary } from '../hosts/types.js';
import { DurableJobQueue } from '../jobs/queue.js';
import { DriftScheduler } from './service.js';

const queues: DurableJobQueue[] = [];

function rawHost(
  schedule: HostFile['drift_schedule'] = {
    enabled: true,
    cron: '* * * * *',
  },
): HostFile {
  return {
    schema_version: 1,
    id: 'pve-01',
    name: 'PVE 01',
    type: 'proxmox',
    index: 1,
    connection: {
      ssh: { host: '192.0.2.10', port: 22, username: 'root' },
    },
    ignored_guests: [],
    drift_schedule: schedule,
  };
}

function runtime(vault: 'not_configured' | 'unlocked' | 'locked') {
  return {
    overall: 'healthy' as const,
    ssh: { status: 'connected' as const },
    api: { status: 'unknown' as const, configured: false },
    vault: { status: vault },
    queue: { status: 'idle' as const },
    issues: [],
  };
}

function hostSummary(
  vault: 'not_configured' | 'unlocked' | 'locked',
): HostSummary {
  return {
    id: 'pve-01',
    name: 'PVE 01',
    type: 'proxmox',
    index: 1,
    status: 'healthy',
    runtime: runtime(vault),
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function hostDetail(
  vault: 'not_configured' | 'unlocked' | 'locked',
): HostDetail {
  return {
    ...hostSummary(vault),
    connection: {
      ssh: {
        host: '192.0.2.10',
        port: 22,
        username: 'root',
        authMethod: 'none',
      },
    },
    ignoredGuestsCount: 0,
  };
}

async function fixture(options?: {
  readonly vault?: 'not_configured' | 'unlocked' | 'locked';
  readonly inventoryStatus?: 'online' | 'offline' | 'degraded' | 'error';
  readonly schedule?: HostFile['drift_schedule'];
  readonly now?: Date;
  readonly baseBackoffMs?: number;
  readonly onError?: (error: unknown) => void;
}) {
  const handle = createDatabase({ path: ':memory:' });
  const repos = createSqliteRepositories(handle.db);
  const queue = new DurableJobQueue(repos);
  queues.push(queue);
  const vault = options?.vault ?? 'unlocked';
  let schedule: HostFile['drift_schedule'] = options?.schedule ?? {
    enabled: true,
    cron: '* * * * *',
  };
  let now = options?.now ?? new Date('2026-01-01T00:00:00.000Z');
  const registry = {
    async listHosts() {
      return [hostSummary(vault)];
    },
    getRawHost() {
      return rawHost(schedule);
    },
    async getHost(): Promise<HostDetail | undefined> {
      return hostDetail(vault);
    },
  };
  const inventory = {
    async getHostInventory() {
      return {
        hostId: 'pve-01',
        name: 'PVE 01',
        status: options?.inventoryStatus ?? 'online',
        guests: [
          {
            hostId: 'pve-01',
            vmid: 112,
            name: 'guest-112',
            type: 'lxc' as const,
            status: 'running',
            node: 'pve-01',
          },
          {
            hostId: 'pve-01',
            vmid: 113,
            name: 'guest-113',
            type: 'vm' as const,
            status: 'stopped',
            node: 'pve-01',
          },
        ],
        channels: {
          ssh: { ok: true, status: 'connected' as const },
          api: { ok: false, status: 'not_configured' as const },
        },
        lastRefreshedAt: now.toISOString(),
        ...(options?.inventoryStatus === 'error'
          ? { error: 'host unavailable' }
          : {}),
      } as Awaited<
        ReturnType<
          import('../inventory/service.js').LiveInventoryService['getHostInventory']
        >
      >;
    },
  };
  const scheduler = new DriftScheduler(repos, queue, registry, inventory, {
    now: () => now,
    baseBackoffMs: options?.baseBackoffMs,
    maxBackoffMs: 10 * 60_000,
    pollIntervalMs: 1_000,
    onError: options?.onError,
  });
  scheduler.registerQueueHandler();
  return {
    handle,
    repos,
    queue,
    scheduler,
    registry,
    setNow(value: Date) {
      now = value;
    },
    setSchedule(value: HostFile['drift_schedule']) {
      schedule = value;
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    queues.splice(0).map((queue) => queue.stop({ interruptRunning: true })),
  );
});

describe('DriftScheduler', () => {
  it('enqueues each UTC cron slot once and records scheduled audit', async () => {
    const test = await fixture();
    try {
      await test.queue.start();
      await expect(test.scheduler.tick()).resolves.toBe(1);
      await expect(test.scheduler.tick()).resolves.toBe(0);
      const jobs = await test.repos.jobs.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        type: 'drift.check',
        reason: 'schedule',
        status: expect.stringMatching(/running|completed/),
      });
      await expect(test.queue.waitForJob(jobs[0]!.id)).resolves.toMatchObject({
        status: 'completed',
      });
      expect(
        await test.repos.auditLogs.search({ reason: 'schedule' }),
      ).toMatchObject({
        total: 1,
        items: [
          expect.objectContaining({
            action: 'drift.check',
            jobId: jobs[0]!.id,
          }),
        ],
      });
      expect(
        await test.repos.settings.get('scheduler.drift.pve-01.backoff'),
      ).toBeNull();
    } finally {
      test.scheduler.stop();
      test.handle.close();
    }
  });

  it('backs off locked vaults and retries after the persisted deadline', async () => {
    const test = await fixture({ vault: 'locked', baseBackoffMs: 120_000 });
    try {
      await test.queue.start();
      await test.scheduler.tick();
      const first = (await test.repos.jobs.list())[0]!;
      await expect(test.queue.waitForJob(first.id)).resolves.toMatchObject({
        status: 'failed',
        error: expect.stringContaining('Vault is locked'),
      });
      const backoff = JSON.parse(
        (await test.repos.settings.get('scheduler.drift.pve-01.backoff'))!,
      ) as { failures: number; nextAttemptAt: string };
      expect(backoff).toMatchObject({ failures: 1 });
      expect(backoff.nextAttemptAt).toBe('2026-01-01T00:02:00.000Z');

      test.setNow(new Date('2026-01-01T00:01:00.000Z'));
      await expect(test.scheduler.tick()).resolves.toBe(0);
      expect(await test.repos.jobs.list()).toHaveLength(1);

      test.setNow(new Date('2026-01-01T00:02:00.000Z'));
      await expect(test.scheduler.tick()).resolves.toBe(1);
      const jobs = await test.repos.jobs.list();
      expect(jobs).toHaveLength(2);
      const retry = jobs.find((job) => job.id !== first.id)!;
      await test.queue.waitForJob(retry.id);
      expect(
        await test.repos.auditLogs.search({ reason: 'schedule' }),
      ).toMatchObject({ total: 2 });
    } finally {
      test.scheduler.stop();
      test.handle.close();
    }
  });

  it('handles disabled, invalid, non-matching, active, and enqueue-failure cases', async () => {
    const onError = vi.fn();
    const test = await fixture({ onError });
    try {
      test.setSchedule({ enabled: false, cron: '* * * * *' });
      await expect(test.scheduler.tick()).resolves.toBe(0);
      test.setSchedule({ enabled: true, cron: 'invalid' });
      await expect(test.scheduler.tick()).resolves.toBe(0);
      expect(onError).toHaveBeenCalledOnce();
      test.setSchedule({ enabled: true, cron: '1 * * * *' });
      await expect(test.scheduler.tick()).resolves.toBe(0);

      test.setSchedule({ enabled: true, cron: '* * * * *' });
      await test.repos.jobs.create({
        id: 'already-active',
        hostId: 'pve-01',
        lane: 'host',
        type: 'drift.check',
        reason: 'schedule',
        status: 'queued',
        priority: 0,
        createdAt: new Date(),
      });
      await expect(test.scheduler.tick()).resolves.toBe(0);

      await test.repos.jobs.updateStatus('already-active', 'cancelled');
      test.setNow(new Date('2026-01-01T00:01:00.000Z'));
      const enqueue = vi
        .spyOn(test.queue, 'enqueue')
        .mockRejectedValueOnce(new Error('queue offline'));
      await expect(test.scheduler.tick()).rejects.toThrow('queue offline');
      enqueue.mockRestore();
      expect(
        await test.repos.settings.get('scheduler.drift.pve-01.last_slot'),
      ).toBeNull();
    } finally {
      test.scheduler.stop();
      test.handle.close();
    }
  });

  it('starts once, stops cleanly, and ignores overlapping ticks', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test = await fixture();
    const list = vi
      .spyOn(test.registry, 'listHosts')
      .mockImplementationOnce(async () => {
        await gate;
        return [hostSummary('unlocked')];
      });
    try {
      const first = test.scheduler.tick();
      await expect(test.scheduler.tick()).resolves.toBe(0);
      release();
      await first;
      list.mockRestore();

      test.scheduler.start();
      test.scheduler.start();
      await vi.advanceTimersByTimeAsync(1_000);
      test.scheduler.stop();
      test.scheduler.stop();
    } finally {
      test.scheduler.stop();
      test.handle.close();
    }
  });

  it('backs off host inventory failures and rejects missing hosts', async () => {
    const unavailable = await fixture({ inventoryStatus: 'error' });
    try {
      await unavailable.queue.start();
      await unavailable.scheduler.tick();
      const job = (await unavailable.repos.jobs.list())[0]!;
      await expect(unavailable.queue.waitForJob(job.id)).resolves.toMatchObject(
        {
          status: 'failed',
          error: 'host unavailable',
        },
      );
    } finally {
      unavailable.scheduler.stop();
      unavailable.handle.close();
    }

    const missing = await fixture();
    const getHost = vi
      .spyOn(missing.registry, 'getHost')
      .mockResolvedValue(undefined);
    try {
      await missing.queue.start();
      await missing.scheduler.tick();
      const job = (await missing.repos.jobs.list())[0]!;
      await expect(missing.queue.waitForJob(job.id)).resolves.toMatchObject({
        status: 'failed',
        error: expect.stringContaining('no longer configured'),
      });
    } finally {
      getHost.mockRestore();
      missing.scheduler.stop();
      missing.handle.close();
    }
  });
});
