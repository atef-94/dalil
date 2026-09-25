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

/**
 * Builds a real, real signed contract with a payment schedule inside the
 * seeded demo company (via a real HTTP request chain — the exact sequence
 * a browser session would drive), so tests below can attempt a refund
 * against it.
 */
async function signRealDemoContract(base: string, headers: Record<string, string>) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const project = await call(base, 'POST', '/api/inventory/projects', { name: `RefundIdorProj-${suffix}`, location: 'Maadi' }, headers);
  const unit = await call(base, 'POST', '/api/inventory/units', { projectId: (project.body as { id: string }).id, code: `RU-${suffix}`, listPrice: 400000, unitType: 'apartment', areaSqm: 90 }, headers);
  const template = await call(base, 'POST', '/api/payment-plan-templates', { name: `RefundIdorPlan-${suffix}`, downPaymentType: 'percentage', downPaymentValue: 20, frequency: 'monthly', termMonths: 6, fees: [] }, headers);
  const lead = await call(base, 'POST', '/api/crm/leads', { fullName: `RefundClient-${suffix}`, phone: `rp-${suffix}`, nationalId: `rnid-${suffix}` }, headers);
  await call(base, 'PATCH', `/api/crm/leads/${(lead.body as { id: string }).id}/status`, { status: 'qualified' }, headers);
  const opp = await call(base, 'POST', '/api/sales/opportunities', { leadId: (lead.body as { id: string }).id }, headers);
  const reservation = await call(base, 'POST', `/api/sales/opportunities/${(opp.body as { id: string }).id}/reserve-unit`, { unitId: (unit.body as { id: string }).id }, headers);
  const contract = await call(base, 'POST', '/api/sales/contracts', { reservationId: (reservation.body as { id: string }).id, paymentPlanTemplateId: (template.body as { id: string }).id, totalPrice: 400000 }, headers);
  const schedule = await call(base, 'GET', `/api/contracts/${(contract.body as { id: string }).id}/payment-schedule`, undefined, headers);
  return { contractId: (contract.body as { id: string }).id, lineId: (schedule.body as { id: string }[])[0]!.id };
}

test('POST /api/finance/refunds rejects a request whose contract/schedule line does not belong to the actor\'s own company (real security fix)', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const financeUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Finance')!.userId;
    const ceoHeaders = { 'x-demo-user': ceoUserId };
    const financeHeaders = { 'x-demo-user': financeUserId };

    // A real contract/schedule line inside company-demo (Tenant A).
    const { contractId, lineId } = await signRealDemoContract(base, ceoHeaders);

    // A completely separate real tenant (Tenant B), via self-service signup.
    const signupB = await call(base, 'POST', '/api/auth/signup', {
      companyName: `Refund Tenant B ${Date.now()}`,
      fullName: 'Owner B',
      email: `refund-ownerb-${Date.now()}@example.com`,
      password: 'a-real-password-123',
    });
    assert.equal(signupB.status, 201);
    const tenantBHeaders = { authorization: `Bearer ${(signupB.body as { token: string }).token}` };

    // Before the fix, this created a real, queued ApprovalRequest under
    // Tenant B's own companyId that referenced Tenant A's real
    // contract/schedule-line ids — it would only ever fail later, at
    // approval time, instead of being rejected immediately like every
    // other approval-gated route in the codebase.
    const crossTenantRefund = await call(base, 'POST', '/api/finance/refunds', {
      contractId,
      paymentScheduleLineId: lineId,
      amount: 100,
      reason: 'cross-tenant attempt',
    }, tenantBHeaders);
    assert.equal(crossTenantRefund.status, 404);

    // Sanity: the same request, from the real owning tenant, still works.
    const legitimateRefund = await call(base, 'POST', '/api/finance/refunds', {
      contractId,
      paymentScheduleLineId: lineId,
      amount: 100,
      reason: 'legitimate same-tenant refund request',
    }, financeHeaders);
    assert.equal(legitimateRefund.status, 202);
  });
});

test('POST /api/finance/refunds rejects a paymentScheduleLineId that does not belong to the given contractId', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const financeUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Finance')!.userId;
    const ceoHeaders = { 'x-demo-user': ceoUserId };
    const financeHeaders = { 'x-demo-user': financeUserId };

    const first = await signRealDemoContract(base, ceoHeaders);
    const second = await signRealDemoContract(base, ceoHeaders);

    // Same tenant, but the schedule line belongs to a different real
    // contract than the one named in the request.
    const mismatched = await call(base, 'POST', '/api/finance/refunds', {
      contractId: first.contractId,
      paymentScheduleLineId: second.lineId,
      amount: 50,
      reason: 'mismatched contract/line',
    }, financeHeaders);
    assert.equal(mismatched.status, 404);
  });
});
