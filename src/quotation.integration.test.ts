import { test } from 'node:test';
import assert from 'node:assert/strict';
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

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function setupUnitAndTemplate(base: string, headers: Record<string, string>) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const project = await call(base, 'POST', '/api/inventory/projects', { name: `QuoteProj-${suffix}` }, headers);
  const unit = await call(base, 'POST', '/api/inventory/units', { projectId: (project.body as { id: string }).id, code: `Q-${suffix}`, listPrice: 2_000_000, unitType: 'apartment', areaSqm: 150 }, headers);
  const template = await call(base, 'POST', '/api/payment-plan-templates', { name: `QuotePlan-${suffix}`, downPaymentType: 'percentage', downPaymentValue: 10, frequency: 'quarterly', termMonths: 48, fees: [] }, headers);
  return { unitId: (unit.body as { id: string }).id, templateId: (template.body as { id: string }).id };
}

test('quotation lifecycle: calculate -> generate -> version -> get -> status -> excel -> print -> share (real HTTP)', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const { unitId, templateId } = await setupUnitAndTemplate(base, headers);

    const calc = await call(base, 'POST', '/api/quotations/calculate', { unitId, paymentPlanTemplateId: templateId, discountPercent: 5 }, headers);
    assert.equal(calc.status, 200);
    const calcBody = calc.body as { totalPrice: number; netValue: number; schedule: unknown[] };
    assert.equal(calcBody.totalPrice, 2_000_000);
    assert.equal(calcBody.netValue, 2_000_000 * 0.95);
    assert.ok(calcBody.schedule.length > 0);

    const gen1 = await call(base, 'POST', '/api/quotations', { unitId, paymentPlanTemplateId: templateId, discountPercent: 5 }, headers);
    assert.equal(gen1.status, 201);
    const q1 = gen1.body as { id: string; version: number; referenceNumber: string; status: string };
    assert.equal(q1.version, 1);
    assert.equal(q1.status, 'generated');

    const gen2 = await call(base, 'POST', '/api/quotations', { unitId, paymentPlanTemplateId: templateId, discountPercent: 8 }, headers);
    const q2 = gen2.body as { id: string; version: number };
    assert.equal(q2.version, 2);
    assert.notEqual(q1.referenceNumber, (gen2.body as { referenceNumber: string }).referenceNumber);

    // Listing sees both, newest sorted or not, both present.
    const list = await call(base, 'GET', '/api/quotations', undefined, headers);
    assert.equal(list.status, 200);
    const items = (list.body as { items: { id: string }[] }).items;
    assert.ok(items.some((i) => i.id === q1.id));
    assert.ok(items.some((i) => i.id === q2.id));

    // Get one — recompute matches the persisted inputs.
    const getOne = await call(base, 'GET', `/api/quotations/${q1.id}`, undefined, headers);
    assert.equal(getOne.status, 200);
    const getOneBody = getOne.body as { quotation: { version: number }; calculation: { discountPercent: number } };
    assert.equal(getOneBody.quotation.version, 1);
    assert.equal(getOneBody.calculation.discountPercent, 5);

    // Status transition.
    const statusRes = await call(base, 'PATCH', `/api/quotations/${q1.id}/status`, { status: 'sent' }, headers);
    assert.equal(statusRes.status, 200);
    assert.equal((statusRes.body as { status: string }).status, 'sent');

    // Excel export — real xlsx magic bytes (PK zip header) once base64-decoded.
    const excel = await call(base, 'GET', `/api/quotations/${q1.id}/excel`, undefined, headers);
    assert.equal(excel.status, 200);
    const excelBody = excel.body as { filename: string; base64: string };
    assert.match(excelBody.filename, /\.xlsx$/);
    const decoded = Buffer.from(excelBody.base64, 'base64');
    assert.equal(decoded.subarray(0, 2).toString('ascii'), 'PK');

    // Print/PDF view — a real HTML document containing the reference number.
    const print = await call(base, 'GET', `/api/quotations/${q1.id}/print`, undefined, headers);
    assert.equal(print.status, 200);
    const printBody = print.body as { html: string };
    assert.match(printBody.html, /<html/);
    assert.match(printBody.html, new RegExp(q1.referenceNumber));

    // Share logs a real Message.
    const share = await call(base, 'POST', `/api/quotations/${q1.id}/share`, { channel: 'whatsapp', message: 'Please review.' }, headers);
    assert.equal(share.status, 201);
    assert.equal((share.body as { channel: string }).channel, 'whatsapp');
    assert.equal((share.body as { relatedResource: string }).relatedResource, 'quotation');
  });
});

test('quotation routes reject cross-tenant access with 404, not leaking existence', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const ceoHeaders = { 'x-demo-user': ceoUserId };
    const { unitId, templateId } = await setupUnitAndTemplate(base, ceoHeaders);
    const gen = await call(base, 'POST', '/api/quotations', { unitId, paymentPlanTemplateId: templateId }, ceoHeaders);
    const quotationId = (gen.body as { id: string }).id;

    const signupB = await call(base, 'POST', '/api/auth/signup', {
      companyName: `Quote Tenant B ${Date.now()}`,
      fullName: 'Owner B',
      email: `quote-ownerb-${Date.now()}@example.com`,
      password: 'a-real-password-123',
    });
    assert.equal(signupB.status, 201);
    const tenantBHeaders = { authorization: `Bearer ${(signupB.body as { token: string }).token}` };

    const crossGet = await call(base, 'GET', `/api/quotations/${quotationId}`, undefined, tenantBHeaders);
    assert.equal(crossGet.status, 404);
    const crossStatus = await call(base, 'PATCH', `/api/quotations/${quotationId}/status`, { status: 'sent' }, tenantBHeaders);
    assert.equal(crossStatus.status, 404);
    const crossExcel = await call(base, 'GET', `/api/quotations/${quotationId}/excel`, undefined, tenantBHeaders);
    assert.equal(crossExcel.status, 404);
  });
});

test('a Sales Agent cannot view another agent\'s quotation, and an unauthenticated caller is rejected', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const agentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;
    const ceoHeaders = { 'x-demo-user': ceoUserId };
    const agentHeaders = { 'x-demo-user': agentUserId };
    const { unitId, templateId } = await setupUnitAndTemplate(base, ceoHeaders);

    // CEO-owned quotation.
    const gen = await call(base, 'POST', '/api/quotations', { unitId, paymentPlanTemplateId: templateId }, ceoHeaders);
    const quotationId = (gen.body as { id: string }).id;

    // Sales Agent's own-scope grant does not extend to the CEO's quotation.
    const agentGet = await call(base, 'GET', `/api/quotations/${quotationId}`, undefined, agentHeaders);
    assert.equal(agentGet.status, 403);

    // But the agent can generate and view their own.
    const agentGen = await call(base, 'POST', '/api/quotations', { unitId, paymentPlanTemplateId: templateId }, agentHeaders);
    assert.equal(agentGen.status, 201);
    const agentOwnGet = await call(base, 'GET', `/api/quotations/${(agentGen.body as { id: string }).id}`, undefined, agentHeaders);
    assert.equal(agentOwnGet.status, 200);

    const unauth = await call(base, 'POST', '/api/quotations/calculate', { unitId, paymentPlanTemplateId: templateId });
    assert.equal(unauth.status, 401);
  });
});
