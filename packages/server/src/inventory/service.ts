import { EventEmitter } from 'node:events';
import { parseProxmoxConfig } from '@hacm/core';
import type { HostRegistry } from '../hosts/registry.js';
import type { ConnectionManager } from '../router/manager.js';
import type { HostConnectionRouter } from '../router/router.js';
import type { ProxmoxClient } from '../proxmox/client.js';
import type { ProxmoxGuestStatus } from '../proxmox/types.js';
import type {
  HostInventory,
  InventoryChangeEvent,
  LiveGuestDetail,
  LiveGuestSummary,
} from './types.js';

export interface LiveInventoryServiceOptions {
  readonly hostRegistry: HostRegistry;
  readonly connectionManager: ConnectionManager;
  readonly ttlMs?: number | undefined;
}

interface CacheEntry {
  readonly inventory: HostInventory;
  readonly expiresAt: number;
}

export class LiveInventoryService extends EventEmitter {
  private readonly hostRegistry: HostRegistry;
  private readonly connectionManager: ConnectionManager;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  public constructor(options: LiveInventoryServiceOptions) {
    super();
    this.hostRegistry = options.hostRegistry;
    this.connectionManager = options.connectionManager;
    this.ttlMs = options.ttlMs ?? 30_000;
  }

  public async getHostInventory(
    hostId: string,
    forceRefresh = false,
  ): Promise<HostInventory> {
    const cached = this.cache.get(hostId);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.inventory;
    }

    const hostEntry = this.hostRegistry.getRawHost(hostId);
    if (!hostEntry) {
      throw new Error(`Host '${hostId}' not found in registry`);
    }

    const hostName = hostEntry.name;

    try {
      const router = await this.connectionManager.getRouter(hostId);
      const apiClient = await this.connectionManager.getApiClient(hostId);
      const inventory = await this.fetchHostInventory(
        hostId,
        hostName,
        router,
        apiClient,
      );

      this.updateCacheAndEmitChanges(hostId, inventory);
      return inventory;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const failedInventory: HostInventory = {
        hostId,
        name: hostName,
        status: 'error',
        guests: [],
        channels: {
          ssh: { ok: false, status: 'error', error: errorMsg },
          api: { ok: false, status: 'error', error: errorMsg },
        },
        lastRefreshedAt: new Date().toISOString(),
        error: errorMsg,
      };

      this.cache.set(hostId, {
        inventory: failedInventory,
        expiresAt: Date.now() + 5_000,
      });

      return failedInventory;
    }
  }

  public async getAllInventories(
    forceRefresh = false,
  ): Promise<readonly HostInventory[]> {
    const hosts = await this.hostRegistry.listHosts();
    const results = await Promise.allSettled(
      hosts.map((h) => this.getHostInventory(h.id, forceRefresh)),
    );

    const inventories: HostInventory[] = [];
    for (let i = 0; i < results.length; i++) {
      const res = results[i]!;
      const h = hosts[i]!;
      if (res.status === 'fulfilled') {
        inventories.push(res.value);
      } else {
        const errorMsg =
          res.reason instanceof Error ? res.reason.message : String(res.reason);
        inventories.push({
          hostId: h.id,
          name: h.name,
          status: 'error',
          guests: [],
          channels: {
            ssh: { ok: false, status: 'error', error: errorMsg },
            api: { ok: false, status: 'error', error: errorMsg },
          },
          lastRefreshedAt: new Date().toISOString(),
          error: errorMsg,
        });
      }
    }

    return inventories;
  }

  public async listGuests(filter?: {
    readonly hostId?: string | undefined;
    readonly type?: 'lxc' | 'vm' | undefined;
    readonly status?: string | undefined;
  }): Promise<readonly LiveGuestSummary[]> {
    let inventories: readonly HostInventory[];
    if (filter?.hostId) {
      const inv = await this.getHostInventory(filter.hostId);
      inventories = [inv];
    } else {
      inventories = await this.getAllInventories();
    }

    const allGuests: LiveGuestSummary[] = [];
    for (const inv of inventories) {
      for (const g of inv.guests) {
        if (filter?.type && g.type !== filter.type) continue;
        if (filter?.status && g.status !== filter.status) continue;
        allGuests.push(g);
      }
    }

    return allGuests;
  }

  public async getGuestLiveConfig(
    hostId: string,
    vmid: number,
    guestType?: 'lxc' | 'vm',
  ): Promise<LiveGuestDetail> {
    const inv = await this.getHostInventory(hostId);
    let summary = inv.guests.find((g) => g.vmid === vmid);
    let resolvedType = guestType ?? summary?.type;

    if (!resolvedType) {
      resolvedType = 'lxc';
    }

    if (!summary) {
      summary = {
        hostId,
        vmid,
        name: `guest-${vmid}`,
        type: resolvedType,
        status: 'unknown',
        node: 'localhost',
      };
    }

    const router = await this.connectionManager.getRouter(hostId);
    const { raw, source } = await router.readGuestConfig(
      vmid,
      resolvedType,
      summary.node,
    );

    let rawConfigStr: string;
    if (typeof raw === 'string') {
      rawConfigStr = raw;
    } else if (typeof raw === 'object' && raw !== null) {
      rawConfigStr = Object.entries(raw)
        .filter(([k]) => typeof k === 'string' && !k.startsWith('_'))
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join('\n');
    } else {
      rawConfigStr = '';
    }

    const canonicalConfig = parseProxmoxConfig(
      rawConfigStr,
      resolvedType,
      vmid,
    );

    return {
      summary,
      rawConfig: rawConfigStr,
      canonicalConfig,
      source,
    };
  }

  public invalidate(hostId?: string): void {
    if (hostId) {
      this.cache.delete(hostId);
    } else {
      this.cache.clear();
    }
  }

  private async fetchHostInventory(
    hostId: string,
    hostName: string,
    router: HostConnectionRouter,
    apiClient?: ProxmoxClient,
  ): Promise<HostInventory> {
    const node = 'localhost';
    const guests: LiveGuestSummary[] = [];
    let fetchError: string | undefined = undefined;

    // 1. Try API first
    if (apiClient) {
      try {
        const [lxcs, qemus] = await Promise.all([
          apiClient.listLxc(node),
          apiClient.listQemu(node),
        ]);

        for (const l of lxcs) {
          guests.push(this.mapProxmoxGuest(hostId, node, 'lxc', l));
        }
        for (const q of qemus) {
          guests.push(this.mapProxmoxGuest(hostId, node, 'vm', q));
        }
      } catch (err) {
        fetchError = err instanceof Error ? err.message : String(err);
      }
    }

    // 2. Fall back to SSH if API not configured or failed
    if (guests.length === 0 && router.health.ssh.status !== 'not_configured') {
      try {
        const sshGuests = await this.fetchViaSsh(hostId, node, router);
        guests.push(...sshGuests);
        fetchError = undefined;
      } catch (err) {
        if (!fetchError) {
          fetchError = err instanceof Error ? err.message : String(err);
        }
      }
    }

    const health = router.health;
    const isOnline = guests.length > 0 || !fetchError;
    const status: HostInventory['status'] = !isOnline
      ? 'error'
      : health.ssh.ok &&
          (health.api.ok || health.api.status === 'not_configured')
        ? 'online'
        : 'degraded';

    return {
      hostId,
      name: hostName,
      status,
      guests,
      channels: health,
      lastRefreshedAt: new Date().toISOString(),
      ...(fetchError ? { error: fetchError } : {}),
    };
  }

  private async fetchViaSsh(
    hostId: string,
    node: string,
    router: HostConnectionRouter,
  ): Promise<LiveGuestSummary[]> {
    const guests: LiveGuestSummary[] = [];

    // First try pvesh JSON
    try {
      const pveshLxc = await router.exec([
        'pvesh',
        'get',
        `/nodes/${node}/lxc`,
        '--output-format',
        'json',
      ]);
      if (pveshLxc.exitCode === 0) {
        const data = JSON.parse(pveshLxc.stdout) as ProxmoxGuestStatus[];
        for (const item of data) {
          guests.push(this.mapProxmoxGuest(hostId, node, 'lxc', item));
        }
      }
    } catch {
      // Fall through to pct list
    }

    try {
      const pveshQemu = await router.exec([
        'pvesh',
        'get',
        `/nodes/${node}/qemu`,
        '--output-format',
        'json',
      ]);
      if (pveshQemu.exitCode === 0) {
        const data = JSON.parse(pveshQemu.stdout) as ProxmoxGuestStatus[];
        for (const item of data) {
          guests.push(this.mapProxmoxGuest(hostId, node, 'vm', item));
        }
      }
    } catch {
      // Fall through to qm list
    }

    // If pvesh succeeded, return guests
    if (guests.length > 0) {
      return guests;
    }

    // Fall back to pct list / qm list text tables
    const pctRes = await router.exec(['pct', 'list']);
    if (pctRes.exitCode === 0) {
      guests.push(...this.parsePctList(hostId, node, pctRes.stdout));
    }

    const qmRes = await router.exec(['qm', 'list']);
    if (qmRes.exitCode === 0) {
      guests.push(...this.parseQmList(hostId, node, qmRes.stdout));
    }

    return guests;
  }

  private parsePctList(
    hostId: string,
    node: string,
    output: string,
  ): LiveGuestSummary[] {
    const lines = output.trim().split('\n');
    const result: LiveGuestSummary[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      const vmid = Number(parts[0]);
      if (!Number.isFinite(vmid)) continue;

      const status = parts[1] ?? 'unknown';
      const name = parts[parts.length - 1] ?? `lxc-${vmid}`;

      result.push({
        hostId,
        vmid,
        name,
        type: 'lxc',
        status,
        node,
      });
    }

    return result;
  }

  private parseQmList(
    hostId: string,
    node: string,
    output: string,
  ): LiveGuestSummary[] {
    const lines = output.trim().split('\n');
    const result: LiveGuestSummary[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      const vmid = Number(parts[0]);
      if (!Number.isFinite(vmid)) continue;

      const name = parts[1] ?? `vm-${vmid}`;
      const status = parts[2] ?? 'unknown';

      result.push({
        hostId,
        vmid,
        name,
        type: 'vm',
        status,
        node,
      });
    }

    return result;
  }

  private mapProxmoxGuest(
    hostId: string,
    node: string,
    type: 'lxc' | 'vm',
    item: ProxmoxGuestStatus,
  ): LiveGuestSummary {
    return {
      hostId,
      vmid: item.vmid,
      name: item.name ?? `${type}-${item.vmid}`,
      type,
      status: item.status,
      node,
      ...(item.cpu !== undefined ? { cpu: item.cpu } : {}),
      ...(item.cpus !== undefined ? { maxcpu: item.cpus } : {}),
      ...(item.mem !== undefined ? { mem: item.mem } : {}),
      ...(item.maxmem !== undefined ? { maxmem: item.maxmem } : {}),
      ...(item.uptime !== undefined ? { uptime: item.uptime } : {}),
      ...(item.lock !== undefined ? { lock: item.lock } : {}),
    };
  }

  private updateCacheAndEmitChanges(
    hostId: string,
    inventory: HostInventory,
  ): void {
    const previous = this.cache.get(hostId)?.inventory;
    this.cache.set(hostId, {
      inventory,
      expiresAt: Date.now() + this.ttlMs,
    });

    if (!previous) return;

    const prevMap = new Map(previous.guests.map((g) => [g.vmid, g]));
    const currMap = new Map(inventory.guests.map((g) => [g.vmid, g]));

    const added: LiveGuestSummary[] = [];
    const removed: LiveGuestSummary[] = [];
    const changed: { previous: LiveGuestSummary; current: LiveGuestSummary }[] =
      [];

    for (const [vmid, curr] of currMap.entries()) {
      const prev = prevMap.get(vmid);
      if (!prev) {
        added.push(curr);
      } else if (
        prev.status !== curr.status ||
        prev.name !== curr.name ||
        prev.lock !== curr.lock
      ) {
        changed.push({ previous: prev, current: curr });
      }
    }

    for (const [vmid, prev] of prevMap.entries()) {
      if (!currMap.has(vmid)) {
        removed.push(prev);
      }
    }

    if (added.length > 0 || removed.length > 0 || changed.length > 0) {
      const event: InventoryChangeEvent = {
        hostId,
        timestamp: new Date().toISOString(),
        added,
        removed,
        changed,
      };
      this.emit('change', event);
    }
  }
}
