import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { managedGuestUuid } from '../guest/identity.js';
import { Secret } from '../tags/secret.js';
import { loadYamlDocument } from '../yaml/document.js';
import {
  guestDeploymentSchema,
  type GuestDeployment,
} from '../schema/deployment.js';
import { MemoryStepJournal } from '../steps/memory-journal.js';
import { runJournaledSteps } from '../steps/runner.js';
import { StepExecutionError } from '../steps/types.js';
import type { StepLogger } from '../steps/types.js';
import { FakeTransport } from '../transport/fake.js';
import {
  buildVmConfigureArgv,
  buildVmCreateArgv,
  buildVmImportArgv,
  cloudImageDownloadArgv,
  cloudImagePath,
  createVmProvisionSteps,
  describeVmCreation,
  formatVmIpConfig,
  formatVmNetwork,
} from './vm.js';

type Vm = Extract<GuestDeployment, { type: 'vm' }>;

const fixturePath = join(
  __dirname,
  '../../fixtures/deployments/vm-212-cloud-image.yaml',
);
const stamp = managedGuestUuid('pve-01', 212);
const imagePath = cloudImagePath(
  212,
  'https://cloud.example.invalid/debian-12.qcow2',
);

function fixtureVm(overrides: Partial<Vm> = {}): Vm {
  const parsed = guestDeploymentSchema.parse(
    loadYamlDocument(readFileSync(fixturePath, 'utf8')).toJSON(),
  );
  if (parsed.type !== 'vm') throw new Error('Expected VM fixture');
  return { ...parsed, ...overrides };
}

function vm(overrides: Partial<Vm> = {}): Vm {
  return {
    id: 212,
    name: 'example-vm',
    type: 'vm',
    cpu: 2,
    ram: 2048,
    disks: [],
    network: [],
    ...overrides,
  };
}

const baseConfig = 'name: example-vm';

const attachedConfig = [
  baseConfig,
  'cores: 4',
  'memory: 4096',
  'scsi0: local-lvm:vm-212-disk-0,size=32G',
].join('\n');

const configuredConfig = [
  attachedConfig,
  'tags: example;hacm-managed',
  `description: hacm-managed: ${stamp}`,
].join('\n');

function logger(): StepLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function transportWithConfigs(...configs: string[]): FakeTransport {
  const transport = new FakeTransport()
    .onExec(/^qm (create|clone|set|resize|start) /, { stdout: 'ok' })
    .onExec(/^qm importdisk 212 /, {
      stdout: "Successfully imported disk as 'unused0:local-lvm:vm-212-disk-0'",
    })
    .onExec(/^sha256sum /, {
      stdout: `${'a'.repeat(64)}  ${imagePath}`,
    })
    .onExec(/^test -f \/var\/tmp\//, { exitCode: 1 }, { once: true })
    .onExec(/^test -f \/var\/tmp\//, { exitCode: 0 })
    .onExec(/^test -f \/etc\/pve\/local\/qemu-server\/212\.conf/, {
      exitCode: 1,
    });
  for (const config of [...configs].reverse()) {
    transport.onExec('qm config 212', { stdout: config }, { once: true });
  }
  return transport;
}

async function run(
  transport: FakeTransport,
  steps: ReturnType<typeof createVmProvisionSteps>,
) {
  return runJournaledSteps({
    operationId: 'vm-create-test',
    input: undefined,
    transport,
    logger: logger(),
    dryRun: false,
    signal: new AbortController().signal,
    journal: new MemoryStepJournal(),
    steps,
  });
}

describe('VM command generation', () => {
  it('produces the expected qm commands for the cloud-image fixture', () => {
    const guest = fixtureVm();
    expect(buildVmCreateArgv(guest, { hostId: 'pve-01' })).toEqual([
      'qm',
      'create',
      '212',
      '--name',
      'example-vm',
      '--cores',
      '4',
      '--memory',
      '4096',
      '--scsihw',
      'virtio-scsi-pci',
    ]);
    expect(buildVmConfigureArgv(guest, { hostId: 'pve-01' })).toEqual([
      'qm',
      'set',
      '212',
      '--bios',
      'ovmf',
      '--machine',
      'q35',
      '--agent',
      'enabled=1',
      '--efidisk0',
      'local-lvm:1,efitype=4m,pre-enrolled-keys=1',
      '--tpmstate0',
      'local-lvm:1,version=v2.0',
      '--tags',
      'example;hacm-managed',
      '--description',
      `hacm-managed: ${stamp}`,
      '--net0',
      'virtio=A2:B1:C1:01:E0:AA,bridge=vmbr0',
      '--ipconfig0',
      'ip=192.0.2.212/24,gw=192.0.2.1',
      '--net1',
      'bridge=vmbr1',
      '--ciuser',
      'example',
      '--cipassword',
      'example-password',
      '--sshkeys',
      encodeURIComponent(
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleOnly example@example',
      ),
      '--ide2',
      'local-lvm:cloudinit',
      '--scsihw',
      'virtio-scsi-pci',
      '--boot',
      'c',
      '--bootdisk',
      'scsi0',
    ]);
    expect(buildVmImportArgv(guest, imagePath)).toEqual([
      'qm',
      'importdisk',
      '212',
      imagePath,
      'local-lvm',
    ]);
    expect(
      cloudImageDownloadArgv(
        212,
        guest.installation?.type === 'cloud_image'
          ? guest.installation.url
          : '',
      ),
    ).toEqual([
      'curl',
      '-fsSL',
      '--retry',
      '3',
      '--output',
      imagePath,
      'https://cloud.example.invalid/debian-12.qcow2',
    ]);
  });

  it('describes the VM creation and its cloud-init cloud-image commands', () => {
    const preview = describeVmCreation(fixtureVm(), { hostId: 'pve-01' });
    expect(preview.summary).toBe(
      'Create VM 212 (example-vm) from https://cloud.example.invalid/debian-12.qcow2',
    );
    expect(preview.commands.map((argv) => argv.slice(0, 2))).toEqual([
      ['curl', '-fsSL'],
      ['qm', 'create'],
      ['qm', 'importdisk'],
      ['qm', 'set'],
    ]);
    expect(preview.warnings).toEqual([]);
  });

  it('clones a template and keeps declared disks additive', () => {
    const guest = fixtureVm({
      installation: { type: 'clone', template_id: 9000 },
    });
    expect(buildVmCreateArgv(guest, { hostId: 'pve-01' })).toEqual([
      'qm',
      'clone',
      '9000',
      '212',
      '--name',
      'example-vm',
      '--full',
      '1',
      '--storage',
      'local-lvm',
    ]);
    expect(describeVmCreation(guest, { hostId: 'pve-01' }).warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Cloned disks')]),
    );
  });

  it('supports a plain VM without an installation', () => {
    const guest = vm({
      disks: [{ name: 'scsi0', storage: 'local-lvm', size_gb: 20 }],
    });
    expect(buildVmCreateArgv(guest, { hostId: 'pve-01' })).toEqual([
      'qm',
      'create',
      '212',
      '--name',
      'example-vm',
      '--cores',
      '2',
      '--memory',
      '2048',
      '--scsihw',
      'virtio-scsi-pci',
    ]);
    expect(buildVmConfigureArgv(guest, { hostId: 'pve-01' })).toEqual(
      expect.arrayContaining([
        '--scsi0',
        'local-lvm:20',
        '--boot',
        'c',
        '--bootdisk',
        'scsi0',
      ]),
    );
  });

  it('formats VM networks, ipconfig and sanitized image paths', () => {
    expect(
      formatVmNetwork({
        index: 0,
        bridge: 'vmbr0',
        firewall: true,
        vlan: 20,
        mtu: 9000,
        mac: 'A2:B1:C1:01:E0:AA',
      }),
    ).toBe('virtio=A2:B1:C1:01:E0:AA,bridge=vmbr0,firewall=1,tag=20,mtu=9000');
    expect(
      formatVmNetwork({ index: 1, bridge: 'vmbr1', extra: { model: 'e1000' } }),
    ).toBe('bridge=vmbr1');
    expect(
      formatVmIpConfig({
        index: 0,
        ip: 'dhcp',
        gateway: '192.0.2.1',
        ip6: 'auto',
        gateway6: '2001:db8::1',
      }),
    ).toBe('ip=dhcp,gw=192.0.2.1,ip6=auto,gw6=2001:db8::1');
    expect(formatVmIpConfig({ index: 1, bridge: 'vmbr1' })).toBeUndefined();
    expect(
      cloudImagePath(7, 'https://example.invalid/a/b/my image.qcow2?x=1'),
    ).toBe('/var/tmp/hacm-vm-7-my_image.qcow2');
  });

  it('warns when cloud-init is used without a guest agent', () => {
    const guest = fixtureVm({ guest_agent: undefined });
    expect(describeVmCreation(guest, { hostId: 'pve-01' }).warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('guest_agent is not enabled'),
      ]),
    );
  });

  it('rejects template installation for VMs', () => {
    expect(() =>
      buildVmCreateArgv(
        vm({
          installation: {
            type: 'template',
            template: 'local:vztmpl/not-a-vm.tar.zst',
          },
        }),
        { hostId: 'pve-01' },
      ),
    ).toThrow('clone or cloud_image');
  });
});

describe('createVmProvisionSteps', () => {
  it('downloads, creates, imports, configures and waits for the agent', async () => {
    const transport = transportWithConfigs(
      baseConfig,
      baseConfig,
      baseConfig,
      attachedConfig,
      attachedConfig,
      configuredConfig,
      configuredConfig,
    )
      .onExec('qm status 212', { stdout: 'status: running' })
      .onExec('qm status 212', { stdout: 'status: stopped' }, { once: true })
      .onExec('qm status 212', { stdout: 'status: stopped' }, { once: true })
      .onExec('qm agent 212 ping', { stdout: '' });
    const result = await run(
      transport,
      createVmProvisionSteps(fixtureVm(), {
        hostId: 'pve-01',
        agentAttempts: 1,
      }),
    );
    expect(result.entries.map((entry) => entry.status)).toEqual(
      Array.from({ length: 6 }, () => 'completed'),
    );
    expect(transport.execArgv).toEqual(
      expect.arrayContaining([
        [
          'qm',
          'create',
          '212',
          '--name',
          'example-vm',
          '--cores',
          '4',
          '--memory',
          '4096',
          '--scsihw',
          'virtio-scsi-pci',
        ],
        ['qm', 'importdisk', '212', imagePath, 'local-lvm'],
        ['qm', 'set', '212', '--scsi0', 'local-lvm:vm-212-disk-0'],
        ['qm', 'start', '212'],
        ['qm', 'agent', '212', 'ping'],
      ]),
    );
  });

  it('reports a missing guest agent clearly', async () => {
    const guest = fixtureVm({
      disks: [],
      cloud_init: undefined,
      installation: { type: 'clone', template_id: 9000 },
    });
    const transport = transportWithConfigs(
      baseConfig,
      baseConfig,
      [
        baseConfig,
        'tags: example;hacm-managed',
        `description: hacm-managed: ${stamp}`,
      ].join('\n'),
    )
      .onExec('qm status 212', { stdout: 'status: stopped' })
      .onExec('qm agent 212 ping', {
        exitCode: 1,
        stderr: 'No QEMU guest agent configured',
      });
    await expect(
      run(
        transport,
        createVmProvisionSteps(guest, {
          hostId: 'pve-01',
          agentAttempts: 2,
          agentDelaySeconds: 0,
        }),
      ),
    ).rejects.toThrow('did not answer the QEMU guest agent');
  });

  it('refuses to shrink a cloned disk', async () => {
    const guest = vm({
      disks: [{ name: 'scsi0', storage: 'local-lvm', size_gb: 8 }],
      installation: { type: 'clone', template_id: 9000 },
    });
    const transport = transportWithConfigs(
      baseConfig,
      baseConfig,
      [
        baseConfig,
        'tags: hacm-managed',
        `description: hacm-managed: ${stamp}`,
      ].join('\n'),
      attachedConfig,
    );
    await expect(
      run(transport, createVmProvisionSteps(guest, { hostId: 'pve-01' })),
    ).rejects.toThrow('Refusing to shrink VM 212 disk');
  });

  it('fails the create step when the VMID is occupied by another name', async () => {
    const guest = vm({ installation: { type: 'clone', template_id: 9000 } });
    const transport = new FakeTransport()
      .onExec('test -f /etc/pve/local/qemu-server/212.conf', { exitCode: 0 })
      .onExec('qm config 212', { stdout: 'name: other-vm' });
    await expect(
      run(transport, createVmProvisionSteps(guest, { hostId: 'pve-01' })),
    ).rejects.toBeInstanceOf(StepExecutionError);
  });

  it('fails when the cloud image download or import fails', async () => {
    const download = transportWithConfigs()
      .onExec(/^test -f \/var\/tmp\//, { exitCode: 1 })
      .onExec(/^curl /, { exitCode: 1, stderr: 'curl: not found' });
    await expect(
      run(
        download,
        createVmProvisionSteps(fixtureVm(), {
          hostId: 'pve-01',
          agentAttempts: 1,
        }),
      ),
    ).rejects.toThrow('Failed to download cloud image');

    const imported = transportWithConfigs(baseConfig, baseConfig, baseConfig)
      .onExec(/^test -f \/var\/tmp\//, { exitCode: 0 })
      .onExec(/^sha256sum /, { stdout: `${'a'.repeat(64)}  ${imagePath}` })
      .onExec(/^qm importdisk 212 /, {
        exitCode: 1,
        stderr: 'unsupported image',
      });
    await expect(
      run(
        imported,
        createVmProvisionSteps(fixtureVm(), {
          hostId: 'pve-01',
          agentAttempts: 1,
        }),
      ),
    ).rejects.toThrow('Failed to import cloud image');
  });

  it('rejects a cloud image without a disk', () => {
    expect(() =>
      createVmProvisionSteps(fixtureVm({ disks: [] }), {
        hostId: 'pve-01',
      }),
    ).toThrow('requires at least one disk');
  });

  it('skips the agent wait when the guest agent is disabled', async () => {
    const guest = vm({
      guest_agent: false,
      installation: { type: 'clone', template_id: 9000 },
    });
    const transport = transportWithConfigs(
      baseConfig,
      baseConfig,
      [
        baseConfig,
        'tags: hacm-managed',
        `description: hacm-managed: ${stamp}`,
      ].join('\n'),
    );
    const result = await run(
      transport,
      createVmProvisionSteps(guest, { hostId: 'pve-01' }),
    );
    expect(result.entries).toHaveLength(2);
    expect(transport.execArgv).not.toContainEqual(['qm', 'start', '212']);
  });
});

describe('VM command generation edge cases', () => {
  it('handles secret and tagged network values', () => {
    expect(
      formatVmNetwork({
        index: 0,
        bridge: 'vmbr0',
        mac: new Secret('A2:B1:C1:01:E0:AA') as unknown as string,
      }),
    ).toBe('virtio=A2:B1:C1:01:E0:AA,bridge=vmbr0');
    expect(() =>
      formatVmNetwork({
        index: 0,
        mac: { tag: 'env', value: 'MAC' } as never,
      }),
    ).toThrow('unresolved tag');
    expect(() =>
      formatVmNetwork({ index: 0, mac: { nested: true } as never }),
    ).toThrow('must be a scalar');
    expect(() =>
      formatVmNetwork({
        index: 0,
        firewall: new Secret('1') as never,
      }),
    ).toThrow('resolved to a secret');
    expect(() =>
      formatVmNetwork({
        index: 0,
        firewall: { tag: 'env', value: 'FIREWALL' } as never,
      }),
    ).toThrow('unresolved tag');
    expect(() =>
      formatVmNetwork({ index: 0, firewall: 'yes' as never }),
    ).toThrow('must be a boolean');
  });

  it('includes network extra options after the known keys', () => {
    expect(
      formatVmNetwork({
        index: 0,
        bridge: 'vmbr0',
        extra: { model: 'e1000', rate: 10, queues: 2 },
      }),
    ).toBe('bridge=vmbr0,queues=2,rate=10');
  });

  it('sanitizes cloud image names and falls back for empty URLs', () => {
    expect(
      cloudImagePath(3, 'https://example.invalid/a/b/image.qcow2?x=1'),
    ).toBe('/var/tmp/hacm-vm-3-image.qcow2');
    expect(cloudImagePath(3, 'https://example.invalid/')).toBe(
      '/var/tmp/hacm-vm-3-cloud-image.img',
    );
  });

  it('rejects a cloud image without a disk', () => {
    expect(() => buildVmImportArgv(vm(), 'image.qcow2')).toThrow(
      'requires at least one disk',
    );
  });

  it('rejects a plain create without a host ID', () => {
    expect(() => buildVmCreateArgv(vm(), { hostId: '  ' })).toThrow(
      'hostId is required',
    );
  });

  it('clones without a storage when no disk is declared and supports full=false', () => {
    const argv = buildVmCreateArgv(
      vm({
        installation: { type: 'clone', template_id: 9000, full: false },
      }),
      { hostId: 'pve-01' },
    );
    expect(argv).toEqual([
      'qm',
      'clone',
      '9000',
      '212',
      '--name',
      'example-vm',
      '--full',
      '0',
    ]);
  });

  it('formats disk extras and rejects invalid sizes', () => {
    const withExtras = vm({
      disks: [
        {
          name: 'scsi0',
          storage: 'local-lvm',
          size_gb: 20,
          extra: {
            volume: 'vm-212-disk-0',
            size: '20G',
            cache: 'writeback',
            discard: 'on',
          },
        },
      ],
    });
    const argv = buildVmConfigureArgv(withExtras, { hostId: 'pve-01' });
    const disk = argv[argv.indexOf('--scsi0') + 1];
    expect(disk).toContain('local-lvm:20');
    expect(disk).toContain('cache=writeback');
    expect(disk).toContain('discard=on');
    expect(disk).not.toContain('vm-212-disk-0');

    expect(() =>
      buildVmConfigureArgv(
        vm({
          disks: [
            {
              name: 'scsi0',
              storage: 'local-lvm',
              size_gb: 'many' as never,
            },
          ],
        }),
        { hostId: 'pve-01' },
      ),
    ).toThrow('finite number');

    const defaulted = buildVmConfigureArgv(
      vm({
        disks: [{ name: 'scsi0', storage: 'local-lvm', size_gb: '' as never }],
      }),
      { hostId: 'pve-01' },
    );
    expect(defaulted[defaulted.indexOf('--scsi0') + 1]).toBe('local-lvm:1');
  });

  it('skips managed extra keys and keeps passthrough options', () => {
    const guest = vm({
      disks: [],
      protection: false,
      extra: {
        name: 'ignored',
        _internal: 'ignored',
        net0: 'ignored',
        ipconfig0: 'ignored',
        unused0: 'ignored',
        scsi1: 'ignored',
        ide3: 'ignored',
        balloon: 0,
        args: '-cpu host',
      },
    });
    const argv = buildVmConfigureArgv(guest, { hostId: 'pve-01' });
    expect(argv).toEqual(
      expect.arrayContaining([
        '--protection',
        '0',
        '--balloon',
        '0',
        '--args',
        '-cpu host',
      ]),
    );
    expect(argv).not.toContain('--name');
    expect(argv).not.toContain('--scsi1');
    expect(argv).not.toContain('--ide3');
  });

  it('enables ovmf for an EFI disk and protects guests', () => {
    const argv = buildVmConfigureArgv(
      vm({ efi_disk: true, protection: true }),
      { hostId: 'pve-01' },
    );
    expect(argv).toEqual(
      expect.arrayContaining([
        '--bios',
        'ovmf',
        '--efidisk0',
        'local-lvm:1,efitype=4m,pre-enrolled-keys=1',
        '--protection',
        '1',
      ]),
    );
    const seabios = buildVmConfigureArgv(
      vm({ efi_disk: true, bios: 'seabios' }),
      { hostId: 'pve-01' },
    );
    expect(seabios[seabios.indexOf('--bios') + 1]).toBe('seabios');
  });

  it('adds the cloud-init drive for ipconfig-only networks', () => {
    const argv = buildVmConfigureArgv(
      vm({
        disks: [],
        network: [{ index: 0, ip: 'dhcp' }],
      }),
      { hostId: 'pve-01' },
    );
    expect(argv).toEqual(
      expect.arrayContaining([
        '--ipconfig0',
        'ip=dhcp',
        '--ide2',
        'local-lvm:cloudinit',
      ]),
    );
  });

  it('omits ssh keys when none are declared', () => {
    const argv = buildVmConfigureArgv(
      vm({ disks: [], cloud_init: { user: 'example' } }),
      { hostId: 'pve-01' },
    );
    expect(argv).toEqual(expect.arrayContaining(['--ciuser', 'example']));
    expect(argv).not.toContain('--sshkeys');
  });

  it('describes plain VMs and warns about unsafe hardware combinations', () => {
    const plain = describeVmCreation(vm(), { hostId: 'pve-01' });
    expect(plain.origin).toBe('empty VM');
    expect(plain.summary).toBe('Create VM 212 (example-vm) from empty VM');
    expect(plain.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('No VM disks')]),
    );

    const cloud = describeVmCreation(
      vm({
        installation: {
          type: 'cloud_image',
          url: 'https://example.invalid/image.qcow2',
        },
      }),
      { hostId: 'pve-01' },
    );
    expect(cloud.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Cloud-image creation needs a disk'),
      ]),
    );

    const hardware = describeVmCreation(vm({ efi_disk: true, tpm: true }), {
      hostId: 'pve-01',
    });
    expect(hardware.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('BIOS is set to ovmf'),
        expect.stringContaining('tpm is enabled'),
      ]),
    );
  });

  it('rejects community scripts for VM creation', () => {
    expect(() =>
      buildVmCreateArgv(
        vm({
          installation: {
            type: 'community_script',
            url: 'https://example.invalid/script.sh',
          },
        }),
        { hostId: 'pve-01' },
      ),
    ).toThrow('clone or cloud_image');
  });
});

function findStep(
  steps: ReturnType<typeof createVmProvisionSteps>,
  fragment: string,
) {
  const step = steps.find((candidate) => candidate.name.includes(fragment));
  if (!step) throw new Error(`Missing step containing '${fragment}'`);
  return step;
}

function stepContext(transport: FakeTransport) {
  return {
    operationId: 'vm-step-test',
    input: undefined,
    transport,
    logger: logger(),
    dryRun: false,
    signal: new AbortController().signal,
  };
}

describe('VM provisioning step edge cases', () => {
  it('handles cloud image check, download, missing file and checksum paths', async () => {
    const guest = fixtureVm({
      installation: {
        type: 'cloud_image',
        url: 'https://example.invalid/image.qcow2',
      },
    });
    const localImage = cloudImagePath(
      212,
      'https://example.invalid/image.qcow2',
    );
    const image = findStep(
      createVmProvisionSteps(guest, { hostId: 'pve-01' }),
      'ensure cloud image',
    );
    expect(
      await image.check(
        stepContext(new FakeTransport().onExec(/^test -f /, { exitCode: 0 })),
      ),
    ).toEqual({ status: 'satisfied', detail: { image: localImage } });
    expect(
      await image.check(
        stepContext(new FakeTransport().onExec(/^test -f /, { exitCode: 1 })),
      ),
    ).toEqual({ status: 'required', detail: { image: localImage } });

    expect(
      await image.apply(
        stepContext(
          new FakeTransport().onExec(/^curl /, { stdout: 'downloaded' }),
        ),
      ),
    ).toEqual({ image: localImage });

    await expect(
      image.verify(
        stepContext(new FakeTransport().onExec(/^test -f /, { exitCode: 1 })),
      ),
    ).rejects.toThrow('was not downloaded');

    const checksumGuest = fixtureVm();
    const checked = findStep(
      createVmProvisionSteps(checksumGuest, { hostId: 'pve-01' }),
      'ensure cloud image',
    );
    await expect(
      checked.verify(
        stepContext(
          new FakeTransport()
            .onExec(/^test -f /, { exitCode: 0 })
            .onExec(/^sha256sum /, { stdout: `${'b'.repeat(64)}  x` }),
        ),
      ),
    ).rejects.toThrow('failed its sha256 checksum');
    await expect(
      checked.verify(
        stepContext(
          new FakeTransport()
            .onExec(/^test -f /, { exitCode: 0 })
            .onExec(/^sha256sum /, { exitCode: 1 }),
        ),
      ),
    ).rejects.toThrow('failed its sha256 checksum');
    await expect(
      checked.verify(
        stepContext(
          new FakeTransport()
            .onExec(/^test -f /, { exitCode: 0 })
            .onExec(/^sha256sum /, { stdout: `${'a'.repeat(64)}  x` }),
        ),
      ),
    ).resolves.toEqual({ image: imagePath });

    const failing = findStep(
      createVmProvisionSteps(guest, { hostId: 'pve-01' }),
      'ensure cloud image',
    );
    await expect(
      failing.apply(
        stepContext(new FakeTransport().onExec(/^curl /, { exitCode: 1 })),
      ),
    ).rejects.toThrow('exit code 1');
    await expect(
      failing.apply(
        stepContext(
          new FakeTransport().onExec(/^curl /, {
            exitCode: 1,
            stderr: 'network down',
          }),
        ),
      ),
    ).rejects.toThrow('network down');
  });

  it('handles create check, failure and verify mismatch paths', async () => {
    const guest = vm({ installation: { type: 'clone', template_id: 9000 } });
    const create = findStep(
      createVmProvisionSteps(guest, { hostId: 'pve-01' }),
      'create VM',
    );
    expect(
      await create.check(
        stepContext(
          new FakeTransport()
            .onExec(/^test -f /, { exitCode: 0 })
            .onExec('qm config 212', { stdout: 'name: example-vm' }),
        ),
      ),
    ).toEqual({
      status: 'satisfied',
      detail: { vmid: 212, name: 'example-vm' },
    });
    await expect(
      create.check(
        stepContext(
          new FakeTransport()
            .onExec(/^test -f /, { exitCode: 0 })
            .onExec('qm config 212', { stdout: 'name: other-vm' }),
        ),
      ),
    ).rejects.toThrow('already occupied');
    expect(
      await create.check(
        stepContext(new FakeTransport().onExec(/^test -f /, { exitCode: 1 })),
      ),
    ).toEqual({ status: 'required' });

    await expect(
      create.apply(
        stepContext(new FakeTransport().onExec(/^qm clone /, { exitCode: 1 })),
      ),
    ).rejects.toThrow('exit code 1');
    await expect(
      create.apply(
        stepContext(
          new FakeTransport().onExec(/^qm clone /, {
            exitCode: 1,
            stderr: 'template missing',
          }),
        ),
      ),
    ).rejects.toThrow('template missing');
    await expect(
      create.verify(
        stepContext(
          new FakeTransport().onExec('qm config 212', {
            stdout: 'name: other-vm',
          }),
        ),
      ),
    ).rejects.toThrow('missing its name');
  });

  it('handles import check, attach and failure paths', async () => {
    const guest = fixtureVm();
    const attach = 'scsi0: local-lvm:vm-212-disk-0,size=32G';
    const importStep = findStep(
      createVmProvisionSteps(guest, { hostId: 'pve-01' }),
      'import cloud image',
    );
    expect(
      await importStep.check(
        stepContext(
          new FakeTransport().onExec('qm config 212', { stdout: attach }),
        ),
      ),
    ).toEqual({ status: 'satisfied', detail: { disk: 'scsi0' } });
    expect(
      await importStep.check(
        stepContext(
          new FakeTransport().onExec('qm config 212', {
            stdout: 'unused0: local-lvm:vm-212-disk-1',
          }),
        ),
      ),
    ).toEqual({
      status: 'required',
      detail: { unused: 'local-lvm:vm-212-disk-1' },
    });
    expect(
      await importStep.check(
        stepContext(
          new FakeTransport().onExec('qm config 212', { stdout: 'name: x' }),
        ),
      ),
    ).toEqual({ status: 'required', detail: {} });

    expect(
      await importStep.apply(
        stepContext(
          new FakeTransport().onExec('qm config 212', { stdout: attach }),
        ),
      ),
    ).toEqual({ disk: 'scsi0', alreadyAttached: true });

    const unused = new FakeTransport()
      .onExec('qm config 212', { stdout: 'unused0: local-lvm:vm-212-disk-1' })
      .onExec(/^qm set 212 /, { stdout: 'ok' });
    expect(await importStep.apply(stepContext(unused))).toEqual({
      disk: 'scsi0',
      volume: 'local-lvm:vm-212-disk-1',
    });

    const imported = new FakeTransport()
      .onExec('qm config 212', { stdout: 'name: x' })
      .onExec(/^qm importdisk /, {
        stdout:
          "Successfully imported disk as 'unused0:local-lvm:vm-212-disk-2'",
      })
      .onExec(/^qm set 212 /, { stdout: 'ok' });
    expect(await importStep.apply(stepContext(imported))).toEqual({
      disk: 'scsi0',
      volume: 'local-lvm:vm-212-disk-2',
    });

    const fallback = new FakeTransport()
      .onExec('qm config 212', { stdout: 'name: x' })
      .onExec(/^qm importdisk /, { stdout: 'no volume here' })
      .onExec(/^qm set 212 /, { stdout: 'ok' });
    expect(await importStep.apply(stepContext(fallback))).toEqual({
      disk: 'scsi0',
      volume: 'local-lvm:vm-212-disk-0',
    });

    for (const stderr of ['', 'image corrupt']) {
      await expect(
        importStep.apply(
          stepContext(
            new FakeTransport()
              .onExec('qm config 212', { stdout: 'name: x' })
              .onExec(/^qm importdisk /, { exitCode: 1, stderr }),
          ),
        ),
      ).rejects.toThrow(stderr === '' ? 'exit code 1' : 'image corrupt');
    }
    for (const stderr of ['', 'attach failed']) {
      await expect(
        importStep.apply(
          stepContext(
            new FakeTransport()
              .onExec('qm config 212', {
                stdout: 'unused0: local-lvm:vm-212-disk-1',
              })
              .onExec(/^qm set 212 /, { exitCode: 1, stderr }),
          ),
        ),
      ).rejects.toThrow(stderr === '' ? 'exit code 1' : 'attach failed');
    }
    await expect(
      importStep.verify(
        stepContext(
          new FakeTransport().onExec('qm config 212', { stdout: 'name: x' }),
        ),
      ),
    ).rejects.toThrow('does not have its imported disk');
  });

  it('handles configure satisfied, failure and missing stamp paths', async () => {
    const guest = fixtureVm();
    const configure = findStep(
      createVmProvisionSteps(guest, { hostId: 'pve-01' }),
      'configure VM',
    );
    const good = [
      'name: example-vm',
      'tags: example;hacm-managed',
      `description: hacm-managed: ${stamp}`,
    ].join('\n');
    expect(
      await configure.check(
        stepContext(
          new FakeTransport().onExec('qm config 212', { stdout: good }),
        ),
      ),
    ).toEqual({
      status: 'satisfied',
      detail: { vmid: 212, stamp },
    });
    expect(
      await configure.check(
        stepContext(
          new FakeTransport().onExec('qm config 212', {
            stdout: 'name: example-vm',
          }),
        ),
      ),
    ).toEqual({ status: 'required', detail: { vmid: 212 } });

    for (const stderr of ['', 'bad option']) {
      await expect(
        configure.apply(
          stepContext(
            new FakeTransport().onExec(/^qm set 212 /, { exitCode: 1, stderr }),
          ),
        ),
      ).rejects.toThrow(stderr === '' ? 'exit code 1' : 'bad option');
    }
    await expect(
      configure.verify(
        stepContext(
          new FakeTransport().onExec('qm config 212', {
            stdout: 'name: example-vm',
          }),
        ),
      ),
    ).rejects.toThrow('missing its name, managed tag or management stamp');
  });

  it('grows disks and refuses shrink, missing or failed resizes', async () => {
    const guest = vm({
      disks: [
        { name: 'scsi0', storage: 'local-lvm', size_gb: 40 },
        { name: 'scsi1', storage: 'local-lvm', size_gb: 40 },
      ],
    });
    const grow = findStep(
      createVmProvisionSteps(guest, { hostId: 'pve-01' }),
      'grow VM',
    );
    const small = [
      'scsi0: local-lvm:vm-212-disk-0,size=32G',
      'scsi1: local-lvm:vm-212-disk-1,size=32G',
    ].join('\n');
    expect(
      await grow.check(
        stepContext(
          new FakeTransport().onExec('qm config 212', { stdout: small }),
        ),
      ),
    ).toEqual({
      status: 'required',
      detail: {
        commands: [
          ['qm', 'resize', '212', 'scsi0', '40G'],
          ['qm', 'resize', '212', 'scsi1', '40G'],
        ],
      },
    });
    expect(
      await grow.check(
        stepContext(
          new FakeTransport().onExec('qm config 212', {
            stdout: [
              'scsi0: local-lvm:vm-212-disk-0,size=40G',
              'scsi1: local-lvm:vm-212-disk-1,size=40G',
            ].join('\n'),
          }),
        ),
      ),
    ).toEqual({ status: 'satisfied', detail: { disks: 2 } });
    await expect(
      grow.check(
        stepContext(
          new FakeTransport().onExec('qm config 212', { stdout: 'name: x' }),
        ),
      ),
    ).rejects.toThrow('is not attached');

    const sizes = [
      'scsi0: local-lvm:vm-212-disk-0,size=32G',
      'scsi1: local-lvm:vm-212-disk-1,size=32G',
    ].join('\n');
    expect(
      await grow.apply(
        stepContext(
          new FakeTransport()
            .onExec('qm config 212', { stdout: sizes })
            .onExec(/^qm resize /, { stdout: 'ok' }),
        ),
      ),
    ).toEqual({
      vmid: 212,
      commands: [
        ['qm', 'resize', '212', 'scsi0', '40G'],
        ['qm', 'resize', '212', 'scsi1', '40G'],
      ],
    });
    for (const stderr of ['', 'storage full']) {
      await expect(
        grow.apply(
          stepContext(
            new FakeTransport()
              .onExec('qm config 212', { stdout: sizes })
              .onExec(/^qm resize /, { exitCode: 1, stderr }),
          ),
        ),
      ).rejects.toThrow(stderr === '' ? 'exit code 1' : 'storage full');
    }
    await expect(
      grow.apply(
        stepContext(
          new FakeTransport().onExec('qm config 212', { stdout: 'name: x' }),
        ),
      ),
    ).rejects.toThrow('is not attached');

    const shrinking = vm({
      disks: [{ name: 'scsi0', storage: 'local-lvm', size_gb: 8 }],
    });
    const shrinkStep = findStep(
      createVmProvisionSteps(shrinking, { hostId: 'pve-01' }),
      'grow VM',
    );
    const attached = 'scsi0: local-lvm:vm-212-disk-0,size=32G';
    await expect(
      shrinkStep.apply(
        stepContext(
          new FakeTransport().onExec('qm config 212', { stdout: attached }),
        ),
      ),
    ).rejects.toThrow('Refusing to shrink');

    await expect(
      grow.verify(
        stepContext(
          new FakeTransport().onExec('qm config 212', {
            stdout: [
              'scsi0: local-lvm:vm-212-disk-0,size=40G',
              'scsi1: local-lvm:vm-212-disk-1,size=40G',
            ].join('\n'),
          }),
        ),
      ),
    ).resolves.toEqual({
      vmid: 212,
      sizes: { scsi0: 40, scsi1: 40 },
    });
    await expect(
      grow.verify(
        stepContext(
          new FakeTransport().onExec('qm config 212', { stdout: small }),
        ),
      ),
    ).rejects.toThrow('still 32 GB');
    await expect(
      grow.verify(
        stepContext(
          new FakeTransport().onExec('qm config 212', { stdout: 'name: x' }),
        ),
      ),
    ).rejects.toThrow('is not attached after resize');
  });

  it('starts the VM and reports agent or start failures', async () => {
    const guest = fixtureVm();
    const start = findStep(
      createVmProvisionSteps(guest, { hostId: 'pve-01' }),
      'start VM',
    );
    expect(
      await start.check(
        stepContext(
          new FakeTransport().onExec('qm status 212', {
            stdout: 'status: stopped',
          }),
        ),
      ),
    ).toEqual({ status: 'required', detail: { status: 'stopped' } });
    expect(
      await start.check(
        stepContext(
          new FakeTransport()
            .onExec('qm status 212', { stdout: 'status: running' })
            .onExec('qm agent 212 ping', { stdout: '' }),
        ),
      ),
    ).toEqual({ status: 'satisfied', detail: { status: 'running' } });
    expect(
      await start.check(
        stepContext(
          new FakeTransport()
            .onExec('qm status 212', { stdout: 'status: running' })
            .onExec('qm agent 212 ping', { exitCode: 1 }),
        ),
      ),
    ).toEqual({
      status: 'required',
      detail: { status: 'running', agent: false },
    });

    expect(
      await start.apply(
        stepContext(
          new FakeTransport()
            .onExec('qm status 212', { stdout: 'status: running' })
            .onExec('qm agent 212 ping', { stdout: '' }),
        ),
      ),
    ).toEqual({ vmid: 212, agent: true });

    expect(
      await start.apply(
        stepContext(
          new FakeTransport()
            .onExec('qm status 212', { stdout: 'status: stopped' })
            .onExec(/^qm start /, { stdout: 'ok' })
            .onExec('qm agent 212 ping', { stdout: '' }),
        ),
      ),
    ).toEqual({ vmid: 212, agent: true });

    await expect(
      start.apply(
        stepContext(
          new FakeTransport()
            .onExec('qm status 212', { stdout: 'status: stopped' })
            .onExec(/^qm start /, { exitCode: 1 }),
        ),
      ),
    ).rejects.toThrow('exit code 1');
    await expect(
      start.apply(
        stepContext(
          new FakeTransport()
            .onExec('qm status 212', { stdout: 'status: stopped' })
            .onExec(/^qm start /, { exitCode: 1, stderr: 'lock held' }),
        ),
      ),
    ).rejects.toThrow('lock held');

    const retrying = findStep(
      createVmProvisionSteps(guest, {
        hostId: 'pve-01',
        agentAttempts: 2,
        agentDelaySeconds: 1,
      }),
      'start VM',
    );
    expect(
      await retrying.apply(
        stepContext(
          new FakeTransport()
            .onExec('qm status 212', { stdout: 'status: running' })
            .onExec('qm agent 212 ping', { stdout: '' })
            .onExec('qm agent 212 ping', { exitCode: 1 }, { once: true })
            .onExec(/^sleep /, { stdout: '' }),
        ),
      ),
    ).toEqual({ vmid: 212, agent: true });

    await expect(
      start.verify(
        stepContext(
          new FakeTransport().onExec('qm status 212', {
            stdout: 'status: stopped',
          }),
        ),
      ),
    ).rejects.toThrow('is not running after create');
    const singleAttempt = findStep(
      createVmProvisionSteps(guest, {
        hostId: 'pve-01',
        agentAttempts: 1,
      }),
      'start VM',
    );
    await expect(
      singleAttempt.verify(
        stepContext(
          new FakeTransport()
            .onExec('qm status 212', { stdout: 'status: running' })
            .onExec('qm agent 212 ping', { exitCode: 1 }),
        ),
      ),
    ).rejects.toThrow('exit code 1');
    await expect(
      start.verify(
        stepContext(
          new FakeTransport()
            .onExec('qm status 212', { stdout: 'status: running' })
            .onExec('qm agent 212 ping', { stdout: '' }),
        ),
      ),
    ).resolves.toEqual({ vmid: 212, agent: true });
  });
});
