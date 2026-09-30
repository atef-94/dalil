import { backup } from 'node:sqlite';
import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Same-volume, application-level SQLite backups via node:sqlite's online
 * backup API (safe under WAL/concurrent writes, unlike a raw file copy).
 * This protects against corruption or an accidental bad write, NOT against
 * loss of the volume itself — the backups live right next to the primary
 * database. True disaster recovery (volume loss, region outage) needs
 * Railway's own volume-backup feature or an off-site upload target, neither
 * of which this module attempts.
 */

export interface RunBackupOptions {
  dbPath: string;
  db: DatabaseSync;
  retainCount?: number;
}

export function backupDir(dbPath: string): string {
  return join(dirname(dbPath), 'backups');
}

export async function runBackup(options: RunBackupOptions): Promise<string> {
  const { dbPath, db, retainCount = 7 } = options;
  const dir = backupDir(dbPath);
  mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destPath = join(dir, `active-os-${timestamp}.db`);
  await backup(db, destPath);
  pruneOldBackups(dir, retainCount);
  return destPath;
}

function pruneOldBackups(dir: string, retainCount: number): void {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({ name: f, mtimeMs: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of files.slice(retainCount)) {
    unlinkSync(join(dir, file.name));
  }
}
