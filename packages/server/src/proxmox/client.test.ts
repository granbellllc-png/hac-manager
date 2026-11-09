import { describe, expect, it } from 'vitest';
import { ProxmoxClient, parseNodeFromUpid } from './client.js';
import { ProxmoxApiError, ProxmoxTaskError } from './errors.js';

describe('ProxmoxClient', () => {
  it('parses node correctly from UPID', () => {
    expect(
      parseNodeFromUpid(
        'UPID:pve1:00001234:00005678:672D:vzstart:112:root@pam:',
      ),
    ).toBe('pve1');
    expect(parseNodeFromUpid('invalid')).toBe('localhost');
  });

  it('authenticates with API token and queries resources', async () => {
    const interceptedHeaders: Record<string, string>[] = [];

    const mockFetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const urlStr = url.toString();
      interceptedHeaders.push((init?.headers ?? {}) as Record<string, string>);

      if (urlStr.endsWith('/api2/json/cluster/resources')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'lxc/112',
                node: 'pve-node-1',
                type: 'lxc',
                vmid: 112,
                name: 'dns-server',
                status: 'running',
                cpu: 0.05,
                maxcpu: 2,
                mem: 104857600,
                maxmem: 536870912,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.endsWith('/api2/json/nodes/pve-node-1/lxc/112/config')) {
        return new Response(
          JSON.stringify({
            data: {
              arch: 'amd64',
              cores: 2,
              memory: 512,
              net0: 'name=eth0,bridge=vmbr0,firewall=1,hwaddr=BC:24:11:22:33:44,ip=dhcp',
              ostype: 'debian',
              rootfs: 'local-lvm:subvol-112-disk-0,size=8G',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const client = new ProxmoxClient({
      baseUrl: 'https://pve.example.local:8006',
      auth: {
        type: 'token',
        tokenId: 'root@pam!hacm',
        tokenSecret: 'fake-secret-uuid',
      },
      fetchFn: mockFetch,
    });

    const resources = await client.getClusterResources();
    expect(resources).toHaveLength(1);
    expect(resources[0]?.vmid).toBe(112);
    expect(resources[0]?.name).toBe('dns-server');
    expect(interceptedHeaders[0]?.Authorization).toBe(
      'PVEAPIToken=root@pam!hacm=fake-secret-uuid',
    );

    const config = await client.getLxcConfig('pve-node-1', 112);
    expect(config.cores).toBe(2);
    expect(config.ostype).toBe('debian');
  });

  it('authenticates with ticket, handles CSRF and refreshes on 401', async () => {
    let ticketLogins = 0;
    let requestCount = 0;

    const mockFetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const urlStr = url.toString();

      if (urlStr.endsWith('/api2/json/access/ticket')) {
        ticketLogins++;
        return new Response(
          JSON.stringify({
            data: {
              ticket: `PVE:ticket-value-${ticketLogins}`,
              CSRFPreventionToken: `CSRF:token-value-${ticketLogins}`,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.endsWith('/api2/json/nodes/pve-1/lxc/100/status/start')) {
        requestCount++;
        if (requestCount === 1) {
          // Simulate expired ticket on first call
          return new Response('Unauthorized', {
            status: 401,
            statusText: 'Unauthorized',
          });
        }
        // Verify CSRF prevention token was sent
        const headers = init?.headers as Record<string, string>;
        expect(headers['CSRFPreventionToken']).toContain('CSRF:token-value-2');
        expect(headers['Cookie']).toContain('PVEAuthCookie=PVE:ticket-value-2');

        return new Response(
          JSON.stringify({
            data: 'UPID:pve-1:00001:00002:12345:vzstart:100:root@pam:',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const client = new ProxmoxClient({
      baseUrl: 'https://pve.example.local:8006',
      auth: {
        type: 'ticket',
        username: 'root@pam',
        password: 'secretpassword',
      },
      fetchFn: mockFetch,
    });

    const upid = await client.lxcPowerAction('pve-1', 100, 'start');
    expect(upid).toBe('UPID:pve-1:00001:00002:12345:vzstart:100:root@pam:');
    expect(ticketLogins).toBe(2); // Initial + refreshed on 401
  });

  it('polls task UPID and awaits completion with streaming progress', async () => {
    let pollCount = 0;
    const progressLines: string[] = [];

    const mockFetch = (async (url: string | URL | Request) => {
      const urlStr = url.toString();

      if (urlStr.includes('/tasks/') && urlStr.includes('/status')) {
        pollCount++;
        if (pollCount < 3) {
          return new Response(
            JSON.stringify({
              data: {
                status: 'running',
                node: 'pve-node-1',
                pid: 1234,
                type: 'vzstart',
                user: 'root@pam',
                upid: 'UPID:pve-node-1:0001:0002:1234:vzstart:112:root@pam:',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        } else {
          return new Response(
            JSON.stringify({
              data: {
                status: 'stopped',
                exitstatus: 'OK',
                node: 'pve-node-1',
                pid: 1234,
                type: 'vzstart',
                user: 'root@pam',
                upid: 'UPID:pve-node-1:0001:0002:1234:vzstart:112:root@pam:',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      }

      if (urlStr.includes('/tasks/') && urlStr.includes('/log')) {
        return new Response(
          JSON.stringify({
            data: [
              { n: 1, t: 'starting container 112' },
              { n: 2, t: 'network configured' },
              { n: 3, t: 'container started successfully' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const client = new ProxmoxClient({
      baseUrl: 'https://pve.example.local:8006',
      auth: {
        type: 'token',
        tokenId: 'root@pam!hacm',
        tokenSecret: 'secret',
      },
      fetchFn: mockFetch,
    });

    const result = await client.waitForTask(
      'UPID:pve-node-1:0001:0002:1234:vzstart:112:root@pam:',
      {
        intervalMs: 10,
        onProgress: (line) => progressLines.push(line),
      },
    );

    expect(result.status).toBe('stopped');
    expect(result.exitstatus).toBe('OK');
    expect(progressLines).toContain('starting container 112');
    expect(progressLines).toContain('container started successfully');
  });

  it('fails with ProxmoxTaskError if task finishes with non-OK exitstatus', async () => {
    const mockFetch = (async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/status')) {
        return new Response(
          JSON.stringify({
            data: {
              status: 'stopped',
              exitstatus: 'command failed with exit code 1',
              node: 'pve-1',
              pid: 999,
              type: 'vzstart',
              user: 'root@pam',
              upid: 'UPID:pve-1:0001:0002:1234:vzstart:112:root@pam:',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    const client = new ProxmoxClient({
      baseUrl: 'https://pve.example.local:8006',
      auth: { type: 'token', tokenId: 'a!b', tokenSecret: 'c' },
      fetchFn: mockFetch,
    });

    await expect(
      client.waitForTask('UPID:pve-1:0001:0002:1234:vzstart:112:root@pam:', {
        intervalMs: 10,
      }),
    ).rejects.toThrow(ProxmoxTaskError);
  });

  it('maps HTTP errors into ProxmoxApiError', async () => {
    const mockFetch = (async () => {
      return new Response(
        JSON.stringify({ errors: { vmid: 'already exists' } }),
        {
          status: 400,
          statusText: 'Bad Request',
        },
      );
    }) as typeof fetch;

    const client = new ProxmoxClient({
      baseUrl: 'https://pve.example.local:8006',
      auth: { type: 'token', tokenId: 'a!b', tokenSecret: 'c' },
      fetchFn: mockFetch,
    });

    await expect(client.getClusterResources()).rejects.toThrow(ProxmoxApiError);
  });
});
