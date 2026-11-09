import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport, type GuestDeployment } from '@hacm/core';
import { createDatabase } from '../db/connection.js';
import { createSqliteRepositories } from '../db/repositories/sqlite.js';
import type { GuestLifecycleService } from '../guests/service.js';
import type { GuestSnapshot } from '../guests/types.js';
import { DurableJobQueue } from '../jobs/queue.js';
import type { ConnectionManager } from '../router/manager.js';
import { PlanService } from './service.js';

const tempDirs: string[] = [];

const hostYaml = `schema_version: 1
id: pve-01
name: pve-01
type: proxmox
index: 1
connection:
  ssh:
    host: 192.0.2.10
`;

const deleteYaml = `schema_version: 1
id: 112
name: example-lxc
type: lxc
cpu: 2
ram: 1024
disks: []
network: []
`;

function liveDeployment(
  overrides: Partial<GuestDeployment> = {},
): GuestDeployment {
  return {
    id: 112,
    name: 'example-lxc',
    type: 'lxc',
    cpu: 2,
    ram: 1024,
    disks: [],
    network: [],
    ...overrides,
  } as GuestDeployment;
}

function snapshot(
  deployment: GuestDeployment,
  status = 'running',
): GuestSnapshot {
  return {
    hostId: 'pve-01',
    vmid: 112,
    type: deployment.type,
    summary: {
      hostId: 'pve-01',
      vmid: 112,
      name: deployment.name,
      type: deployment.type,
      status,
      node: 'pve-01',
    },
    deployment,
    status,
  };
}

function simpleTransport(): FakeTransport {
  const transport = new FakeTransport()
    .onExec('pct status 112', { stdout: 'status: stopped' })
    .onExec('pct stop 112', { stdout: 'ok' })
    .onExec('pct destroy 112', { stdout: 'ok' });
  // test -f sequence: stop check present, destroy check present, verify absent.
  transport.onExec(/^test -f /, { exitCode: 1 }, { once: true });
  transport.onExec(/^test -f /, { exitCode: 0 }, { once: true });
  transport.onExec(/^test -f /, { exitCode: 0 }, { once: true });
  transport.onExec(
    'pct status 112',
    { stdout: 'status: running' },
    { once: true },
  );
  return transport;
}

async function createFixture(
  options: {
    readonly yaml?: string;
    readonly live?: GuestDeployment;
    readonly status?: string;
    readonly ignored?: boolean;
    readonly transport?: FakeTransport;
  } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'hacm-plan-delete-'));
  tempDirs.push(dataDir);
  const hostDir = join(dataDir, 'hosts', 'pve-01');
  await mkdir(hostDir, { recursive: true });
  await writeFile(
    join(hostDir, 'host.yaml'),
    options.ignored
      ? `${hostYaml}ignored_guests:\n  - vmid: 112\n    name: example-lxc\n`
      : hostYaml,
    'utf8',
  );
  if (options.yaml !== null) {
    const guestDir = join(hostDir, '112-example-lxc');
    await mkdir(guestDir, { recursive: true });
    await writeFile(
      join(guestDir, 'deployment.yaml'),
      options.yaml ?? deleteYaml,
      'utf8',
    );
  }

  const handle = createDatabase({ path: ':memory:' });
  const repos = createSqliteRepositories(handle.db);
  const queue = new DurableJobQueue(repos);
  const transport = options.transport ?? simpleTransport();
  let current = snapshot(
    options.live ?? liveDeployment(),
    options.status ?? 'running',
  );
  const lifecycle = {
    async requireSnapshot() {
      return current;
    },
    verifyForMutation: vi.fn(async () => current),
    executePower: vi.fn(async () => ({ source: 'ssh' as const })),
    waitForPowerState: vi.fn(async () => ({
      status: 'running',
      expected: 'running',
    })),
  };
  const connections: Pick<ConnectionManager, 'getRouter' | 'secretManager'> = {
    async getRouter() {
      return transport as never;
    },
    secretManager: undefined as never,
  };
  const service = new PlanService(
    repos,
    queue,
    {
      async getGuestLiveConfig() {
        throw new Error('not used');
      },
    },
    {
      dataDir,
      getRawHost: () => ({ id: 'pve-01', name: 'pve-01', index: 1 }) as never,
    },
    lifecycle as unknown as GuestLifecycleService,
    connections,
  );
  service.registerQueueHandler();

  return {
    dataDir,
    handle,
    repos,
    queue,
    service,
    transport,
    lifecycle,
    setLive(next: GuestSnapshot) {
      current = next;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('PlanService safe guest deletion', () => {
  it('plans and applies a running LXC deletion with an audit reason', async () => {
    const fixture = await createFixture();
    try {
      const plan = await fixture.service.createGuestDeletePlan({
        hostId: 'pve-01',
        vmid: 112,
        reason: 'decommission old service',
      });
      expect(plan).toMatchObject({
        operation: 'guest.delete',
        status: 'ready',
        destructive: true,
        confirmationText: 'DELETE pve-01/112',
        summary: 'Delete LXC 112 (example-lxc) on pve-01',
      });
      expect(plan.changes.map((change) => change.id)).toEqual([
        'stop',
        'delete',
      ]);
      expect(fixture.lifecycle.verifyForMutation).toHaveBeenCalledWith(
        'pve-01',
        112,
        { operation: 'guest.delete', allowProtected: false },
      );

      await fixture.queue.start();
      await expect(
        fixture.service.queueApply(plan.id, {
          confirmation: 'DELETE somewhere else',
          user: { id: 'operator-1', username: 'operator', role: 'operator' },
        }),
      ).rejects.toThrow('Typed confirmation');

      const queued = await fixture.service.queueApply(plan.id, {
        confirmation: 'DELETE pve-01/112',
        user: { id: 'operator-1', username: 'operator', role: 'operator' },
      });
      await expect(
        fixture.queue.waitForJob(queued.job.id),
      ).resolves.toMatchObject({ status: 'completed' });
      expect(await fixture.service.get(plan.id)).toMatchObject({
        status: 'applied',
      });
      expect(fixture.transport.execArgv).toEqual(
        expect.arrayContaining([
          ['pct', 'stop', '112'],
          ['pct', 'destroy', '112'],
        ]),
      );
      const audit = await fixture.repos.auditLogs.search({
        action: 'plan.apply',
      });
      expect(audit.items).toHaveLength(1);
      expect(audit.items[0]?.metadataJson).toContain(
        'decommission old service',
      );
    } finally {
      await fixture.queue.stop({ interruptRunning: false });
      fixture.handle.close();
    }
  });

  it('requires explicit unprotect for a protected guest', async () => {
    const fixture = await createFixture({
      live: liveDeployment({ protection: true }),
    });
    try {
      await expect(
        fixture.service.createGuestDeletePlan({
          hostId: 'pve-01',
          vmid: 112,
          reason: 'replace host',
        }),
      ).rejects.toThrow('is protected');

      const plan = await fixture.service.createGuestDeletePlan({
        hostId: 'pve-01',
        vmid: 112,
        reason: 'replace host',
        unprotect: true,
      });
      expect(plan.changes.map((change) => change.id)).toEqual([
        'unprotect',
        'stop',
        'delete',
      ]);
      expect(plan.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Protection is lifted'),
        ]),
      );
      expect(fixture.lifecycle.verifyForMutation).toHaveBeenCalledWith(
        'pve-01',
        112,
        { operation: 'guest.delete', allowProtected: true },
      );
    } finally {
      fixture.handle.close();
    }
  });

  it('plans an optional backup and purge', async () => {
    const fixture = await createFixture({
      live: liveDeployment({
        backup_storage: 'backup-store',
        mounts: [
          {
            index: 0,
            host_path: '/srv/data',
            guest_path: '/data',
            permissions: 'minimal',
          },
        ],
      }),
    });
    try {
      const plan = await fixture.service.createGuestDeletePlan({
        hostId: 'pve-01',
        vmid: 112,
        reason: 'retire',
        backup: true,
        purge: true,
      });
      expect(plan.changes.map((change) => change.id)).toEqual([
        'backup',
        'stop',
        'delete',
      ]);
      expect(plan.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('bind-mounted mp data'),
          expect.stringContaining('Purge is enabled'),
        ]),
      );
      expect(plan.changes[0]).toMatchObject({
        id: 'backup',
        action: 'execute',
      });
      expect(
        plan.changes.find((change) => change.id === 'delete'),
      ).toMatchObject({ action: 'delete', destructive: true });
    } finally {
      fixture.handle.close();
    }
  });

  it('deletes an unmanaged guest without YAML and clears its ignore entry', async () => {
    const fixture = await createFixture({ yaml: null as never, ignored: true });
    try {
      const plan = await fixture.service.createGuestDeletePlan({
        hostId: 'pve-01',
        vmid: 112,
        reason: 'orphan cleanup',
      });
      expect(plan.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('orphan ignore list')]),
      );
      await fixture.queue.start();
      const queued = await fixture.service.queueApply(plan.id, {
        confirmation: 'DELETE pve-01/112',
        user: { id: 'operator-1', username: 'operator', role: 'operator' },
      });
      await expect(
        fixture.queue.waitForJob(queued.job.id),
      ).resolves.toMatchObject({ status: 'completed' });
      const written = await readFile(
        join(fixture.dataDir, 'hosts', 'pve-01', 'host.yaml'),
        'utf8',
      );
      expect(written).not.toContain('vmid: 112');
    } finally {
      await fixture.queue.stop({ interruptRunning: false });
      fixture.handle.close();
    }
  });

  it('rejects a missing reason and marks a status change stale', async () => {
    const fixture = await createFixture();
    try {
      await expect(
        fixture.service.createGuestDeletePlan({
          hostId: 'pve-01',
          vmid: 112,
          reason: '   ',
        }),
      ).rejects.toThrow('reason is required');

      const plan = await fixture.service.createGuestDeletePlan({
        hostId: 'pve-01',
        vmid: 112,
        reason: 'retire',
      });
      fixture.setLive(snapshot(liveDeployment(), 'stopped'));
      await expect(
        fixture.service.queueApply(plan.id, {
          confirmation: 'DELETE pve-01/112',
          user: { id: 'operator-1', username: 'operator', role: 'operator' },
        }),
      ).rejects.toThrow('stale');
      expect(await fixture.service.get(plan.id)).toMatchObject({
        status: 'stale',
      });
    } finally {
      fixture.handle.close();
    }
  });

  it('does not mutate during a dry-run', async () => {
    const fixture = await createFixture();
    try {
      const plan = await fixture.service.createGuestDeletePlan({
        hostId: 'pve-01',
        vmid: 112,
        reason: 'dry run',
      });
      await fixture.queue.start();
      const queued = await fixture.service.queueApply(plan.id, {
        dryRun: true,
        confirmation: 'DELETE pve-01/112',
        user: { id: 'operator-1', username: 'operator', role: 'operator' },
      });
      await expect(
        fixture.queue.waitForJob(queued.job.id),
      ).resolves.toMatchObject({ status: 'completed' });
      expect(
        fixture.transport.execArgv.some(
          (argv) => argv[0] === 'pct' && argv[1] !== 'status',
        ),
      ).toBe(false);
      expect(await fixture.service.get(plan.id)).toMatchObject({
        status: 'ready',
      });
    } finally {
      await fixture.queue.stop({ interruptRunning: false });
      fixture.handle.close();
    }
  });
});
