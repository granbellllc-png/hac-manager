import { describe, expect, it, vi } from 'vitest';
import { MemoryStepJournal } from '../steps/memory-journal.js';
import { runJournaledSteps } from '../steps/runner.js';
import type {
  JournaledStep,
  StepExecutionContext,
  StepLogger,
} from '../steps/types.js';
import type { ExecOptions, ExecResult, Transport } from '../transport/types.js';
import {
  backupLabel,
  backupSlug,
  createPreUpdateBackupSteps,
  DATA_PROTECTION_TIMEOUT_MS,
  DEFAULT_HOST_DATA_BACKUP_ROOT,
  formatBackupTimestamp,
  planPreUpdateBackup,
  preUpdateVzdumpArgv,
  type PreUpdateBackupGuest,
} from './pre-update.js';

const now = new Date('2026-11-10T12:34:56.000Z');
const label = '112_2026-11-10_12-34-56_jellyfin';

function guest(
  overrides: Partial<PreUpdateBackupGuest> = {},
): PreUpdateBackupGuest {
  return {
    hostId: 'pve-01',
    vmid: 112,
    type: 'lxc',
    name: 'jellyfin',
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
  operationId = 'pre-update-112',
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

function ok(stdout = ''): ExecResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

function fail(exitCode = 1, stderr = ''): ExecResult {
  return { exitCode, stdout: '', stderr, timedOut: false };
}

interface Failures {
  vzdump?: boolean;
  rsync?: boolean;
  restic?: boolean;
  zfs?: boolean;
  btrfs?: boolean;
  mkdir?: boolean;
}

/** Stateful fake host that tracks backups, snapshots, directories and tags. */
class BackupHostTransport implements Transport {
  public readonly calls: (readonly string[])[] = [];
  public readonly timeouts: number[] = [];
  public readonly files = new Set([
    '/etc/pve/local/lxc/112.conf',
    '/etc/pve/local/qemu-server/300.conf',
  ]);
  public readonly dirs = new Set<string>();
  public readonly snapshots = new Set<string>();
  public readonly tags = new Set<string>();
  public backedUp = false;
  public listFailure = false;
  public failures: Failures = {};

  public async exec(
    argv: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    this.calls.push([...argv]);
    if (options?.timeoutMs !== undefined) {
      this.timeouts.push(options.timeoutMs);
    }
    options?.onOutput?.('stdout', `${argv[0]} output`);
    switch (argv[0]) {
      case 'vzdump':
        if (this.failures.vzdump) return fail(1, 'vzdump failed');
        this.backedUp = true;
        return ok('creating vzdump archive');
      case 'test':
        return this.test(argv);
      case 'pvesm':
        if (this.listFailure) return fail(1, 'storage offline');
        return ok(
          this.backedUp
            ? `backup-store:backup/vzdump-lxc-112-2026_11_10-12_34_56.tar.zst tar zst 1 112\n`
            : '',
        );
      case 'mkdir':
        if (this.failures.mkdir) return fail(1, 'cannot create directory');
        this.dirs.add(argv.at(-1)!);
        return ok();
      case 'rsync':
        if (this.failures.rsync) return fail(1, 'rsync failed');
        this.dirs.add(argv.at(-1)!.replace(/\/$/, ''));
        return ok();
      case 'btrfs':
        if (this.failures.btrfs) return fail(1, 'btrfs failed');
        this.dirs.add(argv.at(-1)!);
        return ok();
      case 'zfs':
        return this.zfs(argv);
      case 'restic':
        return this.restic(argv);
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

  private test(argv: readonly string[]): ExecResult {
    if (argv[1] === '-f') return this.files.has(argv[2]!) ? ok() : fail(1);
    if (argv[1] === '-d') return this.dirs.has(argv[2]!) ? ok() : fail(1);
    return fail(2);
  }

  private zfs(argv: readonly string[]): ExecResult {
    if (argv[1] === 'list') {
      return this.snapshots.has(argv.at(-1)!) ? ok('snapshot') : fail(1);
    }
    if (this.failures.zfs) return fail(1, 'zfs failed');
    this.snapshots.add(argv[2]!);
    return ok();
  }

  private restic(argv: readonly string[]): ExecResult {
    const tagIndex = argv.indexOf('--tag');
    const tag = tagIndex >= 0 ? argv[tagIndex + 1] : undefined;
    if (argv.includes('snapshots')) {
      return ok(
        tag !== undefined && this.tags.has(tag)
          ? `[{"id":"abc","tags":["${tag}"]}]`
          : '[]',
      );
    }
    if (this.failures.restic) return fail(1, 'restic failed');
    if (tag !== undefined) this.tags.add(tag);
    return ok('snapshot abc saved');
  }
}

describe('backup labels', () => {
  it('formats a UTC timestamp', () => {
    expect(formatBackupTimestamp(new Date('2026-01-02T03:04:05.000Z'))).toBe(
      '2026-01-02_03-04-05',
    );
  });

  it('slugifies application names safely', () => {
    expect(backupSlug('Jellyfin / Media')).toBe('Jellyfin-Media');
    expect(backupSlug('  ///  ')).toBe('guest');
    expect(backupSlug('café')).toBe('caf');
    expect(backupSlug('a_b.c-d')).toBe('a_b.c-d');
  });

  it('builds VMID_timestamp_AppName labels', () => {
    expect(backupLabel(112, 'jellyfin', now)).toBe(label);
    expect(backupLabel(112, 'Jellyfin / Media', now)).toBe(
      '112_2026-11-10_12-34-56_Jellyfin-Media',
    );
  });
});

describe('preUpdateVzdumpArgv', () => {
  it('uses snapshot mode, zstd, a note label and optional storage', () => {
    expect(preUpdateVzdumpArgv(guest(), label)).toEqual([
      'vzdump',
      '112',
      '--mode',
      'snapshot',
      '--compress',
      'zstd',
      '--notes-template',
      label,
    ]);
    expect(
      preUpdateVzdumpArgv(guest(), label, 'backup-store').slice(-2),
    ).toEqual(['--storage', 'backup-store']);
    expect(preUpdateVzdumpArgv(guest(), label, '')).not.toContain('--storage');
  });
});

describe('planPreUpdateBackup', () => {
  it('plans the guest backup and an rsync fallback for host data', () => {
    const plan = planPreUpdateBackup(
      guest({
        mounts: [
          {
            index: 0,
            host_path: '/opt/server-data/pve-01/jellyfin/opt',
            guest_path: '/opt',
            filesystem: 'ext4',
          },
          {
            index: 1,
            host_path: '/srv/skip',
            guest_path: '/skip',
            backup: false,
          },
        ],
      }),
      { now },
    );
    expect(plan.label).toBe(label);
    expect(plan.skipped).toBe(false);
    expect(plan.summary).toBe(
      'Back up LXC 112 (jellyfin) before updating it on pve-01',
    );
    expect(plan.guestBackup).toEqual({
      included: true,
      argv: preUpdateVzdumpArgv(guest(), label),
      verification: 'exit-code',
    });
    expect(plan.target).toEqual({
      hostId: 'pve-01',
      vmid: 112,
      type: 'lxc',
      name: 'jellyfin',
    });
    expect(plan.dataProtection.map((entry) => entry.method)).toEqual([
      'rsync',
      'skip',
    ]);
    expect(plan.covered).toEqual(['/opt/server-data/pve-01/jellyfin/opt']);
    expect(plan.uncovered).toEqual(['/srv/skip']);
    expect(plan.dataProtection[1]?.reason).toBe('backup: false');
    expect(plan.changes.map((change) => change.id)).toEqual([
      'guest-backup',
      'protect-data-0',
    ]);
    expect(plan.commands[0]).toEqual(preUpdateVzdumpArgv(guest(), label));
    const rsync = plan.dataProtection[0]!;
    expect(rsync.target).toBe(
      `${DEFAULT_HOST_DATA_BACKUP_ROOT}/opt-server-data-pve-01-jellyfin-opt-${label}`,
    );
    expect(rsync.probe).toEqual(['test', '-d', rsync.target]);
    expect(rsync.commands).toEqual([
      ['mkdir', '-p', rsync.target],
      [
        'rsync',
        '-aAXH',
        '--numeric-ids',
        '/opt/server-data/pve-01/jellyfin/opt/',
        `${rsync.target}/`,
      ],
    ]);
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Host data '/srv/skip' is not protected"),
        expect.stringContaining('vzdump does not include bind-mounted'),
      ]),
    );
  });

  it('skips every backup when backup_skip is enabled', () => {
    const plan = planPreUpdateBackup(
      guest({
        backup_skip: true,
        backup_storage: 'backup-store',
        mounts: [{ host_path: '/srv/data', guest_path: '/data' }],
      }),
      { now },
    );
    expect(plan.skipped).toBe(true);
    expect(plan.guestBackup.included).toBe(false);
    expect(plan.guestBackup.argv).toEqual([]);
    expect(plan.guestBackup.verification).toBe('exit-code');
    expect(plan.changes).toEqual([]);
    expect(plan.commands).toEqual([]);
    expect(plan.covered).toEqual([]);
    expect(plan.uncovered).toEqual(['/srv/data']);
    expect(plan.dataProtection[0]).toMatchObject({
      method: 'skip',
      reason: 'backup_skip is enabled for this guest',
    });
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('backup_skip is enabled'),
        expect.stringContaining('without a verified restore point'),
      ]),
    );
  });

  it('uses backup_storage and reports pvesm verification', () => {
    const plan = planPreUpdateBackup(
      guest({ backup_storage: 'backup-store' }),
      { now },
    );
    expect(plan.guestBackup.storage).toBe('backup-store');
    expect(plan.guestBackup.verification).toBe('pvesm');
    expect(plan.guestBackup.argv.slice(-2)).toEqual([
      '--storage',
      'backup-store',
    ]);
    expect(plan.changes[0]?.after).toEqual({
      label,
      storage: 'backup-store',
      mode: 'snapshot',
      compress: 'zstd',
    });
  });

  it('prefers the storage override and treats an empty override as unset', () => {
    const overridden = planPreUpdateBackup(
      guest({ backup_storage: 'backup-store' }),
      { now, backupStorage: 'other-store' },
    );
    expect(overridden.guestBackup.storage).toBe('other-store');

    const empty = planPreUpdateBackup(
      guest({ backup_storage: 'backup-store' }),
      { now, backupStorage: '' },
    );
    expect(empty.guestBackup.storage).toBeUndefined();
    expect(empty.guestBackup.verification).toBe('exit-code');
    expect(empty.guestBackup.argv).not.toContain('--storage');
  });

  it('snapshots ZFS host data when a dataset is declared', () => {
    const plan = planPreUpdateBackup(
      guest({
        mounts: [
          {
            host_path: '/opt/server-data/pve-01/jellyfin/opt',
            guest_path: '/opt',
            filesystem: 'zfspool',
            dataset: 'tank/apps/jellyfin',
          },
        ],
      }),
      { now },
    );
    const entry = plan.dataProtection[0]!;
    expect(entry.method).toBe('snapshot');
    expect(entry.target).toBe(`tank/apps/jellyfin@hacm-${label}`);
    expect(entry.commands).toEqual([
      ['zfs', 'snapshot', `tank/apps/jellyfin@hacm-${label}`],
    ]);
    expect(entry.probe).toEqual([
      'zfs',
      'list',
      '-H',
      '-o',
      'name',
      '-t',
      'snapshot',
      `tank/apps/jellyfin@hacm-${label}`,
    ]);
  });

  it('snapshots BTRFS host data below the backup root', () => {
    const plan = planPreUpdateBackup(
      guest({
        mounts: [
          {
            host_path: '/srv/btrfs/data',
            filesystem: 'btrfs',
          },
        ],
      }),
      { now, backupRoot: '/snapshots' },
    );
    const entry = plan.dataProtection[0]!;
    expect(entry.method).toBe('snapshot');
    expect(entry.target).toBe(`/snapshots/srv-btrfs-data-${label}`);
    expect(entry.commands).toEqual([
      ['btrfs', 'subvolume', 'snapshot', '-r', '/srv/btrfs/data', entry.target],
    ]);
    expect(entry.probe).toEqual(['test', '-d', entry.target]);
  });

  it('falls back to rsync when ZFS has no dataset and warns', () => {
    const plan = planPreUpdateBackup(
      guest({
        mounts: [{ host_path: '/srv/zfs', filesystem: 'zfs' }],
      }),
      { now },
    );
    expect(plan.dataProtection[0]?.method).toBe('rsync');
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('looks snapshot-capable'),
      ]),
    );
  });

  it('uses restic when it is configured', () => {
    const plan = planPreUpdateBackup(
      guest({ mounts: [{ host_path: '/srv/data', filesystem: 'ext4' }] }),
      {
        now,
        restic: {
          repository: 's3:https://backup.example/bucket',
          passwordFile: '/etc/restic.pass',
          tag: 'pre-update',
        },
      },
    );
    const entry = plan.dataProtection[0]!;
    expect(entry.method).toBe('restic');
    expect(entry.target).toBe('s3:https://backup.example/bucket#pre-update');
    expect(entry.commands).toEqual([
      [
        'restic',
        '-r',
        's3:https://backup.example/bucket',
        '--password-file',
        '/etc/restic.pass',
        'backup',
        '--tag',
        'pre-update',
        '/srv/data',
      ],
    ]);
    expect(entry.probe).toEqual([
      'restic',
      '-r',
      's3:https://backup.example/bucket',
      '--password-file',
      '/etc/restic.pass',
      'snapshots',
      '--tag',
      'pre-update',
      '--last',
      '1',
      '--json',
    ]);
  });

  it('defaults the restic tag to the backup label', () => {
    const plan = planPreUpdateBackup(
      guest({ mounts: [{ host_path: '/srv/data' }] }),
      { now, restic: { repository: '/srv/restic' } },
    );
    expect(plan.dataProtection[0]?.resticTag).toBe(`hacm-${label}`);
    expect(plan.dataProtection[0]?.commands[0]).toContain(`hacm-${label}`);
  });

  it('honours forced data-protection methods', () => {
    const snapshot = planPreUpdateBackup(
      guest({
        mounts: [
          { host_path: '/srv/data', filesystem: 'btrfs' },
          { host_path: '/srv/skip', backup: false },
        ],
      }),
      { now, dataProtection: 'snapshot', backupRoot: '/snapshots' },
    );
    expect(snapshot.dataProtection.map((entry) => entry.method)).toEqual([
      'snapshot',
      'skip',
    ]);

    const rsync = planPreUpdateBackup(
      guest({ mounts: [{ host_path: '/srv/data', filesystem: 'btrfs' }] }),
      { now, dataProtection: 'rsync' },
    );
    expect(rsync.dataProtection[0]?.method).toBe('rsync');

    const restic = planPreUpdateBackup(
      guest({ mounts: [{ host_path: '/srv/data', filesystem: 'btrfs' }] }),
      {
        now,
        dataProtection: 'restic',
        restic: { repository: '/srv/restic' },
      },
    );
    expect(restic.dataProtection[0]?.method).toBe('restic');
  });

  it('rejects impossible forced methods', () => {
    expect(() =>
      planPreUpdateBackup(
        guest({ mounts: [{ host_path: '/srv/data', filesystem: 'ext4' }] }),
        { now, dataProtection: 'snapshot' },
      ),
    ).toThrow(/unsupported file system/);
    expect(() =>
      planPreUpdateBackup(
        guest({
          mounts: [
            { host_path: '/srv/data', filesystem: 'zfs', dataset: '   ' },
          ],
        }),
        { now, dataProtection: 'snapshot' },
      ),
    ).toThrow(/ZFS dataset is required/);
    expect(() =>
      planPreUpdateBackup(guest({ mounts: [{ host_path: '/srv/data' }] }), {
        now,
        dataProtection: 'restic',
      }),
    ).toThrow(/no restic repository is configured/);
  });

  it('ignores mounts on VMs and warns', () => {
    const plan = planPreUpdateBackup(
      guest({
        type: 'vm',
        vmid: 300,
        name: 'vm-app',
        mounts: [{ host_path: '/srv/unused' }],
      }),
      { now },
    );
    expect(plan.dataProtection).toEqual([]);
    expect(plan.covered).toEqual([]);
    expect(plan.warnings).toEqual([
      'VMs have no bind-mounted host data; mounts were ignored for the pre-update backup.',
    ]);
    expect(plan.label).toBe('300_2026-11-10_12-34-56_vm-app');
  });

  it('deduplicates host paths and keeps the protecting mount', () => {
    const protective = planPreUpdateBackup(
      guest({
        mounts: [
          { host_path: '/srv/data', backup: false },
          { host_path: '/srv/data', filesystem: 'ext4' },
        ],
      }),
      { now },
    );
    expect(protective.covered).toEqual(['/srv/data']);
    expect(protective.uncovered).toEqual([]);

    const optOut = planPreUpdateBackup(
      guest({
        mounts: [
          { host_path: '/srv/data', filesystem: 'ext4' },
          { host_path: '/srv/data', backup: false },
        ],
      }),
      { now },
    );
    expect(optOut.covered).toEqual(['/srv/data']);
    expect(optOut.dataProtection[0]?.method).toBe('rsync');
  });

  it('uses a custom app name and clock', () => {
    const plan = planPreUpdateBackup(guest(), {
      now: new Date('2026-01-02T03:04:05.000Z'),
      appName: 'Custom / App',
    });
    expect(plan.label).toBe('112_2026-01-02_03-04-05_Custom-App');
  });

  it('validates the guest identity', () => {
    expect(() => planPreUpdateBackup(guest({ vmid: 0 }))).toThrow(
      /not a positive integer/,
    );
    expect(() => planPreUpdateBackup(guest({ vmid: 1.5 }))).toThrow(
      /not a positive integer/,
    );
    expect(() => planPreUpdateBackup(guest({ hostId: '  ' }))).toThrow(
      /hostId must not be empty/,
    );
    expect(() =>
      planPreUpdateBackup(guest({ type: 'docker' as 'lxc' })),
    ).toThrow(/Guest type must be 'lxc' or 'vm'/);
  });

  it('does not warn about host data when nothing is declared', () => {
    const plan = planPreUpdateBackup(guest(), { now });
    expect(plan.dataProtection).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });
});

describe('createPreUpdateBackupSteps', () => {
  it('runs the guest backup and rsync protection in order', async () => {
    const transport = new BackupHostTransport();
    const plan = planPreUpdateBackup(
      guest({
        backup_storage: 'backup-store',
        mounts: [
          {
            host_path: '/srv/data',
            guest_path: '/data',
            filesystem: 'ext4',
          },
        ],
      }),
      { now },
    );
    const steps = createPreUpdateBackupSteps(plan);
    expect(steps.map((step) => step.name)).toEqual([
      'back up LXC 112 with vzdump before update',
      "protect host data '/srv/data' with rsync before update",
    ]);
    const result = await runJournaledSteps({
      ...context(transport),
      steps,
      journal: new MemoryStepJournal(),
    });
    expect(result.entries.map((entry) => entry.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(transport.calls.map((argv) => argv[0])).toEqual([
      'vzdump',
      'test',
      'pvesm',
      'test',
      'mkdir',
      'rsync',
      'test',
    ]);
    const dest = plan.dataProtection[0]!.target!;
    expect(transport.dirs.has(dest)).toBe(true);
    expect(transport.backedUp).toBe(true);
  });

  it('aborts the update when the guest backup fails', async () => {
    const transport = new BackupHostTransport();
    transport.failures.vzdump = true;
    const plan = planPreUpdateBackup(guest(), { now });
    const update: JournaledStep<undefined> = {
      name: 'apply the update',
      check: vi.fn(async () => ({ status: 'required' as const })),
      apply: vi.fn(async () => ({ updated: true })),
      verify: vi.fn(async () => ({ updated: true })),
      rollbackHint: 'Restore the backup.',
    };
    const journal = new MemoryStepJournal();
    await expect(
      runJournaledSteps({
        ...context(transport),
        steps: [...createPreUpdateBackupSteps(plan), update],
        journal,
      }),
    ).rejects.toThrow(/Pre-update backup .* failed; the update is aborted/);
    expect(update.check).not.toHaveBeenCalled();
    expect(update.apply).not.toHaveBeenCalled();
    expect(transport.calls.map((argv) => argv[0])).toEqual(['vzdump']);
    const entries = await journal.list('pre-update-112');
    expect(entries.map((entry) => entry.status)).toEqual(['failed']);
  });

  it('aborts the update when host data protection fails', async () => {
    const transport = new BackupHostTransport();
    transport.failures.rsync = true;
    const plan = planPreUpdateBackup(
      guest({ mounts: [{ host_path: '/srv/data', filesystem: 'ext4' }] }),
      { now },
    );
    const update: JournaledStep<undefined> = {
      name: 'apply the update',
      check: vi.fn(async () => ({ status: 'required' as const })),
      apply: vi.fn(async () => ({ updated: true })),
      verify: vi.fn(async () => ({ updated: true })),
      rollbackHint: 'Restore the backup.',
    };
    await expect(
      runJournaledSteps({
        ...context(transport),
        steps: [...createPreUpdateBackupSteps(plan), update],
        journal: new MemoryStepJournal(),
      }),
    ).rejects.toThrow(/rsync '\/srv\/data'.*update is aborted/);
    expect(update.check).not.toHaveBeenCalled();
  });

  it('fails verification when the archive is missing from storage', async () => {
    const transport = new BackupHostTransport();
    const plan = planPreUpdateBackup(
      guest({ backup_storage: 'backup-store' }),
      { now },
    );
    const [step] = createPreUpdateBackupSteps(plan);
    await step!.apply(context(transport));
    transport.backedUp = false;
    await expect(step!.verify(context(transport))).rejects.toThrow(
      /No vzdump archive for guest 112 was found/,
    );
  });

  it('fails verification when pvesm or the guest config is unavailable', async () => {
    const plan = planPreUpdateBackup(
      guest({ backup_storage: 'backup-store' }),
      { now },
    );
    const [step] = createPreUpdateBackupSteps(plan);

    const listFailure = new BackupHostTransport();
    listFailure.listFailure = true;
    await expect(step!.verify(context(listFailure))).rejects.toThrow(
      /Could not verify the backup on storage 'backup-store': storage offline/,
    );

    const missing = new BackupHostTransport();
    missing.files.delete('/etc/pve/local/lxc/112.conf');
    await expect(step!.verify(context(missing))).rejects.toThrow(
      /disappeared while taking its pre-update backup/,
    );
  });

  it('verifies without pvesm when no storage is configured', async () => {
    const transport = new BackupHostTransport();
    const plan = planPreUpdateBackup(guest(), { now });
    const [step] = createPreUpdateBackupSteps(plan);
    await expect(step!.verify(context(transport))).resolves.toEqual({
      backup: true,
      verification: 'exit-code',
    });
    expect(transport.calls.some((argv) => argv[0] === 'pvesm')).toBe(false);
  });

  it('creates no steps for a skipped backup', () => {
    const plan = planPreUpdateBackup(
      guest({ backup_skip: true, mounts: [{ host_path: '/srv/data' }] }),
      { now },
    );
    expect(createPreUpdateBackupSteps(plan)).toEqual([]);
  });

  it('protects ZFS data with a snapshot step', async () => {
    const transport = new BackupHostTransport();
    const plan = planPreUpdateBackup(
      guest({
        mounts: [
          {
            host_path: '/srv/data',
            filesystem: 'zfs',
            dataset: 'tank/data',
          },
        ],
        backup_skip: true,
      }),
      { now },
    );
    // backup_skip wins over data protection, so build a normal plan instead.
    expect(createPreUpdateBackupSteps(plan)).toEqual([]);

    const snapshotPlan = planPreUpdateBackup(
      guest({
        mounts: [
          {
            host_path: '/srv/data',
            filesystem: 'zfs',
            dataset: 'tank/data',
          },
        ],
      }),
      { now },
    );
    const steps = createPreUpdateBackupSteps(snapshotPlan);
    const dataStep = steps[1]!;
    expect(dataStep.name).toBe(
      "protect host data '/srv/data' with snapshot before update",
    );
    await expect(dataStep.check(context(transport))).resolves.toMatchObject({
      status: 'required',
    });
    await dataStep.apply(context(transport));
    expect(transport.snapshots).toContain(`tank/data@hacm-${label}`);
    await expect(dataStep.verify(context(transport))).resolves.toEqual({
      method: 'snapshot',
      target: `tank/data@hacm-${label}`,
    });
    await expect(dataStep.check(context(transport))).resolves.toMatchObject({
      status: 'satisfied',
    });
  });

  it('protects BTRFS data and reports snapshot failures', async () => {
    const transport = new BackupHostTransport();
    transport.failures.btrfs = true;
    const plan = planPreUpdateBackup(
      guest({
        mounts: [{ host_path: '/srv/data', filesystem: 'btrfs' }],
      }),
      { now, backupRoot: '/snapshots' },
    );
    const dataStep = createPreUpdateBackupSteps(plan)[1]!;
    await expect(dataStep.apply(context(transport))).rejects.toThrow(
      /snapshot '\/srv\/data'.*update is aborted/,
    );

    const stale = new BackupHostTransport();
    await expect(dataStep.verify(context(stale))).rejects.toThrow(
      /Host data protection for '\/srv\/data' was not found/,
    );
  });

  it('protects data with restic and verifies its tag', async () => {
    const transport = new BackupHostTransport();
    const plan = planPreUpdateBackup(
      guest({ mounts: [{ host_path: '/srv/data', filesystem: 'ext4' }] }),
      { now, restic: { repository: '/srv/restic', tag: 'pre-update' } },
    );
    const dataStep = createPreUpdateBackupSteps(plan)[1]!;
    await expect(dataStep.check(context(transport))).resolves.toMatchObject({
      status: 'required',
    });
    await dataStep.apply(context(transport));
    expect(transport.tags.has('pre-update')).toBe(true);
    await expect(dataStep.verify(context(transport))).resolves.toEqual({
      method: 'restic',
      target: '/srv/restic#pre-update',
    });
    await expect(dataStep.check(context(transport))).resolves.toMatchObject({
      status: 'satisfied',
    });

    const failing = new BackupHostTransport();
    failing.failures.restic = true;
    await expect(dataStep.apply(context(failing))).rejects.toThrow(
      /restic '\/srv\/data'.*restic failed/,
    );
  });

  it('reports rsync and mkdir failures', async () => {
    for (const failure of ['rsync', 'mkdir'] as const) {
      const transport = new BackupHostTransport();
      transport.failures[failure] = true;
      const plan = planPreUpdateBackup(
        guest({ mounts: [{ host_path: '/srv/data', filesystem: 'ext4' }] }),
        { now },
      );
      const dataStep = createPreUpdateBackupSteps(plan)[1]!;
      await expect(dataStep.apply(context(transport))).rejects.toThrow(
        /Pre-update backup .* failed; the update is aborted/,
      );
    }
  });

  it('passes the long data-protection timeout to every command', async () => {
    const transport = new BackupHostTransport();
    const plan = planPreUpdateBackup(
      guest({ mounts: [{ host_path: '/srv/data', filesystem: 'ext4' }] }),
      { now },
    );
    await createPreUpdateBackupSteps(plan)[1]!.apply(context(transport));
    expect(
      transport.timeouts.filter(
        (timeout) => timeout === DATA_PROTECTION_TIMEOUT_MS,
      ),
    ).toHaveLength(2);
  });
});
