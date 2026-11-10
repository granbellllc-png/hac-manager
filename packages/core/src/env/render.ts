import { hashContent } from '../data-dir/hash.js';
import { envFileSchema, type EnvFile } from '../schema/env.js';
import { resolveConfigTags } from '../tags/walk.js';
import { Secret } from '../tags/secret.js';
import type { ResolutionContext, TagResolutionReport } from '../tags/types.js';

/** Rendered `.env` files are readable and writable by their owner only. */
export const ENV_FILE_MODE = '0600' as const;

/** The host paths that may receive rendered `.env` content. */
export interface EnvFileRemoteState {
  /** SHA-256 of the `.env` currently present at the destination. */
  readonly hash?: string | undefined;
  /** Octal mode of the current file, for example `0600`. */
  readonly mode?: string | undefined;
}

/** A rendered `.env` file, safe to pass through plans, logs and SSE. */
export interface RenderedEnvFile {
  /**
   * The dotenv content wrapped in {@link Secret}. Serialization, logging and
   * interpolation all yield `***`; only the transfer executor may unwrap it.
   */
  readonly content: Secret;
  /** SHA-256 of the rendered bytes, used for change detection without plaintext. */
  readonly hash: string;
  readonly mode: typeof ENV_FILE_MODE;
  /** Variable names only. Values are never exposed through this list. */
  readonly variables: readonly string[];
  readonly size: number;
}

export class EnvRenderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'EnvRenderError';
  }
}

/**
 * Quote one value for a `.env` file read by Docker Compose and dotenv tools.
 *
 * Double quotes keep `#`, spaces, `=`, quotes and newlines in the value.
 * Compose interpolates double-quoted values, so `$` is written as `$$` (the
 * documented literal-dollar escape); single quotes are not used because
 * parsers disagree about `\'` (D-18).
 */
export function quoteEnvValue(value: string): string {
  let escaped = '';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x06 || (code >= 0x0e && code <= 0x1f) || code === 0x7f) {
      throw new EnvRenderError(
        'An environment value contains a control character that dotenv cannot represent.',
      );
    }
    switch (character) {
      case '\\':
        escaped += '\\\\';
        break;
      case '"':
        escaped += '\\"';
        break;
      case '$':
        escaped += '$$';
        break;
      case '\n':
        escaped += '\\n';
        break;
      case '\r':
        escaped += '\\r';
        break;
      case '\t':
        escaped += '\\t';
        break;
      case '\b':
        escaped += '\\b';
        break;
      case '\f':
        escaped += '\\f';
        break;
      case '\v':
        escaped += '\\v';
        break;
      case '\u0007':
        escaped += '\\a';
        break;
      default:
        escaped += character;
    }
  }
  return `"${escaped}"`;
}

/** Only a file literally named `.env` may receive rendered content. */
export function assertEnvRenderTarget(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  if (normalized !== '.env' && !normalized.endsWith('/.env')) {
    throw new EnvRenderError(
      `Rendered .env content may only target a file named '.env', received '${path}'. The tracked source is '.env.yaml'.`,
    );
  }
  return path;
}

function scalarText(value: unknown, name: string): string {
  if (value instanceof Secret) return value.unwrap();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  throw new EnvRenderError(
    `Variable '${name}' did not resolve to a scalar value.`,
  );
}

function resolutionDetails(report: TagResolutionReport): readonly string[] {
  return [
    ...report.unresolved.map(
      (item) => `!${item.tag} ${item.raw}: ${item.reason}`,
    ),
    ...report.locked.map((item) => `!${item.tag} ${item.raw}: ${item.reason}`),
    ...report.errors.map((item) => `!${item.tag} ${item.raw}: ${item.error}`),
  ];
}

function formatSchemaIssues(
  issues: readonly { readonly path: PropertyKey[]; readonly message: string }[],
): string {
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/**
 * Resolve `.env.yaml` tags, quote every value and hash the rendered bytes.
 *
 * The plaintext exists only inside the returned `Secret` (and transiently in
 * this function). Plans and logs receive the hash, mode, size and names, so a
 * rendered file cannot leak through serialization (D-15, D-18).
 */
export async function renderEnvFile(
  input: unknown,
  context: ResolutionContext,
): Promise<RenderedEnvFile> {
  const parsed = envFileSchema.safeParse(input);
  if (!parsed.success) {
    throw new EnvRenderError(
      `Invalid .env.yaml: ${formatSchemaIssues(parsed.error.issues)}`,
    );
  }

  const resolution = await resolveConfigTags<EnvFile>(parsed.data, context);
  if (!resolution.report.isFullyResolved) {
    throw new EnvRenderError(
      `Cannot render .env: ${resolutionDetails(resolution.report).join('; ')}`,
    );
  }

  const variables = Object.keys(resolution.data.values).sort();
  const lines = variables.map(
    (name) =>
      `${name}=${quoteEnvValue(
        scalarText(resolution.data.values[name], name),
      )}`,
  );
  const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`;

  return {
    content: new Secret(text),
    hash: await hashContent(text),
    mode: ENV_FILE_MODE,
    variables,
    size: new TextEncoder().encode(text).byteLength,
  };
}

/**
 * Compare a rendered file with the destination manifest. A changed hash or a
 * mode other than `0600` requires a new transfer; plaintext never enters the
 * comparison.
 */
export function isEnvFileOutdated(
  rendered: RenderedEnvFile,
  remote?: EnvFileRemoteState | null,
): boolean {
  const remoteMode = remote?.mode?.padStart(4, '0');
  return remote?.hash !== rendered.hash || remoteMode !== rendered.mode;
}
