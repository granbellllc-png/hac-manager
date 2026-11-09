import { describe, expect, it } from 'vitest';
import { serialiseVmProxmoxConfig } from '../codec/vm.js';
import type { GuestDeployment } from '../schema/deployment.js';
import type { StepExecutionContext } from '../steps/types.js';
import { Secret } from '../tags/secret.js';
import { FakeTransport } from '../transport/fake.js';
import {
  createVmUpdateSteps,
  planVmUpdate,
  vmPendingKeys,
  vmUpdateState,
  VmUpdateError,
} from './vm-update.js';

type Vm = Extract<GuestDeployment, { type: 'vm' }>;

function vm(overrides: Partial<Vm> = {}): Vm {
  return {
    id: 112,
    name: 'example-vm',
    type: 'vm',
    cpu: 2,
    ram: 1024,
    bios: 'seabios',
    protection: false,
    disks: [
      {
        name: 'scsi0',
        storage: 'local-lvm',
        size_gb: 20,
        extra: { volume: 'vm-112-disk-0' },
      },
    ],
    network: [],
    ...overrides,
  };
}

function desiredVm(): Vm {
  return vm({
    cpu: 4,
    ram: 2048,
    bios: 'ovmf',
    machine: 'q35',
    guest_agent: true,
    efi_disk: true,
    tpm: true,
    protection: false,
    tags: ['app'],
    cloud_init: {
      user: 'admin',
      password: 'example-password',
      ssh_keys: ['ssh-ed25519 AAAAC3NzaExample admin@example'],
    },
    disks: [
      {
        name: 'scsi0',
        storage: 'local-lvm',
        size_gb: 32,
        extra: { volume: 'vm-112-disk-0', cache: 'writeback' },
      },
      { name: 'virtio0', storage: 'local-lvm', size_gb: 10 },
    ],
    network: [
      {
        index: 0,
        bridge: 'vmbr0',
        ip: '192.0.2.112/24',
        gateway: '192.0.2.1',
        mac: 'A2:B1:C1:01:E0:AA',
      },
      { index: 1, bridge: 'vmbr1' },
    ],
  });
}

function liveVm(): Vm {
  return vm({
    cpu: 2,
    ram: 1024,
    bios: 'seabios',
    protection: true,
    tags: ['app', 'hacm-managed'],
    cloud_init: {
      user: 'old',
      ssh_keys: ['ssh-ed25519 AAAAC3Old old@example'],
    },
    disks: [
      {
        name: 'scsi0',
        storage: 'local-lvm',
        size_gb: 20,
        extra: { volume: 'vm-112-disk-0' },
      },
      {
        name: 'sata0',
        storage: 'local-lvm',
        size_gb: 8,
        extra: { volume: 'vm-112-disk-9' },
      },
    ],
    network: [
      {
        index: 0,
        bridge: 'vmbr0',
        ip: '192.0.2.111/24',
        gateway: '192.0.2.1',
        mac: 'A2:B1:C1:01:E0:AA',
      },
      { index: 2, bridge: 'vmbr2' },
    ],
  });
}

function logger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function context(transport: FakeTransport): StepExecutionContext<undefined> {
  return {
    operationId: 'vm-update-test',
    input: undefined,
    transport,
    logger: logger(),
    dryRun: false,
    signal: new AbortController().signal,
  };
}

function findStep(
  steps: ReturnType<typeof createVmUpdateSteps>,
  fragment: string,
) {
  const step = steps.find((candidate) => candidate.name.includes(fragment));
  if (!step) throw new Error(`Missing step containing '${fragment}'`);
  return step;
}

describe('planVmUpdate', () => {
  it('diffs CPU, RAM, firmware, NICs, cloud-init, disks and protection', () => {
    const plan = planVmUpdate(desiredVm(), liveVm());
    const ids = plan.changes.map((change) => change.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'cpu',
        'ram',
        'bios',
        'machine',
        'guest_agent',
        'efi_disk',
        'tpm',
        'cloud_init_user',
        'cloud_init_ssh_keys',
        'net0',
        'net1',
        'net2',
        'disk-scsi0',
        'disk-virtio0',
        'protection',
      ]),
    );
    expect(plan.changes.find((change) => change.id === 'net2')).toMatchObject({
      action: 'delete',
      destructive: true,
    });
    expect(plan.changes.find((change) => change.id === 'net1')).toMatchObject({
      action: 'create',
    });
    expect(
      plan.changes.find((change) => change.id === 'disk-virtio0'),
    ).toMatchObject({ action: 'create' });
    expect(
      plan.changes.find((change) => change.id === 'protection'),
    ).toMatchObject({ destructive: true, after: false });
    expect(plan.destructive).toBe(true);
    expect(plan.restartRequired).toBe(true);
    expect(plan.blocked).toBe(false);
    expect(plan.commands).toEqual(
      expect.arrayContaining([
        ['qm', 'set', '112', '--cores', '4'],
        ['qm', 'set', '112', '--memory', '2048'],
        ['qm', 'set', '112', '--bios', 'ovmf'],
        ['qm', 'set', '112', '--machine', 'q35'],
        ['qm', 'set', '112', '--agent', 'enabled=1'],
        [
          'qm',
          'set',
          '112',
          '--efidisk0',
          'local-lvm:1,efitype=4m,pre-enrolled-keys=1',
        ],
        ['qm', 'set', '112', '--tpmstate0', 'local-lvm:1,version=v2.0'],
        ['qm', 'resize', '112', 'scsi0', '32G'],
        ['qm', 'set', '112', '--net1', 'bridge=vmbr1'],
        ['qm', 'set', '112', '--delete', 'net2'],
      ]),
    );
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("disk 'scsi0' options differ"),
        expect.stringContaining("disk 'sata0'"),
        expect.stringContaining('cloud-init passwords are not compared'),
        expect.stringContaining('restarted'),
      ]),
    );
  });

  it('reports a plan with no changes for a matching VM', () => {
    const matching = vm({
      cpu: 2,
      ram: 1024,
      tags: ['app', 'hacm-managed'],
      protection: false,
      disks: [
        {
          name: 'scsi0',
          storage: 'local-lvm',
          size_gb: 20,
          extra: { volume: 'vm-112-disk-0' },
        },
      ],
      network: [],
    });
    const plan = planVmUpdate(matching, matching);
    expect(plan.changes).toEqual([]);
    expect(plan.commands).toEqual([]);
    expect(plan.restartRequired).toBe(false);
    expect(plan.destructive).toBe(false);
    expect(plan.blocked).toBe(false);
  });

  it('blocks pending changes and disk shrinks', () => {
    const pending = planVmUpdate(desiredVm(), {
      ...liveVm(),
      extra: { _pending: { cores: '4', memory: '2048' } },
    });
    expect(pending.blocked).toBe(true);
    expect(pending.blockReason).toContain('pending configuration changes');

    const shrink = planVmUpdate(
      vm({
        disks: [{ name: 'scsi0', storage: 'local-lvm', size_gb: 8 }],
      }),
      liveVm(),
    );
    expect(shrink.blocked).toBe(true);
    expect(shrink.blockReason).toContain('Refusing to shrink scsi0');
    expect(shrink.commands.some((argv) => argv[1] === 'resize')).toBe(false);
  });

  it('warns about undeclared live hardware and protection', () => {
    const plan = planVmUpdate(
      vm({ protection: undefined }),
      vm({
        efi_disk: true,
        tpm: true,
        protection: true,
        extra: { ide2: 'local-lvm:cloudinit' },
      }),
    );
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('EFI disk'),
        expect.stringContaining('TPM state disk'),
        expect.stringContaining('protection is enabled'),
      ]),
    );
  });

  it('updates and deletes ipconfig values', () => {
    const plan = planVmUpdate(
      vm({
        network: [{ index: 0, bridge: 'vmbr0', ip: '192.0.2.50/24' }],
        disks: [],
      }),
      vm({
        network: [{ index: 0, bridge: 'vmbr0', ip: '192.0.2.51/24' }],
        disks: [],
      }),
    );
    expect(plan.commands).toEqual(
      expect.arrayContaining([
        ['qm', 'set', '112', '--ipconfig0', 'ip=192.0.2.50/24'],
      ]),
    );

    const removed = planVmUpdate(
      vm({ network: [{ index: 0, bridge: 'vmbr0' }], disks: [] }),
      vm({
        network: [{ index: 0, bridge: 'vmbr0', ip: '192.0.2.51/24' }],
        disks: [],
      }),
    );
    expect(removed.commands).toEqual(
      expect.arrayContaining([['qm', 'set', '112', '--delete', 'ipconfig0']]),
    );
    expect(removed.restartRequired).toBe(true);
  });

  it('rejects unresolved values and reports update state', () => {
    expect(() =>
      planVmUpdate(
        vm({
          disks: [
            {
              name: 'scsi0',
              storage: { tag: 'env', value: 'STORAGE' } as never,
              size_gb: 20,
            },
          ],
        }),
        vm(),
      ),
    ).toThrow('unresolved tag');
    expect(() =>
      planVmUpdate(
        vm({
          disks: [
            { name: 'scsi0', storage: 'local-lvm', size_gb: 'x' as never },
          ],
        }),
        vm(),
      ),
    ).toThrow('finite number');
    expect(() =>
      planVmUpdate(vm({ protection: new Secret('true') as never }), vm()),
    ).toThrow('resolved to a secret');
    expect(vmUpdateState(vm(), vm())).toEqual({ desired: vm(), live: vm() });
  });

  it('ignores malformed pending sections', () => {
    expect(vmPendingKeys({ ...vm(), extra: { _pending: 'x' } })).toEqual([]);
    expect(vmPendingKeys({ ...vm(), extra: { _pending: [] } })).toEqual([]);
    expect(
      vmPendingKeys({
        ...vm(),
        extra: { _pending: { cores: '4', memory: '2' } },
      }),
    ).toEqual(['cores', 'memory']);
  });
});

describe('createVmUpdateSteps', () => {
  it('checks the diff, applies commands and verifies the result', async () => {
    const before = serialiseVmProxmoxConfig(liveVm());
    const after = serialiseVmProxmoxConfig({
      ...desiredVm(),
      protection: undefined,
      tags: ['app', 'hacm-managed'],
    });
    const steps = createVmUpdateSteps(desiredVm(), {
      hostId: 'pve-01',
      restartRequired: false,
    });
    const update = findStep(steps, 'update configuration');

    const check = await update.check(
      context(new FakeTransport().onExec('qm config 112', { stdout: before })),
    );
    expect(check).toMatchObject({ status: 'required' });

    const transport = new FakeTransport()
      .onExec('qm config 112', { stdout: before })
      .onExec(/^qm (set|resize) 112 /, { stdout: 'ok' });
    const applied = await update.apply(context(transport));
    expect(applied).toMatchObject({ status: 'applied' });
    expect(transport.execArgv).toEqual(
      expect.arrayContaining([
        ['qm', 'set', '112', '--cores', '4'],
        ['qm', 'resize', '112', 'scsi0', '32G'],
      ]),
    );

    await expect(
      update.verify(
        context(new FakeTransport().onExec('qm config 112', { stdout: after })),
      ),
    ).resolves.toMatchObject({ changes: 0 });

    await expect(
      update.verify(
        context(
          new FakeTransport().onExec('qm config 112', { stdout: before }),
        ),
      ),
    ).rejects.toThrow('still differs after update');
  });

  it('reports a satisfied check and a blocked diff', async () => {
    const matching = vm({
      tags: ['hacm-managed'],
      protection: false,
      disks: [
        {
          name: 'scsi0',
          storage: 'local-lvm',
          size_gb: 20,
          extra: { volume: 'vm-112-disk-0' },
        },
      ],
      network: [],
    });
    const steps = createVmUpdateSteps(matching, {
      hostId: 'pve-01',
      restartRequired: false,
    });
    const update = findStep(steps, 'update configuration');
    expect(
      await update.check(
        context(
          new FakeTransport().onExec('qm config 112', {
            stdout: serialiseVmProxmoxConfig(matching),
          }),
        ),
      ),
    ).toEqual({ status: 'satisfied', detail: { changes: [] } });

    const blocked = createVmUpdateSteps(
      vm({ disks: [{ name: 'scsi0', storage: 'local-lvm', size_gb: 8 }] }),
      { hostId: 'pve-01', restartRequired: false },
    );
    const blockedUpdate = findStep(blocked, 'update configuration');
    await expect(
      blockedUpdate.check(
        context(
          new FakeTransport().onExec('qm config 112', {
            stdout: serialiseVmProxmoxConfig(vm()),
          }),
        ),
      ),
    ).rejects.toThrow('Refusing to shrink');
  });

  it('fails clearly when reading or applying the configuration fails', async () => {
    const steps = createVmUpdateSteps(desiredVm(), {
      hostId: 'pve-01',
      restartRequired: false,
    });
    const update = findStep(steps, 'update configuration');
    await expect(
      update.check(
        context(
          new FakeTransport().onExec('qm config 112', {
            exitCode: 1,
            stderr: 'permission denied',
          }),
        ),
      ),
    ).rejects.toThrow('permission denied');
    await expect(
      update.check(
        context(new FakeTransport().onExec('qm config 112', { exitCode: 1 })),
      ),
    ).rejects.toThrow('exit code 1');

    const before = serialiseVmProxmoxConfig(liveVm());
    for (const stderr of ['', 'bad option']) {
      await expect(
        update.apply(
          context(
            new FakeTransport()
              .onExec('qm config 112', { stdout: before })
              .onExec(/^qm /, { exitCode: 1, stderr }),
          ),
        ),
      ).rejects.toThrow(stderr === '' ? 'exit code 1' : 'bad option');
    }
  });

  it('returns pending changes and restarts the VM', async () => {
    const before = serialiseVmProxmoxConfig(liveVm());
    const pending = [before, '[PENDING]', 'cores: 4', 'memory: 2048'].join(
      '\n',
    );
    const after = serialiseVmProxmoxConfig({
      ...desiredVm(),
      protection: undefined,
      tags: ['app', 'hacm-managed'],
    });
    const restart = async () => undefined;
    const steps = createVmUpdateSteps(desiredVm(), {
      hostId: 'pve-01',
      restartRequired: true,
      restart,
    });
    const update = findStep(steps, 'update configuration');
    expect(
      await update.verify(
        context(
          new FakeTransport().onExec('qm config 112', { stdout: pending }),
        ),
      ),
    ).toEqual({ pending: ['cores', 'memory'] });

    const reboot = findStep(steps, 'restart VM');
    expect(
      await reboot.check(
        context(
          new FakeTransport().onExec('qm config 112', { stdout: pending }),
        ),
      ),
    ).toEqual({ status: 'required' });
    expect(
      await reboot.check(
        context(new FakeTransport().onExec('qm config 112', { stdout: after })),
      ),
    ).toEqual({ status: 'satisfied', detail: { pending: 0 } });

    await expect(reboot.apply(context(new FakeTransport()))).resolves.toEqual({
      restarted: true,
    });
    await expect(
      reboot.verify(
        context(
          new FakeTransport().onExec('qm config 112', { stdout: pending }),
        ),
      ),
    ).rejects.toThrow('still has pending configuration');
    await expect(
      reboot.verify(
        context(
          new FakeTransport().onExec('qm config 112', { stdout: before }),
        ),
      ),
    ).rejects.toThrow('still differs after restart');
    await expect(
      reboot.verify(
        context(new FakeTransport().onExec('qm config 112', { stdout: after })),
      ),
    ).resolves.toEqual({ pending: 0, changes: 0 });
  });

  it('requires a restart hook when changes need a reboot', async () => {
    const steps = createVmUpdateSteps(desiredVm(), {
      hostId: 'pve-01',
      restartRequired: true,
    });
    const reboot = findStep(steps, 'restart VM');
    await expect(
      reboot.check(
        context(
          new FakeTransport().onExec('qm config 112', {
            stdout: serialiseVmProxmoxConfig(liveVm()),
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(VmUpdateError);
  });
});

describe('VM update edge cases', () => {
  it('resolves secrets and defaults, and formats new disks', () => {
    const plan = planVmUpdate(
      vm({
        protection: true,
        disks: [
          {
            name: 'scsi0',
            storage: new Secret('local-lvm') as never,
            size_gb: new Secret('10') as never,
            extra: {
              volume: 'ignored',
              size: 'ignored',
              cache: '',
              discard: 'on',
            },
          },
          {
            name: 'virtio0',
            storage: undefined as never,
            size_gb: undefined as never,
          },
          {
            name: 'sata0',
            storage: 'local-lvm',
            size_gb: '' as never,
          },
        ],
        network: [],
      }),
      vm({ protection: false, disks: [], network: [] }),
    );
    expect(plan.commands).toEqual(
      expect.arrayContaining([
        ['qm', 'set', '112', '--scsi0', 'local-lvm:10G,discard=on'],
        ['qm', 'set', '112', '--virtio0', 'local-lvm:1G'],
        ['qm', 'set', '112', '--sata0', 'local-lvm:1G'],
        ['qm', 'set', '112', '--protection', '1'],
      ]),
    );
    expect(plan.destructive).toBe(false);
  });

  it('adds NICs with ipconfig and updates changed net strings', () => {
    const plan = planVmUpdate(
      vm({
        disks: [],
        network: [
          { index: 0, bridge: 'vmbr9', ip: '192.0.2.10/24' },
          { index: 1, bridge: 'vmbr1', ip: 'dhcp' },
        ],
      }),
      vm({
        disks: [],
        network: [{ index: 0, bridge: 'vmbr0', ip: '192.0.2.10/24' }],
      }),
    );
    expect(plan.commands).toEqual(
      expect.arrayContaining([
        ['qm', 'set', '112', '--net0', 'bridge=vmbr9'],
        ['qm', 'set', '112', '--net1', 'bridge=vmbr1'],
        ['qm', 'set', '112', '--ipconfig1', 'ip=dhcp'],
      ]),
    );
    expect(
      plan.changes.filter((change) => change.id.startsWith('net')),
    ).toHaveLength(2);
  });

  it('disables the guest agent and compares equal cloud-init values', () => {
    const plan = planVmUpdate(
      vm({
        disks: [],
        guest_agent: false,
        cloud_init: {
          user: 'admin',
          ssh_keys: ['ssh-ed25519 AAAA same'],
        } as never,
        network: [],
      }),
      vm({
        disks: [],
        guest_agent: true,
        cloud_init: {
          user: 'admin',
          ssh_keys: ['ssh-ed25519 AAAA same'],
        },
        network: [],
      }),
    );
    expect(plan.commands).toContainEqual(['qm', 'set', '112', '--agent', '0']);
    expect(
      plan.changes.some((change) => change.id.startsWith('cloud_init')),
    ).toBe(false);
    expect(plan.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining('cloud-init passwords')]),
    );

    const empty = planVmUpdate(
      vm({ disks: [], cloud_init: {} as never, network: [] }),
      vm({ disks: [], network: [] }),
    );
    expect(
      empty.changes.some((change) => change.id.startsWith('cloud_init')),
    ).toBe(false);
  });

  it('warns about disk storage changes and handles missing sizes', () => {
    const plan = planVmUpdate(
      vm({
        disks: [
          { name: 'scsi0', storage: 'local-zfs', size_gb: undefined as never },
        ],
        network: [],
      }),
      vm({
        disks: [{ name: 'scsi0', storage: 'local-lvm', size_gb: 20 }],
        network: [],
      }),
    );
    expect(plan.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('storage differs')]),
    );
    expect(plan.commands.some((argv) => argv[1] === 'resize')).toBe(false);
  });
});

describe('createVmUpdateSteps failure paths', () => {
  const shrinking = () =>
    vm({ disks: [{ name: 'scsi0', storage: 'local-lvm', size_gb: 8 }] });

  it('refuses to apply or verify a blocked plan', async () => {
    const steps = createVmUpdateSteps(shrinking(), {
      hostId: 'pve-01',
      restartRequired: false,
    });
    const update = findStep(steps, 'update configuration');
    const live = serialiseVmProxmoxConfig(vm());
    await expect(
      update.apply(
        context(new FakeTransport().onExec('qm config 112', { stdout: live })),
      ),
    ).rejects.toThrow('Refusing to shrink');
    await expect(
      update.verify(
        context(new FakeTransport().onExec('qm config 112', { stdout: live })),
      ),
    ).rejects.toThrow('Refusing to shrink');
  });

  it('reports failed update commands with and without stderr', async () => {
    const steps = createVmUpdateSteps(vm({ cpu: 4, disks: [], network: [] }), {
      hostId: 'pve-01',
      restartRequired: false,
    });
    const update = findStep(steps, 'update configuration');
    const live = serialiseVmProxmoxConfig(vm({ disks: [], network: [] }));
    for (const stderr of ['', 'bad cores']) {
      await expect(
        update.apply(
          context(
            new FakeTransport()
              .onExec('qm config 112', { stdout: live })
              .onExec(/^qm set 112 --cores /, { exitCode: 1, stderr }),
          ),
        ),
      ).rejects.toThrow(stderr === '' ? 'exit code 1' : 'bad cores');
    }
  });

  it('refuses to verify a blocked plan after a restart', async () => {
    const steps = createVmUpdateSteps(shrinking(), {
      hostId: 'pve-01',
      restartRequired: true,
      restart: async () => undefined,
    });
    const reboot = findStep(steps, 'restart VM');
    await expect(
      reboot.verify(
        context(
          new FakeTransport().onExec('qm config 112', {
            stdout: serialiseVmProxmoxConfig(vm()),
          }),
        ),
      ),
    ).rejects.toThrow('Refusing to shrink');
  });
});
