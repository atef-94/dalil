import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseXlsx } from './xlsx-parser.js';

async function buildWorkbook(rows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  for (const row of rows) sheet.addRow(row);
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf);
}

test('parseXlsx reads headers and rows from a real workbook buffer', async () => {
  const buf = await buildWorkbook([
    ['Full Name', 'Phone Number', 'Email'],
    ['Ahmed Ali', '0100000000', 'ahmed@example.com'],
    ['Sara Youssef', '0111111111', ''],
  ]);
  const { headers, rows } = await parseXlsx(buf);
  assert.deepEqual(headers, ['Full Name', 'Phone Number', 'Email']);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { 'Full Name': 'Ahmed Ali', 'Phone Number': '0100000000', Email: 'ahmed@example.com' });
  assert.deepEqual(rows[1], { 'Full Name': 'Sara Youssef', 'Phone Number': '0111111111', Email: '' });
});

test('parseXlsx skips fully blank rows', async () => {
  const buf = await buildWorkbook([
    ['Name', 'Budget'],
    ['Ahmed', '1500000'],
    ['', ''],
    ['Sara', '2000000'],
  ]);
  const { rows } = await parseXlsx(buf);
  assert.equal(rows.length, 2);
});

test('parseXlsx converts numeric cells to strings', async () => {
  const buf = await buildWorkbook([
    ['Name', 'Budget'],
    ['Ahmed', 1500000],
  ]);
  const { rows } = await parseXlsx(buf);
  assert.equal(rows[0]!.Budget, '1500000');
});

test('parseXlsx throws a clear ValidationError for a non-Excel file', async () => {
  await assert.rejects(() => parseXlsx(Buffer.from('this is not an xlsx file')), /could not read this file as an Excel workbook/);
});

test('parseXlsx returns empty headers/rows for a workbook with only an empty sheet', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Empty');
  const buf = Buffer.from(await workbook.xlsx.writeBuffer());
  const { headers, rows } = await parseXlsx(buf);
  assert.deepEqual(headers, []);
  assert.deepEqual(rows, []);
});
