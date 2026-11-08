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

  it('returns error code for unknown command', async () => {
    const code = await runCli(['unknown-command']);
    expect(code).toBe(1);
    expect(stderrBuffer).toContain('Unknown command');
  });
});
