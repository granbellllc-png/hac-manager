import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseProxmoxConfig,
  type GuestDeployment,
  type HostFile,
} from '@hacm/core';
import { createDatabase } from '../db/connection.js';
import { createSqliteRepositories } from '../db/repositories/sqlite.js';
import type { DatabaseRepositories } from '../db/repositories/types.js';
import type { LiveInventoryService } from '../inventory/service.js';
import { DriftGuestNotFoundError, DriftService } from './service.js';

const baseDeployment = `schema_version: 1
id: 112
name: adguard
type: lxc
cpu: !expr "host.index + 1"
ram: 2048
disks: []
network: []
`;

async function createDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), 'hacm-drift-test-'));
  const hostDir = join(dataDir, 'hosts', 'pve-01');
  await mkdir(hostDir, { recursive: true });
  await writeFile(
    join(hostDir, 'host.yaml'),
    `schema_version: 1
id: pve-01
name: Proxmox Node 1
type: proxmox
index: 1
connection:
  ssh:
    host: 192.0.2.10
    port: 22
    username: root
`,
    'utf8',
  );
  return dataDir;
}

async function writeGuest(
  dataDir: string,
  vmid: number,
  name: string,
  yaml: string,
): Promise<void> {
  const guestDir = join(dataDir, 'hosts', 'pve-01', `${vmid}-${name}`);
  await mkdir(guestDir, { recursive: true });
  await writeFile(join(guestDir, 'deployment.yaml'), yaml, 'utf8');
}

function guestYaml(vmid: number, name: string, overrides: string): string {
  return `schema_version: 1
id: ${vmid}
name: ${name}
type: lxc
cpu: 2
ram: 2048
disks: []
network: []
${overrides}`;
}

function live(
  raw: string,
  type: 'lxc' | 'vm' = 'lxc',
  vmid = 112,
): GuestDeployment {
  return parseProxmoxConfig(raw, type, vmid);
}

function hostRegistryStub(dataDir: string) {
  return {
    dataDir,
    getRawHost: (id: string): HostFile | undefined =>
      id === 'pve-01'
        ? ({ name: 'Proxmox Node 1', index: 1 } as unknown as HostFile)
        : undefined,
  };
}

function inventoryStub(
  value: GuestDeployment | ((vmid: number) => Promise<GuestDeployment>),
): Pick<LiveInventoryService, 'getGuestLiveConfig'> & {
  getGuestLiveConfig: ReturnType<typeof vi.fn>;
} {
  const getGuestLiveConfig = vi.fn(async (_hostId: string, vmid: number) => {
    const canonicalConfig =
      typeof value === 'function' ? await value(vmid) : value;
    return {
      summary: {
        hostId: 'pve-01',
        vmid,
        name: 'guest',
        type: 'lxc' as const,
        status: 'running',
        node: 'localhost',
      },
      rawConfig: '',
      canonicalConfig,
      source: 'ssh' as const,
    };
  });
  return { getGuestLiveConfig };
}

function repoFixture(): {
  handle: ReturnType<typeof createDatabase>;
  repos: DatabaseRepositories;
} {
  const handle = createDatabase({ path: ':memory:' });
  return { handle, repos: createSqliteRepositories(handle.db) };
}

describe('DriftService', () => {
  it('compares a guest once and persists a redacted snapshot with provenance', async () => {
    const dataDir = await createDataDir();
    await writeGuest(dataDir, 112, 'adguard', baseDeployment);
    const { handle, repos } = repoFixture();
    try {
      const service = new DriftService({
        repos,
        hostRegistry: hostRegistryStub(dataDir),
        inventoryService: inventoryStub(
          live('hostname: adguard\ncores: 2\nmemory: 4096\n'),
        ),
        now: () => new Date('2026-11-09T10:00:00.000Z'),
      });

      const snapshot = await service.checkGuest('pve-01', 112);
      expect(snapshot).toMatchObject({
        hostId: 'pve-01',
        vmid: 112,
        type: 'lxc',
        status: 'drifted',
        checkedAt: '2026-11-09T10:00:00.000Z',
      });
      expect(snapshot.changes).toHaveLength(1);
      expect(snapshot.changes[0]).toMatchObject({
        path: 'ram',
        category: 'config',
        kind: 'changed',
        desired: 2048,
        actual: 4096,
        pullable: true,
        provenance: {
          layer: 'override',
          file: 'hosts/pve-01/112-adguard/deployment.yaml',
          path: 'ram',
          sourcePath: 'ram',
        },
      });
      expect(snapshot.computedFields).toEqual([]);

      expect(await service.get('pve-01', 112)).toEqual(snapshot);
      expect(await service.get('pve-01', 999)).toBeNull();
      expect(await service.list({ hostId: 'pve-01' })).toEqual([snapshot]);
      expect(
        await service.list({ hostId: 'pve-01', vmid: 112, limit: 1 }),
      ).toEqual([snapshot]);
      expect(await service.list({ statuses: ['in_sync'] })).toEqual([]);
    } finally {
      handle.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('flags resolved tags as computed and never pullable', async () => {
    const dataDir = await createDataDir();
    await writeGuest(dataDir, 112, 'adguard', baseDeployment);
    const { handle, repos } = repoFixture();
    try {
      const service = new DriftService({
        repos,
        hostRegistry: hostRegistryStub(dataDir),
        inventoryService: inventoryStub(
          live('hostname: adguard\ncores: 8\nmemory: 2048\n'),
        ),
      });

      const snapshot = await service.checkGuest('pve-01', 112);
      expect(snapshot.changes).toHaveLength(1);
      expect(snapshot.changes[0]).toMatchObject({
        path: 'cpu',
        desired: 2,
        actual: 8,
        computed: true,
        pullable: false,
        tag: 'expr',
      });
      expect(snapshot.computedFields).toContain('cpu');
    } finally {
      handle.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('leaves unresolved tags out of the diff and marks them computed', async () => {
    const dataDir = await createDataDir();
    await writeGuest(
      dataDir,
      112,
      'adguard',
      baseDeployment.replace(
        'cpu: !expr "host.index + 1"',
        'cpu: !env UNKNOWN_DRIFT_VAR',
      ),
    );
    const { handle, repos } = repoFixture();
    try {
      const service = new DriftService({
        repos,
        hostRegistry: hostRegistryStub(dataDir),
        inventoryService: inventoryStub(
          live('hostname: adguard\ncores: 2\nmemory: 2048\n'),
        ),
      });

      const snapshot = await service.checkGuest('pve-01', 112);
      expect(snapshot.status).toBe('in_sync');
      expect(snapshot.changes).toEqual([]);
      expect(snapshot.computedFields).toEqual(['cpu']);
    } finally {
      handle.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('resolves secrets through the connection secret manager', async () => {
    const dataDir = await createDataDir();
    await writeGuest(
      dataDir,
      112,
      'adguard',
      `schema_version: 1
id: 112
name: adguard
type: lxc
cpu: 2
ram: 2048
disks: []
network:
  - index: 0
    bridge: !secret BRIDGE
`,
    );
    const { handle, repos } = repoFixture();
    try {
      const resolveSecret = vi
        .fn()
        .mockResolvedValue({ status: 'found', value: 'vmbr0' });
      const service = new DriftService({
        repos,
        hostRegistry: hostRegistryStub(dataDir),
        inventoryService: inventoryStub(
          live(
            'hostname: adguard\ncores: 2\nmemory: 2048\nnet0: bridge=vmbr0\n',
          ),
        ),
        connections: {
          secretManager: { resolveSecret } as never,
        },
      });

      const snapshot = await service.checkGuest('pve-01', 112);
      expect(resolveSecret).toHaveBeenCalledWith('BRIDGE');
      expect(snapshot.status).toBe('in_sync');
      expect(snapshot.changes).toEqual([]);
    } finally {
      handle.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('honours additional ignored paths', async () => {
    const dataDir = await createDataDir();
    await writeGuest(dataDir, 112, 'adguard', baseDeployment);
    const { handle, repos } = repoFixture();
    try {
      const service = new DriftService({
        repos,
        hostRegistry: hostRegistryStub(dataDir),
        inventoryService: inventoryStub(
          live('hostname: adguard\ncores: 2\nmemory: 4096\n'),
        ),
        ignoredPaths: ['ram'],
      });

      const snapshot = await service.checkGuest('pve-01', 112);
      expect(snapshot.status).toBe('in_sync');
      expect(snapshot.changes).toEqual([]);
      expect(snapshot.ignoredPaths).toContain('ram');
    } finally {
      handle.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('falls back to the host id when the raw host is unavailable', async () => {
    const dataDir = await createDataDir();
    await writeGuest(dataDir, 112, 'adguard', guestYaml(112, 'adguard', ''));
    const { handle, repos } = repoFixture();
    try {
      const service = new DriftService({
        repos,
        hostRegistry: {
          dataDir,
          getRawHost: () => undefined,
        },
        inventoryService: inventoryStub(
          live('hostname: adguard\ncores: 2\nmemory: 2048\n'),
        ),
      });

      const snapshot = await service.checkGuest('pve-01', 112);
      expect(snapshot.status).toBe('in_sync');
      expect(snapshot.computedFields).toEqual([]);
    } finally {
      handle.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('throws when the guest has no deployment YAML', async () => {
    const dataDir = await createDataDir();
    const { handle, repos } = repoFixture();
    try {
      const service = new DriftService({
        repos,
        hostRegistry: hostRegistryStub(dataDir),
        inventoryService: inventoryStub(
          live('hostname: adguard\ncores: 2\nmemory: 2048\n'),
        ),
      });

      await expect(service.checkGuest('pve-01', 999)).rejects.toBeInstanceOf(
        DriftGuestNotFoundError,
      );
    } finally {
      handle.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('checks every configured guest on a host and reports failures', async () => {
    const dataDir = await createDataDir();
    await writeGuest(dataDir, 112, 'adguard', guestYaml(112, 'adguard', ''));
    await writeGuest(dataDir, 113, 'dns', guestYaml(113, 'dns', ''));
    const { handle, repos } = repoFixture();
    try {
      const service = new DriftService({
        repos,
        hostRegistry: hostRegistryStub(dataDir),
        inventoryService: inventoryStub(async (vmid) => {
          if (vmid === 113) throw new Error('live config unavailable');
          return live(
            'hostname: adguard\ncores: 2\nmemory: 2048\n',
            'lxc',
            vmid,
          );
        }),
      });

      const result = await service.checkHost('pve-01');
      expect(result).toMatchObject({
        hostId: 'pve-01',
        checked: 2,
      });
      expect(result.snapshots.map((snapshot) => snapshot.vmid)).toEqual([112]);
      expect(result.failures).toEqual([
        { vmid: 113, message: 'live config unavailable' },
      ]);
    } finally {
      handle.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
