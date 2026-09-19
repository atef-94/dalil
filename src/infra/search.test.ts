import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesQuery, searchFilter } from './search.js';

test('matchesQuery matches case-insensitively across the given fields', () => {
  const item = { fullName: 'Nadia CEO', email: 'ceo@demo.local', age: 40 };
  assert.equal(matchesQuery(item, ['fullName', 'email'], 'nadia'), true);
  assert.equal(matchesQuery(item, ['fullName', 'email'], 'CEO@DEMO'), true);
  assert.equal(matchesQuery(item, ['fullName', 'email'], 'nope'), false);
});

test('matchesQuery ignores non-string fields and an empty query matches everything', () => {
  const item = { fullName: 'Nadia', age: 40 };
  assert.equal(matchesQuery(item, ['age' as never], 'anything'), false);
  assert.equal(matchesQuery(item, ['fullName'], ''), true);
  assert.equal(matchesQuery(item, ['fullName'], '   '), true);
});

test('searchFilter passes items through unfiltered when no query is given', () => {
  const items = [{ fullName: 'A' }, { fullName: 'B' }];
  assert.deepEqual(searchFilter(items, ['fullName'], undefined), items);
  assert.deepEqual(searchFilter(items, ['fullName'], null), items);
  assert.deepEqual(searchFilter(items, ['fullName'], ''), items);
});

test('searchFilter narrows to matching items only', () => {
  const items = [{ fullName: 'Nadia CEO' }, { fullName: 'Omar Sales' }];
  const result = searchFilter(items, ['fullName'], 'omar');
  assert.equal(result.length, 1);
  assert.equal(result[0]!.fullName, 'Omar Sales');
});
