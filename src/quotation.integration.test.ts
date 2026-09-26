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

    // Real, server-rendered Offer PDF — real %PDF- magic bytes once base64-decoded.
    const pdf = await call(base, 'GET', `/api/quotations/${q1.id}/pdf`, undefined, headers);
    assert.equal(pdf.status, 200);
    const pdfBody = pdf.body as { filename: string; contentType: string; base64: string };
    assert.match(pdfBody.filename, /\.pdf$/);
    assert.equal(pdfBody.contentType, 'application/pdf');
    const decodedPdf = Buffer.from(pdfBody.base64, 'base64');
    assert.equal(decodedPdf.subarray(0, 5).toString('latin1'), '%PDF-');
  });
});

test('unit-by-code lookup auto-fills unit + project for the Offer builder', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const project = await call(base, 'POST', '/api/inventory/projects', { name: `CodeLookupProj-${suffix}` }, headers);
    const unit = await call(base, 'POST', '/api/inventory/units', {
      projectId: (project.body as { id: string }).id, code: `CL-${suffix}`, listPrice: 3_000_000, unitType: 'apartment', areaSqm: 140,
    }, headers);

    const found = await call(base, 'GET', `/api/quotations/units/by-code/${(unit.body as { code: string }).code}`, undefined, headers);
    assert.equal(found.status, 200);
    const foundBody = found.body as { unit: { id: string }; project: { id: string; name: string } };
    assert.equal(foundBody.unit.id, (unit.body as { id: string }).id);
    assert.equal(foundBody.project.id, (project.body as { id: string }).id);

    const missing = await call(base, 'GET', '/api/quotations/units/by-code/NO-SUCH-CODE', undefined, headers);
    assert.equal(missing.status, 404);
  });
});

test('sending an Offer via WhatsApp generates a real PDF, sends it as a document through the connected integration, and logs it on the lead\'s own timeline', async () => {
  // Fakes only the network boundary (the real Meta Cloud API), exactly
  // like the e-signature integration test — everything else (routes,
  // PDF generation, RBAC, the Integration Layer, timeline aggregation)
  // runs for real. Node's test runner isolates each test file in its own
  // process, so this patch never leaks into other test files.
  const realFetch = globalThis.fetch;
  const graphCalls: string[] = [];
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes('graph.facebook.com')) {
      graphCalls.push(urlStr);
      if (urlStr.includes('/media')) return new Response(JSON.stringify({ id: 'media-fake-123' }), { status: 200 });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.fake-456' }] }), { status: 200 });
    }
    return realFetch(url, init);
  }) as typeof fetch;

  try {
    await withServer(async (base, app) => {
      const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
      const headers = { 'x-demo-user': ceoUserId };
      const { unitId, templateId } = await setupUnitAndTemplate(base, headers);

      const lead = await call(base, 'POST', '/api/crm/leads', { fullName: 'Offer Recipient', phone: `0555-${Date.now()}` }, headers);
      const leadId = (lead.body as { id: string }).id;

      const gen = await call(base, 'POST', '/api/quotations', { unitId, paymentPlanTemplateId: templateId, leadId }, headers);
      assert.equal(gen.status, 201);
      const quotationId = (gen.body as { id: string }).id;

      await call(base, 'POST', '/api/integrations/connections', {
        provider: 'whatsapp', displayName: 'Demo WhatsApp',
        config: { phoneNumberId: 'phone-demo' },
        credentials: { access_token: 'tok-demo' },
      }, headers);

      const send = await call(base, 'POST', `/api/quotations/${quotationId}/send-whatsapp`, { to: '+201234567890' }, headers);
      assert.equal(send.status, 201);
      const sendBody = send.body as { message: { relatedResource: string; relatedResourceId: string }; providerResult: { providerMessageId?: string } };
      assert.equal(sendBody.message.relatedResource, 'lead');
      assert.equal(sendBody.message.relatedResourceId, leadId);
      assert.equal(sendBody.providerResult.providerMessageId, 'wamid.fake-456');

      // Real 2-step Cloud API flow: media upload, then the document message.
      assert.equal(graphCalls.length, 2);
      assert.match(graphCalls[0]!, /\/media/);
      assert.match(graphCalls[1]!, /\/messages/);

      // Shows up on the lead's own timeline, not hidden under 'quotation'.
      const timeline = await call(base, 'GET', `/api/crm/leads/${leadId}/timeline`, undefined, headers);
      assert.equal(timeline.status, 200);
      const entries = (timeline.body as { items: { type: string; summary: string }[] }).items;
      assert.ok(entries.some((e) => e.type === 'message' && /Offer/.test(e.summary)));
    });
  } finally {
    globalThis.fetch = realFetch;
  }
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
    const crossPdf = await call(base, 'GET', `/api/quotations/${quotationId}/pdf`, undefined, tenantBHeaders);
    assert.equal(crossPdf.status, 404);
    const crossWhatsapp = await call(base, 'POST', `/api/quotations/${quotationId}/send-whatsapp`, { to: '+1' }, tenantBHeaders);
    assert.equal(crossWhatsapp.status, 404);
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
