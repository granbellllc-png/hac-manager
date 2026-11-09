import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeTransport,
  managedGuestUuid,
  type GuestDeployment,
} from '@hacm/core';
import { createDatabase } from '../db/connection.js';
import { createSqliteRepositories } from '../db/repositories/sqlite.js';
import type { ConnectionManager } from '../router/manager.js';
import type { DurableJobQueue } from '../jobs/queue.js';
import { DurableJobQueue as Queue } from '../jobs/queue.js';
import { PlanService } from './service.js';
import { PlanAdminRequiredError, PlanStateError } from './types.js';

const tempDirs: string[] = [];

const deploymentYaml = `schema_version: 1
id: 112
name: example-lxc
type: lxc
cpu: 2
ram: 1024
unprivileged: true
ostype: debian
onboot: true
startup: order=2,up=30
tags:
  - app
disks:
  - name: rootfs
    storage: local-lvm
    size_gb: 10
network:
  - index: 0
    bridge: vmbr0
    ip: 192.0.2.112/24
    gateway: 192.0.2.1
    mac: !expr "mac('A2:B1:C1', host.index, 0, vmid)"
installation:
  type: template
  template: local:vztmpl/debian-12-standard.tar.zst
`;

const hostYaml = `schema_version: 1
id: pve-01
name: pve-01
type: proxmox
index: 1
connection:
  ssh:
    host: 192.0.2.10
`;

const vmDeploymentYaml = `schema_version: 1
id: 112
name: example-vm
type: vm
cpu: 2
ram: 1024
disks: []
network: []
installation:
  type: clone
  template_id: 9000
`;

const fullVmDeploymentYaml = `schema_version: 1
id: 112
name: example-vm
type: vm
cpu: 2
ram: 2048
bios: ovmf
guest_agent: true
disks:
  - name: scsi0
    storage: local-lvm
    size_gb: 20
network:
  - index: 0
    bridge: vmbr0
    ip: 192.0.2.112/24
    gateway: 192.0.2.1
installation:
  type: clone
  template_id: 9000
`;

function vmScriptTransport(): FakeTransport {
  const stamp = managedGuestUuid('pve-01', 112);
  const nameOnly = 'name: example-vm';
  const configured = [
    nameOnly,
    'tags: hacm-managed',
    `description: hacm-managed: ${stamp}`,
  ].join('\n');
  const sized = 'scsi0: local-lvm:vm-112-disk-0,size=20G';
  const transport = new FakeTransport()
    .onExec('test -f /etc/pve/local/qemu-server/112.conf', { exitCode: 1 })
    .onExec('test -f /etc/pve/local/lxc/112.conf', { exitCode: 1 })
    .onExec(/^qm clone /, { stdout: 'cloned' })
    .onExec(/^qm set 112 /, { stdout: 'configured' })
    .onExec(/^qm start /, { stdout: 'started' })
    .onExec('qm status 112', { stdout: 'status: running' })
    .onExec('qm status 112', { stdout: 'status: stopped' }, { once: true })
    .onExec('qm status 112', { stdout: 'status: stopped' }, { once: true })
    .onExec('qm agent 112 ping', { stdout: '' });
  for (const config of [
    nameOnly,
    nameOnly,
    configured,
    sized,
    sized,
  ].reverse()) {
    transport.onExec('qm config 112', { stdout: config }, { once: true });
  }
  return transport;
}

function lxcDeployment(): GuestDeployment {
  return {
    id: 112,
    name: 'example-lxc',
    type: 'lxc',
    cpu: 2,
    ram: 1024,
    disks: [],
    network: [],
    installation: {
      type: 'template',
      template: 'local:vztmpl/debian-12-standard.tar.zst',
    },
  };
}

function routerFor(
  transport: FakeTransport,
): Pick<ConnectionManager, 'getRouter' | 'secretManager'> {
  return {
    async getRouter() {
      return transport as never;
    },
    secretManager: undefined as never,
  };
}

function scriptTransport(): FakeTransport {
  const stamp = managedGuestUuid('pve-01', 112);
  return new FakeTransport()
    .onExec('test -f /etc/pve/local/qemu-server/112.conf', { exitCode: 1 })
    .onExec('test -f /etc/pve/local/lxc/112.conf', { exitCode: 1 })
    .onExec('pveam list local', {
      stdout: 'local:vztmpl/debian-12-standard.tar.zst 120 MB',
    })
    .onExec(/^pct create 112 /, { stdout: 'created' })
    .onExec('pct config 112', {
      stdout: [
        'hostname: example-lxc',
        'tags: app;hacm-managed',
        `description: hacm-managed: ${stamp}`,
      ].join('\n'),
    });
}

async function createFixture(
  options: {
    readonly deployment?: string | null;
    readonly transport?: FakeTransport;
  } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'hacm-plan-create-'));
  tempDirs.push(dataDir);
  const hostDir = join(dataDir, 'hosts', 'pve-01');
  await mkdir(hostDir, { recursive: true });
  await writeFile(join(hostDir, 'host.yaml'), hostYaml, 'utf8');
  const deployment =
    options.deployment === undefined ? deploymentYaml : options.deployment;
  if (deployment !== null) {
    const guestDir = join(hostDir, '112-example-lxc');
    await mkdir(guestDir, { recursive: true });
    await writeFile(join(guestDir, 'deployment.yaml'), deployment, 'utf8');
  }

  const handle = createDatabase({ path: ':memory:' });
  const repos = createSqliteRepositories(handle.db);
  const queue: DurableJobQueue = new Queue(repos);
  const transport = options.transport ?? scriptTransport();
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
    undefined,
    routerFor(transport),
  );
  service.registerQueueHandler();
  let jobSequence = 0;

  return {
    dataDir,
    handle,
    repos,
    queue,
    service,
    transport,
    async start() {
      await queue.start();
    },
    async stop() {
      await queue.stop({ interruptRunning: false });
      handle.close();
    },
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
        log: async () => undefined,
        prompt: async () => undefined,
      };
    },
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('PlanService LXC creation', () => {
  it('plans and creates an LXC from the data-dir deployment', async () => {
    const fixture = await createFixture();
    try {
      const plan = await fixture.service.createGuestCreatePlan({
        hostId: 'pve-01',
        vmid: 112,
        createdBy: 'admin-1',
        createdByRole: 'admin',
      });
      expect(plan).toMatchObject({
        operation: 'guest.create',
        status: 'ready',
        destructive: false,
        summary:
          'Create LXC 112 (example-lxc) from local:vztmpl/debian-12-standard.tar.zst',
      });
      expect(plan.changes).toEqual([
        expect.objectContaining({
          id: 'create-guest',
          action: 'create',
          after: expect.objectContaining({
            vmid: 112,
            template: 'local:vztmpl/debian-12-standard.tar.zst',
          }),
        }),
      ]);

      await fixture.start();
      const queued = await fixture.service.queueApply(plan.id, {
        user: { id: 'admin-1', username: 'admin', role: 'admin' },
      });
      await expect(
        fixture.queue.waitForJob(queued.job.id),
      ).resolves.toMatchObject({ status: 'completed' });
      expect(await fixture.service.get(plan.id)).toMatchObject({
        status: 'applied',
      });

      const mutations = fixture.transport.execArgv.filter(
        (argv) => argv[0] === 'pct' && argv[1] === 'create',
      );
      expect(mutations).toHaveLength(1);
      expect(mutations[0]).toEqual(
        expect.arrayContaining([
          'pct',
          'create',
          '112',
          'local:vztmpl/debian-12-standard.tar.zst',
          '--hostname',
          'example-lxc',
          '--tags',
          'app;hacm-managed',
        ]),
      );
      expect(mutations[0]?.join(' ')).toContain(
        `--description hacm-managed: ${managedGuestUuid('pve-01', 112)}`,
      );
      expect(mutations[0]?.join(' ')).toContain('hwaddr=A2:B1:C1:01:E0:12');
    } finally {
      await fixture.stop();
    }
  });

  it('does not mutate during a dry-run apply', async () => {
    const fixture = await createFixture();
    try {
      const plan = await fixture.service.createGuestCreatePlan({
        hostId: 'pve-01',
        vmid: 112,
        createdByRole: 'admin',
      });
      await fixture.start();
      const queued = await fixture.service.queueApply(plan.id, {
        dryRun: true,
        user: { id: 'admin-1', username: 'admin', role: 'admin' },
      });
      await expect(
        fixture.queue.waitForJob(queued.job.id),
      ).resolves.toMatchObject({ status: 'completed' });
      expect(fixture.transport.execArgv).not.toContainEqual(
        expect.arrayContaining(['pct', 'create']),
      );
      expect(await fixture.service.get(plan.id)).toMatchObject({
        status: 'ready',
      });
    } finally {
      await fixture.stop();
    }
  });

  it('rejects non-admin creation and admin-only apply', async () => {
    const fixture = await createFixture();
    try {
      await expect(
        fixture.service.createGuestCreatePlan({
          hostId: 'pve-01',
          vmid: 112,
          createdByRole: 'operator',
        }),
      ).rejects.toBeInstanceOf(PlanAdminRequiredError);
      await expect(
        fixture.service.createGuestCreatePlan({
          hostId: 'pve-01',
          vmid: 112,
        }),
      ).rejects.toBeInstanceOf(PlanAdminRequiredError);

      const plan = await fixture.service.createGuestCreatePlan({
        hostId: 'pve-01',
        vmid: 112,
        createdByRole: 'admin',
      });
      await expect(
        fixture.service.queueApply(plan.id, {
          user: { id: 'operator-1', username: 'operator', role: 'operator' },
        }),
      ).rejects.toBeInstanceOf(PlanAdminRequiredError);
    } finally {
      await fixture.stop();
    }
  });

  it('plans and creates a VM from a clone deployment', async () => {
    const fixture = await createFixture({
      deployment: fullVmDeploymentYaml,
      transport: vmScriptTransport(),
    });
    try {
      const plan = await fixture.service.createGuestCreatePlan({
        hostId: 'pve-01',
        vmid: 112,
        guestType: 'vm',
        createdBy: 'admin-1',
        createdByRole: 'admin',
      });
      expect(plan).toMatchObject({
        operation: 'guest.create',
        status: 'ready',
        destructive: false,
        summary: 'Create VM 112 (example-vm) from template 9000',
      });
      expect(plan.changes).toEqual([
        expect.objectContaining({
          id: 'create-guest',
          action: 'create',
          after: expect.objectContaining({
            vmid: 112,
            type: 'vm',
            template: 'template 9000',
          }),
        }),
      ]);

      await fixture.start();
      const queued = await fixture.service.queueApply(plan.id, {
        user: { id: 'admin-1', username: 'admin', role: 'admin' },
      });
      await expect(
        fixture.queue.waitForJob(queued.job.id),
      ).resolves.toMatchObject({ status: 'completed' });
      expect(await fixture.service.get(plan.id)).toMatchObject({
        status: 'applied',
      });

      const clone = fixture.transport.execArgv.find(
        (argv) => argv[0] === 'qm' && argv[1] === 'clone',
      );
      expect(clone).toEqual([
        'qm',
        'clone',
        '9000',
        '112',
        '--name',
        'example-vm',
        '--full',
        '1',
        '--storage',
        'local-lvm',
      ]);
      const configure = fixture.transport.execArgv.find(
        (argv) => argv[0] === 'qm' && argv[1] === 'set',
      );
      expect(configure?.join(' ')).toContain('--tags hacm-managed');
      expect(configure?.join(' ')).toContain(
        `--description hacm-managed: ${managedGuestUuid('pve-01', 112)}`,
      );
      expect(fixture.transport.execArgv).not.toContainEqual(
        expect.arrayContaining(['qm', 'resize']),
      );
      expect(fixture.transport.execArgv).toContainEqual(['qm', 'start', '112']);
    } finally {
      await fixture.stop();
    }
  });

  it('requires a data-dir deployment and an LXC deployment', async () => {
    const missing = await createFixture({ deployment: null });
    try {
      await expect(
        missing.service.createGuestCreatePlan({
          hostId: 'pve-01',
          vmid: 112,
          createdByRole: 'admin',
        }),
      ).rejects.toThrow('No deployment YAML is configured');
    } finally {
      await missing.stop();
    }

    const vm = await createFixture({
      deployment: vmDeploymentYaml,
    });
    try {
      await expect(
        vm.service.createGuestCreatePlan({
          hostId: 'pve-01',
          vmid: 112,
          guestType: 'lxc',
          createdByRole: 'admin',
        }),
      ).rejects.toThrow('LXC creation only supports');
    } finally {
      await vm.stop();
    }
  });

  it('refuses a VMID that is already occupied', async () => {
    const fixture = await createFixture();
    fixture.transport.onExec('test -f /etc/pve/local/lxc/112.conf', {
      exitCode: 0,
    });
    try {
      await expect(
        fixture.service.createGuestCreatePlan({
          hostId: 'pve-01',
          vmid: 112,
          createdByRole: 'admin',
        }),
      ).rejects.toThrow(
        "VMID 112 is already occupied by a different workload on host 'pve-01'",
      );
    } finally {
      await fixture.stop();
    }
  });

  it('returns a conflict when the deployment changes before apply', async () => {
    const fixture = await createFixture();
    try {
      const plan = await fixture.service.createGuestCreatePlan({
        hostId: 'pve-01',
        vmid: 112,
        createdByRole: 'admin',
      });
      await writeFile(
        join(
          fixture.dataDir,
          'hosts',
          'pve-01',
          '112-example-lxc',
          'deployment.yaml',
        ),
        deploymentYaml.replace('ram: 1024', 'ram: 2048'),
        'utf8',
      );
      await expect(
        fixture.service.queueApply(plan.id, {
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        }),
      ).rejects.toThrow('stale');
      expect(await fixture.service.get(plan.id)).toMatchObject({
        status: 'stale',
      });
    } finally {
      await fixture.stop();
    }
  });

  it('rejects unresolved tags and missing provisioning connections', async () => {
    const unresolved = await createFixture({
      deployment: deploymentYaml.replace(
        'mac: !expr "mac(\'A2:B1:C1\', host.index, 0, vmid)"',
        'mac: !secret example_mac',
      ),
    });
    try {
      await expect(
        unresolved.service.createGuestCreatePlan({
          hostId: 'pve-01',
          vmid: 112,
          createdByRole: 'admin',
        }),
      ).rejects.toThrow('could not be resolved');
    } finally {
      await unresolved.stop();
    }

    const handle = createDatabase({ path: ':memory:' });
    const repos = createSqliteRepositories(handle.db);
    const queue = new Queue(repos);
    const connected = await createFixture();
    const service = new PlanService(
      repos,
      queue,
      {
        async getGuestLiveConfig() {
          return {
            canonicalConfig: lxcDeployment(),
            summary: {
              hostId: 'pve-01',
              vmid: 112,
              name: 'example-lxc',
              type: 'lxc',
              status: 'stopped',
              node: 'pve-01',
            },
            rawConfig: 'hostname: example-lxc',
            source: 'api',
          };
        },
      },
      {
        dataDir: connected.dataDir,
        getRawHost: () => ({ id: 'pve-01', name: 'pve-01', index: 1 }) as never,
      },
    );
    try {
      await expect(
        service.createGuestCreatePlan({
          hostId: 'pve-01',
          vmid: 112,
          createdByRole: 'admin',
        }),
      ).rejects.toBeInstanceOf(PlanStateError);
    } finally {
      handle.close();
      await connected.stop();
    }
  });

  it('rejects create jobs without a VMID and without a deployment', async () => {
    const fixture = await createFixture();
    try {
      await fixture.repos.plans.create({
        id: 'create-no-vmid',
        operation: 'guest.create',
        hostId: 'pve-01',
        vmid: null,
        status: 'ready',
        summary: 'Fixture plan',
        changesJson: '[]',
        warningsJson: '[]',
        destructive: false,
        stateFingerprint: 'a'.repeat(64),
        payloadJson: JSON.stringify({
          relativePath: 'hosts/pve-01/112-example-lxc/deployment.yaml',
          generatedAt: new Date().toISOString(),
        }),
        createdAt: new Date(),
      });
      await expect(
        fixture.service.executeJob(
          await fixture.context({ planId: 'create-no-vmid', dryRun: true }),
        ),
      ).rejects.toThrow('requires a guest VMID');

      const plan = await fixture.service.createGuestCreatePlan({
        hostId: 'pve-01',
        vmid: 112,
        createdByRole: 'admin',
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
        fixture.service.executeJob(
          await fixture.context({ planId: plan.id, dryRun: true }),
        ),
      ).rejects.toThrow('stale');
    } finally {
      await fixture.stop();
    }
  });
});
