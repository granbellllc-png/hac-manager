import { describe, expect, it } from 'vitest';
import type { GuestDeployment } from '../schema/deployment.js';
import { FakeTransport } from '../transport/fake.js';
import {
  inspectStorageInvariants,
  parseStorageDaemons,
  parseStorageInitPid,
  parseStorageProbeMode,
  parseStorageSummary,
  resolveStoragePaths,
  storageResolutionFromLabel,
  storageResolutionTimestamp,
  type StorageInvariantReport,
} from './invariants.js';

type Lxc = Extract<GuestDeployment, { type: 'lxc' }>;

const hostPath = '/opt/server-data/pve-01/example-lxc/opt';
const configPath = '/etc/pve/local/lxc/112.conf';
const probePath = '/run/hacm-rootfs-probe';
const pid = 4242;
const hostSummaryArgv = `bash -s -- ${hostPath}`;
const rootfsArgv = `nsenter -t ${pid} -m -- bash -s -- /opt ${probePath}`;
const mountArgv = `nsenter -t ${pid} -m -- mountpoint -q /opt`;
const daemonArgv = `bash -s -- /opt 112 dockerd containerd postgres postmaster`;

const config = [
  'hostname: example-lxc',
  'cores: 2',
  'rootfs: local-lvm:vm-112-disk-0,size=10G',
  `mp0: ${hostPath},backup=1,mp=/opt`,
].join('\n');

function lxc(overrides: Partial<Lxc> = {}): Lxc {
  return {
    schema_version: 1,
    id: 112,
    name: 'example-lxc',
    type: 'lxc',
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

function summary(
  exists: boolean,
  files: number,
  bytes: number,
  newest?: string,
): string {
  if (!exists) return 'exists=0\nfiles=0\nbytes=0\n';
  return `exists=1\nfiles=${files}\nbytes=${bytes}\nnewest=${newest ?? ''}\n`;
}

interface Fixture {
  readonly config?: string;
  readonly configExitCode?: number;
  readonly status?: string;
  readonly pid?: number | undefined;
  readonly host?: string;
  readonly rootfs?: string;
  readonly mounted?: boolean;
  readonly daemons?: string;
}

function transport(fixture: Fixture = {}): FakeTransport {
  const fake = new FakeTransport()
    .onExec(`pct config 112`, {
      ...(fixture.configExitCode !== undefined
        ? { exitCode: fixture.configExitCode }
        : {}),
      stdout: fixture.config ?? config,
    })
    .onExec('pct status 112', { stdout: fixture.status ?? 'status: running' })
    .onExec(
      `lxc-info -n 112 -p -H`,
      fixture.pid === undefined
        ? { stdout: '' }
        : { stdout: `${fixture.pid ?? pid}\n` },
    )
    .onExec(hostSummaryArgv, {
      stdout: fixture.host ?? summary(true, 3, 1200, '1762752000'),
    })
    .onExec(rootfsArgv, {
      stdout: fixture.rootfs ?? `probe=bind\n${summary(false, 0, 0)}`,
    })
    .onExec(mountArgv, {
      exitCode: fixture.mounted === false ? 1 : 0,
    })
    .onExec(daemonArgv, { stdout: fixture.daemons ?? '' });
  if (fixture.pid === undefined) {
    fake.onExec(`lxc-info -n 112 -p -H`, { stdout: `${pid}\n` });
  }
  return fake;
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    hostId: 'pve-01',
    pid,
    rootfsProbePath: probePath,
    now: () => new Date('2026-11-10T12:00:00.000Z'),
    ...overrides,
  } as Parameters<typeof inspectStorageInvariants>[2];
}

describe('storage invariant classification (D-46)', () => {
  it('reports ok when the host data is active and the rootfs copy is empty', async () => {
    const report = await inspectStorageInvariants(
      lxc(),
      transport(),
      options(),
    );
    expect(report).toMatchObject({
      hostId: 'pve-01',
      vmid: 112,
      guestName: 'example-lxc',
      guestPath: '/opt',
      hostPath,
      status: 'ok',
      mounted: true,
      rootfsProbe: 'bind-mount',
      requiresResolution: false,
      resolutionOptions: [],
      checkedAt: '2026-11-10T12:00:00.000Z',
    });
    expect(report.host.newestTimestamp).toBe(
      new Date(1_762_752_000_000).toISOString(),
    );
    expect(report.warnings).toEqual([]);
  });

  it('detects split-brain data and offers both resolutions', async () => {
    const report = await inspectStorageInvariants(
      lxc(),
      transport({
        mounted: false,
        host: summary(true, 2, 512, '1762665600'),
        rootfs: `probe=bind\n${summary(true, 4, 900, '1762752000')}`,
      }),
      options(),
    );
    expect(report.status).toBe('split-brain');
    expect(report.requiresResolution).toBe(true);
    expect(report.resolutionOptions).toEqual([
      'keep-host-data',
      'migrate-rootfs-to-host',
    ]);
    expect(report.recommendedResolution).toBe('migrate-rootfs-to-host');
    expect(report.message).toContain('rootfs copy');
  });

  it('recommends host data when it is newer than the rootfs copy', async () => {
    const report = await inspectStorageInvariants(
      lxc(),
      transport({
        mounted: false,
        host: summary(true, 2, 512, '1762752000'),
        rootfs: `probe=bind\n${summary(true, 4, 900, '1762665600')}`,
      }),
      options(),
    );
    expect(report.status).toBe('split-brain');
    expect(report.recommendedResolution).toBe('keep-host-data');
  });

  it('detects shadowed rootfs data behind an active mp0', async () => {
    const report = await inspectStorageInvariants(
      lxc(),
      transport({
        mounted: true,
        host: summary(true, 2, 512, '1762752000'),
        rootfs: `probe=bind\n${summary(true, 4, 900, '1762665600')}`,
      }),
      options(),
    );
    expect(report.status).toBe('shadowed');
    expect(report.requiresResolution).toBe(true);
    expect(report.recommendedResolution).toBe('keep-host-data');
  });

  it('reports not-migrated, not-mounted and missing-host-data', async () => {
    const notMigrated = await inspectStorageInvariants(
      lxc(),
      transport({
        mounted: false,
        host: summary(false, 0, 0),
        rootfs: `probe=bind\n${summary(true, 4, 900)}`,
      }),
      options(),
    );
    expect(notMigrated.status).toBe('not-migrated');
    expect(notMigrated.warnings.join(' ')).toContain('migration');

    const notMounted = await inspectStorageInvariants(
      lxc(),
      transport({
        mounted: false,
        host: summary(true, 2, 512),
        rootfs: `probe=bind\n${summary(false, 0, 0)}`,
      }),
      options(),
    );
    expect(notMounted.status).toBe('not-mounted');

    const missing = await inspectStorageInvariants(
      lxc(),
      transport({
        mounted: true,
        host: summary(false, 0, 0),
        rootfs: `probe=bind\n${summary(false, 0, 0)}`,
      }),
      options(),
    );
    expect(missing.status).toBe('missing-host-data');

    const empty = await inspectStorageInvariants(
      lxc(),
      transport({
        mounted: false,
        host: summary(false, 0, 0),
        rootfs: `probe=bind\n${summary(false, 0, 0)}`,
      }),
      options(),
    );
    expect(empty.status).toBe('ok');
  });

  it('detects daemons stuck on the old mount namespace', async () => {
    const report = await inspectStorageInvariants(
      lxc(),
      transport({
        mounted: true,
        daemons: 'dockerd 900 0\npostgres 901 1\n',
      }),
      options(),
    );
    expect(report.status).toBe('stale-mount');
    expect(report.staleDaemons).toEqual([
      expect.objectContaining({ name: 'dockerd', pid: 900, stale: true }),
    ]);
    expect(report.daemons).toContainEqual(
      expect.objectContaining({ name: 'postgres', stale: false }),
    );
    expect(report.warnings.join(' ')).toContain('Restart the guest stack');
  });

  it('warns when the rootfs probe had to use the visible path', async () => {
    const report = await inspectStorageInvariants(
      lxc(),
      transport({
        mounted: true,
        rootfs: `probe=visible\n${summary(false, 0, 0)}`,
      }),
      options(),
    );
    expect(report.rootfsProbe).toBe('visible');
    expect(report.status).toBe('ok');
    expect(report.warnings.join(' ')).toContain('bind-mount');
  });

  it('returns guest-stopped, not-applicable and unknown reports', async () => {
    const stopped = await inspectStorageInvariants(
      lxc(),
      transport({ status: 'status: stopped' }),
      options(),
    );
    expect(stopped.status).toBe('guest-stopped');
    expect(stopped.requiresResolution).toBe(false);

    const vm: GuestDeployment = {
      id: 300,
      name: 'example-vm',
      type: 'vm',
      cpu: 1,
      ram: 512,
      disks: [],
      network: [],
    };
    const notApplicable = await inspectStorageInvariants(
      vm,
      new FakeTransport(),
      options(),
    );
    expect(notApplicable.status).toBe('not-applicable');
    expect(notApplicable.guestPath).toBe('/opt');

    const configFailed = await inspectStorageInvariants(
      lxc(),
      transport({ configExitCode: 1 }),
      options(),
    );
    expect(configFailed.status).toBe('unknown');
    expect(configFailed.warnings[0]).toContain('Failed to read');

    const noPid = await inspectStorageInvariants(
      lxc(),
      transport().onExec(`lxc-info -n 112 -p -H`, {
        stdout: '',
      }),
      options({ pid: undefined }),
    );
    expect(noPid.status).toBe('unknown');

    const badHost = await inspectStorageInvariants(
      lxc(),
      transport().onExec(hostSummaryArgv, { stdout: 'nonsense' }),
      options(),
    );
    expect(badHost.status).toBe('unknown');

    const badRootfs = await inspectStorageInvariants(
      lxc(),
      transport().onExec(rootfsArgv, { stdout: 'nonsense' }),
      options(),
    );
    expect(badRootfs.status).toBe('unknown');
  });

  it('uses the deployment path, then the live mp0, then the D-43 default', () => {
    expect(resolveStoragePaths(lxc(), 'pve-01', config)).toEqual({
      guestPath: '/opt',
      hostPath,
      mp0Value: `${hostPath},backup=1,mp=/opt`,
    });
    expect(
      resolveStoragePaths(
        lxc({ mounts: undefined }),
        'pve-01',
        `mp0: /srv/live,mp=/srv,backup=0\n`,
      ),
    ).toEqual({
      guestPath: '/srv',
      hostPath: '/srv/live',
      mp0Value: '/srv/live,mp=/srv,backup=0',
    });
    expect(
      resolveStoragePaths(lxc({ mounts: undefined }), 'pve-01', ''),
    ).toEqual({
      guestPath: '/opt',
      hostPath,
    });
  });

  it('parses summaries, probes, pids, daemons and labels', () => {
    expect(parseStorageSummary(summary(false, 0, 0))).toEqual({
      exists: false,
      fileCount: 0,
      bytes: 0,
    });
    expect(parseStorageSummary('nope')).toBeUndefined();
    expect(parseStorageSummary('exists=1\nfiles=x\nbytes=1')).toBeUndefined();
    expect(
      parseStorageSummary(summary(true, 2, 10, '1762752000.5')),
    ).toMatchObject({ fileCount: 2, bytes: 10 });
    expect(parseStorageProbeMode('probe=bind\n')).toBe('bind-mount');
    expect(parseStorageProbeMode('probe=visible')).toBe('visible');
    expect(parseStorageProbeMode('other')).toBeUndefined();
    expect(parseStorageInitPid('4242\n')).toBe(4242);
    expect(parseStorageInitPid('0')).toBeUndefined();
    expect(parseStorageInitPid('x')).toBeUndefined();
    expect(
      parseStorageDaemons('bad line\nfoo x 1\ndockerd 10 1\n', false),
    ).toEqual([
      { name: 'dockerd', pid: 10, mountedInDaemon: true, stale: true },
    ]);
    expect(storageResolutionFromLabel('Keep Host Data')).toBe('keep-host-data');
    expect(storageResolutionFromLabel('nope')).toBeUndefined();
    expect(
      storageResolutionTimestamp(new Date('2026-11-10T12:00:00.500Z')),
    ).toBe('2026-11-10T120000Z');
  });

  it('honours explicit path and daemon overrides', async () => {
    const fake = new FakeTransport()
      .onExec('pct config 112', { stdout: config })
      .onExec('pct status 112', { stdout: 'status: running' })
      .onExec('lxc-info -n 112 -p -H', { stdout: `${pid}\n` })
      .onExec('bash -s -- /srv/data', {
        stdout: summary(true, 1, 1),
      })
      .onExec(`nsenter -t ${pid} -m -- bash -s -- /srv ${probePath}`, {
        stdout: `probe=bind\n${summary(false, 0, 0)}`,
      })
      .onExec(`nsenter -t ${pid} -m -- mountpoint -q /srv`, { exitCode: 0 })
      .onExec('bash -s -- /srv 112 dockerd', { stdout: '' });
    const report = await inspectStorageInvariants(
      lxc(),
      fake,
      options({
        guestPath: '/srv',
        hostPath: '/srv/data',
        daemonNames: ['dockerd'],
      }),
    );
    expect(report.guestPath).toBe('/srv');
    expect(report.hostPath).toBe('/srv/data');
    expect(report.status).toBe('ok');
  });

  it('keeps the report type assignable for callers', () => {
    const report: StorageInvariantReport = {
      hostId: 'pve-01',
      vmid: 112,
      guestName: 'example-lxc',
      guestType: 'lxc',
      guestPath: '/opt',
      hostPath,
      status: 'ok',
      message: 'ok',
      host: { exists: false, fileCount: 0, bytes: 0 },
      rootfs: { exists: false, fileCount: 0, bytes: 0 },
      mounted: false,
      rootfsProbe: 'skipped',
      daemons: [],
      staleDaemons: [],
      warnings: [],
      requiresResolution: false,
      resolutionOptions: [],
      checkedAt: '2026-11-10T12:00:00.000Z',
    };
    expect(report.status).toBe('ok');
    expect(configPath).toBe('/etc/pve/local/lxc/112.conf');
  });
});
