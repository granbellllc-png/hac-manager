import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultNodeFileSystem } from '../yaml/file.js';
import { WriteConflictError } from '../data-dir/write-guard.js';
import { applyPatch } from './apply-patch.js';

let directory: string;
let deploymentFile: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hacm-writeback-guards-'));
  deploymentFile = join(directory, 'deployment.yaml');
  await writeFile(deploymentFile, '# preserve this comment\ncpu: 2\n');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('writeback failure boundaries', () => {
  it('rejects a root patch and missing guest file', async () => {
    expect(await applyPatch({ deploymentFile }, [], 1)).toMatchObject({
      success: false,
      reason: 'invalid_path',
    });
    expect(
      await applyPatch(
        { deploymentFile: join(directory, 'missing.yaml') },
        'cpu',
        4,
      ),
    ).toMatchObject({ success: false, reason: 'target_not_found' });
  });

  it('adds a guest value when optional defaults are missing', async () => {
    expect(
      await applyPatch({ deploymentFile }, 'ram', 1024, {
        defaultDeploymentFile: join(directory, 'absent.yaml'),
      }),
    ).toMatchObject({ success: true, layer: 'override' });
    expect(await readFile(deploymentFile, 'utf8')).toContain(
      '# preserve this comment',
    );
  });

  it('finds defaults supplied through host metadata', async () => {
    const defaultFile = join(directory, 'default-deployment.yaml');
    await writeFile(defaultFile, 'ram: 512\n');
    expect(
      await applyPatch({ deploymentFile }, 'ram', 1024, {
        host: {
          id: 'fixture',
          name: 'fixture',
          dir: directory,
          relativeDir: 'hosts/fixture',
          hostFile: join(directory, 'host.yaml'),
          relativeHostFile: 'hosts/fixture/host.yaml',
          defaultDeploymentFile: defaultFile,
          guests: [],
          tasks: [],
        },
      }),
    ).toMatchObject({ success: true, layer: 'default' });
    expect(await readFile(defaultFile, 'utf8')).toContain('ram: 1024');
  });

  it('can throw an external-edit conflict while preserving the original file', async () => {
    await expect(
      applyPatch({ deploymentFile }, 'cpu', 4, {
        expectedHash: 'stale-fixture-hash',
        throwOnConflict: true,
      }),
    ).rejects.toBeInstanceOf(WriteConflictError);
    expect(await readFile(deploymentFile, 'utf8')).toBe(
      '# preserve this comment\ncpu: 2\n',
    );
  });

  it('propagates I/O errors without reporting a successful save', async () => {
    const fs = {
      ...defaultNodeFileSystem,
      writeFile: async () => {
        throw new Error('fixture disk full');
      },
    };
    await expect(
      applyPatch({ deploymentFile }, 'cpu', 4, { fs }),
    ).rejects.toThrow('fixture disk full');
  });

  it.each(['!!int 2', '!custom fixture', '!custom', '!!null null'])(
    'preserves explicitly tagged guest scalars: %s',
    async (scalar) => {
      await writeFile(deploymentFile, `cpu: ${scalar}\n`);
      expect(await applyPatch({ deploymentFile }, 'cpu', 4)).toMatchObject({
        success: false,
        reason: 'tag_protected',
        layer: 'override',
      });
      expect(await readFile(deploymentFile, 'utf8')).toBe(`cpu: ${scalar}\n`);
    },
  );

  it.each(['!!int 2', '!custom fixture'])(
    'preserves explicitly tagged inherited scalars: %s',
    async (scalar) => {
      await writeFile(deploymentFile, 'name: fixture\n');
      const defaultDeploymentFile = join(directory, 'default-deployment.yaml');
      await writeFile(defaultDeploymentFile, `cpu: ${scalar}\n`);
      expect(
        await applyPatch({ deploymentFile, defaultDeploymentFile }, 'cpu', 4),
      ).toMatchObject({
        success: false,
        reason: 'tag_protected',
        layer: 'default',
      });
    },
  );
});
