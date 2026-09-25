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

test('full Lead Import HTTP flow: real CSV upload -> preview -> confirm creates real leads', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const companyId = app.seedResult!.companyId;

    const csv = Buffer.from(
      'Full Name,Mobile,Email\n' +
        'Ahmed Ali,0100000001,ahmed.import@example.com\n' +
        'Sara Youssef,0100000002,sara.import@example.com\n' +
        ',0100000003,noname@example.com\n', // invalid: missing Full Name
    );

    const upload = await uploadFile(base, '/api/crm/leads/import/upload', 'leads.csv', 'text/csv', csv, headers);
    assert.equal(upload.status, 200);
    const uploadBody = upload.body as { sessionId: string; detectedColumns: string[]; suggestedMapping: Record<string, string | null> };
    assert.deepEqual(uploadBody.detectedColumns, ['Full Name', 'Mobile', 'Email']);
    assert.deepEqual(uploadBody.suggestedMapping, { 'Full Name': 'fullName', Mobile: 'phone', Email: 'email' });

    const preview = await callJson(base, 'POST', `/api/crm/leads/import/${uploadBody.sessionId}/preview`, { mapping: uploadBody.suggestedMapping }, headers);
    assert.equal(preview.status, 200);
    const previewBody = preview.body as { totalRows: number; validCount: number; invalidCount: number };
    assert.equal(previewBody.totalRows, 3);
    assert.equal(previewBody.validCount, 2);
    assert.equal(previewBody.invalidCount, 1);

    const confirm = await callJson(base, 'POST', `/api/crm/leads/import/${uploadBody.sessionId}/confirm`, {}, headers);
    assert.equal(confirm.status, 200);
    const confirmBody = confirm.body as { total: number; succeeded: number; skipped: number; failed: number };
    assert.equal(confirmBody.total, 3);
    assert.equal(confirmBody.succeeded, 2);
    assert.equal(confirmBody.skipped, 1);
    assert.equal(confirmBody.failed, 0);

    const leads = await app.repos.leads.findAll((l) => l.companyId === companyId);
    const imported = leads.filter((l) => l.email === 'ahmed.import@example.com' || l.email === 'sara.import@example.com');
    assert.equal(imported.length, 2);
  });
});

test('full Lead Import HTTP flow: real .xlsx upload with a duplicate row is skipped, not imported twice', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Leads');
    sheet.addRow(['Name', 'Phone']);
    sheet.addRow(['Mona Adel', '0122223333']);
    sheet.addRow(['Mona Adel Duplicate', '0122223333']); // same phone -> duplicate
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const upload = await uploadFile(
      base,
      '/api/crm/leads/import/upload',
      'leads.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buf,
      headers,
    );
    assert.equal(upload.status, 200);
    const uploadBody = upload.body as { sessionId: string; suggestedMapping: Record<string, string | null> };

    const preview = await callJson(base, 'POST', `/api/crm/leads/import/${uploadBody.sessionId}/preview`, { mapping: uploadBody.suggestedMapping }, headers);
    const previewBody = preview.body as { validCount: number; duplicateCount: number };
    assert.equal(previewBody.validCount, 1);
    assert.equal(previewBody.duplicateCount, 1);

    const confirm = await callJson(base, 'POST', `/api/crm/leads/import/${uploadBody.sessionId}/confirm`, {}, headers);
    const confirmBody = confirm.body as { succeeded: number; skipped: number };
    assert.equal(confirmBody.succeeded, 1);
    assert.equal(confirmBody.skipped, 1);
  });
});

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

test('full Lead Import HTTP flow: real PDF upload -> preview -> confirm creates real leads', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const companyId = app.seedResult!.companyId;

    const pdf = buildPdf([
      { text: 'Full Name', x: 50, y: 700 },
      { text: 'Phone', x: 250, y: 700 },
      { text: 'Email', x: 400, y: 700 },
      { text: 'Youssef Kamal', x: 50, y: 680 },
      { text: '0155501234', x: 250, y: 680 },
      { text: 'youssef.pdfimport@example.com', x: 400, y: 680 },
    ]);

    const upload = await uploadFile(base, '/api/crm/leads/import/upload', 'leads.pdf', 'application/pdf', pdf, headers);
    assert.equal(upload.status, 200);
    const uploadBody = upload.body as { sessionId: string; fileType: string; suggestedMapping: Record<string, string | null> };
    assert.equal(uploadBody.fileType, 'pdf');
    assert.deepEqual(uploadBody.suggestedMapping, { 'Full Name': 'fullName', Phone: 'phone', Email: 'email' });

    const preview = await callJson(base, 'POST', `/api/crm/leads/import/${uploadBody.sessionId}/preview`, { mapping: uploadBody.suggestedMapping }, headers);
    assert.equal((preview.body as { validCount: number }).validCount, 1);

    const confirm = await callJson(base, 'POST', `/api/crm/leads/import/${uploadBody.sessionId}/confirm`, {}, headers);
    assert.equal((confirm.body as { succeeded: number }).succeeded, 1);

    const leads = await app.repos.leads.findAll((l) => l.companyId === companyId && l.email === 'youssef.pdfimport@example.com');
    assert.equal(leads.length, 1);
    assert.equal(leads[0]!.fullName, 'Youssef Kamal');
  });
});

test('a PDF whose layout cannot be reliably read as a table is rejected with a clear error, not fabricated rows', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const sparsePdf = buildPdf([
      { text: 'A', x: 50, y: 700 },
      { text: 'B', x: 250, y: 700 },
      { text: 'C', x: 400, y: 700 },
      { text: 'onlyone', x: 50, y: 680 },
    ]);
    const upload = await uploadFile(base, '/api/crm/leads/import/upload', 'unreliable.pdf', 'application/pdf', sparsePdf, headers);
    assert.equal(upload.status, 400);
    assert.match((upload.body as { error: string }).error, /could not be reliably read/);
  });
});

test('a Sales Agent (create:lead at own scope) can use Lead Import exactly like the manual Add Lead button', async () => {
  await withServer(async (base, app) => {
    const agentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;
    const headers = { 'x-demo-user': agentUserId };
    const csv = Buffer.from('Full Name,Mobile\nAgent Imported Lead,0501231234\n');
    const upload = await uploadFile(base, '/api/crm/leads/import/upload', 'leads.csv', 'text/csv', csv, headers);
    assert.equal(upload.status, 200);
    const uploadBody = upload.body as { sessionId: string; suggestedMapping: Record<string, string | null> };
    await callJson(base, 'POST', `/api/crm/leads/import/${uploadBody.sessionId}/preview`, { mapping: uploadBody.suggestedMapping }, headers);
    const confirm = await callJson(base, 'POST', `/api/crm/leads/import/${uploadBody.sessionId}/confirm`, {}, headers);
    assert.equal(confirm.status, 200);
    assert.equal((confirm.body as { succeeded: number }).succeeded, 1);
  });
});

test('a role without create:lead (Finance) is blocked from Lead Import, same as the manual route', async () => {
  await withServer(async (base, app) => {
    const financeUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Finance')!.userId;
    const headers = { 'x-demo-user': financeUserId };
    const csv = Buffer.from('Full Name,Mobile\nBlocked Lead,0501112223\n');
    const upload = await uploadFile(base, '/api/crm/leads/import/upload', 'leads.csv', 'text/csv', csv, headers);
    assert.equal(upload.status, 403);
  });
});

test('Automation Engine audit: a lead created via the import pipeline fires a real lead.created event that triggers a real workflow (no second engine, no fake event)', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const companyId = app.seedResult!.companyId;

    await app.services.automation.createWorkflow({
      companyId,
      name: 'Follow-up on lead import',
      createdByUserId: ceoUserId,
      trigger: { type: 'event', eventType: 'lead.created' },
      steps: [{ name: 'Create follow-up task', action: { type: 'create_task', params: { title: 'Follow up with imported lead' } } }],
    });

    const csv = Buffer.from('Full Name,Mobile\nAutomation Audit Lead,0501119999\n');
    const upload = await uploadFile(base, '/api/crm/leads/import/upload', 'leads.csv', 'text/csv', csv, headers);
    const uploadBody = upload.body as { sessionId: string; suggestedMapping: Record<string, string | null> };
    await callJson(base, 'POST', `/api/crm/leads/import/${uploadBody.sessionId}/preview`, { mapping: uploadBody.suggestedMapping }, headers);
    const confirm = await callJson(base, 'POST', `/api/crm/leads/import/${uploadBody.sessionId}/confirm`, {}, headers);
    assert.equal((confirm.body as { succeeded: number }).succeeded, 1);

    const runs = await app.repos.workflowRuns.findAll((r) => r.companyId === companyId);
    const completedRun = runs.find((r) => r.status === 'completed');
    assert.ok(completedRun, 'expected a completed workflow run triggered by the imported lead.created event');

    const tasks = await app.repos.tasks.findAll((t) => t.companyId === companyId && t.title === 'Follow up with imported lead');
    assert.equal(tasks.length, 1);
  });
});

test('AI audit: the existing AI Execution Layer works against a lead created via the import pipeline, through the same endpoint the AI Assistant panel uses', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const companyId = app.seedResult!.companyId;

    const csv = Buffer.from('Full Name,Mobile\nAI Audit Lead,0501118888\n');
    const upload = await uploadFile(base, '/api/crm/leads/import/upload', 'leads.csv', 'text/csv', csv, headers);
    const uploadBody = upload.body as { sessionId: string; suggestedMapping: Record<string, string | null> };
    await callJson(base, 'POST', `/api/crm/leads/import/${uploadBody.sessionId}/preview`, { mapping: uploadBody.suggestedMapping }, headers);
    const confirm = await callJson(base, 'POST', `/api/crm/leads/import/${uploadBody.sessionId}/confirm`, {}, headers);
    const leadId = (confirm.body as { results: { leadId?: string }[] }).results.find((r) => r.leadId)!.leadId!;

    // Same endpoint public/js/pages/ai-panel.js calls for "Ask AI" on a lead
    // — no separate AI code path exists for imported leads.
    const suggestion = await callJson(base, 'POST', `/api/crm/leads/${leadId}/suggest-next-action`, {}, headers);
    assert.equal(suggestion.status, 201);
    const request = suggestion.body as { subjectType: string; subjectId: string; companyId: string };
    assert.equal(request.subjectId, leadId);
    assert.equal(request.companyId, companyId);

    // The same imported lead is also a valid subject for the general Sales
    // agent's decide() pipeline (RBAC/policy/approval/audit all real, not
    // re-implemented for imports).
    const decision = await callJson(base, 'POST', '/api/ai/agents/sales/decide', { subjectId: leadId }, headers);
    assert.equal(decision.status, 201);
  });
});

test('Lead Import upload requires authentication', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/crm/leads/import/upload`, { method: 'POST', body: new FormData() });
    assert.equal(res.status, 401);
  });
});

test('confirm rejects an import session that was never mapped', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const upload = await uploadFile(base, '/api/crm/leads/import/upload', 'leads.csv', 'text/csv', Buffer.from('Full Name\nAhmed\n'), headers);
    const uploadBody = upload.body as { sessionId: string };
    const confirm = await callJson(base, 'POST', `/api/crm/leads/import/${uploadBody.sessionId}/confirm`, {}, headers);
    assert.equal(confirm.status, 400);
  });
});
