import type { Transport } from '@hacm/core';

export type SshConnectionState =
  'disconnected' | 'connecting' | 'connected' | 'error';

export interface SshHostConfig {
  readonly host: string;
  readonly port?: number | undefined;
  readonly username?: string | undefined;
  readonly privateKey?: string | Buffer | undefined;
  readonly password?: string | undefined;
  readonly fingerprint?: string | undefined;
  readonly maxSessions?: number | undefined;
  readonly keepaliveIntervalMs?: number | undefined;
  readonly readyTimeoutMs?: number | undefined;
}

export interface SshTransport extends Transport {
  readonly hostId: string;
  readonly state: SshConnectionState;
  readonly lastFingerprint?: string | undefined;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  retrustHostKey(newFingerprint?: string): void;
}

export class HostKeyMismatchError extends Error {
  public constructor(
    public readonly host: string,
    public readonly expectedFingerprint: string,
    public readonly actualFingerprint: string,
  ) {
    super(
      `Host key verification failed for ${host}: expected '${expectedFingerprint}', got '${actualFingerprint}'. Connection blocked until re-trusted (D-24).`,
    );
    this.name = 'HostKeyMismatchError';
  }
}

export class SshConnectionLostError extends Error {
  public constructor(
    public readonly host: string,
    message = 'SSH connection lost',
  ) {
    super(`${message} (host: ${host})`);
    this.name = 'SshConnectionLostError';
  }
}
