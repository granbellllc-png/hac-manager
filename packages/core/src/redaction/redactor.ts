import { Secret } from '../tags/secret.js';
import type { RedactorOptions } from './types.js';

export class SecretRedactor {
  private readonly secretSet = new Set<string>();
  private sortedSecrets: string[] = [];
  private dirty = false;
  private readonly minLength: number;
  private readonly mask: string;

  public constructor(options: RedactorOptions = {}) {
    this.minLength = options.minSecretLength ?? 3;
    this.mask = options.mask ?? '***';
  }

  public register(secret: string | Secret | undefined | null): void {
    if (!secret) return;
    const plain = secret instanceof Secret ? secret.unwrap() : secret;
    if (typeof plain === 'string' && plain.length >= this.minLength) {
      if (!this.secretSet.has(plain)) {
        this.secretSet.add(plain);
        this.dirty = true;
      }
    }
  }

  public registerAll(
    secrets: Iterable<string | Secret | undefined | null>,
  ): void {
    for (const s of secrets) {
      this.register(s);
    }
  }

  public unregister(secret: string | Secret): void {
    const plain = secret instanceof Secret ? secret.unwrap() : secret;
    if (this.secretSet.delete(plain)) {
      this.dirty = true;
    }
  }

  public clear(): void {
    this.secretSet.clear();
    this.sortedSecrets = [];
    this.dirty = false;
  }

  public get size(): number {
    return this.secretSet.size;
  }

  private ensureSorted(): void {
    if (this.dirty) {
      // Sort descending by length so longer substrings are matched first
      this.sortedSecrets = Array.from(this.secretSet).sort(
        (a, b) => b.length - a.length,
      );
      this.dirty = false;
    }
  }

  public redact(text: string): string {
    if (!text || this.secretSet.size === 0) return text;
    this.ensureSorted();

    let result = text;
    for (const secret of this.sortedSecrets) {
      if (result.includes(secret)) {
        result = result.replaceAll(secret, this.mask);
      }
    }
    return result;
  }

  public redactLine(line: string): string {
    return this.redact(line);
  }
}

/** Global redactor instance used across server logging, SSE, and audit */
export const globalSecretRedactor = new SecretRedactor();
