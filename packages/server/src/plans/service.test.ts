import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  planGuestImport,
  StalePlanError,
  type GuestDeployment,
} from '@hacm/core';
import { createDatabase } from '../db/connection.js';
import { createSqliteRepositories } from '../db/repositories/sqlite.js';
import type { LiveGuestDetail } from '../inventory/types.js';
import { DurableJobQueue } from '../jobs/queue.js';
import { PlanService, planServiceInternals } from './service.js';
import {
  PlanConfirmationError,
  PlanAdminRequiredError,
  PlanOverwriteRequiredError,
  PlanNotFoundError,
  PlanStateError,
} from './types.js';

const tempDirs: string[] = [];

function liveDetail(guest: GuestDeployment): LiveGuestDetail {
  return {
    summary: {
      hostId: 'pve-01',
      vmid: guest.id,
      name: guest.name,
      type: guest.type,
      status: 'running',
      node: 'pve-01',
    },
    rawConfig: `hostname: ${guest.name}`,
    canonicalConfig: guest,
    source: 'api',
  };
}

function lxc(vmid: number, ram = 2_048): GuestDeployment {
  return {
    id: vmid,
    name: `guest-${vmid}`,
    type: 'lxc',
    cpu: 2,
    ram,
    disks: [],
    network: [],
  };
}

async function createFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'hacm-plans-'));
  tempDirs.push(dataDir);
  const handle = createDatabase({ path: ':memory:' });
  const repos = createSqliteRepositories(handle.db);
  const queue = new DurableJobQueue(repos);
  const guests = new Map<number, GuestDeployment>([
    [112, lxc(112)],
    [113, lxc(113)],
  ]);
  const inventory = {
    async getGuestLiveConfig(_hostId: string, vmid: number) {
      const guest = guests.get(vmid);
      if (!guest) throw new Error(`Guest ${vmid} not found`);
      return liveDetail(guest);
    },
  };
  const service = new PlanService(repos, queue, inventory, { dataDir });
  service.registerQueueHandler();
  return { dataDir, handle, repos, queue, guests, service };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('PlanService', () => {
  it('runs dry-run and apply through durable jobs without mutating early', async () => {
    const fixture = await createFixture();
    try {
      const plan = await fixture.service.createGuestImportPlan({
        hostId: 'pve-01',
        vmid: 112,
        createdBy: 'operator-1',
      });
      expect(plan).toMatchObject({
        operation: 'guest.import',
        status: 'ready',
        destructive: false,
        changes: [{ action: 'create' }],
      });
      const target = join(
        fixture.dataDir,
        'hosts/pve-01/112-guest-112/deployment.yaml',
      );

      await fixture.queue.start();
      const dryRun = await fixture.service.queueApply(plan.id, {
        dryRun: true,
        user: { id: 'operator-1', username: 'operator', role: 'operator' },
      });
      await expect(
        fixture.queue.waitForJob(dryRun.job.id),
      ).resolves.toMatchObject({ status: 'completed' });
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await fixture.service.get(plan.id)).toMatchObject({
        status: 'ready',
      });
      expect(await fixture.repos.jobSteps.list(dryRun.job.id)).toEqual([
        expect.objectContaining({ status: 'skipped' }),
      ]);

      const applied = await fixture.service.queueApply(plan.id, {
        user: { id: 'operator-1', username: 'operator', role: 'operator' },
      });
      const appliedJob = await fixture.queue.waitForJob(applied.job.id);
      const stored = await fixture.repos.plans.get(plan.id);
      const storedPayload = JSON.parse(stored!.payloadJson) as {
        generatedAt: string;
      };
      expect(storedPayload.generatedAt).toBe(plan.createdAt);
      const regenerated = await planGuestImport({
        dataDir: fixture.dataDir,
        hostId: 'pve-01',
        guest: fixture.guests.get(112)!,
        generatedAt: new Date(storedPayload.generatedAt),
      });
      expect(
        await readFile(target, 'utf8'),
        appliedJob.error ?? undefined,
      ).toBe(regenerated.yamlContent);
      expect(appliedJob.status, appliedJob.error ?? undefined).toBe(
        'completed',
      );
      expect(await readFile(target, 'utf8')).toContain('ram: 2048');
      expect(await fixture.service.get(plan.id)).toMatchObject({
        status: 'applied',
        approvedBy: 'operator-1',
        lastJobId: applied.job.id,
      });
      expect(await fixture.repos.jobSteps.list(applied.job.id)).toEqual([
        expect.objectContaining({ status: 'completed' }),
      ]);
      expect(
        await fixture.repos.auditLogs.search({ action: 'plan.apply' }),
      ).toMatchObject({ total: 1 });
    } finally {
      await fixture.queue.stop({ interruptRunning: true });
      fixture.handle.close();
    }
  });

  it('refuses stale plans before queueing', async () => {
    const fixture = await createFixture();
    try {
      const plan = await fixture.service.createGuestImportPlan({
        hostId: 'pve-01',
        vmid: 113,
      });
      fixture.guests.set(113, lxc(113, 4_096));

      await expect(
        fixture.service.queueApply(plan.id, {
          user: { id: 'operator-1', username: 'operator', role: 'operator' },
        }),
      ).rejects.toBeInstanceOf(StalePlanError);
      expect(await fixture.service.get(plan.id)).toMatchObject({
        status: 'stale',
        error: expect.stringContaining('is stale'),
      });
      expect(await fixture.repos.jobs.list()).toHaveLength(0);
    } finally {
      await fixture.queue.stop({ interruptRunning: true });
      fixture.handle.close();
    }
  });

  it('rechecks freshness inside the queued job before mutation', async () => {
    const fixture = await createFixture();
    try {
      const plan = await fixture.service.createGuestImportPlan({
        hostId: 'pve-01',
        vmid: 113,
      });
      const queued = await fixture.service.queueApply(plan.id, {
        user: { id: 'operator-1', username: 'operator', role: 'operator' },
      });
      fixture.guests.set(113, lxc(113, 8_192));
      await fixture.queue.start();

      await expect(
        fixture.queue.waitForJob(queued.job.id),
      ).resolves.toMatchObject({
        status: 'failed',
        error: expect.stringContaining('stale'),
      });
      expect(await fixture.service.get(plan.id)).toMatchObject({
        status: 'stale',
      });
      await expect(
        readFile(
          join(fixture.dataDir, 'hosts/pve-01/113-guest-113/deployment.yaml'),
          'utf8',
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fixture.queue.stop({ interruptRunning: true });
      fixture.handle.close();
    }
  });

  it('requires explicit overwrite intent and typed confirmation', async () => {
    const fixture = await createFixture();
    try {
      await fixture.queue.start();
      const initial = await fixture.service.createGuestImportPlan({
        hostId: 'pve-01',
        vmid: 112,
      });
      const initialApply = await fixture.service.queueApply(initial.id, {
        user: { id: 'admin-1', username: 'admin', role: 'admin' },
      });
      await fixture.queue.waitForJob(initialApply.job.id);
      const target = join(
        fixture.dataDir,
        'hosts/pve-01/112-guest-112/deployment.yaml',
      );
      await writeFile(
        target,
        `${await readFile(target, 'utf8')}installation:\n  type: community_script\n  url: https://example.invalid/install.sh\n  pinned_commit: abcdef1\n`,
        'utf8',
      );
      fixture.guests.set(112, lxc(112, 4_096));

      await expect(
        fixture.service.createGuestImportPlan({
          hostId: 'pve-01',
          vmid: 112,
        }),
      ).rejects.toBeInstanceOf(PlanOverwriteRequiredError);
      await expect(
        fixture.service.createGuestImportPlan({
          hostId: 'pve-01',
          vmid: 112,
          overwrite: true,
          createdByRole: 'operator',
        }),
      ).rejects.toBeInstanceOf(PlanAdminRequiredError);
      const overwrite = await fixture.service.createGuestImportPlan({
        hostId: 'pve-01',
        vmid: 112,
        overwrite: true,
        createdByRole: 'admin',
      });
      expect(overwrite).toMatchObject({
        destructive: true,
        confirmationText: 'OVERWRITE pve-01/112',
        changes: [{ action: 'update', destructive: true }],
      });
      await expect(
        fixture.service.queueApply(overwrite.id, {
          confirmation: 'overwrite',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        }),
      ).rejects.toBeInstanceOf(PlanConfirmationError);
      await expect(
        fixture.service.queueApply(overwrite.id, {
          confirmation: 'OVERWRITE pve-01/112',
          user: {
            id: 'operator-1',
            username: 'operator',
            role: 'operator',
          },
        }),
      ).rejects.toBeInstanceOf(PlanAdminRequiredError);

      const queued = await fixture.service.queueApply(overwrite.id, {
        confirmation: 'OVERWRITE pve-01/112',
        user: { id: 'admin-1', username: 'admin', role: 'admin' },
      });
      const overwriteJob = await fixture.queue.waitForJob(queued.job.id);
      expect(overwriteJob.status, overwriteJob.error ?? undefined).toBe(
        'completed',
      );
      expect(await readFile(target, 'utf8')).toContain('ram: 4096');
    } finally {
      await fixture.queue.stop({ interruptRunning: true });
      fixture.handle.close();
    }
  });

  it('rejects invalid plan states and records queue failures', async () => {
    const fixture = await createFixture();
    const user = {
      id: 'operator-1',
      username: 'operator',
      role: 'operator' as const,
    };
    try {
      await expect(
        fixture.service.queueApply('missing', { user }),
      ).rejects.toBeInstanceOf(PlanNotFoundError);

      const applied = await fixture.service.createGuestImportPlan({
        hostId: 'pve-01',
        vmid: 112,
      });
      await fixture.repos.plans.updateStatus(applied.id, 'applied');
      await expect(
        fixture.service.queueApply(applied.id, { user }),
      ).rejects.toThrow('already been applied');

      const applying = await fixture.service.createGuestImportPlan({
        hostId: 'pve-01',
        vmid: 113,
      });
      await fixture.repos.jobs.create({
        id: 'active-apply',
        hostId: 'pve-01',
        vmid: 113,
        lane: 'guest',
        type: 'plan.apply',
        status: 'queued',
        priority: 0,
        createdAt: new Date(),
      });
      await fixture.repos.plans.updateStatus(applying.id, 'applying', {
        lastJobId: 'active-apply',
      });
      await expect(
        fixture.service.queueApply(applying.id, { user }),
      ).rejects.toThrow('already applying');

      const stale = await fixture.service.createGuestImportPlan({
        hostId: 'pve-01',
        vmid: 112,
      });
      await fixture.repos.plans.updateStatus(stale.id, 'stale');
      await expect(
        fixture.service.queueApply(stale.id, { user }),
      ).rejects.toThrow('must be recreated');

      const unclaimed = await fixture.service.createGuestImportPlan({
        hostId: 'pve-01',
        vmid: 112,
      });
      const claim = vi
        .spyOn(fixture.repos.plans, 'claimApply')
        .mockResolvedValueOnce(null);
      await expect(
        fixture.service.queueApply(unclaimed.id, { user }),
      ).rejects.toThrow('could not be claimed');
      claim.mockRestore();

      const enqueueFailure = await fixture.service.createGuestImportPlan({
        hostId: 'pve-01',
        vmid: 113,
      });
      const enqueue = vi
        .spyOn(fixture.queue, 'enqueue')
        .mockRejectedValueOnce(new Error('queue offline'));
      await expect(
        fixture.service.queueApply(enqueueFailure.id, { user }),
      ).rejects.toThrow('queue offline');
      enqueue.mockRestore();
      expect(await fixture.service.get(enqueueFailure.id)).toMatchObject({
        status: 'failed',
        error: 'queue offline',
      });

      await fixture.repos.plans.create({
        id: 'unsupported-operation',
        operation: 'unsupported',
        hostId: 'pve-01',
        status: 'ready',
        summary: 'Unsupported',
        changesJson: JSON.stringify([
          { id: 'one', action: 'update', summary: 'One' },
        ]),
        warningsJson: '[]',
        destructive: false,
        stateFingerprint: 'a'.repeat(64),
        payloadJson: '{}',
        createdAt: new Date(),
      });
      expect(await fixture.service.get('unsupported-operation')).toMatchObject({
        target: { hostId: 'pve-01', resourceType: 'host' },
      });
      await expect(
        fixture.service.queueApply('unsupported-operation', { user }),
      ).rejects.toThrow("operation 'unsupported'");
    } finally {
      await fixture.queue.stop({ interruptRunning: true });
      fixture.handle.close();
    }
  });

  it('validates direct job execution payloads and ownership', async () => {
    const fixture = await createFixture();
    try {
      const job = await fixture.repos.jobs.create({
        id: 'direct-job',
        hostId: 'pve-01',
        vmid: 112,
        lane: 'guest',
        type: 'plan.apply',
        status: 'running',
        priority: 0,
        createdAt: new Date(),
      });
      const context = (payload: unknown) => ({
        job,
        payload,
        signal: new AbortController().signal,
        log: vi.fn(async () => undefined),
        prompt: vi.fn(async () => undefined),
      });
      await expect(fixture.service.executeJob(context({}))).rejects.toThrow(
        'payload is invalid',
      );
      await expect(
        fixture.service.executeJob(
          context({ planId: 'missing-plan', dryRun: true }),
        ),
      ).rejects.toBeInstanceOf(PlanNotFoundError);

      const plan = await fixture.service.createGuestImportPlan({
        hostId: 'pve-01',
        vmid: 112,
      });
      await expect(
        fixture.service.executeJob(context({ planId: plan.id, dryRun: false })),
      ).rejects.toThrow('is not claimed by job');
    } finally {
      await fixture.queue.stop({ interruptRunning: true });
      fixture.handle.close();
    }
  });

  it('reconciles applying plans whose jobs stopped or disappeared', async () => {
    const fixture = await createFixture();
    try {
      const statuses = [
        'failed',
        'cancelled',
        'interrupted',
        'running',
      ] as const;
      for (const [index, status] of statuses.entries()) {
        const jobId = `reconcile-job-${status}`;
        await fixture.repos.jobs.create({
          id: jobId,
          hostId: 'pve-01',
          lane: 'host',
          type: 'plan.apply',
          status,
          priority: 0,
          error: status === 'failed' ? 'fixture failure' : null,
          createdAt: new Date(index),
        });
        await fixture.repos.plans.create({
          id: `reconcile-${status}`,
          operation: 'guest.import',
          hostId: 'pve-01',
          vmid: 112,
          status: 'applying',
          summary: 'Reconcile',
          changesJson: JSON.stringify([
            { id: 'one', action: 'update', summary: 'One' },
          ]),
          warningsJson: '[]',
          destructive: false,
          stateFingerprint: 'b'.repeat(64),
          payloadJson: '{}',
          lastJobId: jobId,
          createdAt: new Date(index),
        });
      }
      await fixture.repos.plans.create({
        id: 'reconcile-missing',
        operation: 'guest.import',
        hostId: 'pve-01',
        vmid: 112,
        status: 'applying',
        summary: 'Missing job',
        changesJson: JSON.stringify([
          { id: 'one', action: 'update', summary: 'One' },
        ]),
        warningsJson: '[]',
        destructive: false,
        stateFingerprint: 'c'.repeat(64),
        payloadJson: '{}',
        lastJobId: 'does-not-exist',
        createdAt: new Date(10),
      });

      expect(await fixture.service.get('reconcile-missing')).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('no longer exists'),
      });
      expect(await fixture.service.get('reconcile-failed')).toMatchObject({
        status: 'failed',
        error: 'fixture failure',
      });
      expect(await fixture.service.get('reconcile-cancelled')).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('cancelled'),
      });
      expect(await fixture.service.get('reconcile-interrupted')).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('interrupted'),
      });
      expect(await fixture.service.get('reconcile-running')).toMatchObject({
        status: 'applying',
      });
      expect(await fixture.service.list({ limit: 2 })).toHaveLength(2);
    } finally {
      await fixture.queue.stop({ interruptRunning: true });
      fixture.handle.close();
    }
  });

  it('loads defaults and preserves invalid target details in a plan', async () => {
    const fixture = await createFixture();
    try {
      const hostDir = join(fixture.dataDir, 'hosts', 'pve-01');
      await mkdir(hostDir, { recursive: true });
      const defaults = join(hostDir, 'default-deployment.yaml');
      await writeFile(
        defaults,
        'schema_version: 1\ncpu: 2\nram: 2048\n',
        'utf8',
      );
      const withDefaults = await fixture.service.createGuestImportPlan({
        hostId: 'pve-01',
        vmid: 112,
      });
      expect(withDefaults.warnings[0]).toContain('cpu, ram');

      const target = join(hostDir, '113-guest-113', 'deployment.yaml');
      await mkdir(join(hostDir, '113-guest-113'), { recursive: true });
      await writeFile(target, 'schema_version: [', 'utf8');
      const invalidTarget = await fixture.service.createGuestImportPlan({
        hostId: 'pve-01',
        vmid: 113,
        overwrite: true,
        createdByRole: 'admin',
      });
      expect(invalidTarget.changes[0]?.before).toEqual({ invalidYaml: true });

      await writeFile(defaults, 'schema_version: invalid\n', 'utf8');
      await expect(
        fixture.service.createGuestImportPlan({
          hostId: 'pve-01',
          vmid: 112,
        }),
      ).rejects.toThrow();
      await rm(defaults);
      const directoryTarget = join(hostDir, '112-guest-112', 'deployment.yaml');
      await mkdir(directoryTarget, { recursive: true });
      await expect(
        fixture.service.createGuestImportPlan({
          hostId: 'pve-01',
          vmid: 112,
          overwrite: true,
          createdByRole: 'admin',
        }),
      ).rejects.toThrow();
    } finally {
      await fixture.queue.stop({ interruptRunning: true });
      fixture.handle.close();
    }
  });

  it('fails unsupported planned changes and executor refusals', async () => {
    const fixture = await createFixture();
    try {
      await fixture.queue.start();
      const unsupported = await fixture.service.createGuestImportPlan({
        hostId: 'pve-01',
        vmid: 112,
      });
      fixture.handle.sqlite
        .prepare('UPDATE plans SET changes_json = ? WHERE id = ?')
        .run(
          JSON.stringify([
            { id: 'unsupported', action: 'create', summary: 'Unsupported' },
          ]),
          unsupported.id,
        );
      const unsupportedJob = await fixture.service.queueApply(unsupported.id, {
        user: { id: 'admin-1', username: 'admin', role: 'admin' },
      });
      await expect(
        fixture.queue.waitForJob(unsupportedJob.job.id),
      ).resolves.toMatchObject({
        status: 'failed',
        error: expect.stringContaining('unsupported change'),
      });

      const initial = await fixture.service.createGuestImportPlan({
        hostId: 'pve-01',
        vmid: 113,
      });
      const initialJob = await fixture.service.queueApply(initial.id, {
        user: { id: 'admin-1', username: 'admin', role: 'admin' },
      });
      await fixture.queue.waitForJob(initialJob.job.id);
      fixture.guests.set(113, lxc(113, 4_096));
      const refused = await fixture.service.createGuestImportPlan({
        hostId: 'pve-01',
        vmid: 113,
        overwrite: true,
        createdByRole: 'admin',
      });
      const stored = await fixture.repos.plans.get(refused.id);
      const payload = JSON.parse(stored!.payloadJson) as Record<
        string,
        unknown
      >;
      fixture.handle.sqlite
        .prepare('UPDATE plans SET payload_json = ? WHERE id = ?')
        .run(JSON.stringify({ ...payload, overwrite: false }), refused.id);
      const refusedJob = await fixture.service.queueApply(refused.id, {
        confirmation: 'OVERWRITE pve-01/113',
        user: { id: 'admin-1', username: 'admin', role: 'admin' },
      });
      await expect(
        fixture.queue.waitForJob(refusedJob.job.id),
      ).resolves.toMatchObject({
        status: 'failed',
        error: expect.stringContaining('could not apply'),
      });
    } finally {
      await fixture.queue.stop({ interruptRunning: true });
      fixture.handle.close();
    }
  });

  it('keeps the local-only transport unavailable', async () => {
    await expect(
      planServiceInternals.unavailableTransport.exec(['true']),
    ).rejects.toBeInstanceOf(PlanStateError);
    await expect(
      planServiceInternals.unavailableTransport.readFile('/tmp/file'),
    ).rejects.toBeInstanceOf(PlanStateError);
    await expect(
      planServiceInternals.unavailableTransport.writeFile('/tmp/file', ''),
    ).rejects.toBeInstanceOf(PlanStateError);
  });
});
