import {
  TransportAbortedError,
  TransportFileNotFoundError,
  type ExecOptions,
  type ExecResult,
  type Transport,
} from './types.js';

export interface FakeResponse {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly timedOut?: boolean;
}

export type CommandMatcher =
  string | RegExp | ((argv: readonly string[]) => boolean);

export interface RecordedExec {
  readonly kind: 'exec';
  readonly argv: readonly string[];
  readonly options: ExecOptions | undefined;
}

export interface RecordedFileOp {
  readonly kind: 'readFile' | 'writeFile';
  readonly path: string;
}

export type RecordedCall = RecordedExec | RecordedFileOp;

interface Rule {
  readonly matcher: CommandMatcher;
  readonly response: FakeResponse;
  readonly once: boolean;
  used: boolean;
}

function matches(matcher: CommandMatcher, argv: readonly string[]): boolean {
  if (typeof matcher === 'string') return argv.join(' ') === matcher;
  if (matcher instanceof RegExp) return matcher.test(argv.join(' '));
  return matcher(argv);
}

/**
 * Deterministic Transport for tests. Responses are scripted; unmatched
 * commands fail loudly so tests never silently talk to a real host.
 */
export class FakeTransport implements Transport {
  public readonly calls: RecordedCall[] = [];
  private readonly rules: Rule[] = [];
  private readonly files = new Map<string, string>();

  /** Script a response. Later registrations take priority over earlier ones. */
  public onExec(
    matcher: CommandMatcher,
    response: FakeResponse,
    options: { readonly once?: boolean } = {},
  ): this {
    this.rules.unshift({
      matcher,
      response,
      once: options.once ?? false,
      used: false,
    });
    return this;
  }

  public setFile(path: string, content: string): this {
    this.files.set(path, content);
    return this;
  }

  public getFile(path: string): string | undefined {
    return this.files.get(path);
  }

  public exec(
    argv: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    this.calls.push({ kind: 'exec', argv, options });
    if (options?.signal?.aborted)
      return Promise.reject(new TransportAbortedError());
    const rule = this.rules.find(
      (r) => !(r.once && r.used) && matches(r.matcher, argv),
    );
    if (!rule) {
      return Promise.reject(
        new Error(`FakeTransport: no scripted response for: ${argv.join(' ')}`),
      );
    }
    rule.used = true;
    const result: ExecResult = {
      exitCode: rule.response.exitCode ?? 0,
      stdout: rule.response.stdout ?? '',
      stderr: rule.response.stderr ?? '',
      timedOut: rule.response.timedOut ?? false,
    };
    if (result.stdout) options?.onOutput?.('stdout', result.stdout);
    if (result.stderr) options?.onOutput?.('stderr', result.stderr);
    return Promise.resolve(result);
  }

  public readFile(
    path: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<string> {
    this.calls.push({ kind: 'readFile', path });
    if (options?.signal?.aborted)
      return Promise.reject(new TransportAbortedError());
    const content = this.files.get(path);
    if (content === undefined)
      return Promise.reject(new TransportFileNotFoundError(path));
    return Promise.resolve(content);
  }

  public writeFile(
    path: string,
    content: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    this.calls.push({ kind: 'writeFile', path });
    if (options?.signal?.aborted)
      return Promise.reject(new TransportAbortedError());
    this.files.set(path, content);
    return Promise.resolve();
  }

  /** Argv of every exec call, in order. */
  public get execArgv(): readonly (readonly string[])[] {
    return this.calls.flatMap((call) =>
      call.kind === 'exec' ? [call.argv] : [],
    );
  }

  public assertExecuted(matcher: CommandMatcher): void {
    if (!this.execArgv.some((argv) => matches(matcher, argv))) {
      throw new Error(
        `FakeTransport: expected command was not executed: ${String(matcher)}`,
      );
    }
  }

  /** Fails when any write or non-allowlisted exec happened; used to prove dry runs. */
  public assertNoMutations(readOnly: readonly CommandMatcher[] = []): void {
    for (const call of this.calls) {
      if (call.kind === 'writeFile') {
        throw new Error(`FakeTransport: unexpected write to ${call.path}`);
      }
      if (
        call.kind === 'exec' &&
        !readOnly.some((m) => matches(m, call.argv))
      ) {
        throw new Error(
          `FakeTransport: unexpected command: ${call.argv.join(' ')}`,
        );
      }
    }
  }
}
