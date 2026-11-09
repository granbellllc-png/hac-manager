import { describe, expect, it } from 'vitest';
import { HostConnectionRouter } from './router.js';
import { ChannelUnavailableError } from './types.js';
import { FakeTransport } from '@hacm/core';
import type { SshTransport } from '../ssh/types.js';
import { ProxmoxClient } from '../proxmox/client.js';

describe('HostConnectionRouter', () => {
  it('falls back to SSH for reads when API is not configured or fails', async () => {
    // Fake SSH transport simulating pct config
    const fakeSsh = new FakeTransport().onExec('pct config 112', {
      exitCode: 0,
      stdout: 'cores: 2\nmemory: 512\nostype: debian\n',
    }) as unknown as SshTransport;

    // 1. Router with SSH only (API disabled)
    const routerNoApi = new HostConnectionRouter('host-ssh-only', {
      sshTransport: fakeSsh,
    });

    const res1 = await routerNoApi.readGuestConfig(112, 'lxc');
    expect(res1.source).toBe('ssh');
    expect(res1.raw).toContain('cores: 2');

    // 2. Router with API configured that fails -> falls back to SSH
    const failingFetch = (async () => {
      return new Response('API down', {
        status: 503,
        statusText: 'Service Unavailable',
      });
    }) as typeof fetch;

    const failingApiClient = new ProxmoxClient({
      baseUrl: 'https://127.0.0.1:8006',
      auth: { type: 'token', tokenId: 'a!b', tokenSecret: 'c' },
      fetchFn: failingFetch,
    });

    const routerWithFailingApi = new HostConnectionRouter('host-fallback', {
      sshTransport: fakeSsh,
      apiClient: failingApiClient,
    });

    const res2 = await routerWithFailingApi.readGuestConfig(112, 'lxc');
    expect(res2.source).toBe('ssh');
    expect(res2.raw).toContain('cores: 2');
  });

  it('fails fast on SSH-required operations when only API is configured', async () => {
    const mockFetch = (async () => {
      return new Response(JSON.stringify({ data: { cores: 4 } }), {
        status: 200,
      });
    }) as typeof fetch;

    const apiClient = new ProxmoxClient({
      baseUrl: 'https://127.0.0.1:8006',
      auth: { type: 'token', tokenId: 'a!b', tokenSecret: 'c' },
      fetchFn: mockFetch,
    });

    // Router with API only, no SSH
    const routerApiOnly = new HostConnectionRouter('api-only-host', {
      apiClient,
    });

    // API read works
    const configRes = await routerApiOnly.readGuestConfig(112, 'lxc');
    expect(configRes.source).toBe('api');

    // SSH operations MUST fail fast with ChannelUnavailableError
    await expect(routerApiOnly.exec(['pct', 'list'])).rejects.toThrow(
      ChannelUnavailableError,
    );
    await expect(
      routerApiOnly.readFile('/etc/pve/storage.cfg'),
    ).rejects.toThrow(ChannelUnavailableError);
    await expect(
      routerApiOnly.writeFile('/etc/test.txt', 'data'),
    ).rejects.toThrow(ChannelUnavailableError);
  });

  it('tests connection and reports health for both channels', async () => {
    const fakeSsh = new FakeTransport().onExec('echo hacm-ping', {
      exitCode: 0,
      stdout: 'hacm-ping\n',
    }) as unknown as SshTransport;

    const mockFetch = (async (url: string | URL | Request) => {
      if (url.toString().endsWith('/api2/json/nodes')) {
        return new Response(
          JSON.stringify({ data: [{ node: 'pve1', status: 'online' }] }),
          {
            status: 200,
          },
        );
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const apiClient = new ProxmoxClient({
      baseUrl: 'https://127.0.0.1:8006',
      auth: { type: 'token', tokenId: 'a!b', tokenSecret: 'c' },
      fetchFn: mockFetch,
    });

    const router = new HostConnectionRouter('test-host', {
      sshTransport: fakeSsh,
      apiClient,
    });

    const testRes = await router.testConnection();
    expect(testRes.ok).toBe(true);
    expect(testRes.ssh.ok).toBe(true);
    expect(testRes.ssh.status).toBe('connected');
    expect(testRes.api?.ok).toBe(true);
    expect(testRes.api?.status).toBe('connected');
  });
});
