import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initDataDir } from './init.js';

describe('physical data directory initialization', () => {
  it('creates parent directories and preserves pre-existing user files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hacm-init-physical-'));
    try {
      const result = await initDataDir({
        dataDir: `${directory}/`,
        hostId: ' ',
        hostName: ' ',
        hostIp: ' ',
      });
      expect(result.actions).toHaveLength(8);
      expect(
        result.actions.every((action) => action.status === 'created'),
      ).toBe(true);
      expect(
        await readFile(join(directory, 'hosts/pve-01/host.yaml'), 'utf8'),
      ).toContain('192.0.2.10');
      const secrets = join(directory, 'secrets.yaml');
      await writeFile(secrets, '# owner-authored fake fixture\n');
      expect(
        (await initDataDir({ dataDir: directory })).actions.every(
          (action) => action.status === 'skipped',
        ),
      ).toBe(true);
      expect(await readFile(secrets, 'utf8')).toBe(
        '# owner-authored fake fixture\n',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
