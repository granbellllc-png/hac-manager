import {
  globalSecretRedactor,
  resolveConfigTags,
  Secret,
  SecretManager,
  type HostFile,
} from '@hacm/core';

function unwrapSecret(val: unknown): string | undefined {
  if (val === undefined || val === null) return undefined;
  if (val instanceof Secret) return val.unwrap();
  return String(val);
}
import type { HostRegistry } from '../hosts/registry.js';
import { SshPool } from '../ssh/pool.js';
import type { SshHostConfig } from '../ssh/types.js';
import { ProxmoxClient } from '../proxmox/client.js';
import { HostConnectionRouter } from './router.js';
import type { TestConnectionResult } from './types.js';

export interface ConnectionManagerOptions {
  readonly dataDir: string;
  readonly hostRegistry: HostRegistry;
  readonly secretManager?: SecretManager | undefined;
  readonly sshPool?: SshPool | undefined;
}

export class VaultLockedError extends Error {
  public constructor(
    public readonly hostId: string,
    public readonly providerIds: readonly string[],
  ) {
    super(`Vault access is locked for host '${hostId}'`);
    this.name = 'VaultLockedError';
  }
}

export class SecretResolutionError extends Error {
  public constructor(
    public readonly hostId: string,
    message: string,
  ) {
    super(message);
    this.name = 'SecretResolutionError';
  }
}

export class ConnectionManager {
  public readonly dataDir: string;
  public readonly hostRegistry: HostRegistry;
  public readonly secretManager: SecretManager;
  public readonly sshPool: SshPool;
  private readonly routers = new Map<string, HostConnectionRouter>();

  public constructor(options: ConnectionManagerOptions) {
    this.dataDir = options.dataDir;
    this.hostRegistry = options.hostRegistry;
    this.secretManager =
      options.secretManager ?? new SecretManager({ dataDir: this.dataDir });
    this.sshPool = options.sshPool ?? new SshPool();
  }

  public async getRouter(hostId: string): Promise<HostConnectionRouter> {
    const existing = this.routers.get(hostId);
    if (existing) {
      return existing;
    }

    const rawHost = this.hostRegistry.getRawHost(hostId);
    if (!rawHost) {
      throw new Error(`Host '${hostId}' not found in registry`);
    }

    const router = await this.buildRouter(rawHost);
    this.routers.set(hostId, router);
    return router;
  }

  public registerRouter(hostId: string, router: HostConnectionRouter): void {
    this.routers.set(hostId, router);
  }

  public async getApiClient(
    hostId: string,
  ): Promise<ProxmoxClient | undefined> {
    const router = await this.getRouter(hostId);
    return router.client;
  }

  private async buildRouter(host: HostFile): Promise<HostConnectionRouter> {
    // Resolve tags in connection object
    const resolution = await resolveConfigTags<HostFile['connection']>(
      host.connection,
      {
        dataDir: this.dataDir,
        secretProvider: this.secretManager,
        cmdProvider: this.secretManager,
        env: process.env,
      },
    );

    if (resolution.report.locked.length > 0) {
      const providerIds = new Set<string>();
      for (const locked of resolution.report.locked) {
        if (locked.tag !== 'cmd') continue;
        const provider = this.secretManager.vaultProviderForCommand(locked.raw);
        if (provider) providerIds.add(provider.id);
      }
      this.hostRegistry.updateRuntimeStatus(host.id, {
        vault: {
          status: 'locked',
          error: 'Vault unlock is required',
        },
      });
      throw new VaultLockedError(host.id, [...providerIds]);
    }
    if (
      resolution.report.unresolved.length > 0 ||
      resolution.report.errors.length > 0
    ) {
      const details = [
        ...resolution.report.unresolved.map((item) => item.reason),
        ...resolution.report.errors.map((item) => item.error),
      ];
      throw new SecretResolutionError(
        host.id,
        globalSecretRedactor.redact(
          `Could not resolve connection credentials for host '${host.id}': ${details.join('; ')}`,
        ),
      );
    }

    const requiredProviders = this.secretManager.requiredVaultProviderIds(
      host.connection,
    );
    this.hostRegistry.updateRuntimeStatus(host.id, {
      vault: {
        status: requiredProviders.length > 0 ? 'unlocked' : 'not_configured',
        error: undefined,
      },
    });

    const resolvedConn = resolution.data;

    let sshTransport = undefined;
    if (resolvedConn.ssh) {
      const sshConf: SshHostConfig = {
        host: String(resolvedConn.ssh.host),
        port: resolvedConn.ssh.port,
        username: resolvedConn.ssh.username
          ? String(resolvedConn.ssh.username)
          : 'root',
        privateKey: unwrapSecret(resolvedConn.ssh.private_key),
        password: unwrapSecret(resolvedConn.ssh.password),
        fingerprint: resolvedConn.ssh.fingerprint,
        readyTimeoutMs: 3000,
      };
      sshTransport = this.sshPool.getOrCreate(host.id, sshConf);
    }

    let apiClient = undefined;
    if (resolvedConn.api) {
      const isToken = Boolean(
        resolvedConn.api.token_id && resolvedConn.api.token_secret,
      );
      apiClient = new ProxmoxClient({
        baseUrl: resolvedConn.api.url,
        auth: isToken
          ? {
              type: 'token',
              tokenId: unwrapSecret(resolvedConn.api.token_id)!,
              tokenSecret: unwrapSecret(resolvedConn.api.token_secret)!,
            }
          : {
              type: 'ticket',
              username: String(resolvedConn.ssh?.username ?? 'root@pam'),
              password: unwrapSecret(resolvedConn.ssh?.password) ?? '',
            },
        pinnedFingerprint: resolvedConn.api.fingerprint,
        caCertificate: resolvedConn.api.ca_file
          ? String(resolvedConn.api.ca_file)
          : undefined,
      });
    }

    return new HostConnectionRouter(host.id, {
      sshTransport,
      apiClient,
      defaultNode: host.id,
    });
  }

  public async testConnection(hostId: string): Promise<TestConnectionResult> {
    const router = await this.getRouter(hostId);
    const result = await router.testConnection();

    const overall = !result.ok
      ? 'unreachable'
      : result.api?.ok === false
        ? 'degraded'
        : 'healthy';

    this.hostRegistry.updateRuntimeStatus(hostId, {
      overall,
      ssh: {
        status: result.ssh.status === 'connected' ? 'connected' : 'unreachable',
        error: result.ssh.error,
        lastCheckedAt: result.ssh.lastCheckedAt,
      },
      api: {
        status:
          result.api?.status === 'connected' ? 'connected' : 'unreachable',
        configured: Boolean(
          result.api && result.api.status !== 'not_configured',
        ),
        error: result.api?.error,
        lastCheckedAt: result.api?.lastCheckedAt,
      },
    });

    return result;
  }

  public async invalidateHost(hostId: string): Promise<void> {
    this.routers.delete(hostId);
    await this.sshPool.remove(hostId);
  }

  public async close(): Promise<void> {
    this.routers.clear();
    await this.sshPool.closeAll();
  }
}
