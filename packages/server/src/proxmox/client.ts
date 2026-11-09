import { Agent } from 'undici';
import {
  ProxmoxApiError,
  ProxmoxTaskError,
  TlsFingerprintMismatchError,
} from './errors.js';
import type {
  AwaitTaskOptions,
  ProxmoxClientOptions,
  ProxmoxClusterResource,
  ProxmoxGuestStatus,
  ProxmoxNodeStatus,
  ProxmoxStorage,
  ProxmoxTaskLogLine,
  ProxmoxTaskStatus,
} from './types.js';

function normalizeFingerprint(fp: string): string {
  return fp
    .trim()
    .replace(/^SHA256:/i, '')
    .replace(/[:\s]/g, '')
    .toLowerCase();
}

export function parseNodeFromUpid(upid: string): string {
  const parts = upid.split(':');
  if (parts.length >= 2 && parts[0] === 'UPID') {
    return parts[1] ?? 'localhost';
  }
  return 'localhost';
}

export class ProxmoxClient {
  public readonly baseUrl: string;
  private readonly options: ProxmoxClientOptions;
  private readonly fetchFn: typeof fetch;
  private readonly dispatcher?: Agent | undefined;
  private ticket?: string | undefined;
  private csrfToken?: string | undefined;

  public constructor(options: ProxmoxClientOptions) {
    this.options = options;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? globalThis.fetch;

    if (
      !options.fetchFn &&
      (options.pinnedFingerprint || options.caCertificate)
    ) {
      this.dispatcher = new Agent({
        connect: {
          ca: options.caCertificate,
          rejectUnauthorized: Boolean(options.caCertificate),
          checkServerIdentity: (hostname, cert) => {
            if (options.pinnedFingerprint) {
              const expected = normalizeFingerprint(options.pinnedFingerprint);
              const actual = normalizeFingerprint(cert.fingerprint256);
              if (expected !== actual) {
                throw new TlsFingerprintMismatchError(
                  hostname,
                  options.pinnedFingerprint,
                  `SHA256:${cert.fingerprint256}`,
                );
              }
            }
            return undefined;
          },
        },
      });
    }
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    if (this.options.auth.type === 'token') {
      const { tokenId, tokenSecret } = this.options.auth;
      return {
        Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}`,
      };
    }

    if (!this.ticket || !this.csrfToken) {
      await this.loginTicket();
    }

    const headers: Record<string, string> = {
      Cookie: `PVEAuthCookie=${this.ticket}`,
    };
    if (this.csrfToken) {
      headers['CSRFPreventionToken'] = this.csrfToken;
    }
    return headers;
  }

  private async loginTicket(): Promise<void> {
    if (this.options.auth.type !== 'ticket') return;

    const { username, password } = this.options.auth;
    const url = `${this.baseUrl}/api2/json/access/ticket`;

    const body = new URLSearchParams({
      username,
      password,
    }).toString();

    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      // @ts-expect-error undici dispatcher option for node fetch
      dispatcher: this.dispatcher,
    });

    if (!res.ok) {
      throw new ProxmoxApiError(
        res.status,
        `Ticket authentication failed for user '${username}'`,
      );
    }

    const json = (await res.json()) as {
      data?: { ticket?: string; CSRFPreventionToken?: string };
    };

    if (!json.data?.ticket || !json.data?.CSRFPreventionToken) {
      throw new ProxmoxApiError(
        500,
        'Invalid authentication response from Proxmox server',
      );
    }

    this.ticket = json.data.ticket;
    this.csrfToken = json.data.CSRFPreventionToken;
  }

  public async request<T>(
    endpoint: string,
    options: {
      readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | undefined;
      readonly body?: Record<string, unknown> | undefined;
      readonly isRetry?: boolean | undefined;
    } = {},
  ): Promise<T> {
    const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const url = `${this.baseUrl}${path}`;
    const method = options.method ?? 'GET';
    const authHeaders = await this.getAuthHeaders();

    const headers: Record<string, string> = {
      ...authHeaders,
      Accept: 'application/json',
    };

    let bodyStr: string | undefined = undefined;
    if (options.body && ['POST', 'PUT', 'DELETE'].includes(method)) {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(options.body);
    }

    const res = await this.fetchFn(url, {
      method,
      headers,
      body: bodyStr,
      // @ts-expect-error undici dispatcher option for node fetch
      dispatcher: this.dispatcher,
    });

    if (
      res.status === 401 &&
      !options.isRetry &&
      this.options.auth.type === 'ticket'
    ) {
      this.ticket = undefined;
      this.csrfToken = undefined;
      return this.request<T>(endpoint, { ...options, isRetry: true });
    }

    if (!res.ok) {
      let bodyData: unknown = undefined;
      try {
        bodyData = await res.json();
      } catch {
        try {
          bodyData = await res.text();
        } catch {
          // ignore
        }
      }
      throw new ProxmoxApiError(
        res.status,
        res.statusText || 'Request failed',
        bodyData,
      );
    }

    const json = (await res.json()) as { data?: T };
    return (json.data ?? json) as T;
  }

  // Cluster & Node
  public async getClusterResources(
    type?: 'qemu' | 'lxc' | 'storage' | 'node',
  ): Promise<ProxmoxClusterResource[]> {
    const query = type ? `?type=${type}` : '';
    return this.request<ProxmoxClusterResource[]>(
      `/api2/json/cluster/resources${query}`,
    );
  }

  public async getClusterStatus(): Promise<Record<string, unknown>[]> {
    return this.request<Record<string, unknown>[]>('/api2/json/cluster/status');
  }

  public async getNodes(): Promise<
    Array<{ node: string; status: string; ssl_fingerprint?: string }>
  > {
    return this.request<
      Array<{ node: string; status: string; ssl_fingerprint?: string }>
    >('/api2/json/nodes');
  }

  public async getNodeStatus(node: string): Promise<ProxmoxNodeStatus> {
    return this.request<ProxmoxNodeStatus>(`/api2/json/nodes/${node}/status`);
  }

  public async getStorages(node: string): Promise<ProxmoxStorage[]> {
    return this.request<ProxmoxStorage[]>(`/api2/json/nodes/${node}/storage`);
  }

  // LXC
  public async listLxc(node: string): Promise<ProxmoxGuestStatus[]> {
    return this.request<ProxmoxGuestStatus[]>(`/api2/json/nodes/${node}/lxc`);
  }

  public async getLxcStatus(
    node: string,
    vmid: number,
  ): Promise<ProxmoxGuestStatus> {
    return this.request<ProxmoxGuestStatus>(
      `/api2/json/nodes/${node}/lxc/${vmid}/status/current`,
    );
  }

  public async getLxcConfig(
    node: string,
    vmid: number,
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      `/api2/json/nodes/${node}/lxc/${vmid}/config`,
    );
  }

  public async lxcPowerAction(
    node: string,
    vmid: number,
    action: 'start' | 'stop' | 'shutdown' | 'reboot',
  ): Promise<string> {
    return this.request<string>(
      `/api2/json/nodes/${node}/lxc/${vmid}/status/${action}`,
      {
        method: 'POST',
      },
    );
  }

  // QEMU (VM)
  public async listQemu(node: string): Promise<ProxmoxGuestStatus[]> {
    return this.request<ProxmoxGuestStatus[]>(`/api2/json/nodes/${node}/qemu`);
  }

  public async getQemuStatus(
    node: string,
    vmid: number,
  ): Promise<ProxmoxGuestStatus> {
    return this.request<ProxmoxGuestStatus>(
      `/api2/json/nodes/${node}/qemu/${vmid}/status/current`,
    );
  }

  public async getQemuConfig(
    node: string,
    vmid: number,
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      `/api2/json/nodes/${node}/qemu/${vmid}/config`,
    );
  }

  public async qemuPowerAction(
    node: string,
    vmid: number,
    action: 'start' | 'stop' | 'shutdown' | 'reboot' | 'reset',
  ): Promise<string> {
    return this.request<string>(
      `/api2/json/nodes/${node}/qemu/${vmid}/status/${action}`,
      {
        method: 'POST',
      },
    );
  }

  public async getQemuAgentInfo(
    node: string,
    vmid: number,
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      `/api2/json/nodes/${node}/qemu/${vmid}/agent/info`,
    );
  }

  // Tasks
  public async getTaskStatus(
    node: string,
    upid: string,
  ): Promise<ProxmoxTaskStatus> {
    return this.request<ProxmoxTaskStatus>(
      `/api2/json/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`,
    );
  }

  public async getTaskLog(
    node: string,
    upid: string,
    start = 0,
    limit = 500,
  ): Promise<ProxmoxTaskLogLine[]> {
    return this.request<ProxmoxTaskLogLine[]>(
      `/api2/json/nodes/${node}/tasks/${encodeURIComponent(upid)}/log?start=${start}&limit=${limit}`,
    );
  }

  public async waitForTask(
    upid: string,
    options: AwaitTaskOptions = {},
  ): Promise<ProxmoxTaskStatus> {
    const node = parseNodeFromUpid(upid);
    const intervalMs = options.intervalMs ?? 100;
    const timeoutMs = options.timeoutMs ?? 30000;
    const startTime = Date.now();
    let lastLogLineIndex = 0;

    while (true) {
      if (options.signal?.aborted) {
        throw new Error('Task await aborted');
      }

      if (Date.now() - startTime > timeoutMs) {
        throw new Error(
          `Timeout waiting for task '${upid}' after ${timeoutMs}ms`,
        );
      }

      const status = await this.getTaskStatus(node, upid);

      if (options.onProgress) {
        try {
          const logs = await this.getTaskLog(node, upid, lastLogLineIndex, 100);
          for (const line of logs) {
            options.onProgress(line.t);
            lastLogLineIndex = Math.max(lastLogLineIndex, line.n + 1);
          }
        } catch {
          // Non-fatal if log fetching is interrupted
        }
      }

      if (status.status === 'stopped') {
        if (status.exitstatus === 'OK' || status.exitstatus === undefined) {
          return status;
        }
        throw new ProxmoxTaskError(upid, status.exitstatus ?? 'UNKNOWN_ERROR');
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
