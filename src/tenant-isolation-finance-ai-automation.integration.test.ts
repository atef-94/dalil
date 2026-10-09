import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, createSecondTenant, withServer } from './test-support/test-app.js';

// Mandatory proof points 5, 7 (Finance/AI/Automation slice):
//   5. A tenant user cannot access another company's records by changing
//      record IDs or tenant IDs.
//   7. Tenant data remains isolated across ... Finance, AI, Automation ...

async function signRealContract(base: string, headers: Record<string, string>) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const project = await call(base, 'POST', '/api/inventory/projects', { name: `IsoProj-${suffix}` }, headers);
  const unit = await call(base, 'POST', '/api/inventory/units', { projectId: (project.body as { id: string }).id, code: `IU-${suffix}`, listPrice: 400000, unitType: 'apartment', areaSqm: 90 }, headers);
  const template = await call(base, 'POST', '/api/payment-plan-templates', { name: `IsoPlan-${suffix}`, downPaymentType: 'percentage', downPaymentValue: 20, frequency: 'monthly', termMonths: 6, fees: [] }, headers);
  const lead = await call(base, 'POST', '/api/crm/leads', { fullName: `IsoClient-${suffix}`, phone: `ip-${suffix}` }, headers);
  const opp = await call(base, 'POST', '/api/sales/opportunities', { leadId: (lead.body as { id: string }).id }, headers);
  const reservation = await call(base, 'POST', `/api/sales/opportunities/${(opp.body as { id: string }).id}/reserve-unit`, { unitId: (unit.body as { id: string }).id }, headers);
  const contract = await call(base, 'POST', '/api/sales/contracts', { reservationId: (reservation.body as { id: string }).id, paymentPlanTemplateId: (template.body as { id: string }).id, totalPrice: 400000 }, headers);
  return { contractId: (contract.body as { id: string }).id, leadId: (lead.body as { id: string }).id };
}

test('a tenant B user cannot read tenant A finance contract balances by manipulated contract id', async () => {
  await withServer(async (base, app) => {
    const ceoA = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!;
    const headersA = { 'x-demo-user': ceoA.userId };
    const { contractId } = await signRealContract(base, headersA);

    const tenantB = await createSecondTenant(base, 'Finance Isolation Tenant B');
    const balance = await call(base, 'GET', `/api/finance/contracts/${contractId}/balance`, undefined, tenantB.headers);
    // getBalance() filters schedule lines by (contractId AND companyId) and
    // sums whatever matches — for a cross-tenant id that's always zero
    // matches, so this returns 200 with an all-zero balance rather than a
    // 404 (same shape as a legitimate contract that happens to have no
    // schedule lines yet). No real tenant A amount is ever exposed either
    // way, since the predicate requires the *actor's own* companyId.
    assert.equal(balance.status, 200);
    assert.deepEqual(balance.body, { contractId, totalDue: 0, totalPaid: 0, outstanding: 0 });

    // A record payment attempt by manipulated contract id must not succeed either.
    const payment = await call(base, 'POST', '/api/finance/payments', { contractId, amount: 1000, method: 'cash' }, tenantB.headers);
    assert.ok([403, 404].includes(payment.status));
  });
});

test('a tenant B user cannot read or run tenant A automation workflows by manipulated workflow/run ids', async () => {
  await withServer(async (base, app) => {
    const ceoA = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!;
    const headersA = { 'x-demo-user': ceoA.userId };
    const workflow = await call(base, 'POST', '/api/automation/workflows', {
      name: 'Tenant A Private Workflow',
      trigger: { type: 'event', eventType: 'lead.created' },
      steps: [{ name: 'Create follow-up task', action: { type: 'create_task', params: { title: 'Follow up' } } }],
    }, headersA);
    assert.equal(workflow.status, 201);
    const workflowId = (workflow.body as { id: string }).id;

    const tenantB = await createSecondTenant(base, 'Automation Isolation Tenant B');

    const read = await call(base, 'GET', `/api/automation/workflows/${workflowId}`, undefined, tenantB.headers);
    assert.equal(read.status, 404);

    // listRuns() filters by (workflowId AND companyId) — a cross-tenant
    // workflowId always matches zero rows, so this returns 200 with an
    // empty list rather than 404 (same shape as a real workflow with no
    // runs yet). No tenant A run data is ever included either way.
    const runsList = await call(base, 'GET', `/api/automation/workflows/${workflowId}/runs`, undefined, tenantB.headers);
    assert.equal(runsList.status, 200);
    assert.deepEqual((runsList.body as { items: unknown[] }).items, []);

    const statusChange = await call(base, 'POST', `/api/automation/workflows/${workflowId}/status`, { status: 'paused' }, tenantB.headers);
    assert.equal(statusChange.status, 404);
  });
});

test('a tenant B user cannot read tenant A AI workflow runs by manipulated run id (consolidating the AI proof point here)', async () => {
  await withServer(async (base, app) => {
    const ceoA = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!;
    const headersA = { 'x-demo-user': ceoA.userId };
    const lead = await call(base, 'POST', '/api/crm/leads', { fullName: 'AI Isolation Lead', phone: '0100099999' }, headersA);
    const run = await call(base, 'POST', '/api/ai/workflows', { goalType: 'high_value_lead_followup', subjectId: (lead.body as { id: string }).id }, headersA);
    assert.equal(run.status, 201);
    const runId = (run.body as { id: string }).id;

    const tenantB = await createSecondTenant(base, 'AI Isolation Tenant B');
    const read = await call(base, 'GET', `/api/ai/workflows/${runId}`, undefined, tenantB.headers);
    assert.equal(read.status, 404);
  });
});
