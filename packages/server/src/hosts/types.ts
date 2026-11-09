import type { HostFile } from '@hacm/core';

export interface HostChannelStatus {
  readonly status: 'unknown' | 'connected' | 'unreachable' | 'error';
  readonly error?: string | undefined;
  readonly lastCheckedAt?: string | undefined;
}

export interface HostRuntimeStatus {
  readonly overall:
    'unknown' | 'healthy' | 'degraded' | 'unreachable' | 'error';
  readonly ssh: HostChannelStatus;
  readonly api: HostChannelStatus & { readonly configured: boolean };
  readonly vault: {
    readonly status: 'not_configured' | 'unlocked' | 'locked';
    readonly error?: string | undefined;
  };
  readonly queue: {
    readonly status: 'idle' | 'busy' | 'paused';
    readonly activeJobId?: string | undefined;
  };
  readonly lastSeenAt?: string | undefined;
  readonly issues: readonly string[];
}

export interface SanitizedSshConnection {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly fingerprint?: string | undefined;
  readonly authMethod: 'key' | 'password' | 'none';
}

export interface SanitizedApiConnection {
  readonly url: string;
  readonly tokenId: string;
  readonly fingerprint?: string | undefined;
  readonly configured: boolean;
}

export interface HostSummary {
  readonly id: string;
  readonly name: string;
  readonly type: 'proxmox';
  readonly index: number;
  readonly status: 'unknown' | 'healthy' | 'degraded' | 'unreachable' | 'error';
  readonly runtime: HostRuntimeStatus;
  readonly updatedAt: string;
}

export interface HostDetail extends HostSummary {
  readonly connection: {
    readonly ssh: SanitizedSshConnection;
    readonly api?: SanitizedApiConnection | undefined;
  };
  readonly ignoredGuestsCount: number;
  readonly defaults?:
    | {
        readonly deployment?: string | undefined;
        readonly filemappings?: string | undefined;
      }
    | undefined;
}

export interface HostSyncResult {
  readonly synced: number;
  readonly removed: number;
  readonly issues: readonly string[];
}

export interface HostRegistryEntry {
  readonly id: string;
  readonly config: HostFile;
  readonly runtime: HostRuntimeStatus;
  readonly updatedAt: Date;
}
