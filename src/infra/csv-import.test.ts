import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runImport, SkipRow } from './csv-import.js';

test('runImport reports per-row success without letting one failure block the rest', async () => {
  const records = [{ name: 'Ahmed' }, { name: '' }, { name: 'Mona' }];
  const result = await runImport(records, [], async (record) => {
    if (!record.name) throw new Error('name is required');
    return { id: `id-${record.name}` };
  });
  assert.equal(result.total, 3);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.results.map((r) => r.status), ['created', 'error', 'created']);
  assert.equal(result.results[1]!.error, 'name is required');
});

test('runImport reports SkipRow as skipped, not failed', async () => {
  const records = [{ amount: '0' }, { amount: '100' }];
  const result = await runImport(records, [], async (record) => {
    if (record.amount === '0') throw new SkipRow('nothing to record');
    return { id: 'payment-1' };
  });
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.results[0]!.status, 'skipped');
  assert.equal(result.results[0]!.error, 'nothing to record');
});

test('runImport passes unsupportedColumns straight through', async () => {
  const result = await runImport([], ['Notes', 'Status'], async (r) => ({ id: 'x' }));
  assert.deepEqual(result.unsupportedColumns, ['Notes', 'Status']);
  assert.equal(result.total, 0);
});
