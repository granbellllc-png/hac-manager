import { describe, expect, it, vi } from 'vitest';
import { LiveInventoryService } from './service.js';
import type { HostRegistry } from '../hosts/registry.js';
import type { ConnectionManager } from '../router/manager.js';
import type { HostConnectionRouter } from '../router/router.js';
import type { ProxmoxClient } from '../proxmox/client.js';

describe('LiveInventoryService', () => {
  it('fetches inventory via API and handles change events', async () => {
    const mockApiClient = {
      listLxc: vi.fn().mockResolvedValue([
        {
          vmid: 112,
          name: 'adguard',
          status: 'running',
          cpu: 0.05,
          cpus: 2,
          mem: 512 * 1024 * 1024,
          maxmem: 1024 * 1024 * 1024,
          uptime: 12345,
        },
      ]),
      listQemu: vi.fn().mockResolvedValue([
        {
          vmid: 212,
          name: 'homeassistant',
          status: 'running',
          cpu: 0.1,
          cpus: 4,
          mem: 2048 * 1024 * 1024,
          maxmem: 4096 * 1024 * 1024,
          uptime: 67890,
        },
      ]),
    } as unknown as ProxmoxClient;

    const mockRouter = {
      health: {
        ssh: { ok: true, status: 'connected' },
        api: { ok: true, status: 'connected' },
      },
      readGuestConfig: vi.fn().mockResolvedValue({
        raw: 'hostname: adguard\ncores: 2\nmemory: 1024\nrootfs: local-lvm:vm-112-disk-0,size=8G\nnet0: name=eth0,bridge=vmbr0,ip=dhcp\n',
        source: 'api',
      }),
    } as unknown as HostConnectionRouter;

    const mockRegistry = {
      getRawHost: vi.fn().mockReturnValue({
        name: 'pve-main',
        connection: { ssh: { host: 'localhost' } },
      }),
      listHosts: vi
        .fn()
        .mockResolvedValue([{ id: 'pve-main', name: 'pve-main' }]),
    } as unknown as HostRegistry;

    const mockConnManager = {
      getRouter: vi.fn().mockResolvedValue(mockRouter),
      getApiClient: vi.fn().mockResolvedValue(mockApiClient),
    } as unknown as ConnectionManager;

    const service = new LiveInventoryService({
      hostRegistry: mockRegistry,
      connectionManager: mockConnManager,
      ttlMs: 5000,
    });

    // 1. Initial fetch
    const inv1 = await service.getHostInventory('pve-main');
    expect(inv1.status).toBe('online');
    expect(inv1.guests).toHaveLength(2);
    expect(inv1.guests[0]?.vmid).toBe(112);
    expect(inv1.guests[0]?.type).toBe('lxc');
    expect(inv1.guests[1]?.vmid).toBe(212);
    expect(inv1.guests[1]?.type).toBe('vm');

    // 2. Cache hit (mockApiClient.listLxc should not be called again)
    const inv2 = await service.getHostInventory('pve-main');
    expect(inv2).toBe(inv1);
    expect(mockApiClient.listLxc).toHaveBeenCalledTimes(1);

    // 3. Change detection with forceRefresh
    const changeEvents: unknown[] = [];
    service.on('change', (e) => changeEvents.push(e));

    // Simulate guest state change (adguard stopped)
    vi.mocked(mockApiClient.listLxc).mockResolvedValueOnce([
      {
        vmid: 112,
        name: 'adguard',
        status: 'stopped',
      },
    ]);

    const inv3 = await service.getHostInventory('pve-main', true);
    expect(inv3.guests[0]?.status).toBe('stopped');
    expect(changeEvents).toHaveLength(1);

    // 4. Read guest live config with codec
    const detail = await service.getGuestLiveConfig('pve-main', 112, 'lxc');
    expect(detail.canonicalConfig.name).toBe('adguard');
    expect(detail.canonicalConfig.cpu).toBe(2);
    expect(detail.canonicalConfig.ram).toBe(1024);
    expect(detail.source).toBe('api');
  });

  it('falls back to SSH when API is unavailable', async () => {
    const mockRouter = {
      health: {
        ssh: { ok: true, status: 'connected' },
        api: { ok: false, status: 'not_configured' },
      },
      exec: vi.fn().mockImplementation(async (argv: string[]) => {
        if (argv[0] === 'pvesh') {
          return { exitCode: 1, stdout: '', stderr: 'command not found' };
        }
        if (argv[0] === 'pct' && argv[1] === 'list') {
          return {
            exitCode: 0,
            stdout:
              'VMID       Status     Lock         Name\n100        running                 dns-pihole\n',
            stderr: '',
          };
        }
        if (argv[0] === 'qm' && argv[1] === 'list') {
          return {
            exitCode: 0,
            stdout:
              'VMID       NAME                 STATUS     MEM(MB)    BOOTDISK(GB) PID\n200        truenas              running    8192              64.00 4567\n',
            stderr: '',
          };
        }
        return { exitCode: 1, stdout: '', stderr: 'unknown' };
      }),
    } as unknown as HostConnectionRouter;

    const mockRegistry = {
      getRawHost: vi.fn().mockReturnValue({
        name: 'pve-ssh-only',
        connection: { ssh: { host: 'localhost' } },
      }),
    } as unknown as HostRegistry;

    const mockConnManager = {
      getRouter: vi.fn().mockResolvedValue(mockRouter),
      getApiClient: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConnectionManager;

    const service = new LiveInventoryService({
      hostRegistry: mockRegistry,
      connectionManager: mockConnManager,
    });

    const inv = await service.getHostInventory('pve-ssh-only');
    expect(inv.status).toBe('online');
    expect(inv.guests).toHaveLength(2);
    expect(inv.guests[0]?.name).toBe('dns-pihole');
    expect(inv.guests[0]?.type).toBe('lxc');
    expect(inv.guests[1]?.name).toBe('truenas');
    expect(inv.guests[1]?.type).toBe('vm');
  });

  it('does not block other hosts when one host fails', async () => {
    const mockRegistry = {
      getRawHost: vi.fn().mockImplementation((id: string) => {
        return { name: id, connection: { ssh: { host: 'localhost' } } };
      }),
      listHosts: vi.fn().mockResolvedValue([
        { id: 'host-ok', name: 'host-ok' },
        { id: 'host-bad', name: 'host-bad' },
      ]),
    } as unknown as HostRegistry;

    const mockConnManager = {
      getRouter: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'host-bad') {
          throw new Error('Connection refused to host-bad');
        }
        return {
          health: {
            ssh: { ok: true, status: 'connected' },
            api: { ok: false, status: 'not_configured' },
          },
          exec: vi.fn().mockImplementation(async (argv: string[]) => {
            if (argv[0] === 'pct' && argv[1] === 'list') {
              return {
                exitCode: 0,
                stdout:
                  'VMID       Status     Lock         Name\n101        running                 test-lxc\n',
                stderr: '',
              };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
          }),
        };
      }),
      getApiClient: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConnectionManager;

    const service = new LiveInventoryService({
      hostRegistry: mockRegistry,
      connectionManager: mockConnManager,
    });

    const inventories = await service.getAllInventories();
    expect(inventories).toHaveLength(2);

    const okInv = inventories.find((i) => i.hostId === 'host-ok');
    expect(okInv?.status).toBe('online');
    expect(okInv?.guests).toHaveLength(1);

    const badInv = inventories.find((i) => i.hostId === 'host-bad');
    expect(badInv?.status).toBe('error');
    expect(badInv?.error).toContain('Connection refused');
    expect(badInv?.guests).toHaveLength(0);
  });
});
