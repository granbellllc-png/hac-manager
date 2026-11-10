/**
 * Prompt supervision for community scripts (D-41).
 *
 * Community scripts ask questions over a pseudo-terminal. Configured answers
 * are matched by pattern; any other prompt pauses the job for the user instead
 * of guessing. Terminal control sequences are stripped before matching or
 * showing the question, and the question passes through the secret redactor.
 */

import { SecretRedactor, globalSecretRedactor } from '../redaction/index.js';

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/** Remove ANSI/VT100 control sequences and normalize carriage returns. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '').replace(/\r/g, '\n');
}

const PROMPT_ENDING = /[:?]\s*$/;
const DEFAULT_HINT =
  /(?:\[(?:y\/n|Y\/n|y\/N|yes\/no|Enter[^\]]*)\]|\((?:y\/n|Y\/n|y\/N|yes\/no)\)|press\s+(?:enter|any key)[^]*)$/i;
const LOG_PREFIX = /^\[(?:info|warn|warning|error|debug|ok|done)\]/i;

/**
 * Heuristic: the last visible line asks for input when it ends with a colon or
 * question mark, or shows a bracketed default (`[y/N]`, `[Enter]`). Plain log
 * lines such as `[INFO] downloading` do not match.
 */
export function looksLikeScriptPrompt(text: string): boolean {
  const line = lastVisibleLine(text);
  if (line.length === 0) return false;
  if (LOG_PREFIX.test(line)) return false;
  return PROMPT_ENDING.test(line) || DEFAULT_HINT.test(line);
}

function lastVisibleLine(text: string): string {
  const normalized = stripAnsi(text);
  const lines = normalized.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trimEnd() ?? '';
    if (line.trim().length > 0) return line.trimStart();
  }
  return '';
}

/** The last visible line of terminal output, ANSI sequencing removed. */
export function lastScriptOutputLine(text: string): string {
  return lastVisibleLine(text);
}

export interface ScriptAnswerMatch {
  readonly pattern: string;
  readonly response: string;
}

/**
 * Match a question against the configured answers. Keys are regular
 * expressions; a key that is not a valid expression is compared literally, so
 * a typo degrades to an exact match instead of failing the run.
 */
export function matchScriptAnswer(
  question: string,
  answers: Readonly<Record<string, string>> | undefined,
): ScriptAnswerMatch | undefined {
  if (!answers) return undefined;
  for (const [pattern, response] of Object.entries(answers)) {
    if (pattern.length === 0) continue;
    let matches: boolean;
    try {
      matches = new RegExp(pattern, 'i').test(question);
    } catch {
      matches = question.toLowerCase().includes(pattern.toLowerCase());
    }
    if (matches) return { pattern, response };
  }
  return undefined;
}

export interface PendingScriptPrompt {
  /** Stable identifier, suitable as a durable job prompt id. */
  readonly id: string;
  /** Redacted question shown in the UI. */
  readonly question: string;
}

export interface ScriptPromptSessionOptions {
  readonly answers?: Readonly<Record<string, string>> | undefined;
  readonly redactor?: SecretRedactor | undefined;
  readonly idPrefix?: string | undefined;
  readonly isPrompt?: ((text: string) => boolean) | undefined;
}

export interface ScriptPromptFeedResult {
  /** Responses to write back to the script, in order. */
  readonly answers: readonly string[];
  /** Set when the script asked something no configured answer covers. */
  readonly prompt?: PendingScriptPrompt | undefined;
}

/**
 * Stateful prompt matcher for one running script. Feed terminal chunks; the
 * session either returns the answer for a known prompt or pauses on an
 * unexpected one. `respond` resumes a paused session with a user answer.
 */
export class ScriptPromptSession {
  private readonly answers: Readonly<Record<string, string>> | undefined;
  private readonly redactor: SecretRedactor;
  private readonly idPrefix: string;
  private readonly isPrompt: (text: string) => boolean;
  private buffer = '';
  private currentPrompt: PendingScriptPrompt | undefined;
  private counter = 0;

  public constructor(options: ScriptPromptSessionOptions = {}) {
    this.answers = options.answers;
    this.redactor = options.redactor ?? globalSecretRedactor;
    this.idPrefix = options.idPrefix ?? 'script-prompt';
    this.isPrompt = options.isPrompt ?? looksLikeScriptPrompt;
  }

  public get waiting(): PendingScriptPrompt | undefined {
    return this.currentPrompt;
  }

  public feed(chunk: string): ScriptPromptFeedResult {
    this.buffer += chunk;
    if (this.currentPrompt) return { answers: [] };
    if (!this.isPrompt(this.buffer)) return { answers: [] };

    const question = lastVisibleLine(this.buffer);
    const match = matchScriptAnswer(question, this.answers);
    if (!match) {
      this.counter += 1;
      this.currentPrompt = {
        id: `${this.idPrefix}-${this.counter}`,
        question: this.redactor.redactLine(question),
      };
      return { answers: [], prompt: this.currentPrompt };
    }

    this.buffer = '';
    return { answers: [match.response] };
  }

  /** Answer the pending prompt and return the bytes to write to the PTY. */
  public respond(answer: string): string {
    if (!this.currentPrompt) {
      throw new ScriptPromptStateError(
        'No community script prompt is pending.',
      );
    }
    this.currentPrompt = undefined;
    this.buffer = '';
    return `${answer}\n`;
  }
}

export class ScriptPromptStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ScriptPromptStateError';
  }
}
