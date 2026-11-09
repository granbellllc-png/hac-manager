import { describe, expect, it } from 'vitest';
import type { GuestDeployment } from '../schema/deployment.js';
import type { StepExecutionContext, StepLogger } from '../steps/types.js';
import { FakeTransport } from '../transport/fake.js';
import {
  createHostDirectorySteps,
  DEFAULT_UNPRIVILEGED_UID_BASE,
  defaultHostDataPath,
  HOST_DIRECTORY_MINIMAL_MODE,
  HOST_DIRECTORY_WORLD_WRITABLE_MODE,
  hostDirectoryAclArgv,
  hostDirectoryInstallArgv,
  hostDirectoryMatches,
  hostDirectorySetupArgv,
  hostDirectoryStatArgv,
  parseHostDirectoryStat,
  planHostDirectories,
  planHostDirectory,
  readHostDirectory,
  resolveGuestIdMap,
  type GuestIdMap,
  type HostDirectoryPlan,
} from './host-dirs.js';

type Lxc = Extract<GuestDeployment, { type: 'lxc' }>;
type Mount = NonNullable<Lxc['mounts']>[number];

function mount(overrides: Partial<Mount> = {}): Mount {
  return {
    index: 0,
    host_path: '/opt/server-data/pve-01/example-lxc/opt',
    guest_path: '/opt',
    backup: true,
    permissions: 'minimal',
    ...overrides,
  };
}

function lxc(overrides: Partial<Lxc> = {}): Lxc {
  return {
    id: 112,
    name: 'example-lxc',
    type: 'lxc',
    cpu: 1,
    ram: 512,
    disks: [],
    network: [],
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
    operationId: 'host-dir-test',
    input: undefined,
    transport,
    logger: logger(),
    dryRun: false,
    signal: new AbortController().signal,
  };
}

const statCommand = hostDirectoryStatArgv(
  '/opt/server-data/pve-01/example-lxc/opt',
).join(' ');

describe('host data path convention (D-43)', () => {
  it('builds /opt/server-data/<host>/<guest>/<guest path>', () => {
    expect(defaultHostDataPath('pve-01', 'example-lxc')).toBe(
      '/opt/server-data/pve-01/example-lxc/opt',
    );
    expect(defaultHostDataPath('pve-01', 'example-lxc', '/srv/app/data')).toBe(
      '/opt/server-data/pve-01/example-lxc/srv/app/data',
    );
    expect(defaultHostDataPath('pve-01', 'example-lxc', 'opt', '/data')).toBe(
      '/data/pve-01/example-lxc/opt',
    );
  });

  it('rejects path segments that could escape the data root', () => {
    expect(() => defaultHostDataPath('../etc', 'guest')).toThrow('hostId');
    expect(() => defaultHostDataPath('pve-01', 'bad name')).toThrow(
      'guestName',
    );
    expect(() => defaultHostDataPath('pve-01', 'guest', '/')).toThrow(
      'filesystem root',
    );
    expect(() => defaultHostDataPath('pve-01', 'guest', '/opt/../etc')).toThrow(
      'guestPath segment',
    );
  });
});

describe('guest idmap resolution', () => {
  it('defaults unprivileged guests to 100000 and privileged guests to 0', () => {
    expect(resolveGuestIdMap(lxc({ unprivileged: true }))).toEqual({
      uidBase: DEFAULT_UNPRIVILEGED_UID_BASE,
      gidBase: DEFAULT_UNPRIVILEGED_UID_BASE,
    });
    expect(resolveGuestIdMap(lxc({ unprivileged: false }))).toEqual({
      uidBase: 0,
      gidBase: 0,
    });
    expect(resolveGuestIdMap(lxc())).toEqual({ uidBase: 0, gidBase: 0 });
  });

  it('lets an explicit idmap override the defaults, including size', () => {
    expect(
      resolveGuestIdMap(
        lxc({
          unprivileged: true,
          idmap: { uid_base: 200_000, gid_base: 300_000, size: 65_536 },
        }),
      ),
    ).toEqual({ uidBase: 200_000, gidBase: 300_000, size: 65_536 });
    expect(
      resolveGuestIdMap(lxc({ unprivileged: true, idmap: { size: 65_536 } })),
    ).toEqual({
      uidBase: DEFAULT_UNPRIVILEGED_UID_BASE,
      gidBase: DEFAULT_UNPRIVILEGED_UID_BASE,
      size: 65_536,
    });
  });

  it('returns the privileged identity for VMs', () => {
    const vm: GuestDeployment = {
      id: 300,
      name: 'example-vm',
      type: 'vm',
      cpu: 1,
      ram: 512,
      disks: [],
      network: [],
    };
    expect(resolveGuestIdMap(vm)).toEqual({ uidBase: 0, gidBase: 0 });
    expect(planHostDirectories(vm)).toEqual([]);
  });
});

describe('host directory planning', () => {
  it('shifts mount owners by the idmap', () => {
    const unprivileged: GuestIdMap = {
      uidBase: DEFAULT_UNPRIVILEGED_UID_BASE,
      gidBase: DEFAULT_UNPRIVILEGED_UID_BASE,
    };
    expect(planHostDirectory(mount(), unprivileged)).toMatchObject({
      uid: 100_000,
      gid: 100_000,
      mode: HOST_DIRECTORY_MINIMAL_MODE,
      defaultAcl: false,
    });
    expect(
      planHostDirectory(
        mount({ owner: { uid: 1000, gid: 1000 } }),
        unprivileged,
      ),
    ).toMatchObject({ uid: 101_000, gid: 101_000 });
    expect(
      planHostDirectory(mount({ owner: { uid: 33, gid: 33 } }), {
        uidBase: 0,
        gidBase: 0,
      }),
    ).toMatchObject({ uid: 33, gid: 33 });
  });

  it('supports a per-mount owner with different uid and gid bases', () => {
    const plan = planHostDirectory(mount({ owner: { uid: 100, gid: 200 } }), {
      uidBase: 10_000,
      gidBase: 20_000,
      size: 65_536,
    });
    expect(plan).toEqual({
      hostPath: '/opt/server-data/pve-01/example-lxc/opt',
      guestPath: '/opt',
      uid: 10_100,
      gid: 20_200,
      mode: '0750',
      defaultAcl: false,
    });
  });

  it('keeps world-writable an explicit opt-in with default ACLs', () => {
    const plan = planHostDirectory(mount({ permissions: 'world_writable' }), {
      uidBase: 0,
      gidBase: 0,
    });
    expect(plan.mode).toBe(HOST_DIRECTORY_WORLD_WRITABLE_MODE);
    expect(plan.defaultAcl).toBe(true);
  });

  it('only plans mp0 directories and ignores other bind mounts', () => {
    const guest = lxc({
      unprivileged: true,
      mounts: [
        mount(),
        mount({
          index: 1,
          host_path: '/srv/shared',
          guest_path: '/shared',
        }),
      ],
    });
    const plans = planHostDirectories(guest);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.hostPath).toBe('/opt/server-data/pve-01/example-lxc/opt');
  });

  it('returns no plans when the guest has no mounts', () => {
    expect(planHostDirectories(lxc())).toEqual([]);
  });

  it('rejects owners outside the idmap size or UID range', () => {
    expect(() =>
      planHostDirectory(mount({ owner: { uid: 70_000, gid: 1 } }), {
        uidBase: DEFAULT_UNPRIVILEGED_UID_BASE,
        gidBase: DEFAULT_UNPRIVILEGED_UID_BASE,
        size: 65_536,
      }),
    ).toThrow('outside the idmap size');
    expect(() =>
      planHostDirectory(mount({ owner: { uid: 0, gid: 70_000 } }), {
        uidBase: DEFAULT_UNPRIVILEGED_UID_BASE,
        gidBase: DEFAULT_UNPRIVILEGED_UID_BASE,
        size: 65_536,
      }),
    ).toThrow('outside the idmap size');
    expect(() =>
      planHostDirectory(mount({ owner: { uid: 1, gid: 0 } }), {
        uidBase: 4_294_967_295,
        gidBase: 0,
      }),
    ).toThrow('Mapped host UID');
    expect(() =>
      planHostDirectory(mount({ owner: { uid: 0, gid: 1 } }), {
        uidBase: 0,
        gidBase: 4_294_967_295,
      }),
    ).toThrow('Mapped host GID');
  });
});

describe('host directory command builders', () => {
  const plan: HostDirectoryPlan = {
    hostPath: '/opt/server-data/pve-01/example-lxc/opt',
    guestPath: '/opt',
    uid: 101_000,
    gid: 101_000,
    mode: '0750',
    defaultAcl: false,
  };

  it('builds stat, install and optional ACL argv without a shell', () => {
    expect(hostDirectoryStatArgv(plan.hostPath)).toEqual([
      'stat',
      '-c',
      '%u:%g:%a',
      plan.hostPath,
    ]);
    expect(hostDirectoryInstallArgv(plan)).toEqual([
      'install',
      '-d',
      '-m',
      '0750',
      '-o',
      '101000',
      '-g',
      '101000',
      plan.hostPath,
    ]);
    expect(hostDirectoryAclArgv(plan)).toBeUndefined();
    expect(hostDirectorySetupArgv(plan)).toEqual([
      hostDirectoryInstallArgv(plan),
    ]);
    const worldWritable: HostDirectoryPlan = {
      ...plan,
      mode: '2777',
      defaultAcl: true,
    };
    expect(hostDirectoryAclArgv(worldWritable)).toEqual([
      'setfacl',
      '-d',
      '-m',
      'u::rwx,g::rwx,o::rwx',
      plan.hostPath,
    ]);
    expect(hostDirectorySetupArgv(worldWritable)).toHaveLength(2);
  });

  it('parses and compares stat output in octal', () => {
    expect(parseHostDirectoryStat('101000:101000:750\n')).toEqual({
      uid: 101_000,
      gid: 101_000,
      mode: 0o750,
    });
    expect(parseHostDirectoryStat('101000:101000:2777')).toEqual({
      uid: 101_000,
      gid: 101_000,
      mode: 0o2777,
    });
    expect(parseHostDirectoryStat('bad')).toBeUndefined();
    expect(parseHostDirectoryStat('a:1:750')).toBeUndefined();
    expect(parseHostDirectoryStat('1:b:750')).toBeUndefined();
    expect(parseHostDirectoryStat('1:1:nope')).toBeUndefined();
    expect(
      hostDirectoryMatches(plan, {
        uid: 101_000,
        gid: 101_000,
        mode: 0o750,
      }),
    ).toBe(true);
    expect(hostDirectoryMatches(plan, { uid: 0, gid: 0, mode: 0o750 })).toBe(
      false,
    );
  });
});

describe('host directory journaled steps', () => {
  it('prepares and verifies a minimal directory', async () => {
    const steps = createHostDirectorySteps(
      lxc({ unprivileged: true, mounts: [mount()] }),
    );
    expect(steps).toHaveLength(1);
    const step = steps[0]!;
    expect(step.name).toContain('/opt/server-data/pve-01/example-lxc/opt');

    const missing = new FakeTransport().onExec(statCommand, { exitCode: 1 });
    await expect(step.check(context(missing))).resolves.toEqual({
      status: 'required',
    });

    const planned = new FakeTransport()
      .onExec(statCommand, { stdout: '100000:100000:750' }, { once: true })
      .onExec(/^install -d /, { stdout: '' }, { once: true })
      .onExec(statCommand, { exitCode: 1 }, { once: true });
    await expect(step.check(context(planned))).resolves.toEqual({
      status: 'required',
    });
    await expect(step.apply(context(planned))).resolves.toMatchObject({
      hostPath: '/opt/server-data/pve-01/example-lxc/opt',
      uid: 100_000,
      gid: 100_000,
      mode: '0750',
    });
    await expect(step.verify(context(planned))).resolves.toMatchObject({
      stat: { uid: 100_000, gid: 100_000, mode: 0o750 },
    });

    const satisfied = new FakeTransport().onExec(statCommand, {
      stdout: '100000:100000:750',
    });
    await expect(step.check(context(satisfied))).resolves.toMatchObject({
      status: 'satisfied',
    });
    expect(step.rollbackHint).toContain('never deleted automatically');
  });

  it('adds default ACLs only after checking setfacl exists', async () => {
    const steps = createHostDirectorySteps(
      lxc({
        unprivileged: true,
        mounts: [mount({ permissions: 'world_writable' })],
      }),
    );
    const step = steps[0]!;

    await expect(
      step.check(
        context(new FakeTransport().onExec('which setfacl', { exitCode: 1 })),
      ),
    ).rejects.toThrow("'acl' package");

    const transport = new FakeTransport()
      .onExec(statCommand, { stdout: '100000:100000:2777' }, { once: true })
      .onExec(/^setfacl -d /, { stdout: '' }, { once: true })
      .onExec(/^install -d /, { stdout: '' }, { once: true })
      .onExec(statCommand, { exitCode: 1 }, { once: true })
      .onExec('which setfacl', { stdout: '/usr/bin/setfacl' }, { once: true });
    await expect(step.check(context(transport))).resolves.toEqual({
      status: 'required',
    });
    await expect(step.apply(context(transport))).resolves.toMatchObject({
      mode: '2777',
    });
    await expect(step.verify(context(transport))).resolves.toMatchObject({
      stat: { mode: 0o2777 },
    });
  });

  it('surfaces install failures with and without stderr', async () => {
    const step = createHostDirectorySteps(
      lxc({ unprivileged: true, mounts: [mount()] }),
    )[0]!;
    await expect(
      step.apply(
        context(
          new FakeTransport().onExec(/^install -d /, {
            exitCode: 1,
            stderr: 'permission denied',
          }),
        ),
      ),
    ).rejects.toThrow('permission denied');
    await expect(
      step.apply(
        context(new FakeTransport().onExec(/^install -d /, { exitCode: 1 })),
      ),
    ).rejects.toThrow('exit code 1');
  });

  it('fails verification when stat fails or does not match', async () => {
    const step = createHostDirectorySteps(
      lxc({ unprivileged: true, mounts: [mount()] }),
    )[0]!;
    await expect(
      step.verify(
        context(
          new FakeTransport().onExec(statCommand, {
            exitCode: 1,
            stderr: 'missing',
          }),
        ),
      ),
    ).rejects.toThrow('missing');
    await expect(
      step.verify(
        context(new FakeTransport().onExec(statCommand, { exitCode: 1 })),
      ),
    ).rejects.toThrow('exit code 1');
    await expect(
      step.verify(
        context(
          new FakeTransport().onExec(statCommand, {
            stdout: '100000:100000:755',
          }),
        ),
      ),
    ).rejects.toThrow('does not have the planned ownership or mode');
    await expect(
      step.verify(
        context(
          new FakeTransport().onExec(statCommand, {
            stdout: 'not-a-stat',
          }),
        ),
      ),
    ).rejects.toThrow('does not have the planned ownership or mode');
  });

  it('returns no steps for VMs or guests without mounts', () => {
    const vm: GuestDeployment = {
      id: 300,
      name: 'example-vm',
      type: 'vm',
      cpu: 1,
      ram: 512,
      disks: [],
      network: [],
    };
    expect(createHostDirectorySteps(vm)).toEqual([]);
    expect(createHostDirectorySteps(lxc())).toEqual([]);
  });
});

describe('readHostDirectory', () => {
  it('returns the stat when present and undefined otherwise', async () => {
    await expect(
      readHostDirectory(
        new FakeTransport().onExec(statCommand, {
          stdout: '100000:100000:750',
        }),
        '/opt/server-data/pve-01/example-lxc/opt',
      ),
    ).resolves.toEqual({ uid: 100_000, gid: 100_000, mode: 0o750 });
    await expect(
      readHostDirectory(
        new FakeTransport().onExec(statCommand, { exitCode: 1 }),
        '/opt/server-data/pve-01/example-lxc/opt',
      ),
    ).resolves.toBeUndefined();
  });
});
