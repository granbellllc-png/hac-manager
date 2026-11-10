import { basename } from 'node:path';
import type { CmdProvider, CmdProviderResult } from '../tags/types.js';
import type { CmdExecutor, CommandSecretProviderOptions } from './types.js';

export function parseCommandArgs(cmd: string): string[] {
  const args: string[] = [];
  let current = '';
  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (/\s/.test(ch) && !inDouble && !inSingle) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}

export const defaultNodeCmdExecutor: CmdExecutor = async (
  bin,
  args,
  options,
) => {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(
      bin,
      [...args],
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxOutputBytes,
        env: {
          ...process.env,
          ...options.env,
        },
      },
      (error, stdout, stderr) => {
        const outStr = String(stdout ?? '');
        const errStr = String(stderr ?? '');
        const exitCode = error
          ? typeof error.code === 'number'
            ? error.code
            : 1
          : 0;
        resolve({
          stdout: outStr,
          stderr: errStr,
          exitCode,
          ...(error && typeof error.code === 'string'
            ? { errorCode: error.code }
            : {}),
        });
      },
    );
  });
};

function isLockedOutput(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('not signed in') ||
    lower.includes('not logged in') ||
    lower.includes('session expired') ||
    lower.includes('vault is locked') ||
    lower.includes('authentication required') ||
    lower.includes('please authenticate') ||
    lower.includes('unauthorized')
  );
}

export class CommandSecretProvider implements CmdProvider {
  private readonly allowlist: readonly string[];
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly executor: CmdExecutor;
  private readonly env?: Record<string, string | undefined> | undefined;
  private readonly runtimeEnv?:
    (() => Record<string, string | undefined>) | undefined;

  public constructor(options: CommandSecretProviderOptions) {
    this.allowlist = options.allowlist;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;
    this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
    this.executor = options.executor ?? defaultNodeCmdExecutor;
    this.env = options.env;
    this.runtimeEnv = options.runtimeEnv;
  }

  public async resolveCmd(command: string): Promise<CmdProviderResult> {
    const trimmed = command.trim();
    if (!trimmed) {
      return {
        status: 'error',
        error: 'Empty command string',
      };
    }

    const argv = parseCommandArgs(trimmed);
    if (argv.length === 0) {
      return {
        status: 'error',
        error: 'No executable specified in command',
      };
    }

    const bin = argv[0]!;
    const binName = basename(bin);
    const args = argv.slice(1);

    // Verify binary against allowlist (exact match on binary name or full path)
    const isAllowed = this.allowlist.some(
      (item) => item === bin || item === binName,
    );

    if (!isAllowed) {
      return {
        status: 'not_allowed',
        reason: `Binary "${bin}" is not permitted by admin allowlist [${this.allowlist.join(', ')}]`,
      };
    }

    try {
      const execResult = await this.executor(bin, args, {
        argv,
        timeoutMs: this.defaultTimeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        env: {
          ...this.env,
          ...this.runtimeEnv?.(),
        },
      });

      const combinedOutput = `${execResult.stdout}\n${execResult.stderr}`;

      if (isLockedOutput(combinedOutput)) {
        return {
          status: 'locked',
          reason:
            execResult.stderr.trim() ||
            execResult.stdout.trim() ||
            'Vault CLI is locked',
        };
      }

      if (execResult.exitCode !== 0) {
        return {
          status: 'error',
          error:
            execResult.stderr.trim() ||
            execResult.stdout.trim() ||
            `Command "${trimmed}" exited with code ${execResult.exitCode}`,
        };
      }

      return {
        status: 'success',
        output: execResult.stdout.trim(),
      };
    } catch (err) {
      const msg = (err as Error).message;
      if (isLockedOutput(msg)) {
        return {
          status: 'locked',
          reason: msg,
        };
      }
      return {
        status: 'error',
        error: msg,
      };
    }
  }
}
