import type { ExecOptions, ExecResult, Transport } from '@hacm/core';
import type { SshTransport } from '../ssh/types.js';
import type { ProxmoxClient } from '../proxmox/client.js';
import {
  ChannelUnavailableError,
  type ChannelHealth,
  type TestConnectionResult,
} from './types.js';

export interface HostConnectionRouterOptions {
  readonly sshTransport?: SshTransport | undefined;
  readonly apiClient?: ProxmoxClient | undefined;
  readonly defaultNode?: string | undefined;
}

export class HostConnectionRouter implements Transport {
  public readonly hostId: string;
  private readonly sshTransport?: SshTransport | undefined;
  private readonly apiClient?: ProxmoxClient | undefined;
  private readonly defaultNode: string;
  private sshHealth: ChannelHealth;
  private apiHealth: ChannelHealth;

  public constructor(
    hostId: string,
    options: HostConnectionRouterOptions = {},
  ) {
    this.hostId = hostId;
    this.sshTransport = options.sshTransport;
    this.apiClient = options.apiClient;
    this.defaultNode = options.defaultNode ?? 'localhost';

    this.sshHealth = {
      ok: Boolean(this.sshTransport),
      status: this.sshTransport ? 'connected' : 'not_configured',
    };

    this.apiHealth = {
      ok: Boolean(this.apiClient),
      status: this.apiClient ? 'connected' : 'not_configured',
    };
  }

  public get health(): {
    readonly ssh: ChannelHealth;
    readonly api: ChannelHealth;
  } {
    return {
      ssh: this.sshHealth,
      api: this.apiHealth,
    };
  }

  public async exec(
    argv: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    if (!this.sshTransport) {
      throw new ChannelUnavailableError(
        this.hostId,
        'ssh',
        `Command execution ('${argv[0] ?? ''}') requires SSH channel, which is not configured for host '${this.hostId}'.`,
      );
    }

    try {
      const result = await this.sshTransport.exec(argv, options);
      this.sshHealth = {
        ok: true,
        status: 'connected',
        lastCheckedAt: new Date().toISOString(),
      };
      return result;
    } catch (err) {
      this.sshHealth = {
        ok: false,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        lastCheckedAt: new Date().toISOString(),
      };
      throw err;
    }
  }

  public async readFile(
    path: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<string> {
    if (!this.sshTransport) {
      throw new ChannelUnavailableError(
        this.hostId,
        'ssh',
        `File read ('${path}') requires SSH channel, which is not configured for host '${this.hostId}'.`,
      );
    }

    return this.sshTransport.readFile(path, options);
  }

  public async writeFile(
    path: string,
    content: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    if (!this.sshTransport) {
      throw new ChannelUnavailableError(
        this.hostId,
        'ssh',
        `File write ('${path}') requires SSH channel, which is not configured for host '${this.hostId}'.`,
      );
    }

    return this.sshTransport.writeFile(path, content, options);
  }

  public async readGuestConfig(
    vmid: number,
    type: 'lxc' | 'vm',
    node = this.defaultNode,
  ): Promise<{
    readonly raw: string | Record<string, unknown>;
    readonly source: 'api' | 'ssh';
  }> {
    // 1. Try API first if configured
    if (this.apiClient) {
      try {
        const config =
          type === 'lxc'
            ? await this.apiClient.getLxcConfig(node, vmid)
            : await this.apiClient.getQemuConfig(node, vmid);
        this.apiHealth = {
          ok: true,
          status: 'connected',
          lastCheckedAt: new Date().toISOString(),
        };
        return { raw: config, source: 'api' };
      } catch (err) {
        this.apiHealth = {
          ok: false,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          lastCheckedAt: new Date().toISOString(),
        };
        // Fall back to SSH if available
        if (!this.sshTransport) {
          throw err;
        }
      }
    }

    // 2. Fall back to SSH
    if (this.sshTransport) {
      const cmd =
        type === 'lxc'
          ? ['pct', 'config', String(vmid)]
          : ['qm', 'config', String(vmid)];
      const res = await this.sshTransport.exec(cmd);
      if (res.exitCode !== 0) {
        throw new Error(
          `Failed to read config for ${type} ${vmid} via SSH: ${res.stderr.trim() || `exit code ${res.exitCode}`}`,
        );
      }
      return { raw: res.stdout, source: 'ssh' };
    }

    throw new ChannelUnavailableError(
      this.hostId,
      'ssh',
      `Neither API nor SSH channel is available to read config for ${type} ${vmid} on host '${this.hostId}'.`,
    );
  }

  public async powerAction(
    vmid: number,
    type: 'lxc' | 'vm',
    action: 'start' | 'stop' | 'shutdown' | 'reboot',
    node = this.defaultNode,
  ): Promise<{
    readonly upid?: string | undefined;
    readonly source: 'api' | 'ssh';
  }> {
    if (this.apiClient) {
      try {
        const upid =
          type === 'lxc'
            ? await this.apiClient.lxcPowerAction(node, vmid, action)
            : await this.apiClient.qemuPowerAction(node, vmid, action);
        return { upid, source: 'api' };
      } catch (err) {
        if (!this.sshTransport) {
          throw err;
        }
      }
    }

    if (this.sshTransport) {
      const tool = type === 'lxc' ? 'pct' : 'qm';
      const res = await this.sshTransport.exec([tool, action, String(vmid)]);
      if (res.exitCode !== 0) {
        throw new Error(
          `Power action ${action} failed on ${type} ${vmid} via SSH: ${res.stderr.trim()}`,
        );
      }
      return { source: 'ssh' };
    }

    throw new ChannelUnavailableError(
      this.hostId,
      'ssh',
      `Cannot execute power action '${action}' for ${type} ${vmid}: no channel available on host '${this.hostId}'.`,
    );
  }

  public async testConnection(): Promise<TestConnectionResult> {
    let sshRes: ChannelHealth = {
      ok: false,
      status: 'not_configured',
    };

    if (this.sshTransport) {
      const t0 = Date.now();
      try {
        const res = await this.sshTransport.exec(['echo', 'hacm-ping'], {
          timeoutMs: 5000,
        });
        if (res.exitCode === 0) {
          sshRes = {
            ok: true,
            status: 'connected',
            latencyMs: Date.now() - t0,
            lastCheckedAt: new Date().toISOString(),
          };
        } else {
          sshRes = {
            ok: false,
            status: 'error',
            error: res.stderr || `Exit code ${res.exitCode}`,
            latencyMs: Date.now() - t0,
            lastCheckedAt: new Date().toISOString(),
          };
        }
      } catch (err) {
        sshRes = {
          ok: false,
          status: 'unreachable',
          error: err instanceof Error ? err.message : String(err),
          latencyMs: Date.now() - t0,
          lastCheckedAt: new Date().toISOString(),
        };
      }
    }
    this.sshHealth = sshRes;

    let apiRes: ChannelHealth | undefined = undefined;
    if (this.apiClient) {
      const t0 = Date.now();
      try {
        await this.apiClient.getNodes();
        apiRes = {
          ok: true,
          status: 'connected',
          latencyMs: Date.now() - t0,
          lastCheckedAt: new Date().toISOString(),
        };
      } catch (err) {
        apiRes = {
          ok: false,
          status: 'unreachable',
          error: err instanceof Error ? err.message : String(err),
          latencyMs: Date.now() - t0,
          lastCheckedAt: new Date().toISOString(),
        };
      }
      this.apiHealth = apiRes;
    }

    const overallOk =
      (this.sshTransport ? sshRes.ok : true) &&
      (this.apiClient ? (apiRes?.ok ?? false) : true);

    return {
      ok: overallOk,
      ssh: sshRes,
      api: apiRes,
    };
  }
}
