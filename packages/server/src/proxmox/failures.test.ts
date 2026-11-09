import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProxmoxClient } from './client.js';
import { ProxmoxApiError } from './errors.js';

function clientWith(fetchFn: typeof fetch, ticket = false) {
  return new ProxmoxClient({
    baseUrl: 'https://fixture.invalid/',
    auth: ticket
      ? {
          type: 'ticket',
          username: 'fixture@pam',
          password: 'fixture-password',
        }
      : {
          type: 'token',
          tokenId: 'fixture!test',
          tokenSecret: 'fixture-token',
        },
    fetchFn,
  });
}
afterEach(() => vi.useRealTimers());

describe('Proxmox API request contract', () => {
  it('calls the correct LXC, VM, task and cluster endpoints', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ data: [] }));
    const client = clientWith(fetchFn);
    await client.getClusterResources('qemu');
    await client.listLxc('fixture');
    await client.getLxcStatus('fixture', 100);
    await client.listQemu('fixture');
    await client.getQemuStatus('fixture', 200);
    await client.getQemuAgentInfo('fixture', 200);
    await client.getTaskLog('fixture', 'UPID:fixture:1');
    const paths = fetchFn.mock.calls.map(
      ([url]) => new URL(String(url)).pathname + new URL(String(url)).search,
    );
    expect(paths).toEqual([
      '/api2/json/cluster/resources?type=qemu',
      '/api2/json/nodes/fixture/lxc',
      '/api2/json/nodes/fixture/lxc/100/status/current',
      '/api2/json/nodes/fixture/qemu',
      '/api2/json/nodes/fixture/qemu/200/status/current',
      '/api2/json/nodes/fixture/qemu/200/agent/info',
      '/api2/json/nodes/fixture/tasks/UPID%3Afixture%3A1/log?start=0&limit=500',
    ]);
  });

  it('serializes mutation bodies and accepts unwrapped response payloads', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ result: 'fixture' }));
    const client = clientWith(fetchFn);
    expect(
      await client.request('api2/json/fixture', {
        method: 'PUT',
        body: { cores: 2 },
      }),
    ).toEqual({ result: 'fixture' });
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
      method: 'PUT',
      body: '{"cores":2}',
      headers: { 'Content-Type': 'application/json' },
    });
    await client.request('/api2/json/fixture', {
      method: 'GET',
      body: { ignored: true },
    });
    expect(fetchFn.mock.calls[1]?.[1]?.body).toBeUndefined();
  });

  it.each([
    {
      response: () => new Response('', { status: 401 }),
      message: 'Ticket authentication failed',
    },
    {
      response: () => Response.json({}),
      message: 'Invalid authentication response',
    },
    {
      response: () => Response.json({ data: { ticket: 'fixture-ticket' } }),
      message: 'Invalid authentication response',
    },
  ])(
    'rejects failed or incomplete ticket authentication',
    async ({ response, message }) => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => response());
      await expect(clientWith(fetchFn, true).getNodes()).rejects.toThrow(
        message,
      );
      expect(fetchFn).toHaveBeenCalledOnce();
    },
  );

  it('does not loop indefinitely when a refreshed ticket is also rejected', async () => {
    let logins = 0;
    const client = clientWith(
      vi.fn<typeof fetch>().mockImplementation(async (url) => {
        if (String(url).endsWith('/access/ticket')) {
          logins++;
          return Response.json({
            data: {
              ticket: 'fixture-ticket',
              CSRFPreventionToken: 'fixture-csrf',
            },
          });
        }
        return new Response('unauthorized fixture', { status: 401 });
      }),
      true,
    );
    await expect(client.getNodes()).rejects.toMatchObject({ statusCode: 401 });
    expect(logins).toBe(2);
  });

  it('handles a non-JSON error response and a network exception', async () => {
    await expect(
      clientWith(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response('fixture failure', { status: 503 })),
      ).getNodes(),
    ).rejects.toBeInstanceOf(ProxmoxApiError);
    await expect(
      clientWith(
        vi.fn<typeof fetch>().mockRejectedValue(new Error('fixture offline')),
      ).getNodes(),
    ).rejects.toThrow('fixture offline');
  });

  it('stops awaiting an aborted task without polling', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      clientWith(fetchFn).waitForTask('UPID:fixture:1', {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow('aborted');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('times out a task that remains running', async () => {
    vi.useFakeTimers();
    const client = clientWith(
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          Response.json({ data: { status: 'running' } }),
        ),
    );
    const assertion = expect(
      client.waitForTask('UPID:fixture:1', { intervalMs: 5, timeoutMs: 10 }),
    ).rejects.toThrow('Timeout');
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
  });

  it('accepts a stopped task without an exit status and tolerates unavailable progress logs', async () => {
    const onProgress = vi.fn();
    const client = clientWith(
      vi.fn<typeof fetch>().mockImplementation(async (url) => {
        if (String(url).includes('/log?'))
          throw new Error('fixture log interruption');
        return Response.json({ data: { status: 'stopped' } });
      }),
    );
    expect(await client.waitForTask('UPID:fixture:1', { onProgress })).toEqual({
      status: 'stopped',
    });
    expect(onProgress).not.toHaveBeenCalled();
    expect(await client.waitForTask('UPID:fixture:1')).toEqual({
      status: 'stopped',
    });
  });
});
