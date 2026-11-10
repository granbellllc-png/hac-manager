import { describe, expect, it } from 'vitest';
import { managedGuestUuid } from '../guest/identity.js';
import type { GuestDeployment } from '../schema/deployment.js';
import { MemoryStepJournal } from '../steps/memory-journal.js';
import { runJournaledSteps } from '../steps/runner.js';
import type { StepExecutionContext, StepLogger } from '../steps/types.js';
import type { ExecOptions, ExecResult, Transport } from '../transport/types.js';
import {
  createGuestRestoreSteps,
  createRestoreMutationPlan,
  guestConfigPath,
  guestRestoreArgv,
  hostDataRestoreSource,
  listGuestBackups,
  parsePvesmList,
  parseVzdumpVolume,
  planGuestRestore,
  planHostDataRestore,
  verifyRestoredIdentity,
  verifyRestoredInvariants,
  type RestoreGuestTarget,
} from './restore.js';

const now = new Date('2026-11-10T12:34:56.000Z');
const volid = 'backup-store:backup/vzdump-lxc-112-2026_11_10-12_34_56.tar.zst';
const vmVolid =
  'backup-store:backup/vzdump-qemu-300-2026_11_10-12_34_56.vma.zst';
const uuid = managedGuestUuid('pve-01', 112);

function target(
  overrides: Partial<RestoreGuestTarget> = {},
): RestoreGuestTarget {
  return {
    hostId: 'pve-01',
    vmid: 112,
    type: 'lxc',
    name: 'jellyfin',
    exists: false,
    status: 'stopped',
    protection: false,
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

function context(
  transport: Transport,
  dryRun = false,
): StepExecutionContext<undefined> {
  return {
    operationId: 'restore-112',
    input: undefined,
    transport,
    logger: logger(),
    dryRun,
    signal: new AbortController().signal,
  };
}

function ok(stdout = ''): ExecResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

function fail(exitCode = 1, stderr = ''): ExecResult {
  return { exitCode, stdout: '', stderr, timedOut: false };
}

interface Failures {
  restore?: boolean;
  stop?: boolean;
  destroy?: boolean;
  start?: boolean;
  list?: boolean;
  mv?: boolean;
  mkdir?: boolean;
  rsync?: boolean;
  restic?: boolean;
  touch?: boolean;
}

/** Stateful fake host with a guest, host directories and restore markers. */
class RestoreHostTransport implements Transport {
  public readonly calls: (readonly string[])[] = [];
  public readonly dirs = new Set<string>();
  public readonly markers = new Set<string>();
  public guestExists = false;
  public running = false;
  public failures: Failures = {};
  public failMkdirPath: string | undefined;
  public config = [
    'hostname: jellyfin',
    `description: hacm-managed: ${uuid}`,
    'tags: hacm-managed',
    'rootfs: local-lvm:vm-112-disk-0,size=10G',
    'mp0: /opt/server-data/pve-01/jellyfin/opt,backup=1,mp=/opt',
  ].join('\n');
  public status = 'running';
  public hostSummary = 'exists=1\nfiles=2\nbytes=42\nnewest=1762752000\n';
  public rootfsSummary = 'probe=bind\nexists=0\nfiles=0\nbytes=0\n';
  public pvesmOutput = `Volid Format Type Size VMID\n${volid} tar zst 1.17 GiB 112\n`;

  public async exec(
    argv: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    this.calls.push([...argv]);
    if (options?.timeoutMs !== undefined) {
      options.onOutput?.('stdout', `${argv[0]} output`);
    }
    const [command, ...args] = argv;
    switch (command) {
      case 'pvesm':
        if (this.failures.list) return fail(1, 'storage offline');
        return ok(this.pvesmOutput);
      case 'pct':
        return this.pct(args);
      case 'qm':
        return this.qm(args);
      case 'test':
        return this.test(args);
      case 'mv':
        if (this.failures.mv) return fail(1, 'cannot move');
        if (!this.dirs.has(args[0]!)) return fail(1, 'missing');
        this.dirs.delete(args[0]!);
        this.dirs.add(args[1]!);
        return ok();
      case 'mkdir':
        if (
          this.failures.mkdir &&
          (this.failMkdirPath === undefined ||
            this.failMkdirPath === args.at(-1))
        ) {
          return fail(1, 'cannot create');
        }
        this.dirs.add(args.at(-1)!);
        return ok();
      case 'touch':
        if (this.failures.touch) return fail(1, 'cannot touch');
        this.markers.add(args[0]!);
        return ok();
      case 'rsync':
        if (this.failures.rsync) return fail(1, 'rsync failed');
        this.dirs.add(args.at(-1)!.replace(/\/$/, ''));
        return ok();
      case 'restic':
        if (this.failures.restic) return fail(1, 'restic failed');
        this.dirs.add(args[args.indexOf('--target') + 1]!);
        return ok();
      case 'lxc-info':
        return ok('4242\n');
      case 'nsenter':
        return this.nsenter(args);
      case 'bash':
        return this.bash(args);
      default:
        throw new Error(`unexpected command: ${argv.join(' ')}`);
    }
  }

  public async readFile(): Promise<string> {
    throw new Error('not used');
  }

  public async writeFile(): Promise<void> {
    throw new Error('not used');
  }

  private pct(args: readonly string[]): ExecResult {
    const [action, vmid] = args;
    if (vmid !== '112' && action !== 'restore') return fail(1, 'no guest');
    switch (action) {
      case 'status':
        if (!this.guestExists) return fail(1, 'no guest');
        return ok(`status: ${this.running ? 'running' : 'stopped'}\n`);
      case 'config':
        return this.guestExists ? ok(this.config) : fail(1, 'no guest');
      case 'stop':
        if (this.failures.stop) return fail(1, 'stop failed');
        this.running = false;
        return ok();
      case 'destroy':
        if (this.failures.destroy) return fail(1, 'destroy failed');
        this.guestExists = false;
        this.running = false;
        return ok();
      case 'restore':
        if (this.failures.restore) return fail(1, 'restore failed');
        this.guestExists = true;
        this.running = false;
        return ok();
      case 'start':
        if (this.failures.start) return fail(1, 'start failed');
        this.running = true;
        return ok();
      default:
        throw new Error(`unexpected pct ${action}`);
    }
  }

  private qm(args: readonly string[]): ExecResult {
    const [action] = args;
    switch (action) {
      case 'status':
        if (!this.guestExists) return fail(1, 'no guest');
        return ok(`status: ${this.running ? 'running' : 'stopped'}\n`);
      case 'config':
        return this.guestExists ? ok(this.config) : fail(1, 'no guest');
      case 'stop':
        if (this.failures.stop) return fail(1, 'stop failed');
        this.running = false;
        return ok();
      case 'destroy':
        if (this.failures.destroy) return fail(1, 'destroy failed');
        this.guestExists = false;
        return ok();
      case 'start':
        if (this.failures.start) return fail(1, 'start failed');
        this.running = true;
        return ok();
      default:
        throw new Error(`unexpected qm ${action}`);
    }
  }

  private test(args: readonly string[]): ExecResult {
    const [flag, path] = args;
    if (path === '/etc/pve/local/lxc/112.conf') {
      return this.guestExists ? ok() : fail(1);
    }
    if (path === '/etc/pve/local/qemu-server/300.conf') {
      return this.guestExists ? ok() : fail(1);
    }
    if (flag === '-f') return this.markers.has(path!) ? ok() : fail(1);
    if (flag === '-d') return this.dirs.has(path!) ? ok() : fail(1);
    return fail(2);
  }

  private bash(args: readonly string[]): ExecResult {
    if (args[0] === '-s') {
      if (args[2] === '/opt/server-data/pve-01/jellyfin/opt') {
        return ok(this.hostSummary);
      }
      return ok('');
    }
    return ok('');
  }

  private nsenter(args: readonly string[]): ExecResult {
    if (args.includes('mountpoint')) return ok();
    return ok(this.rootfsSummary);
  }
}

describe('vzdump volume parsing', () => {
  it('parses LXC and VM volume IDs with their timestamp', () => {
    expect(parseVzdumpVolume(volid)).toEqual({
      volid,
      storage: 'backup-store',
      type: 'lxc',
      vmid: 112,
      createdAt: '2026-11-10T12:34:56.000Z',
    });
    expect(parseVzdumpVolume(vmVolid)).toMatchObject({
      type: 'vm',
      vmid: 300,
    });
  });

  it('rejects malformed or non-vzdump volumes', () => {
    expect(
      parseVzdumpVolume('backup-store:backup/other.tar.zst'),
    ).toBeUndefined();
    expect(
      parseVzdumpVolume('vzdump-lxc-112-2026_11_10-12_34_56.tar.zst'),
    ).toBeUndefined();
    expect(
      parseVzdumpVolume(':backup/vzdump-lxc-112-2026_11_10-12_34_56.tar.zst'),
    ).toBeUndefined();
    expect(
      parseVzdumpVolume('store:vzdump-disk-1-2026_11_10-12_34_56.tar'),
    ).toBeUndefined();
  });

  it('parses pvesm list output with and without a VMID column', () => {
    const parsed = parsePvesmList(
      [
        'Volid Format Type Size VMID',
        `${volid} tar zst 1.17 GiB 112`,
        `${vmVolid} vma zst 2.00 GiB 300`,
        'backup-store:backup/not-a-guest.tar 118 B',
        '',
      ].join('\n'),
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      vmid: 112,
      format: 'tar',
      size: '1.17 GiB',
    });
    expect(parsed[1]).toMatchObject({ vmid: 300, size: '2.00 GiB' });

    const withoutVmid = parsePvesmList(`${volid} tar zst 1.17 GiB\n`);
    expect(withoutVmid[0]).toMatchObject({ vmid: 112, size: '1.17 GiB' });
  });

  it('skips a row whose VMID column contradicts the volume name', () => {
    expect(parsePvesmList(`${volid} tar zst 1.17 GiB 999\n`)).toEqual([]);
  });
});

describe('listGuestBackups', () => {
  it('lists matching backups newest first', async () => {
    const transport = new RestoreHostTransport();
    transport.pvesmOutput = [
      'Volid Format Type Size VMID',
      'backup-store:backup/vzdump-lxc-112-2026_11_09-10_00_00.tar.zst tar zst 1 GiB 112',
      `${volid} tar zst 1 GiB 112`,
      `${vmVolid} vma zst 1 GiB 300`,
      'backup-store:backup/vzdump-lxc-113-2026_11_10-12_34_56.tar.zst tar zst 1 GiB 113',
    ].join('\n');
    const backups = await listGuestBackups(
      transport,
      {
        vmid: 112,
        type: 'lxc',
      },
      { storage: 'backup-store' },
    );
    expect(backups.map((entry) => entry.createdAt)).toEqual([
      '2026-11-10T12:34:56.000Z',
      '2026-11-09T10:00:00.000Z',
    ]);
    expect(transport.calls).toEqual([['pvesm', 'list', 'backup-store']]);
  });

  it('uses the deployment storage and rejects missing storage', async () => {
    const transport = new RestoreHostTransport();
    await expect(
      listGuestBackups(transport, { vmid: 112, type: 'lxc' }),
    ).rejects.toThrow(/backup storage is required/);

    await listGuestBackups(transport, {
      vmid: 112,
      type: 'lxc',
      backup_storage: 'backup-store',
    });
    expect(transport.calls).toEqual([['pvesm', 'list', 'backup-store']]);
  });

  it('reports listing failures', async () => {
    const transport = new RestoreHostTransport();
    transport.failures.list = true;
    await expect(
      listGuestBackups(
        transport,
        { vmid: 112, type: 'lxc' },
        { storage: 'backup-store' },
      ),
    ).rejects.toThrow(
      /Could not list backups on storage 'backup-store': storage offline/,
    );
  });
});

describe('restore argv', () => {
  it('builds pct restore and qmrestore commands', () => {
    expect(guestRestoreArgv(target(), { volid })).toEqual([
      'pct',
      'restore',
      '112',
      volid,
    ]);
    expect(
      guestRestoreArgv(target(), { volid }, { storage: 'fast-local' }),
    ).toEqual(['pct', 'restore', '112', volid, '--storage', 'fast-local']);
    expect(
      guestRestoreArgv(target({ type: 'vm', vmid: 300, name: 'app-vm' }), {
        volid: vmVolid,
      }),
    ).toEqual(['qmrestore', vmVolid, '300']);
  });

  it('rejects backups from another guest or type', () => {
    expect(() => guestRestoreArgv(target(), { volid: vmVolid })).toThrow(
      /is a VM archive/,
    );
    expect(() => guestRestoreArgv(target({ vmid: 113 }), { volid })).toThrow(
      /belongs to VMID 112, not 113/,
    );
    expect(() =>
      guestRestoreArgv(target(), { volid: 'store:not-a-backup' }),
    ).toThrow(/not a vzdump backup volume ID/);
  });

  it('validates the target identity', () => {
    expect(() => guestRestoreArgv(target({ hostId: ' ' }), { volid })).toThrow(
      /hostId must not be empty/,
    );
    expect(() => guestRestoreArgv(target({ vmid: 0 }), { volid })).toThrow(
      /not a positive integer/,
    );
    expect(() => guestRestoreArgv(target({ name: ' ' }), { volid })).toThrow(
      /name must not be empty/,
    );
    expect(() =>
      guestRestoreArgv(target({ type: 'docker' as 'lxc' }), { volid }),
    ).toThrow(/Guest type must be 'lxc' or 'vm'/);
  });
});

describe('planGuestRestore', () => {
  it('plans a fresh restore with start and typed confirmation', () => {
    const plan = planGuestRestore(target(), { volid }, { now });
    expect(plan.summary).toBe(
      'Restore LXC 112 (jellyfin) from backup-store:backup/vzdump-lxc-112-2026_11_10-12_34_56.tar.zst on pve-01',
    );
    expect(plan.requiredConfirmation).toBe('RESTORE 112');
    expect(plan.blocked).toBe(false);
    expect(plan.destructive).toBe(true);
    expect(plan.changes.map((change) => change.id)).toEqual([
      'restore',
      'start',
    ]);
    expect(plan.commands).toEqual([
      ['pct', 'restore', '112', volid],
      ['pct', 'start', '112'],
    ]);
    expect(plan.warnings).toEqual([
      'The restored guest is started and then identity-checked.',
    ]);
    expect(plan.target).toMatchObject({
      exists: false,
      protection: false,
      status: 'stopped',
    });
  });

  it('stops and destroys an existing guest when overwrite is enabled', () => {
    const plan = planGuestRestore(
      target({ exists: true, status: 'running' }),
      { volid },
      { now, overwrite: true },
    );
    expect(plan.changes.map((change) => change.id)).toEqual([
      'stop',
      'destroy',
      'restore',
      'start',
    ]);
    expect(
      plan.changes.find((change) => change.id === 'destroy'),
    ).toMatchObject({ action: 'delete', destructive: true });
    expect(plan.commands).toEqual([
      ['pct', 'stop', '112'],
      ['pct', 'destroy', '112', '--purge', '1'],
      ['pct', 'restore', '112', volid],
      ['pct', 'start', '112'],
    ]);
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('stopped before it is restored'),
        expect.stringContaining('destroyed before the restore'),
      ]),
    );
  });

  it('uses qm destroy options for VM overwrites', () => {
    const plan = planGuestRestore(
      target({
        type: 'vm',
        vmid: 300,
        name: 'app-vm',
        exists: true,
        status: 'running',
      }),
      { volid: vmVolid },
      { overwrite: true },
    );
    expect(plan.commands[1]).toEqual([
      'qm',
      'destroy',
      '300',
      '--purge',
      '1',
      '--destroy-unreferenced-disks',
      '1',
    ]);
    expect(plan.commands[2]).toEqual(['qmrestore', vmVolid, '300']);
  });

  it('blocks an existing guest without overwrite', () => {
    const plan = planGuestRestore(target({ exists: true }), { volid });
    expect(plan.blocked).toBe(true);
    expect(plan.blockReason).toMatch(/already exists/);
    expect(plan.changes).toEqual([]);
    expect(plan.commands).toEqual([]);
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('left untouched until overwrite'),
      ]),
    );
  });

  it('blocks a protected guest until unprotect is explicit', () => {
    const blocked = planGuestRestore(
      target({ exists: true, protection: true }),
      { volid },
      { overwrite: true },
    );
    expect(blocked.blocked).toBe(true);
    expect(blocked.blockReason).toMatch(/protection enabled/);
    expect(blocked.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Protection blocks')]),
    );

    const allowed = planGuestRestore(
      target({ exists: true, protection: true }),
      { volid },
      { overwrite: true, unprotect: true },
    );
    expect(allowed.blocked).toBe(false);
  });

  it('warns about rootfs and mp0 data mismatch', () => {
    const plan = planGuestRestore(
      target({
        mounts: [
          {
            index: 0,
            host_path: '/opt/server-data/pve-01/jellyfin/opt',
            guest_path: '/opt',
            backup: true,
          },
          {
            index: 1,
            host_path: '/srv/skip',
            guest_path: '/skip',
            backup: false,
          },
        ],
      }),
      { volid },
      { now },
    );
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('contains the rootfs only'),
        expect.stringContaining(
          "Host data '/opt/server-data/pve-01/jellyfin/opt' (mp0 at '/opt') is not covered",
        ),
        expect.stringContaining("Host data '/srv/skip' was excluded"),
      ]),
    );
  });

  it('covers matching host data and warns for undeclared paths', () => {
    const plan = planGuestRestore(
      target({
        mounts: [
          {
            index: 0,
            host_path: '/opt/server-data/pve-01/jellyfin/opt',
            guest_path: '/opt',
            backup: true,
          },
        ],
      }),
      { volid },
      {
        now,
        hostData: [
          {
            hostPath: '/opt/server-data/pve-01/jellyfin/opt',
            method: 'rsync',
            target: '/var/backups/hacm/opt-112_2026-11-09_10-00-00',
          },
          {
            hostPath: '/srv/extra',
            method: 'snapshot',
            target: '/snapshots/extra',
          },
        ],
      },
    );
    expect(plan.warnings).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Host data '/opt/server-data/pve-01/jellyfin/opt' (mp0",
        ),
      ]),
    );
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Host data '/srv/extra' is not declared"),
        expect.stringContaining('moved to a timestamped path'),
      ]),
    );
    expect(plan.changes.map((change) => change.id)).toEqual([
      'restore',
      'restore-host-data-0',
      'restore-host-data-1',
      'start',
    ]);
  });

  it('warns that VM mounts are ignored', () => {
    const plan = planGuestRestore(
      target({
        type: 'vm',
        vmid: 300,
        name: 'app-vm',
        mounts: [
          {
            index: 0,
            host_path: '/srv/unused',
            guest_path: '/data',
          },
        ],
      }),
      { volid: vmVolid },
    );
    expect(plan.warnings).toEqual([
      'VMs have no bind-mounted host data; mounts were ignored for this restore.',
      'The restored guest is started and then identity-checked.',
    ]);
  });

  it('adds the storage override to the restore change', () => {
    const plan = planGuestRestore(
      target(),
      { volid },
      { storage: 'fast-local' },
    );
    expect(plan.restoreArgv.slice(-2)).toEqual(['--storage', 'fast-local']);
    expect(plan.changes[0]?.after).toEqual({
      volid,
      storage: 'fast-local',
    });
  });
});

describe('host data restore plans', () => {
  it('displaces current data before an rsync copy', () => {
    const entry = planHostDataRestore(
      {
        hostPath: '/srv/data',
        method: 'rsync',
        target: '/var/backups/hacm/srv-data-112_2026-11-09_10-00-00',
      },
      { now, backupRoot: '/backups' },
    );
    expect(entry.displacedPath).toBe(
      '/backups/srv-data-before-restore-2026-11-10_12-34-56',
    );
    expect(entry.markerPath).toBe(
      '/backups/.restore-srv-data-2026-11-10_12-34-56.done',
    );
    expect(entry.source).toBe(
      '/var/backups/hacm/srv-data-112_2026-11-09_10-00-00',
    );
    expect(entry.restoreCommands).toEqual([
      [
        'rsync',
        '-aAXH',
        '--numeric-ids',
        '/var/backups/hacm/srv-data-112_2026-11-09_10-00-00/',
        '/srv/data/',
      ],
    ]);
    expect(entry.commands).toEqual([
      ['mkdir', '-p', '/backups'],
      ['mv', '/srv/data', entry.displacedPath],
      ['mkdir', '-p', '/srv/data'],
      ...entry.restoreCommands,
      ['touch', entry.markerPath],
    ]);
  });

  it('reads ZFS snapshots from the hidden .zfs directory', () => {
    expect(
      hostDataRestoreSource({
        hostPath: '/srv/data',
        method: 'snapshot',
        target: 'tank/apps/jellyfin@hacm-112_2026-11-10_12-34-56',
      }),
    ).toBe('/tank/apps/jellyfin/.zfs/snapshot/hacm-112_2026-11-10_12-34-56');
    expect(
      hostDataRestoreSource({
        hostPath: '/srv/data',
        method: 'snapshot',
        target: '/snapshots/data-112',
        filesystem: 'btrfs',
      }),
    ).toBe('/snapshots/data-112');
    expect(
      hostDataRestoreSource({
        hostPath: '/srv/data',
        method: 'rsync',
        target: '/copies/data',
      }),
    ).toBe('/copies/data');
    expect(() =>
      hostDataRestoreSource({
        hostPath: '/srv/data',
        method: 'snapshot',
        target: 'tank/apps',
        filesystem: 'zfs',
      }),
    ).toThrow(/has no '@snapshot' suffix/);
  });

  it('restores restic snapshots through a staging directory', () => {
    const entry = planHostDataRestore(
      {
        hostPath: '/srv/data',
        method: 'restic',
        target: 's3:https://backup.example/bucket#pre-update',
        restic: {
          repository: 's3:https://backup.example/bucket',
          passwordFile: '/etc/restic.pass',
        },
        resticTag: 'pre-update',
      },
      { now, backupRoot: '/backups', index: 2 },
    );
    expect(entry.stagingPath).toBe(
      '/backups/restore-srv-data-2026-11-10_12-34-56-2',
    );
    expect(entry.restoreCommands).toEqual([
      ['mkdir', '-p', entry.stagingPath],
      [
        'restic',
        '-r',
        's3:https://backup.example/bucket',
        '--password-file',
        '/etc/restic.pass',
        'restore',
        'latest',
        '--tag',
        'pre-update',
        '--target',
        entry.stagingPath,
      ],
      [
        'rsync',
        '-aAXH',
        '--numeric-ids',
        `${entry.stagingPath}/srv/data/`,
        '/srv/data/',
      ],
    ]);
  });

  it('omits optional restic arguments', () => {
    const entry = planHostDataRestore(
      {
        hostPath: '/srv/data',
        method: 'restic',
        target: '/repository',
        restic: { repository: '/repository' },
      },
      { now },
    );
    expect(entry.restoreCommands[1]).toEqual([
      'restic',
      '-r',
      '/repository',
      'restore',
      'latest',
      '--target',
      entry.stagingPath,
    ]);
  });

  it('rejects unsafe or incomplete entries', () => {
    expect(() =>
      planHostDataRestore(
        { hostPath: 'relative', method: 'rsync', target: '/copy' },
        { now },
      ),
    ).toThrow(/must be absolute/);
    expect(() =>
      planHostDataRestore(
        { hostPath: '/srv/data', method: 'restic', target: '/repository' },
        { now },
      ),
    ).toThrow(/requires a repository/);
    expect(() =>
      planGuestRestore(
        target(),
        { volid },
        {
          now,
          hostData: [
            { hostPath: '/srv/data', method: 'restic', target: '/repository' },
          ],
        },
      ),
    ).toThrow(/requires a repository/);
  });
});

describe('createRestoreMutationPlan', () => {
  it('requires the exact typed confirmation', () => {
    const plan = planGuestRestore(target(), { volid }, { now });
    expect(() =>
      createRestoreMutationPlan({
        plan,
        planId: 'plan-1',
        confirmationText: 'restore 112',
        createdAt: now,
      }),
    ).toThrow(/must be exactly 'RESTORE 112'/);

    const mutation = createRestoreMutationPlan({
      plan,
      planId: 'plan-1',
      confirmationText: 'RESTORE 112',
      createdAt: now,
    });
    expect(mutation).toMatchObject({
      id: 'plan-1',
      operation: 'restore',
      destructive: true,
      confirmationText: 'RESTORE 112',
      target: { hostId: 'pve-01', vmid: 112, resourceType: 'guest' },
    });
    expect(mutation.changes.map((change) => change.id)).toEqual([
      'restore',
      'start',
    ]);
  });

  it('rejects blocked restore plans', () => {
    const plan = planGuestRestore(target({ exists: true }), { volid });
    expect(() =>
      createRestoreMutationPlan({
        plan,
        planId: 'plan-1',
        confirmationText: 'RESTORE 112',
      }),
    ).toThrow(/already exists/);
  });
});

describe('verifyRestoredIdentity', () => {
  it('accepts a correctly stamped guest', async () => {
    const transport = new RestoreHostTransport();
    transport.guestExists = true;
    await expect(
      verifyRestoredIdentity(transport, target()),
    ).resolves.toMatchObject({ status: 'verified', ok: true });
  });

  it('reports a name mismatch', async () => {
    const transport = new RestoreHostTransport();
    transport.guestExists = true;
    transport.config = transport.config.replace(
      'hostname: jellyfin',
      'hostname: other',
    );
    await expect(
      verifyRestoredIdentity(transport, target()),
    ).resolves.toMatchObject({ status: 'name-mismatch', ok: false });
  });

  it('reports an unstamped guest', async () => {
    const transport = new RestoreHostTransport();
    transport.guestExists = true;
    transport.config = 'hostname: jellyfin\ntags: \n';
    await expect(
      verifyRestoredIdentity(transport, target()),
    ).resolves.toMatchObject({ status: 'unmanaged', ok: false });
  });

  it('rejects a missing name or unreadable config', async () => {
    const transport = new RestoreHostTransport();
    transport.guestExists = true;
    transport.config = 'tags: hacm-managed';
    await expect(verifyRestoredIdentity(transport, target())).rejects.toThrow(
      /has no name/,
    );

    const missing = new RestoreHostTransport();
    await expect(verifyRestoredIdentity(missing, target())).rejects.toThrow(
      /Failed to read the configuration/,
    );
  });

  it('reads VM names from the qemu config', async () => {
    const transport = new RestoreHostTransport();
    transport.guestExists = true;
    transport.config = [
      'name: app-vm',
      `description: hacm-managed: ${managedGuestUuid('pve-01', 300)}`,
      'tags: hacm-managed',
    ].join('\n');
    const vmTarget = target({ type: 'vm', vmid: 300, name: 'app-vm' });
    // The fake only knows LXC paths, so read the config through qm directly.
    transport.exec = async (argv) =>
      argv[0] === 'qm' && argv[1] === 'config' ? ok(transport.config) : fail(1);
    await expect(
      verifyRestoredIdentity(transport, vmTarget),
    ).resolves.toMatchObject({ status: 'verified' });
  });
});

describe('verifyRestoredInvariants', () => {
  const deployment = {
    schema_version: 1,
    id: 112,
    name: 'jellyfin',
    type: 'lxc',
    cpu: 2,
    ram: 1024,
    disks: [{ name: 'rootfs', storage: 'local-lvm', size_gb: 10 }],
    network: [{ index: 0, name: 'eth0', bridge: 'vmbr0' }],
    mounts: [
      {
        index: 0,
        host_path: '/opt/server-data/pve-01/jellyfin/opt',
        guest_path: '/opt',
        permissions: 'minimal',
      },
    ],
  } satisfies GuestDeployment;

  it('returns an ok report', async () => {
    const transport = new RestoreHostTransport();
    transport.guestExists = true;
    transport.running = true;
    const report = await verifyRestoredInvariants(deployment, transport, {
      hostId: 'pve-01',
      pid: 4242,
      now: () => now,
    });
    expect(report.status).toBe('ok');
  });

  it('rejects unsafe storage states', async () => {
    const transport = new RestoreHostTransport();
    transport.guestExists = true;
    transport.running = true;
    transport.hostSummary = 'exists=0\nfiles=0\nbytes=0\n';
    transport.rootfsSummary = 'probe=bind\nexists=1\nfiles=2\nbytes=42\n';
    await expect(
      verifyRestoredInvariants(deployment, transport, {
        hostId: 'pve-01',
        pid: 4242,
        now: () => now,
      }),
    ).rejects.toThrow(/Post-restore storage check failed/);
  });

  it('rejects non-LXC guests and missing host IDs', async () => {
    const transport = new RestoreHostTransport();
    const vm = {
      ...deployment,
      type: 'vm',
      mounts: [],
    } as unknown as typeof deployment;
    await expect(
      verifyRestoredInvariants(vm, transport, { hostId: 'pve-01' }),
    ).rejects.toThrow(/only apply to LXC guests/);
    await expect(
      verifyRestoredInvariants(deployment, transport, {} as { hostId: string }),
    ).rejects.toThrow(/hostId is required/);
  });
});

describe('createGuestRestoreSteps', () => {
  const deployment = {
    schema_version: 1,
    id: 112,
    name: 'jellyfin',
    type: 'lxc',
    cpu: 2,
    ram: 1024,
    disks: [{ name: 'rootfs', storage: 'local-lvm', size_gb: 10 }],
    network: [{ index: 0, name: 'eth0', bridge: 'vmbr0' }],
    mounts: [
      {
        index: 0,
        host_path: '/opt/server-data/pve-01/jellyfin/opt',
        guest_path: '/opt',
        permissions: 'minimal',
      },
    ],
  } satisfies GuestDeployment;

  it('runs restore, host data, start, identity and invariant checks in order', async () => {
    const transport = new RestoreHostTransport();
    transport.dirs.add('/opt/server-data/pve-01/jellyfin/opt');
    const plan = planGuestRestore(
      target({
        mounts: [
          {
            index: 0,
            host_path: '/opt/server-data/pve-01/jellyfin/opt',
            guest_path: '/opt',
          },
        ],
      }),
      { volid },
      {
        now,
        hostData: [
          {
            hostPath: '/opt/server-data/pve-01/jellyfin/opt',
            method: 'rsync',
            target: '/var/backups/hacm/jellyfin-112_2026-11-09_10-00-00',
          },
        ],
      },
    );
    const steps = createGuestRestoreSteps(plan, {
      deployment,
      invariantOptions: { pid: 4242, now: () => now },
    });
    expect(steps.map((step) => step.name)).toEqual([
      'restore LXC 112 from backup-store:backup/vzdump-lxc-112-2026_11_10-12_34_56.tar.zst',
      "restore host data '/opt/server-data/pve-01/jellyfin/opt' from rsync",
      'start LXC 112 after restore',
      'verify the identity of restored LXC 112',
      'verify storage invariants of restored LXC 112',
    ]);

    const result = await runJournaledSteps({
      ...context(transport),
      steps,
      journal: new MemoryStepJournal(),
    });
    expect(result.entries.map((entry) => entry.status)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
      'completed',
    ]);
    expect(transport.guestExists).toBe(true);
    expect(transport.running).toBe(true);
    expect(transport.dirs.has('/opt/server-data/pve-01/jellyfin/opt')).toBe(
      true,
    );
    expect(
      transport.dirs.has(
        '/var/backups/hacm/opt-server-data-pve-01-jellyfin-opt-before-restore-2026-11-10_12-34-56',
      ),
    ).toBe(true);
    expect(transport.markers.size).toBe(1);
    expect(transport.calls.map((argv) => argv[0])).toContain('pct');
    expect(transport.calls.some((argv) => argv[0] === 'rsync')).toBe(true);
  });

  it('stops and destroys an existing guest first', async () => {
    const transport = new RestoreHostTransport();
    transport.guestExists = true;
    transport.running = true;
    const plan = planGuestRestore(
      target({ exists: true, status: 'running' }),
      { volid },
      { overwrite: true, now },
    );
    const steps = createGuestRestoreSteps(plan);
    const result = await runJournaledSteps({
      ...context(transport),
      steps,
      journal: new MemoryStepJournal(),
    });
    expect(result.entries.map((entry) => entry.name)).toEqual([
      'stop LXC 112 before restore',
      'destroy LXC 112 before restore',
      'restore LXC 112 from backup-store:backup/vzdump-lxc-112-2026_11_10-12_34_56.tar.zst',
      'start LXC 112 after restore',
      'verify the identity of restored LXC 112',
    ]);
    const commands = transport.calls.map((argv) => argv.slice(0, 2).join(' '));
    expect(commands).toEqual(
      expect.arrayContaining([
        'pct status',
        'pct stop',
        'pct destroy',
        'pct restore',
        'pct start',
      ]),
    );
    expect(transport.running).toBe(true);
  });

  it('skips host data when its marker exists', async () => {
    const transport = new RestoreHostTransport();
    const plan = planGuestRestore(
      target(),
      { volid },
      {
        now,
        hostData: [
          {
            hostPath: '/srv/data',
            method: 'rsync',
            target: '/backups/data',
          },
        ],
      },
    );
    transport.markers.add(plan.hostData[0]!.markerPath);
    const step = createGuestRestoreSteps(plan)[1]!;
    await expect(step.check(context(transport))).resolves.toMatchObject({
      status: 'satisfied',
    });
  });

  it('rejects blocked plans', () => {
    const plan = planGuestRestore(target({ exists: true }), { volid });
    expect(() => createGuestRestoreSteps(plan)).toThrow(/already exists/);
  });

  it('fails when the restore command fails', async () => {
    const transport = new RestoreHostTransport();
    transport.failures.restore = true;
    const plan = planGuestRestore(target(), { volid }, { now });
    const steps = createGuestRestoreSteps(plan);
    await expect(
      runJournaledSteps({
        ...context(transport),
        steps,
        journal: new MemoryStepJournal(),
      }),
    ).rejects.toThrow(/Restoring LXC 112 failed: restore failed/);
  });

  it('reports stop, destroy and start failures', async () => {
    for (const failure of ['stop', 'destroy', 'start'] as const) {
      const transport = new RestoreHostTransport();
      transport.guestExists = true;
      transport.running = true;
      transport.failures[failure] = true;
      const plan = planGuestRestore(
        target({ exists: true }),
        { volid },
        { overwrite: true, now },
      );
      const steps = createGuestRestoreSteps(plan);
      await expect(
        runJournaledSteps({
          ...context(transport),
          steps,
          journal: new MemoryStepJournal(),
        }),
      ).rejects.toThrow(/failed/);
    }
  });

  it('fails when the restored identity is wrong', async () => {
    const transport = new RestoreHostTransport();
    transport.config = transport.config.replace(
      `hacm-managed: ${uuid}`,
      'hacm-managed: 00000000-0000-5000-8000-000000000000',
    );
    const plan = planGuestRestore(target(), { volid }, { now });
    await expect(
      runJournaledSteps({
        ...context(transport),
        steps: createGuestRestoreSteps(plan),
        journal: new MemoryStepJournal(),
      }),
    ).rejects.toThrow(/Post-restore identity check failed/);
  });

  it('fails when host data cannot be displaced or copied', async () => {
    for (const failure of ['mv', 'rsync', 'mkdir', 'touch'] as const) {
      const transport = new RestoreHostTransport();
      transport.dirs.add('/srv/data');
      transport.failures[failure] = true;
      const plan = planGuestRestore(
        target(),
        { volid },
        {
          now,
          hostData: [
            {
              hostPath: '/srv/data',
              method: 'rsync',
              target: '/backups/data',
            },
          ],
        },
      );
      const step = createGuestRestoreSteps(plan)[1]!;
      await expect(step.apply(context(transport))).rejects.toThrow(/failed/);
    }
  });

  it('fails when the restore did not create a config', async () => {
    const transport = new RestoreHostTransport();
    const plan = planGuestRestore(target(), { volid }, { now });
    const step = createGuestRestoreSteps(plan)[0]!;
    await expect(step.verify(context(transport))).rejects.toThrow(
      /has no configuration after the restore/,
    );
  });

  it('fails verification when the guest or marker is missing', async () => {
    const transport = new RestoreHostTransport();
    const plan = planGuestRestore(
      target(),
      { volid },
      {
        now,
        hostData: [
          { hostPath: '/srv/data', method: 'rsync', target: '/backups/data' },
        ],
      },
    );
    const steps = createGuestRestoreSteps(plan);
    await expect(steps[1]!.verify(context(transport))).rejects.toThrow(
      /was not restored/,
    );
    await expect(steps[2]!.verify(context(transport))).rejects.toThrow(
      /is not running after the restore/,
    );

    const destroyTransport = new RestoreHostTransport();
    destroyTransport.guestExists = true;
    const overwrite = planGuestRestore(
      target({ exists: true }),
      { volid },
      { overwrite: true, now },
    );
    await expect(
      createGuestRestoreSteps(overwrite)[1]!.verify(context(destroyTransport)),
    ).rejects.toThrow(/still exists after it was destroyed/);
  });

  it('does not mutate during a dry run', async () => {
    const transport = new RestoreHostTransport();
    const plan = planGuestRestore(target(), { volid }, { now });
    const result = await runJournaledSteps({
      ...context(transport, true),
      steps: createGuestRestoreSteps(plan),
      journal: new MemoryStepJournal(),
    });
    expect(result.entries.every((entry) => entry.status === 'skipped')).toBe(
      true,
    );
    expect(transport.guestExists).toBe(false);
    expect(
      transport.calls.some((argv) =>
        ['restore', 'start', 'stop', 'destroy'].includes(argv[1] ?? ''),
      ),
    ).toBe(false);
  });
});

describe('restore edge branches', () => {
  it('resolves VM config paths', () => {
    expect(guestConfigPath('vm', 300)).toBe(
      '/etc/pve/local/qemu-server/300.conf',
    );
  });

  it('parses rows without optional format and size columns', () => {
    const parsed = parsePvesmList(
      'backup-store:backup/vzdump-lxc-112-2026_11_10-12_34_56.tar.zst\n',
    );
    expect(parsed[0]).toMatchObject({ vmid: 112 });
    expect(parsed[0]?.format).toBeUndefined();
    expect(parsed[0]?.size).toBeUndefined();
  });

  it('falls back to the exit code when listing has no stderr', async () => {
    const transport = new RestoreHostTransport();
    transport.exec = async () => fail(1);
    await expect(
      listGuestBackups(
        transport,
        { vmid: 112, type: 'lxc' },
        { storage: 'backup-store' },
      ),
    ).rejects.toThrow(/exit code 1/);
  });

  it('uses the default clock and backup root', () => {
    const entry = planHostDataRestore({
      hostPath: '/srv/data',
      method: 'rsync',
      target: '/copies/data',
    });
    expect(entry.displacedPath).toMatch(
      /^\/var\/backups\/hacm\/srv-data-before-restore-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/,
    );
  });

  it('defaults optional target state and destructive warnings', () => {
    const plan = planGuestRestore(
      { hostId: 'pve-01', vmid: 112, type: 'lxc', name: 'jellyfin' },
      { volid },
      {
        backupRoot: '/backups',
        hostData: [
          {
            hostPath: '/srv/data',
            method: 'rsync',
            target: '/copies/data',
          },
        ],
      },
    );
    expect(plan.target).toMatchObject({
      exists: true,
      protection: false,
    });
    expect(plan.target.status).toBeUndefined();
    expect(plan.hostData[0]?.displacedPath).toContain('/backups/');

    const overwrite = planGuestRestore(
      {
        hostId: 'pve-01',
        vmid: 112,
        type: 'lxc',
        name: 'jellyfin',
        exists: true,
      },
      { volid },
      { overwrite: true },
    );
    expect(
      overwrite.changes.find((change) => change.id === 'destroy')?.before,
    ).toMatchObject({ status: 'unknown' });
  });

  it('warns about a mount without an explicit index', () => {
    const plan = planGuestRestore(
      {
        hostId: 'pve-01',
        vmid: 112,
        type: 'lxc',
        name: 'jellyfin',
        exists: false,
        mounts: [
          {
            host_path: '/srv/data',
            guest_path: '/data',
          },
        ],
      },
      { volid },
    );
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("(mp0 at '/data') is not covered"),
      ]),
    );
  });

  it('fingerprints host data when creating the mutation plan', () => {
    const plan = planGuestRestore(
      target(),
      { volid },
      {
        now,
        hostData: [
          { hostPath: '/srv/data', method: 'rsync', target: '/copies/data' },
        ],
      },
    );
    const mutation = createRestoreMutationPlan({
      plan,
      planId: 'plan-1',
      confirmationText: 'RESTORE 112',
    });
    expect(mutation.stateFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a blocked plan without a reason', () => {
    const plan = planGuestRestore(target(), { volid }, { now });
    expect(() =>
      createGuestRestoreSteps({
        ...plan,
        blocked: true,
        blockReason: undefined,
      }),
    ).toThrow(/The restore plan is blocked/);
  });

  it('reports the identity check failure during verification', async () => {
    const transport = new RestoreHostTransport();
    transport.guestExists = true;
    transport.config = transport.config.replace(
      `hacm-managed: ${uuid}`,
      'hacm-managed: 00000000-0000-5000-8000-000000000000',
    );
    const plan = planGuestRestore(target(), { volid }, { now });
    const steps = createGuestRestoreSteps(plan);
    const identity = steps.find((step) =>
      step.name.startsWith('verify the identity'),
    )!;
    await expect(identity.verify(context(transport))).rejects.toThrow(
      /Post-restore identity check failed/,
    );
  });

  it('skips start and restore checks when already satisfied', async () => {
    const transport = new RestoreHostTransport();
    transport.guestExists = true;
    transport.running = true;
    const plan = planGuestRestore(
      target({ exists: true }),
      { volid },
      {
        overwrite: true,
        now,
      },
    );
    const steps = createGuestRestoreSteps(plan);
    const restore = steps.find((step) => step.name.startsWith('restore'))!;
    const start = steps.find((step) => step.name.startsWith('start'))!;
    await expect(restore.check(context(transport))).resolves.toMatchObject({
      status: 'satisfied',
    });
    await expect(start.check(context(transport))).resolves.toMatchObject({
      status: 'satisfied',
    });
  });

  it('copies host data even when the path did not exist beforehand', async () => {
    const transport = new RestoreHostTransport();
    const plan = planGuestRestore(
      target(),
      { volid },
      {
        now,
        hostData: [
          { hostPath: '/srv/data', method: 'rsync', target: '/copies/data' },
        ],
      },
    );
    const step = createGuestRestoreSteps(plan)[1]!;
    await step.apply(context(transport));
    expect(transport.dirs.has('/srv/data')).toBe(true);
    expect(transport.markers.size).toBe(1);
  });

  it('reports failure to recreate the host path', async () => {
    const transport = new RestoreHostTransport();
    transport.failures.mkdir = true;
    transport.failMkdirPath = '/srv/data';
    const plan = planGuestRestore(
      target(),
      { volid },
      {
        now,
        hostData: [
          { hostPath: '/srv/data', method: 'rsync', target: '/copies/data' },
        ],
      },
    );
    await expect(
      createGuestRestoreSteps(plan)[1]!.apply(context(transport)),
    ).rejects.toThrow(/Creating '\/srv\/data' failed/);
  });

  it('falls back to the exit code in command failures', async () => {
    const transport = new RestoreHostTransport();
    transport.exec = async (argv) => {
      if (argv[0] === 'test') return fail(1);
      if (argv[0] === 'pct' && argv[1] === 'restore') return fail(1);
      return ok();
    };
    const plan = planGuestRestore(target(), { volid }, { now });
    await expect(
      runJournaledSteps({
        ...context(transport),
        steps: createGuestRestoreSteps(plan),
        journal: new MemoryStepJournal(),
      }),
    ).rejects.toThrow(/exit code 1/);
  });

  it('falls back to the exit code when reading a config fails', async () => {
    const transport = new RestoreHostTransport();
    transport.exec = async (argv) =>
      argv[0] === 'pct' && argv[1] === 'config' ? fail(1) : ok();
    await expect(verifyRestoredIdentity(transport, target())).rejects.toThrow(
      /exit code 1/,
    );
  });

  it('treats a config without tags as unmanaged', async () => {
    const transport = new RestoreHostTransport();
    transport.guestExists = true;
    transport.config = `hostname: jellyfin\ndescription: hacm-managed: ${uuid}`;
    await expect(
      verifyRestoredIdentity(transport, target()),
    ).resolves.toMatchObject({ status: 'unmanaged' });
  });

  it('includes invariant warnings in failure messages', async () => {
    const transport = new RestoreHostTransport();
    transport.guestExists = true;
    transport.running = true;
    transport.hostSummary = 'exists=0\nfiles=0\nbytes=0\n';
    transport.rootfsSummary = 'probe=visible\nexists=1\nfiles=1\nbytes=1\n';
    const deployment = {
      schema_version: 1,
      id: 112,
      name: 'jellyfin',
      type: 'lxc',
      cpu: 2,
      ram: 1024,
      disks: [{ name: 'rootfs', storage: 'local-lvm', size_gb: 10 }],
      network: [{ index: 0, name: 'eth0', bridge: 'vmbr0' }],
      mounts: [
        {
          index: 0,
          host_path: '/opt/server-data/pve-01/jellyfin/opt',
          guest_path: '/opt',
          permissions: 'minimal',
        },
      ],
    } satisfies GuestDeployment;
    await expect(
      verifyRestoredInvariants(deployment, transport, {
        hostId: 'pve-01',
        pid: 4242,
        now: () => now,
      }),
    ).rejects.toThrow(/raw rootfs probe could not bind-mount/);
  });

  it('adds invariant checks with default options', () => {
    const deployment = {
      schema_version: 1,
      id: 112,
      name: 'jellyfin',
      type: 'lxc',
      cpu: 2,
      ram: 1024,
      disks: [{ name: 'rootfs', storage: 'local-lvm', size_gb: 10 }],
      network: [{ index: 0, name: 'eth0', bridge: 'vmbr0' }],
      mounts: [
        {
          index: 0,
          host_path: '/srv/data',
          guest_path: '/opt',
          permissions: 'minimal',
        },
      ],
    } satisfies GuestDeployment;
    const plan = planGuestRestore(target(), { volid }, { now });
    expect(
      createGuestRestoreSteps(plan, { deployment }).map((step) => step.name),
    ).toContain('verify storage invariants of restored LXC 112');
    expect(
      createGuestRestoreSteps(plan, {
        deployment: { ...deployment, type: 'vm' } as GuestDeployment,
      }).map((step) => step.name),
    ).not.toContain('verify storage invariants of restored LXC 112');
  });
});
