export interface RateLimitEntry {
  count: number;
  firstAttemptAt: number;
  lockedUntil?: number;
}

export interface LoginRateLimiterOptions {
  /** Maximum allowed consecutive failures before lockout (default: 5) */
  readonly maxFailures?: number;
  /** Window for counting failures in milliseconds (default: 15 minutes) */
  readonly windowMs?: number;
  /** Lockout duration in milliseconds (default: 15 minutes) */
  readonly lockoutDurationMs?: number;
}

export class LoginRateLimiter {
  private readonly attempts = new Map<string, RateLimitEntry>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockoutDurationMs: number;

  constructor(options: LoginRateLimiterOptions = {}) {
    this.maxFailures = options.maxFailures ?? 5;
    this.windowMs = options.windowMs ?? 15 * 60 * 1000;
    this.lockoutDurationMs = options.lockoutDurationMs ?? 15 * 60 * 1000;
  }

  isLocked(key: string, now = Date.now()): boolean {
    const entry = this.attempts.get(key);
    if (!entry) return false;

    if (entry.lockedUntil && entry.lockedUntil > now) {
      return true;
    }

    // Lockout expired or window expired
    if (entry.lockedUntil && entry.lockedUntil <= now) {
      this.attempts.delete(key);
      return false;
    }

    if (now - entry.firstAttemptAt > this.windowMs) {
      this.attempts.delete(key);
      return false;
    }

    return false;
  }

  recordFailure(
    key: string,
    now = Date.now(),
  ): { locked: boolean; remaining: number } {
    let entry = this.attempts.get(key);
    if (!entry || now - entry.firstAttemptAt > this.windowMs) {
      entry = { count: 1, firstAttemptAt: now };
      this.attempts.set(key, entry);
      return { locked: false, remaining: this.maxFailures - 1 };
    }

    entry.count += 1;
    if (entry.count >= this.maxFailures) {
      entry.lockedUntil = now + this.lockoutDurationMs;
      return { locked: true, remaining: 0 };
    }

    return { locked: false, remaining: this.maxFailures - entry.count };
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }

  clear(): void {
    this.attempts.clear();
  }
}
