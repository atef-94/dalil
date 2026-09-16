import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, SqliteRepository } from './sqlite-repository.js';

interface Widget {
  id: string;
  name: string;
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'active-os-test-'));
  return join(dir, 'test.db');
}

test('save then findById returns the same record', async () => {
  const path = tempDbPath();
  const db = openDatabase(path);
  const repo = new SqliteRepository<Widget>(db, 'widgets');
  await repo.save({ id: 'w1', name: 'Widget One' });
  const found = await repo.findById('w1');
  assert.equal(found?.name, 'Widget One');
  db.close();
  rmSync(path, { force: true });
});

test('save with an existing id overwrites rather than duplicates', async () => {
  const path = tempDbPath();
  const db = openDatabase(path);
  const repo = new SqliteRepository<Widget>(db, 'widgets');
  await repo.save({ id: 'w1', name: 'First' });
  await repo.save({ id: 'w1', name: 'Second' });
  const all = await repo.findAll();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.name, 'Second');
  db.close();
  rmSync(path, { force: true });
});

test('findAll applies the given predicate', async () => {
  const path = tempDbPath();
  const db = openDatabase(path);
  const repo = new SqliteRepository<Widget>(db, 'widgets');
  await repo.save({ id: 'w1', name: 'Alpha' });
  await repo.save({ id: 'w2', name: 'Beta' });
  const filtered = await repo.findAll((w) => w.name === 'Beta');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.id, 'w2');
  db.close();
  rmSync(path, { force: true });
});

test('deleteById removes the row and reports success', async () => {
  const path = tempDbPath();
  const db = openDatabase(path);
  const repo = new SqliteRepository<Widget>(db, 'widgets');
  await repo.save({ id: 'w1', name: 'Alpha' });
  const deleted = await repo.deleteById('w1');
  assert.equal(deleted, true);
  assert.equal(await repo.findById('w1'), undefined);
  db.close();
  rmSync(path, { force: true });
});

test('deleteById on a missing id returns false', async () => {
  const path = tempDbPath();
  const db = openDatabase(path);
  const repo = new SqliteRepository<Widget>(db, 'widgets');
  const deleted = await repo.deleteById('nonexistent');
  assert.equal(deleted, false);
  db.close();
  rmSync(path, { force: true });
});

test('data survives closing and reopening the same database file (real persistence)', async () => {
  const path = tempDbPath();
  const db1 = openDatabase(path);
  const repo1 = new SqliteRepository<Widget>(db1, 'widgets');
  await repo1.save({ id: 'w1', name: 'Persisted Widget' });
  db1.close();

  const db2 = openDatabase(path);
  const repo2 = new SqliteRepository<Widget>(db2, 'widgets');
  const found = await repo2.findById('w1');
  assert.equal(found?.name, 'Persisted Widget');
  db2.close();
  rmSync(path, { force: true });
});
