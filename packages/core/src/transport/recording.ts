import type { ExecOptions, ExecResult, Transport } from './types.js';

export interface RecordedExecution {
  readonly argv: readonly string[];
  readonly stdin: string | undefined;
  readonly result: ExecResult;
}

export type Sanitizer = (text: string) => string;

/**
 * Wraps a real Transport and captures command output so it can be turned into
 * fixtures. Output passes through `sanitize` (secrets, real hostnames, IPs)
 * before it is stored; never commit unsanitised recordings (ADR 0012).
 */
export class RecordingTransport implements Transport {
  private readonly recorded: RecordedExecution[] = [];

  public constructor(
    private readonly inner: Transport,
    private readonly sanitize: Sanitizer,
  ) {}

  public get executions(): readonly RecordedExecution[] {
    return this.recorded;
  }

  public async exec(
    argv: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    const result = await this.inner.exec(argv, options);
    this.recorded.push({
      argv: argv.map((part) => this.sanitize(part)),
      stdin:
        options?.stdin === undefined ? undefined : this.sanitize(options.stdin),
      result: {
        ...result,
        stdout: this.sanitize(result.stdout),
        stderr: this.sanitize(result.stderr),
      },
    });
    return result;
  }

  public readFile(
    path: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<string> {
    return this.inner.readFile(path, options);
  }

  public writeFile(
    path: string,
    content: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    return this.inner.writeFile(path, content, options);
  }
}
