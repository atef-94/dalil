import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { InMemoryRepository } from '../../infra/repository.js';
import { ImportSessionService } from './import-session.service.js';
import type { ImportSession } from '../../domain/types.js';
import type { ImportFieldDef } from '../../infra/field-mapping.js';

const LEAD_FIELDS: ImportFieldDef[] = [
  { key: 'fullName', label: 'Full Name', aliases: ['name'] },
  { key: 'phone', label: 'Phone', aliases: ['mobile'] },
  { key: 'email', label: 'Email' },
];

const INVENTORY_LIKE_FIELDS: ImportFieldDef[] = [
  { key: 'projectName', label: 'Project', aliases: ['project name', 'compound'], required: true },
  { key: 'unitType', label: 'Unit Type', aliases: ['type'], required: true },
  { key: 'areaSqmFrom', label: 'Area (sqm) — From', aliases: ['area from', 'bua from'] },
];

function service() {
  return new ImportSessionService(new InMemoryRepository<ImportSession>());
}

test('createSession parses a CSV upload and suggests a mapping', async () => {
  const svc = service();
  const csv = Buffer.from('Full Name,Mobile,Email\nAhmed Ali,0100000000,ahmed@example.com\n');
  const session = await svc.createSession({
    companyId: 'c1',
    createdByUserId: 'u1',
    targetType: 'lead',
    fileName: 'leads.csv',
    fileBuffer: csv,
    contentType: 'text/csv',
    fields: LEAD_FIELDS,
  });
  assert.equal(session.fileType, 'csv');
  assert.equal(session.status, 'uploaded');
  assert.deepEqual(session.detectedColumns, ['Full Name', 'Mobile', 'Email']);
  assert.deepEqual(session.suggestedMapping, { 'Full Name': 'fullName', Mobile: 'phone', Email: 'email' });
  assert.equal(session.rawRows.length, 1);
  assert.equal(session.rawRows[0]!['Full Name'], 'Ahmed Ali');
});

test('createSession parses a real .xlsx upload the same way as CSV', async () => {
  const svc = service();
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Leads');
  sheet.addRow(['Name', 'Phone', 'Email']);
  sheet.addRow(['Sara Youssef', '0111111111', 'sara@example.com']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());

  const session = await svc.createSession({
    companyId: 'c1',
    createdByUserId: 'u1',
    targetType: 'lead',
    fileName: 'leads.xlsx',
    fileBuffer: buf,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fields: LEAD_FIELDS,
  });
  assert.equal(session.fileType, 'xlsx');
  assert.deepEqual(session.suggestedMapping, { Name: 'fullName', Phone: 'phone', Email: 'email' });
});

test('createSession rejects an unsupported file extension', async () => {
  const svc = service();
  await assert.rejects(
    () =>
      svc.createSession({
        companyId: 'c1',
        createdByUserId: 'u1',
        targetType: 'lead',
        fileName: 'leads.docx',
        fileBuffer: Buffer.from('irrelevant'),
        contentType: 'application/msword',
        fields: LEAD_FIELDS,
      }),
    /unsupported file/,
  );
});

test('createSession rejects a file with no detectable header row', async () => {
  const svc = service();
  await assert.rejects(
    () =>
      svc.createSession({
        companyId: 'c1',
        createdByUserId: 'u1',
        targetType: 'lead',
        fileName: 'empty.csv',
        fileBuffer: Buffer.from(''),
        contentType: 'text/csv',
        fields: LEAD_FIELDS,
      }),
    /could not detect any columns/,
  );
});

test('getSession enforces tenant isolation', async () => {
  const svc = service();
  const session = await svc.createSession({
    companyId: 'c1',
    createdByUserId: 'u1',
    targetType: 'lead',
    fileName: 'leads.csv',
    fileBuffer: Buffer.from('Full Name\nAhmed\n'),
    contentType: 'text/csv',
    fields: LEAD_FIELDS,
  });
  await assert.rejects(() => svc.getSession(session.id, 'c2'), /not found/);
  const same = await svc.getSession(session.id, 'c1');
  assert.equal(same.id, session.id);
});

test('confirmMapping stores the user-corrected mapping and advances status', async () => {
  const svc = service();
  const session = await svc.createSession({
    companyId: 'c1',
    createdByUserId: 'u1',
    targetType: 'lead',
    fileName: 'leads.csv',
    fileBuffer: Buffer.from('Client,Cell\nAhmed Ali,0100000000\n'),
    contentType: 'text/csv',
    fields: LEAD_FIELDS,
  });
  // "Client"/"Cell" don't match anything automatically.
  assert.deepEqual(session.suggestedMapping, { Client: null, Cell: null });

  const mapped = await svc.confirmMapping(session.id, 'c1', { Client: 'fullName', Cell: 'phone' });
  assert.equal(mapped.status, 'mapped');
  assert.deepEqual(mapped.confirmedMapping, { Client: 'fullName', Cell: 'phone' });

  const rows = svc.mapRows(mapped);
  assert.deepEqual(rows, [{ fullName: 'Ahmed Ali', phone: '0100000000' }]);
});

test('mapRows falls back to the suggested mapping before confirmation', async () => {
  const svc = service();
  const session = await svc.createSession({
    companyId: 'c1',
    createdByUserId: 'u1',
    targetType: 'lead',
    fileName: 'leads.csv',
    fileBuffer: Buffer.from('Full Name,Phone\nAhmed,0100000000\n'),
    contentType: 'text/csv',
    fields: LEAD_FIELDS,
  });
  const rows = svc.mapRows(session);
  assert.deepEqual(rows, [{ fullName: 'Ahmed', phone: '0100000000' }]);
});

test('markConfirmed advances status to confirmed', async () => {
  const svc = service();
  const session = await svc.createSession({
    companyId: 'c1',
    createdByUserId: 'u1',
    targetType: 'lead',
    fileName: 'leads.csv',
    fileBuffer: Buffer.from('Full Name\nAhmed\n'),
    contentType: 'text/csv',
    fields: LEAD_FIELDS,
  });
  const confirmed = await svc.markConfirmed(session.id, 'c1');
  assert.equal(confirmed.status, 'confirmed');
});

// ---- Multi-sheet import: a real broker/developer portfolio export
// commonly puts one project per worksheet tab (e.g. "Stayn", "Connect4")
// instead of one flat table with a Project column. sheetNameAsColumn is the
// opt-in option that reads every sheet and injects the sheet's own name into
// the given column for any row that doesn't already carry a real value
// there — confirmed against a real 7-sheet user file. ----

test('createSession with sheetNameAsColumn merges every sheet, injecting the sheet name as the Project for rows missing it', async () => {
  const svc = service();
  const wb = new ExcelJS.Workbook();
  const stayn = wb.addWorksheet('Stayn');
  stayn.addRow(['Unit Type', 'Area (sqm) — From']);
  stayn.addRow(['Apartment', '150']);
  const connect4 = wb.addWorksheet('Connect4');
  connect4.addRow(['Unit Type', 'Area (sqm) — From']);
  connect4.addRow(['Duplex', '220']);
  connect4.addRow(['Villa', '300']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());

  const session = await svc.createSession({
    companyId: 'c1',
    createdByUserId: 'u1',
    targetType: 'inventory_unit',
    fileName: 'portfolio.xlsx',
    fileBuffer: buf,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fields: INVENTORY_LIKE_FIELDS,
    sheetNameAsColumn: 'Project',
  });

  assert.equal(session.rawRows.length, 3);
  assert.ok(session.detectedColumns.includes('Project'));
  assert.deepEqual(
    session.rawRows.map((r) => r.Project),
    ['Stayn', 'Connect4', 'Connect4'],
  );
  assert.equal(session.rawRows[0]!['Unit Type'], 'Apartment');
  assert.equal(session.rawRows[1]!['Unit Type'], 'Duplex');
});

test('createSession with sheetNameAsColumn leaves a row alone when it already has a real value in that column', async () => {
  const svc = service();
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Stayn');
  sheet.addRow(['Project', 'Unit Type']);
  sheet.addRow(['Stayn Phase 2', 'Apartment']); // explicit Project column, should win over the sheet name
  sheet.addRow(['', 'Duplex']); // blank Project, should fall back to sheet name
  const buf = Buffer.from(await wb.xlsx.writeBuffer());

  const session = await svc.createSession({
    companyId: 'c1',
    createdByUserId: 'u1',
    targetType: 'inventory_unit',
    fileName: 'portfolio.xlsx',
    fileBuffer: buf,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fields: INVENTORY_LIKE_FIELDS,
    sheetNameAsColumn: 'Project',
  });

  assert.deepEqual(
    session.rawRows.map((r) => r.Project),
    ['Stayn Phase 2', 'Stayn'],
  );
});

test('createSession without sheetNameAsColumn only reads the first sheet (unchanged default behavior)', async () => {
  const svc = service();
  const wb = new ExcelJS.Workbook();
  const stayn = wb.addWorksheet('Stayn');
  stayn.addRow(['Unit Type']);
  stayn.addRow(['Apartment']);
  const connect4 = wb.addWorksheet('Connect4');
  connect4.addRow(['Unit Type']);
  connect4.addRow(['Duplex']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());

  const session = await svc.createSession({
    companyId: 'c1',
    createdByUserId: 'u1',
    targetType: 'inventory_unit',
    fileName: 'portfolio.xlsx',
    fileBuffer: buf,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fields: INVENTORY_LIKE_FIELDS,
  });

  assert.equal(session.rawRows.length, 1);
  assert.equal(session.rawRows[0]!['Unit Type'], 'Apartment');
});
