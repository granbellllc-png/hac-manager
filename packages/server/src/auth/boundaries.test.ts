import { describe, expect, it } from 'vitest';
import { LoginRateLimiter } from './rate-limit.js';
import { verifyPassword } from './password.js';
import { checkPermission } from './policy.js';

describe('authentication failure boundaries', () => {
  it('rejects malformed password hashes without leaking a native exception', async () => {
    expect(await verifyPassword('not-an-argon2-hash', 'fixture-password')).toBe(
      false,
    );
  });

  it('rejects unknown roles even for otherwise readable resources', async () => {
    expect(
      await checkPermission(
        {
          id: 'fixture',
          username: 'fixture',
          role: 'unknown',
          autoGrantNewHosts: false,
        },
        { action: 'read_resource' },
      ),
    ).toMatchObject({ allowed: false });
  });

  it('resets expired windows, expired lockouts, successful logins and explicit clears', () => {
    const limiter = new LoginRateLimiter({
      maxFailures: 3,
      windowMs: 10,
      lockoutDurationMs: 20,
    });
    expect(limiter.isLocked('fixture', 0)).toBe(false);
    expect(limiter.recordFailure('fixture', 0)).toEqual({
      locked: false,
      remaining: 2,
    });
    expect(limiter.isLocked('fixture', 5)).toBe(false);
    expect(limiter.recordFailure('fixture', 1)).toEqual({
      locked: false,
      remaining: 1,
    });
    expect(limiter.recordFailure('fixture', 2)).toEqual({
      locked: true,
      remaining: 0,
    });
    expect(limiter.isLocked('fixture', 21)).toBe(true);
    expect(limiter.isLocked('fixture', 22)).toBe(false);
    limiter.recordFailure('fixture', 30);
    expect(limiter.isLocked('fixture', 41)).toBe(false);
    limiter.recordFailure('fixture', 50);
    expect(limiter.recordFailure('fixture', 61).remaining).toBe(2);
    limiter.recordSuccess('fixture');
    expect(limiter.isLocked('fixture')).toBe(false);
    limiter.recordFailure('fixture');
    limiter.clear();
    expect(limiter.isLocked('fixture')).toBe(false);
  });

  it('locks immediately when configured to allow only one failure', () => {
    const limiter = new LoginRateLimiter({ maxFailures: 1 });
    expect(limiter.recordFailure('fixture')).toEqual({
      locked: true,
      remaining: 0,
    });
    expect(limiter.isLocked('fixture')).toBe(true);
  });
});
