import { randomUUID } from 'node:crypto';
import { globalSecretRedactor } from '@hacm/core';
import type { DatabaseRepositories } from '../db/repositories/types.js';
import type { ConnectionManager } from '../router/manager.js';
import type { InteractiveShell } from '../ssh/types.js';
import type {
  ConsoleClientMessage,
  ConsoleSessionContext,
  ConsoleSocket,
} from './types.js';

const MAX_INPUT_BYTES = 64 * 1024;
const MIN_COLS = 20;
const MAX_COLS = 500;
const MIN_ROWS = 5;
const MAX_ROWS = 200;

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function parseClientMessage(value: string): ConsoleClientMessage | undefined {
  if (Buffer.byteLength(value, 'utf8') > MAX_INPUT_BYTES) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed['type'] === 'input' && typeof parsed['data'] === 'string') {
      if (Buffer.byteLength(parsed['data'], 'utf8') > MAX_INPUT_BYTES) {
        return undefined;
      }
      return { type: 'input', data: parsed['data'] };
    }
    if (parsed['type'] === 'resize') {
      const cols = boundedInteger(parsed['cols'], MIN_COLS, MAX_COLS);
      const rows = boundedInteger(parsed['rows'], MIN_ROWS, MAX_ROWS);
      return cols && rows ? { type: 'resize', cols, rows } : undefined;
    }
    if (parsed['type'] === 'ping') return { type: 'ping' };
  } catch {
    return undefined;
  }
  return undefined;
}

function send(socket: ConsoleSocket, value: unknown): void {
  try {
    socket.send(JSON.stringify(value));
  } catch {
    // The peer may have closed between the event and the write.
  }
}

export interface ConsoleServiceOptions {
  readonly idleTimeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
}

export class ConsoleService {
  private readonly idleTimeoutMs: number;
  private readonly now: () => Date;
  private readonly onError: (error: unknown) => void;

  public constructor(
    private readonly connections: Pick<ConnectionManager, 'getRouter'>,
    private readonly repos: DatabaseRepositories,
    options: ConsoleServiceOptions = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 15 * 60_000;
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => undefined);
  }

  public async open(
    socket: ConsoleSocket,
    context: ConsoleSessionContext,
  ): Promise<void> {
    const sessionId = randomUUID();
    const startedAt = this.now();
    let shell: InteractiveShell | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let inputBytes = 0;
    let outputBytes = 0;
    const startAuditPromise = this.repos.auditLogs.append({
      userId: context.user.id,
      username: context.user.username,
      hostId: context.request.hostId,
      vmid: context.request.vmid ?? null,
      action: 'console.start',
      reason: 'manual',
      diff: {
        sessionId,
        target: context.request.target,
      },
      metadata: {
        cols: context.request.cols,
        rows: context.request.rows,
        recording: context.request.recording,
        transcriptStorage: 'browser_memory_only',
      },
      createdAt: startedAt,
    });
    const settle = (reason: string, error?: unknown) => {
      void finish(reason, error).catch(this.onError);
    };

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        send(socket, { type: 'idle_timeout' });
        socket.close(1000, 'Console idle timeout');
        settle('idle_timeout');
      }, this.idleTimeoutMs);
    };

    const finish = async (reason: string, error?: unknown) => {
      if (finished) return;
      finished = true;
      if (idleTimer) clearTimeout(idleTimer);
      shell?.removeAllListeners();
      shell?.close();
      const finishedAt = this.now();
      await startAuditPromise;
      await this.repos.auditLogs.append({
        userId: context.user.id,
        username: context.user.username,
        hostId: context.request.hostId,
        vmid: context.request.vmid ?? null,
        action: 'console.stop',
        reason: 'manual',
        diff: {
          sessionId,
          target: context.request.target,
          reason,
        },
        metadata: {
          durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
          inputBytes,
          outputBytes,
          recording: context.request.recording,
          ...(error
            ? {
                error: globalSecretRedactor.redact(
                  error instanceof Error ? error.message : String(error),
                ),
              }
            : {}),
        },
        createdAt: finishedAt,
      });
    };

    socket.onClose(() => settle('client_closed'));
    socket.onError((error) => settle('websocket_error', error));

    await startAuditPromise;

    try {
      const router = await this.connections.getRouter(context.request.hostId);
      shell = await router.openConsole({
        target: context.request.target,
        ...(context.request.vmid !== undefined
          ? { vmid: context.request.vmid }
          : {}),
        cols: context.request.cols,
        rows: context.request.rows,
        term: 'xterm-256color',
      });
      if (finished) {
        shell.close();
        return;
      }
      shell.on('data', (chunk: Buffer) => {
        const data = chunk.toString('utf8');
        outputBytes += Buffer.byteLength(data, 'utf8');
        send(socket, { type: 'output', data });
      });
      shell.on(
        'exit',
        (status: {
          code?: number | undefined;
          signal?: string | undefined;
        }) => {
          send(socket, { type: 'exit', ...status });
          settle('shell_exit');
        },
      );
      shell.on('error', (error: Error) => {
        send(socket, {
          type: 'error',
          message: globalSecretRedactor.redact(error.message),
        });
        settle('shell_error', error);
      });
      socket.onMessage((raw) => {
        const message = parseClientMessage(raw);
        if (!message) {
          send(socket, { type: 'error', message: 'Invalid console message' });
          return;
        }
        resetIdle();
        if (message.type === 'input') {
          inputBytes += Buffer.byteLength(message.data, 'utf8');
          shell?.write(message.data);
        } else if (message.type === 'resize') {
          shell?.resize(message.cols, message.rows);
        } else {
          send(socket, { type: 'pong' });
        }
      });
      send(socket, {
        type: 'ready',
        sessionId,
        target: context.request.target,
        idleTimeoutMs: this.idleTimeoutMs,
      });
      resetIdle();
    } catch (error) {
      send(socket, {
        type: 'error',
        message: globalSecretRedactor.redact(
          error instanceof Error ? error.message : String(error),
        ),
      });
      socket.close(1011, 'Console unavailable');
      await finish('open_failed', error);
    }
  }
}

export const consoleServiceInternals = {
  parseClientMessage,
  boundedInteger,
};
