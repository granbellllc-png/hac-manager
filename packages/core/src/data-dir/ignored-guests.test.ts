import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addIgnoredGuest,
  ignoredGuestFingerprint,
  ignoredGuestMatches,
  isIgnoredGuest,
  listIgnoredGuests,
  removeIgnoredGuest,
  type IgnoredGuestIdentity,
} from './ignored-guests.js';

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

const identity: IgnoredGuestIdentity = {
  vmid: 112,
  name: 'mystery',
  type: 'lxc',
  node: 'pve-01',
};

describe('ignored guest identity fingerprints', () => {
  it('matches legacy entries by name and fingerprinted entries exactly', () => {
    const legacy = { vmid: 112, name: 'mystery' };
    expect(ignoredGuestMatches(legacy, identity)).toBe(true);
    expect(
      ignoredGuestMatches(legacy, { ...identity, name: 'replacement' }),
    ).toBe(false);

    const entry = {
      vmid: 112,
      name: 'mystery',
      fingerprint: ignoredGuestFingerprint(identity),
    };
    expect(ignoredGuestMatches(entry, identity)).toBe(true);
    expect(
      ignoredGuestMatches(entry, { ...identity, name: 'replacement' }),
    ).toBe(false);
    expect(ignoredGuestMatches(entry, { ...identity, type: 'vm' })).toBe(false);
    expect(ignoredGuestMatches(entry, { ...identity, node: 'pve-02' })).toBe(
      false,
    );
    expect(ignoredGuestMatches(entry, { ...identity, vmid: 113 })).toBe(false);
  });

  it('keeps all-digit fingerprints as text instead of YAML numbers', async () => {
    const digits = '0'.repeat(64);
    const dir = await fixture(`schema_version: 1
id: pve-01
name: pve-01
type: proxmox
index: 1
connection:
  ssh:
    host: 192.0.2.10
ignored_guests:
  - vmid: 112
    name: mystery
    fingerprint: ${digits}
`);
    await expect(listIgnoredGuests(dir, 'pve-01')).resolves.toEqual([
      { vmid: 112, name: 'mystery', fingerprint: digits },
    ]);
    await expect(isIgnoredGuest(dir, 'pve-01', 112, identity)).resolves.toBe(
      false,
    );
  });

  it('detects lists and treats stale identities as not ignored', async () => {
    const dir = await fixture(hostYaml);
    await expect(listIgnoredGuests(dir, 'pve-01')).resolves.toEqual([
      { vmid: 112, name: 'mystery' },
      { vmid: 113, name: 'other' },
    ]);
    await expect(isIgnoredGuest(dir, 'pve-01', 112, identity)).resolves.toBe(
      true,
    );
    await expect(
      isIgnoredGuest(dir, 'pve-01', 112, {
        ...identity,
        name: 'replacement',
      }),
    ).resolves.toBe(false);
    await expect(listIgnoredGuests(dir, 'missing')).resolves.toEqual([]);
  });

  it('appends a fingerprinted entry, creates the list and is idempotent', async () => {
    const dir = await fixture(`schema_version: 1
id: pve-01
name: pve-01
type: proxmox
index: 1
connection:
  ssh:
    host: 192.0.2.10
# keep this comment
`);
    const created = await addIgnoredGuest(dir, 'pve-01', identity);
    expect(created).toMatchObject({
      ignored: true,
      changed: true,
      replaced: false,
    });
    const written = await readFile(
      join(dir, 'hosts', 'pve-01', 'host.yaml'),
      'utf8',
    );
    expect(written).toContain('# keep this comment');
    expect(written).toContain('ignored_guests:');
    expect(written).toContain('vmid: 112');
    expect(written).toContain('name: mystery');
    expect(written).toContain(
      `fingerprint: ${ignoredGuestFingerprint(identity)}`,
    );

    const again = await addIgnoredGuest(dir, 'pve-01', identity);
    expect(again).toMatchObject({
      ignored: true,
      changed: false,
      reason: 'already_ignored',
    });
  });

  it('replaces a stale entry when the same VMID gets a new identity', async () => {
    const dir = await fixture(hostYaml);
    const replacement = {
      ...identity,
      name: 'replacement',
      type: 'vm' as const,
    };
    const result = await addIgnoredGuest(dir, 'pve-01', replacement);
    expect(result).toMatchObject({
      ignored: true,
      changed: true,
      replaced: true,
    });
    const written = await readFile(
      join(dir, 'hosts', 'pve-01', 'host.yaml'),
      'utf8',
    );
    expect(written).toContain('# keep this comment');
    expect(written).toContain('name: replacement');
    expect(written).toContain('name: other');
    expect(written).not.toContain('name: mystery');
    expect(written).toContain(
      `fingerprint: ${ignoredGuestFingerprint(replacement)}`,
    );
    await expect(isIgnoredGuest(dir, 'pve-01', 112, replacement)).resolves.toBe(
      true,
    );
    await expect(isIgnoredGuest(dir, 'pve-01', 112, identity)).resolves.toBe(
      false,
    );
  });

  it('does not rewrite when the list is an include or the host is missing', async () => {
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
    await expect(
      addIgnoredGuest(included, 'pve-01', { ...identity, node: 'pve-01' }),
    ).resolves.toMatchObject({ ignored: false, reason: 'not_inline' });
    await expect(
      addIgnoredGuest(included, 'missing', identity),
    ).resolves.toMatchObject({ ignored: false, reason: 'host_file_missing' });
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
  - vmid: 114
    name:
      nested: true
  - vmid: 115
    name: weird
    fingerprint:
      nested: true
  - vmid: 112
    name: target
`);
    await expect(listIgnoredGuests(mixed, 'pve-01')).resolves.toEqual([
      { vmid: 115, name: 'weird' },
      { vmid: 112, name: 'target' },
    ]);
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
