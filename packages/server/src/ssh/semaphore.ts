export class Semaphore {
  private current = 0;
  private readonly queue: Array<() => void> = [];

  public constructor(public readonly max: number) {
    if (max < 1) {
      throw new Error(`Semaphore max must be at least 1, got ${max}`);
    }
  }

  public async acquire(): Promise<() => void> {
    if (this.current < this.max) {
      this.current++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          this.release();
        }
      };
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        let released = false;
        resolve(() => {
          if (!released) {
            released = true;
            this.release();
          }
        });
      });
    });
  }

  private release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    } else {
      this.current = Math.max(0, this.current - 1);
    }
  }

  public get activeCount(): number {
    return this.current;
  }

  public get waitingCount(): number {
    return this.queue.length;
  }
}
