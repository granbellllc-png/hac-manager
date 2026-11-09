import { describe, expect, it } from 'vitest';
import { HostProber } from './prober.js';
import { HostConnectionRouter } from '../router/router.js';
import { FakeTransport } from '@hacm/core';
import type { SshTransport } from '../ssh/types.js';
import { ProxmoxClient } from '../proxmox/client.js';

describe('HostProber', () => {
  it('probes standalone host correctly with PVE version, storages, and tools', async () => {
    const fakeSsh = new FakeTransport()
      .onExec('pveversion', {
        stdout: 'pve-manager/8.2.4/e8e8e8e (running kernel: 6.8.8-2-pve)\n',
      })
      .onExec('pvecm status', {
        exitCode: 1,
        stderr: 'Cannot initialize CMAP service\n',
      })
      .onExec('which setfacl rsync restic nsenter', {
        stdout: '/usr/bin/setfacl\n/usr/bin/rsync\n/usr/bin/nsenter\n',
      }) as unknown as SshTransport;

    const mockFetch = (async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.endsWith('/api2/json/nodes/pve1/status')) {
        return new Response(
          JSON.stringify({
            data: {
              node: 'pve1',
              pveversion: 'pve-manager/8.2.4/e8e8e8e',
              uptime: 123456,
              cpu: 0.1,
              wait: 0,
              memory: {
                total: 16000000000,
                used: 8000000000,
                free: 8000000000,
              },
              rootfs: {
                total: 100000000000,
                used: 20000000000,
                free: 80000000000,
                avail: 80000000000,
              },
            },
          }),
          { status: 200 },
        );
      }
      if (u.endsWith('/api2/json/cluster/status')) {
        return new Response(
          JSON.stringify({
            data: [
              { type: 'node', name: 'pve1', ip: '192.168.1.10', online: 1 },
            ],
          }),
          { status: 200 },
        );
      }
      if (u.endsWith('/api2/json/nodes/pve1/storage')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                storage: 'local',
                type: 'dir',
                content: 'vztmpl,iso,backup',
                total: 1000000000,
                used: 200000000,
                avail: 800000000,
                shared: 0,
              },
              {
                storage: 'local-lvm',
                type: 'lvmthin',
                content: 'rootdir,images',
                total: 5000000000,
                used: 1000000000,
                avail: 4000000000,
                shared: 0,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const client = new ProxmoxClient({
      baseUrl: 'https://127.0.0.1:8006',
      auth: { type: 'token', tokenId: 'a!b', tokenSecret: 'c' },
      fetchFn: mockFetch,
    });

    const router = new HostConnectionRouter('standalone-host', {
      sshTransport: fakeSsh,
      apiClient: client,
      defaultNode: 'pve1',
    });

    const prober = new HostProber();
    const result = await prober.probe(
      'standalone-host',
      router,
      client,
      'pve1',
    );

    expect(result.hostId).toBe('standalone-host');
    expect(result.pveVersion).toContain('8.2.4');
    expect(result.isCluster).toBe(false);
    expect(result.storages).toHaveLength(2);
    expect(result.storages[1]?.name).toBe('local-lvm');
    expect(result.storages[1]?.content).toContain('rootdir');
    expect(result.tools.setfacl).toBe(true);
    expect(result.tools.rsync).toBe(true);
    expect(result.tools.restic).toBe(false);
    expect(result.warnings.some((w) => w.includes('cluster'))).toBe(false);
  });

  it('detects clustered host and surfaces a prominent warning', async () => {
    const fakeSsh = new FakeTransport()
      .onExec('pveversion', {
        stdout: 'pve-manager/8.2.4\n',
      })
      .onExec('which setfacl rsync restic nsenter', {
        stdout: '/usr/bin/setfacl\n/usr/bin/rsync\n',
      }) as unknown as SshTransport;

    const mockFetch = (async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.endsWith('/api2/json/cluster/status')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                type: 'cluster',
                name: 'homelab-cluster',
                nodes: 3,
                quorate: 1,
              },
              { type: 'node', name: 'pve1', online: 1 },
              { type: 'node', name: 'pve2', online: 1 },
              { type: 'node', name: 'pve3', online: 1 },
            ],
          }),
          { status: 200 },
        );
      }
      if (u.endsWith('/api2/json/nodes/pve1/status')) {
        return new Response(
          JSON.stringify({
            data: { pveversion: 'pve-manager/8.2.4' },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    const client = new ProxmoxClient({
      baseUrl: 'https://127.0.0.1:8006',
      auth: { type: 'token', tokenId: 'a!b', tokenSecret: 'c' },
      fetchFn: mockFetch,
    });

    const router = new HostConnectionRouter('clustered-host', {
      sshTransport: fakeSsh,
      apiClient: client,
      defaultNode: 'pve1',
    });

    const prober = new HostProber();
    const result = await prober.probe('clustered-host', router, client, 'pve1');

    expect(result.isCluster).toBe(true);
    expect(result.clusterName).toBe('homelab-cluster');
    expect(result.warnings.some((w) => w.includes('homelab-cluster'))).toBe(
      true,
    );
    expect(
      result.warnings.some((w) => w.includes('Clusters are unsupported in v1')),
    ).toBe(true);
  });
});
