import { resolve } from 'node:path';
import type {
  CmdProvider,
  CmdProviderResult,
  SecretProvider,
  SecretProviderResult,
} from '../tags/types.js';
import { isTagValue } from '../schema/common.js';
import { defaultNodeFileSystem, type FileSystem } from '../yaml/file.js';
import { SecretTtlCache } from './cache.js';
import { CommandSecretProvider } from './cmd-provider.js';
import { EnvSecretProvider } from './env-provider.js';
import type {
  SecretManagerOptions,
  VaultProvider,
  VaultProviderMetadata,
  VaultProviderStatus,
} from './types.js';
import { commandName, createDefaultVaultProviders } from './vault-provider.js';
import { YamlSecretProvider } from './yaml-provider.js';

export class SecretManager implements SecretProvider, CmdProvider {
  private readonly dataDir: string;
  private readonly ttlCache: SecretTtlCache<string>;
  private readonly yamlProvider: YamlSecretProvider;
  private readonly cmdProvider: CommandSecretProvider;
  private readonly envProvider: EnvSecretProvider;
  private readonly vaultProviders = new Map<string, VaultProvider>();
  private readonly vaultStatusCache: SecretTtlCache<VaultProviderStatus>;

  public constructor(options: SecretManagerOptions) {
    this.dataDir = options.dataDir;
    const fs: FileSystem = options.fs ?? defaultNodeFileSystem;
    const ttlMs = options.ttlMs ?? 300_000; // 5 min default

    this.ttlCache = new SecretTtlCache<string>(ttlMs);
    this.vaultStatusCache = new SecretTtlCache<VaultProviderStatus>(ttlMs);

    const vaultProviders =
      options.vaultProviders ??
      createDefaultVaultProviders({
        ...(options.cmdExecutor ? { executor: options.cmdExecutor } : {}),
        ...(options.env ? { env: options.env } : {}),
      });
    for (const provider of vaultProviders) {
      if (this.vaultProviders.has(provider.id)) {
        throw new Error(`Duplicate vault provider id '${provider.id}'`);
      }
      this.vaultProviders.set(provider.id, provider);
    }

    const secretsFilePath = resolve(this.dataDir, 'secrets.yaml');
    this.yamlProvider = new YamlSecretProvider({
      secretsPath: secretsFilePath,
      fs,
    });

    this.cmdProvider = new CommandSecretProvider({
      allowlist: options.allowlist ?? ['op', 'bw', 'pass', 'vault', 'echo'],
      executor: options.cmdExecutor,
      env: options.env,
      runtimeEnv: () => this.runtimeVaultEnvironment(),
    });

    this.envProvider = new EnvSecretProvider({
      env: options.env,
      fs,
    });
  }

  public get env(): EnvSecretProvider {
    return this.envProvider;
  }

  public get ttlCacheSize(): number {
    return this.ttlCache.size;
  }

  public async resolveSecret(key: string): Promise<SecretProviderResult> {
    const cacheKey = `secret:${key}`;
    const cached = this.ttlCache.get(cacheKey);
    if (cached !== undefined) {
      return { status: 'found', value: cached };
    }

    const result = await this.yamlProvider.resolveSecret(key);
    if (result.status === 'found') {
      this.ttlCache.set(cacheKey, result.value);
    }
    return result;
  }

  public async resolveCmd(command: string): Promise<CmdProviderResult> {
    const cacheKey = `cmd:${command.trim()}`;
    const cached = this.ttlCache.get(cacheKey);
    if (cached !== undefined) {
      return { status: 'success', output: cached };
    }

    const result = await this.cmdProvider.resolveCmd(command);
    if (result.status === 'success') {
      this.ttlCache.set(cacheKey, result.output);
    }
    const provider = this.vaultProviderForCommand(command);
    if (provider && result.status === 'success') {
      this.vaultStatusCache.set(provider.id, { status: 'unlocked' });
    } else if (provider && result.status === 'locked') {
      this.vaultStatusCache.set(provider.id, {
        status: 'locked',
        reason: result.reason,
      });
    }
    return result;
  }

  public listVaultProviders(): readonly VaultProviderMetadata[] {
    return [...this.vaultProviders.values()].map(
      ({ id, name, commands, tokenLabel, helpText }) => ({
        id,
        name,
        commands,
        tokenLabel,
        helpText,
      }),
    );
  }

  public vaultProviderForCommand(
    command: string,
  ): VaultProviderMetadata | undefined {
    const executable = commandName(command);
    if (!executable) return undefined;
    return [...this.vaultProviders.values()].find((provider) =>
      provider.commands.includes(executable),
    );
  }

  public requiredVaultProviderIds(input: unknown): readonly string[] {
    const required = new Set<string>();
    const walk = (value: unknown): void => {
      if (isTagValue(value)) {
        if (value.tag === 'cmd') {
          const provider = this.vaultProviderForCommand(value.value);
          if (provider) required.add(provider.id);
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (value && typeof value === 'object') {
        for (const item of Object.values(value as Record<string, unknown>)) {
          walk(item);
        }
      }
    };
    walk(input);
    return [...required].sort();
  }

  public async getVaultStatus(
    providerId: string,
    options: { readonly refresh?: boolean | undefined } = {},
  ): Promise<VaultProviderStatus> {
    const provider = this.vaultProviders.get(providerId);
    if (!provider) {
      return {
        status: 'unavailable',
        reason: `Vault provider '${providerId}' is not configured`,
      };
    }
    if (!options.refresh) {
      const cached = this.vaultStatusCache.get(providerId);
      if (cached) return cached;
    }
    const status = await provider.status();
    this.vaultStatusCache.set(providerId, status);
    return status;
  }

  public async unlockVault(
    providerId: string,
    token: string,
  ): Promise<VaultProviderStatus> {
    const provider = this.vaultProviders.get(providerId);
    if (!provider) {
      return {
        status: 'unavailable',
        reason: `Vault provider '${providerId}' is not configured`,
      };
    }
    const status = await provider.unlock(token);
    this.vaultStatusCache.set(providerId, status);
    if (status.status === 'unlocked') this.ttlCache.clear();
    return status;
  }

  public clearVault(providerId: string): boolean {
    const provider = this.vaultProviders.get(providerId);
    if (!provider) return false;
    provider.clear();
    this.vaultStatusCache.invalidate(providerId);
    this.ttlCache.clear();
    return true;
  }

  public async resolveEnvVar(
    varName: string,
    fileDirs?: readonly string[],
  ): Promise<string | undefined> {
    return this.envProvider.resolveVar(varName, fileDirs);
  }

  public invalidateSecret(key: string): void {
    this.ttlCache.invalidate(`secret:${key}`);
    this.yamlProvider.invalidate();
  }

  public invalidateCmd(command: string): void {
    this.ttlCache.invalidate(`cmd:${command.trim()}`);
  }

  public invalidateAll(): void {
    this.ttlCache.clear();
    this.vaultStatusCache.clear();
    this.yamlProvider.invalidate();
    this.envProvider.clear();
  }

  private runtimeVaultEnvironment(): Record<string, string> {
    return Object.assign(
      {},
      ...[...this.vaultProviders.values()].map((provider) =>
        provider.environment(),
      ),
    ) as Record<string, string>;
  }
}
