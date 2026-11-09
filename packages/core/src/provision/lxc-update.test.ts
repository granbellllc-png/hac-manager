import { describe, expect, it, vi } from 'vitest';
import { managedGuestUuid } from '../guest/identity.js';
import type { GuestDeployment } from '../schema/deployment.js';
import { MemoryStepJournal } from '../steps/memory-journal.js';
import { runJournaledSteps } from '../steps/runner.js';
import { StepExecutionError } from '../steps/types.js';
import type { StepLogger } from '../steps/types.js';
import { FakeTransport } from '../transport/fake.js';
import {
  createLxcUpdateSteps,
  lxcPendingKeys,
  lxcUpdateState,
  LxcUpdateError,
  planLxcUpdate,
} from './lxc-update.js';

type Lxc = Extract<GuestDeployment, { type: 'lxc' }>;

const stamp = managedGuestUuid('pve-01', 112);

function lxc(overrides: Partial<Lxc> = {}): Lxc {
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
    tags: ['app', 'hacm-managed'],
    features: { nesting: true },
    protection: false,
    disks: [
      {
        name: 'rootfs',
        storage: 'local-lvm',
        size_gb: 10,
        extra: { volume: 'vm-112-disk-0' },
      },
    ],
    network: [
      {
        index: 0,
        name: 'eth0',
        bridge: 'vmbr0',
        ip: '192.0.2.112/24',
      },
    ],
    ...overrides,
  };
}

const liveBefore = [
  'hostname: example-lxc',
  'cores: 2',
  'memory: 1024',
  'swap: 512',
  'tags: app;hacm-managed',
  'protection: 0',
  'features: nesting=1',
  'rootfs: local-lvm:vm-112-disk-0,size=10G',
  'net0: name=eth0,bridge=vmbr0,ip=192.0.2.112/24',
  'net1: name=eth1,bridge=vmbr1',
].join('\n');

const livePending = [
  liveBefore,
  '[PENDING]',
  'cores: 4',
  'memory: 2048',
  'swap: 1024',
  'protection: 1',
  'features: nesting=1,keyctl=1',
  'tags: app;extra;hacm-managed',
  'delete: net1',
  'net0: name=eth0,bridge=vmbr0,ip=192.0.2.113/24',
].join('\n');

const liveAfter = [
  'hostname: example-lxc',
  'cores: 4',
  'memory: 2048',
  'swap: 1024',
  'tags: app;extra;hacm-managed',
  'protection: 1',
  'features: nesting=1,keyctl=1',
  'rootfs: local-lvm:vm-112-disk-0,size=20G',
  'net0: name=eth0,bridge=vmbr0,ip=192.0.2.113/24',
].join('\n');

function desiredUpdate(): Lxc {
  return lxc({
    cpu: 4,
    ram: 2048,
    swap: 1024,
    tags: ['app', 'extra'],
    features: { nesting: true, keyctl: true },
    protection: true,
    disks: [
      {
        name: 'rootfs',
        storage: 'local-lvm',
        size_gb: 20,
        extra: { volume: 'vm-112-disk-0' },
      },
    ],
    network: [
      {
        index: 0,
        name: 'eth0',
        bridge: 'vmbr0',
        ip: '192.0.2.113/24',
      },
    ],
  });
}

function logger(): StepLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function transportWithConfigs(...configs: string[]): FakeTransport {
  const transport = new FakeTransport().onExec(/^pct (set|resize) 112 /, {
    stdout: 'ok',
  });
  for (const config of [...configs].reverse()) {
    transport.onExec('pct config 112', { stdout: config }, { once: true });
  }
  return transport;
}

async function run(
  transport: FakeTransport,
  steps: ReturnType<typeof createLxcUpdateSteps>,
) {
  return runJournaledSteps({
    operationId: 'update-test',
    input: undefined,
    transport,
    logger: logger(),
    dryRun: false,
    signal: new AbortController().signal,
    journal: new MemoryStepJournal(),
    steps,
  });
}

describe('planLxcUpdate', () => {
  it('reports no changes when YAML and live config match', () => {
    const live = lxc({ tags: ['app', 'hacm-managed'] });
    const plan = planLxcUpdate(lxc(), live);
    expect(plan).toMatchObject({
      blocked: false,
      destructive: false,
      restartRequired: false,
      changes: [],
      commands: [],
      summary: 'Update LXC 112 (example-lxc)',
    });
  });

  it('builds CPU, memory, swap, tag, feature, protection, NIC and disk commands', () => {
    const plan = planLxcUpdate(
      desiredUpdate(),
      lxc({
        network: [
          lxc().network[0]!,
          { index: 1, name: 'eth1', bridge: 'vmbr1' },
        ],
      }),
    );
    expect(plan.blocked).toBe(false);
    expect(plan.restartRequired).toBe(true);
    expect(plan.destructive).toBe(true);
    expect(plan.changes.map((change) => change.id)).toEqual([
      'cpu',
      'ram',
      'swap',
      'tags',
      'features',
      'protection',
      'net0',
      'net1',
      'disk-rootfs',
    ]);
    expect(plan.commands).toEqual([
      ['pct', 'set', '112', '--cores', '4'],
      ['pct', 'set', '112', '--memory', '2048'],
      ['pct', 'set', '112', '--swap', '1024'],
      ['pct', 'set', '112', '--tags', 'app;extra;hacm-managed'],
      ['pct', 'set', '112', '--features', 'keyctl=1,nesting=1'],
      ['pct', 'set', '112', '--protection', '1'],
      [
        'pct',
        'set',
        '112',
        '--net0',
        'name=eth0,bridge=vmbr0,ip=192.0.2.113/24',
      ],
      ['pct', 'set', '112', '--delete', 'net1'],
      ['pct', 'resize', '112', 'rootfs', '20G'],
    ]);
    expect(plan.changes.find((change) => change.id === 'net1')).toMatchObject({
      action: 'delete',
      destructive: true,
    });
    expect(plan.changes.find((change) => change.id === 'cpu')).toMatchObject({
      action: 'update',
      before: 2,
      after: 4,
    });
    expect(plan.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('restarted')]),
    );
  });

  it('keeps the managed tag and ignores tag ordering', () => {
    const plan = planLxcUpdate(
      lxc({ tags: ['hacm-managed', 'app'], protection: false }),
      lxc({ tags: ['app', 'hacm-managed'] }),
    );
    expect(plan.changes).toEqual([]);
  });

  it('adds a new NIC and removes protection only with confirmation', () => {
    const plan = planLxcUpdate(
      lxc({
        protection: false,
        network: [
          lxc().network[0]!,
          { index: 1, bridge: 'vmbr1', mac: 'A2:B1:C1:00:70:01' },
        ],
      }),
      lxc({ protection: true }),
    );
    expect(plan.changes.map((change) => change.id)).toEqual([
      'protection',
      'net1',
    ]);
    expect(plan.changes[0]).toMatchObject({ destructive: true, after: false });
    expect(plan.changes[1]).toMatchObject({ action: 'create' });
    expect(plan.destructive).toBe(true);
  });

  it('removes features when YAML explicitly disables them', () => {
    const plan = planLxcUpdate(
      lxc({ features: {} }),
      lxc({ features: { nesting: true, keyctl: true } }),
    );
    expect(plan.commands).toEqual([
      ['pct', 'set', '112', '--delete', 'features'],
    ]);
    expect(plan.restartRequired).toBe(true);
  });

  it('blocks a disk shrink without emitting commands', () => {
    const plan = planLxcUpdate(
      lxc({
        disks: [{ name: 'rootfs', storage: 'local-lvm', size_gb: 5 }],
      }),
      lxc(),
    );
    expect(plan.blocked).toBe(true);
    expect(plan.blockReason).toContain('Refusing to shrink rootfs');
    expect(plan.commands).toEqual([]);
  });

  it('blocks any update when live config has pending changes', () => {
    const live = lxc({
      extra: { _pending: { cores: '4', memory: '2048' } },
    });
    const plan = planLxcUpdate(lxc(), live);
    expect(plan.blocked).toBe(true);
    expect(plan.blockReason).toContain('pending configuration changes');
    expect(plan.blockReason).toContain('cores, memory');
    expect(lxcPendingKeys(live)).toEqual(['cores', 'memory']);
    expect(lxcPendingKeys(lxc({ extra: { _pending: [] } }))).toEqual([]);
  });

  it('warns about unmanaged values without changing them', () => {
    const plan = planLxcUpdate(
      {
        ...lxc(),
        swap: undefined,
        features: undefined,
        protection: undefined,
        disks: [
          lxc().disks[0]!,
          { name: 'data', storage: 'local-lvm', size_gb: 20 },
        ],
      },
      lxc({
        swap: 512,
        features: { nesting: true },
        protection: true,
        disks: [
          { name: 'rootfs', storage: 'local', size_gb: 10 },
          { name: 'rootfs', storage: 'local-lvm', size_gb: 10 },
        ],
      }),
    );
    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('swap is not declared'),
        expect.stringContaining('features are not declared'),
        expect.stringContaining('protection is enabled'),
        expect.stringContaining('rootfs storage differs'),
        expect.stringContaining("Disk 'data' is not managed"),
      ]),
    );
    expect(plan.warnings.join('\n')).not.toContain('rootfs disk is not');
  });

  it('warns about a missing live rootfs and undeclared live rootfs', () => {
    const missingLive = planLxcUpdate(lxc(), lxc({ disks: [] }));
    expect(missingLive.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('live rootfs disk is not visible'),
      ]),
    );

    const missingYaml = planLxcUpdate(lxc({ disks: [] }), lxc());
    expect(missingYaml.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('not declared in YAML')]),
    );
  });

  it('rejects unresolved tags and non-finite numbers', () => {
    expect(() =>
      planLxcUpdate(
        {
          ...lxc(),
          cpu: { tag: 'expr', value: 'cores' } as unknown as number,
        },
        lxc(),
      ),
    ).toThrow(LxcUpdateError);
    expect(() =>
      planLxcUpdate({ ...lxc(), cpu: 'lots' as unknown as number }, lxc()),
    ).toThrow('finite number');
    expect(() =>
      planLxcUpdate(
        {
          ...lxc(),
          protection: { tag: 'expr', value: 'p' } as unknown as boolean,
        },
        lxc(),
      ),
    ).toThrow(LxcUpdateError);
  });

  it('fingerprints the YAML and live state', () => {
    expect(lxcUpdateState(lxc(), lxc())).toEqual({
      desired: lxc(),
      live: lxc(),
    });
  });
});

describe('createLxcUpdateSteps', () => {
  it('applies the diff and restarts when required', async () => {
    const restart = vi.fn(async () => undefined);
    const transport = transportWithConfigs(
      liveBefore,
      liveBefore,
      livePending,
      livePending,
      liveAfter,
    );
    const result = await run(
      transport,
      createLxcUpdateSteps(desiredUpdate(), {
        hostId: 'pve-01',
        restartRequired: true,
        restart,
      }),
    );
    expect(result.entries.map((entry) => entry.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(transport.execArgv).toEqual(
      expect.arrayContaining([
        ['pct', 'set', '112', '--cores', '4'],
        ['pct', 'resize', '112', 'rootfs', '20G'],
        ['pct', 'config', '112'],
      ]),
    );
  });

  it('completes without a restart when no change needs one', async () => {
    const before = [
      'hostname: example-lxc',
      'cores: 2',
      'memory: 1024',
      'swap: 512',
      'tags: app;hacm-managed',
      'protection: 0',
      'features: nesting=1',
      'rootfs: local-lvm:vm-112-disk-0,size=10G',
      'net0: name=eth0,bridge=vmbr0,ip=192.0.2.112/24',
    ].join('\n');
    const after = [
      'hostname: example-lxc',
      'cores: 2',
      'memory: 1024',
      'swap: 512',
      'tags: app;hacm-managed',
      'protection: 1',
      'features: nesting=1',
      'rootfs: local-lvm:vm-112-disk-0,size=20G',
      'net0: name=eth0,bridge=vmbr0,ip=192.0.2.112/24',
    ].join('\n');
    const desired = lxc({
      protection: true,
      disks: [
        {
          name: 'rootfs',
          storage: 'local-lvm',
          size_gb: 20,
          extra: { volume: 'vm-112-disk-0' },
        },
      ],
    });
    const transport = transportWithConfigs(before, before, after);
    const restart = vi.fn(async () => undefined);
    const result = await run(
      transport,
      createLxcUpdateSteps(desired, {
        hostId: 'pve-01',
        restartRequired: false,
        restart,
      }),
    );
    expect(result.entries).toHaveLength(1);
    expect(restart).not.toHaveBeenCalled();
  });

  it('is satisfied when the guest already matches YAML', async () => {
    const transport = transportWithConfigs(liveAfter, liveAfter);
    const result = await run(
      transport,
      createLxcUpdateSteps(desiredUpdate(), {
        hostId: 'pve-01',
        restartRequired: true,
      }),
    );
    expect(result.entries[0]).toMatchObject({
      status: 'completed',
      result: { check: { changes: [] } },
    });
    expect(transport.execArgv).toEqual([
      ['pct', 'config', '112'],
      ['pct', 'config', '112'],
    ]);
  });

  it('fails the check when live config has pending changes', async () => {
    const transport = transportWithConfigs(livePending);
    await expect(
      run(
        transport,
        createLxcUpdateSteps(desiredUpdate(), {
          hostId: 'pve-01',
          restartRequired: true,
          restart: async () => undefined,
        }),
      ),
    ).rejects.toBeInstanceOf(StepExecutionError);
  });

  it('fails when reading the configuration fails', async () => {
    const transport = new FakeTransport().onExec('pct config 112', {
      exitCode: 2,
      stderr: 'permission denied',
    });
    await expect(
      run(
        transport,
        createLxcUpdateSteps(desiredUpdate(), {
          hostId: 'pve-01',
          restartRequired: true,
        }),
      ),
    ).rejects.toThrow('permission denied');

    const silent = new FakeTransport().onExec('pct config 112', {
      exitCode: 3,
    });
    await expect(
      run(
        silent,
        createLxcUpdateSteps(desiredUpdate(), {
          hostId: 'pve-01',
          restartRequired: true,
        }),
      ),
    ).rejects.toThrow('exit code 3');
  });

  it('fails when a pct command fails', async () => {
    const transport = new FakeTransport()
      .onExec('pct config 112', { stdout: liveBefore })
      .onExec('pct set 112 --cores 4', {
        exitCode: 1,
        stderr: 'cannot set cores',
      });
    await expect(
      run(
        transport,
        createLxcUpdateSteps(desiredUpdate(), {
          hostId: 'pve-01',
          restartRequired: false,
        }),
      ),
    ).rejects.toThrow('cannot set cores');

    const silent = new FakeTransport()
      .onExec('pct config 112', { stdout: liveBefore })
      .onExec('pct set 112 --cores 4', { exitCode: 4 });
    await expect(
      run(
        silent,
        createLxcUpdateSteps(desiredUpdate(), {
          hostId: 'pve-01',
          restartRequired: false,
        }),
      ),
    ).rejects.toThrow('exit code 4');
  });

  it('fails verification when the config did not change', async () => {
    const transport = transportWithConfigs(liveBefore, liveBefore, liveBefore);
    await expect(
      run(
        transport,
        createLxcUpdateSteps(desiredUpdate(), {
          hostId: 'pve-01',
          restartRequired: false,
        }),
      ),
    ).rejects.toThrow('still differs after update');
  });

  it('requires a restart hook when a restart is needed', async () => {
    const transport = transportWithConfigs(
      liveBefore,
      liveBefore,
      livePending,
      livePending,
    );
    await expect(
      run(
        transport,
        createLxcUpdateSteps(desiredUpdate(), {
          hostId: 'pve-01',
          restartRequired: true,
        }),
      ),
    ).rejects.toThrow('no restart hook is configured');
  });

  it('fails when pending config remains after restart', async () => {
    const transport = transportWithConfigs(
      liveBefore,
      liveBefore,
      livePending,
      livePending,
      livePending,
    );
    await expect(
      run(
        transport,
        createLxcUpdateSteps(desiredUpdate(), {
          hostId: 'pve-01',
          restartRequired: true,
          restart: async () => undefined,
        }),
      ),
    ).rejects.toThrow('still has pending configuration after restart');
  });

  it('fails when the config still differs after restart', async () => {
    const transport = transportWithConfigs(
      liveBefore,
      liveBefore,
      livePending,
      livePending,
      liveBefore,
    );
    await expect(
      run(
        transport,
        createLxcUpdateSteps(desiredUpdate(), {
          hostId: 'pve-01',
          restartRequired: true,
          restart: async () => undefined,
        }),
      ),
    ).rejects.toThrow('still differs after restart');
  });

  it('does not call a restart hook when already satisfied', async () => {
    const restart = vi.fn(async () => undefined);
    const transport = transportWithConfigs(liveAfter, liveAfter);
    await run(
      transport,
      createLxcUpdateSteps(desiredUpdate(), {
        hostId: 'pve-01',
        restartRequired: true,
        restart,
      }),
    );
    expect(restart).not.toHaveBeenCalled();
  });
});

describe('mp0 attachment safety (D-44)', () => {
  const mp0Path = '/opt/server-data/pve-01/example-lxc/opt';
  const liveBase = liveBefore
    .split('\n')
    .filter((line) => !line.startsWith('net1:'))
    .join('\n');
  const liveWithMp0 = [liveBase, `mp0: ${mp0Path},backup=1,mp=/opt`].join('\n');

  function desiredWithMp0(overrides: Partial<Lxc> = {}): Lxc {
    return lxc({
      mounts: [
        {
          index: 0,
          host_path: mp0Path,
          guest_path: '/opt',
          backup: true,
          permissions: 'minimal',
        },
      ],
      ...overrides,
    });
  }

  it('plans an attach without a hot pct set command', () => {
    const plan = planLxcUpdate(desiredWithMp0(), lxc());
    expect(plan.blocked).toBe(false);
    expect(plan.mountChangeRequired).toBe(true);
    expect(plan.restartRequired).toBe(true);
    expect(plan.commands).toEqual([]);
    expect(plan.mountCommands).toEqual([
      ['pct', 'set', '112', '--mp0', `${mp0Path},backup=1,mp=/opt`],
    ]);
    expect(plan.changes).toEqual([
      expect.objectContaining({
        id: 'mp0',
        action: 'create',
        before: null,
        after: `${mp0Path},backup=1,mp=/opt`,
      }),
    ]);
    expect(plan.warnings.join('\n')).toContain('never hot-applied');
  });

  it('plans an update and a destructive detach', () => {
    const changed = planLxcUpdate(
      desiredWithMp0({
        mounts: [
          {
            index: 0,
            host_path: '/opt/server-data/pve-01/example-lxc/data',
            guest_path: '/data',
            permissions: 'minimal',
          },
        ],
      }),
      lxc({
        mounts: [
          {
            index: 0,
            host_path: mp0Path,
            guest_path: '/opt',
            permissions: 'minimal',
          },
        ],
      }),
    );
    expect(changed.mountCommands).toEqual([
      [
        'pct',
        'set',
        '112',
        '--mp0',
        '/opt/server-data/pve-01/example-lxc/data,mp=/data',
      ],
    ]);
    expect(changed.changes[0]).toMatchObject({ id: 'mp0', action: 'update' });

    const removed = planLxcUpdate(lxc(), {
      ...lxc(),
      mounts: [
        {
          index: 0,
          host_path: mp0Path,
          guest_path: '/opt',
          permissions: 'minimal',
        },
      ],
    });
    expect(removed.mountChangeRequired).toBe(true);
    expect(removed.destructive).toBe(true);
    expect(removed.mountCommands).toEqual([
      ['pct', 'set', '112', '--delete', 'mp0'],
    ]);
    expect(removed.changes[0]).toMatchObject({
      id: 'mp0',
      action: 'delete',
      destructive: true,
    });
  });

  it('does not plan mp0 when it already matches and warns about other mounts', () => {
    const plan = planLxcUpdate(
      desiredWithMp0({
        mounts: [
          {
            index: 0,
            host_path: mp0Path,
            guest_path: '/opt',
            backup: true,
            permissions: 'minimal',
          },
          {
            index: 1,
            host_path: '/srv/shared',
            guest_path: '/shared',
            permissions: 'minimal',
          },
        ],
      }),
      lxc({
        mounts: [
          {
            index: 0,
            host_path: mp0Path,
            guest_path: '/opt',
            backup: true,
            permissions: 'minimal',
          },
        ],
      }),
    );
    expect(plan.mountChangeRequired).toBe(false);
    expect(plan.mountCommands).toEqual([]);
    expect(plan.warnings.join('\n')).toContain('mp1 is not managed');
  });

  it('handles satisfied and blocked plans inside the mp0 step', async () => {
    const step = createLxcUpdateSteps(desiredWithMp0(), {
      hostId: 'pve-01',
      restartRequired: false,
      mountChangeRequired: true,
    })[0]!;
    const context = (transport: FakeTransport) => ({
      operationId: 'mp0-step',
      input: undefined,
      transport,
      logger: logger(),
      dryRun: false,
      signal: new AbortController().signal,
    });
    const unchanged = transportWithConfigs(liveWithMp0, liveWithMp0);
    await expect(step.check(context(unchanged))).resolves.toMatchObject({
      status: 'satisfied',
    });
    await expect(step.apply(context(unchanged))).resolves.toEqual({
      changed: false,
    });

    const pendingLive = [liveBase, '[PENDING]', 'cores: 4'].join('\n');
    await expect(
      step.check(
        context(
          new FakeTransport().onExec('pct config 112', {
            stdout: pendingLive,
          }),
        ),
      ),
    ).rejects.toThrow('pending configuration changes');
    await expect(
      step.apply(
        context(
          new FakeTransport().onExec('pct config 112', {
            stdout: pendingLive,
          }),
        ),
      ),
    ).rejects.toThrow('pending configuration changes');

    const shrink = planLxcUpdate(
      desiredWithMp0({
        disks: [{ name: 'rootfs', storage: 'local-lvm', size_gb: 5 }],
      }),
      lxc(),
    );
    expect(shrink.blocked).toBe(true);
    const shrinkingStep = createLxcUpdateSteps(
      desiredWithMp0({
        disks: [{ name: 'rootfs', storage: 'local-lvm', size_gb: 5 }],
      }),
      { hostId: 'pve-01', restartRequired: false, mountChangeRequired: true },
    )[0]!;
    await expect(
      shrinkingStep.verify(context(transportWithConfigs(liveWithMp0))),
    ).rejects.toThrow('Refusing to shrink rootfs');
  });

  it('stops a running guest, attaches mp0 and starts it again', async () => {
    const transport = transportWithConfigs(
      liveBase,
      liveBase,
      liveWithMp0,
      liveWithMp0,
    )
      .onExec('pct status 112', { stdout: 'status: stopped' }, { once: true })
      .onExec('pct status 112', { stdout: 'status: running' }, { once: true })
      .onExec('pct start 112', { stdout: 'started' })
      .onExec('pct shutdown 112', { stdout: 'stopped' });

    const result = await run(
      transport,
      createLxcUpdateSteps(desiredWithMp0(), {
        hostId: 'pve-01',
        restartRequired: false,
        mountChangeRequired: true,
      }),
    );
    expect(result.entries.map((entry) => entry.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(transport.execArgv).toEqual(
      expect.arrayContaining([
        ['pct', 'shutdown', '112'],
        ['pct', 'set', '112', '--mp0', `${mp0Path},backup=1,mp=/opt`],
        ['pct', 'start', '112'],
      ]),
    );
    const setIndex = transport.execArgv.findIndex(
      (argv) => argv[0] === 'pct' && argv[1] === 'set',
    );
    const shutdownIndex = transport.execArgv.findIndex(
      (argv) => argv[0] === 'pct' && argv[1] === 'shutdown',
    );
    const startIndex = transport.execArgv.findIndex(
      (argv) => argv[0] === 'pct' && argv[1] === 'start',
    );
    expect(shutdownIndex).toBeLessThan(setIndex);
    expect(setIndex).toBeLessThan(startIndex);
  });

  it('leaves a stopped guest stopped and refuses hot-apply attempts', async () => {
    const stopped = transportWithConfigs(
      liveBase,
      liveBase,
      liveWithMp0,
      liveWithMp0,
    ).onExec('pct status 112', { stdout: 'status: stopped' });
    const result = await run(
      stopped,
      createLxcUpdateSteps(desiredWithMp0(), {
        hostId: 'pve-01',
        restartRequired: false,
        mountChangeRequired: true,
      }),
    );
    expect(result.entries[0]?.status).toBe('completed');
    expect(
      stopped.execArgv.some(
        (argv) => argv[0] === 'pct' && argv[1] === 'shutdown',
      ),
    ).toBe(false);
    expect(
      stopped.execArgv.some((argv) => argv[0] === 'pct' && argv[1] === 'start'),
    ).toBe(false);

    const shutdownFailed = transportWithConfigs(liveBase, liveBase)
      .onExec('pct status 112', { stdout: 'status: running' })
      .onExec('pct shutdown 112', {
        exitCode: 1,
        stderr: 'shutdown refused',
      });
    await expect(
      run(
        shutdownFailed,
        createLxcUpdateSteps(desiredWithMp0(), {
          hostId: 'pve-01',
          restartRequired: false,
          mountChangeRequired: true,
        }),
      ),
    ).rejects.toThrow('Refusing to hot-apply mp0');

    const stillRunning = transportWithConfigs(liveBase, liveBase)
      .onExec('pct status 112', { stdout: 'status: running' })
      .onExec('pct shutdown 112', { stdout: 'ok' });
    await expect(
      run(
        stillRunning,
        createLxcUpdateSteps(desiredWithMp0(), {
          hostId: 'pve-01',
          restartRequired: false,
          mountChangeRequired: true,
        }),
      ),
    ).rejects.toThrow('still running after shutdown');

    const unknown = transportWithConfigs(liveBase, liveBase).onExec(
      'pct status 112',
      { exitCode: 1, stderr: 'status unavailable' },
    );
    await expect(
      run(
        unknown,
        createLxcUpdateSteps(desiredWithMp0(), {
          hostId: 'pve-01',
          restartRequired: false,
          mountChangeRequired: true,
        }),
      ),
    ).rejects.toThrow('power state could not be determined');

    const unparsable = transportWithConfigs(liveBase, liveBase).onExec(
      'pct status 112',
      { stdout: 'status: migrating' },
    );
    await expect(
      run(
        unparsable,
        createLxcUpdateSteps(desiredWithMp0(), {
          hostId: 'pve-01',
          restartRequired: false,
          mountChangeRequired: true,
        }),
      ),
    ).rejects.toThrow('power state could not be determined');
  });

  it('explains mount and start failures', async () => {
    const mountFailed = transportWithConfigs(liveBase, liveBase)
      .onExec('pct status 112', { stdout: 'status: stopped' })
      .onExec(/^pct set 112 --mp0/, {
        exitCode: 1,
        stderr: 'mount rejected',
      });
    await expect(
      run(
        mountFailed,
        createLxcUpdateSteps(desiredWithMp0(), {
          hostId: 'pve-01',
          restartRequired: false,
          mountChangeRequired: true,
        }),
      ),
    ).rejects.toThrow('mount rejected');

    const mountSilent = transportWithConfigs(liveBase, liveBase)
      .onExec('pct status 112', { stdout: 'status: stopped' })
      .onExec(/^pct set 112 --mp0/, { exitCode: 1 });
    await expect(
      run(
        mountSilent,
        createLxcUpdateSteps(desiredWithMp0(), {
          hostId: 'pve-01',
          restartRequired: false,
          mountChangeRequired: true,
        }),
      ),
    ).rejects.toThrow('exit code 1');

    const shutdownSilent = transportWithConfigs(liveBase, liveBase)
      .onExec('pct status 112', { stdout: 'status: running' })
      .onExec('pct shutdown 112', { exitCode: 1 });
    await expect(
      run(
        shutdownSilent,
        createLxcUpdateSteps(desiredWithMp0(), {
          hostId: 'pve-01',
          restartRequired: false,
          mountChangeRequired: true,
        }),
      ),
    ).rejects.toThrow('exit code 1');

    const startFailed = transportWithConfigs(liveBase, liveBase)
      .onExec('pct status 112', { stdout: 'status: stopped' }, { once: true })
      .onExec('pct status 112', { stdout: 'status: running' }, { once: true })
      .onExec('pct shutdown 112', { stdout: 'ok' })
      .onExec('pct start 112', { exitCode: 1, stderr: 'start rejected' });
    await expect(
      run(
        startFailed,
        createLxcUpdateSteps(desiredWithMp0(), {
          hostId: 'pve-01',
          restartRequired: false,
          mountChangeRequired: true,
        }),
      ),
    ).rejects.toThrow('failed to start again');

    const startSilent = transportWithConfigs(liveBase, liveBase)
      .onExec('pct status 112', { stdout: 'status: stopped' }, { once: true })
      .onExec('pct status 112', { stdout: 'status: running' }, { once: true })
      .onExec('pct shutdown 112', { stdout: 'ok' })
      .onExec('pct start 112', { exitCode: 1 });
    await expect(
      run(
        startSilent,
        createLxcUpdateSteps(desiredWithMp0(), {
          hostId: 'pve-01',
          restartRequired: false,
          mountChangeRequired: true,
        }),
      ),
    ).rejects.toThrow('exit code 1');
  });

  it('verifies that [PENDING] is empty after the controlled restart', async () => {
    const pendingAfter = [liveWithMp0, '[PENDING]', 'cores: 4'].join('\n');
    const transport = transportWithConfigs(
      liveBase,
      liveBase,
      pendingAfter,
    ).onExec('pct status 112', { stdout: 'status: stopped' });
    await expect(
      run(
        transport,
        createLxcUpdateSteps(desiredWithMp0(), {
          hostId: 'pve-01',
          restartRequired: false,
          mountChangeRequired: true,
        }),
      ),
    ).rejects.toThrow('[PENDING] must be empty');

    const unchanged = transportWithConfigs(liveBase, liveBase, liveBase).onExec(
      'pct status 112',
      { stdout: 'status: stopped' },
    );
    await expect(
      run(
        unchanged,
        createLxcUpdateSteps(desiredWithMp0(), {
          hostId: 'pve-01',
          restartRequired: false,
          mountChangeRequired: true,
        }),
      ),
    ).rejects.toThrow('still has a differing mp0');
  });
});

describe('LXC update safety metadata', () => {
  it('keeps the managed stamp out of the diff', () => {
    const plan = planLxcUpdate(lxc(), lxc({ tags: ['app', stamp] }));
    expect(plan.changes[0]).toMatchObject({
      id: 'tags',
      after: ['app', 'hacm-managed'],
    });
  });
});
