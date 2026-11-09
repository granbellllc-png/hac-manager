import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';

describe('workspace configuration paths', () => {
  it('resolves existing direct paths, existing workspace paths, and new relative paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hacm-config-paths-'));
    try {
      const cwd = join(directory, 'packages', 'server');
      await mkdir(join(directory, 'fixture-data'), { recursive: true });
      await mkdir(join(cwd, 'direct-data'), { recursive: true });
      vi.spyOn(process, 'cwd').mockReturnValue(cwd);
      expect(
        loadConfig({
          HACM_DATA_DIR: 'fixture-data',
          HACM_STATE_DIR: 'new-state',
        }),
      ).toMatchObject({
        HACM_DATA_DIR: join(directory, 'fixture-data'),
        HACM_STATE_DIR: join(cwd, 'new-state'),
      });
      expect(
        loadConfig({
          HACM_DATA_DIR: 'direct-data',
          HACM_STATE_DIR: 'new-state',
        }).HACM_DATA_DIR,
      ).toBe(join(cwd, 'direct-data'));
    } finally {
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
