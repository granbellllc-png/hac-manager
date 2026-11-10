import { randomUUID } from 'node:crypto';
import { globalSecretRedactor, type SecretManager } from '@hacm/core';
import type { DatabaseRepositories } from '../db/repositories/types.js';
import type { HostRegistry } from '../hosts/registry.js';
import type { JobExecutionContext } from '../jobs/types.js';
import {
  VaultProviderNotRequiredError,
  VaultUnavailableError,
  VaultUnlockDeclinedError,
  VaultUnlockFailedError,
  type HostVaultProvider,
  type VaultUnlockActor,
} from './types.js';

function confirmed(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['kind'] === 'confirm' &&
    (value as Record<string, unknown>)['confirmed'] === true
  );
}

export class VaultService {
  private readonly promptEpoch = randomUUID();

  public constructor(
    private readonly secretManager: SecretManager,
    private readonly hostRegistry: HostRegistry,
    private readonly repos: DatabaseRepositories,
  ) {}

  public async listForHost(
    hostId: string,
    options: { readonly refresh?: boolean | undefined } = {},
  ): Promise<readonly HostVaultProvider[]> {
    const rawHost = this.hostRegistry.getRawHost(hostId);
    if (!rawHost) return [];
    const required = new Set(
      this.secretManager.requiredVaultProviderIds(rawHost.connection),
    );
    const providers = this.secretManager
      .listVaultProviders()
      .filter((provider) => required.has(provider.id));
    return Promise.all(
      providers.map(async (provider) => {
        const status = await this.secretManager.getVaultStatus(provider.id, {
          refresh: options.refresh,
        });
        return {
          ...provider,
          status: status.status,
          ...(status.reason
            ? { reason: globalSecretRedactor.redact(status.reason) }
            : {}),
        };
      }),
    );
  }

  public async unlock(
    hostId: string,
    providerId: string,
    token: string,
    actor: VaultUnlockActor,
  ): Promise<HostVaultProvider> {
    const providers = await this.listForHost(hostId);
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) {
      throw new VaultProviderNotRequiredError(hostId, providerId);
    }
    const status = await this.secretManager.unlockVault(providerId, token);
    if (status.status !== 'unlocked') {
      this.updateHostVaultStatus(hostId, 'locked', status.reason);
      throw new VaultUnlockFailedError(
        providerId,
        status.reason ?? `Could not unlock ${provider.name}`,
      );
    }
    this.updateHostVaultStatus(hostId, 'unlocked');
    await this.repos.auditLogs.append({
      userId: actor.id,
      username: actor.username,
      hostId,
      action: 'vault.unlock',
      reason: 'manual',
      diff: { providerId, status: 'unlocked' },
      metadata: { storage: 'memory_only' },
    });
    return { ...provider, status: 'unlocked', reason: undefined };
  }

  public async preflight(context: JobExecutionContext): Promise<void> {
    const providers = await this.listForHost(context.job.hostId);
    if (providers.length === 0) {
      this.updateHostVaultStatus(context.job.hostId, 'not_configured');
      return;
    }

    for (const provider of providers) {
      if (provider.status === 'unlocked') continue;
      if (provider.status === 'unavailable') {
        this.updateHostVaultStatus(
          context.job.hostId,
          'locked',
          provider.reason,
        );
        throw new VaultUnavailableError(
          provider.id,
          provider.reason ?? `${provider.name} is unavailable`,
        );
      }

      this.updateHostVaultStatus(
        context.job.hostId,
        'locked',
        'Vault unlock is required',
      );
      const resolution = await context.prompt({
        id: `${context.job.id}:vault:${provider.id}:${this.promptEpoch}`,
        kind: 'confirm',
        message: `Unlock ${provider.name} to continue`,
        payload: {
          type: 'vault_unlock',
          providerId: provider.id,
          providerName: provider.name,
          tokenLabel: provider.tokenLabel,
          helpText: provider.helpText,
          storage: 'memory_only',
        },
      });
      if (!confirmed(resolution)) {
        throw new VaultUnlockDeclinedError(provider.id);
      }
      const refreshed = await this.secretManager.getVaultStatus(provider.id, {
        refresh: true,
      });
      if (refreshed.status !== 'unlocked') {
        throw new VaultUnlockFailedError(
          provider.id,
          refreshed.reason ?? `${provider.name} is still locked`,
        );
      }
    }

    this.updateHostVaultStatus(context.job.hostId, 'unlocked');
  }

  private updateHostVaultStatus(
    hostId: string,
    status: 'not_configured' | 'unlocked' | 'locked',
    error?: string,
  ): void {
    this.hostRegistry.updateRuntimeStatus(hostId, {
      vault: {
        status,
        ...(error
          ? { error: globalSecretRedactor.redact(error) }
          : { error: undefined }),
      },
    });
  }
}
