export interface RedactorOptions {
  /**
   * Minimum secret length to track for string scanning (default: 3).
   * Prevents scrubbing common short strings like "a", "no", "1".
   */
  readonly minSecretLength?: number | undefined;
  /**
   * Replacement text (default: '***').
   */
  readonly mask?: string | undefined;
}

export interface DiffEntry<T = unknown> {
  readonly path: string;
  readonly before: T;
  readonly after: T;
  readonly type?: 'add' | 'remove' | 'change' | undefined;
}
