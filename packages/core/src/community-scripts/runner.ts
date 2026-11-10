/**
 * Supervised execution of pinned community scripts (D-41, ADR 0011).
 *
 * Core does not spawn processes or open pseudo-terminals itself: a
 * `ScriptProcessFactory` is injected by the server. The runner injects the
 * `var_*` environment expected by Proxmox VE helper scripts, answers known
 * prompts, pauses on unexpected ones, enforces a timeout, supports
 * cancellation, detects the created CTID and streams redacted log lines.
 */

import {
  globalSecretRedactor,
  type SecretRedactor,
} from '../redaction/index.js';
import type { Secret } from '../tags/secret.js';
import {
  ScriptPromptSession,
  ScriptPromptStateError,
  looksLikeScriptPrompt,
  stripAnsi,
  type PendingScriptPrompt,
} from './prompts.js';
import {
  COMMUNITY_SCRIPT_DEFAULT_TIMEOUT_MS,
  type CachedCommunityScript,
} from './types.js';

export interface ScriptProcessExit {
  readonly exitCode: number | null;
  readonly signal?: string | number | undefined;
}

/** A supervised pseudo-terminal process running one script. */
export interface ScriptProcess {
  write(data: string): void;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
  onData(listener: (chunk: string) => void): () => void;
  onExit(listener: (event: ScriptProcessExit) => void): () => void;
}

export interface ScriptSpawnOptions {
  /** Verified, cached script content. Must run from a private file or stdin. */
  readonly script: CachedCommunityScript;
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
}

/**
 * Starts scripts under a PTY. Implementations materialize the script outside
 * the data dir, never pipe a remote URL into a shell, and never parse an
 * interactive shell (see AGENTS.md rule 17).
 */
export interface ScriptProcessFactory {
  spawn(options: ScriptSpawnOptions): ScriptProcess | Promise<ScriptProcess>;
}

export class ScriptEnvironmentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ScriptEnvironmentError';
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface CommunityScriptGuest {
  readonly ctid: number;
  readonly hostname?: string | undefined;
  readonly unprivileged?: boolean | undefined;
  readonly cpu?: number | undefined;
  readonly ram?: number | undefined;
  readonly disk?: number | undefined;
  readonly bridge?: string | undefined;
  /** MAC address handed to the script as `var_net`. */
  readonly net?: string | undefined;
  readonly ssh?: boolean | undefined;
  readonly ostype?: string | undefined;
  readonly storage?: string | undefined;
  readonly extra?:
    Readonly<Record<string, string | number | boolean>> | undefined;
}

function scalar(name: string, value: string | number | boolean): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new ScriptEnvironmentError(
      `Script variable '${name}' is not finite.`,
    );
  }
  const text = String(value);
  if (text.includes('\u0000')) {
    throw new ScriptEnvironmentError(
      `Script variable '${name}' must not contain NUL bytes.`,
    );
  }
  return text;
}

/**
 * Build the environment consumed by Proxmox VE community scripts. `TERM` is
 * always `xterm`; booleans use the conventions those scripts expect
 * (`var_unprivileged=1`, `var_ssh=yes`).
 */
export function communityScriptEnv(
  guest: CommunityScriptGuest,
): Record<string, string> {
  if (!Number.isSafeInteger(guest.ctid) || guest.ctid < 100) {
    throw new ScriptEnvironmentError(
      `Community script CTID '${guest.ctid}' must be an integer of at least 100.`,
    );
  }
  const env: Record<string, string> = {
    TERM: 'xterm',
    var_ctid: String(guest.ctid),
  };
  if (guest.hostname !== undefined)
    env.var_hostname = scalar('hostname', guest.hostname);
  if (guest.unprivileged !== undefined) {
    env.var_unprivileged = guest.unprivileged ? '1' : '0';
  }
  if (guest.cpu !== undefined) env.var_cpu = scalar('cpu', guest.cpu);
  if (guest.ram !== undefined) env.var_ram = scalar('ram', guest.ram);
  if (guest.disk !== undefined) env.var_disk = scalar('disk', guest.disk);
  if (guest.bridge !== undefined) env.var_brg = scalar('bridge', guest.bridge);
  if (guest.net !== undefined) env.var_net = scalar('net', guest.net);
  if (guest.ssh !== undefined) env.var_ssh = guest.ssh ? 'yes' : 'no';
  if (guest.ostype !== undefined) env.var_os = scalar('ostype', guest.ostype);
  if (guest.storage !== undefined) {
    env.var_storage = scalar('storage', guest.storage);
  }
  for (const [name, value] of Object.entries(guest.extra ?? {})) {
    if (!ENV_NAME.test(name) || name === 'TERM') {
      throw new ScriptEnvironmentError(
        `Extra script variable '${name}' is not a valid environment name.`,
      );
    }
    env[name] = scalar(name, value);
  }
  return env;
}

export type CommunityScriptRunResult =
  | {
      readonly status: 'completed';
      readonly exitCode: 0;
      readonly ctid?: number | undefined;
      readonly logs: readonly string[];
    }
  | {
      readonly status: 'waiting_input';
      readonly prompt: PendingScriptPrompt;
      readonly logs: readonly string[];
    }
  | {
      readonly status: 'failed';
      readonly exitCode: number | null;
      readonly error: string;
      readonly logs: readonly string[];
    }
  | { readonly status: 'timed_out'; readonly logs: readonly string[] }
  | { readonly status: 'cancelled'; readonly logs: readonly string[] };

export interface CommunityScriptRunHandle {
  /** Resolves for the current phase, again after `answer` resumes a pause. */
  readonly done: Promise<CommunityScriptRunResult>;
  readonly logs: readonly string[];
  /** Answer the pending unexpected prompt and resume the script. */
  answer(answer: string): void;
  cancel(): void;
}

export interface CommunityScriptRunOptions {
  readonly script: CachedCommunityScript;
  readonly guest: CommunityScriptGuest;
  readonly processFactory: ScriptProcessFactory;
  readonly answers?: Readonly<Record<string, string>> | undefined;
  readonly env?:
    Readonly<Record<string, string | number | boolean>> | undefined;
  readonly redactor?: SecretRedactor | undefined;
  readonly secrets?: Iterable<string | Secret | undefined | null> | undefined;
  readonly onLine?: ((line: string) => void) | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly ctidPatterns?: readonly RegExp[] | undefined;
  readonly cols?: number | undefined;
  readonly rows?: number | undefined;
}

const DEFAULT_CTID_PATTERNS: readonly RegExp[] = [
  /\bCTID\s*[:=]\s*(\d{3,9})\b/i,
  /\b(?:container|CT)\s+ID\s*[:=]\s*(\d{3,9})\b/i,
  /\b(?:created|creating|starting)\s+(?:CT|container)\s+(\d{3,9})\b/i,
];

/** Extract the Proxmox CTID a script reports creating. */
export function detectCommunityScriptCtid(
  output: string,
  patterns: readonly RegExp[] = DEFAULT_CTID_PATTERNS,
): number | undefined {
  const plain = stripAnsi(output);
  for (const pattern of patterns) {
    const match = pattern.exec(plain);
    if (!match?.[1]) continue;
    const ctid = Number(match[1]);
    if (Number.isSafeInteger(ctid) && ctid >= 100 && ctid <= 999_999_999) {
      return ctid;
    }
  }
  return undefined;
}

class RunningCommunityScript implements CommunityScriptRunHandle {
  private readonly redactor: SecretRedactor;
  private readonly session: ScriptPromptSession;
  private readonly lines: string[] = [];
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly onAbort = (): void => {
    this.cancel();
  };

  private logBuffer = '';
  private output = '';
  private process: ScriptProcess | undefined;
  private exited: ScriptProcessExit | undefined;
  private pendingPrompt: PendingScriptPrompt | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private phase!: Promise<CommunityScriptRunResult>;
  private resolvePhase!: (result: CommunityScriptRunResult) => void;
  private phaseSettled = false;
  private timedOut = false;
  private cancelled = false;
  private ctid: number | undefined;

  public constructor(private readonly options: CommunityScriptRunOptions) {
    this.redactor = options.redactor ?? globalSecretRedactor;
    this.redactor.registerAll(options.secrets ?? []);
    this.timeoutMs = options.timeoutMs ?? COMMUNITY_SCRIPT_DEFAULT_TIMEOUT_MS;
    this.signal = options.signal;
    this.session = new ScriptPromptSession({
      answers: options.answers,
      redactor: this.redactor,
      idPrefix: `script-prompt-${options.guest.ctid}`,
      isPrompt: looksLikeScriptPrompt,
    });
    this.beginPhase();
    if (this.signal?.aborted) {
      this.cancel();
      return;
    }
    this.signal?.addEventListener('abort', this.onAbort, { once: true });
    void this.start();
  }

  public get done(): Promise<CommunityScriptRunResult> {
    return this.phase;
  }

  public get logs(): readonly string[] {
    return this.lines;
  }

  public answer(answer: string): void {
    if (this.cancelled || this.timedOut) {
      throw new ScriptPromptStateError(
        'The community script is no longer running.',
      );
    }
    if (!this.pendingPrompt) {
      throw new ScriptPromptStateError(
        'No community script prompt is pending.',
      );
    }
    const payload = this.session.respond(answer);
    this.pendingPrompt = undefined;
    if (this.exited) {
      this.beginPhase();
      this.settleTerminal(this.exited);
      return;
    }
    if (!this.process) {
      throw new ScriptPromptStateError('The community script is not running.');
    }
    this.process.write(payload);
    this.beginPhase();
    this.startTimer();
  }

  public cancel(): void {
    if (this.cancelled || this.timedOut) return;
    this.cancelled = true;
    this.clearTimer();
    this.process?.kill('SIGKILL');
    this.settle({ status: 'cancelled', logs: this.snapshot() });
  }

  private snapshot(): readonly string[] {
    return [...this.lines];
  }

  private beginPhase(): void {
    this.phaseSettled = false;
    this.phase = new Promise<CommunityScriptRunResult>((resolve) => {
      this.resolvePhase = resolve;
    });
  }

  private settle(result: CommunityScriptRunResult): void {
    if (this.phaseSettled) return;
    this.phaseSettled = true;
    this.clearTimer();
    if (result.status !== 'waiting_input') {
      this.signal?.removeEventListener('abort', this.onAbort);
    }
    this.resolvePhase(result);
  }

  private async start(): Promise<void> {
    let process: ScriptProcess;
    try {
      const env: Record<string, string> = {
        ...communityScriptEnv(this.options.guest),
      };
      for (const [name, value] of Object.entries(this.options.env ?? {})) {
        if (!ENV_NAME.test(name)) {
          throw new ScriptEnvironmentError(
            `Script variable '${name}' is not a valid environment name.`,
          );
        }
        env[name] = scalar(name, value);
      }
      env.TERM = 'xterm';
      process = await this.options.processFactory.spawn({
        script: this.options.script,
        env,
        cols: this.options.cols ?? 120,
        rows: this.options.rows ?? 40,
      });
    } catch (error) {
      this.settle({
        status: 'failed',
        exitCode: null,
        error: `Failed to start community script: ${
          error instanceof Error ? error.message : String(error)
        }`,
        logs: this.snapshot(),
      });
      return;
    }

    this.process = process;
    if (this.cancelled) {
      process.kill('SIGKILL');
      return;
    }
    process.onData((chunk) => {
      this.handleData(chunk);
    });
    process.onExit((event) => {
      this.handleExit(event);
    });
    this.startTimer();
  }

  private startTimer(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timedOut = true;
      this.process?.kill('SIGKILL');
      this.settle({ status: 'timed_out', logs: this.snapshot() });
    }, this.timeoutMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private handleData(chunk: string): void {
    this.output += chunk;
    this.consumeLog(stripAnsi(chunk));

    const feed = this.session.feed(chunk);
    this.ctid ??= detectCommunityScriptCtid(
      this.output,
      this.options.ctidPatterns,
    );
    for (const response of feed.answers) {
      this.process?.write(`${response}\n`);
    }
    if (feed.prompt) {
      this.pendingPrompt = feed.prompt;
      this.flushPartialLog();
      this.settle({
        status: 'waiting_input',
        prompt: feed.prompt,
        logs: this.snapshot(),
      });
    }
  }

  private handleExit(event: ScriptProcessExit): void {
    this.consumeLog(stripAnsi('\n'));
    this.exited = event;
    if (this.pendingPrompt) return;
    this.settleTerminal(event);
  }

  private settleTerminal(event: ScriptProcessExit): void {
    if (event.exitCode === 0) {
      this.ctid ??= detectCommunityScriptCtid(
        this.output,
        this.options.ctidPatterns,
      );
      this.settle({
        status: 'completed',
        exitCode: 0,
        ...(this.ctid !== undefined ? { ctid: this.ctid } : {}),
        logs: this.snapshot(),
      });
      return;
    }
    const suffix =
      event.signal !== undefined ? ` (signal ${String(event.signal)})` : '';
    this.settle({
      status: 'failed',
      exitCode: event.exitCode,
      error: `Community script exited with code ${String(event.exitCode)}${suffix}.`,
      logs: this.snapshot(),
    });
  }

  private consumeLog(text: string): void {
    this.logBuffer += text;
    let newline = this.logBuffer.indexOf('\n');
    while (newline >= 0) {
      this.emitLine(this.logBuffer.slice(0, newline));
      this.logBuffer = this.logBuffer.slice(newline + 1);
      newline = this.logBuffer.indexOf('\n');
    }
  }

  private flushPartialLog(): void {
    if (this.logBuffer.length === 0) return;
    const partial = this.logBuffer;
    this.logBuffer = '';
    this.emitLine(partial);
  }

  private emitLine(line: string): void {
    const safe = this.redactor.redactLine(line.replace(/\r$/, ''));
    if (safe.length === 0) return;
    this.lines.push(safe);
    try {
      this.options.onLine?.(safe);
    } catch {
      // A log sink must never abort the script under supervision.
    }
  }
}

/** Start a script under supervision; the returned handle can pause/resume. */
export function startCommunityScript(
  options: CommunityScriptRunOptions,
): CommunityScriptRunHandle {
  return new RunningCommunityScript(options);
}

/**
 * Run a script to a terminal state. Unexpected prompts are reported as
 * `waiting_input`; callers that need to pause durably should use
 * `startCommunityScript` and answer through the prompt service.
 */
export async function runCommunityScript(
  options: CommunityScriptRunOptions,
): Promise<CommunityScriptRunResult> {
  return startCommunityScript(options).done;
}
