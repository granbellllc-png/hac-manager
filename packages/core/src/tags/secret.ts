// Synchronous lightweight string hash for comparison without crypto promises
function simpleHash(val: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < val.length; i++) {
    const ch = val.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0))
    .toString(16)
    .padStart(16, '0');
}

/**
 * Wraps sensitive credentials so they are never leaked in logs, diffs,
 * errors, or JSON serialization.
 *
 * Invariant 1 (AGENTS.md):
 * "Never log, persist, diff or audit a resolved secret. Secrets are wrapped
 * in a Secret type that serialises as ***. Compare secret fields by hash."
 */
export class Secret {
  readonly #value: string;
  readonly #hash: string;

  public constructor(value: string) {
    if (typeof value !== 'string') {
      throw new TypeError(
        `Secret value must be a string, received ${typeof value}`,
      );
    }
    this.#value = value;
    this.#hash = simpleHash(value);
  }

  /**
   * Unwraps the plaintext secret. Only privileged remote transport executors
   * or authenticators should ever call this method.
   */
  public unwrap(): string {
    return this.#value;
  }

  /**
   * Comparison hash used to diff or match secret fields without exposing plaintext.
   */
  public get hash(): string {
    return this.#hash;
  }

  /**
   * Compares equality with another Secret by hash.
   */
  public equals(other: unknown): boolean {
    if (other instanceof Secret) {
      return this.#hash === other.#hash && this.#value === other.#value;
    }
    return false;
  }

  /**
   * JSON serialization guarantees mask.
   */
  public toJSON(): string {
    return '***';
  }

  /**
   * String conversion guarantees mask.
   */
  public toString(): string {
    return '***';
  }

  /**
   * Node.js custom inspection format guarantees mask.
   */
  public [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[Secret: ***]';
  }
}
