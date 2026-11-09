import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isIgnoredGuest, removeIgnoredGuest } from './ignored-guests.js';

const dirs: string[] = [];

async function fixture(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hacm-ignored-'));
  dirs.push(dir);
  await mkdir(join(dir, 'hosts', 'pve-01'), { recursive: true });
  await writeFile(join(dir, 'hosts', 'pve-01', 'host.yaml'), content, 'utf8');
  return dir;
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const hostYaml = `schema_version: 1
id: pve-01
name: pve-01
type: proxmox
index: 1
connection:
  ssh:
    host: 192.0.2.10
# keep this comment
ignored_guests:
  - vmid: 112
    name: mystery
  - vmid: 113
    name: other
`;

describe('ignored guests in host.yaml', () => {
  it('detects an inline ignored guest', async () => {
    const dir = await fixture(hostYaml);
    await expect(isIgnoredGuest(dir, 'pve-01', 112)).resolves.toBe(true);
    await expect(isIgnoredGuest(dir, 'pve-01', 999)).resolves.toBe(false);
    await expect(isIgnoredGuest(dir, 'missing', 112)).resolves.toBe(false);
  });

  it('removes only the matching entry and preserves the rest', async () => {
    const dir = await fixture(hostYaml);
    await expect(removeIgnoredGuest(dir, 'pve-01', 112)).resolves.toMatchObject(
      {
        ignored: true,
      },
    );
    const written = await readFile(
      join(dir, 'hosts', 'pve-01', 'host.yaml'),
      'utf8',
    );
    expect(written).toContain('# keep this comment');
    expect(written).not.toContain('name: mystery');
    expect(written).toContain('name: other');
    await expect(isIgnoredGuest(dir, 'pve-01', 112)).resolves.toBe(false);
    await expect(isIgnoredGuest(dir, 'pve-01', 113)).resolves.toBe(true);
  });

  it('does nothing for a missing entry, include or missing host file', async () => {
    const dir = await fixture(hostYaml);
    await expect(removeIgnoredGuest(dir, 'pve-01', 999)).resolves.toMatchObject(
      { ignored: false },
    );
    const included = await fixture(`schema_version: 1
id: pve-02
name: pve-02
type: proxmox
index: 2
connection:
  ssh:
    host: 192.0.2.11
ignored_guests: !include ignored.yaml
`);
    await expect(isIgnoredGuest(included, 'pve-02', 112)).resolves.toBe(false);
    await expect(
      removeIgnoredGuest(included, 'pve-02', 112),
    ).resolves.toMatchObject({ ignored: false });
    await expect(removeIgnoredGuest(dir, 'missing', 112)).resolves.toEqual({
      ignored: false,
    });
  });
});

describe('ignored guest parsing edge cases', () => {
  it('skips malformed entries and non-list values', async () => {
    const mixed = await fixture(`schema_version: 1
id: pve-03
name: pve-03
type: proxmox
index: 3
connection:
  ssh:
    host: 192.0.2.12
ignored_guests:
  - just-a-string
  - name: no-vmid
  - vmid: not-a-number
    name: bad
  - vmid: 112
    name: target
`);
    await expect(isIgnoredGuest(mixed, 'pve-01', 112)).resolves.toBe(true);
    await expect(isIgnoredGuest(mixed, 'pve-01', 999)).resolves.toBe(false);

    const scalar = await fixture(`schema_version: 1
id: pve-04
name: pve-04
type: proxmox
index: 4
connection:
  ssh:
    host: 192.0.2.13
ignored_guests: not-a-list
`);
    await expect(isIgnoredGuest(scalar, 'pve-01', 112)).resolves.toBe(false);
  });
});
