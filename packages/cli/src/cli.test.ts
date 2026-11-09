import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from './cli.js';

describe('CLI hacm', () => {
  const examplesDataDir = resolve(__dirname, '../../../examples/data');
  const tempSchemasDir = resolve(__dirname, '../dist/temp-schemas');

  let stdoutBuffer = '';
  let stderrBuffer = '';

  beforeEach(() => {
    stdoutBuffer = '';
    stderrBuffer = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutBuffer += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrBuffer += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(tempSchemasDir)) {
      rmSync(tempSchemasDir, { recursive: true, force: true });
    }
  });

  it('prints help when called with no arguments or -h/--help', async () => {
    const code = await runCli([]);
    expect(code).toBe(0);
    expect(stdoutBuffer).toContain('Usage:');
    expect(stdoutBuffer).toContain('hacm <command>');
  });

  it('prints version with -v or --version', async () => {
    const code = await runCli(['--version']);
    expect(code).toBe(0);
    expect(stdoutBuffer).toContain('hacm');
  });

  it('runs validate successfully against examples/data', async () => {
    const code = await runCli(['validate', '--data-dir', examplesDataDir]);
    expect(code).toBe(0);
    expect(stdoutBuffer).toContain('Validation passed');
  });

  it('runs validate with --json against examples/data', async () => {
    const code = await runCli([
      'validate',
      '--data-dir',
      examplesDataDir,
      '--json',
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed.valid).toBe(true);
    expect(parsed.issues).toEqual([]);
    expect(parsed.stats.hosts).toBe(1);
  });

  it('runs schema export to target directory', async () => {
    const code = await runCli([
      'schema',
      'export',
      '--out-dir',
      tempSchemasDir,
    ]);
    expect(code).toBe(0);
    expect(stdoutBuffer).toContain('Exported 6 JSON Schemas');
    expect(stdoutBuffer).toContain(
      'yaml-language-server modeline documentation',
    );
    expect(existsSync(resolve(tempSchemasDir, 'deployment.schema.json'))).toBe(
      true,
    );
    expect(existsSync(resolve(tempSchemasDir, 'host.schema.json'))).toBe(true);
  });

  it('scaffolds a new data directory with init and validates it', async () => {
    const tempInitDir = resolve(__dirname, '../dist/temp-init');
    if (existsSync(tempInitDir)) {
      rmSync(tempInitDir, { recursive: true, force: true });
    }

    try {
      // First run: creates files
      const initCode = await runCli([
        'init',
        '--data-dir',
        tempInitDir,
        '--host',
        'pve-cli',
      ]);
      expect(initCode).toBe(0);
      expect(stdoutBuffer).toContain('Scaffolded HAC Manager data directory');
      expect(existsSync(resolve(tempInitDir, 'hosts/pve-cli/host.yaml'))).toBe(
        true,
      );

      // Validate newly scaffolded repo
      const validateCode = await runCli([
        'validate',
        '--data-dir',
        tempInitDir,
      ]);
      expect(validateCode).toBe(0);

      // Second run: idempotent (skips)
      stdoutBuffer = '';
      const secondInitCode = await runCli([
        'init',
        '--data-dir',
        tempInitDir,
        '--host',
        'pve-cli',
      ]);
      expect(secondInitCode).toBe(0);
      expect(stdoutBuffer).toContain('skipped (already exists)');
    } finally {
      if (existsSync(tempInitDir)) {
        rmSync(tempInitDir, { recursive: true, force: true });
      }
    }
  });

  it('returns error code for unknown command', async () => {
    const code = await runCli(['unknown-command']);
    expect(code).toBe(1);
    expect(stderrBuffer).toContain('Unknown command');
  });

  it('runs import with dry-run and apply', async () => {
    const tempDir = resolve(__dirname, '../dist/temp-import-test');
    const fixturePath = resolve(
      __dirname,
      '../../core/fixtures/proxmox/lxc-112-unprivileged.conf',
    );
    try {
      // First scaffold data dir
      await runCli(['init', '--data-dir', tempDir, '--host', 'pve-01']);
      stdoutBuffer = '';

      // Dry run
      const dryCode = await runCli([
        'import',
        '--data-dir',
        tempDir,
        '--host',
        'pve-01',
        '--file',
        fixturePath,
        '--vmid',
        '112',
        '--dry-run',
      ]);
      expect(dryCode).toBe(0);
      expect(stdoutBuffer).toContain('Import plan for LXC 112 (example-lxc)');
      expect(stdoutBuffer).toContain('Status: new');

      // Actual import
      stdoutBuffer = '';
      const importCode = await runCli([
        'import',
        '--data-dir',
        tempDir,
        '--host',
        'pve-01',
        '--file',
        fixturePath,
        '--vmid',
        '112',
      ]);
      expect(importCode).toBe(0);
      expect(stdoutBuffer).toContain('Imported LXC 112 (example-lxc)');

      // Re-running import fails with already exists
      stdoutBuffer = '';
      stderrBuffer = '';
      const secondCode = await runCli([
        'import',
        '--data-dir',
        tempDir,
        '--host',
        'pve-01',
        '--file',
        fixturePath,
        '--vmid',
        '112',
      ]);
      expect(secondCode).toBe(1);
      expect(stderrBuffer).toContain('already exists');
    } finally {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });
});
