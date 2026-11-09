import { describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '@hacm/core';
import type { SshTransport } from '../ssh/types.js';
import { HostConnectionRouter } from '../router/router.js';
import { ProxmoxClient } from '../proxmox/client.js';
import { HostProber } from './prober.js';

describe('host probing with unavailable capabilities', () => {
  it('uses SSH fallbacks for version, cluster, storage and tools after API failure', async () => {
    const transport = new FakeTransport()
      .onExec('pveversion', { stdout: 'pve-manager/8.4\n' })
      .onExec('pvecm status', {
        stdout: 'Cluster Name: fixture-cluster\nNodes: 2\n',
      })
      .onExec('pvesm status', {
        stdout: 'Name Type Status\nfixture-zfs zfspool active\nmalformed\n',
      })
      .onExec('which setfacl rsync restic nsenter', {
        stdout: '/usr/bin/restic\n',
      }) as unknown as SshTransport;
    const client = new ProxmoxClient({
      baseUrl: 'https://fixture.invalid',
      auth: {
        type: 'token',
        tokenId: 'fixture!test',
        tokenSecret: 'fixture-token',
      },
      fetchFn: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error('fixture offline')),
    });
    const result = await new HostProber().probe(
      'fixture',
      new HostConnectionRouter('fixture', { sshTransport: transport }),
      client,
    );
    expect(result.pveVersion).toBe('pve-manager/8.4');
    expect(result.isCluster).toBe(true);
    expect(result.clusterName).toBe('fixture-cluster');
    expect(result.storages).toEqual([
      {
        name: 'fixture-zfs',
        type: 'zfspool',
        content: ['rootdir', 'images'],
        shared: false,
      },
    ]);
    expect(result.warnings).toHaveLength(3);
  });

  it.each(['Nodes: 2', 'standalone fixture'])(
    'detects cluster membership from %s',
    async (clusterOutput) => {
      const transport = new FakeTransport()
        .onExec('pveversion', { exitCode: 1 })
        .onExec('pvecm status', { stdout: clusterOutput })
        .onExec('pvesm status', { exitCode: 1 })
        .onExec('which setfacl rsync restic nsenter', {
          stdout: '',
        }) as unknown as SshTransport;
      const result = await new HostProber().probe(
        'fixture',
        new HostConnectionRouter('fixture', { sshTransport: transport }),
      );
      expect(result.pveVersion).toBe('unknown');
      expect(result.isCluster).toBe(clusterOutput.includes('2'));
      expect(result.storages).toEqual([]);
    },
  );

  it('degrades gracefully with no channel and emits actionable tool warnings', async () => {
    const result = await new HostProber().probe(
      'fixture',
      new HostConnectionRouter('fixture'),
    );
    expect(result.pveVersion).toBe('unknown');
    expect(result.tools.rsync).toBe(false);
    expect(result.warnings).toHaveLength(2);
  });

  it('handles missing optional API fields and unnamed multi-host clusters', async () => {
    const client = new ProxmoxClient({
      baseUrl: 'https://fixture.invalid',
      auth: {
        type: 'token',
        tokenId: 'fixture!test',
        tokenSecret: 'fixture-token',
      },
      fetchFn: vi.fn<typeof fetch>().mockImplementation(async (url) => {
        const path = String(url);
        if (path.endsWith('/cluster/status'))
          return Response.json({ data: [{ type: 'node' }, { type: 'node' }] });
        if (path.endsWith('/storage'))
          return Response.json({ data: [{ storage: 'fixture', type: 'dir' }] });
        return Response.json({ data: {} });
      }),
    });
    const result = await new HostProber().probe(
      'fixture',
      new HostConnectionRouter('fixture'),
      client,
    );
    expect(result.pveVersion).toBe('unknown');
    expect(result.isCluster).toBe(true);
    expect(result.storages[0]?.content).toEqual([]);
    expect(result.warnings[0]).toContain("'unknown'");
  });
});
