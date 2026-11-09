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
