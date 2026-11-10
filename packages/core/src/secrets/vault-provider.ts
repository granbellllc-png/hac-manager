import { basename } from 'node:path';
import { globalSecretRedactor } from '../redaction/redactor.js';
import { Secret } from '../tags/secret.js';
import { defaultNodeCmdExecutor, parseCommandArgs } from './cmd-provider.js';
import type {
  CliVaultProviderOptions,
  CmdExecutionResult,
  CmdExecutor,
  VaultProvider,
  VaultProviderStatus,
} from './types.js';

const MAX_TOKEN_LENGTH = 16 * 1024;

function lockedReason(result: CmdExecutionResult): string {
  return result.stderr.trim() || result.stdout.trim() || 'Vault CLI is locked';
}

function defaultEvaluateStatus(
  result: CmdExecutionResult,
): VaultProviderStatus {
  if (result.errorCode) {
    return {
      status: 'unavailable',
      reason:
        result.errorCode === 'ENOENT'
          ? 'Vault CLI is not installed or is not on PATH'
          : `Vault CLI status check failed (${result.errorCode})`,
    };
  }
  if (result.exitCode === 0) return { status: 'unlocked' };
  return { status: 'locked', reason: lockedReason(result) };
}

function evaluateBitwardenStatus(
  result: CmdExecutionResult,
): VaultProviderStatus {
  if (result.errorCode === 'ENOENT') return defaultEvaluateStatus(result);
  try {
    const parsed = JSON.parse(result.stdout) as { status?: unknown };
    if (parsed.status === 'unlocked') return { status: 'unlocked' };
    if (parsed.status === 'locked' || parsed.status === 'unauthenticated') {
      return {
        status: 'locked',
        reason: `Bitwarden CLI status is ${parsed.status}`,
      };
    }
  } catch {
    // Fall through to the generic exit-code classification.
  }
  return defaultEvaluateStatus(result);
}

export class CliVaultProvider implements VaultProvider {
  public readonly id: string;
  public readonly name: string;
  public readonly commands: readonly string[];
  public readonly tokenLabel: string;
  public readonly helpText: string;
  private readonly tokenEnvVar: string;
  private readonly statusArgv: readonly string[];
  private readonly executor: CmdExecutor;
  private readonly env?: Record<string, string | undefined> | undefined;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly evaluateStatus: (
    result: CmdExecutionResult,
  ) => VaultProviderStatus;
  private token?: Secret | undefined;

  public constructor(options: CliVaultProviderOptions) {
    if (options.statusArgv.length === 0) {
      throw new Error(`Vault provider '${options.id}' needs a status command`);
    }
    this.id = options.id;
    this.name = options.name;
    this.commands = options.commands;
    this.tokenLabel = options.tokenLabel;
    this.helpText = options.helpText;
    this.tokenEnvVar = options.tokenEnvVar;
    this.statusArgv = options.statusArgv;
    this.executor = options.executor ?? defaultNodeCmdExecutor;
    this.env = options.env;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
    this.evaluateStatus = options.evaluateStatus ?? defaultEvaluateStatus;
  }

  public async status(): Promise<VaultProviderStatus> {
    const [bin, ...args] = this.statusArgv;
    try {
      const result = await this.executor(bin!, args, {
        argv: this.statusArgv,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        env: {
          ...this.env,
          ...this.environment(),
        },
      });
      const status = this.evaluateStatus(result);
      return status.reason
        ? {
            ...status,
            reason: globalSecretRedactor.redact(status.reason),
          }
        : status;
    } catch (error) {
      return {
        status: 'unavailable',
        reason: globalSecretRedactor.redact(
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
  }

  public async unlock(token: string): Promise<VaultProviderStatus> {
    const normalized = token.trim();
    if (!normalized) {
      return { status: 'locked', reason: 'Unlock token must not be empty' };
    }
    if (normalized.length > MAX_TOKEN_LENGTH) {
      return {
        status: 'locked',
        reason: `Unlock token exceeds ${MAX_TOKEN_LENGTH} characters`,
      };
    }
    this.clear();
    this.token = new Secret(normalized);
    globalSecretRedactor.register(this.token);
    const status = await this.status();
    if (status.status !== 'unlocked') this.clear();
    return status;
  }

  public clear(): void {
    if (this.token) globalSecretRedactor.unregister(this.token);
    this.token = undefined;
  }

  public environment(): Readonly<Record<string, string>> {
    return this.token
      ? { [this.tokenEnvVar]: this.token.unwrap() }
      : Object.freeze({});
  }
}

export function createDefaultVaultProviders(
  options: {
    readonly executor?: CmdExecutor | undefined;
    readonly env?: Record<string, string | undefined> | undefined;
  } = {},
): readonly VaultProvider[] {
  const shared = {
    ...(options.executor ? { executor: options.executor } : {}),
    ...(options.env ? { env: options.env } : {}),
  };
  return [
    new CliVaultProvider({
      ...shared,
      id: 'op',
      name: '1Password CLI',
      commands: ['op'],
      tokenEnvVar: 'OP_SERVICE_ACCOUNT_TOKEN',
      statusArgv: ['op', 'whoami'],
      tokenLabel: '1Password service-account token',
      helpText:
        'Desktop-app unlock is unavailable on headless servers. Use a service-account token.',
    }),
    new CliVaultProvider({
      ...shared,
      id: 'bw',
      name: 'Bitwarden CLI',
      commands: ['bw'],
      tokenEnvVar: 'BW_SESSION',
      statusArgv: ['bw', 'status'],
      tokenLabel: 'Bitwarden session token',
      helpText: 'Generate a session token with `bw unlock --raw`.',
      evaluateStatus: evaluateBitwardenStatus,
    }),
    new CliVaultProvider({
      ...shared,
      id: 'vault',
      name: 'HashiCorp Vault CLI',
      commands: ['vault'],
      tokenEnvVar: 'VAULT_TOKEN',
      statusArgv: ['vault', 'token', 'lookup', '-format=json'],
      tokenLabel: 'Vault token',
      helpText: 'Supply a token allowed to read the configured secret paths.',
    }),
  ];
}

export function commandName(command: string): string | undefined {
  const first = parseCommandArgs(command.trim())[0];
  return first ? basename(first.replaceAll('\\', '/')) : undefined;
}
