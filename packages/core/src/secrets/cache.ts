export interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export class SecretTtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly defaultTtlMs: number;

  public constructor(defaultTtlMs = 300_000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  public get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.value;
  }

  public set(key: string, value: T, ttlMs?: number): void {
    const duration = ttlMs ?? this.defaultTtlMs;
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + duration,
    });
  }

  public invalidate(key: string): boolean {
    return this.entries.delete(key);
  }

  public clear(): void {
    this.entries.clear();
  }

  public get size(): number {
    // Purge expired entries when inspecting size
    const now = Date.now();
    for (const [k, v] of this.entries.entries()) {
      if (now > v.expiresAt) {
        this.entries.delete(k);
      }
    }
    return this.entries.size;
  }
}
