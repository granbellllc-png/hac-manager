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
}

export interface SecretManagerOptions {
  readonly dataDir: string;
  readonly allowlist?: readonly string[] | undefined;
  readonly ttlMs?: number | undefined;
  readonly fs?: FileSystem | undefined;
  readonly cmdExecutor?: CmdExecutor | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
}
