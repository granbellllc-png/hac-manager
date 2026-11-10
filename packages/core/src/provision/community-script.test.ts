import { describe, expect, it } from 'vitest';
import type { GuestDeployment } from '../schema/deployment.js';
import { MemoryStepJournal } from '../steps/memory-journal.js';
import { runJournaledSteps } from '../steps/runner.js';
import type { StepExecutionContext, StepLogger } from '../steps/types.js';
import type { ExecOptions, ExecResult, Transport } from '../transport/types.js';
import { FakeTransport } from '../transport/fake.js';
import type { GuestIdMap } from '../storage/host-dirs.js';
import {
  createAdoptionFinalVerifyStep,
  createCommunityScriptAdoptionSteps,
  createLxcIdentityCheckStep,
  createLxcRootfsEmptyStep,
  createLxcStampStep,
  createScriptCreatedGuestStep,
  lxcConfigField,
  lxcConfigTags,
  lxcStampArgv,
  planLxcStamp,
} from './community-script.js';
import { lxcMp0Matches, planLxcMigration } from './lxc-migrate.js';

type Lxc = Extract<GuestDeployment, { type: 'lxc' }>;

const hostId = 'pve-01';
const vmid = 112;
const rootfsMountPath = '/fixtures/lxc/112/rootfs';
const hostPath = '/opt/server-data/pve-01/example-lxc/opt';
const guestOptPath = `${rootfsMountPath}/opt`;
const displacedPath = `${guestOptPath}.migrated-2026-11-10T120000Z`;
const configPath = '/etc/pve/local/lxc/112.conf';

const initialConfig = [
  'hostname: example-lxc',
  'cores: 2',
  'memory: 1024',
  'rootfs: local-lvm:vm-112-disk-0,size=10G',
  'description: Created by a community script',
].join('\n');

function lxc(overrides: Partial<Lxc> = {}): Lxc {
  return {
    schema_version: 1,
    id: vmid,
    name: 'example-lxc',
    type: 'lxc',
    cpu: 2,
    ram: 1024,
    unprivileged: true,
    ostype: 'debian',
    tags: ['app'],
    disks: [{ name: 'rootfs', storage: 'local-lvm', size_gb: 10 }],
    network: [{ index: 0, name: 'eth0', bridge: 'vmbr0' }],
    mounts: [
      {
        index: 0,
        host_path: hostPath,
        guest_path: '/opt',
        backup: true,
        permissions: 'minimal',
      },
    ],
    installation: {
      type: 'community_script',
      url: `https://example.test/install.sh/${'a'.repeat(40)}`,
      pinned_commit: 'a'.repeat(40),
      answers: { 'Continue\\?': 'y' },
    },
    identity_checks: ['test -f /etc/os-release'],
    ...overrides,
  };
}

const options = {
  hostId,
  backup: false,
  timestamp: '2026-11-10T120000Z',
  rootfsMountPath,
} as const;

interface Call {
  readonly argv: readonly string[];
  readonly stdin?: string | undefined;
}

/** Small stateful host fake for the adoption sequence. */
class AdoptionTransport implements Transport {
  public config = initialConfig;
  public running = true;
  public mounted = false;
  public failMountOnce = false;
  public readonly calls: Call[] = [];
  public readonly paths = new Set([guestOptPath]);
  public hostStat: { uid: number; gid: number; mode: number } | undefined;

  private result(
    exitCode = 0,
    stdout = '',
    stderr = '',
    timedOut = false,
  ): ExecResult {
    return { exitCode, stdout, stderr, timedOut };
  }

  private setConfigField(field: string, value: string): void {
    const lines = this.config.split('\n');
    const prefix = `${field}:`;
    const index = lines.findIndex((line) => line.startsWith(prefix));
    if (index >= 0) lines[index] = `${prefix} ${value}`;
    else lines.push(`${prefix} ${value}`);
    this.config = lines.join('\n');
  }

  public async exec(
    argv: readonly string[],
    execOptions?: ExecOptions,
  ): Promise<ExecResult> {
    this.calls.push({ argv, stdin: execOptions?.stdin });
    const joined = argv.join(' ');
    if (joined === `test -f ${configPath}`) return this.result();
    if (joined === 'pct config 112') return this.result(0, this.config);
    if (joined === 'pct status 112') {
      return this.result(0, `status: ${this.running ? 'running' : 'stopped'}`);
    }
    if (joined === 'test -e ' + guestOptPath) {
      return this.paths.has(guestOptPath) ? this.result() : this.result(1);
    }
    if (joined === 'test -e ' + displacedPath) {
      return this.paths.has(displacedPath) ? this.result() : this.result(1);
    }
    if (joined === 'test -e ' + hostPath) {
      return this.hostStat ? this.result() : this.result(1);
    }
    if (joined === `stat -c %u:%g:%a ${hostPath}`) {
      return this.hostStat
        ? this.result(
            0,
            `${this.hostStat.uid}:${this.hostStat.gid}:${this.hostStat.mode}`,
          )
        : this.result(1);
    }
    if (argv[0] === 'install' && argv[1] === '-d') {
      this.hostStat = { uid: 100_000, gid: 100_000, mode: 750 };
      return this.result();
    }
    if (argv[0] === 'chown' || argv[0] === 'chmod') return this.result();
    if (joined === `mountpoint -q ${rootfsMountPath}`) {
      return this.mounted ? this.result() : this.result(1);
    }
    if (joined === 'pct mount 112') {
      if (this.failMountOnce) {
        this.failMountOnce = false;
        return this.result(1, '', 'mount failed once');
      }
      this.mounted = true;
      return this.result();
    }
    if (joined === 'pct unmount 112') {
      this.mounted = false;
      return this.result();
    }
    if (joined.startsWith('rsync ')) {
      this.hostStat = { uid: 100_000, gid: 100_000, mode: 750 };
      return this.result();
    }
    if (joined.startsWith('bash -s -- ')) {
      return this.result();
    }
    if (joined === `mv ${guestOptPath} ${displacedPath}`) {
      if (this.paths.has(displacedPath)) return this.result(1, '', 'exists');
      this.paths.delete(guestOptPath);
      this.paths.add(displacedPath);
      return this.result();
    }
    if (argv[0] === 'find') {
      const path = argv[1] ?? '';
      return this.paths.has(path)
        ? this.result(0, `${path}/file\n`)
        : this.result(1, '', 'missing');
    }
    if (joined === 'pct shutdown 112 --timeout 120') {
      this.running = false;
      return this.result();
    }
    if (joined === 'pct start 112') {
      this.running = true;
      return this.result();
    }
    if (argv[0] === 'pct' && argv[1] === 'set' && argv[2] === '112') {
      const mp0 = argv.indexOf('--mp0');
      if (mp0 >= 0) {
        this.setConfigField('mp0', argv[mp0 + 1] ?? '');
      }
      const tags = argv.indexOf('--tags');
      if (tags >= 0) this.setConfigField('tags', argv[tags + 1] ?? '');
      const description = argv.indexOf('--description');
      if (description >= 0) {
        this.setConfigField('description', argv[description + 1] ?? '');
      }
      return this.result();
    }
    if (argv[0] === 'pct' && argv[1] === 'exec') {
      return this.result();
    }
    throw new Error(`unexpected command: ${joined}`);
  }

  public async readFile(): Promise<string> {
    throw new Error('not used');
  }

  public async writeFile(): Promise<void> {
    throw new Error('not used');
  }
}

function logger(): StepLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function context(
  transport: Transport,
  operationId = 'adopt-112',
): StepExecutionContext<undefined> {
  return {
    operationId,
    input: undefined,
    transport,
    logger: logger(),
    dryRun: false,
    signal: new AbortController().signal,
  };
}

describe('config field helpers', () => {
  it('reads single and multi-line fields', () => {
    expect(lxcConfigField(initialConfig, 'hostname')).toBe('example-lxc');
    expect(
      lxcConfigField(
        'a: 1\ndescription: one\ntwo\nthree\nmp0: x',
        'description',
      ),
    ).toBe('one\ntwo\nthree');
    expect(lxcConfigField(initialConfig, 'missing')).toBeUndefined();
    expect(lxcConfigField('description:', 'description')).toBe('');
  });

  it('parses management tags', () => {
    expect(lxcConfigTags('tags: app;hacm-managed')).toEqual([
      'app',
      'hacm-managed',
    ]);
    expect(lxcConfigTags('tags:')).toEqual([]);
    expect(lxcConfigTags('hostname: x')).toEqual([]);
  });

  it('plans and builds only changed stamp fields', () => {
    const plan = planLxcStamp(initialConfig, hostId, vmid);
    expect(plan.changed).toBe(true);
    expect(plan.tags).toContain('hacm-managed');
    expect(plan.description).toContain('hacm-managed: ');
    const argv = lxcStampArgv(initialConfig, plan, vmid);
    expect(argv?.slice(0, 3)).toEqual(['pct', 'set', '112']);
    expect(argv).toContain('--tags');
    expect(argv).toContain('--description');

    const stamped = [
      'hostname: example-lxc',
      `tags: app;hacm-managed`,
      `description: ${plan.description}`,
    ].join('\n');
    expect(planLxcStamp(stamped, hostId, vmid).changed).toBe(false);
    expect(
      lxcStampArgv(stamped, planLxcStamp(stamped, hostId, vmid), vmid),
    ).toBeUndefined();

    const onlyTags = `description: ${plan.description}\ntags: app`;
    expect(
      lxcStampArgv(onlyTags, planLxcStamp(onlyTags, hostId, vmid), vmid),
    ).not.toContain('--description');
  });

  it('replaces a foreign stamp in place', () => {
    const config = `description: kept\nhacm-managed: ${'0'.repeat(8)}-0000-0000-0000-000000000000`;
    const plan = planLxcStamp(config, hostId, vmid);
    expect(plan.description.startsWith('kept\nhacm-managed: ')).toBe(true);
    expect(plan.description).not.toContain('00000000-0000');
  });
});

describe('community script adoption', () => {
  it('migrates, stamps, verifies and starts a script-created LXC', async () => {
    const transport = new AdoptionTransport();
    const steps = createCommunityScriptAdoptionSteps(lxc(), options);
    const journal = new MemoryStepJournal();
    const result = await runJournaledSteps({
      ...context(transport),
      steps,
      journal,
    });

    expect(result.entries).toHaveLength(steps.length);
    expect(result.entries.every((entry) => entry.status === 'completed')).toBe(
      true,
    );
    expect(transport.running).toBe(true);
    expect(transport.paths.has(guestOptPath)).toBe(false);
    expect(transport.paths.has(displacedPath)).toBe(true);
    expect(
      lxcMp0Matches(transport.config, `${hostPath},backup=1,mp=/opt`),
    ).toBe(true);
    expect(transport.config).toContain('tags: app;hacm-managed');
    expect(transport.config).toContain('Created by a community script');
    expect(transport.config).toContain('hacm-managed: ');
    expect(transport.calls.some((call) => call.argv[1] === 'exec')).toBe(true);
    expect(
      transport.calls.filter(
        (call) => call.argv.join(' ') === 'pct exec 112 -- /bin/sh -s',
      )[0]?.stdin,
    ).toBe('test -f /etc/os-release\n');
  });

  it('resumes after a failure without repeating completed steps', async () => {
    const transport = new AdoptionTransport();
    transport.failMountOnce = true;
    const steps = createCommunityScriptAdoptionSteps(lxc(), options);
    const journal = new MemoryStepJournal();

    await expect(
      runJournaledSteps({ ...context(transport), steps, journal }),
    ).rejects.toThrow(/mount failed once/);
    const failed = await journal.list('adopt-112');
    expect(failed.some((entry) => entry.status === 'failed')).toBe(true);

    const resumed = await runJournaledSteps({
      ...context(transport),
      steps,
      journal,
    });
    expect(resumed.entries.every((entry) => entry.status === 'completed')).toBe(
      true,
    );
    expect(transport.running).toBe(true);
    expect(transport.paths.has(displacedPath)).toBe(true);
  });

  it('skips all mutations in a dry run', async () => {
    const transport = new AdoptionTransport();
    const steps = createCommunityScriptAdoptionSteps(lxc(), options);
    const journal = new MemoryStepJournal();
    const result = await runJournaledSteps({
      ...context(transport),
      steps,
      journal,
      dryRun: true,
    });
    expect(
      result.entries.every(
        (entry) => entry.status === 'completed' || entry.status === 'skipped',
      ),
    ).toBe(true);
    expect(transport.running).toBe(true);
    expect(transport.mounted).toBe(false);
    const mutating = new Set([
      'install',
      'rsync',
      'mv',
      'pct set',
      'pct start',
      'pct stop',
      'pct shutdown',
      'pct mount',
      'pct unmount',
      'pct exec',
    ]);
    expect(
      transport.calls.some((call) =>
        mutating.has(
          `${call.argv[0]}${call.argv[1] ? ` ${call.argv[1]}` : ''}`,
        ),
      ),
    ).toBe(false);
  });

  it('refuses VMs and missing or foreign script-created guests', async () => {
    const vm: GuestDeployment = {
      id: 300,
      name: 'example-vm',
      type: 'vm',
      cpu: 1,
      ram: 512,
      disks: [],
      network: [],
    };
    expect(() => createCommunityScriptAdoptionSteps(vm, options)).toThrow(
      /only applies to LXC/,
    );

    const transport = new AdoptionTransport();
    const scriptCheck = transport.exec.bind(transport);
    transport.exec = async (argv, execOptions) =>
      argv.join(' ') === `test -f ${configPath}`
        ? { exitCode: 1, stdout: '', stderr: '', timedOut: false }
        : scriptCheck(argv, execOptions);
    const steps = createCommunityScriptAdoptionSteps(lxc(), options);
    await expect(
      runJournaledSteps({
        ...context(transport),
        steps,
        journal: new MemoryStepJournal(),
      }),
    ).rejects.toThrow(/did not create LXC 112/);

    const foreign = new AdoptionTransport();
    foreign.config = initialConfig.replace(
      'description: Created by a community script',
      `description: hacm-managed: 00000000-0000-0000-0000-000000000000`,
    );
    await expect(
      runJournaledSteps({
        ...context(foreign),
        steps,
        journal: new MemoryStepJournal(),
      }),
    ).rejects.toThrow(/probably reused/);

    const wrongName = new AdoptionTransport();
    wrongName.config = initialConfig.replace(
      'hostname: example-lxc',
      'hostname: other',
    );
    await expect(
      runJournaledSteps({
        ...context(wrongName),
        steps,
        journal: new MemoryStepJournal(),
      }),
    ).rejects.toThrow(/different workload/);
  });

  it('fails adoption when identity checks fail', async () => {
    const transport = new AdoptionTransport();
    const exec = transport.exec.bind(transport);
    transport.exec = async (argv, execOptions) => {
      if (argv[1] === 'exec') {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'missing os-release',
          timedOut: false,
        };
      }
      return exec(argv, execOptions);
    };
    await expect(
      runJournaledSteps({
        ...context(transport),
        steps: createCommunityScriptAdoptionSteps(lxc(), options),
        journal: new MemoryStepJournal(),
      }),
    ).rejects.toThrow(/Identity check 'test -f \/etc\/os-release' failed/);
  });

  it('reports identity checks that cannot run on a stopped guest', async () => {
    const transport = new AdoptionTransport();
    transport.running = false;
    const steps = [
      ...createCommunityScriptAdoptionSteps(lxc(), options).filter((step) =>
        step.name.startsWith('run identity checks'),
      ),
    ];
    await expect(
      runJournaledSteps({
        ...context(transport),
        steps,
        journal: new MemoryStepJournal(),
      }),
    ).rejects.toThrow(/require a running guest/);
  });

  it('exposes the migration plan and keeps a displaced copy', () => {
    const plan = planLxcMigration(lxc(), options);
    expect(plan.rootfsMountPath).toBe(options.rootfsMountPath);
    expect(plan.displacedPath).toBe(displacedPath);
    expect(plan.hostPath).toBe(hostPath);
    expect(plan.mp0Value).toBe(`${hostPath},backup=1,mp=/opt`);
    const idmap: GuestIdMap = plan.idmap;
    expect(idmap).toEqual({ uidBase: 100_000, gidBase: 100_000, size: 65_536 });
  });

  it('builds default host paths for a missing mp0 and warns', () => {
    const guest = lxc({ mounts: undefined });
    const steps = createCommunityScriptAdoptionSteps(guest, options);
    expect(
      steps.some((step) =>
        step.name.includes('/opt/server-data/pve-01/example-lxc/opt'),
      ),
    ).toBe(true);
    expect(() =>
      createCommunityScriptAdoptionSteps(guest, options),
    ).not.toThrow();
  });

  it('rejects a malformed host identity', () => {
    expect(() => planLxcStamp(initialConfig, '', vmid)).toThrow(/hostId/);
  });
});

describe('adoption step edge cases', () => {
  const plan = planLxcMigration(lxc(), options);
  const stamped = planLxcStamp(initialConfig, hostId, vmid, ['app']);
  const stampedConfig = [
    'hostname: example-lxc',
    `mp0: ${plan.mp0Value}`,
    `tags: ${stamped.tags.join(';')}`,
    `description: ${stamped.description}`,
  ].join('\n');

  it('builds stamp argv when only tags or only description changed', () => {
    expect(
      lxcStampArgv(
        'tags: a;c\ndescription: old',
        { tags: ['a', 'b'], description: 'old', changed: true },
        vmid,
      ),
    ).toEqual(['pct', 'set', '112', '--tags', 'a;b']);
    expect(
      lxcStampArgv(
        'tags: app\ndescription: old',
        { tags: ['app'], description: 'new', changed: true },
        vmid,
      ),
    ).toEqual(['pct', 'set', '112', '--description', 'new']);
  });

  it('verifies and applies the script-created guest guard directly', async () => {
    const step = createScriptCreatedGuestStep(lxc(), { hostId });
    const transport = new AdoptionTransport();
    await expect(step.apply(context(transport))).resolves.toEqual({
      adopted: true,
    });
    await expect(step.verify(context(transport))).resolves.toEqual({
      vmid,
    });

    const wrongName = new AdoptionTransport();
    wrongName.config = initialConfig.replace('example-lxc', 'other');
    await expect(step.verify(context(wrongName))).rejects.toThrow(
      /no longer has hostname/,
    );
  });

  it('skips or fails the stamp apply and verify branches', async () => {
    const step = createLxcStampStep(lxc(), { hostId });
    const already = new AdoptionTransport();
    already.config = stampedConfig;
    await expect(step.apply(context(already))).resolves.toEqual({
      changed: false,
    });

    const denied = new AdoptionTransport();
    const deniedExec = denied.exec.bind(denied);
    denied.exec = async (argv, execOptions) =>
      argv[1] === 'set'
        ? { exitCode: 1, stdout: '', stderr: 'denied', timedOut: false }
        : deniedExec(argv, execOptions);
    await expect(step.apply(context(denied))).rejects.toThrow(
      /Failed to stamp LXC 112: denied/,
    );

    const unstamped = new AdoptionTransport();
    await expect(step.verify(context(unstamped))).rejects.toThrow(
      /not stamped as managed/,
    );
  });

  it('guards the rootfs path before mp0 is attached', async () => {
    const step = createLxcRootfsEmptyStep(plan);
    const empty = new FakeTransport()
      .onExec(`test -e ${guestOptPath}`, {})
      .onExec(`find ${guestOptPath} -mindepth 1 -print -quit`, { stdout: '' });
    await expect(step.check(context(empty))).resolves.toEqual({
      status: 'satisfied',
      detail: { empty: true },
    });

    const populated = new FakeTransport()
      .onExec(`test -e ${guestOptPath}`, {})
      .onExec(`find ${guestOptPath} -mindepth 1 -print -quit`, {
        stdout: `${guestOptPath}/old`,
      });
    await expect(step.check(context(populated))).resolves.toEqual({
      status: 'required',
      detail: { empty: false },
    });
    await expect(step.apply(context(populated))).rejects.toThrow(
      /still contains data/,
    );
    await expect(step.verify(context(populated))).rejects.toThrow(
      /is not empty after migration/,
    );

    const broken = new FakeTransport()
      .onExec(`test -e ${guestOptPath}`, {})
      .onExec(`find ${guestOptPath} -mindepth 1 -print -quit`, {
        exitCode: 1,
        stderr: 'io error',
      });
    await expect(step.check(context(broken))).rejects.toThrow(/io error/);

    const gone = new FakeTransport().onExec(`test -e ${guestOptPath}`, {
      exitCode: 1,
    });
    await expect(step.apply(context(gone))).resolves.toEqual({ empty: true });
    await expect(step.verify(context(gone))).resolves.toEqual({ empty: true });
  });

  it('fails the final adoption invariants individually', async () => {
    const step = createAdoptionFinalVerifyStep(lxc(), plan, { hostId });
    const valid = (config = stampedConfig) =>
      new FakeTransport()
        .onExec('pct config 112', { stdout: config })
        .onExec('pct status 112', { stdout: 'status: running' })
        .onExec(`stat -c %u:%g:%a ${hostPath}`, {
          stdout: '100000:100000:750',
        });

    await expect(step.apply(context(valid()))).resolves.toMatchObject({
      vmid,
      mp0: plan.mp0Value,
    });
    await expect(
      step.apply(context(valid(`${stampedConfig}\n[PENDING]`))),
    ).rejects.toThrow(/pending configuration/);
    await expect(
      step.apply(
        context(valid(stampedConfig.replace(plan.mp0Value, '/wrong,mp=/opt'))),
      ),
    ).rejects.toThrow(/does not expose the planned mp0/);

    const stopped = new FakeTransport()
      .onExec('pct config 112', { stdout: stampedConfig })
      .onExec('pct status 112', { stdout: 'status: stopped' })
      .onExec(`stat -c %u:%g:%a ${hostPath}`, {
        stdout: '100000:100000:750',
      });
    await expect(step.apply(context(stopped))).rejects.toThrow(
      /is not running after adoption/,
    );

    const missingStat = new FakeTransport()
      .onExec('pct config 112', { stdout: stampedConfig })
      .onExec('pct status 112', { stdout: 'status: running' })
      .onExec(`stat -c %u:%g:%a ${hostPath}`, { exitCode: 1 });
    await expect(step.apply(context(missingStat))).rejects.toThrow(
      /does not match the planned ownership/,
    );

    await expect(
      step.apply(
        context(
          valid(
            stampedConfig.replace(
              new RegExp(`description: [^]*`),
              'description: unstamped',
            ),
          ),
        ),
      ),
    ).rejects.toThrow(/is not stamped with/);

    await expect(
      step.verify(context(valid(`${stampedConfig}\n[PENDING]`))),
    ).rejects.toThrow(/changed its mp0 or pending state/);
  });

  it('treats timed-out identity checks as failures', async () => {
    const transport = new FakeTransport()
      .onExec('pct status 112', { stdout: 'status: running' })
      .onExec('pct exec 112 -- /bin/sh -s', { timedOut: true, exitCode: 0 });
    const step = createLxcIdentityCheckStep(lxc());
    await expect(step.apply(context(transport))).rejects.toThrow(
      /Identity check .* failed/,
    );
  });

  it('satisfies identity checks when none are configured', async () => {
    const step = createLxcIdentityCheckStep(
      lxc({ identity_checks: undefined }),
    );
    await expect(step.check(context(new FakeTransport()))).resolves.toEqual({
      status: 'satisfied',
      detail: { checks: 0 },
    });
  });

  it('includes a pre-adoption backup by default', () => {
    const steps = createCommunityScriptAdoptionSteps(lxc(), {
      hostId,
      timestamp: '2026-11-10T120000Z',
      rootfsMountPath,
    });
    expect(steps.some((step) => step.name.includes('back up LXC 112'))).toBe(
      true,
    );
  });
});

describe('adoption optional branches', () => {
  const plan = planLxcMigration(lxc(), options);
  const stamped = planLxcStamp(initialConfig, hostId, vmid, ['app']);
  const stampedConfig = [
    'hostname: example-lxc',
    `mp0: ${plan.mp0Value}`,
    `tags: ${stamped.tags.join(';')}`,
    `description: ${stamped.description}`,
  ].join('\n');

  it('returns no stamp argv when nothing meaningful changes', () => {
    expect(
      lxcStampArgv(
        'tags: app\ndescription: d',
        { tags: ['app'], description: 'd', changed: true },
        vmid,
      ),
    ).toBeUndefined();
  });

  it('adopts a guest without hostname or declared tags', async () => {
    const noHostname = new AdoptionTransport();
    noHostname.config = 'cores: 2';
    await expect(
      createScriptCreatedGuestStep(lxc(), { hostId }).check(
        context(noHostname),
      ),
    ).resolves.toMatchObject({
      status: 'satisfied',
      detail: { hostname: 'example-lxc' },
    });

    const noTags = createLxcStampStep(lxc({ tags: undefined }), { hostId });
    await expect(
      noTags.check(context(new AdoptionTransport())),
    ).resolves.toMatchObject({ status: 'required' });

    const already = new AdoptionTransport();
    already.config = stampedConfig;
    await expect(
      createLxcStampStep(lxc(), { hostId }).check(context(already)),
    ).resolves.toMatchObject({ status: 'satisfied' });
  });

  it('falls back to the exit code when the stamp error has no text', async () => {
    const transport = new AdoptionTransport();
    const exec = transport.exec.bind(transport);
    transport.exec = async (argv, execOptions) =>
      argv[1] === 'set'
        ? { exitCode: 1, stdout: '', stderr: '', timedOut: false }
        : exec(argv, execOptions);
    await expect(
      createLxcStampStep(lxc(), { hostId }).apply(context(transport)),
    ).rejects.toThrow(/Failed to stamp LXC 112: exit code 1/);
  });

  it('reports an unknown power state and skips optional checks', async () => {
    const unknown = new FakeTransport().onExec('pct status 112', {
      exitCode: 1,
    });
    await expect(
      createLxcIdentityCheckStep(lxc()).apply(context(unknown)),
    ).rejects.toThrow(/'unknown'/);

    const steps = createCommunityScriptAdoptionSteps(lxc(), {
      ...options,
      runIdentityChecks: false,
    });
    expect(
      steps.some((step) => step.name.startsWith('run identity checks')),
    ).toBe(false);
  });

  it('reports a failed rootfs inspection without stderr text', async () => {
    const step = createLxcRootfsEmptyStep(plan);
    const broken = new FakeTransport()
      .onExec(`test -e ${guestOptPath}`, {})
      .onExec(`find ${guestOptPath} -mindepth 1 -print -quit`, {
        exitCode: 1,
      });
    await expect(step.check(context(broken))).rejects.toThrow(/exit code 1/);
  });
});
