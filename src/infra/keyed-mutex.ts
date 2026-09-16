// A per-key async mutex. Protects one Node process; does not protect
// multiple horizontally-scaled instances — that requires database-level
// locking (see prisma/schema.prisma comments).
export class KeyedMutex {
  private chains = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.chains.set(key, previous.then(() => next));

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
