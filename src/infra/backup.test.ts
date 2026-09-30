import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, SqliteRepository } from './sqlite-repository.js';
import { runBackup, backupDir } from './backup.js';

interface Widget {
  id: string;
  name: string;
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'active-os-backup-test-'));
  return join(dir, 'test.db');
}

test('runBackup produces a restorable copy of the live database', async () => {
  const dbPath = tempDbPath();
  const db = openDatabase(dbPath);
  const repo = new SqliteRepository<Widget>(db, 'widgets');
  await repo.save({ id: 'w1', name: 'Widget One' });

  const destPath = await runBackup({ dbPath, db });
  assert.ok(existsSync(destPath));

  const restoredDb = openDatabase(destPath);
  const restoredRepo = new SqliteRepository<Widget>(restoredDb, 'widgets');
  const found = await restoredRepo.findById('w1');
  assert.equal(found?.name, 'Widget One');

  restoredDb.close();
  db.close();
  rmSync(join(dbPath, '..'), { recursive: true, force: true });
});

test('runBackup keeps writes made after the backup out of the snapshot', async () => {
  const dbPath = tempDbPath();
  const db = openDatabase(dbPath);
  const repo = new SqliteRepository<Widget>(db, 'widgets');
  await repo.save({ id: 'w1', name: 'Before backup' });

  const destPath = await runBackup({ dbPath, db });
  await repo.save({ id: 'w2', name: 'After backup' });

  const restoredDb = openDatabase(destPath);
  const restoredRepo = new SqliteRepository<Widget>(restoredDb, 'widgets');
  assert.ok(await restoredRepo.findById('w1'));
  assert.equal(await restoredRepo.findById('w2'), undefined);

  restoredDb.close();
  db.close();
  rmSync(join(dbPath, '..'), { recursive: true, force: true });
});

test('runBackup prunes older backups beyond retainCount', async () => {
  const dbPath = tempDbPath();
  const db = openDatabase(dbPath);
  const repo = new SqliteRepository<Widget>(db, 'widgets');
  await repo.save({ id: 'w1', name: 'Widget One' });

  for (let i = 0; i < 5; i++) {
    await runBackup({ dbPath, db, retainCount: 3 });
    // Force a distinct timestamp per backup filename.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const dir = backupDir(dbPath);
  const files = readdirSync(dir).filter((f) => f.endsWith('.db'));
  assert.equal(files.length, 3);

  db.close();
  rmSync(join(dbPath, '..'), { recursive: true, force: true });
});
