import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
import { PlanStateError } from './types.js';

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

const updateYaml = `schema_version: 1
id: 112
name: example-lxc
type: lxc
cpu: 4
ram: 2048
swap: 512
protection: true
tags:
  - app
  - extra
disks:
  - name: rootfs
    storage: local-lvm
    size_gb: 20
network:
  - index: 0
    name: eth0
    bridge: vmbr0
    ip: 192.0.2.112/24
`;

const matchingYaml = `schema_version: 1
id: 112
name: example-lxc
type: lxc
cpu: 2
ram: 1024
swap: 512
protection: true
tags:
  - app
disks:
  - name: rootfs
    storage: local-lvm
    size_gb: 10
network:
  - index: 0
    name: eth0
    bridge: vmbr0
    ip: 192.0.2.112/24
`;

const vmYaml = `schema_version: 1
id: 112
name: example-vm
type: vm
cpu: 2
ram: 1024
disks: []
network: []
`;

const liveConfigBefore = [
  'hostname: example-lxc',
  'cores: 2',
  'memory: 1024',
  'swap: 512',
  'tags: app;hacm-managed',
  'protection: 0',
  'rootfs: local-lvm:vm-112-disk-0,size=10G',
  'net0: name=eth0,bridge=vmbr0,ip=192.0.2.112/24',
  'net1: name=eth1,bridge=vmbr1',
].join('\n');

const liveConfigPending = [
  liveConfigBefore,
  '[PENDING]',
  'cores: 4',
  'memory: 2048',
  'protection: 1',
  'tags: app;extra;hacm-managed',
  'delete: net1',
  'rootfs: local-lvm:vm-112-disk-0,size=20G',
].join('\n');

const liveConfigNoNet1 = [
  'hostname: example-lxc',
  'cores: 2',
  'memory: 1024',
  'swap: 512',
  'tags: app;hacm-managed',
  'protection: 0',
  'rootfs: local-lvm:vm-112-disk-0,size=10G',
  'net0: name=eth0,bridge=vmbr0,ip=192.0.2.112/24',
].join('\n');

const liveConfigAfter = [
  'hostname: example-lxc',
  'cores: 4',
  'memory: 2048',
  'swap: 512',
  'tags: app;extra;hacm-managed',
  'protection: 1',
  'rootfs: local-lvm:vm-112-disk-0,size=20G',
  'net0: name=eth0,bridge=vmbr0,ip=192.0.2.112/24',
].join('\n');

function liveDeployment(): GuestDeployment {
  return {
    id: 112,
    name: 'example-lxc',
    type: 'lxc',
    cpu: 2,
    ram: 1024,
    swap: 512,
    protection: false,
    tags: ['app', 'hacm-managed'],
    disks: [
      {
        name: 'rootfs',
        storage: 'local-lvm',
        size_gb: 10,
        extra: { volume: 'vm-112-disk-0' },
      },
    ],
    network: [
      { index: 0, name: 'eth0', bridge: 'vmbr0', ip: '192.0.2.112/24' },
      { index: 1, name: 'eth1', bridge: 'vmbr1' },
    ],
  };
}

function snapshot(
  deployment: GuestDeployment,
  status = 'running',
): GuestSnapshot {
  return {
    hostId: 'pve-01',
    vmid: 112,
    type: 'lxc',
    summary: {
      hostId: 'pve-01',
      vmid: 112,
      name: deployment.name,
      type: 'lxc',
      status,
      node: 'pve-01',
    },
    deployment,
    status,
  };
}

function transportSequence(...configs: string[]): FakeTransport {
  const transport = new FakeTransport().onExec(/^pct (set|resize) 112 /, {
    stdout: 'ok',
  });
  for (const config of [...configs].reverse()) {
    transport.onExec('pct config 112', { stdout: config }, { once: true });
  }
  return transport;
}

async function createFixture(
  options: {
    readonly yaml?: string;
    readonly live?: GuestDeployment;
    readonly configs?: readonly string[];
  } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'hacm-plan-update-'));
  tempDirs.push(dataDir);
  const hostDir = join(dataDir, 'hosts', 'pve-01');
  await mkdir(hostDir, { recursive: true });
  await writeFile(join(hostDir, 'host.yaml'), hostYaml, 'utf8');
  const guestDir = join(hostDir, '112-example-lxc');
  await mkdir(guestDir, { recursive: true });
  await writeFile(
    join(guestDir, 'deployment.yaml'),
    options.yaml ?? updateYaml,
    'utf8',
  );

  const handle = createDatabase({ path: ':memory:' });
  const repos = createSqliteRepositories(handle.db);
  const queue = new DurableJobQueue(repos);
  const transport = transportSequence(
    ...(options.configs ?? [liveConfigBefore]),
  );
  let current = snapshot(options.live ?? liveDeployment());
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

describe('PlanService LXC configuration updates', () => {
  it('plans CPU, memory, protection, NIC removal and disk growth', async () => {
    const fixture = await createFixture();
    try {
      const plan = await fixture.service.createGuestUpdatePlan({
        hostId: 'pve-01',
        vmid: 112,
        createdBy: 'operator-1',
      });
      expect(plan).toMatchObject({
        operation: 'guest.update',
        status: 'ready',
        destructive: true,
        confirmationText: 'UPDATE pve-01/112',
        summary: 'Update LXC 112 (example-lxc)',
      });
      expect(plan.changes.map((change) => change.id)).toEqual([
        'cpu',
        'ram',
        'tags',
        'protection',
        'net1',
        'disk-rootfs',
      ]);
      expect(plan.changes.find((change) => change.id === 'net1')).toMatchObject(
        { action: 'delete', destructive: true },
      );
      expect(fixture.lifecycle.verifyForMutation).toHaveBeenCalledWith(
        'pve-01',
        112,
        { operation: 'guest.update', allowProtected: false },
      );
    } finally {
      fixture.handle.close();
    }
  });

  it('applies the diff, runs commands and restarts the guest', async () => {
    const fixture = await createFixture({
      configs: [
        liveConfigBefore,
        liveConfigBefore,
        liveConfigPending,
        liveConfigPending,
        liveConfigAfter,
      ],
    });
    try {
      const plan = await fixture.service.createGuestUpdatePlan({
        hostId: 'pve-01',
        vmid: 112,
      });
      await fixture.queue.start();
      const queued = await fixture.service.queueApply(plan.id, {
        confirmation: 'UPDATE pve-01/112',
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
          ['pct', 'set', '112', '--cores', '4'],
          ['pct', 'set', '112', '--memory', '2048'],
          ['pct', 'set', '112', '--delete', 'net1'],
          ['pct', 'resize', '112', 'rootfs', '20G'],
        ]),
      );
      expect(fixture.lifecycle.executePower).toHaveBeenCalledWith(
        'pve-01',
        112,
        'shutdown',
        expect.any(Object),
      );
      expect(fixture.lifecycle.executePower).toHaveBeenCalledWith(
        'pve-01',
        112,
        'start',
        expect.any(Object),
      );
    } finally {
      await fixture.queue.stop({ interruptRunning: false });
      fixture.handle.close();
    }
  });

  it('allows a non-destructive update of a protected guest', async () => {
    const live: GuestDeployment = {
      ...liveDeployment(),
      protection: true,
      network: [liveDeployment().network[0]!],
    };
    const fixture = await createFixture({
      live,
      yaml: updateYaml
        .replace('cpu: 4', 'cpu: 2')
        .replace('ram: 2048', 'ram: 1024')
        .replace('size_gb: 20', 'size_gb: 10'),
      configs: [
        liveConfigNoNet1,
        liveConfigNoNet1,
        [
          'hostname: example-lxc',
          'cores: 2',
          'memory: 1024',
          'swap: 512',
          'tags: app;extra;hacm-managed',
          'protection: 1',
          'rootfs: local-lvm:vm-112-disk-0,size=10G',
          'net0: name=eth0,bridge=vmbr0,ip=192.0.2.112/24',
        ].join('\n'),
      ],
    });
    try {
      const plan = await fixture.service.createGuestUpdatePlan({
        hostId: 'pve-01',
        vmid: 112,
      });
      expect(plan.destructive).toBe(false);
      expect(plan.confirmationText).toBeUndefined();
      expect(fixture.lifecycle.verifyForMutation).toHaveBeenCalledWith(
        'pve-01',
        112,
        { operation: 'guest.update', allowProtected: true },
      );
      await fixture.queue.start();
      const queued = await fixture.service.queueApply(plan.id, {
        user: { id: 'operator-1', username: 'operator', role: 'operator' },
      });
      await expect(
        fixture.queue.waitForJob(queued.job.id),
      ).resolves.toMatchObject({ status: 'completed' });
    } finally {
      await fixture.queue.stop({ interruptRunning: false });
      fixture.handle.close();
    }
  });

  it('does not mutate during a dry-run', async () => {
    const fixture = await createFixture({
      configs: [liveConfigBefore, liveConfigBefore],
    });
    try {
      const plan = await fixture.service.createGuestUpdatePlan({
        hostId: 'pve-01',
        vmid: 112,
      });
      await fixture.queue.start();
      const queued = await fixture.service.queueApply(plan.id, {
        dryRun: true,
        confirmation: 'UPDATE pve-01/112',
        user: { id: 'operator-1', username: 'operator', role: 'operator' },
      });
      await expect(
        fixture.queue.waitForJob(queued.job.id),
      ).resolves.toMatchObject({ status: 'completed' });
      expect(
        fixture.transport.execArgv.some(
          (argv) => argv[0] === 'pct' && argv[1] !== 'config',
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

  it('refuses a disk shrink and an unchanged configuration', async () => {
    const shrink = await createFixture({
      yaml: updateYaml.replace('size_gb: 20', 'size_gb: 5'),
    });
    try {
      await expect(
        shrink.service.createGuestUpdatePlan({ hostId: 'pve-01', vmid: 112 }),
      ).rejects.toThrow('Refusing to shrink rootfs');
    } finally {
      shrink.handle.close();
    }

    const same = await createFixture({
      yaml: matchingYaml,
      live: {
        ...liveDeployment(),
        protection: true,
        network: [liveDeployment().network[0]!],
      },
    });
    try {
      await expect(
        same.service.createGuestUpdatePlan({ hostId: 'pve-01', vmid: 112 }),
      ).rejects.toBeInstanceOf(PlanStateError);
    } finally {
      same.handle.close();
    }
  });

  it('rejects pending live config, VMs and missing YAML', async () => {
    const pending = await createFixture({
      live: {
        ...liveDeployment(),
        extra: { _pending: { cores: '4' } },
      },
    });
    try {
      await expect(
        pending.service.createGuestUpdatePlan({ hostId: 'pve-01', vmid: 112 }),
      ).rejects.toThrow('pending configuration changes');
    } finally {
      pending.handle.close();
    }

    const vm = await createFixture({
      yaml: vmYaml,
      live: {
        id: 112,
        name: 'example-vm',
        type: 'vm',
        cpu: 2,
        ram: 1024,
        disks: [],
        network: [],
      },
    });
    try {
      await expect(
        vm.service.createGuestUpdatePlan({ hostId: 'pve-01', vmid: 112 }),
      ).rejects.toThrow('LXC config updates only support');
    } finally {
      vm.handle.close();
    }

    const missing = await createFixture();
    try {
      await rm(
        join(
          missing.dataDir,
          'hosts',
          'pve-01',
          '112-example-lxc',
          'deployment.yaml',
        ),
      );
      await expect(
        missing.service.createGuestUpdatePlan({ hostId: 'pve-01', vmid: 112 }),
      ).rejects.toThrow('No deployment YAML');
    } finally {
      missing.handle.close();
    }
  });

  it('marks the plan stale when YAML changes before apply', async () => {
    const fixture = await createFixture();
    try {
      const plan = await fixture.service.createGuestUpdatePlan({
        hostId: 'pve-01',
        vmid: 112,
      });
      await writeFile(
        join(
          fixture.dataDir,
          'hosts',
          'pve-01',
          '112-example-lxc',
          'deployment.yaml',
        ),
        updateYaml.replace('cpu: 4', 'cpu: 6'),
        'utf8',
      );
      await expect(
        fixture.service.queueApply(plan.id, {
          confirmation: 'UPDATE pve-01/112',
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

  it('rejects update jobs without a VMID, deployment or matching guest type', async () => {
    const fixture = await createFixture();
    try {
      await fixture.repos.plans.create({
        id: 'update-no-vmid',
        operation: 'guest.update',
        hostId: 'pve-01',
        vmid: null,
        status: 'ready',
        summary: 'Fixture plan',
        changesJson: '[]',
        warningsJson: '[]',
        destructive: false,
        stateFingerprint: 'a'.repeat(64),
        payloadJson: JSON.stringify({
          relativePath: '',
          generatedAt: new Date().toISOString(),
          restartRequired: false,
        }),
        createdAt: new Date(),
      });
      await expect(
        fixture.service.executeJob({
          job: await fixture.repos.jobs.create({
            id: 'job-no-vmid',
            hostId: 'pve-01',
            vmid: 112,
            lane: 'guest',
            type: 'plan.apply',
            status: 'running',
            priority: 0,
            createdAt: new Date(),
          }),
          payload: { planId: 'update-no-vmid', dryRun: true },
          signal: new AbortController().signal,
          log: async () => undefined,
          prompt: async () => undefined,
        }),
      ).rejects.toThrow('requires a guest VMID');

      const plan = await fixture.service.createGuestUpdatePlan({
        hostId: 'pve-01',
        vmid: 112,
      });
      await rm(
        join(
          fixture.dataDir,
          'hosts',
          'pve-01',
          '112-example-lxc',
          'deployment.yaml',
        ),
      );
      await expect(
        fixture.service.executeJob({
          job: await fixture.repos.jobs.create({
            id: 'job-missing-yaml',
            hostId: 'pve-01',
            vmid: 112,
            lane: 'guest',
            type: 'plan.apply',
            status: 'running',
            priority: 0,
            createdAt: new Date(),
          }),
          payload: { planId: plan.id, dryRun: true },
          signal: new AbortController().signal,
          log: async () => undefined,
          prompt: async () => undefined,
        }),
      ).rejects.toThrow('No deployment YAML');
    } finally {
      fixture.handle.close();
    }
  });
});
