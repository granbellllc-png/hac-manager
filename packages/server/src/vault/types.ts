import type { VaultProviderMetadata, VaultProviderStatus } from '@hacm/core';

export interface HostVaultProvider extends VaultProviderMetadata {
  readonly status: VaultProviderStatus['status'];
  readonly reason?: string | undefined;
}

export interface VaultUnlockActor {
  readonly id: string;
  readonly username: string;
}

export class VaultProviderNotRequiredError extends Error {
  public constructor(
    public readonly hostId: string,
    public readonly providerId: string,
  ) {
    super(`Vault provider '${providerId}' is not required by host '${hostId}'`);
    this.name = 'VaultProviderNotRequiredError';
  }
}

export class VaultUnavailableError extends Error {
  public constructor(
    public readonly providerId: string,
    message: string,
  ) {
    super(message);
    this.name = 'VaultUnavailableError';
  }
}

export class VaultUnlockDeclinedError extends Error {
  public constructor(public readonly providerId: string) {
    super(`Unlock was declined for vault provider '${providerId}'`);
    this.name = 'VaultUnlockDeclinedError';
  }
}

export class VaultUnlockFailedError extends Error {
  public constructor(
    public readonly providerId: string,
    message: string,
  ) {
    super(message);
    this.name = 'VaultUnlockFailedError';
  }
}
