import { describe, expect, it } from 'vitest';
import { Semaphore } from './semaphore.js';

describe('Semaphore', () => {
  it('bounds concurrency and respects FIFO release order', async () => {
    const sem = new Semaphore(2);
    expect(sem.activeCount).toBe(0);

    const rel1 = await sem.acquire();
    expect(sem.activeCount).toBe(1);

    const rel2 = await sem.acquire();
    expect(sem.activeCount).toBe(2);

    let acquired3 = false;
    const p3 = sem.acquire().then((rel) => {
      acquired3 = true;
      return rel;
    });

    expect(sem.waitingCount).toBe(1);
    expect(acquired3).toBe(false);

    rel1();
    const rel3 = await p3;
    expect(acquired3).toBe(true);
    expect(sem.activeCount).toBe(2);
    expect(sem.waitingCount).toBe(0);

    rel2();
    rel3();
    expect(sem.activeCount).toBe(0);
  });
});
