import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDeploymentDefaults, readLocalTarget } from './plan-file.js';

const tempDirs: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'hacm-plan-file-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('local plan file helpers', () => {
  it('loads optional defaults and surfaces invalid defaults', async () => {
    const dataDir = await temporaryDirectory();
    expect(await loadDeploymentDefaults(dataDir, 'pve-01')).toBeUndefined();
    const hostDir = join(dataDir, 'hosts', 'pve-01');
    await mkdir(hostDir, { recursive: true });
    const defaults = join(hostDir, 'default-deployment.yaml');
    await writeFile(defaults, 'schema_version: 1\ncpu: 2\nram: 1024\n', 'utf8');
    await expect(
      loadDeploymentDefaults(dataDir, 'pve-01'),
    ).resolves.toMatchObject({ cpu: 2, ram: 1024 });
    await writeFile(defaults, 'schema_version: nope\n', 'utf8');
    await expect(loadDeploymentDefaults(dataDir, 'pve-01')).rejects.toThrow();
  });

  it('reads missing, valid, invalid, and unreadable targets', async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, 'deployment.yaml');
    await expect(readLocalTarget(target)).resolves.toEqual({
      exists: false,
      hash: null,
      value: null,
    });
    await writeFile(target, 'schema_version: 1\nid: 112\n', 'utf8');
    await expect(readLocalTarget(target)).resolves.toMatchObject({
      exists: true,
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      value: { schema_version: 1, id: 112 },
    });
    await writeFile(target, 'schema_version: [', 'utf8');
    await expect(readLocalTarget(target)).resolves.toMatchObject({
      exists: true,
      value: { invalidYaml: true },
    });
    await expect(readLocalTarget(directory)).rejects.toThrow();
  });
});
