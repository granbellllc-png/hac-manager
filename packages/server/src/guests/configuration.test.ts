import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadGuestDeployment,
  GuestConfigurationError,
} from './configuration.js';

const tempDirs: string[] = [];

async function createDataDir(
  deployment = `schema_version: 1
id: 112
name: example-lxc
type: lxc
cpu: 2
ram: 1024
disks: []
network: []
`,
  defaults?: string,
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'hacm-guest-config-'));
  tempDirs.push(dataDir);
  const hostDir = join(dataDir, 'hosts', 'pve-01');
  const guestDir = join(hostDir, '112-example-lxc');
  await mkdir(guestDir, { recursive: true });
  await writeFile(
    join(hostDir, 'host.yaml'),
    `schema_version: 1
id: pve-01
name: PVE 01
type: proxmox
index: 1
connection:
  ssh:
    host: 192.0.2.1
`,
    'utf8',
  );
  await writeFile(join(guestDir, 'deployment.yaml'), deployment, 'utf8');
  if (defaults !== undefined) {
    await writeFile(join(hostDir, 'default-deployment.yaml'), defaults, 'utf8');
  }
  return dataDir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('loadGuestDeployment', () => {
  it('loads and merges the deployment with host defaults', async () => {
    const dataDir = await createDataDir(
      `schema_version: 1
id: 112
name: example-lxc
type: lxc
disks: []
network: []
`,
      `schema_version: 1
cpu: 4
ram: 2048
`,
    );
    const loaded = await loadGuestDeployment(dataDir, 'pve-01', 112);
    expect(loaded).toMatchObject({
      relativePath: 'hosts/pve-01/112-example-lxc/deployment.yaml',
      deployment: {
        id: 112,
        name: 'example-lxc',
        cpu: 4,
        ram: 2048,
      },
    });
    expect(await loadGuestDeployment(dataDir, 'nope', 112)).toBeNull();
    expect(await loadGuestDeployment(dataDir, 'pve-01', 999)).toBeNull();
  });

  it('loads the deployment alone when the host has no defaults', async () => {
    const dataDir = await createDataDir();
    const loaded = await loadGuestDeployment(dataDir, 'pve-01', 112);
    expect(loaded).toMatchObject({
      relativePath: 'hosts/pve-01/112-example-lxc/deployment.yaml',
      deployment: { id: 112, cpu: 2, ram: 1024 },
    });
  });

  it('reports invalid deployment and defaults with file context', async () => {
    const invalidGuest = await createDataDir(`schema_version: 1
id: 112
name: example-lxc
type: lxc
cpu: nope
ram: 1024
disks: []
network: []
`);
    await expect(
      loadGuestDeployment(invalidGuest, 'pve-01', 112),
    ).rejects.toBeInstanceOf(GuestConfigurationError);

    const invalidDefaults = await createDataDir(
      undefined,
      `schema_version: 1
cpu: nope
`,
    );
    await expect(
      loadGuestDeployment(invalidDefaults, 'pve-01', 112),
    ).rejects.toThrow(
      "Default deployment 'hosts/pve-01/default-deployment.yaml'",
    );
  });

  it('reports merge validation failures', async () => {
    const mismatched = await createDataDir(
      undefined,
      `schema_version: 1
bios: ovmf
`,
    );
    await expect(
      loadGuestDeployment(mismatched, 'pve-01', 112),
    ).rejects.toThrow('Merged deployment for guest 112 is invalid');
  });
});
