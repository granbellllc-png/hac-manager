import { describe, expect, it } from 'vitest';
import { FakeTransport } from '../transport/fake.js';
import { MemoryStepJournal } from '../steps/memory-journal.js';
import { runJournaledSteps } from '../steps/runner.js';
import type { StepLogger, StepExecutionContext } from '../steps/types.js';
import type { GuestDeployment } from '../schema/deployment.js';
import { managedGuestUuid } from '../guest/identity.js';
import { Secret } from '../tags/secret.js';
import {
  buildLxcCreateArgv,
  createLxcProvisionSteps,
  describeLxcCreation,
  hasUnresolvedTags,
  lxcConfigPath,
  lxcTemplateAvailable,
  lxcTemplateDownloadArgv,
  lxcTemplateListArgv,
  parseLxcTemplateRef,
} from './lxc.js';

type Lxc = Extract<GuestDeployment, { type: 'lxc' }>;

function lxc(): Lxc {
  return {
    schema_version: 1,
    id: 112,
    name: 'example-lxc',
    type: 'lxc',
    cpu: 2,
    ram: 1024,
    swap: 512,
    unprivileged: true,
    ostype: 'debian',
    onboot: true,
    startup: 'order=2,up=30',
    tags: ['app'],
    features: { nesting: true, keyctl: true, mount: ['fuse', 'nfs'] },
    disks: [
      {
        name: 'rootfs',
        storage: 'local-lvm',
        size_gb: 10,
        extra: { volume: 'vm-112-disk-0' },
      },
    ],
    mounts: [
      {
        index: 0,
        host_path: '/srv/hacm/pve-01/example-lxc/opt',
        guest_path: '/opt',
        backup: true,
        permissions: 'minimal',
      },
    ],
    network: [
      {
        index: 0,
        name: 'eth0',
        bridge: 'vmbr0',
        ip: '192.0.2.112/24',
        gateway: '192.0.2.1',
        mac: 'A2:B1:C1:00:70:AA',
        vlan: 20,
        mtu: 1400,
        firewall: true,
        ipv6: 'auto',
      },
      {
        index: 1,
        bridge: 'vmbr1',
        ipv6: 'static',
        ip6: '2001:db8::5/64',
      },
    ],
    installation: {
      type: 'template',
      template: 'local:vztmpl/debian-12-standard.tar.zst',
    },
  };
}

function logger(): StepLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function context(transport: FakeTransport): StepExecutionContext<undefined> {
  return {
    operationId: 'lxc-create-test',
    input: undefined,
    transport,
    logger: logger(),
    dryRun: false,
    signal: new AbortController().signal,
  };
}

describe('LXC template references', () => {
  it('parses storage volumes and checks pveam listings', () => {
    const ref = parseLxcTemplateRef('local:vztmpl/debian-12.tar.zst');
    expect(ref).toEqual({
      storage: 'local',
      volume: 'debian-12.tar.zst',
      volid: 'local:vztmpl/debian-12.tar.zst',
    });
    expect(() => parseLxcTemplateRef('debian-12.tar.zst')).toThrow(
      'Invalid LXC template',
    );
    expect(lxcTemplateListArgv(ref)).toEqual(['pveam', 'list', 'local']);
    expect(lxcTemplateDownloadArgv(ref)).toEqual([
      'pveam',
      'download',
      'local',
      'debian-12.tar.zst',
    ]);
    expect(
      lxcTemplateAvailable('local:vztmpl/debian-12.tar.zst 120 MB', ref),
    ).toBe(true);
    expect(lxcTemplateAvailable('debian-12.tar.zst 120 MB', ref)).toBe(true);
    expect(lxcTemplateAvailable('local:vztmpl/other.tar.zst', ref)).toBe(false);
  });
});

describe('LXC creation command mapping', () => {
  it('maps CPU, memory, features, mounts, multi-NIC, VLAN, MTU and IPv6', () => {
    const argv = buildLxcCreateArgv(lxc(), { hostId: 'pve-01' });
    expect(argv).toEqual([
      'pct',
      'create',
      '112',
      'local:vztmpl/debian-12-standard.tar.zst',
      '--hostname',
      'example-lxc',
      '--cores',
      '2',
      '--memory',
      '1024',
      '--swap',
      '512',
      '--unprivileged',
      '1',
      '--ostype',
      'debian',
      '--onboot',
      '1',
      '--startup',
      'order=2,up=30',
      '--tags',
      'app;hacm-managed',
      '--description',
      expect.stringMatching(/^hacm-managed: [0-9a-f-]{36}$/),
      '--features',
      'keyctl=1,mount=fuse;nfs,nesting=1',
      '--rootfs',
      'local-lvm:vm-112-disk-0,size=10G',
      '--mp0',
      '/srv/hacm/pve-01/example-lxc/opt,backup=1,mp=/opt',
      '--net0',
      'name=eth0,bridge=vmbr0,gw=192.0.2.1,hwaddr=A2:B1:C1:00:70:AA,ip=192.0.2.112/24,ip6=auto,firewall=1,mtu=1400,tag=20',
      '--net1',
      'bridge=vmbr1,ip6=2001:db8::5/64',
    ]);
  });

  it('describes warnings for missing rootfs, default privilege and static IPv6', () => {
    const guest = lxc();
    const preview = describeLxcCreation(
      {
        ...guest,
        disks: [],
        unprivileged: undefined,
        network: [{ index: 0, bridge: 'vmbr0', ipv6: 'static' }],
      },
      { hostId: 'pve-01' },
    );
    expect(preview.summary).toContain('Create LXC 112 (example-lxc)');
    expect(preview.warnings).toEqual([
      'No rootfs disk is declared; Proxmox storage defaults and size apply.',
      'unprivileged is not set; Proxmox applies its default privilege mode.',
      'mp0 will be attached at creation before the first boot (D-44).',
      "net0 uses IPv6 mode 'static' without an ip6 address.",
    ]);
  });

  it('rejects non-template installations and unresolved tags', () => {
    const guest = lxc();
    expect(() =>
      buildLxcCreateArgv(
        { ...guest, installation: { type: 'clone', template_id: 9000 } },
        { hostId: 'pve-01' },
      ),
    ).toThrow('installation.type: template');
    expect(
      hasUnresolvedTags({
        ...guest,
        cpu: { tag: 'expr', value: 'host.index + 1' },
      }),
    ).toBe(true);
    expect(() =>
      buildLxcCreateArgv(
        {
          ...guest,
          cpu: { tag: 'expr', value: 'host.index + 1' },
        },
        { hostId: 'pve-01' },
      ),
    ).toThrow('unresolved tag');
  });

  it('unwraps resolved secrets for argv without ever stringifying them', () => {
    const argv = buildLxcCreateArgv(
      {
        ...lxc(),
        cpu: new Secret('4') as unknown as number,
        installation: {
          type: 'template',
          template: new Secret(
            'local:vztmpl/debian-12-standard.tar.zst',
          ) as unknown as string,
        },
        network: [
          {
            index: 0,
            bridge: new Secret('vmbr0') as unknown as string,
            ip: new Secret('192.0.2.112/24') as unknown as string,
          },
        ],
      },
      { hostId: 'pve-01' },
    );
    expect(argv).toContain('4');
    expect(argv.join(' ')).toContain('bridge=vmbr0');
    expect(argv.join(' ')).toContain('ip=192.0.2.112/24');
    expect(argv.join(' ')).not.toContain('***');
    expect(() =>
      buildLxcCreateArgv(
        {
          ...lxc(),
          onboot: new Secret('true') as unknown as boolean,
        },
        { hostId: 'pve-01' },
      ),
    ).toThrow('a boolean was expected');
    expect(() =>
      buildLxcCreateArgv(
        {
          ...lxc(),
          installation: {
            type: 'template',
            template: { tag: 'secret', value: 'template' },
          },
        },
        { hostId: 'pve-01' },
      ),
    ).toThrow('unresolved tag');
  });
});

describe('minimal LXC creation and network option fallbacks', () => {
  it('omits absent optional fields and handles interface fallbacks', () => {
    const minimal: Lxc = {
      id: 120,
      name: 'minimal',
      type: 'lxc',
      cpu: 1,
      ram: 256,
      disks: [
        {
          name: 'rootfs',
          storage: undefined as unknown as string,
          size_gb: undefined as unknown as number,
          extra: { size: '11G', iothread: '1' },
        },
      ],
      mounts: [
        {
          index: 1,
          host_path: '/srv/data',
          guest_path: '/data',
          backup: false,
          readonly: true,
          permissions: 'minimal',
        },
      ],
      features: { nesting: false, keyctl: false, fuse: false, mount: [] },
      tags: ['hacm-managed'],
      network: [
        {
          index: 0,
          firewall: false,
          ipv6: 'dhcp',
          extra: { link_down: '0' },
        },
        { index: 1, ipv6: 'disabled' },
        { index: 2, ipv6: 'static' },
      ],
      installation: {
        type: 'template',
        template: 'local:vztmpl/minimal.tar.zst',
      },
    };
    const argv = buildLxcCreateArgv(minimal, { hostId: 'pve-01' });
    expect(argv).not.toContain('--swap');
    expect(argv).not.toContain('--unprivileged');
    expect(argv).not.toContain('--ostype');
    expect(argv).not.toContain('--onboot');
    expect(argv).not.toContain('--startup');
    expect(argv).not.toContain('--features');
    expect(argv.join(' ')).toContain('--tags hacm-managed');
    expect(argv.join(' ')).toContain(
      '--rootfs local-lvm:vm-120-disk-0,iothread=1,size=8G',
    );
    expect(argv.join(' ')).toContain('--mp1 /srv/data,mp=/data,ro=1');
    expect(argv.join(' ')).toContain('ip6=dhcp,firewall=0,link_down=0');
    expect(argv.join(' ')).toContain('ip6=manual');
    expect(
      describeLxcCreation(minimal, { hostId: 'pve-01' }).warnings,
    ).toContain("net2 uses IPv6 mode 'static' without an ip6 address.");
  });
});

describe('LXC provisioning steps', () => {
  it('downloads a missing template, creates the LXC and verifies its stamp', async () => {
    const guest = lxc();
    const stamp = managedGuestUuid('pve-01', guest.id);
    const transport = new FakeTransport()
      .onExec('pct config 112', {
        stdout: [
          'hostname: example-lxc',
          'tags: app;hacm-managed',
          `description: hacm-managed: ${stamp}`,
        ].join('\n'),
      })
      .onExec(
        'test -f /etc/pve/local/lxc/112.conf',
        { exitCode: 1 },
        { once: true },
      )
      .onExec(/^pct create /, { stdout: 'created' }, { once: true })
      .onExec(/^pveam download /, { stdout: 'downloaded' }, { once: true })
      .onExec(
        'pveam list local',
        { stdout: 'local:vztmpl/debian-12-standard.tar.zst 120 MB' },
        { once: true },
      )
      .onExec('pveam list local', { stdout: 'no templates' }, { once: true });

    const steps = createLxcProvisionSteps(guest, { hostId: 'pve-01' });
    await expect(
      runJournaledSteps({
        operationId: 'lxc-create-112',
        input: undefined,
        transport,
        logger: logger(),
        dryRun: false,
        signal: new AbortController().signal,
        journal: new MemoryStepJournal(),
        steps,
      }),
    ).resolves.toMatchObject({ operationId: 'lxc-create-112' });

    expect(transport.execArgv).toEqual([
      ['pveam', 'list', 'local'],
      ['pveam', 'download', 'local', 'debian-12-standard.tar.zst'],
      ['pveam', 'list', 'local'],
      ['test', '-f', lxcConfigPath(112)],
      buildLxcCreateArgv(guest, { hostId: 'pve-01' }),
      ['pct', 'config', '112'],
    ]);
    expect(
      transport.execArgv.filter(
        (argv) => argv[0] === 'pct' && argv[1] === 'create',
      ),
    ).toHaveLength(1);
  });

  it('does not mutate during a dry run and skips a present template', async () => {
    const guest = lxc();
    const transport = new FakeTransport()
      .onExec('pveam list local', {
        stdout: 'local:vztmpl/debian-12-standard.tar.zst 120 MB',
      })
      .onExec('test -f /etc/pve/local/lxc/112.conf', { exitCode: 1 });

    await runJournaledSteps({
      operationId: 'lxc-create-dry',
      input: undefined,
      transport,
      logger: logger(),
      dryRun: true,
      signal: new AbortController().signal,
      journal: new MemoryStepJournal(),
      steps: createLxcProvisionSteps(guest, { hostId: 'pve-01' }),
    });

    expect(transport.execArgv).toEqual([
      ['pveam', 'list', 'local'],
      ['test', '-f', lxcConfigPath(112)],
    ]);
  });

  it('refuses to overwrite a VMID with a different workload', async () => {
    const transport = new FakeTransport()
      .onExec('test -f /etc/pve/local/lxc/112.conf', { exitCode: 0 })
      .onExec('pct config 112', { stdout: 'hostname: other-workload' })
      .onExec('pveam list local', {
        stdout: 'local:vztmpl/debian-12-standard.tar.zst 120 MB',
      });

    await expect(
      runJournaledSteps({
        operationId: 'lxc-create-collision',
        input: undefined,
        transport,
        logger: logger(),
        dryRun: false,
        signal: new AbortController().signal,
        journal: new MemoryStepJournal(),
        steps: createLxcProvisionSteps(lxc(), { hostId: 'pve-01' }),
      }),
    ).rejects.toThrow('already occupied by a different workload');
    expect(
      transport.execArgv.some(
        (argv) => argv[0] === 'pct' && argv[1] === 'create',
      ),
    ).toBe(false);
  });

  it('surfaces template list and download failures with and without stderr', async () => {
    const steps = createLxcProvisionSteps(lxc(), { hostId: 'pve-01' });
    const ensureTemplate = steps[0]!;
    await expect(
      ensureTemplate.check(
        context(
          new FakeTransport().onExec('pveam list local', {
            exitCode: 2,
            stderr: 'storage offline',
          }),
        ),
      ),
    ).rejects.toThrow('storage offline');
    await expect(
      ensureTemplate.check(
        context(
          new FakeTransport().onExec('pveam list local', { exitCode: 2 }),
        ),
      ),
    ).rejects.toThrow('exit code 2');
    await expect(
      ensureTemplate.apply(
        context(
          new FakeTransport().onExec(/^pveam download /, {
            exitCode: 2,
            stderr: 'download failed',
          }),
        ),
      ),
    ).rejects.toThrow('download failed');
    await expect(
      ensureTemplate.apply(
        context(
          new FakeTransport().onExec(/^pveam download /, { exitCode: 2 }),
        ),
      ),
    ).rejects.toThrow('exit code 2');
    await expect(
      ensureTemplate.verify(
        context(
          new FakeTransport().onExec('pveam list local', { exitCode: 2 }),
        ),
      ),
    ).rejects.toThrow('is not available after download');
    await expect(
      ensureTemplate.verify(
        context(
          new FakeTransport().onExec('pveam list local', {
            stdout: 'no templates',
          }),
        ),
      ),
    ).rejects.toThrow('is not available after download');
  });

  it('surfaces create and verification failures with and without stderr', async () => {
    const guest = lxc();
    const steps = createLxcProvisionSteps(guest, { hostId: 'pve-01' });
    const create = steps[1]!;
    const stamp = managedGuestUuid('pve-01', guest.id);

    await expect(
      create.apply(
        context(
          new FakeTransport().onExec(/^pct create /, {
            exitCode: 1,
            stderr: 'create failed',
          }),
        ),
      ),
    ).rejects.toThrow('create failed');
    await expect(
      create.apply(
        context(new FakeTransport().onExec(/^pct create /, { exitCode: 1 })),
      ),
    ).rejects.toThrow('exit code 1');
    await expect(
      create.verify(
        context(
          new FakeTransport().onExec('pct config 112', {
            exitCode: 1,
            stderr: 'missing',
          }),
        ),
      ),
    ).rejects.toThrow('missing');
    await expect(
      create.verify(
        context(new FakeTransport().onExec('pct config 112', { exitCode: 1 })),
      ),
    ).rejects.toThrow('exit code 1');
    await expect(
      create.verify(
        context(
          new FakeTransport().onExec('pct config 112', {
            stdout: 'hostname: example-lxc',
          }),
        ),
      ),
    ).rejects.toThrow('missing its hostname or management stamp');
    await expect(
      create.check(
        context(
          new FakeTransport()
            .onExec('test -f /etc/pve/local/lxc/112.conf', { exitCode: 0 })
            .onExec('pct config 112', {
              stdout: [
                'hostname: example-lxc',
                `description: hacm-managed: ${stamp}`,
              ].join('\n'),
            }),
        ),
      ),
    ).resolves.toMatchObject({ status: 'satisfied' });
  });
});
