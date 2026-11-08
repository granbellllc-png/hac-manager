import { resolve } from 'node:path';
import type {
  CmdProvider,
  CmdProviderResult,
  SecretProvider,
  SecretProviderResult,
} from '../tags/types.js';
import { defaultNodeFileSystem, type FileSystem } from '../yaml/file.js';
import { SecretTtlCache } from './cache.js';
import { CommandSecretProvider } from './cmd-provider.js';
import { EnvSecretProvider } from './env-provider.js';
import type { SecretManagerOptions } from './types.js';
import { YamlSecretProvider } from './yaml-provider.js';

export class SecretManager implements SecretProvider, CmdProvider {
  private readonly dataDir: string;
  private readonly ttlCache: SecretTtlCache<string>;
  private readonly yamlProvider: YamlSecretProvider;
  private readonly cmdProvider: CommandSecretProvider;
  private readonly envProvider: EnvSecretProvider;

  public constructor(options: SecretManagerOptions) {
    this.dataDir = options.dataDir;
    const fs: FileSystem = options.fs ?? defaultNodeFileSystem;
    const ttlMs = options.ttlMs ?? 300_000; // 5 min default

    this.ttlCache = new SecretTtlCache<string>(ttlMs);

    const secretsFilePath = resolve(this.dataDir, 'secrets.yaml');
    this.yamlProvider = new YamlSecretProvider({
      secretsPath: secretsFilePath,
      fs,
    });

    this.cmdProvider = new CommandSecretProvider({
      allowlist: options.allowlist ?? ['op', 'bw', 'pass', 'vault', 'echo'],
      executor: options.cmdExecutor,
      env: options.env,
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
    return result;
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
    this.yamlProvider.invalidate();
    this.envProvider.clear();
  }
}
