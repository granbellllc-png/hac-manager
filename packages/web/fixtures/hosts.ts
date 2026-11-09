import type { HostSummary } from '../src/pages/hosts';
import type { HostDetailData, ProbeResult } from '../src/pages/host-detail';

export const fixtureHost: HostSummary = {
  id: 'fixture-host',
  name: 'Fixture Host',
  type: 'proxmox',
  index: 1,
  status: 'healthy',
  runtime: {
    overall: 'healthy',
    ssh: { status: 'connected' },
    api: { configured: true, status: 'connected' },
    vault: { status: 'unlocked' },
    queue: { status: 'idle' },
    issues: [],
  },
  updatedAt: '2026-01-01T00:00:00Z',
};

export const fixtureHostDetail: HostDetailData = {
  ...fixtureHost,
  connection: {
    ssh: {
      host: '192.0.2.10',
      port: 22,
      username: 'fixture',
      authMethod: 'key',
    },
  },
};

export const fixtureProbe: ProbeResult = {
  hostId: 'fixture-host',
  pveVersion: 'fixture-pve-8',
  isCluster: true,
  tools: { rsync: false, nsenter: true },
  storages: [
    {
      name: 'fixture-storage',
      type: 'dir',
      content: ['images'],
      avail: 2 * 1024 ** 4,
      shared: true,
    },
  ],
  warnings: ['fixture warning'],
  probedAt: '2026-01-01T00:00:00Z',
};

export const fixtureGuests = [
  {
    hostId: fixtureHost.id,
    vmid: 112,
    name: 'Example LXC',
    type: 'lxc' as const,
    status: 'running',
    node: 'fixture-node',
    cpu: 0.17,
    maxcpu: 2,
    mem: 512 * 1024 ** 2,
    maxmem: 1024 ** 3,
    uptime: 90_061,
    configuration: {
      status: 'configured' as const,
      relativePath: 'hosts/fixture-host/112-example-lxc/deployment.yaml',
    },
  },
  {
    hostId: fixtureHost.id,
    vmid: 212,
    name: 'Unmanaged VM',
    type: 'vm' as const,
    status: 'stopped',
    node: 'fixture-node',
    maxcpu: 4,
    maxmem: 4 * 1024 ** 3,
    configuration: { status: 'orphan' as const },
  },
] as const;

export const fixtureGuestDetail = {
  summary: fixtureGuests[0],
  rawConfig:
    'hostname: example-lxc\ncores: 2\nmemory: 1024\nrootfs: local-lvm:vm-112-disk-0,size=8G\n',
  canonicalConfig: {
    id: 112,
    name: 'Example LXC',
    type: 'lxc',
    cpu: 2,
    ram: 1024,
    disks: [{ name: 'rootfs', storage: 'local-lvm', size_gb: 8 }],
    network: [{ index: 0, bridge: 'vmbr0', ip: 'dhcp' }],
    protection: true,
  },
  source: 'ssh' as const,
  configuration: {
    status: 'configured' as const,
    relativePath: 'hosts/fixture-host/112-example-lxc/deployment.yaml',
    rawYaml: `# Fixture comment must remain visible
schema_version: 1
id: 112
name: Example LXC
type: lxc
cpu: !expr "host.index + 1"
ram: 1024
`,
    hash: 'a'.repeat(64),
    config: {
      schema_version: 1,
      id: 112,
      name: 'Example LXC',
      type: 'lxc',
      cpu: { tag: 'expr', value: 'host.index + 1' },
      ram: 1024,
    },
    issues: [],
  },
};
