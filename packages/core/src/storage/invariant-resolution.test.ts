import { describe, expect, it } from 'vitest';
import type { GuestDeployment } from '../schema/deployment.js';
import { MemoryStepJournal } from '../steps/memory-journal.js';
import { runJournaledSteps } from '../steps/runner.js';
import type { StepExecutionContext, StepLogger } from '../steps/types.js';
import { FakeTransport } from '../transport/fake.js';
import {
  createHostDataDisplaceStep,
  createStorageArchiveStep,
  createStorageResolutionSteps,
  DEFAULT_STORAGE_BACKUP_ROOT,
  planStorageResolution,
  storageBackupArgv,
  storageBackupPath,
  storageHostDisplaceArgv,
  storageHostDisplacedPath,
} from './invariant-resolution.js';
import type { StorageInvariantReport } from './invariants.js';

type Lxc = Extract<GuestDeployment, { type: 'lxc' }>;

const hostPath = '/opt/server-data/pve-01/example-lxc/opt';
const rootfsMountPath = '/fixtures/lxc/112/rootfs';
const guestOptPath = `${rootfsMountPath}/opt`;
const timestamp = '2026-11-10T120000Z';
const displacedPath = `${guestOptPath}.migrated-${timestamp}`;
const hostDisplacedPath = `${hostPath}.migrated-${timestamp}`;
const mp0Value = `${hostPath},backup=1,mp=/opt`;
const rootfsBackupPath = `${DEFAULT_STORAGE_BACKUP_ROOT}/pve-01/112/${timestamp}-rootfs-data.tar.gz`;
const hostBackupPath = `${DEFAULT_STORAGE_BACKUP_ROOT}/pve-01/112/${timestamp}-host-data.tar.gz`;
const configPath = '/etc/pve/local/lxc/112.conf';

function lxc(overrides: Partial<Lxc> = {}): Lxc {
  return {
    schema_version: 1,
    id: 112,
    name: 'example-lxc',
    type: 'lxc',
    unprivileged: true,
    cpu: 2,
    ram: 1024,
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

function report(
  overrides: Partial<StorageInvariantReport> = {},
): StorageInvariantReport {
  return {
    hostId: 'pve-01',
    vmid: 112,
    guestName: 'example-lxc',
    guestType: 'lxc',
    guestPath: '/opt',
    hostPath,
    status: 'split-brain',
    message: 'both sides have data',
    host: {
      exists: true,
      fileCount: 2,
      bytes: 512,
      newestTimestamp: '2026-11-10T10:00:00.000Z',
    },
    rootfs: {
      exists: true,
      fileCount: 4,
      bytes: 900,
      newestTimestamp: '2026-11-10T11:00:00.000Z',
    },
    mounted: false,
    rootfsProbe: 'bind-mount',
    daemons: [],
    staleDaemons: [],
    warnings: [],
    requiresResolution: true,
    resolutionOptions: ['keep-host-data', 'migrate-rootfs-to-host'],
    recommendedResolution: 'keep-host-data',
    checkedAt: '2026-11-10T12:00:00.000Z',
    ...overrides,
  };
}

const baseConfig = [
  'hostname: example-lxc',
  'cores: 2',
  'memory: 1024',
  'rootfs: local-lvm:vm-112-disk-0,size=10G',
].join('\n');

function configured(): string {
  return `${baseConfig}\nmp0: ${mp0Value}`;
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
    operationId: 'resolve-112',
    input: undefined,
    transport,
    logger: logger(),
    dryRun: false,
    signal: new AbortController().signal,
  };
}

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

describe('storage resolution planning (D-47)', () => {
  it('plans keep-host-data with a rootfs archive and displacement', () => {
    const plan = planStorageResolution(lxc(), report(), 'keep-host-data', {
      timestamp,
      rootfsMountPath,
    });
    expect(plan).toMatchObject({
      resolution: 'keep-host-data',
      status: 'split-brain',
      guestPath: '/opt',
      hostPath,
      vmid: 112,
      hostId: 'pve-01',
      timestamp,
      rootfsMountPath,
      guestOptPath,
      hostDisplacedPath,
      rootfsDisplacedPath: displacedPath,
      rootfsBackupPath,
      mp0Value,
      destructive: false,
    });
    expect(plan.hostBackupPath).toBeUndefined();
    expect(plan.changes.join('\n')).toContain('Archive the rootfs copy');
    expect(plan.warnings.join('\n')).toContain('never deleted automatically');
    expect(plan.commands).toContainEqual(
      storageBackupArgv(guestOptPath, rootfsBackupPath),
    );
    expect(plan.commands.join(' ')).not.toContain('--delete');
  });

  it('plans migrate-rootfs-to-host with a host archive before the migration', () => {
    const plan = planStorageResolution(
      lxc(),
      report(),
      'migrate-rootfs-to-host',
      { timestamp, rootfsMountPath, guestBackup: false },
    );
    expect(plan).toMatchObject({
      resolution: 'migrate-rootfs-to-host',
      hostBackupPath,
      mp0Value,
      destructive: false,
    });
    expect(plan.rootfsBackupPath).toBeUndefined();
    expect(plan.warnings.join('\n')).toContain(
      'previous host data is archived',
    );
    expect(plan.commands[0]).toEqual(
      storageBackupArgv(hostPath, hostBackupPath),
    );
    expect(plan.commands[1]).toEqual(
      storageHostDisplaceArgv(hostPath, hostDisplacedPath),
    );
    expect(plan.commands.join(' ')).not.toContain('vzdump');
  });

  it('warns about protection and relies on vzdump when it is enabled', () => {
    const plan = planStorageResolution(
      lxc({ protection: true }),
      report(),
      'migrate-rootfs-to-host',
      { timestamp, rootfsMountPath },
    );
    expect(plan.commands).toContainEqual(
      expect.arrayContaining(['vzdump', '112']),
    );
    expect(plan.warnings.join('\n')).toContain('protection flag');
  });

  it('uses the current time when no deterministic timestamp is supplied', () => {
    const plan = planStorageResolution(
      lxc(),
      report({ status: 'shadowed', recommendedResolution: 'keep-host-data' }),
      'keep-host-data',
      { rootfsMountPath },
    );
    expect(plan.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{6}Z$/);
  });

  it('rejects unavailable resolutions and changed paths', () => {
    expect(() =>
      planStorageResolution(
        {
          id: 300,
          name: 'example-vm',
          type: 'vm',
          cpu: 1,
          ram: 512,
          disks: [],
          network: [],
        },
        report(),
        'keep-host-data',
        { timestamp },
      ),
    ).toThrow('only applies to LXC');
    expect(() =>
      planStorageResolution(
        lxc(),
        report({
          status: 'ok',
          requiresResolution: false,
          resolutionOptions: [],
        }),
        'keep-host-data',
        { timestamp },
      ),
    ).toThrow('does not require a resolution');
    expect(() =>
      planStorageResolution(
        lxc(),
        report({ resolutionOptions: ['keep-host-data'] }),
        'migrate-rootfs-to-host',
        { timestamp },
      ),
    ).toThrow('is not available');
    expect(() =>
      planStorageResolution(
        lxc(),
        report({ hostPath: '/srv/other' }),
        'keep-host-data',
        { timestamp },
      ),
    ).toThrow('deployment paths changed');
    expect(() =>
      planStorageResolution(lxc(), report(), 'keep-host-data', {
        timestamp: '../escape',
      }),
    ).toThrow('cannot be used in a storage backup path');
  });

  it('builds safe backup and displacement paths', () => {
    expect(
      storageBackupPath('/backups', 'pve-01', 112, timestamp, 'host'),
    ).toBe(`/backups/pve-01/112/${timestamp}-host-data.tar.gz`);
    expect(() =>
      storageBackupPath('relative', 'pve-01', 112, timestamp, 'host'),
    ).toThrow('must be a normalized absolute path');
    expect(() =>
      storageBackupPath('/backups', 'bad/id', 112, timestamp, 'host'),
    ).toThrow('cannot be used in a storage backup path');
    expect(storageHostDisplacedPath(hostPath, timestamp)).toBe(
      hostDisplacedPath,
    );
  });
});

describe('storage resolution steps', () => {
  it('archives the rootfs before displacing it when host data is kept', async () => {
    const transport = new FakeTransport();
    sequence(transport, `stat -c %u:%g:%a ${hostPath}`, [
      { stdout: '100000:100000:750' },
      { stdout: '100000:100000:750' },
      { stdout: '100000:100000:750' },
    ]);
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
    sequence(transport, 'pct config 112', [
      { stdout: baseConfig },
      { stdout: baseConfig },
      { stdout: configured() },
      { stdout: configured() },
    ]);
    sequence(transport, `mountpoint -q ${rootfsMountPath}`, [
      { exitCode: 1 },
      { exitCode: 1 },
      {},
      {},
      {},
      { exitCode: 1 },
    ]);
    sequence(transport, `test -s ${rootfsBackupPath}`, [
      { exitCode: 1 },
      { exitCode: 1 },
      {},
    ]);
    sequence(transport, `test -e ${guestOptPath}`, [
      {},
      {},
      {},
      {},
      {},
      { exitCode: 1 },
    ]);
    sequence(transport, `test -e ${displacedPath}`, [
      { exitCode: 1 },
      { exitCode: 1 },
      {},
    ]);
    transport.onExec('pct shutdown 112 --timeout 120', {});
    transport.onExec('pct mount 112', {});
    transport.onExec(
      `install -d -m 0700 ${DEFAULT_STORAGE_BACKUP_ROOT}/pve-01/112`,
      {},
    );
    transport.onExec(
      storageBackupArgv(guestOptPath, rootfsBackupPath).join(' '),
      {},
    );
    transport.onExec(`mv ${guestOptPath} ${displacedPath}`, {});
    transport.onExec('pct unmount 112', {});
    transport.onExec(`pct set 112 --mp0 ${mp0Value}`, {});
    transport.onExec('pct start 112', {});

    const steps = createStorageResolutionSteps(
      lxc(),
      report(),
      'keep-host-data',
      { timestamp, rootfsMountPath },
    );
    expect(steps).toHaveLength(9);
    const result = await runJournaledSteps({
      operationId: 'resolve-112',
      input: undefined,
      transport,
      logger: logger(),
      dryRun: false,
      signal: new AbortController().signal,
      journal: new MemoryStepJournal(),
      steps,
    });
    expect(result.entries.map((entry) => entry.status)).toEqual(
      Array.from({ length: 9 }, () => 'completed'),
    );
    const argv = transport.execArgv;
    const archive = argv.findIndex((call) => call[0] === 'tar');
    const displace = argv.findIndex((call) => call[0] === 'mv');
    const attach = argv.findIndex(
      (call) => call[0] === 'pct' && call[1] === 'set',
    );
    expect(archive).toBeGreaterThan(-1);
    expect(displace).toBeGreaterThan(archive);
    expect(attach).toBeGreaterThan(displace);
    expect(argv.some((call) => call[0] === 'rm')).toBe(false);
    expect(argv.some((call) => call.includes('--delete'))).toBe(false);
  });

  it('archives and displaces host data before migrating the rootfs', () => {
    const steps = createStorageResolutionSteps(
      lxc(),
      report(),
      'migrate-rootfs-to-host',
      { timestamp, rootfsMountPath, guestBackup: false },
    );
    expect(steps).toHaveLength(13);
    expect(steps[0]!.name).toContain('stop LXC 112');
    expect(steps[1]!.name).toContain('archive host data');
    expect(steps[2]!.name).toContain('displace host data');
    expect(steps[3]!.name).toContain('prepare host directory');
    expect(steps.at(-1)!.name).toContain('verify the host-backed');
  });

  it('fails the archive before displacing anything', async () => {
    const archive = createStorageArchiveStep({
      name: 'archive host data',
      sourcePath: hostPath,
      backupPath: hostBackupPath,
    });
    const failing = new FakeTransport()
      .onExec(`test -s ${hostBackupPath}`, { exitCode: 1 })
      .onExec(`test -e ${hostPath}`, {})
      .onExec(
        `install -d -m 0700 ${DEFAULT_STORAGE_BACKUP_ROOT}/pve-01/112`,
        {},
      )
      .onExec(storageBackupArgv(hostPath, hostBackupPath).join(' '), {
        exitCode: 1,
        stderr: 'disk full',
      });
    await expect(archive.apply(context(failing))).rejects.toThrow('disk full');
    expect(failing.execArgv.some((call) => call[0] === 'mv')).toBe(false);

    const installFailing = new FakeTransport()
      .onExec(`test -s ${hostBackupPath}`, { exitCode: 1 })
      .onExec(`test -e ${hostPath}`, {})
      .onExec(`install -d -m 0700 ${DEFAULT_STORAGE_BACKUP_ROOT}/pve-01/112`, {
        exitCode: 1,
        stderr: 'read-only',
      });
    await expect(archive.apply(context(installFailing))).rejects.toThrow(
      'read-only',
    );
  });

  it('is idempotent when the archive already exists or the source is gone', async () => {
    const archive = createStorageArchiveStep({
      name: 'archive rootfs',
      sourcePath: guestOptPath,
      backupPath: rootfsBackupPath,
    });
    await expect(
      archive.check(
        context(new FakeTransport().onExec(`test -s ${rootfsBackupPath}`, {})),
      ),
    ).resolves.toMatchObject({ status: 'satisfied' });
    await expect(
      archive.apply(
        context(new FakeTransport().onExec(`test -s ${rootfsBackupPath}`, {})),
      ),
    ).resolves.toEqual({ backupPath: rootfsBackupPath });
    await expect(
      archive.check(
        context(
          new FakeTransport()
            .onExec(`test -s ${rootfsBackupPath}`, { exitCode: 1 })
            .onExec(`test -e ${guestOptPath}`, { exitCode: 1 }),
        ),
      ),
    ).resolves.toMatchObject({ detail: { skipped: true } });
    await expect(
      archive.apply(
        context(
          new FakeTransport()
            .onExec(`test -s ${rootfsBackupPath}`, { exitCode: 1 })
            .onExec(`test -e ${guestOptPath}`, { exitCode: 1 }),
        ),
      ),
    ).resolves.toEqual({ skipped: true, reason: 'source-missing' });
    await expect(
      archive.verify(
        context(
          new FakeTransport().onExec(`test -e ${guestOptPath}`, {
            exitCode: 1,
          }),
        ),
      ),
    ).resolves.toEqual({ skipped: true, reason: 'source-missing' });
    await expect(
      archive.verify(
        context(
          new FakeTransport()
            .onExec(`test -e ${guestOptPath}`, {})
            .onExec(`test -s ${rootfsBackupPath}`, { exitCode: 1 }),
        ),
      ),
    ).rejects.toThrow('missing or empty');
  });

  it('never overwrites an existing displaced host directory', async () => {
    const step = createHostDataDisplaceStep(hostPath, hostDisplacedPath);
    await expect(
      step.check(
        context(
          new FakeTransport()
            .onExec(`test -e ${hostPath}`, {})
            .onExec(`test -e ${hostDisplacedPath}`, {}),
        ),
      ),
    ).rejects.toThrow('Refusing to overwrite');
    await expect(
      step.check(
        context(
          new FakeTransport()
            .onExec(`test -e ${hostPath}`, { exitCode: 1 })
            .onExec(`test -e ${hostDisplacedPath}`, {}),
        ),
      ),
    ).resolves.toMatchObject({ status: 'satisfied' });
    await expect(
      step.check(
        context(
          new FakeTransport()
            .onExec(`test -e ${hostPath}`, { exitCode: 1 })
            .onExec(`test -e ${hostDisplacedPath}`, { exitCode: 1 }),
        ),
      ),
    ).resolves.toMatchObject({ detail: { missing: true } });
    await expect(
      step.apply(
        context(
          new FakeTransport()
            .onExec(`test -e ${hostPath}`, { exitCode: 1 })
            .onExec(`test -e ${hostDisplacedPath}`, {}),
        ),
      ),
    ).resolves.toEqual({ changed: false });
    await expect(
      step.apply(
        context(
          new FakeTransport()
            .onExec(`test -e ${hostPath}`, { exitCode: 1 })
            .onExec(`test -e ${hostDisplacedPath}`, { exitCode: 1 }),
        ),
      ),
    ).resolves.toEqual({ changed: false, missing: true });
    await expect(
      step.apply(
        context(
          new FakeTransport()
            .onExec(`test -e ${hostPath}`, {})
            .onExec(`test -e ${hostDisplacedPath}`, {}),
        ),
      ),
    ).rejects.toThrow('Refusing to overwrite');
    await expect(
      step.apply(
        context(
          new FakeTransport()
            .onExec(`test -e ${hostPath}`, {})
            .onExec(`test -e ${hostDisplacedPath}`, { exitCode: 1 })
            .onExec(
              storageHostDisplaceArgv(hostPath, hostDisplacedPath).join(' '),
              {
                exitCode: 1,
                stderr: 'cross-device',
              },
            ),
        ),
      ),
    ).rejects.toThrow('cross-device');
    await expect(
      step.apply(
        context(
          new FakeTransport()
            .onExec(`test -e ${hostPath}`, {})
            .onExec(`test -e ${hostDisplacedPath}`, { exitCode: 1 })
            .onExec(
              storageHostDisplaceArgv(hostPath, hostDisplacedPath).join(' '),
              { exitCode: 1 },
            ),
        ),
      ),
    ).rejects.toThrow('exit code 1');
    await expect(
      step.verify(
        context(
          new FakeTransport()
            .onExec(`test -e ${hostPath}`, { exitCode: 1 })
            .onExec(`test -e ${hostDisplacedPath}`, { exitCode: 1 }),
        ),
      ),
    ).resolves.toMatchObject({ skipped: true });
    await expect(
      step.verify(
        context(
          new FakeTransport()
            .onExec(`test -e ${hostPath}`, {})
            .onExec(`test -e ${hostDisplacedPath}`, { exitCode: 1 }),
        ),
      ),
    ).rejects.toThrow('was not displaced correctly');
    await expect(
      step.check(
        context(
          new FakeTransport()
            .onExec(`test -e ${hostPath}`, {})
            .onExec(`test -e ${hostDisplacedPath}`, { exitCode: 1 }),
        ),
      ),
    ).resolves.toMatchObject({ status: 'required' });
    await expect(
      step.apply(
        context(
          new FakeTransport()
            .onExec(`test -e ${hostPath}`, {})
            .onExec(`test -e ${hostDisplacedPath}`, { exitCode: 1 })
            .onExec(
              storageHostDisplaceArgv(hostPath, hostDisplacedPath).join(' '),
              {},
            ),
        ),
      ),
    ).resolves.toEqual({ displaced: hostDisplacedPath });
    await expect(
      step.verify(
        context(
          new FakeTransport()
            .onExec(`test -e ${hostPath}`, { exitCode: 1 })
            .onExec(`test -e ${hostDisplacedPath}`, {}),
        ),
      ),
    ).resolves.toEqual({ displaced: hostDisplacedPath });
    await expect(
      step.verify(
        context(
          new FakeTransport()
            .onExec(`test -e ${hostPath}`, {})
            .onExec(`test -e ${hostDisplacedPath}`, {}),
        ),
      ),
    ).rejects.toThrow('was not displaced correctly');
  });

  it('keeps the config path fixture explicit', () => {
    expect(configPath).toBe('/etc/pve/local/lxc/112.conf');
  });
});
