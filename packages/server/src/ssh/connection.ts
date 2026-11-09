import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { Client, type SFTPWrapper } from 'ssh2';
import {
  TransportAbortedError,
  TransportFileNotFoundError,
  type ExecOptions,
  type ExecResult,
} from '@hacm/core';
import { Semaphore } from './semaphore.js';
import {
  HostKeyMismatchError,
  SshConnectionLostError,
  type SshConnectionState,
  type SshHostConfig,
  type SshTransport,
} from './types.js';

export function escapePosixArg(arg: string): string {
  if (arg.length === 0) return "''";
  if (/^[a-zA-Z0-9_\-./=:@]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function normalizeFingerprint(fp: string): string {
  return fp
    .trim()
    .replace(/^SHA256:/i, '')
    .replace(/=+$/, '');
}

interface PendingCommand {
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

export class SshConnection extends EventEmitter implements SshTransport {
  public state: SshConnectionState = 'disconnected';
  public lastFingerprint?: string | undefined;
  private client: Client | undefined;
  private sftpWrapper: SFTPWrapper | undefined;
  private readonly semaphore: Semaphore;
  private pinnedFingerprint: string | undefined;
  private manualDisconnect = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelayMs = 500;
  private readonly pendingCommands = new Set<PendingCommand>();
  private verificationError: HostKeyMismatchError | undefined;

  public constructor(
    public readonly hostId: string,
    public readonly config: SshHostConfig,
  ) {
    super();
    this.semaphore = new Semaphore(config.maxSessions ?? 10);
    this.pinnedFingerprint = config.fingerprint;
  }

  public retrustHostKey(newFingerprint?: string): void {
    this.pinnedFingerprint = newFingerprint ?? this.lastFingerprint;
    this.verificationError = undefined;
  }

  public async connect(): Promise<void> {
    if (this.state === 'connected' && this.client) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.manualDisconnect = false;
    this.verificationError = undefined;
    this.setState('connecting');

    return new Promise<void>((resolve, reject) => {
      const client = new Client();
      let connected = false;

      const cleanupListeners = () => {
        client.removeListener('ready', onReady);
        client.removeListener('error', onError);
        client.removeListener('close', onClose);
      };

      const onReady = () => {
        connected = true;
        this.client = client;
        this.setState('connected');
        this.reconnectDelayMs = 500;
        resolve();
      };

      const onError = (err: Error) => {
        if (!connected) {
          cleanupListeners();
          client.end();
          this.setState('error');
          if (this.verificationError) {
            reject(this.verificationError);
          } else {
            reject(err);
          }
        } else {
          this.handleDisconnect(err.message);
        }
      };

      const onClose = () => {
        if (!connected) {
          cleanupListeners();
          this.setState('disconnected');
          if (this.verificationError) {
            reject(this.verificationError);
          } else {
            reject(new Error('Connection closed before ready'));
          }
        } else {
          this.handleDisconnect('Connection closed by remote');
        }
      };

      client.on('ready', onReady);
      client.on('error', onError);
      client.on('close', onClose);

      const connectConfig: Record<string, unknown> = {
        host: this.config.host,
        port: this.config.port ?? 22,
        username: this.config.username ?? 'root',
        keepaliveInterval: this.config.keepaliveIntervalMs ?? 15000,
        readyTimeout: this.config.readyTimeoutMs ?? 10000,
        hostVerifier: (hashedOrKey: Buffer | string) => {
          let fp: string;
          if (Buffer.isBuffer(hashedOrKey)) {
            const hash = createHash('sha256')
              .update(hashedOrKey)
              .digest('base64');
            fp = `SHA256:${hash.replace(/=+$/, '')}`;
          } else {
            fp = String(hashedOrKey);
          }
          this.lastFingerprint = fp;

          if (this.pinnedFingerprint) {
            const expected = normalizeFingerprint(this.pinnedFingerprint);
            const actual = normalizeFingerprint(fp);
            if (expected !== actual) {
              this.verificationError = new HostKeyMismatchError(
                this.config.host,
                this.pinnedFingerprint,
                fp,
              );
              return false;
            }
          }
          return true;
        },
      };

      if (this.config.privateKey) {
        connectConfig.privateKey = this.config.privateKey;
      }
      if (this.config.password) {
        connectConfig.password = this.config.password;
      }

      try {
        client.connect(connectConfig);
      } catch (err) {
        cleanupListeners();
        this.setState('error');
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  public async disconnect(): Promise<void> {
    this.manualDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.sftpWrapper = undefined;
    if (this.client) {
      this.client.end();
      this.client = undefined;
    }
    this.setState('disconnected');
    this.failPendingCommands(
      new SshConnectionLostError(
        this.hostId,
        'SSH client disconnected manually',
      ),
    );
  }

  public async exec(
    argv: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    if (options?.signal?.aborted) {
      throw new TransportAbortedError();
    }

    if (this.state !== 'connected' || !this.client) {
      await this.connect();
    }

    const releaseSemaphore = await this.semaphore.acquire();

    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let timeoutTimer: NodeJS.Timeout | undefined = undefined;

      const cleanup = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = undefined;
        }
        if (options?.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
        this.pendingCommands.delete(pending);
        releaseSemaphore();
      };

      const safeResolve = (res: ExecResult) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(res);
        }
      };

      const safeReject = (err: Error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      };

      const pending: PendingCommand = {
        reject: safeReject,
        cleanup,
      };
      this.pendingCommands.add(pending);

      const onAbort = () => {
        safeReject(new TransportAbortedError());
      };

      if (options?.signal) {
        options.signal.addEventListener('abort', onAbort);
      }

      if (options?.timeoutMs && options.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          safeResolve({
            exitCode: -1,
            stdout: stdoutAcc,
            stderr: stderrAcc + '\nCommand timed out',
            timedOut: true,
          });
        }, options.timeoutMs);
      }

      let stdoutAcc = '';
      let stderrAcc = '';

      const cmdString = argv.map(escapePosixArg).join(' ');

      this.client!.exec(cmdString, (err, stream) => {
        if (err) {
          return safeReject(err);
        }

        if (options?.stdin !== undefined) {
          stream.write(options.stdin);
        }
        stream.end();

        stream.on('data', (chunk: Buffer) => {
          const str = chunk.toString('utf8');
          stdoutAcc += str;
          options?.onOutput?.('stdout', str);
        });

        stream.stderr.on('data', (chunk: Buffer) => {
          const str = chunk.toString('utf8');
          stderrAcc += str;
          options?.onOutput?.('stderr', str);
        });

        stream.on('close', (code: number) => {
          safeResolve({
            exitCode: typeof code === 'number' ? code : 0,
            stdout: stdoutAcc,
            stderr: stderrAcc,
            timedOut,
          });
        });
      });
    });
  }

  private async getSftp(): Promise<SFTPWrapper> {
    if (this.sftpWrapper) return this.sftpWrapper;
    if (this.state !== 'connected' || !this.client) {
      await this.connect();
    }

    return new Promise<SFTPWrapper>((resolve, reject) => {
      this.client!.sftp((err, sftp) => {
        if (err) {
          return reject(err);
        }
        this.sftpWrapper = sftp;
        resolve(sftp);
      });
    });
  }

  public async readFile(
    path: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<string> {
    if (options?.signal?.aborted) {
      throw new TransportAbortedError();
    }
    const sftp = await this.getSftp();

    return new Promise<string>((resolve, reject) => {
      sftp.stat(path, (statErr) => {
        if (statErr) {
          return reject(new TransportFileNotFoundError(path));
        }

        const chunks: Buffer[] = [];
        const stream = sftp.createReadStream(path);

        const onAbort = () => {
          stream.destroy();
          reject(new TransportAbortedError());
        };

        if (options?.signal) {
          options.signal.addEventListener('abort', onAbort);
        }

        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('error', (err: Error) => {
          if (options?.signal) {
            options.signal.removeEventListener('abort', onAbort);
          }
          reject(err);
        });
        stream.on('end', () => {
          if (options?.signal) {
            options.signal.removeEventListener('abort', onAbort);
          }
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
      });
    });
  }

  public async writeFile(
    path: string,
    content: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    if (options?.signal?.aborted) {
      throw new TransportAbortedError();
    }
    const sftp = await this.getSftp();

    return new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(path);

      let finished = false;
      const safeResolve = () => {
        if (!finished) {
          finished = true;
          if (options?.signal) {
            options.signal.removeEventListener('abort', onAbort);
          }
          resolve();
        }
      };

      const onAbort = () => {
        stream.destroy();
        reject(new TransportAbortedError());
      };

      if (options?.signal) {
        options.signal.addEventListener('abort', onAbort);
      }

      stream.on('error', (err: Error) => {
        if (!finished) {
          finished = true;
          if (options?.signal) {
            options.signal.removeEventListener('abort', onAbort);
          }
          reject(err);
        }
      });
      stream.on('finish', safeResolve);
      stream.on('close', safeResolve);

      stream.end(content, 'utf8');
    });
  }

  private handleDisconnect(reason: string): void {
    this.sftpWrapper = undefined;
    this.client = undefined;
    this.setState('disconnected');
    this.failPendingCommands(new SshConnectionLostError(this.hostId, reason));

    if (!this.manualDisconnect) {
      this.scheduleReconnect();
    }
  }

  private failPendingCommands(err: Error): void {
    const list = [...this.pendingCommands];
    this.pendingCommands.clear();
    for (const cmd of list) {
      cmd.reject(err);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 10000);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => {
        // Ignored; handleDisconnect will trigger next backoff if still failing
      });
    }, delay);
  }

  private setState(newState: SshConnectionState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.emit('stateChange', newState);
    }
  }
}
