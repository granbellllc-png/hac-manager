export interface ProxmoxTokenAuth {
  readonly type: 'token';
  readonly tokenId: string;
  readonly tokenSecret: string;
}

export interface ProxmoxTicketAuth {
  readonly type: 'ticket';
  readonly username: string;
  readonly password: string;
}

export type ProxmoxAuth = ProxmoxTokenAuth | ProxmoxTicketAuth;

export interface ProxmoxClientOptions {
  readonly baseUrl: string;
  readonly auth: ProxmoxAuth;
  readonly pinnedFingerprint?: string | undefined;
  readonly caCertificate?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fetchFn?: typeof fetch | undefined;
}

export interface ProxmoxClusterResource {
  readonly id: string;
  readonly type: 'qemu' | 'lxc' | 'storage' | 'node' | 'pool';
  readonly node: string;
  readonly vmid?: number | undefined;
  readonly name?: string | undefined;
  readonly status?: string | undefined;
  readonly maxcpu?: number | undefined;
  readonly cpu?: number | undefined;
  readonly maxmem?: number | undefined;
  readonly mem?: number | undefined;
  readonly maxdisk?: number | undefined;
  readonly disk?: number | undefined;
  readonly uptime?: number | undefined;
}

export interface ProxmoxNodeStatus {
  readonly node: string;
  readonly pveversion: string;
  readonly uptime: number;
  readonly cpu: number;
  readonly wait: number;
  readonly memory: {
    readonly total: number;
    readonly used: number;
    readonly free: number;
  };
  readonly rootfs: {
    readonly total: number;
    readonly used: number;
    readonly free: number;
    readonly avail: number;
  };
}

export interface ProxmoxStorage {
  readonly storage: string;
  readonly type: string;
  readonly content: string;
  readonly active?: number | boolean | undefined;
  readonly shared?: number | boolean | undefined;
  readonly total?: number | undefined;
  readonly used?: number | undefined;
  readonly avail?: number | undefined;
}

export interface ProxmoxGuestStatus {
  readonly vmid: number;
  readonly name?: string | undefined;
  readonly status: 'running' | 'stopped' | string;
  readonly cpus?: number | undefined;
  readonly cpu?: number | undefined;
  readonly maxmem?: number | undefined;
  readonly mem?: number | undefined;
  readonly maxdisk?: number | undefined;
  readonly disk?: number | undefined;
  readonly uptime?: number | undefined;
  readonly lock?: string | undefined;
  readonly qmpstatus?: string | undefined;
}

export interface ProxmoxTaskStatus {
  readonly upid: string;
  readonly node: string;
  readonly pid: number;
  readonly type: string;
  readonly id?: string | undefined;
  readonly user: string;
  readonly status: 'running' | 'stopped';
  readonly exitstatus?: string | undefined;
}

export interface ProxmoxTaskLogLine {
  readonly n: number;
  readonly t: string;
}

export interface AwaitTaskOptions {
  readonly timeoutMs?: number | undefined;
  readonly intervalMs?: number | undefined;
  readonly onProgress?: ((logLine: string) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}
