import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApplication } from '../../app.js';

async function freshApp() {
  return buildApplication({ nodeEnv: 'test', tokenSecret: 'test-secret', allowedOrigins: [], seed: true });
}

test('full chain: Lead -> Opportunity -> Reserve Unit -> Sign Contract generates a payment schedule', async () => {
  const app = await freshApp();
  const { crm, crmStages, sales, inventory, paymentPlans } = app.services;
  const companyId = app.seedResult!.companyId;
  const agentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;

  const lead = await crm.createLead({ companyId, fullName: 'Client A', phone: '0555-0001', ownerEmployeeUserId: agentUserId });
  const stages = await crmStages.listStages(companyId, true);
  const contacted = stages.find((s) => s.key === 'no_answer')!;
  const qualified = stages.find((s) => s.key === 'meeting')!;
  await crm.moveToStage(lead.id, companyId, contacted.id);
  await crm.moveToStage(lead.id, companyId, qualified.id);

  const opportunity = await sales.createOpportunity({ companyId, leadId: lead.id, ownerEmployeeUserId: agentUserId });
  const unit = await inventory.createUnit({ companyId, projectId: 'proj-1', code: 'B-201', unitType: 'apartment', areaSqm: 150, listPrice: 1_500_000 });
  const reservation = await sales.reserveUnitForOpportunity(opportunity.id, unit.id, companyId);

  const template = await paymentPlans.createTemplate({
    companyId,
    name: 'Integration Test Plan',
    downPaymentType: 'percentage',
    downPaymentValue: 10,
    frequency: 'monthly',
    termMonths: 12,
    fees: [],
  });

  const contract = await sales.signContract({
    companyId,
    reservationId: reservation.id,
    creditedEmployeeUserId: agentUserId,
    paymentPlanTemplateId: template.id,
    totalPrice: 1_500_000,
  });

  assert.equal(contract.status, 'signed');
  const schedule = await paymentPlans.getScheduleForContract(contract.id, companyId);
  assert.ok(schedule.length > 1);

  const refreshedUnit = await inventory.getUnit(unit.id);
  assert.equal(refreshedUnit!.status, 'contracted');

  const refreshedOpportunity = await sales.getOpportunity(opportunity.id);
  assert.equal(refreshedOpportunity!.stage, 'won');
});

test('concurrency regression: 5 concurrent signContract calls against the same reservation produce exactly 1 success', async () => {
  const app = await freshApp();
  const { crm, sales, inventory, paymentPlans } = app.services;
  const companyId = app.seedResult!.companyId;
  const agentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;

  const lead = await crm.createLead({ companyId, fullName: 'Client B', phone: '0555-0002', ownerEmployeeUserId: agentUserId });
  const opportunity = await sales.createOpportunity({ companyId, leadId: lead.id, ownerEmployeeUserId: agentUserId });
  const unit = await inventory.createUnit({ companyId, projectId: 'proj-1', code: 'B-202', unitType: 'apartment', areaSqm: 150, listPrice: 1_000_000 });
  const reservation = await sales.reserveUnitForOpportunity(opportunity.id, unit.id, companyId);
  const template = await paymentPlans.createTemplate({
    companyId,
    name: 'Race Test Plan',
    downPaymentType: 'fixed',
    downPaymentValue: 100_000,
    frequency: 'monthly',
    termMonths: 6,
    fees: [],
  });

  const attempts = Array.from({ length: 5 }, () =>
    sales
      .signContract({ companyId, reservationId: reservation.id, creditedEmployeeUserId: agentUserId, paymentPlanTemplateId: template.id, totalPrice: 1_000_000 })
      .then(
        (contract) => ({ ok: true as const, contract }),
        (err) => ({ ok: false as const, err }),
      ),
  );
  const results = await Promise.all(attempts);
  const successes = results.filter((r) => r.ok);
  assert.equal(successes.length, 1);

  const winningContractId = (successes[0] as { ok: true; contract: { id: string } }).contract.id;
  const schedule = await paymentPlans.getScheduleForContract(winningContractId, companyId);
  assert.ok(schedule.length > 0);

  const refreshedUnit = await inventory.getUnit(unit.id);
  assert.equal(refreshedUnit!.status, 'contracted');
});

test('reserving a unit for a non-open opportunity fails', async () => {
  const app = await freshApp();
  const { crm, sales, inventory } = app.services;
  const companyId = app.seedResult!.companyId;
  const agentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;

  const lead = await crm.createLead({ companyId, fullName: 'Client C', phone: '0555-0003', ownerEmployeeUserId: agentUserId });
  const opportunity = await sales.createOpportunity({ companyId, leadId: lead.id, ownerEmployeeUserId: agentUserId });
  const unitOne = await inventory.createUnit({ companyId, projectId: 'proj-1', code: 'B-203', unitType: 'apartment', areaSqm: 120, listPrice: 800_000 });
  const unitTwo = await inventory.createUnit({ companyId, projectId: 'proj-1', code: 'B-204', unitType: 'apartment', areaSqm: 120, listPrice: 800_000 });

  await sales.reserveUnitForOpportunity(opportunity.id, unitOne.id, companyId);
  await assert.rejects(() => sales.reserveUnitForOpportunity(opportunity.id, unitTwo.id, companyId));
});

test('signContract rejects a reservation belonging to a different company (cross-tenant IDOR)', async () => {
  const app = await freshApp();
  const { crm, sales, inventory, paymentPlans } = app.services;
  const companyId = app.seedResult!.companyId;
  const agentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;

  const lead = await crm.createLead({ companyId, fullName: 'Client D', phone: '0555-0004', ownerEmployeeUserId: agentUserId });
  const opportunity = await sales.createOpportunity({ companyId, leadId: lead.id, ownerEmployeeUserId: agentUserId });
  const unit = await inventory.createUnit({ companyId, projectId: 'proj-1', code: 'B-205', unitType: 'apartment', areaSqm: 120, listPrice: 800_000 });
  const reservation = await sales.reserveUnitForOpportunity(opportunity.id, unit.id, companyId);
  const template = await paymentPlans.createTemplate({
    companyId,
    name: 'Cross Tenant Plan',
    downPaymentType: 'fixed',
    downPaymentValue: 50_000,
    frequency: 'monthly',
    termMonths: 6,
    fees: [],
  });

  await assert.rejects(() =>
    sales.signContract({
      companyId: 'other-company',
      reservationId: reservation.id,
      creditedEmployeeUserId: agentUserId,
      paymentPlanTemplateId: template.id,
      totalPrice: 800_000,
    }),
  );
});

test('cancelContract rejects a contract belonging to a different company (cross-tenant IDOR)', async () => {
  const app = await freshApp();
  const { crm, sales, inventory, paymentPlans } = app.services;
  const companyId = app.seedResult!.companyId;
  const agentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;

  const lead = await crm.createLead({ companyId, fullName: 'Client E', phone: '0555-0005', ownerEmployeeUserId: agentUserId });
  const opportunity = await sales.createOpportunity({ companyId, leadId: lead.id, ownerEmployeeUserId: agentUserId });
  const unit = await inventory.createUnit({ companyId, projectId: 'proj-1', code: 'B-206', unitType: 'apartment', areaSqm: 120, listPrice: 800_000 });
  const reservation = await sales.reserveUnitForOpportunity(opportunity.id, unit.id, companyId);
  const template = await paymentPlans.createTemplate({
    companyId,
    name: 'Cross Tenant Cancel Plan',
    downPaymentType: 'fixed',
    downPaymentValue: 50_000,
    frequency: 'monthly',
    termMonths: 6,
    fees: [],
  });
  const contract = await sales.signContract({
    companyId,
    reservationId: reservation.id,
    creditedEmployeeUserId: agentUserId,
    paymentPlanTemplateId: template.id,
    totalPrice: 800_000,
  });

  await assert.rejects(() => sales.cancelContract(contract.id, 'other-company'));
});

test('generating a payment schedule for the same contract twice is idempotent (no duplicate lines)', async () => {
  const app = await freshApp();
  const { paymentPlans } = app.services;
  const companyId = app.seedResult!.companyId;

  const template = await paymentPlans.createTemplate({
    companyId,
    name: 'Idempotency Test Plan',
    downPaymentType: 'percentage',
    downPaymentValue: 20,
    frequency: 'quarterly',
    termMonths: 12,
    fees: [],
  });

  const first = await paymentPlans.generateForContract('contract-idempotent', companyId, template.id, 500_000);
  const second = await paymentPlans.generateForContract('contract-idempotent', companyId, template.id, 500_000);
  assert.equal(first.length, second.length);
  assert.deepEqual(first.map((l) => l.id).sort(), second.map((l) => l.id).sort());
});

test('generateForContract rejects a template belonging to a different company (cross-tenant IDOR)', async () => {
  const app = await freshApp();
  const { paymentPlans } = app.services;
  const companyId = app.seedResult!.companyId;

  const template = await paymentPlans.createTemplate({
    companyId,
    name: 'Owner-Only Plan',
    downPaymentType: 'percentage',
    downPaymentValue: 15,
    frequency: 'monthly',
    termMonths: 6,
    fees: [],
  });

  await assert.rejects(() => paymentPlans.generateForContract('contract-x', 'other-company', template.id, 500_000));
});

test('previewSchedule rejects a template belonging to a different company (cross-tenant IDOR)', async () => {
  const app = await freshApp();
  const { paymentPlans } = app.services;
  const companyId = app.seedResult!.companyId;

  const template = await paymentPlans.createTemplate({
    companyId,
    name: 'Preview-Only Plan',
    downPaymentType: 'percentage',
    downPaymentValue: 15,
    frequency: 'monthly',
    termMonths: 6,
    fees: [],
  });

  await assert.rejects(() => paymentPlans.previewSchedule(template.id, 'other-company', 500_000));
});

test('generateForContract does not leak an already-generated schedule to a different company reusing the same contractId (idempotency-bypass IDOR)', async () => {
  const app = await freshApp();
  const { paymentPlans } = app.services;
  const companyId = app.seedResult!.companyId;

  const template = await paymentPlans.createTemplate({
    companyId,
    name: 'Owner Schedule Plan',
    downPaymentType: 'percentage',
    downPaymentValue: 15,
    frequency: 'monthly',
    termMonths: 6,
    fees: [],
  });

  const ownerLines = await paymentPlans.generateForContract('shared-contract-id', companyId, template.id, 500_000);
  assert.ok(ownerLines.length > 0);

  // A different company reusing the same contractId must never see the
  // owner's already-generated lines, even though the idempotency check
  // would otherwise short-circuit on contractId alone.
  await assert.rejects(() => paymentPlans.generateForContract('shared-contract-id', 'other-company', template.id, 500_000));
});

// ---- Contract-signing atomicity regression (audit-fix: a Contract must
// never be persisted with status 'signed' unless its payment schedule is
// already known to generate successfully — see signContract's own comment
// for the pre-flight-validate-before-write mechanism this locks in). ----

async function setupReservationForAtomicityTest() {
  const app = await freshApp();
  const { crm, sales, inventory, paymentPlans } = app.services;
  const companyId = app.seedResult!.companyId;
  const agentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;

  const lead = await crm.createLead({ companyId, fullName: 'Atomicity Test Client', phone: '0555-0099', ownerEmployeeUserId: agentUserId });
  const opportunity = await sales.createOpportunity({ companyId, leadId: lead.id, ownerEmployeeUserId: agentUserId });
  const unit = await inventory.createUnit({ companyId, projectId: 'proj-1', code: 'ATOMIC-1', unitType: 'apartment', areaSqm: 120, listPrice: 800_000 });
  const reservation = await sales.reserveUnitForOpportunity(opportunity.id, unit.id, companyId);
  const template = await paymentPlans.createTemplate({
    companyId,
    name: 'Atomicity Test Plan',
    downPaymentType: 'percentage',
    downPaymentValue: 10,
    frequency: 'monthly',
    termMonths: 12,
    fees: [],
  });
  return { app, companyId, agentUserId, unit, reservation, template };
}

test('signContract rejects a non-positive totalPrice and leaves no Contract, unit, or reservation state changed', async () => {
  const { app, companyId, agentUserId, unit, reservation, template } = await setupReservationForAtomicityTest();
  const { sales, inventory } = app.services;

  await assert.rejects(() =>
    sales.signContract({
      companyId,
      reservationId: reservation.id,
      creditedEmployeeUserId: agentUserId,
      paymentPlanTemplateId: template.id,
      totalPrice: -500,
    }),
  );

  // No orphaned Contract: nothing to find for this reservation.
  const contracts = await sales.listContracts(companyId);
  assert.equal(contracts.filter((c) => c.reservationId === reservation.id).length, 0);

  // The unit and reservation must be untouched — still exactly where they
  // were before the failed sign attempt, not left in a broken in-between
  // state.
  const refreshedUnit = await inventory.getUnit(unit.id);
  assert.equal(refreshedUnit!.status, 'reserved');
  const refreshedReservation = await inventory.getReservation(reservation.id);
  assert.equal(refreshedReservation!.status, 'active');
});

test('signContract rejects an out-of-range discountPercent and leaves no Contract, unit, or reservation state changed', async () => {
  const { app, companyId, agentUserId, unit, reservation, template } = await setupReservationForAtomicityTest();
  const { sales, inventory } = app.services;

  await assert.rejects(() =>
    sales.signContract({
      companyId,
      reservationId: reservation.id,
      creditedEmployeeUserId: agentUserId,
      paymentPlanTemplateId: template.id,
      totalPrice: 800_000,
      discountPercent: 150,
    }),
  );

  const contracts = await sales.listContracts(companyId);
  assert.equal(contracts.filter((c) => c.reservationId === reservation.id).length, 0);
  const refreshedUnit = await inventory.getUnit(unit.id);
  assert.equal(refreshedUnit!.status, 'reserved');
  const refreshedReservation = await inventory.getReservation(reservation.id);
  assert.equal(refreshedReservation!.status, 'active');
});

test('signContract still succeeds normally for a valid price/discount after the atomicity fix (no regression)', async () => {
  const { app, companyId, agentUserId, reservation, template } = await setupReservationForAtomicityTest();
  const { sales, paymentPlans } = app.services;

  const contract = await sales.signContract({
    companyId,
    reservationId: reservation.id,
    creditedEmployeeUserId: agentUserId,
    paymentPlanTemplateId: template.id,
    totalPrice: 800_000,
    discountPercent: 5,
  });

  assert.equal(contract.status, 'signed');
  const schedule = await paymentPlans.getScheduleForContract(contract.id, companyId);
  assert.ok(schedule.length > 1);
});

test('signContract with an invalid totalPrice via real HTTP: API rejects it and no Contract is created', async () => {
  const app = await freshApp();
  const server = app.httpServer.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  try {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'Content-Type': 'application/json', 'x-demo-user': ceoUserId };
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let parsed: unknown;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
      return { status: res.status, body: parsed };
    };

    const suffix = `${Date.now()}`;
    const project = await call('POST', '/api/inventory/projects', { name: `AtomicProj-${suffix}` });
    const unit = await call('POST', '/api/inventory/units', { projectId: (project.body as { id: string }).id, code: `ATOMIC-HTTP-${suffix}`, listPrice: 900_000, unitType: 'apartment', areaSqm: 130 });
    const template = await call('POST', '/api/payment-plan-templates', { name: `AtomicPlan-${suffix}`, downPaymentType: 'percentage', downPaymentValue: 10, frequency: 'monthly', termMonths: 12, fees: [] });
    const lead = await call('POST', '/api/crm/leads', { fullName: 'HTTP Atomicity Client', phone: `0555-${suffix}` });
    const opportunity = await call('POST', '/api/sales/opportunities', { leadId: (lead.body as { id: string }).id });
    const reserve = await call('POST', `/api/sales/opportunities/${(opportunity.body as { id: string }).id}/reserve-unit`, { unitId: (unit.body as { id: string }).id });
    const reservationId = (reserve.body as { id: string }).id;

    const signAttempt = await call('POST', '/api/sales/contracts', {
      reservationId,
      paymentPlanTemplateId: (template.body as { id: string }).id,
      totalPrice: 0,
    });
    assert.ok(signAttempt.status >= 400, `expected a 4xx rejection, got ${signAttempt.status}`);

    const contractsAfter = await call('GET', '/api/sales/contracts');
    const items = (contractsAfter.body as { items: Array<{ reservationId: string }> }).items;
    assert.equal(items.filter((c) => c.reservationId === reservationId).length, 0);
  } finally {
    await app.httpServer.close();
  }
});
