import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from './cli.js';
import { runInit } from './commands/init.js';
import { runValidate } from './commands/validate.js';
import { runImport } from './commands/import.js';
import { runSchemaExport } from './commands/schema.js';

let directory: string;
let stdout: string;
let stderr: string;
const fixture = resolve(
  import.meta.dirname,
  '../../core/fixtures/proxmox/lxc-112-unprivileged.conf',
);

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hacm-cli-integration-'));
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe('CLI command integration', () => {
  it.each(['--help', '-h', '--version', '-v'])('supports %s', async (flag) => {
    expect(await runCli([flag])).toBe(0);
    expect(stdout).toContain('hacm');
  });

  it.each([{ args: [] }, { args: ['unknown'] }])(
    'rejects missing or unknown schema subcommands',
    async ({ args }) => {
      expect(await runCli(['schema', ...args])).toBe(1);
      expect(stderr).toContain('Unknown schema command');
    },
  );

  it('supports equals options and JSON for idempotent initialization', async () => {
    const args = [
      'init',
      `--data-dir=${directory}`,
      '--host=fixture-host',
      '--host-name=Fixture Host',
      '--host-ip=192.0.2.25',
      '--json',
    ];
    expect(await runCli(args)).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ hostId: 'fixture-host' });
    const host = await readFile(
      join(directory, 'hosts/fixture-host/host.yaml'),
      'utf8',
    );
    expect(host).toContain('name: Fixture Host');
    expect(host).toContain('host: 192.0.2.25');
    stdout = '';
    expect(await runCli(args)).toBe(0);
    expect(
      JSON.parse(stdout).actions.every(
        (action: { status: string }) => action.status === 'skipped',
      ),
    ).toBe(true);
  });

  it('supports separated host options and environment/current-directory defaults', async () => {
    vi.stubEnv('HACM_DATA_DIR', directory);
    expect(
      await runCli([
        'init',
        '--host',
        'pve-01',
        '--host-name',
        'Fixture Host',
        '--host-ip',
        '192.0.2.50',
      ]),
    ).toBe(0);
    expect(stdout).toContain('hosts/pve-01/host.yaml');
    stdout = '';
    expect(await runInit()).toBe(0);
    expect(await runValidate()).toBe(0);
    vi.stubEnv('HACM_DATA_DIR', undefined);
    vi.spyOn(process, 'cwd').mockReturnValue(directory);
    expect(await runInit()).toBe(0);
    expect(await runValidate()).toBe(0);
  });

  it('emits structured and human-readable diagnostics for invalid YAML', async () => {
    await runInit({ dataDir: directory });
    await writeFile(
      join(directory, 'hosts/pve-01/host.yaml'),
      'schema_version: 1\nconnection: [',
    );
    stdout = '';
    expect(
      await runCli(['validate', `--data-dir=${directory}`, '--json']),
    ).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ valid: false });
    expect(await runCli(['validate', '-d', directory, '--resolve'])).toBe(1);
    expect(stderr).toContain('Validation failed');
    expect(stderr).toContain('error:');
  });

  it('exports JSON schemas and reference documentation to the requested directory', async () => {
    const outDir = join(directory, 'build', 'schemas');
    expect(
      await runCli([
        'schema',
        'export',
        `--out-dir=${outDir}`,
        '--docs',
        '--json',
      ]),
    ).toBe(0);
    expect(JSON.parse(stdout).exportedFiles).toHaveLength(6);
    expect(
      await readFile(join(directory, 'docs/reference/config.md'), 'utf8'),
    ).toContain('Configuration reference');
    vi.spyOn(process, 'cwd').mockReturnValue(directory);
    expect(await runSchemaExport()).toBe(0);
    expect(
      await readFile(join(directory, 'schemas/host.schema.json'), 'utf8'),
    ).toContain('schema_version');
  });

  it('imports from equals-style flags, previews matching defaults, and overwrites only explicitly', async () => {
    await runInit({ dataDir: directory });
    const args = [
      'import',
      `--data-dir=${directory}`,
      '--host=pve-01',
      `--file=${fixture}`,
      '--vmid=112',
      '--type=lxc',
    ];
    stdout = '';
    expect(await runCli([...args, '--dry-run', '--json'])).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      status: 'new',
      plan: { vmid: 112 },
    });
    stdout = '';
    expect(await runCli([...args, '--json'])).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ success: true });
    stdout = '';
    expect(await runCli([...args, '--json'])).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      success: false,
      reason: 'already_exists',
    });
    expect(await runCli([...args, '--overwrite'])).toBe(0);
    expect(await runCli([...args, '--dry-run'])).toBe(0);
    expect(stdout).toContain('Omitted (matches default): cpu');
  });

  it('imports a VM with separated type options and a default VMID', async () => {
    const file = join(directory, 'fixture.conf');
    await writeFile(file, 'name: fixture-vm\nbios: seabios\nmemory: 1024\n');
    vi.stubEnv('HACM_DATA_DIR', directory);
    expect(
      await runCli([
        'import',
        '--host',
        'fixture-host',
        '--file',
        file,
        '--type',
        'vm',
        '--dry-run',
      ]),
    ).toBe(0);
    expect(stdout).toContain('VM 100 (fixture-vm)');
    vi.stubEnv('HACM_DATA_DIR', undefined);
    vi.spyOn(process, 'cwd').mockReturnValue(directory);
    expect(await runImport({ host: 'fixture-host', file, dryRun: true })).toBe(
      0,
    );
  });

  it('returns errors for missing required options and unreadable input', async () => {
    expect(await runImport()).toBe(1);
    expect(stderr).toContain('--host');
    expect(await runImport({ host: 'fixture-host' })).toBe(1);
    expect(stderr).toContain('--file');
    expect(
      await runImport({
        host: 'fixture-host',
        file: join(directory, 'absent.conf'),
      }),
    ).toBe(1);
    expect(stderr).toContain('Failed to read config file');
  });

  it('accepts mixed string and Buffer chunks from stdin without writing in dry-run mode', async () => {
    const stdin = Readable.from([
      'hostname: fixture-stdin\n',
      Buffer.from('cores: 2\n'),
    ]);
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(
      stdin as typeof process.stdin,
    );
    expect(
      await runImport({
        dataDir: directory,
        host: 'fixture-host',
        file: '-',
        dryRun: true,
      }),
    ).toBe(0);
    expect(stdout).toContain('fixture-stdin');
    expect(
      await readFile(
        join(directory, 'hosts/fixture-host/100-fixture-stdin/deployment.yaml'),
      ).catch(() => undefined),
    ).toBeUndefined();
  });
});
