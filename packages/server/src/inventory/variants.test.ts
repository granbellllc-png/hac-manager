import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '@hacm/core';
import type { HostRegistry } from '../hosts/registry.js';
import type { ConnectionManager } from '../router/manager.js';
import type { SshTransport } from '../ssh/types.js';
import { HostConnectionRouter } from '../router/router.js';
import { ProxmoxClient } from '../proxmox/client.js';
import { LiveInventoryService } from './service.js';

function fixture() {
  const transport = new FakeTransport() as unknown as SshTransport;
  const client = new ProxmoxClient({
    baseUrl: 'https://fixture.invalid',
    auth: {
      type: 'token',
      tokenId: 'fixture!test',
      tokenSecret: 'fixture-token',
    },
    fetchFn: vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ data: [] })),
  });
  const router = new HostConnectionRouter('fixture', {
    sshTransport: transport,
    apiClient: client,
  });
  const registry = {
    getRawHost: vi.fn().mockReturnValue({ name: 'Fixture' }),
    listHosts: vi.fn().mockResolvedValue([{ id: 'fixture', name: 'Fixture' }]),
  };
  const manager = {
    getRouter: vi.fn().mockResolvedValue(router),
    getApiClient: vi.fn().mockResolvedValue(client),
  };
  const service = new LiveInventoryService({
    hostRegistry: registry as unknown as HostRegistry,
    connectionManager: manager as unknown as ConnectionManager,
    ttlMs: 100,
  });
  return { service, transport, client, router, registry, manager };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('live inventory variants', () => {
  it('filters more than 100 guests by host, type and status, expiring and invalidating caches', async () => {
    vi.useFakeTimers();
    const { service, client } = fixture();
    const list = vi.spyOn(client, 'listLxc').mockResolvedValue(
      Array.from({ length: 110 }, (_, i) => ({
        vmid: 100 + i,
        status: i % 2 ? 'running' : 'stopped',
        lock: 'backup',
      })),
    );
    vi.spyOn(client, 'listQemu').mockResolvedValue([
      { vmid: 300, status: 'running', name: 'fixture-vm' },
    ]);
    expect(await service.listGuests()).toHaveLength(111);
    expect(
      await service.listGuests({
        hostId: 'fixture',
        type: 'lxc',
        status: 'running',
      }),
    ).toHaveLength(55);
    expect(await service.listGuests({ type: 'vm' })).toHaveLength(1);
    expect(list).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(101);
    await service.listGuests();
    expect(list).toHaveBeenCalledTimes(2);
    service.invalidate('fixture');
    await service.listGuests();
    service.invalidate();
    await service.listGuests();
    expect(list).toHaveBeenCalledTimes(4);
  });

  it('emits added, removed, renamed and lock changes while ignoring unchanged inventories', async () => {
    const { service, client } = fixture();
    const list = vi
      .spyOn(client, 'listLxc')
      .mockResolvedValue([{ vmid: 100, status: 'running', name: 'before' }]);
    const change = vi.fn();
    service.on('change', change);
    await service.getHostInventory('fixture');
    await service.getHostInventory('fixture', true);
    expect(change).not.toHaveBeenCalled();
    list.mockResolvedValue([{ vmid: 100, status: 'running', name: 'after' }]);
    await service.getHostInventory('fixture', true);
    expect(change.mock.calls[0]?.[0].changed[0].current.name).toBe('after');
    list.mockResolvedValue([
      { vmid: 100, status: 'running', name: 'after', lock: 'backup' },
    ]);
    await service.getHostInventory('fixture', true);
    expect(change.mock.calls[1]?.[0].changed[0].current.lock).toBe('backup');
    list.mockResolvedValue([{ vmid: 101, status: 'stopped' }]);
    await service.getHostInventory('fixture', true);
    expect(change.mock.calls[2]?.[0]).toMatchObject({
      added: [{ vmid: 101 }],
      removed: [{ vmid: 100 }],
    });
  });

  it('uses fallback identity for absent guests and strips internal API keys from live config', async () => {
    const { service, client, router } = fixture();
    vi.spyOn(client, 'listLxc').mockResolvedValue([
      { vmid: 100, status: 'running' },
    ]);
    const read = vi.spyOn(router, 'readGuestConfig').mockResolvedValue({
      raw: { hostname: 'fixture', cores: 2, _internal: 'ignored' },
      source: 'api',
    });
    const existing = await service.getGuestLiveConfig('fixture', 100);
    expect(existing.summary.type).toBe('lxc');
    expect(existing.rawConfig).not.toContain('_internal');
    expect(existing.canonicalConfig.cpu).toBe(2);
    expect(
      (await service.getGuestLiveConfig('fixture', 300, 'vm')).summary,
    ).toMatchObject({ name: 'guest-300', type: 'vm', status: 'unknown' });
    read.mockResolvedValue({
      raw: null as unknown as Record<string, unknown>,
      source: 'api',
    });
    expect((await service.getGuestLiveConfig('fixture', 500)).rawConfig).toBe(
      '',
    );
  });

  it.each([new Error('fixture host disappeared'), 'fixture host disappeared'])(
    'isolates a vanished host from the inventory list',
    async (error) => {
      const { service, registry } = fixture();
      registry.getRawHost.mockImplementation(() => {
        throw error;
      });
      expect((await service.getAllInventories())[0]).toMatchObject({
        status: 'error',
        error: 'fixture host disappeared',
      });
      registry.getRawHost.mockReturnValue(undefined);
      await expect(service.getHostInventory('absent')).rejects.toThrow(
        'not found',
      );
    },
  );

  it('returns an error inventory when connection setup throws a non-Error', async () => {
    const { service, manager } = fixture();
    manager.getRouter.mockRejectedValue('fixture connection failure');
    expect(await service.getHostInventory('fixture')).toMatchObject({
      status: 'error',
      error: 'fixture connection failure',
    });
  });

  it('uses pvesh JSON for both guest types when the API is unavailable', async () => {
    const { service, manager, transport } = fixture();
    manager.getApiClient.mockResolvedValue(undefined);
    vi.spyOn(transport, 'exec').mockImplementation(async (argv) => ({
      exitCode: 0,
      stdout: JSON.stringify([
        { vmid: argv[2]?.endsWith('/lxc') ? 100 : 200, status: 'running' },
      ]),
      stderr: '',
      timedOut: false,
    }));
    const inventory = await service.getHostInventory('fixture');
    expect(inventory.guests.map((guest) => guest.type)).toEqual(['lxc', 'vm']);
  });

  it('falls back from failed pvesh requests to text lists and skips malformed rows', async () => {
    const { service, manager, transport } = fixture();
    manager.getApiClient.mockResolvedValue(undefined);
    vi.spyOn(transport, 'exec').mockImplementation(async (argv) => {
      if (argv[0] === 'pvesh') throw new Error('fixture pvesh unavailable');
      return {
        exitCode: 0,
        stdout:
          argv[0] === 'pct'
            ? 'HEADER\ninvalid row\n\n100\n101 stopped fixture-lxc\n'
            : 'HEADER\ninvalid row\n\n200\n201 fixture-vm stopped\n',
        stderr: '',
        timedOut: false,
      };
    });
    const inventory = await service.getHostInventory('fixture');
    expect(inventory.guests.map((guest) => guest.vmid)).toEqual([
      100, 101, 200, 201,
    ]);
    expect(inventory.guests[0]?.status).toBe('unknown');
    expect(inventory.guests[2]?.name).toBe('vm-200');
  });

  it.each([new Error('fixture API failed'), 'fixture API failed'])(
    'preserves the API error if SSH also fails',
    async (error) => {
      const { service, client, transport } = fixture();
      vi.spyOn(client, 'listLxc').mockRejectedValue(error);
      vi.spyOn(transport, 'exec').mockRejectedValue(
        new Error('fixture SSH failed'),
      );
      expect(await service.getHostInventory('fixture')).toMatchObject({
        status: 'error',
        error: 'fixture API failed',
      });
    },
  );

  it.each([new Error('fixture SSH failed'), 'fixture SSH failed'])(
    'reports SSH errors when there is no API error to preserve',
    async (error) => {
      const { service, manager, transport } = fixture();
      manager.getApiClient.mockResolvedValue(undefined);
      vi.spyOn(transport, 'exec').mockRejectedValue(error);
      expect(await service.getHostInventory('fixture')).toMatchObject({
        status: 'error',
        error: 'fixture SSH failed',
      });
    },
  );

  it('returns a degraded empty inventory when channels are unavailable', async () => {
    const { service, manager } = fixture();
    manager.getApiClient.mockResolvedValue(undefined);
    manager.getRouter.mockResolvedValue(new HostConnectionRouter('fixture'));
    expect(await service.getHostInventory('fixture')).toMatchObject({
      status: 'degraded',
      guests: [],
    });
  });
});
