import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseXlsx } from './xlsx-parser.js';
import type { ImportFieldDef } from './field-mapping.js';

const INVENTORY_LIKE_FIELDS: ImportFieldDef[] = [
  { key: 'projectName', label: 'Project', aliases: ['project name', 'compound', 'اسم المشروع'], required: true },
  { key: 'unitType', label: 'Unit Type', aliases: ['type', 'نوع الوحدة'], required: true },
  { key: 'areaSqmFrom', label: 'Area (sqm) — From', aliases: ['area from', 'bua from', 'size from'] },
  { key: 'areaSqmTo', label: 'Area (sqm) — To', aliases: ['area to', 'bua to', 'size to'] },
  { key: 'listPriceFrom', label: 'List Price — From', aliases: ['price from', 'total price from'] },
  { key: 'listPriceTo', label: 'List Price — To', aliases: ['price to', 'total price to'] },
];

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

// ---- Bug fix: a developer price-list export with a banner/title row above
// the real header row (a merged "Project Name" caption repeated across
// every column by exceljs's merged-cell read-back) was being read as if
// that banner text were the column headers — nothing matched any known
// field alias, every column showed "— Do not import —", and the whole
// file appeared to silently fail to import. parseXlsx now auto-detects the
// real header row when given a field dictionary. ----

test('without a field dictionary, parseXlsx still always uses row 1 (unchanged default behavior)', async () => {
  const buf = await buildWorkbook([
    ['Sheikh Zayed - الشيخ زايد', 'Sheikh Zayed - الشيخ زايد', 'Sheikh Zayed - الشيخ زايد'],
    ['Project', 'Unit Type', 'BUA From'],
    ['Zed Towers', 'Apartment', '150'],
  ]);
  const { headers } = await parseXlsx(buf);
  assert.deepEqual(headers, ['Sheikh Zayed - الشيخ زايد', 'Sheikh Zayed - الشيخ زايد', 'Sheikh Zayed - الشيخ زايد']);
});

test('parseXlsx skips a banner row above the real headers when a field dictionary is given', async () => {
  const buf = await buildWorkbook([
    ['Sheikh Zayed - الشيخ زايد', 'Sheikh Zayed - الشيخ زايد', 'Sheikh Zayed - الشيخ زايد', 'Sheikh Zayed - الشيخ زايد'],
    ['Project', 'Unit Type', 'BUA From', 'BUA To'],
    ['Zed Towers', 'Apartment', '150', '180'],
    ['Zed Towers', 'Duplex', '220', '260'],
  ]);
  const { headers, rows } = await parseXlsx(buf, INVENTORY_LIKE_FIELDS);
  assert.deepEqual(headers, ['Project', 'Unit Type', 'BUA From', 'BUA To']);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { Project: 'Zed Towers', 'Unit Type': 'Apartment', 'BUA From': '150', 'BUA To': '180' });
  assert.deepEqual(rows[1], { Project: 'Zed Towers', 'Unit Type': 'Duplex', 'BUA From': '220', 'BUA To': '260' });
});

test('parseXlsx skips multiple banner rows (title + blank-ish caption) above the real headers', async () => {
  const buf = await buildWorkbook([
    ['Residential Projects - West Cairo', '', '', ''],
    ['Generated on 2026-09-22', '', '', ''],
    ['Project', 'Unit Type', 'BUA From', 'BUA To'],
    ['Zed Towers', 'Apartment', '150', '180'],
  ]);
  const { headers, rows } = await parseXlsx(buf, INVENTORY_LIKE_FIELDS);
  assert.deepEqual(headers, ['Project', 'Unit Type', 'BUA From', 'BUA To']);
  assert.equal(rows.length, 1);
});

test('parseXlsx keeps using row 1 when it is already the best-scoring header row (no regression for well-formed files)', async () => {
  const buf = await buildWorkbook([
    ['Project', 'Unit Type', 'BUA From', 'BUA To'],
    ['Zed Towers', 'Apartment', '150', '180'],
  ]);
  const { headers, rows } = await parseXlsx(buf, INVENTORY_LIKE_FIELDS);
  assert.deepEqual(headers, ['Project', 'Unit Type', 'BUA From', 'BUA To']);
  assert.equal(rows.length, 1);
});

test('parseXlsx falls back to row 1 when no row scores higher (an unrecognized header row is not guessed at)', async () => {
  const buf = await buildWorkbook([
    ['Column Alpha', 'Column Beta', 'Column Gamma'],
    ['Widget Foo', 'Widget Bar', 'Widget Baz'],
  ]);
  const { headers } = await parseXlsx(buf, INVENTORY_LIKE_FIELDS);
  assert.deepEqual(headers, ['Column Alpha', 'Column Beta', 'Column Gamma']);
});

// ---- Crash fix: a row with a genuinely untouched cell (never given a
// value or style) reads back from exceljs as a real sparse-array hole, not
// an empty string. sheet.addRow([...]) above always writes every cell, so
// it never reproduces this — a real developer export can and does leave
// cells like that. detectHeaderRowIndex runs suggestMapping's `for...of`
// loop directly over each candidate row, which (unlike .map/.forEach)
// visits holes and yields `undefined` for them, crashing the first
// .replace() call inside normalizeHeader. This actually happened importing
// a real production file once the header-auto-detection above shipped. ----

test('parseXlsx does not crash on a row with a genuinely untouched (sparse) cell', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  const header = sheet.getRow(1);
  header.getCell(1).value = 'Project';
  // Cell 2 is deliberately never touched — a real hole, not ''.
  header.getCell(3).value = 'Unit Type';
  header.commit();
  const dataRow = sheet.getRow(2);
  dataRow.getCell(1).value = 'Zed Towers';
  dataRow.getCell(3).value = 'Apartment';
  dataRow.commit();
  const buf = Buffer.from(await workbook.xlsx.writeBuffer());

  const { headers, rows } = await parseXlsx(buf, INVENTORY_LIKE_FIELDS);
  assert.deepEqual(headers, ['Project', 'Unit Type']);
  assert.equal(rows.length, 1);
});
