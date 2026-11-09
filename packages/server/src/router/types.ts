export interface ChannelHealth {
  readonly ok: boolean;
  readonly status: 'connected' | 'unreachable' | 'error' | 'not_configured';
  readonly latencyMs?: number | undefined;
  readonly error?: string | undefined;
  readonly lastCheckedAt?: string | undefined;
}

export interface TestConnectionResult {
  readonly ok: boolean;
  readonly ssh: ChannelHealth;
  readonly api?: ChannelHealth | undefined;
}

export class ChannelUnavailableError extends Error {
  public constructor(
    public readonly hostId: string,
    public readonly channel: 'ssh' | 'api',
    message?: string,
  ) {
    super(
      message ??
        `Operation requires '${channel}' channel, which is not configured or unavailable on host '${hostId}'.`,
    );
    this.name = 'ChannelUnavailableError';
  }
}
