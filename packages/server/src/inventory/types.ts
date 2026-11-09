import type { GuestDeployment } from '@hacm/core';
import type { ChannelHealth } from '../router/types.js';

export interface LiveGuestSummary {
  readonly hostId: string;
  readonly vmid: number;
  readonly name: string;
  readonly type: 'lxc' | 'vm';
  readonly status: 'running' | 'stopped' | 'unknown' | string;
  readonly node: string;
  readonly cpu?: number | undefined;
  readonly maxcpu?: number | undefined;
  readonly mem?: number | undefined;
  readonly maxmem?: number | undefined;
  readonly uptime?: number | undefined;
  readonly lock?: string | undefined;
  readonly tags?: readonly string[] | undefined;
}

export interface HostInventory {
  readonly hostId: string;
  readonly name: string;
  readonly status: 'online' | 'offline' | 'degraded' | 'error';
  readonly guests: readonly LiveGuestSummary[];
  readonly channels: {
    readonly ssh: ChannelHealth;
    readonly api: ChannelHealth;
  };
  readonly lastRefreshedAt: string;
  readonly error?: string | undefined;
}

export interface LiveGuestDetail {
  readonly summary: LiveGuestSummary;
  readonly rawConfig: string;
  readonly canonicalConfig: GuestDeployment;
  readonly source: 'api' | 'ssh';
}

export interface InventoryChangeEvent {
  readonly hostId: string;
  readonly timestamp: string;
  readonly added: readonly LiveGuestSummary[];
  readonly removed: readonly LiveGuestSummary[];
  readonly changed: readonly {
    readonly previous: LiveGuestSummary;
    readonly current: LiveGuestSummary;
  }[];
}
