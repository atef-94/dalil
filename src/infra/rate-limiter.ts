// IP-based sliding-window rate limiter. Per-key isolation, prunes stale
// windows so memory does not grow unbounded.
export class SlidingWindowRateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly maxHits: number,
  ) {}

  consume(key: string, now = Date.now()): { allowed: boolean; remaining: number } {
    const windowStart = now - this.windowMs;
    const existing = (this.hits.get(key) ?? []).filter((t) => t > windowStart);

    if (existing.length >= this.maxHits) {
      this.hits.set(key, existing);
      return { allowed: false, remaining: 0 };
    }

    existing.push(now);
    this.hits.set(key, existing);
    return { allowed: true, remaining: this.maxHits - existing.length };
  }

  prune(now = Date.now()): void {
    const windowStart = now - this.windowMs;
    for (const [key, hits] of this.hits.entries()) {
      const kept = hits.filter((t) => t > windowStart);
      if (kept.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, kept);
      }
    }
  }
}
