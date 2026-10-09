// Repository<T> is deliberately shaped to match what a Prisma-backed
// repository would expose, so that swapping in Prisma later is a
// repository-layer replacement, not a service-layer rewrite.
export interface Repository<T extends { id: string }> {
  findById(id: string): Promise<T | undefined>;
  /** `companyId` is optional, additive defense-in-depth (see
   * SqliteRepository's own doc comment on its findAll) — existing callers
   * that omit it see no change in behavior. */
  findAll(predicate?: (item: T) => boolean, companyId?: string): Promise<T[]>;
  save(item: T): Promise<T>;
  deleteById(id: string): Promise<boolean>;
}

// Map-backed store. Data does not survive a process restart.
export class InMemoryRepository<T extends { id: string }> implements Repository<T> {
  private store = new Map<string, T>();

  async findById(id: string): Promise<T | undefined> {
    return this.store.get(id);
  }

  async findAll(predicate?: (item: T) => boolean, companyId?: string): Promise<T[]> {
    let all = Array.from(this.store.values());
    if (companyId) all = all.filter((item) => (item as Record<string, unknown>).companyId === companyId);
    return predicate ? all.filter(predicate) : all;
  }

  async save(item: T): Promise<T> {
    this.store.set(item.id, item);
    return item;
  }

  async deleteById(id: string): Promise<boolean> {
    return this.store.delete(id);
  }
}
