import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runApply } from './apply.js';
import { runPlan, type LocalGuestImportPlanDocument } from './plan.js';

const tempDirs: string[] = [];
let stdout = '';
let stderr = '';

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'hacm-apply-command-'));
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
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createDocument(options?: {
  readonly existing?: boolean;
}): Promise<{
  readonly dataDir: string;
  readonly planFile: string;
  readonly document: LocalGuestImportPlanDocument;
  readonly target: string;
}> {
  const dataDir = await tempDir();
  const source = join(dataDir, 'source.conf');
  await writeFile(source, 'hostname: apply-guest\ncores: 2\nmemory: 1024\n');

  stdout = '';
  await runPlan({
    dataDir,
    host: 'pve-01',
    file: source,
    vmid: 112,
    type: 'lxc',
    json: true,
  });
  let document = JSON.parse(stdout) as LocalGuestImportPlanDocument;
  const target = join(dataDir, ...document.plan.changes[0]!.path!.split('/'));
  if (options?.existing) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      'schema_version: 1\nid: 112\nname: apply-guest\ntype: lxc\nram: 512\n',
      'utf8',
    );
    stdout = '';
    await runPlan({
      dataDir,
      host: 'pve-01',
      file: source,
      vmid: 112,
      type: 'lxc',
      overwrite: true,
      json: true,
    });
    document = JSON.parse(stdout) as LocalGuestImportPlanDocument;
  }
  const planFile = join(dataDir, 'plan.json');
  await writeFile(planFile, JSON.stringify(document), 'utf8');
  stdout = '';
  stderr = '';
  return { dataDir, planFile, document, target };
}

async function writeCase(
  dataDir: string,
  name: string,
  value: unknown,
): Promise<string> {
  const file = join(dataDir, `${name}.json`);
  await writeFile(file, JSON.stringify(value), 'utf8');
  return file;
}

describe('runApply', () => {
  it('requires a plan path', async () => {
    expect(await runApply()).toBe(1);
    expect(stderr).toContain('--plan');
  });

  it('validates the plan document envelope and every payload field', async () => {
    const fixture = await createDocument();
    const base = fixture.document;
    const cases: Array<[string, unknown]> = [
      ['not-object', null],
      ['version', { ...base, schemaVersion: 2 }],
      ['payload', { ...base, payload: null }],
      ['host', { ...base, payload: { ...base.payload, hostId: 1 } }],
      ['data-dir', { ...base, payload: { ...base.payload, dataDir: 1 } }],
      ['vmid', { ...base, payload: { ...base.payload, vmid: '112' } }],
      ['type', { ...base, payload: { ...base.payload, type: 'other' } }],
      ['source', { ...base, payload: { ...base.payload, sourceFile: 1 } }],
      ['overwrite', { ...base, payload: { ...base.payload, overwrite: 1 } }],
      ['generated', { ...base, payload: { ...base.payload, generatedAt: 1 } }],
    ];
    for (const [name, value] of cases) {
      stderr = '';
      const planFile = await writeCase(fixture.dataDir, name, value);
      expect(await runApply({ dataDir: fixture.dataDir, plan: planFile })).toBe(
        1,
      );
      expect(stderr).toContain('Failed to apply plan');
    }
  });

  it('rejects unsupported operations, wrong data dirs, and mismatched targets', async () => {
    const fixture = await createDocument();
    const unsupported = {
      ...fixture.document,
      plan: { ...fixture.document.plan, operation: 'unsupported' },
    };
    expect(
      await runApply({
        dataDir: fixture.dataDir,
        plan: await writeCase(fixture.dataDir, 'unsupported', unsupported),
      }),
    ).toBe(1);
    expect(stderr).toContain('Unsupported plan operation');

    stderr = '';
    const otherDir = await tempDir();
    expect(await runApply({ dataDir: otherDir, plan: fixture.planFile })).toBe(
      1,
    );
    expect(stderr).toContain('belongs to data directory');

    stderr = '';
    const mismatched = {
      ...fixture.document,
      plan: {
        ...fixture.document.plan,
        target: { ...fixture.document.plan.target, vmid: 113 },
      },
    };
    expect(
      await runApply({
        dataDir: fixture.dataDir,
        plan: await writeCase(fixture.dataDir, 'mismatch', mismatched),
      }),
    ).toBe(1);
    expect(stderr).toContain('target does not match');
  });

  it('requires destructive confirmation and rejects tampered changes', async () => {
    const fixture = await createDocument({ existing: true });
    expect(
      await runApply({ dataDir: fixture.dataDir, plan: fixture.planFile }),
    ).toBe(1);
    expect(stderr).toContain('Typed confirmation');

    const confirmation = fixture.document.plan.confirmationText!;
    const badId = {
      ...fixture.document,
      plan: {
        ...fixture.document.plan,
        changes: [
          { ...fixture.document.plan.changes[0]!, id: 'unsupported-change' },
        ],
      },
    };
    stderr = '';
    expect(
      await runApply({
        dataDir: fixture.dataDir,
        plan: await writeCase(fixture.dataDir, 'bad-id', badId),
        confirmation,
      }),
    ).toBe(1);
    expect(stderr).toContain('Unsupported plan change');

    const badPath = {
      ...fixture.document,
      plan: {
        ...fixture.document.plan,
        changes: [
          { ...fixture.document.plan.changes[0]!, path: 'wrong/path.yaml' },
        ],
      },
    };
    stderr = '';
    expect(
      await runApply({
        dataDir: fixture.dataDir,
        plan: await writeCase(fixture.dataDir, 'bad-path', badPath),
        confirmation,
      }),
    ).toBe(1);
    expect(stderr).toContain('target path');
  });

  it('supports human dry-run output and reports an executor refusal', async () => {
    const fresh = await createDocument();
    expect(
      await runApply({
        dataDir: fresh.dataDir,
        plan: fresh.planFile,
        dryRun: true,
      }),
    ).toBe(0);
    expect(stdout).toContain('Dry-run completed');

    const existing = await createDocument({ existing: true });
    const refused = {
      ...existing.document,
      payload: { ...existing.document.payload, overwrite: false },
    };
    stderr = '';
    expect(
      await runApply({
        dataDir: existing.dataDir,
        plan: await writeCase(existing.dataDir, 'refused', refused),
        confirmation: existing.document.plan.confirmationText,
      }),
    ).toBe(1);
    expect(stderr).toContain('Guest import failed');
    expect(await readFile(existing.target, 'utf8')).toContain('ram: 512');
  });
});
