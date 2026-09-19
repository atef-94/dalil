import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { buildApplication } from './app.js';

async function freshApp() {
  return buildApplication({ nodeEnv: 'test', tokenSecret: 'test-secret', allowedOrigins: [], seed: true });
}

async function withServer(run: (base: string, app: Awaited<ReturnType<typeof freshApp>>) => Promise<void>) {
  const app = await freshApp();
  const server = app.httpServer.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`, app);
  } finally {
    await app.httpServer.close();
  }
}

async function callJson(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function uploadFile(base: string, path: string, filename: string, contentType: string, data: Buffer, headers: Record<string, string> = {}) {
  const form = new FormData();
  form.set('file', new Blob([data], { type: contentType }), filename);
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: form });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

function buildPdf(lines: { text: string; x: number; y: number }[]): Buffer {
  const escape = (s: string) => s.replace(/[()\\]/g, (m) => '\\' + m);
  const content = lines.map((l) => `BT /F1 10 Tf ${l.x} ${l.y} Td (${escape(l.text)}) Tj ET`).join('\n');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>\nendobj',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj',
    `5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj + '\n';
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

test('full Inventory Import HTTP flow: real CSV upload -> preview -> confirm creates real units', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const companyId = app.seedResult!.companyId;
    const project = await app.services.inventory.createProject({ companyId, name: `Inv Import Project ${Date.now()}` });

    const csv = Buffer.from(
      `Project,Unit Code,Unit Type,Area (sqm),List Price\n` +
        `${project.name},A-201,apartment,120,1500000\n` +
        `${project.name},,villa,,\n`, // invalid: missing unit code/area/price
    );
    const upload = await uploadFile(base, '/api/inventory/units/import/upload', 'units.csv', 'text/csv', csv, headers);
    assert.equal(upload.status, 200);
    const uploadBody = upload.body as { sessionId: string; suggestedMapping: Record<string, string | null> };
    assert.deepEqual(uploadBody.suggestedMapping, { Project: 'projectName', 'Unit Code': 'unitCode', 'Unit Type': 'unitType', 'Area (sqm)': 'areaSqm', 'List Price': 'listPrice' });

    const preview = await callJson(base, 'POST', `/api/inventory/units/import/${uploadBody.sessionId}/preview`, { mapping: uploadBody.suggestedMapping }, headers);
    assert.equal(preview.status, 200);
    const previewBody = preview.body as { totalRows: number; validCount: number; invalidCount: number };
    assert.equal(previewBody.totalRows, 2);
    assert.equal(previewBody.validCount, 1);
    assert.equal(previewBody.invalidCount, 1);

    const confirm = await callJson(base, 'POST', `/api/inventory/units/import/${uploadBody.sessionId}/confirm`, {}, headers);
    assert.equal(confirm.status, 200);
    const confirmBody = confirm.body as { succeeded: number; skipped: number };
    assert.equal(confirmBody.succeeded, 1);
    assert.equal(confirmBody.skipped, 1);

    const units = await app.repos.units.findAll((u) => u.companyId === companyId && u.projectId === project.id);
    assert.equal(units.length, 1);
    assert.equal(units[0]!.code, 'A-201');
  });
});

test('full Inventory Import HTTP flow: real .xlsx upload protects a SOLD unit from being overwritten', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const companyId = app.seedResult!.companyId;
    const project = await app.services.inventory.createProject({ companyId, name: `Inv Import Project ${Date.now()}` });
    const soldUnit = await app.services.inventory.createUnit({ companyId, projectId: project.id, code: 'B-301', unitType: 'apartment', areaSqm: 100, listPrice: 1000000 });
    await app.services.inventory.reserveUnit(soldUnit.id, 'lead-x', companyId);
    await app.services.inventory.markContracted(soldUnit.id);

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Units');
    sheet.addRow(['Project', 'Unit Code', 'Unit Type', 'Area (sqm)', 'List Price']);
    sheet.addRow([project.name, 'B-301', 'apartment', 999, 9999999]); // attempt to overwrite sold unit
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const upload = await uploadFile(base, '/api/inventory/units/import/upload', 'units.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf, headers);
    assert.equal(upload.status, 200);
    const uploadBody = upload.body as { sessionId: string; suggestedMapping: Record<string, string | null> };

    const preview = await callJson(base, 'POST', `/api/inventory/units/import/${uploadBody.sessionId}/preview`, { mapping: uploadBody.suggestedMapping }, headers);
    const previewBody = preview.body as { conflictCount: number };
    assert.equal(previewBody.conflictCount, 1);

    const confirm = await callJson(base, 'POST', `/api/inventory/units/import/${uploadBody.sessionId}/confirm`, {}, headers);
    const confirmBody = confirm.body as { succeeded: number; skipped: number };
    assert.equal(confirmBody.succeeded, 0);
    assert.equal(confirmBody.skipped, 1);

    const untouched = await app.repos.units.findById(soldUnit.id);
    assert.equal(untouched!.areaSqm, 100);
    assert.equal(untouched!.listPrice, 1000000);
    assert.equal(untouched!.status, 'contracted');
  });
});

test('full Inventory Import HTTP flow: real PDF upload creates a real unit', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const companyId = app.seedResult!.companyId;
    const project = await app.services.inventory.createProject({ companyId, name: `PDF Import Project ${Date.now()}` });

    const pdf = buildPdf([
      { text: 'Project', x: 50, y: 700 },
      { text: 'Unit Code', x: 180, y: 700 },
      { text: 'Unit Type', x: 300, y: 700 },
      { text: 'Area', x: 400, y: 700 },
      { text: 'Price', x: 470, y: 700 },
      { text: project.name, x: 50, y: 680 },
      { text: 'C-401', x: 180, y: 680 },
      { text: 'penthouse', x: 300, y: 680 },
      { text: '250', x: 400, y: 680 },
      { text: '4500000', x: 470, y: 680 },
    ]);

    const upload = await uploadFile(base, '/api/inventory/units/import/upload', 'units.pdf', 'application/pdf', pdf, headers);
    assert.equal(upload.status, 200);
    const uploadBody = upload.body as { sessionId: string; fileType: string; suggestedMapping: Record<string, string | null> };
    assert.equal(uploadBody.fileType, 'pdf');

    const preview = await callJson(base, 'POST', `/api/inventory/units/import/${uploadBody.sessionId}/preview`, { mapping: uploadBody.suggestedMapping }, headers);
    assert.equal((preview.body as { validCount: number }).validCount, 1);

    const confirm = await callJson(base, 'POST', `/api/inventory/units/import/${uploadBody.sessionId}/confirm`, {}, headers);
    assert.equal((confirm.body as { succeeded: number }).succeeded, 1);

    const units = await app.repos.units.findAll((u) => u.companyId === companyId && u.code === 'C-401');
    assert.equal(units.length, 1);
    assert.equal(units[0]!.unitType, 'penthouse');
  });
});

test('Import History lists a completed inventory import session', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const companyId = app.seedResult!.companyId;
    const project = await app.services.inventory.createProject({ companyId, name: `History Project ${Date.now()}` });

    const csv = Buffer.from(`Project,Unit Code,Unit Type,Area (sqm),List Price\n${project.name},D-501,studio,60,600000\n`);
    const upload = await uploadFile(base, '/api/inventory/units/import/upload', 'units.csv', 'text/csv', csv, headers);
    const uploadBody = upload.body as { sessionId: string; suggestedMapping: Record<string, string | null> };
    await callJson(base, 'POST', `/api/inventory/units/import/${uploadBody.sessionId}/preview`, { mapping: uploadBody.suggestedMapping }, headers);
    await callJson(base, 'POST', `/api/inventory/units/import/${uploadBody.sessionId}/confirm`, {}, headers);

    const history = await callJson(base, 'GET', '/api/imports/history?targetType=inventory_unit', undefined, headers);
    assert.equal(history.status, 200);
    const sessions = history.body as { id: string; status: string; fileName: string }[];
    assert.ok(sessions.some((s) => s.id === uploadBody.sessionId && s.status === 'confirmed'));
  });
});

test('a role without create:unit (Sales Agent) is blocked from Inventory Import', async () => {
  await withServer(async (base, app) => {
    const agentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;
    const headers = { 'x-demo-user': agentUserId };
    const csv = Buffer.from('Project,Unit Code,Unit Type,Area (sqm),List Price\nX,Y,apartment,100,100\n');
    const upload = await uploadFile(base, '/api/inventory/units/import/upload', 'units.csv', 'text/csv', csv, headers);
    assert.equal(upload.status, 403);
  });
});

test('Inventory Import upload requires authentication', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/inventory/units/import/upload`, { method: 'POST', body: new FormData() });
    assert.equal(res.status, 401);
  });
});
