import { describe, expect, it } from 'vitest';
import { hostFileSchema } from '../schema/host.js';
import {
  hostBackupConfigSchema,
  type HostBackupConfig,
} from '../schema/host-backup.js';
import { MemoryStepJournal } from '../steps/memory-journal.js';
import { runJournaledSteps } from '../steps/runner.js';
import type { StepExecutionContext, StepLogger } from '../steps/types.js';
import { Secret } from '../tags/secret.js';
import type { ExecResult, Transport } from '../transport/types.js';
import { TransportFileNotFoundError } from '../transport/types.js';
import { createHostBackupSteps, planHostBackup } from './plan.js';
import {
  HostBackupError,
  renderHostBackupFiles,
  renderResticCron,
  renderResticScript,
  renderVzdumpConfig,
} from './render.js';
import { readHostBackupStatus } from './status.js';

const now = new Date('2026-11-10T12:34:56.000Z');

function vzConfig(overrides: Record<string, unknown> = {}): HostBackupConfig {
  return hostBackupConfigSchema.parse({
    vzdump: {
      options: {
        mode: 'snapshot',
        compress: 'zstd',
        storage: 'backup-store',
        maxfiles: 3,
        enabled: true,
      },
      ...overrides,
    },
  });
}

function resticConfig(
  overrides: Record<string, unknown> = {},
): HostBackupConfig {
  return hostBackupConfigSchema.parse({
    restic: {
      repository: 's3:https://backup.example/bucket',
      password_file: '/etc/hacm/restic.pass',
      paths: ['/etc/pve', '/var/lib/vz'],
      tag: 'host',
      excludes: ['/var/lib/vz/template/cache'],
      keep_daily: 7,
      keep_weekly: 4,
      ...overrides,
    },
  });
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
    operationId: 'host-backup-example-host',
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
  write?: boolean;
  chmod?: boolean;
  mv?: boolean;
  cat?: boolean;
  pvesh?: boolean;
}

class HostFileTransport implements Transport {
  public readonly files = new Map<string, string>();
  public readonly modes = new Map<string, string>();
  public readonly calls: (readonly string[])[] = [];
  public failures: Failures = {};
  public pveshOutput = '[]';
  public pveshStderr = 'task list failed';

  public async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new TransportFileNotFoundError(path);
    return content;
  }

  public async writeFile(
    path: string,
    content: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    if (options?.signal?.aborted) throw new Error('aborted');
    if (this.failures.write) throw new Error('disk full');
    this.files.set(path, content);
  }

  public async exec(argv: readonly string[]): Promise<ExecResult> {
    this.calls.push([...argv]);
    const [command, ...args] = argv;
    switch (command) {
      case 'stat': {
        const path = args.at(-1)!;
        if (!this.files.has(path)) return fail(1);
        return ok(`${this.modes.get(path) ?? '644'}\n`);
      }
      case 'chmod': {
        if (this.failures.chmod) return fail(1, 'chmod denied');
        if (!this.files.has(args[1]!)) return fail(1);
        this.modes.set(args[1]!, args[0]!);
        return ok();
      }
      case 'mv': {
        if (this.failures.mv) return fail(1, 'mv denied');
        const [source, destination] = args;
        const content = this.files.get(source!);
        if (content === undefined) return fail(1, 'source missing');
        this.files.delete(source!);
        this.files.set(destination!, content);
        const mode = this.modes.get(source!);
        this.modes.delete(source!);
        if (mode !== undefined) this.modes.set(destination!, mode);
        return ok();
      }
      case 'cat': {
        if (this.failures.cat) return fail(1, 'no file');
        const content = this.files.get(args[0]!);
        return content === undefined ? fail(1, 'no file') : ok(content);
      }
      case 'pvesh':
        if (this.failures.pvesh) return fail(1, this.pveshStderr);
        return ok(this.pveshOutput);
      default:
        throw new Error(`unexpected command: ${argv.join(' ')}`);
    }
  }
}

describe('host backup schema', () => {
  it('parses host.yaml with a backup section and applies defaults', () => {
    const host = hostFileSchema.parse({
      schema_version: 1,
      id: 'example-host',
      name: 'example-host',
      type: 'proxmox',
      index: 1,
      connection: {
        ssh: { host: '192.0.2.10', fingerprint: 'SHA256:test' },
      },
      backup: {
        vzdump: { options: { mode: 'snapshot' } },
        restic: {
          repository: 's3:https://backup.example/bucket',
          password_file: '/etc/hacm/restic.pass',
          paths: ['/etc/pve'],
        },
      },
    });
    expect(host.backup?.vzdump).toMatchObject({
      enabled: true,
      path: '/etc/vzdump.conf',
      mode: '0644',
    });
    expect(host.backup?.restic).toMatchObject({
      enabled: true,
      script_path: '/usr/local/sbin/hacm-restic-backup',
      cron_path: '/etc/cron.d/hacm-restic',
      schedule: '30 2 * * *',
      prune: true,
      status_file: '/var/lib/hacm/restic-status',
      excludes: [],
    });
  });

  it('requires exactly one restic repository source', () => {
    const base = {
      password_file: '/etc/hacm/restic.pass',
      paths: ['/etc/pve'],
    };
    expect(() => hostBackupConfigSchema.parse({ restic: base })).toThrow(
      /exactly one of restic.repository or restic.repository_file/,
    );
    expect(() =>
      hostBackupConfigSchema.parse({
        restic: {
          ...base,
          repository: '/srv/restic',
          repository_file: '/etc/hacm/repository',
        },
      }),
    ).toThrow(/exactly one/);
    expect(
      hostBackupConfigSchema.parse({
        restic: { ...base, repository_file: '/etc/hacm/repository' },
      }).restic?.repository_file,
    ).toBe('/etc/hacm/repository');
  });

  it('validates cron expressions and absolute paths', () => {
    expect(() =>
      hostBackupConfigSchema.parse({
        restic: {
          repository: '/srv/restic',
          password_file: '/etc/hacm/restic.pass',
          paths: ['/etc/pve'],
          schedule: 'not cron',
        },
      }),
    ).toThrow(/five-field cron/);
    expect(() =>
      hostBackupConfigSchema.parse({
        restic: {
          repository: '/srv/restic',
          password_file: 'relative/pass',
          paths: ['/etc/pve'],
        },
      }),
    ).toThrow(/absolute path/);
  });
});

describe('host backup rendering', () => {
  it('renders sorted vzdump keys with scalar values', () => {
    expect(renderVzdumpConfig(vzConfig().vzdump!)).toBe(
      [
        'compress: zstd',
        'enabled: true',
        'maxfiles: 3',
        'mode: snapshot',
        'storage: backup-store',
        '',
      ].join('\n'),
    );
  });

  it('renders an empty vzdump config when there are no options', () => {
    expect(
      renderVzdumpConfig(hostBackupConfigSchema.parse({ vzdump: {} }).vzdump!),
    ).toBe('');
  });

  it('refuses resolved secrets and newlines in managed files', () => {
    const withSecret = vzConfig();
    (withSecret.vzdump!.options as Record<string, unknown>)['password'] =
      new Secret('supersecret');
    expect(() => renderVzdumpConfig(withSecret.vzdump!)).toThrow(
      HostBackupError,
    );
    expect(() => renderVzdumpConfig(withSecret.vzdump!)).toThrow(
      /resolved to a secret/,
    );

    const withNewline = vzConfig();
    (withNewline.vzdump!.options as Record<string, unknown>)['comment'] =
      'line one\nline two';
    expect(() => renderVzdumpConfig(withNewline.vzdump!)).toThrow(
      /must not contain a newline/,
    );

    const badKey = vzConfig();
    (badKey.vzdump!.options as Record<string, unknown>)['bad:key'] = 'x';
    expect(() => renderVzdumpConfig(badKey.vzdump!)).toThrow(/not a valid key/);
  });

  it('renders a restic script without embedding secrets', () => {
    const script = renderResticScript(resticConfig().restic!);
    expect(script).toContain(
      "export RESTIC_REPOSITORY='s3:https://backup.example/bucket'",
    );
    expect(script).toContain(
      "export RESTIC_PASSWORD_FILE='/etc/hacm/restic.pass'",
    );
    expect(script).toContain(
      "'restic' 'backup' '--tag' 'host' '--exclude' '/var/lib/vz/template/cache' '/etc/pve' '/var/lib/vz'",
    );
    expect(script).toContain(
      "'restic' 'forget' '--prune' '--keep-daily' '7' '--keep-weekly' '4'",
    );
    expect(script).toContain('last_success=');
    expect(script).not.toContain('supersecret');
  });

  it('uses a repository file when declared', () => {
    const config = resticConfig({
      repository: undefined,
      repository_file: '/etc/hacm/restic.repository',
      prune: false,
    });
    const script = renderResticScript(config.restic!);
    expect(script).toContain(
      "export RESTIC_REPOSITORY_FILE='/etc/hacm/restic.repository'",
    );
    expect(script).not.toContain('RESTIC_REPOSITORY=');
    expect(script).not.toContain('--prune');
    expect(script).toContain('exit "$rc"');
  });

  it('supports retention without prune', () => {
    const script = renderResticScript(
      resticConfig({ prune: false, keep_monthly: 6 }).restic!,
    );
    expect(script).toContain(
      "'restic' 'forget' '--keep-daily' '7' '--keep-weekly' '4' '--keep-monthly' '6'",
    );
    expect(script).not.toContain('--prune');
  });

  it('rejects missing or secret restic values', () => {
    expect(() =>
      renderResticScript({
        ...resticConfig().restic!,
        repository: undefined,
        repository_file: undefined,
      }),
    ).toThrow(/requires repository or repository_file/);

    expect(() =>
      renderResticScript({
        ...resticConfig().restic!,
        repository: new Secret('repo-with-token'),
      } as unknown as NonNullable<ReturnType<typeof resticConfig>['restic']>),
    ).toThrow(/resolved to a secret/);

    expect(() =>
      renderResticScript({
        ...resticConfig().restic!,
        tag: new Secret('tag'),
      } as unknown as NonNullable<ReturnType<typeof resticConfig>['restic']>),
    ).toThrow(/resolved to a secret/);
  });

  it('renders a cron fragment and validates the schedule', () => {
    const cron = renderResticCron(resticConfig().restic!);
    expect(cron).toBe(
      [
        '# Generated by HAC Manager (D-57). Do not edit; changes are overwritten.',
        "30 2 * * * root '/usr/local/sbin/hacm-restic-backup' >'/usr/local/sbin/hacm-restic.log' 2>&1",
        '',
      ].join('\n'),
    );
    expect(() =>
      renderResticCron({
        ...resticConfig().restic!,
        schedule: 'bad schedule',
      }),
    ).toThrow(/five-field cron/);
  });

  it('renders enabled files and skips disabled ones', () => {
    const files = renderHostBackupFiles({
      ...vzConfig(),
      ...resticConfig(),
    });
    expect(files.map((file) => [file.kind, file.path, file.mode])).toEqual([
      ['vzdump', '/etc/vzdump.conf', '0644'],
      ['restic-script', '/usr/local/sbin/hacm-restic-backup', '0755'],
      ['restic-cron', '/etc/cron.d/hacm-restic', '0644'],
    ]);
    expect(
      renderHostBackupFiles({
        vzdump: { ...vzConfig().vzdump!, enabled: false },
        restic: { ...resticConfig().restic!, enabled: false },
      }),
    ).toEqual([]);
    expect(renderHostBackupFiles({})).toEqual([]);
  });
});

describe('planHostBackup', () => {
  it('marks missing files as create changes', async () => {
    const transport = new HostFileTransport();
    const plan = await planHostBackup(
      { ...vzConfig(), ...resticConfig() },
      transport,
      { hostId: 'example-host', now },
    );
    expect(plan.hostId).toBe('example-host');
    expect(plan.checkedAt).toBe(now.toISOString());
    expect(plan.inSync).toBe(false);
    expect(plan.files.map((file) => file.status)).toEqual([
      'create',
      'create',
      'create',
    ]);
    expect(plan.changes.map((change) => change.action)).toEqual([
      'create',
      'create',
      'create',
    ]);
    expect(plan.changes[0]?.summary).toContain(
      'Create the managed vzdump file at /etc/vzdump.conf',
    );
    expect(plan.changes[0]?.after).toMatchObject({ mode: '0644' });
    expect(plan.changes[0]?.before).toBeUndefined();
  });

  it('detects content and mode drift', async () => {
    const config = vzConfig();
    const transport = new HostFileTransport();
    transport.files.set('/etc/vzdump.conf', 'mode: suspend\n');
    transport.modes.set('/etc/vzdump.conf', '600');
    const plan = await planHostBackup(config, transport, {
      hostId: 'example-host',
      now,
    });
    expect(plan.files[0]).toMatchObject({
      status: 'update',
      modeDrifted: true,
      remote: { exists: true, mode: '600' },
    });
    expect(plan.changes[0]).toMatchObject({
      action: 'update',
      path: '/etc/vzdump.conf',
    });
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('live mode of /etc/vzdump.conf is 600'),
      ]),
    );

    transport.files.set('/etc/vzdump.conf', renderVzdumpConfig(config.vzdump!));
    const modeOnly = await planHostBackup(config, transport, {
      hostId: 'example-host',
      now,
    });
    expect(modeOnly.changes[0]?.summary).toBe(
      'Fix the mode of /etc/vzdump.conf to 0644',
    );
  });

  it('reports in-sync files and empty configs', async () => {
    const config = vzConfig();
    const transport = new HostFileTransport();
    transport.files.set('/etc/vzdump.conf', renderVzdumpConfig(config.vzdump!));
    transport.modes.set('/etc/vzdump.conf', '644');
    const plan = await planHostBackup(config, transport, {
      hostId: 'example-host',
      now,
    });
    expect(plan.inSync).toBe(true);
    expect(plan.changes).toEqual([]);
    expect(plan.files[0]?.status).toBe('in-sync');

    const empty = await planHostBackup({}, transport, {
      hostId: 'example-host',
      now,
    });
    expect(empty.inSync).toBe(true);
    expect(empty.warnings).toEqual([
      'No host backup files are managed for this host; enable vzdump or restic in host.yaml.',
    ]);
  });

  it('warns when a remote mode cannot be read', async () => {
    const config = vzConfig();
    const transport = new HostFileTransport();
    transport.files.set('/etc/vzdump.conf', renderVzdumpConfig(config.vzdump!));
    transport.exec = async () => fail(1);
    const plan = await planHostBackup(config, transport, {
      hostId: 'example-host',
      now,
    });
    expect(plan.files[0]?.status).toBe('in-sync');
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Could not read the mode'),
      ]),
    );
  });

  it('propagates read errors and validates the host ID', async () => {
    const transport = new HostFileTransport();
    transport.readFile = async () => {
      throw new Error('ssh connection lost');
    };
    await expect(
      planHostBackup(vzConfig(), transport, { hostId: 'example-host' }),
    ).rejects.toThrow(/ssh connection lost/);
    await expect(
      planHostBackup(vzConfig(), transport, { hostId: ' ' }),
    ).rejects.toThrow(/hostId must not be empty/);
  });
});

describe('createHostBackupSteps', () => {
  it('applies files atomically and is idempotent', async () => {
    const config = { ...vzConfig(), ...resticConfig() };
    const transport = new HostFileTransport();
    const plan = await planHostBackup(config, transport, {
      hostId: 'example-host',
      now,
    });
    const steps = createHostBackupSteps(plan);
    expect(steps.map((step) => step.name)).toEqual([
      'apply managed host backup file /etc/vzdump.conf',
      'apply managed host backup file /usr/local/sbin/hacm-restic-backup',
      'apply managed host backup file /etc/cron.d/hacm-restic',
    ]);

    const first = await runJournaledSteps({
      ...context(transport),
      steps,
      journal: new MemoryStepJournal(),
    });
    expect(first.entries.map((entry) => entry.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect([...transport.files.keys()].sort()).toEqual(
      [
        '/etc/cron.d/hacm-restic',
        '/etc/vzdump.conf',
        '/usr/local/sbin/hacm-restic-backup',
      ].sort(),
    );
    expect(transport.modes.get('/usr/local/sbin/hacm-restic-backup')).toBe(
      '0755',
    );
    expect(transport.calls.map((argv) => argv[0])).toEqual(
      expect.arrayContaining(['chmod', 'mv']),
    );
    const writes = transport.calls.length;
    expect(transport.files.has('/etc/vzdump.conf.hacm-tmp')).toBe(false);

    const journal = new MemoryStepJournal();
    const secondPlan = await planHostBackup(config, transport, {
      hostId: 'example-host',
      now,
    });
    expect(secondPlan.inSync).toBe(true);
    const second = await runJournaledSteps({
      ...context(transport),
      steps: createHostBackupSteps(secondPlan),
      journal,
    });
    expect(second.entries.map((entry) => entry.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(transport.calls.length).toBe(writes + 6);
  });

  it('repairs mode drift without rewriting different content', async () => {
    const config = vzConfig();
    const transport = new HostFileTransport();
    transport.files.set('/etc/vzdump.conf', renderVzdumpConfig(config.vzdump!));
    transport.modes.set('/etc/vzdump.conf', '600');
    const plan = await planHostBackup(config, transport, {
      hostId: 'example-host',
      now,
    });
    const [step] = createHostBackupSteps(plan);
    await runJournaledSteps({
      ...context(transport),
      steps: [step!],
      journal: new MemoryStepJournal(),
    });
    expect(transport.modes.get('/etc/vzdump.conf')).toBe('0644');
  });

  it('does not mutate during a dry run', async () => {
    const config = vzConfig();
    const transport = new HostFileTransport();
    const plan = await planHostBackup(config, transport, {
      hostId: 'example-host',
      now,
    });
    const result = await runJournaledSteps({
      ...context(transport, true),
      steps: createHostBackupSteps(plan),
      journal: new MemoryStepJournal(),
    });
    expect(result.entries[0]?.status).toBe('skipped');
    expect(transport.files.size).toBe(0);
  });

  it('reports write, chmod and move failures', async () => {
    for (const failure of ['write', 'chmod', 'mv'] as const) {
      const transport = new HostFileTransport();
      transport.failures[failure] = true;
      const plan = await planHostBackup(vzConfig(), transport, {
        hostId: 'example-host',
        now,
      });
      const [step] = createHostBackupSteps(plan);
      await expect(step!.apply(context(transport))).rejects.toThrow(
        HostBackupError,
      );
    }
  });

  it('fails verification when the file changes after apply', async () => {
    const transport = new HostFileTransport();
    const plan = await planHostBackup(vzConfig(), transport, {
      hostId: 'example-host',
      now,
    });
    const [step] = createHostBackupSteps(plan);
    await step!.apply(context(transport));
    transport.files.set('/etc/vzdump.conf', 'tampered\n');
    await expect(step!.verify(context(transport))).rejects.toThrow(
      /does not match the declared content or mode/,
    );
    expect(await step!.check(context(transport))).toMatchObject({
      status: 'required',
    });
  });

  it('checks satisfied files without writing', async () => {
    const config = vzConfig();
    const transport = new HostFileTransport();
    transport.files.set('/etc/vzdump.conf', renderVzdumpConfig(config.vzdump!));
    transport.modes.set('/etc/vzdump.conf', '0644');
    const plan = await planHostBackup(config, transport, {
      hostId: 'example-host',
      now,
    });
    const [step] = createHostBackupSteps(plan);
    expect(await step!.check(context(transport))).toMatchObject({
      status: 'satisfied',
    });
    transport.modes.set('/etc/vzdump.conf', '600');
    expect(await step!.check(context(transport))).toMatchObject({
      status: 'required',
    });
    transport.files.delete('/etc/vzdump.conf');
    expect(await step!.check(context(transport))).toMatchObject({
      status: 'required',
    });
  });
});

describe('readHostBackupStatus', () => {
  it('reads restic timestamps and the latest vzdump tasks', async () => {
    const transport = new HostFileTransport();
    transport.files.set(
      '/var/lib/hacm/restic-status',
      [
        'last_run=2026-11-10T01:00:00Z',
        'last_success=2026-11-09T01:00:00Z',
      ].join('\n'),
    );
    transport.pveshOutput = JSON.stringify([
      { starttime: Date.UTC(2026, 10, 8) / 1_000, status: 'OK' },
      { starttime: Date.UTC(2026, 10, 9) / 1_000, status: 'OK' },
      { starttime: Date.UTC(2026, 10, 10) / 1_000, status: 'job errors' },
      { starttime: 'bad' },
    ]);
    const status = await readHostBackupStatus(
      { ...vzConfig(), ...resticConfig() },
      transport,
      { hostId: 'example-host', now, node: 'pve-01' },
    );
    expect(status.vzdump).toMatchObject({
      enabled: true,
      known: true,
      lastStatus: 'job errors',
    });
    expect(status.vzdump.lastSuccess).toBe('2026-11-09T00:00:00.000Z');
    expect(status.restic).toEqual({
      enabled: true,
      known: true,
      lastRun: '2026-11-10T01:00:00.000Z',
      lastSuccess: '2026-11-09T01:00:00.000Z',
    });
    expect(status.warnings).toEqual([]);
    expect(
      transport.calls.find((argv) => argv[0] === 'pvesh')?.join(' '),
    ).toContain('/nodes/pve-01/tasks');
  });

  it('handles unknown restic status sources', async () => {
    const transport = new HostFileTransport();
    transport.failures.cat = true;
    const missing = await readHostBackupStatus(resticConfig(), transport, {
      hostId: 'example-host',
      now,
    });
    expect(missing.restic).toEqual({ enabled: true, known: false });
    expect(missing.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('status file')]),
    );

    transport.failures.cat = false;
    transport.files.set('/var/lib/hacm/restic-status', 'nothing here\n');
    const empty = await readHostBackupStatus(resticConfig(), transport, {
      hostId: 'example-host',
      now,
    });
    expect(empty.restic.known).toBe(false);
    expect(empty.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('no run timestamps')]),
    );
  });

  it('handles vzdump task failures and invalid JSON', async () => {
    const transport = new HostFileTransport();
    transport.failures.pvesh = true;
    const failed = await readHostBackupStatus(vzConfig(), transport, {
      hostId: 'example-host',
      now,
    });
    expect(failed.vzdump).toEqual({ enabled: true, known: false });
    expect(failed.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('task list failed')]),
    );

    transport.failures.pvesh = false;
    transport.pveshOutput = 'not json';
    const invalid = await readHostBackupStatus(vzConfig(), transport, {
      hostId: 'example-host',
      now,
    });
    expect(invalid.vzdump.known).toBe(false);
    expect(invalid.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('not valid JSON')]),
    );
  });

  it('reports disabled mechanisms and empty task lists', async () => {
    const transport = new HostFileTransport();
    const disabled = await readHostBackupStatus(
      {
        vzdump: { ...vzConfig().vzdump!, enabled: false },
        restic: { ...resticConfig().restic!, enabled: false },
      },
      transport,
      { hostId: 'example-host', now },
    );
    expect(disabled.vzdump).toEqual({ enabled: false, known: false });
    expect(disabled.restic).toEqual({ enabled: false, known: false });

    const empty = await readHostBackupStatus(vzConfig(), transport, {
      hostId: 'example-host',
      now,
    });
    expect(empty.vzdump).toEqual({ enabled: true, known: true });
  });

  it('validates the host ID', async () => {
    await expect(
      readHostBackupStatus({}, new HostFileTransport(), { hostId: ' ' }),
    ).rejects.toThrow(/hostId must not be empty/);
  });
});

describe('host backup edge branches', () => {
  it('treats all-zero modes as equal and defaults the clock', async () => {
    const config = hostBackupConfigSchema.parse({
      vzdump: { mode: '0000', options: { mode: 'snapshot' } },
    });
    const transport = new HostFileTransport();
    transport.files.set('/etc/vzdump.conf', renderVzdumpConfig(config.vzdump!));
    transport.modes.set('/etc/vzdump.conf', '000');
    const plan = await planHostBackup(config, transport, {
      hostId: 'example-host',
    });
    expect(plan.files[0]?.status).toBe('in-sync');
    expect(plan.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports content drift when the remote mode is unknown', async () => {
    const transport = new HostFileTransport();
    transport.files.set('/etc/vzdump.conf', 'mode: suspend\n');
    transport.exec = async (argv) => (argv[0] === 'stat' ? fail(1) : ok());
    const plan = await planHostBackup(vzConfig(), transport, {
      hostId: 'example-host',
      now,
    });
    expect(plan.files[0]?.status).toBe('update');
    expect(plan.changes[0]?.before).toEqual({
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(plan.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('only content drift')]),
    );
  });

  it('renders boolean and invalid scalar values', () => {
    const config = hostBackupConfigSchema.parse({
      vzdump: {
        options: { enabled: false, compress: 'zstd' },
      },
    });
    expect(renderVzdumpConfig(config.vzdump!)).toBe(
      'compress: zstd\nenabled: false\n',
    );

    const invalid = {
      ...config.vzdump!,
      options: { nested: { path: '/tmp' } },
    } as unknown as NonNullable<HostBackupConfig['vzdump']>;
    expect(() => renderVzdumpConfig(invalid)).toThrow(
      /must be a string, number or boolean/,
    );
  });

  it('omits the tag and renders every retention flag', () => {
    const withoutTag = renderResticScript(
      resticConfig({ tag: undefined }).restic!,
    );
    expect(withoutTag).not.toContain("'--tag'");

    const all = renderResticScript(
      resticConfig({
        keep_last: 5,
        keep_daily: 7,
        keep_weekly: 4,
        keep_monthly: 6,
      }).restic!,
    );
    expect(all).toContain(
      "'--keep-last' '5' '--keep-daily' '7' '--keep-weekly' '4' '--keep-monthly' '6'",
    );

    const onlyLast = renderResticScript(
      resticConfig({
        keep_last: 3,
        keep_daily: undefined,
        keep_weekly: undefined,
      }).restic!,
    );
    expect(onlyLast).toContain("'--keep-last' '3'");
    expect(onlyLast).not.toContain('--keep-daily');
  });

  it('reports write failures with non-Error values', async () => {
    const transport = new HostFileTransport();
    const plan = await planHostBackup(vzConfig(), transport, {
      hostId: 'example-host',
      now,
    });
    transport.writeFile = async () => {
      throw 'disk gone';
    };
    const [step] = createHostBackupSteps(plan);
    await expect(step!.apply(context(transport))).rejects.toThrow(
      /Could not write '\/etc\/vzdump.conf.hacm-tmp': disk gone/,
    );
  });

  it('falls back to the exit code when chmod or mv has no stderr', async () => {
    for (const command of ['chmod', 'mv'] as const) {
      const transport = new HostFileTransport();
      const plan = await planHostBackup(vzConfig(), transport, {
        hostId: 'example-host',
        now,
      });
      transport.exec = async (argv) => (argv[0] === command ? fail(7) : ok());
      const [step] = createHostBackupSteps(plan);
      await expect(step!.apply(context(transport))).rejects.toThrow(
        /exit code 7/,
      );
    }
  });

  it('handles invalid restic timestamps and partial status files', async () => {
    const transport = new HostFileTransport();
    transport.files.set(
      '/var/lib/hacm/restic-status',
      'last_run=not-a-date\nlast_success=2026-11-09T01:00:00Z\n',
    );
    const partial = await readHostBackupStatus(resticConfig(), transport, {
      hostId: 'example-host',
      now,
    });
    expect(partial.restic).toEqual({
      enabled: true,
      known: true,
      lastSuccess: '2026-11-09T01:00:00.000Z',
    });

    transport.files.set(
      '/var/lib/hacm/restic-status',
      'last_run=2026-11-10T01:00:00Z\n',
    );
    const onlyRun = await readHostBackupStatus(resticConfig(), transport, {
      hostId: 'example-host',
      now,
    });
    expect(onlyRun.restic).toEqual({
      enabled: true,
      known: true,
      lastRun: '2026-11-10T01:00:00.000Z',
    });
  });

  it('reports non-array JSON and exit-code-only task failures', async () => {
    const transport = new HostFileTransport();
    transport.pveshOutput = '{}';
    const notArray = await readHostBackupStatus(vzConfig(), transport, {
      hostId: 'example-host',
      now,
    });
    expect(notArray.vzdump).toEqual({ enabled: true, known: false });
    expect(notArray.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('not valid JSON')]),
    );

    transport.failures.pvesh = true;
    transport.pveshStderr = '';
    const failed = await readHostBackupStatus(vzConfig(), transport, {
      hostId: 'example-host',
      now,
    });
    expect(failed.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('exit code 1')]),
    );
  });

  it('handles tasks without status and no successful run', async () => {
    const transport = new HostFileTransport();
    transport.pveshOutput = JSON.stringify([
      { starttime: Date.UTC(2026, 10, 10) / 1_000 },
    ]);
    const status = await readHostBackupStatus(vzConfig(), transport, {
      hostId: 'example-host',
    });
    expect(status.vzdump).toEqual({
      enabled: true,
      known: true,
      lastRun: '2026-11-10T00:00:00.000Z',
    });
    expect(status.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
