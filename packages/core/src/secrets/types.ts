import type { FileSystem } from '../yaml/file.js';

export interface TtlCacheOptions {
  /** Time to live in milliseconds (default: 300_000, i.e. 5 minutes) */
  readonly ttlMs?: number | undefined;
}

export interface YamlSecretProviderOptions {
  /** Path to secrets.yaml */
  readonly secretsPath: string;
  /** Injected file system for testing */
  readonly fs?: FileSystem | undefined;
}

export interface CmdExecutorOptions {
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly env?: Record<string, string | undefined> | undefined;
}

export interface CmdExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly errorCode?: string | undefined;
}

export type CmdExecutor = (
  bin: string,
  args: readonly string[],
  options: CmdExecutorOptions,
) => Promise<CmdExecutionResult>;

export interface CommandSecretProviderOptions {
  /**
   * Admin-managed allowlist of permitted executable names or paths.
   * If a binary is not in this list, execution is rejected with 'not_allowed'.
   */
  readonly allowlist: readonly string[];
  /** Default execution timeout in milliseconds (default: 5000ms) */
  readonly defaultTimeoutMs?: number | undefined;
  /** Maximum stdout bytes allowed (default: 64KB) */
  readonly maxOutputBytes?: number | undefined;
  /** Custom executor for injecting mocks or testing */
  readonly executor?: CmdExecutor | undefined;
  /** Environment variables to pass to the spawned process */
  readonly env?: Record<string, string | undefined> | undefined;
  /** Ephemeral environment, such as in-memory vault session tokens. */
  readonly runtimeEnv?: (() => Record<string, string | undefined>) | undefined;
}

export type VaultProviderState = 'unlocked' | 'locked' | 'unavailable';

export interface VaultProviderStatus {
  readonly status: VaultProviderState;
  readonly reason?: string | undefined;
}

export interface VaultProviderMetadata {
  readonly id: string;
  readonly name: string;
  readonly commands: readonly string[];
  readonly tokenLabel: string;
  readonly helpText: string;
}

export interface VaultProvider extends VaultProviderMetadata {
  status(): Promise<VaultProviderStatus>;
  unlock(token: string): Promise<VaultProviderStatus>;
  clear(): void;
  environment(): Readonly<Record<string, string>>;
}

export interface CliVaultProviderOptions extends VaultProviderMetadata {
  readonly tokenEnvVar: string;
  readonly statusArgv: readonly string[];
  readonly executor?: CmdExecutor | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly evaluateStatus?:
    ((result: CmdExecutionResult) => VaultProviderStatus) | undefined;
}

export interface SecretManagerOptions {
  readonly dataDir: string;
  readonly allowlist?: readonly string[] | undefined;
  readonly ttlMs?: number | undefined;
  readonly fs?: FileSystem | undefined;
  readonly cmdExecutor?: CmdExecutor | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  readonly vaultProviders?: readonly VaultProvider[] | undefined;
}
