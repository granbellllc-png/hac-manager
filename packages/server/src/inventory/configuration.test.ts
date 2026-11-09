import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getConfiguredGuestFromIndex,
  indexConfiguredGuests,
  parseGuestConfigurationForEditor,
  readGuestConfiguration,
  saveGuestConfiguration,
} from './configuration.js';
import { WriteConflictError } from '@hacm/core';

const tempDirs: string[] = [];

async function createDataDir(deploymentYaml: string): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), 'hacm-configured-guests-'));
  tempDirs.push(dataDir);
  const hostDir = join(dataDir, 'hosts', 'pve-01');
  const guestDir = join(hostDir, '112-adguard');
  await mkdir(guestDir, { recursive: true });
  await writeFile(
    join(hostDir, 'host.yaml'),
    `schema_version: 1
id: pve-01
name: Proxmox 01
type: proxmox
index: 1
connection:
  ssh:
    host: 192.0.2.10
`,
    'utf8',
  );
  await writeFile(join(guestDir, 'deployment.yaml'), deploymentYaml, 'utf8');
  return dataDir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('configured guest inventory', () => {
  it('indexes configured guests and resolves them by host and VMID', async () => {
    const dataDir = await createDataDir(`schema_version: 1
id: 112
name: adguard
type: lxc
`);

    const index = await indexConfiguredGuests(dataDir);
    expect(getConfiguredGuestFromIndex(index, 'pve-01', 112)).toMatchObject({
      name: 'adguard',
      relativePath: 'hosts/pve-01/112-adguard/deployment.yaml',
    });
    expect(getConfiguredGuestFromIndex(index, 'pve-01', 999)).toBeUndefined();
  });

  it('returns the byte-preserved YAML, parsed config, and content hash', async () => {
    const rawYaml = `# keep this comment
schema_version: 1
id: 112
name: adguard
type: lxc
cpu: !expr "host.index + 1"
`;
    const dataDir = await createDataDir(rawYaml);

    const snapshot = await readGuestConfiguration(dataDir, 'pve-01', 112);
    expect(snapshot).toMatchObject({
      status: 'configured',
      rawYaml,
      issues: [],
      config: {
        id: 112,
        type: 'lxc',
      },
    });
    if (snapshot.status === 'configured') {
      expect(snapshot.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('returns validation issues for an invalid configured file and orphan state when absent', async () => {
    const dataDir = await createDataDir(`schema_version: 1
id: 112
name: adguard
type: lxc
unexpected: true
`);

    const invalid = await readGuestConfiguration(dataDir, 'pve-01', 112);
    expect(invalid).toMatchObject({ status: 'configured' });
    if (invalid.status === 'configured') {
      expect(invalid.config).toBeUndefined();
      expect(invalid.issues).not.toHaveLength(0);
    }

    await expect(
      readGuestConfiguration(dataDir, 'pve-01', 999),
    ).resolves.toEqual({ status: 'orphan' });
  });

  it('validates editor content, identity, and every admin-only surface', async () => {
    const identity = {
      vmid: 112,
      name: 'adguard',
      relativePath: 'hosts/pve-01/112-adguard/deployment.yaml',
    };
    const safe = parseGuestConfigurationForEditor(
      `schema_version: 1
id: 112
name: adguard
type: lxc
cpu: 2
`,
      identity,
    );
    expect(safe).toMatchObject({ ok: true, adminOnly: [] });

    const privileged = parseGuestConfigurationForEditor(
      `schema_version: 1
id: 112
name: adguard
type: lxc
cpu: !cmd "vault read cpu"
ram: !include shared/ram.yaml
installation:
  type: community_script
  url: https://example.invalid/install.sh
tasks: []
`,
      { ...identity, relativePath: 'hosts/pve-01/tasks/00-guest.yaml' },
    );
    expect(privileged).toMatchObject({ ok: false });
    expect(privileged.adminOnly).toEqual([
      'cmd',
      'include',
      'installation_url',
      'tasks',
    ]);

    const wrongIdentity = parseGuestConfigurationForEditor(
      `schema_version: 1
id: 113
name: other
type: lxc
`,
      identity,
    );
    expect(wrongIdentity).toMatchObject({ ok: false });
    expect(wrongIdentity.issues.map((issue) => issue.path)).toEqual([
      'id',
      'name',
    ]);
  });

  it('reports malformed YAML without throwing', async () => {
    const parsed = parseGuestConfigurationForEditor('type: [', {
      vmid: 112,
      name: 'adguard',
      relativePath: 'hosts/pve-01/112-adguard/deployment.yaml',
    });
    expect(parsed).toMatchObject({ ok: false });
    expect(parsed.issues).not.toHaveLength(0);

    const cyclic = parseGuestConfigurationForEditor(
      `schema_version: 1
id: 112
name: adguard
type: lxc
extra: &loop
  self: *loop
`,
      {
        vmid: 112,
        name: 'adguard',
        relativePath: 'hosts/pve-01/112-adguard/deployment.yaml',
      },
    );
    expect(cyclic).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'yaml_cycle' })],
    });

    const aliases = Array.from({ length: 101 }, () => '*anchor').join(', ');
    const aliasBomb = parseGuestConfigurationForEditor(
      `anchor: &anchor [value]\nexpanded: [${aliases}]\n`,
      {
        vmid: 112,
        name: 'adguard',
        relativePath: 'hosts/pve-01/112-adguard/deployment.yaml',
      },
    );
    expect(aliasBomb).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: 'yaml_parse',
          message: expect.stringContaining('Excessive alias count'),
        }),
      ],
    });

    const dataDir = await createDataDir('type: [');
    const snapshot = await readGuestConfiguration(dataDir, 'pve-01', 112);
    expect(snapshot).toMatchObject({ status: 'configured' });
    if (snapshot.status === 'configured') {
      expect(snapshot.issues).not.toHaveLength(0);
    }
  });

  it('saves through the CST write guard, preserves comments, and refuses stale hashes', async () => {
    const rawYaml = `# preserved comment
schema_version: 1
id: 112
name: adguard
type: lxc
cpu: 1
`;
    const dataDir = await createDataDir(rawYaml);
    const index = await indexConfiguredGuests(dataDir);
    const guest = getConfiguredGuestFromIndex(index, 'pve-01', 112)!;
    const snapshot = await readGuestConfiguration(dataDir, 'pve-01', 112);
    expect(snapshot.status).toBe('configured');
    if (snapshot.status !== 'configured') return;

    const parsed = parseGuestConfigurationForEditor(
      rawYaml.replace('cpu: 1', 'cpu: 2'),
      {
        vmid: 112,
        name: 'adguard',
        relativePath: guest.relativePath,
      },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const saved = await saveGuestConfiguration(guest, parsed, snapshot.hash);
    expect(saved.rawYaml).toContain('# preserved comment');
    expect(saved.rawYaml).toContain('cpu: 2');
    expect(saved.hash).not.toBe(snapshot.hash);

    await expect(
      saveGuestConfiguration(guest, parsed, snapshot.hash),
    ).rejects.toBeInstanceOf(WriteConflictError);
  });
});
