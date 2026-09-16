import { DatabaseSync } from 'node:sqlite';
import type { Repository } from './repository.js';

/**
 * A real, on-disk database (SQLite via Node's built-in node:sqlite) backing
 * Repository<T>. Each entity type gets its own table of (id, data-as-JSON)
 * rows — a document-store shape rather than a fully normalized relational
 * schema, chosen so every module's existing code keeps working against the
 * same Repository<T> interface unchanged. Data survives process restarts,
 * writes are durable (SQLite fsyncs on commit), and the store is fully
 * queryable with ordinary SQL for operational debugging.
 *
 * This is a genuine upgrade from InMemoryRepository, not the eventual
 * Postgres/Prisma target described in prisma/schema.prisma — that migration
 * remains a repository-layer swap, same as before.
 */
export class SqliteRepository<T extends { id: string }> implements Repository<T> {
  constructor(
    private readonly db: DatabaseSync,
    private readonly table: string,
  ) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  }

  async findById(id: string): Promise<T | undefined> {
    const row = this.db.prepare(`SELECT data FROM "${this.table}" WHERE id = ?`).get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  async findAll(predicate?: (item: T) => boolean): Promise<T[]> {
    const rows = this.db.prepare(`SELECT data FROM "${this.table}"`).all() as { data: string }[];
    const items = rows.map((r) => JSON.parse(r.data) as T);
    return predicate ? items.filter(predicate) : items;
  }

  async save(item: T): Promise<T> {
    this.db
      .prepare(`INSERT INTO "${this.table}" (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`)
      .run(item.id, JSON.stringify(item));
    return item;
  }

  async deleteById(id: string): Promise<boolean> {
    const result = this.db.prepare(`DELETE FROM "${this.table}" WHERE id = ?`).run(id);
    return result.changes > 0;
  }
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}
