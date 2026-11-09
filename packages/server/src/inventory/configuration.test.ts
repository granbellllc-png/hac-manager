import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getConfiguredGuestFromIndex,
  indexConfiguredGuests,
  readGuestConfiguration,
} from './configuration.js';

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
});
