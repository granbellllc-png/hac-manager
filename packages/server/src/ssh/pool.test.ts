import { describe, expect, it, vi } from 'vitest';
import { SshPool } from './pool.js';
import { Semaphore } from './semaphore.js';

describe('SSH pool and channel limit lifecycle', () => {
  it('reuses one connection per host and closes removed and remaining connections', async () => {
    const pool = new SshPool();
    const first = pool.getOrCreate('fixture-one', { host: '192.0.2.1' });
    const second = pool.getOrCreate('fixture-two', { host: '192.0.2.2' });
    const firstClose = vi.spyOn(first, 'disconnect');
    const secondClose = vi.spyOn(second, 'disconnect');
    expect(pool.getOrCreate('fixture-one', { host: '192.0.2.1' })).toBe(first);
    expect(pool.get('fixture-one')).toBe(first);
    await pool.remove('fixture-one');
    expect(firstClose).toHaveBeenCalledOnce();
    expect(pool.get('fixture-one')).toBeUndefined();
    await pool.remove('absent');
    await pool.closeAll();
    expect(secondClose).toHaveBeenCalledOnce();
    expect(pool.get('fixture-two')).toBeUndefined();
  });

  it('rejects an invalid limit and makes releases idempotent for queued channels', async () => {
    expect(() => new Semaphore(0)).toThrow('at least 1');
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();
    const waiting = semaphore.acquire();
    expect(semaphore.waitingCount).toBe(1);
    release();
    release();
    const releaseNext = await waiting;
    expect(semaphore.activeCount).toBe(1);
    releaseNext();
    releaseNext();
    expect(semaphore.activeCount).toBe(0);
  });
});
