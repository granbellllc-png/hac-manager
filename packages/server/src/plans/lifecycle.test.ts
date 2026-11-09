import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  managedGuestUuid,
  MANAGED_GUEST_TAG,
  StalePlanError,
  type GuestDeployment,
} from '@hacm/core';
import { createDatabase } from '../db/connection.js';
import { createSqliteRepositories } from '../db/repositories/sqlite.js';
import type { InsertPlanRow } from '../db/schema.js';
import type { GuestLifecycleService } from '../guests/service.js';
import type { GuestSnapshot } from '../guests/types.js';
import { DurableJobQueue } from '../jobs/queue.js';
import { JOB_PRIORITY } from '../jobs/types.js';
import { PlanService } from './service.js';
import {
  PlanConfirmationError,
  PlanNotFoundError,
  PlanStateError,
} from './types.js';

const tempDirs: string[] = [];

function snapshot(overrides: Partial<GuestSnapshot> = {}): GuestSnapshot {
  const deployment: GuestDeployment = {
    id: 112,
    name: 'example-lxc',
    type: 'lxc',
    cpu: 2,
    ram: 1024,
    disks: [],
    network: [],
    tags: ['app'],
    extra: { description: 'Owner: alice' },
  };
  return {
    hostId: 'pve-01',
    vmid: 112,
    type: 'lxc',
    summary: {
      hostId: 'pve-01',
      vmid: 112,
      name: 'example-lxc',
      type: 'lxc',
      status: 'stopped',
      node: 'pve-01',
    },
    deployment,
    status: 'stopped',
    ...overrides,
  };
}

function planRow(
  overrides: Partial<InsertPlanRow> & { id: string },
): InsertPlanRow {
  return {
    operation: 'guest.power',
    hostId: 'pve-01',
    vmid: 112,
    status: 'ready',
    summary: 'Fixture plan',
    changesJson: '[]',
    warningsJson: '[]',
    destructive: false,
    stateFingerprint: 'a'.repeat(64),
    payloadJson: JSON.stringify({
      action: 'start',
      targetStatus: 'running',
      generatedAt: new Date().toISOString(),
    }),
    createdAt: new Date(),
    ...overrides,
  };
}

async function createFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'hacm-plan-lifecycle-'));
  tempDirs.push(dataDir);
  const handle = createDatabase({ path: ':memory:' });
  const repos = createSqliteRepositories(handle.db);
  const queue = new DurableJobQueue(repos);
  let jobSequence = 0;
  let current = snapshot();
  const lifecycle = {
    async requireSnapshot() {
      return current;
    },
    async getSnapshot() {
      return current;
    },
    verifyForMutation: vi.fn(async () => current),
    executePower: vi.fn(
      async (): Promise<{ source: 'api' | 'ssh'; upid?: string }> => ({
        source: 'ssh',
      }),
    ),
    waitForPowerState: vi.fn(async () => ({
      status: current.status,
      expected: current.status,
    })),
    stampGuest: vi.fn(
      async (
        _hostId: string,
        _vmid: number,
        options: { dryRun?: boolean } = {},
      ) => {
        const tags = [...(current.deployment.tags ?? []), MANAGED_GUEST_TAG];
        const description = `${String(current.deployment.extra?.['description'] ?? '')}\nhacm-managed: ${managedGuestUuid('pve-01', 112)}`;
        if (!options.dryRun) {
          current = snapshot({
            deployment: {
              ...current.deployment,
              tags,
              extra: { description },
            } as GuestDeployment,
            status: current.status,
          });
        }
        return { tags, description, changed: true };
      },
    ),
  };
  const service = new PlanService(
    repos,
    queue,
    {
      async getGuestLiveConfig() {
        throw new Error('not used');
      },
    },
    { dataDir },
    lifecycle as unknown as GuestLifecycleService,
  );
  service.registerQueueHandler();
  return {
    dataDir,
    handle,
    repos,
    queue,
    service,
    lifecycle,
    async context(payload: unknown) {
      jobSequence += 1;
      const job = await repos.jobs.create({
        id: `direct-job-${jobSequence}`,
        hostId: 'pve-01',
        vmid: 112,
        lane: 'guest',
        type: 'plan.apply',
        status: 'running',
        priority: 0,
        createdAt: new Date(),
      });
      return {
        job,
        payload,
        signal: new AbortController().signal,
        log: vi.fn(async () => undefined),
        prompt: vi.fn(async () => undefined),
      };
    },
    setSnapshot(next: GuestSnapshot) {
      current = next;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('PlanService guest lifecycle operations', () => {
  it('plans and applies a prioritized power action', async () => {
    const fixture = await createFixture();
    try {
      const plan = await fixture.service.createGuestPowerPlan({
        hostId: 'pve-01',
        vmid: 112,
        action: 'start',
        createdBy: 'operator-1',
      });
      expect(plan).toMatchObject({
        operation: 'guest.power',
        destructive: false,
        status: 'ready',
        changes: [expect.objectContaining({ id: 'power', action: 'execute' })],
      });
      expect(plan.confirmationText).toBeUndefined();

      await fixture.queue.start();
      const queued = await fixture.service.queueApply(plan.id, {
        user: { id: 'operator-1', username: 'operator', role: 'operator' },
      });
      expect(queued.job.priority).toBe(JOB_PRIORITY.power);
      await expect(
        fixture.queue.waitForJob(queued.job.id),
      ).resolves.toMatchObject({ status: 'completed' });
      expect(fixture.lifecycle.executePower).toHaveBeenCalledWith(
        'pve-01',
        112,
        'start',
        expect.objectContaining({ log: expect.any(Function) }),
      );
      expect(await fixture.service.get(plan.id)).toMatchObject({
        status: 'applied',
      });
    } finally {
      await fixture.queue.stop({ interruptRunning: false });
      fixture.handle.close();
    }
  });

  it('requires typed confirmation for destructive power actions and detects stale plans', async () => {
    const fixture = await createFixture();
    try {
      const plan = await fixture.service.createGuestPowerPlan({
        hostId: 'pve-01',
        vmid: 112,
        action: 'stop',
      });
      expect(plan).toMatchObject({
        destructive: true,
        confirmationText: 'STOP pve-01/112',
      });
      await expect(
        fixture.service.queueApply(plan.id, {
          confirmation: 'stop',
          user: { id: 'operator-1', username: 'operator', role: 'operator' },
        }),
      ).rejects.toBeInstanceOf(PlanConfirmationError);

      fixture.setSnapshot(
        snapshot({
          deployment: {
            ...snapshot().deployment,
            name: 'other-workload',
          } as GuestDeployment,
        }),
      );
      await expect(
        fixture.service.queueApply(plan.id, {
          confirmation: 'STOP pve-01/112',
          user: { id: 'operator-1', username: 'operator', role: 'operator' },
        }),
      ).rejects.toBeInstanceOf(StalePlanError);
      expect(await fixture.service.get(plan.id)).toMatchObject({
        status: 'stale',
      });
    } finally {
      fixture.handle.close();
    }
  });

  it('skips apply during a dry run and honours already-satisfied power state', async () => {
    const fixture = await createFixture();
    try {
      fixture.setSnapshot(
        snapshot({
          status: 'running',
          summary: { ...snapshot().summary, status: 'running' },
        }),
      );
      const plan = await fixture.service.createGuestPowerPlan({
        hostId: 'pve-01',
        vmid: 112,
        action: 'start',
      });
      await fixture.queue.start();
      const queued = await fixture.service.queueApply(plan.id, {
        dryRun: true,
        user: { id: 'operator-1', username: 'operator', role: 'operator' },
      });
      await expect(
        fixture.queue.waitForJob(queued.job.id),
      ).resolves.toMatchObject({ status: 'completed' });
      expect(fixture.lifecycle.executePower).not.toHaveBeenCalled();
      expect(await fixture.service.get(plan.id)).toMatchObject({
        status: 'ready',
      });
      const steps = await fixture.repos.jobSteps.list(queued.job.id);
      expect(steps).toEqual([
        expect.objectContaining({
          status: 'completed',
          resultJson: expect.stringContaining('"check":{"status":"running"}'),
        }),
      ]);
    } finally {
      await fixture.queue.stop({ interruptRunning: false });
      fixture.handle.close();
    }
  });

  it('stamps an unmanaged guest and rejects an already-stamped guest', async () => {
    const fixture = await createFixture();
    try {
      const plan = await fixture.service.createGuestStampPlan({
        hostId: 'pve-01',
        vmid: 112,
      });
      expect(plan).toMatchObject({
        operation: 'guest.stamp',
        summary: 'Stamp guest 112 (example-lxc) as managed',
      });
      await fixture.queue.start();
      const queued = await fixture.service.queueApply(plan.id, {
        user: { id: 'operator-1', username: 'operator', role: 'operator' },
      });
      expect(queued.job.priority).toBe(JOB_PRIORITY.normal);
      await expect(
        fixture.queue.waitForJob(queued.job.id),
      ).resolves.toMatchObject({ status: 'completed' });
      expect(fixture.lifecycle.stampGuest).toHaveBeenCalledWith('pve-01', 112);
      expect(await fixture.service.get(plan.id)).toMatchObject({
        status: 'applied',
      });

      fixture.lifecycle.stampGuest.mockResolvedValueOnce({
        tags: [MANAGED_GUEST_TAG],
        description: 'stamped',
        changed: false,
      });
      await expect(
        fixture.service.createGuestStampPlan({ hostId: 'pve-01', vmid: 112 }),
      ).rejects.toBeInstanceOf(PlanStateError);
    } finally {
      await fixture.queue.stop({ interruptRunning: false });
      fixture.handle.close();
    }
  });

  it('refuses lifecycle operations when no lifecycle service is configured', async () => {
    const handle = createDatabase({ path: ':memory:' });
    const repos = createSqliteRepositories(handle.db);
    const queue = new DurableJobQueue(repos);
    const service = new PlanService(
      repos,
      queue,
      {
        async getGuestLiveConfig() {
          throw new Error('not used');
        },
      },
      { dataDir: '/tmp' },
    );
    try {
      await expect(
        service.createGuestPowerPlan({
          hostId: 'pve-01',
          vmid: 112,
          action: 'start',
        }),
      ).rejects.toBeInstanceOf(PlanStateError);
    } finally {
      handle.close();
    }
  });

  it('plans shutdown and reboot actions and stamps guests without metadata', async () => {
    const fixture = await createFixture();
    try {
      fixture.setSnapshot(
        snapshot({
          deployment: {
            id: 112,
            name: 'example-lxc',
            type: 'lxc',
            cpu: 2,
            ram: 1024,
            disks: [],
            network: [],
          } as GuestDeployment,
        }),
      );
      const stamp = await fixture.service.createGuestStampPlan({
        hostId: 'pve-01',
        vmid: 112,
      });
      expect(stamp.changes[0]?.before).toEqual({ tags: [], description: '' });

      const shutdown = await fixture.service.createGuestPowerPlan({
        hostId: 'pve-01',
        vmid: 112,
        action: 'shutdown',
      });
      expect(shutdown.warnings).toEqual([]);

      const reboot = await fixture.service.createGuestPowerPlan({
        hostId: 'pve-01',
        vmid: 112,
        action: 'reboot',
      });
      expect(reboot.warnings[0]).toContain('restart');
      expect(reboot.confirmationText).toBe('REBOOT pve-01/112');
    } finally {
      fixture.handle.close();
    }
  });

  it('applies shutdown and reboot power plans', async () => {
    const fixture = await createFixture();
    try {
      fixture.setSnapshot(
        snapshot({
          status: 'running',
          summary: { ...snapshot().summary, status: 'running' },
        }),
      );
      await fixture.queue.start();
      for (const action of ['shutdown', 'reboot'] as const) {
        const plan = await fixture.service.createGuestPowerPlan({
          hostId: 'pve-01',
          vmid: 112,
          action,
        });
        const queued = await fixture.service.queueApply(plan.id, {
          confirmation: `${action.toUpperCase()} pve-01/112`,
          user: { id: 'operator-1', username: 'operator', role: 'operator' },
        });
        await expect(
          fixture.queue.waitForJob(queued.job.id),
        ).resolves.toMatchObject({ status: 'completed' });
        expect(fixture.lifecycle.executePower).toHaveBeenCalledWith(
          'pve-01',
          112,
          action,
          expect.any(Object),
        );
        expect(await fixture.service.get(plan.id)).toMatchObject({
          status: 'applied',
        });
      }
    } finally {
      await fixture.queue.stop({ interruptRunning: false });
      fixture.handle.close();
    }
  });

  it('rejects lifecycle jobs without a vmid, unknown action or operation', async () => {
    const fixture = await createFixture();
    try {
      await fixture.repos.plans.create(planRow({ id: 'no-vmid', vmid: null }));
      await expect(
        fixture.service.executeJob(
          await fixture.context({ planId: 'no-vmid', dryRun: true }),
        ),
      ).rejects.toThrow('requires a guest VMID');

      await fixture.repos.plans.create(
        planRow({
          id: 'unknown-action',
          payloadJson: JSON.stringify({
            action: 'explode',
            targetStatus: 'running',
            generatedAt: new Date().toISOString(),
          }),
        }),
      );
      await expect(
        fixture.service.executeJob(
          await fixture.context({ planId: 'unknown-action', dryRun: true }),
        ),
      ).rejects.toThrow("unknown action 'explode'");

      await fixture.repos.plans.create(
        planRow({ id: 'unsupported-operation', operation: 'guest.restore' }),
      );
      await expect(
        fixture.service.executeJob(
          await fixture.context({
            planId: 'unsupported-operation',
            dryRun: true,
          }),
        ),
      ).rejects.toThrow('is not supported');
    } finally {
      fixture.handle.close();
    }
  });

  it('rejects lifecycle plans without a vmid during freshness checks', async () => {
    const fixture = await createFixture();
    const user = {
      id: 'operator-1',
      username: 'operator',
      role: 'operator' as const,
    };
    try {
      await fixture.repos.plans.create(
        planRow({
          id: 'import-no-vmid',
          operation: 'guest.import',
          vmid: null,
          payloadJson: JSON.stringify({
            overwrite: false,
            requiresAdmin: false,
            generatedAt: new Date().toISOString(),
          }),
        }),
      );
      await expect(
        fixture.service.queueApply('import-no-vmid', { user }),
      ).rejects.toThrow('requires a guest VMID');

      await fixture.repos.plans.create(
        planRow({ id: 'power-no-vmid', vmid: null }),
      );
      await expect(
        fixture.service.queueApply('power-no-vmid', { user }),
      ).rejects.toThrow('requires a guest VMID');
    } finally {
      fixture.handle.close();
    }
  });

  it('returns null for missing plans and handles destructive plans without text', async () => {
    const fixture = await createFixture();
    const user = {
      id: 'operator-1',
      username: 'operator',
      role: 'operator' as const,
    };
    try {
      expect(await fixture.service.get('missing-plan')).toBeNull();
      await expect(
        fixture.service.queueApply('missing-plan', { user }),
      ).rejects.toBeInstanceOf(PlanNotFoundError);

      await fixture.repos.plans.create(
        planRow({
          id: 'destructive-no-text',
          destructive: true,
          confirmationText: null,
        }),
      );
      await expect(
        fixture.service.queueApply('destructive-no-text', {
          user,
          confirmation: 'anything',
        }),
      ).rejects.toBeInstanceOf(PlanConfirmationError);
    } finally {
      fixture.handle.close();
    }
  });

  it('marks plans failed when the queue rejects the job', async () => {
    const fixture = await createFixture();
    const user = {
      id: 'operator-1',
      username: 'operator',
      role: 'operator' as const,
    };
    try {
      const plan = await fixture.service.createGuestPowerPlan({
        hostId: 'pve-01',
        vmid: 112,
        action: 'start',
      });
      const enqueue = vi.spyOn(fixture.queue, 'enqueue');
      enqueue.mockRejectedValueOnce(new Error('queue down'));
      await expect(
        fixture.service.queueApply(plan.id, { user, dryRun: true }),
      ).rejects.toThrow('queue down');
      expect(await fixture.service.get(plan.id)).toMatchObject({
        status: 'ready',
      });

      enqueue.mockRejectedValueOnce('string down');
      await expect(
        fixture.service.queueApply(plan.id, { user }),
      ).rejects.toThrow('string down');
      expect(await fixture.service.get(plan.id)).toMatchObject({
        status: 'failed',
        error: 'string down',
      });
    } finally {
      fixture.handle.close();
    }
  });

  it('records the Proxmox task id from a power apply', async () => {
    const fixture = await createFixture();
    try {
      const upid = 'UPID:pve-01:0:0:0:start:112:0';
      fixture.lifecycle.executePower.mockResolvedValueOnce({
        source: 'api',
        upid,
      });
      const plan = await fixture.service.createGuestPowerPlan({
        hostId: 'pve-01',
        vmid: 112,
        action: 'start',
      });
      await fixture.queue.start();
      const queued = await fixture.service.queueApply(plan.id, {
        user: { id: 'operator-1', username: 'operator', role: 'operator' },
      });
      await expect(
        fixture.queue.waitForJob(queued.job.id),
      ).resolves.toMatchObject({ status: 'completed' });
      const steps = await fixture.repos.jobSteps.list(queued.job.id);
      expect(steps[0]?.resultJson).toContain(upid);
    } finally {
      await fixture.queue.stop({ interruptRunning: false });
      fixture.handle.close();
    }
  });

  it('skips a stamp apply when the guest is already stamped', async () => {
    const fixture = await createFixture();
    try {
      fixture.setSnapshot(
        snapshot({
          deployment: {
            ...snapshot().deployment,
            tags: [MANAGED_GUEST_TAG],
            extra: {
              description: `hacm-managed: ${managedGuestUuid('pve-01', 112)}`,
            },
          } as GuestDeployment,
        }),
      );
      fixture.lifecycle.stampGuest.mockResolvedValueOnce({
        tags: [MANAGED_GUEST_TAG],
        description: `hacm-managed: ${managedGuestUuid('pve-01', 112)}`,
        changed: true,
      });
      const plan = await fixture.service.createGuestStampPlan({
        hostId: 'pve-01',
        vmid: 112,
      });
      await fixture.queue.start();
      const queued = await fixture.service.queueApply(plan.id, {
        dryRun: true,
        user: { id: 'operator-1', username: 'operator', role: 'operator' },
      });
      await expect(
        fixture.queue.waitForJob(queued.job.id),
      ).resolves.toMatchObject({ status: 'completed' });
      const steps = await fixture.repos.jobSteps.list(queued.job.id);
      expect(steps[0]?.resultJson).toContain(managedGuestUuid('pve-01', 112));
      expect(fixture.lifecycle.stampGuest).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.queue.stop({ interruptRunning: false });
      fixture.handle.close();
    }
  });

  it('fails a stamp plan when verification does not find the stamp', async () => {
    const fixture = await createFixture();
    try {
      const plan = await fixture.service.createGuestStampPlan({
        hostId: 'pve-01',
        vmid: 112,
      });
      fixture.lifecycle.stampGuest.mockResolvedValue({
        tags: [MANAGED_GUEST_TAG],
        description: 'stamped',
        changed: true,
      });
      await fixture.queue.start();
      const queued = await fixture.service.queueApply(plan.id, {
        user: { id: 'operator-1', username: 'operator', role: 'operator' },
      });
      await expect(
        fixture.queue.waitForJob(queued.job.id),
      ).resolves.toMatchObject({
        status: 'failed',
        error: expect.stringContaining('does not carry the expected'),
      });
      expect(await fixture.service.get(plan.id)).toMatchObject({
        status: 'failed',
      });
    } finally {
      await fixture.queue.stop({ interruptRunning: false });
      fixture.handle.close();
    }
  });

  it('marks a lifecycle plan stale when the guest changes before the job runs', async () => {
    const fixture = await createFixture();
    try {
      const plan = await fixture.service.createGuestPowerPlan({
        hostId: 'pve-01',
        vmid: 112,
        action: 'start',
      });
      const queued = await fixture.service.queueApply(plan.id, {
        user: { id: 'operator-1', username: 'operator', role: 'operator' },
      });
      fixture.setSnapshot(
        snapshot({
          deployment: {
            ...snapshot().deployment,
            name: 'renamed-workload',
          } as GuestDeployment,
        }),
      );
      await fixture.queue.start();
      await expect(
        fixture.queue.waitForJob(queued.job.id),
      ).resolves.toMatchObject({ status: 'failed' });
      expect(await fixture.service.get(plan.id)).toMatchObject({
        status: 'stale',
      });
    } finally {
      await fixture.queue.stop({ interruptRunning: false });
      fixture.handle.close();
    }
  });

  it('marks a lifecycle plan failed when execution throws', async () => {
    const fixture = await createFixture();
    try {
      fixture.lifecycle.executePower.mockRejectedValueOnce(
        new Error('power exploded'),
      );
      const plan = await fixture.service.createGuestPowerPlan({
        hostId: 'pve-01',
        vmid: 112,
        action: 'start',
      });
      await fixture.queue.start();
      const queued = await fixture.service.queueApply(plan.id, {
        user: { id: 'operator-1', username: 'operator', role: 'operator' },
      });
      await expect(
        fixture.queue.waitForJob(queued.job.id),
      ).resolves.toMatchObject({ status: 'failed' });
      expect(await fixture.service.get(plan.id)).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('power exploded'),
      });
    } finally {
      await fixture.queue.stop({ interruptRunning: false });
      fixture.handle.close();
    }
  });
});
