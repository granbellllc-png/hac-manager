import { describe, expect, it } from 'vitest';
import type { GuestDeployment } from '../schema/deployment.js';
import { MemoryStepJournal } from '../steps/memory-journal.js';
import { runJournaledSteps } from '../steps/runner.js';
import type { StepExecutionContext, StepLogger } from '../steps/types.js';
import { FakeTransport } from '../transport/fake.js';
import {
  createLxcMigrationSteps,
  DEFAULT_IDMAP_SIZE,
  lxcGuestRootfsPath,
  lxcHasPendingConfig,
  lxcMigrationAttachArgv,
  lxcMigrationBackupArgv,
  lxcMigrationDisplaceArgv,
  lxcMigrationMp0Value,
  lxcMigrationMountArgv,
  lxcMigrationRsyncArgv,
  lxcMigrationStartArgv,
  lxcMigrationStopArgv,
  lxcMigrationUnmountArgv,
  lxcMp0Matches,
  lxcRootfsMountPath,
  LxcMigrationError,
  lxcUidShiftArgv,
  lxcUidShiftScript,
  parseLxcPowerState,
  planLxcMigration,
  type LxcMigrationOptions,
} from './lxc-migrate.js';

type Lxc = Extract<GuestDeployment, { type: 'lxc' }>;

const hostPath = '/opt/server-data/pve-01/example-lxc/opt';
const rootfsMountPath = '/fixtures/lxc/112/rootfs';
const guestOptPath = `${rootfsMountPath}/opt`;
const displacedPath = `${guestOptPath}.migrated-2026-11-10T120000Z`;
const mp0Value = `${hostPath},backup=1,mp=/opt`;
const configPath = '/etc/pve/local/lxc/112.conf';

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
    ...overrides,
  };
}

function options(
  overrides: Partial<LxcMigrationOptions> = {},
): LxcMigrationOptions {
  return {
    hostId: 'pve-01',
    backup: true,
    timestamp: '2026-11-10T120000Z',
    rootfsMountPath,
    ...overrides,
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
    operationId: 'migrate-112',
    input: undefined,
    transport,
    logger: logger(),
    dryRun: false,
    signal: new AbortController().signal,
  };
}

/** Register responses in call order; FakeTransport prefers the newest rule. */
function sequence(
  transport: FakeTransport,
  matcher: string | RegExp,
  responses: readonly {
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
  }[],
): FakeTransport {
  for (let index = responses.length - 1; index >= 0; index--) {
    transport.onExec(matcher, responses[index]!, { once: true });
  }
  return transport;
}

const baseConfig = [
  'hostname: example-lxc',
  'cores: 2',
  'memory: 1024',
  'rootfs: local-lvm:vm-112-disk-0,size=10G',
].join('\n');

function configured(mp0 = mp0Value): string {
  return `${baseConfig}\nmp0: ${mp0}`;
}

function successfulTransport(): FakeTransport {
  const transport = new FakeTransport();
  sequence(transport, `stat -c %u:%g:%a ${hostPath}`, [
    { exitCode: 1 },
    { stdout: '100000:100000:750' },
    { stdout: '0:0:755' },
    { stdout: '100000:100000:750' },
    { stdout: '100000:100000:750' },
    { stdout: '100000:100000:750' },
  ]);
  transport.onExec(/^install -d /, { stdout: '' });
  sequence(transport, `test -f ${configPath}`, [{}, {}]);
  transport.onExec('vzdump 112 --mode snapshot --compress zstd', {
    stdout: 'creating vzdump archive',
  });
  sequence(transport, 'pct status 112', [
    { stdout: 'status: running' },
    { stdout: 'status: running' },
    { stdout: 'status: stopped' },
    { stdout: 'status: stopped' },
    { stdout: 'status: stopped' },
    { stdout: 'status: stopped' },
    { stdout: 'status: stopped' },
    { stdout: 'status: running' },
    { stdout: 'status: running' },
  ]);
  transport.onExec('pct shutdown 112 --timeout 120', { stdout: 'stopped' });
  sequence(transport, `mountpoint -q ${rootfsMountPath}`, [
    { exitCode: 1 },
    { exitCode: 1 },
    {},
    {},
    {},
    { exitCode: 1 },
  ]);
  transport.onExec('pct mount 112', { stdout: 'mounted' });
  sequence(transport, `test -e ${guestOptPath}`, [
    {},
    {},
    {},
    {},
    { exitCode: 1 },
  ]);
  sequence(transport, `test -e ${displacedPath}`, [
    { exitCode: 1 },
    { exitCode: 1 },
    { exitCode: 1 },
    { exitCode: 1 },
    {},
  ]);
  transport.onExec(`rsync -aAXH --numeric-ids ${guestOptPath}/ ${hostPath}/`, {
    stdout: '',
  });
  transport.onExec(`test -e ${hostPath}`, {});
  transport.onExec(
    `bash -s -- ${hostPath} 100000 100000 65536 100000 100000 0750 0`,
    {
      stdout: '',
    },
  );
  transport.onExec(`mv ${guestOptPath} ${displacedPath}`, { stdout: '' });
  transport.onExec('pct unmount 112', { stdout: 'unmounted' });
  sequence(transport, 'pct config 112', [
    { stdout: baseConfig },
    { stdout: baseConfig },
    { stdout: configured() },
    { stdout: configured() },
  ]);
  transport.onExec(`pct set 112 --mp0 ${mp0Value}`, { stdout: '' });
  transport.onExec('pct start 112', { stdout: 'started' });
  return transport;
}

describe('LXC migration planning (D-45)', () => {
  it('plans a non-destructive migration with a displaced copy', () => {
    const plan = planLxcMigration(lxc(), options());
    expect(plan).toMatchObject({
      vmid: 112,
      hostId: 'pve-01',
      guestPath: '/opt',
      hostPath,
      rootfsMountPath,
      guestOptPath,
      displacedPath,
      uid: 100_000,
      gid: 100_000,
      mode: '0750',
      mp0Value,
      backup: true,
      readOnly: false,
      destructive: false,
      blocked: false,
    });
    expect(plan.idmap).toEqual({
      uidBase: 100_000,
      gidBase: 100_000,
      size: DEFAULT_IDMAP_SIZE,
    });
    expect(plan.changes.map((change) => change.id)).toEqual([
      'backup',
      'stop',
      'mount',
      'copy',
      'uid-shift',
      'displace',
      'unmount',
      'mp0',
      'start',
    ]);
    expect(plan.warnings.join('\n')).toContain('never deleted automatically');
    expect(plan.commands).toEqual(
      expect.arrayContaining([
        lxcMigrationBackupArgv(112, options()),
        lxcMigrationStopArgv(112),
        lxcMigrationMountArgv(112),
        lxcMigrationRsyncArgv({ guestOptPath, hostPath }),
        lxcMigrationDisplaceArgv({ guestOptPath, displacedPath }),
        lxcMigrationUnmountArgv(112),
        lxcMigrationAttachArgv(112, mp0Value),
        lxcMigrationStartArgv(112),
      ]),
    );
  });

  it('derives the default host path when mp0 is missing and warns', () => {
    const plan = planLxcMigration(lxc({ mounts: undefined }), options());
    expect(plan.hostPath).toBe('/opt/server-data/pve-01/example-lxc/opt');
    expect(plan.mp0Value).toBe(`${plan.hostPath},backup=1,mp=/opt`);
    expect(plan.warnings.join('\n')).toContain('No mp0 is declared');
  });

  it('honours declared mp0 options, storage and read-only flags', () => {
    const plan = planLxcMigration(
      lxc({
        mounts: [
          {
            index: 0,
            host_path: '/srv/example',
            guest_path: '/srv',
            backup: false,
            readonly: true,
            permissions: 'world_writable',
            owner: { uid: 1000, gid: 2000 },
          },
        ],
      }),
      options({
        backup: false,
        backupStorage: 'backup-store',
        guestPath: '/srv',
      }),
    );
    expect(plan.hostPath).toBe('/srv/example');
    expect(plan.guestPath).toBe('/srv');
    expect(plan.mp0Value).toBe('/srv/example,mp=/srv,ro=1');
    expect(plan.uid).toBe(101_000);
    expect(plan.gid).toBe(102_000);
    expect(plan.mode).toBe('2777');
    expect(plan.hostDirectory.defaultAcl).toBe(true);
    expect(lxcUidShiftArgv(plan).at(-1)).toBe('1');
    expect(plan.changes.map((change) => change.id)).not.toContain('backup');
    expect(plan.commands[0]).toEqual(lxcMigrationStopArgv(112));
    expect(plan.warnings.join('\n')).toContain('No backup is taken');
    expect(
      lxcMigrationBackupArgv(112, options({ backupStorage: 'backup-store' })),
    ).toEqual([
      'vzdump',
      '112',
      '--mode',
      'snapshot',
      '--compress',
      'zstd',
      '--storage',
      'backup-store',
    ]);
  });

  it('rejects VMs and unsafe paths', () => {
    const vm: GuestDeployment = {
      id: 300,
      name: 'example-vm',
      type: 'vm',
      cpu: 1,
      ram: 512,
      disks: [],
      network: [],
    };
    expect(() => planLxcMigration(vm, options())).toThrow(
      'only applies to LXC containers',
    );
    expect(() =>
      planLxcMigration(
        lxc({
          mounts: [
            {
              index: 0,
              host_path: `${rootfsMountPath}/opt`,
              guest_path: '/opt',
              permissions: 'minimal',
            },
          ],
        }),
        options(),
      ),
    ).toThrow('overlaps the mounted rootfs');
    expect(() =>
      planLxcMigration(
        lxc({
          mounts: [
            {
              index: 0,
              host_path: rootfsMountPath,
              guest_path: '/opt',
              permissions: 'minimal',
            },
          ],
        }),
        options(),
      ),
    ).toThrow('overlaps the mounted rootfs');
    expect(() =>
      planLxcMigration(
        lxc({
          mounts: [
            {
              index: 0,
              host_path: '/fixtures/lxc',
              guest_path: '/opt',
              permissions: 'minimal',
            },
          ],
        }),
        options(),
      ),
    ).toThrow('overlaps the mounted rootfs');
    expect(() => planLxcMigration(lxc(), options({ guestPath: '/' }))).toThrow(
      'must be an absolute path below the filesystem root',
    );
    expect(() =>
      planLxcMigration(lxc(), options({ guestPath: '/opt/../etc' })),
    ).toThrow("must not contain empty, '.' or '..' segments");
    expect(() =>
      planLxcMigration(
        lxc({
          mounts: [
            {
              index: 0,
              host_path: '/etc/example',
              guest_path: '/opt',
              permissions: 'minimal',
            },
          ],
        }),
        options(),
      ),
    ).toThrow('is a host system path');
    expect(() =>
      planLxcMigration(lxc(), options({ rootfsMountPath: '/fixtures/../lxc' })),
    ).toThrow('must be a normalized absolute path');
    expect(() =>
      planLxcMigration(lxc(), options({ timestamp: '../escape' })),
    ).toThrow('cannot be used in a migration path');
  });

  it('rejects idmaps that cannot be shifted idempotently', () => {
    expect(() =>
      planLxcMigration(
        lxc({ idmap: { uid_base: 1000, size: 65_536 } }),
        options(),
      ),
    ).toThrow('uid_base 1000 overlaps the idmap size');
    expect(() =>
      planLxcMigration(
        lxc({ idmap: { gid_base: 1000, size: 65_536 } }),
        options(),
      ),
    ).toThrow('gid_base 1000 overlaps the idmap size');
    expect(() =>
      planLxcMigration(
        lxc({ idmap: { uid_base: 4_294_967_000, size: 65_536 } }),
        options(),
      ),
    ).toThrow('exceeds the UID range');
    expect(() =>
      planLxcMigration(
        lxc({ idmap: { gid_base: 4_294_967_000, size: 65_536 } }),
        options(),
      ),
    ).toThrow('exceeds the GID range');
  });

  it('keeps a privileged guest on unshifted ids without a copy step change', () => {
    const plan = planLxcMigration(
      lxc({ unprivileged: false }),
      options({ timestamp: 'custom-1' }),
    );
    expect(plan.idmap).toEqual({ uidBase: 0, gidBase: 0, size: 65_536 });
    expect(plan.uid).toBe(0);
    expect(plan.displacedPath).toBe(`${guestOptPath}.migrated-custom-1`);
  });
});

describe('migration command builders', () => {
  it('builds the mount, unmount, start and attach commands', () => {
    expect(lxcRootfsMountPath(112)).toBe('/var/lib/lxc/112/rootfs');
    expect(lxcGuestRootfsPath(rootfsMountPath, '/opt')).toBe(guestOptPath);
    expect(lxcMigrationMp0Value(hostPath, '/opt', true, false)).toBe(mp0Value);
    expect(lxcMigrationMp0Value(hostPath, '/opt', false, true)).toBe(
      `${hostPath},mp=/opt,ro=1`,
    );
    expect(lxcMigrationMountArgv(112)).toEqual(['pct', 'mount', '112']);
    expect(lxcMigrationUnmountArgv(112)).toEqual(['pct', 'unmount', '112']);
    expect(lxcMigrationStartArgv(112)).toEqual(['pct', 'start', '112']);
    expect(lxcMigrationAttachArgv(112, mp0Value)).toEqual([
      'pct',
      'set',
      '112',
      '--mp0',
      mp0Value,
    ]);
    expect(lxcMigrationStopArgv(112)).toEqual([
      'pct',
      'shutdown',
      '112',
      '--timeout',
      '120',
    ]);
  });

  it('builds an rsync copy without delete semantics', () => {
    const argv = lxcMigrationRsyncArgv({ guestOptPath, hostPath });
    expect(argv).toEqual([
      'rsync',
      '-aAXH',
      '--numeric-ids',
      `${guestOptPath}/`,
      `${hostPath}/`,
    ]);
    expect(argv.join(' ')).not.toContain('--delete');
  });

  it('builds the stdin UID-shift script and argv', () => {
    const plan = planLxcMigration(lxc(), options());
    expect(lxcUidShiftArgv(plan)).toEqual([
      'bash',
      '-s',
      '--',
      hostPath,
      '100000',
      '100000',
      '65536',
      '100000',
      '100000',
      '0750',
      '0',
    ]);
    const script = lxcUidShiftScript();
    expect(script).toContain('find "$root" -uid "$uid"');
    expect(script).toContain('chown -h "$root_uid:$root_gid" "$root"');
    expect(script).toContain('chmod "$root_mode" "$root"');
    expect(script).toContain('setfacl -d -m u::rwx,g::rwx,o::rwx');
    expect(script).not.toContain('rm ');
  });

  it('parses power states and pending configs', () => {
    expect(parseLxcPowerState('status: running\n')).toBe('running');
    expect(parseLxcPowerState('status: stopped')).toBe('stopped');
    expect(parseLxcPowerState('status: migrating')).toBeUndefined();
    expect(lxcHasPendingConfig('[PENDING]\ncores: 4')).toBe(true);
    expect(lxcHasPendingConfig(baseConfig)).toBe(false);
  });

  it('compares mp0 values by option maps, not text order', () => {
    expect(lxcMp0Matches(baseConfig, mp0Value)).toBe(false);
    expect(
      lxcMp0Matches(
        `${baseConfig}\nmp0: ${hostPath},backup=1,mp=/opt`,
        mp0Value,
      ),
    ).toBe(true);
    expect(
      lxcMp0Matches(`${baseConfig}\nmp0: /other,backup=1,mp=/opt`, mp0Value),
    ).toBe(false);
    expect(
      lxcMp0Matches(`${baseConfig}\nmp0: ${hostPath},mp=/srv`, mp0Value),
    ).toBe(false);
  });
});

describe('journaled rootfs migration', () => {
  it('runs every step in order and leaves the displaced copy in place', async () => {
    const transport = successfulTransport();
    const result = await runJournaledSteps({
      operationId: 'migrate-112',
      input: undefined,
      transport,
      logger: logger(),
      dryRun: false,
      signal: new AbortController().signal,
      journal: new MemoryStepJournal(),
      steps: createLxcMigrationSteps(lxc(), options()),
    });

    expect(result.entries).toHaveLength(11);
    expect(result.entries.map((entry) => entry.status)).toEqual(
      Array.from({ length: 11 }, () => 'completed'),
    );
    const argv = transport.execArgv;
    expect(argv).toContainEqual(
      lxcMigrationBackupArgv(112, options()) as string[],
    );
    expect(argv).toContainEqual(['pct', 'shutdown', '112', '--timeout', '120']);
    expect(argv).toContainEqual(['pct', 'mount', '112']);
    expect(argv).toContainEqual([
      'rsync',
      '-aAXH',
      '--numeric-ids',
      `${guestOptPath}/`,
      `${hostPath}/`,
    ]);
    expect(argv).toContainEqual(['mv', guestOptPath, displacedPath]);
    expect(argv).toContainEqual(['pct', 'unmount', '112']);
    expect(argv).toContainEqual(['pct', 'set', '112', '--mp0', mp0Value]);
    expect(argv).toContainEqual(['pct', 'start', '112']);

    const rsyncIndex = argv.findIndex((call) => call[0] === 'rsync');
    const shiftIndex = argv.findIndex((call) => call[0] === 'bash');
    const displaceIndex = argv.findIndex((call) => call[0] === 'mv');
    const attachIndex = argv.findIndex(
      (call) => call[0] === 'pct' && call[1] === 'set',
    );
    expect(rsyncIndex).toBeGreaterThan(-1);
    expect(shiftIndex).toBeGreaterThan(rsyncIndex);
    expect(displaceIndex).toBeGreaterThan(shiftIndex);
    expect(attachIndex).toBeGreaterThan(displaceIndex);
    expect(
      argv.some((call) => call[0] === 'rm' || call.includes('--delete')),
    ).toBe(false);

    const bashCall = transport.calls.find(
      (call) => call.kind === 'exec' && call.argv[0] === 'bash',
    );
    expect(bashCall).toMatchObject({
      kind: 'exec',
      options: { stdin: expect.stringContaining('set -eu') },
    });
  });

  it('skips the backup step when backups are disabled', async () => {
    const transport = new FakeTransport();
    // Stop, mount, copy, shift, displace, unmount, attach, start, verify.
    sequence(transport, `stat -c %u:%g:%a ${hostPath}`, [
      { exitCode: 1 },
      { stdout: '100000:100000:750' },
      { stdout: '0:0:755' },
      { stdout: '100000:100000:750' },
      { stdout: '100000:100000:750' },
      { stdout: '100000:100000:750' },
    ]);
    transport.onExec(/^install -d /, { stdout: '' });
    sequence(transport, 'pct status 112', [
      { stdout: 'status: stopped' },
      { stdout: 'status: stopped' },
      { stdout: 'status: stopped' },
      { stdout: 'status: stopped' },
      { stdout: 'status: stopped' },
      { stdout: 'status: running' },
      { stdout: 'status: running' },
    ]);
    sequence(transport, 'pct config 112', [
      { stdout: baseConfig },
      { stdout: baseConfig },
      { stdout: configured() },
      { stdout: configured() },
    ]);
    sequence(transport, `mountpoint -q ${rootfsMountPath}`, [
      { exitCode: 1 },
      {},
      {},
      { exitCode: 1 },
    ]);
    transport.onExec('pct mount 112', {});
    sequence(transport, `test -e ${guestOptPath}`, [{}, {}, { exitCode: 1 }]);
    sequence(transport, `test -e ${displacedPath}`, [
      { exitCode: 1 },
      { exitCode: 1 },
      {},
    ]);
    transport.onExec(
      `rsync -aAXH --numeric-ids ${guestOptPath}/ ${hostPath}/`,
      {},
    );
    transport.onExec(`test -e ${hostPath}`, {});
    transport.onExec(
      `bash -s -- ${hostPath} 100000 100000 65536 100000 100000 0750 0`,
      {},
    );
    transport.onExec(`mv ${guestOptPath} ${displacedPath}`, {});
    transport.onExec('pct unmount 112', {});
    transport.onExec(`pct set 112 --mp0 ${mp0Value}`, {});
    transport.onExec('pct start 112', {});

    const steps = createLxcMigrationSteps(lxc(), options({ backup: false }));
    expect(steps).toHaveLength(10);
    const result = await runJournaledSteps({
      operationId: 'migrate-112-no-backup',
      input: undefined,
      transport,
      logger: logger(),
      dryRun: false,
      signal: new AbortController().signal,
      journal: new MemoryStepJournal(),
      steps,
    });
    expect(result.entries.map((entry) => entry.status)).toEqual(
      Array.from({ length: 10 }, () => 'completed'),
    );
    expect(transport.execArgv.some((call) => call[0] === 'vzdump')).toBe(false);
  });

  it('satisfies the copy step when the rootfs data was already displaced', async () => {
    const steps = createLxcMigrationSteps(lxc(), options());
    const step = steps[4]!;
    const transport = new FakeTransport()
      .onExec(`test -e ${guestOptPath}`, { exitCode: 1 })
      .onExec(`test -e ${displacedPath}`, {});
    await expect(step.check(context(transport))).resolves.toMatchObject({
      status: 'satisfied',
    });
    await expect(step.apply(context(transport))).resolves.toEqual({
      changed: false,
    });
  });

  it('keeps the configured shutdown timeout in the stop argv', () => {
    expect(lxcMigrationStopArgv(112)).toContain('120');
  });
});

describe('migration failure handling', () => {
  const steps = () => createLxcMigrationSteps(lxc(), options());
  const noBackupSteps = () =>
    createLxcMigrationSteps(lxc(), options({ backup: false }));

  it('fails the backup step before touching data', async () => {
    const backupStep = steps()[1]!;
    await expect(
      backupStep.check(
        context(
          new FakeTransport().onExec(`test -f ${configPath}`, {
            exitCode: 1,
          }),
        ),
      ),
    ).rejects.toThrow('does not exist');
    await expect(
      backupStep.apply(
        context(
          new FakeTransport().onExec(
            'vzdump 112 --mode snapshot --compress zstd',
            { exitCode: 1, stderr: 'no space' },
          ),
        ),
      ),
    ).rejects.toThrow('nothing was migrated: no space');
    await expect(
      backupStep.apply(
        context(
          new FakeTransport().onExec(
            'vzdump 112 --mode snapshot --compress zstd',
            { exitCode: 1 },
          ),
        ),
      ),
    ).rejects.toThrow('exit code 1');
    await expect(
      backupStep.verify(
        context(
          new FakeTransport().onExec(`test -f ${configPath}`, {
            exitCode: 1,
          }),
        ),
      ),
    ).rejects.toThrow('disappeared');
  });

  it('refuses to migrate when the power state is unknown', async () => {
    const stopStep = steps()[2]!;
    await expect(
      stopStep.check(
        context(
          new FakeTransport().onExec('pct status 112', {
            exitCode: 1,
            stderr: 'unavailable',
          }),
        ),
      ),
    ).rejects.toThrow('power state could not be determined');
    await expect(
      stopStep.apply(
        context(
          new FakeTransport().onExec('pct status 112', {
            stdout: 'status: migrating',
          }),
        ),
      ),
    ).rejects.toThrow('power state could not be determined');
    await expect(
      stopStep.apply(
        context(
          new FakeTransport()
            .onExec('pct status 112', { stdout: 'status: running' })
            .onExec('pct shutdown 112 --timeout 120', {
              exitCode: 1,
              stderr: 'refused',
            }),
        ),
      ),
    ).rejects.toThrow('Failed to stop LXC 112');
    await expect(
      stopStep.verify(
        context(
          new FakeTransport().onExec('pct status 112', {
            stdout: 'status: running',
          }),
        ),
      ),
    ).rejects.toThrow("is 'running' after shutdown");
  });

  it('fails mount and unmount commands loudly', async () => {
    const mountStep = steps()[3]!;
    await expect(
      mountStep.apply(
        context(
          new FakeTransport()
            .onExec(`mountpoint -q ${rootfsMountPath}`, { exitCode: 1 })
            .onExec('pct mount 112', { exitCode: 1, stderr: 'busy' }),
        ),
      ),
    ).rejects.toThrow('busy');
    await expect(
      mountStep.verify(
        context(
          new FakeTransport().onExec(`mountpoint -q ${rootfsMountPath}`, {
            exitCode: 1,
          }),
        ),
      ),
    ).rejects.toThrow('is not mounted');

    const unmountStep = steps()[7]!;
    await expect(
      unmountStep.apply(
        context(
          new FakeTransport()
            .onExec(`mountpoint -q ${rootfsMountPath}`, {})
            .onExec('pct unmount 112', { exitCode: 1 }),
        ),
      ),
    ).rejects.toThrow('exit code 1');
    await expect(
      unmountStep.verify(
        context(
          new FakeTransport().onExec(`mountpoint -q ${rootfsMountPath}`, {}),
        ),
      ),
    ).rejects.toThrow('is still mounted');
  });

  it('reports copy failures without displacing anything', async () => {
    const copyStep = steps()[4]!;
    await expect(
      copyStep.check(
        context(
          new FakeTransport()
            .onExec(`test -e ${guestOptPath}`, { exitCode: 1 })
            .onExec(`test -e ${displacedPath}`, { exitCode: 1 }),
        ),
      ),
    ).rejects.toThrow('are both missing');
    await expect(
      copyStep.apply(
        context(
          new FakeTransport()
            .onExec(`test -e ${guestOptPath}`, { exitCode: 1 })
            .onExec(`test -e ${displacedPath}`, { exitCode: 1 }),
        ),
      ),
    ).rejects.toThrow('disappeared before the copy');
    await expect(
      copyStep.apply(
        context(
          new FakeTransport()
            .onExec(`test -e ${guestOptPath}`, {})
            .onExec(`test -e ${displacedPath}`, { exitCode: 1 })
            .onExec(`rsync -aAXH --numeric-ids ${guestOptPath}/ ${hostPath}/`, {
              exitCode: 1,
              stderr: 'disk full',
            }),
        ),
      ),
    ).rejects.toThrow('disk full');
    await expect(
      copyStep.verify(
        context(
          new FakeTransport().onExec(`test -e ${hostPath}`, {
            exitCode: 1,
          }),
        ),
      ),
    ).rejects.toThrow('is missing after the rsync copy');
  });

  it('reports shift failures and unmapped ownership', async () => {
    const shiftStep = steps()[5]!;
    await expect(
      shiftStep.apply(
        context(
          new FakeTransport().onExec(
            `bash -s -- ${hostPath} 100000 100000 65536 100000 100000 0750 0`,
            { exitCode: 1, stderr: 'chown denied' },
          ),
        ),
      ),
    ).rejects.toThrow('chown denied');
    await expect(
      shiftStep.verify(
        context(
          new FakeTransport().onExec(`stat -c %u:%g:%a ${hostPath}`, {
            stdout: '0:0:755',
          }),
        ),
      ),
    ).rejects.toThrow('does not have the planned ownership');
    await expect(
      shiftStep.verify(
        context(
          new FakeTransport().onExec(`stat -c %u:%g:%a ${hostPath}`, {
            stdout: '100000:100000:750',
          }),
        ),
      ),
    ).resolves.toMatchObject({ stat: { uid: 100_000 } });
    await expect(
      shiftStep.verify(
        context(
          new FakeTransport().onExec(`stat -c %u:%g:%a ${hostPath}`, {
            exitCode: 1,
          }),
        ),
      ),
    ).rejects.toThrow('does not have the planned ownership');
    await expect(
      shiftStep.check(
        context(
          new FakeTransport().onExec(`stat -c %u:%g:%a ${hostPath}`, {
            exitCode: 1,
          }),
        ),
      ),
    ).resolves.toEqual({ status: 'required' });
  });

  it('never overwrites an existing displaced copy', async () => {
    const displaceStep = steps()[6]!;
    await expect(
      displaceStep.check(
        context(
          new FakeTransport()
            .onExec(`test -e ${guestOptPath}`, {})
            .onExec(`test -e ${displacedPath}`, {}),
        ),
      ),
    ).rejects.toThrow('Refusing to overwrite');
    await expect(
      displaceStep.check(
        context(
          new FakeTransport()
            .onExec(`test -e ${guestOptPath}`, { exitCode: 1 })
            .onExec(`test -e ${displacedPath}`, { exitCode: 1 }),
        ),
      ),
    ).rejects.toThrow('unknown state');
    await expect(
      displaceStep.apply(
        context(
          new FakeTransport()
            .onExec(`test -e ${guestOptPath}`, { exitCode: 1 })
            .onExec(`test -e ${displacedPath}`, { exitCode: 1 }),
        ),
      ),
    ).rejects.toThrow('disappeared before it could be displaced');
    await expect(
      displaceStep.apply(
        context(
          new FakeTransport()
            .onExec(`test -e ${guestOptPath}`, {})
            .onExec(`test -e ${displacedPath}`, {}),
        ),
      ),
    ).rejects.toThrow('Refusing to overwrite');
    await expect(
      displaceStep.apply(
        context(
          new FakeTransport()
            .onExec(`test -e ${guestOptPath}`, {})
            .onExec(`test -e ${displacedPath}`, { exitCode: 1 })
            .onExec(`mv ${guestOptPath} ${displacedPath}`, {
              exitCode: 1,
              stderr: 'cross-device',
            }),
        ),
      ),
    ).rejects.toThrow('cross-device');
    await expect(
      displaceStep.verify(
        context(
          new FakeTransport()
            .onExec(`test -e ${guestOptPath}`, {})
            .onExec(`test -e ${displacedPath}`, {}),
        ),
      ),
    ).rejects.toThrow('was not displaced correctly');
  });

  it('refuses a hot mp0 attach and explains failures', async () => {
    const attachStep = steps()[8]!;
    await expect(
      attachStep.check(
        context(
          new FakeTransport()
            .onExec('pct config 112', { stdout: baseConfig })
            .onExec('pct status 112', { stdout: 'status: running' }),
        ),
      ),
    ).rejects.toThrow('Refusing to attach mp0');
    await expect(
      attachStep.apply(
        context(
          new FakeTransport()
            .onExec('pct config 112', { stdout: baseConfig })
            .onExec('pct status 112', { stdout: 'status: stopped' })
            .onExec(`pct set 112 --mp0 ${mp0Value}`, {
              exitCode: 1,
              stderr: 'invalid mp0',
            }),
        ),
      ),
    ).rejects.toThrow('invalid mp0');
    await expect(
      attachStep.verify(
        context(
          new FakeTransport().onExec('pct config 112', {
            stdout: '[PENDING]\nmp0: x',
          }),
        ),
      ),
    ).rejects.toThrow('[PENDING] must be empty');
    await expect(
      attachStep.verify(
        context(
          new FakeTransport().onExec('pct config 112', {
            stdout: baseConfig,
          }),
        ),
      ),
    ).rejects.toThrow('does not have the planned mp0');
  });

  it('fails start when the state is unknown or the guest does not run', async () => {
    const startStep = steps()[9]!;
    await expect(
      startStep.check(
        context(
          new FakeTransport().onExec('pct status 112', {
            exitCode: 1,
          }),
        ),
      ),
    ).rejects.toThrow('power state could not be determined');
    await expect(
      startStep.apply(
        context(
          new FakeTransport()
            .onExec('pct status 112', { stdout: 'status: stopped' })
            .onExec('pct start 112', { exitCode: 1, stderr: 'boot failed' }),
        ),
      ),
    ).rejects.toThrow('boot failed');
    await expect(
      startStep.verify(
        context(
          new FakeTransport().onExec('pct status 112', {
            stdout: 'status: stopped',
          }),
        ),
      ),
    ).rejects.toThrow("is 'stopped' after starting");
  });

  it('rolls the final verification failures into one journaled step', async () => {
    const verifyStep = steps()[10]!;
    const finalTransport = (config: string, status: string, stat: string) =>
      new FakeTransport()
        .onExec('pct config 112', { stdout: config })
        .onExec('pct status 112', { stdout: status })
        .onExec(`stat -c %u:%g:%a ${hostPath}`, { stdout: stat });

    await expect(
      verifyStep.apply(
        context(
          finalTransport(configured(), 'status: running', '100000:100000:750'),
        ),
      ),
    ).resolves.toMatchObject({ mp0: mp0Value });
    await expect(
      verifyStep.apply(
        context(
          finalTransport(
            '[PENDING]\nmp0: x',
            'status: running',
            '100000:100000:750',
          ),
        ),
      ),
    ).rejects.toThrow('[PENDING] must be empty');
    await expect(
      verifyStep.apply(
        context(
          finalTransport(baseConfig, 'status: running', '100000:100000:750'),
        ),
      ),
    ).rejects.toThrow('does not expose the planned mp0');
    await expect(
      verifyStep.apply(
        context(
          finalTransport(configured(), 'status: stopped', '100000:100000:750'),
        ),
      ),
    ).rejects.toThrow('is not running after migration');
    await expect(
      verifyStep.apply(
        context(finalTransport(configured(), 'status: running', '0:0:755')),
      ),
    ).rejects.toThrow('does not match the planned ownership');
    await expect(
      verifyStep.verify(
        context(
          new FakeTransport().onExec(`stat -c %u:%g:%a ${hostPath}`, {
            stdout: '0:0:755',
          }),
        ),
      ),
    ).rejects.toThrow('changed during migration verification');
  });

  it('is a no-op for a stopped guest and already-attached mp0', async () => {
    const stopStep = noBackupSteps()[1]!;
    await expect(
      stopStep.apply(
        context(
          new FakeTransport().onExec('pct status 112', {
            stdout: 'status: stopped',
          }),
        ),
      ),
    ).resolves.toEqual({ changed: false });

    const mountStep = noBackupSteps()[2]!;
    await expect(
      mountStep.apply(
        context(
          new FakeTransport().onExec(`mountpoint -q ${rootfsMountPath}`, {}),
        ),
      ),
    ).resolves.toEqual({ changed: false });

    const attachStep = noBackupSteps()[7]!;
    await expect(
      attachStep.check(
        context(
          new FakeTransport().onExec('pct config 112', {
            stdout: configured(),
          }),
        ),
      ),
    ).resolves.toMatchObject({ status: 'satisfied' });
    await expect(
      attachStep.apply(
        context(
          new FakeTransport().onExec('pct config 112', {
            stdout: configured(),
          }),
        ),
      ),
    ).resolves.toEqual({ changed: false });

    const startStep = noBackupSteps()[8]!;
    await expect(
      startStep.apply(
        context(
          new FakeTransport().onExec('pct status 112', {
            stdout: 'status: running',
          }),
        ),
      ),
    ).resolves.toEqual({ changed: false });
  });

  it('includes a descriptive error name for callers', () => {
    expect(new LxcMigrationError('x')).toBeInstanceOf(Error);
    expect(new LxcMigrationError('x').name).toBe('LxcMigrationError');
  });
});
