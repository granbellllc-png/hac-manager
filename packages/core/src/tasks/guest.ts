import type { ExecOptions, ExecResult, Transport } from '../transport/types.js';
import { TaskRunError } from './types.js';

export interface GuestTaskTarget {
  readonly type: 'lxc' | 'vm';
  readonly vmid: number;
}

export class GuestTaskTransportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GuestTaskTransportError';
  }
}

function assertTarget(target: GuestTaskTarget): void {
  if (target.type !== 'lxc' && target.type !== 'vm') {
    throw new GuestTaskTransportError(
      `Guest task transport requires 'lxc' or 'vm', received '${String(target.type)}'.`,
    );
  }
  if (!Number.isSafeInteger(target.vmid) || target.vmid < 1) {
    throw new GuestTaskTransportError(
      `VMID '${String(target.vmid)}' is not a positive integer.`,
    );
  }
}

interface AgentResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function parseAgentResult(stdout: string, vmid: number): AgentResult {
  const text = stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GuestTaskTransportError(
      `The QEMU guest agent response for VM ${vmid} was not JSON: ${text.slice(0, 200)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new GuestTaskTransportError(
      `The QEMU guest agent response for VM ${vmid} was not an object.`,
    );
  }
  const record = parsed as Record<string, unknown>;
  return {
    exitCode: typeof record['exitcode'] === 'number' ? record['exitcode'] : 0,
    stdout: typeof record['out-data'] === 'string' ? record['out-data'] : '',
    stderr: typeof record['err-data'] === 'string' ? record['err-data'] : '',
  };
}

/**
 * Adapt a host `Transport` so task commands run inside the guest (D-51).
 *
 * LXC uses `pct exec` with the script on stdin. VMs use the QEMU guest agent's
 * `qm guest exec --pass-stdin`, which supports a stdin payload without building
 * a nested `bash -c` string. The returned transport only implements `exec`:
 * file transfer is the job of the file-sync layer, not the task runner.
 */
export function createGuestTaskTransport(
  host: Transport,
  target: GuestTaskTarget,
): Transport {
  assertTarget(target);
  const { vmid, type } = target;

  return {
    async exec(
      argv: readonly string[],
      options?: ExecOptions,
    ): Promise<ExecResult> {
      if (type === 'lxc') {
        return host.exec(['pct', 'exec', String(vmid), '--', ...argv], options);
      }

      const command = [
        'qm',
        'guest',
        'exec',
        String(vmid),
        '--synchronous',
        '1',
        '--timeout',
        '0',
        ...(options?.stdin !== undefined ? ['--pass-stdin', '1'] : []),
        '--',
        ...argv,
      ];
      const hostOptions: ExecOptions | undefined =
        options === undefined
          ? undefined
          : {
              ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
              ...(options.timeoutMs !== undefined
                ? { timeoutMs: options.timeoutMs }
                : {}),
              ...(options.signal !== undefined
                ? { signal: options.signal }
                : {}),
            };
      const result = await host.exec(command, hostOptions);
      if (result.timedOut === true) {
        return {
          exitCode: result.exitCode,
          stdout: '',
          stderr: '',
          timedOut: true,
        };
      }
      if (result.exitCode !== 0) return result;
      const agent = parseAgentResult(result.stdout, vmid);
      if (agent.stdout.length > 0) options?.onOutput?.('stdout', agent.stdout);
      if (agent.stderr.length > 0) options?.onOutput?.('stderr', agent.stderr);
      return {
        exitCode: agent.exitCode,
        stdout: agent.stdout,
        stderr: agent.stderr,
        timedOut: false,
      };
    },

    readFile(): Promise<string> {
      return Promise.reject(
        new TaskRunError(
          'Guest task transports only support exec channels; use the file-sync layer for files.',
        ),
      );
    },

    writeFile(): Promise<void> {
      return Promise.reject(
        new TaskRunError(
          'Guest task transports only support exec channels; use the file-sync layer for files.',
        ),
      );
    },
  };
}
