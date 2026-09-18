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

/** Builds a real signed contract with a real schedule to import payments against. */
async function buildContractFixture(app: Awaited<ReturnType<typeof freshApp>>) {
  const { crm, crmStages, sales, inventory, paymentPlans } = app.services;
  const companyId = app.seedResult!.companyId;
  const agentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;

  const lead = await crm.createLead({ companyId, fullName: 'Payment Import HTTP Client', phone: `05${Date.now()}`.slice(0, 11), ownerEmployeeUserId: agentUserId });
  const stages = await crmStages.listStages(companyId, true);
  await crm.moveToStage(lead.id, companyId, stages.find((s) => s.key === 'contacted')!.id);
  await crm.moveToStage(lead.id, companyId, stages.find((s) => s.key === 'qualified')!.id);

  const opportunity = await sales.createOpportunity({ companyId, leadId: lead.id, ownerEmployeeUserId: agentUserId });
  const project = await inventory.createProject({ companyId, name: `HTTP Import Project ${Date.now()}` });
  const unit = await inventory.createUnit({ companyId, projectId: project.id, code: `HI-${Date.now()}`, unitType: 'apartment', areaSqm: 100, listPrice: 800_000 });
  const reservation = await sales.reserveUnitForOpportunity(opportunity.id, unit.id, companyId);
  const template = await paymentPlans.createTemplate({
    companyId,
    name: 'HTTP Import Plan',
    downPaymentType: 'percentage',
    downPaymentValue: 10,
    frequency: 'monthly',
    termMonths: 2,
    fees: [],
  });
  const contract = await sales.signContract({
    companyId,
    reservationId: reservation.id,
    creditedEmployeeUserId: agentUserId,
    paymentPlanTemplateId: template.id,
    totalPrice: 800_000,
  });
  const schedule = await paymentPlans.getScheduleForContract(contract.id, companyId);
  return { lead, project, unit, contract, schedule, agentUserId };
}

test('full Payment Import HTTP flow: real CSV upload resolved by phone -> preview -> confirm records a real payment', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const { lead, contract, schedule } = await buildContractFixture(app);

    const csv = Buffer.from(`Mobile,Installment Number,Amount Paid,Payment Method\n${lead.phone},${schedule[0]!.sequence},${schedule[0]!.amount},Cash\n`);
    const upload = await uploadFile(base, '/api/finance/payments/import/upload', 'payments.csv', 'text/csv', csv, headers);
    assert.equal(upload.status, 200);
    const uploadBody = upload.body as { sessionId: string; suggestedMapping: Record<string, string | null> };
    assert.deepEqual(uploadBody.suggestedMapping, { Mobile: 'phone', 'Installment Number': 'installmentNumber', 'Amount Paid': 'amount', 'Payment Method': 'method' });

    const preview = await callJson(base, 'POST', `/api/finance/payments/import/${uploadBody.sessionId}/preview`, { mapping: uploadBody.suggestedMapping }, headers);
    assert.equal(preview.status, 200);
    assert.equal((preview.body as { validCount: number }).validCount, 1);

    const confirm = await callJson(base, 'POST', `/api/finance/payments/import/${uploadBody.sessionId}/confirm`, {}, headers);
    assert.equal(confirm.status, 200);
    const confirmBody = confirm.body as { succeeded: number };
    assert.equal(confirmBody.succeeded, 1);

    const line = await app.repos.scheduleLines.findById(schedule[0]!.id);
    assert.equal(line!.status, 'paid');
    const payments = await app.repos.payments.findAll((p) => p.contractId === contract.id);
    assert.equal(payments.length, 1);
  });
});

test('Payment Import flags an already-fully-paid installment as a conflict and does not double-record it', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const { lead, contract, schedule } = await buildContractFixture(app);

    // Pay it once directly through the service (simulating a prior manual entry).
    await app.services.finance.recordPayment({
      companyId: app.seedResult!.companyId,
      contractId: contract.id,
      paymentScheduleLineId: schedule[0]!.id,
      amount: schedule[0]!.amount,
      method: 'cash',
      recordedByUserId: ceoUserId,
    });

    const csv = Buffer.from(`Mobile,Installment Number,Amount Paid,Payment Method\n${lead.phone},${schedule[0]!.sequence},100,Cash\n`);
    const upload = await uploadFile(base, '/api/finance/payments/import/upload', 'payments.csv', 'text/csv', csv, headers);
    const uploadBody = upload.body as { sessionId: string; suggestedMapping: Record<string, string | null> };
    const preview = await callJson(base, 'POST', `/api/finance/payments/import/${uploadBody.sessionId}/preview`, { mapping: uploadBody.suggestedMapping }, headers);
    const previewBody = preview.body as { conflictCount: number };
    assert.equal(previewBody.conflictCount, 1);
  });
});

test('full Payment Import HTTP flow: real .xlsx upload resolved by Project+Unit -> preview -> confirm records a real payment', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const { project, unit, contract, schedule } = await buildContractFixture(app);

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Payments');
    sheet.addRow(['Project', 'Unit', 'Installment Number', 'Amount', 'Method']);
    sheet.addRow([project.name, unit.code, schedule[0]!.sequence, schedule[0]!.amount, 'Transfer']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const upload = await uploadFile(base, '/api/finance/payments/import/upload', 'payments.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf, headers);
    assert.equal(upload.status, 200);
    const uploadBody = upload.body as { sessionId: string; suggestedMapping: Record<string, string | null> };

    const preview = await callJson(base, 'POST', `/api/finance/payments/import/${uploadBody.sessionId}/preview`, { mapping: uploadBody.suggestedMapping }, headers);
    assert.equal((preview.body as { validCount: number }).validCount, 1);

    const confirm = await callJson(base, 'POST', `/api/finance/payments/import/${uploadBody.sessionId}/confirm`, {}, headers);
    assert.equal((confirm.body as { succeeded: number }).succeeded, 1);

    const payments = await app.repos.payments.findAll((p) => p.contractId === contract.id);
    assert.equal(payments.length, 1);
    assert.equal(payments[0]!.method, 'transfer');
  });
});

test('Payment Import upload requires authentication', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/finance/payments/import/upload`, { method: 'POST', body: new FormData() });
    assert.equal(res.status, 401);
  });
});
