import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseCsvRecords } from './csv.js';

test('parseCsv splits plain comma-separated rows', () => {
  const rows = parseCsv('a,b,c\n1,2,3\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('parseCsv handles quoted fields containing commas', () => {
  const rows = parseCsv('name,notes\nAhmed,"Prefers sea view, high floor"\n');
  assert.deepEqual(rows, [['name', 'notes'], ['Ahmed', 'Prefers sea view, high floor']]);
});

test('parseCsv handles escaped double quotes inside quoted fields', () => {
  const rows = parseCsv('name,quote\nOmar,"He said ""hello"" to me"\n');
  assert.deepEqual(rows[1], ['Omar', 'He said "hello" to me']);
});

test('parseCsv handles CRLF line endings', () => {
  const rows = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2'], ['3', '4']]);
});

test('parseCsv handles a file with no trailing newline', () => {
  const rows = parseCsv('a,b\n1,2');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2']]);
});

test('parseCsv skips fully blank lines', () => {
  const rows = parseCsv('a,b\n1,2\n\n3,4\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2'], ['3', '4']]);
});

test('parseCsvRecords keys each row by the header row', () => {
  const records = parseCsvRecords('Name,Phone\nAhmed,0501234567\nMona,0509876543\n');
  assert.deepEqual(records, [
    { Name: 'Ahmed', Phone: '0501234567' },
    { Name: 'Mona', Phone: '0509876543' },
  ]);
});

test('parseCsvRecords pads missing trailing columns with empty strings', () => {
  const records = parseCsvRecords('Name,Phone,Email\nAhmed,0501234567\n');
  assert.deepEqual(records, [{ Name: 'Ahmed', Phone: '0501234567', Email: '' }]);
});

test('parseCsvRecords returns an empty array for empty input', () => {
  assert.deepEqual(parseCsvRecords(''), []);
});
