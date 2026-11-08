/** Result of a finished command. A non-zero exit code is data, not an exception. */
export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export type OutputStream = 'stdout' | 'stderr';

export interface ExecOptions {
  /** Script or data sent on stdin. Never build nested `bash -c '...'` strings (ADR 0012). */
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Streaming callback, invoked per chunk in order. */
  readonly onOutput?: (stream: OutputStream, chunk: string) => void;
}

/**
 * Remote execution and file access. Commands are passed as argv, never as a
 * shell string. Implementations: ssh2 pool (server), FakeTransport (tests).
 */
export interface Transport {
  exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult>;
  readFile(
    path: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<string>;
  writeFile(
    path: string,
    content: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
}

/** Raised when a transport operation is cancelled through its AbortSignal. */
export class TransportAbortedError extends Error {
  public constructor() {
    super('Transport operation aborted');
    this.name = 'TransportAbortedError';
  }
}

/** Raised when a file does not exist on the transport. */
export class TransportFileNotFoundError extends Error {
  public constructor(public readonly path: string) {
    super(`File not found: ${path}`);
    this.name = 'TransportFileNotFoundError';
  }
}
