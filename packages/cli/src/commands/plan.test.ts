import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalGuestImportPlanDocument } from './plan.js';
import { runPlan } from './plan.js';

const tempDirs: string[] = [];
let stdout = '';
let stderr = '';

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'hacm-plan-command-'));
  tempDirs.push(directory);
  return directory;
}

beforeEach(() => {
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
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('runPlan', () => {
  it('rejects missing host, reusable file, and unreadable files', async () => {
    expect(await runPlan()).toBe(1);
    expect(stderr).toContain('--host');
    stderr = '';
    expect(await runPlan({ host: 'pve-01', file: '-' })).toBe(1);
    expect(stderr).toContain('stdin cannot be rechecked');
    stderr = '';
    expect(
      await runPlan({ host: 'pve-01', file: 'missing-plan-source.conf' }),
    ).toBe(1);
    expect(stderr).toContain('Failed to read config file');
  });

  it('uses environment defaults, detects type and VMID, and emits JSON', async () => {
    const dataDir = await tempDir();
    const source = join(dataDir, 'source.conf');
    await writeFile(source, 'hostname: auto-guest\ncores: 1\nmemory: 512\n');
    vi.stubEnv('HACM_DATA_DIR', dataDir);

    expect(await runPlan({ host: 'pve-01', file: source, json: true })).toBe(0);
    const document = JSON.parse(stdout) as LocalGuestImportPlanDocument;
    expect(document.plan).toMatchObject({
      operation: 'guest.import',
      target: { hostId: 'pve-01', vmid: 100 },
      destructive: false,
      warnings: [],
    });
    expect(document.payload.dataDir).toBe(dataDir);
  });

  it('requires overwrite for an existing target and renders destructive warnings', async () => {
    const dataDir = await tempDir();
    const source = join(dataDir, 'source.conf');
    await writeFile(source, 'hostname: existing\ncores: 2\nmemory: 1024\n');
    stdout = '';
    expect(
      await runPlan({
        dataDir,
        host: 'pve-01',
        file: source,
        vmid: 112,
        type: 'lxc',
        json: true,
      }),
    ).toBe(0);
    const initial = JSON.parse(stdout) as LocalGuestImportPlanDocument;
    const relative = initial.plan.changes[0]!.path!;
    const target = join(dataDir, ...relative.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      'schema_version: 1\nid: 112\nname: existing\ntype: lxc\nram: 512\n',
      'utf8',
    );

    stderr = '';
    expect(
      await runPlan({
        dataDir,
        host: 'pve-01',
        file: source,
        vmid: 112,
        type: 'lxc',
      }),
    ).toBe(1);
    expect(stderr).toContain('use --overwrite');

    stdout = '';
    expect(
      await runPlan({
        dataDir,
        host: 'pve-01',
        file: source,
        vmid: 112,
        type: 'lxc',
        overwrite: true,
      }),
    ).toBe(0);
    expect(stdout).toContain('Destructive: yes');
    expect(stdout).toContain('Warning: The existing deployment YAML');
  });

  it('reports invalid defaults through the command error path', async () => {
    const dataDir = await tempDir();
    const source = join(dataDir, 'source.conf');
    const defaults = join(
      dataDir,
      'hosts',
      'pve-01',
      'default-deployment.yaml',
    );
    await mkdir(dirname(defaults), { recursive: true });
    await writeFile(source, 'hostname: invalid-defaults\n');
    await writeFile(defaults, 'schema_version: invalid\n');

    expect(await runPlan({ dataDir, host: 'pve-01', file: source })).toBe(1);
    expect(stderr).toContain('Failed to create plan');
    expect(await readFile(source, 'utf8')).toContain('invalid-defaults');
  });
});
