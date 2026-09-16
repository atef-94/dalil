// A bounded-concurrency, in-process FIFO queue. Protects one Node process
// (same caveat as KeyedMutex — not a distributed queue) against a burst of
// callers each starting expensive work (e.g. workflow runs that call out to
// webhooks) from spawning unbounded concurrent work: once `maxConcurrent`
// jobs are running, further callers queue until a slot frees up.
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly maxConcurrent: number) {
    if (maxConcurrent < 1) throw new Error('maxConcurrent must be at least 1');
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiters.length;
  }
}
