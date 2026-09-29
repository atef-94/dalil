import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { BrokersService } from './brokers.service.js';
import { CrmService } from '../crm/crm.service.js';
import { CrmStageService } from '../crm/crm-stage.service.js';
import type { BrokerCompany, BrokerLead, Commission, CommissionRule, Contract, CrmStage, Lead, Reservation } from '../../domain/types.js';

async function freshService() {
  const crmStages = new CrmStageService(new InMemoryRepository<CrmStage>());
  await crmStages.seedDefaultStages('c1');
  const crm = new CrmService(new InMemoryRepository<Lead>(), crmStages);
  const brokerLeads = new InMemoryRepository<BrokerLead>();
  const contracts = new InMemoryRepository<Contract>();
  const reservations = new InMemoryRepository<Reservation>();
  const svc = new BrokersService(
    new InMemoryRepository<BrokerCompany>(),
    brokerLeads,
    new InMemoryRepository<CommissionRule>(),
    new InMemoryRepository<Commission>(),
    crm,
    contracts,
    reservations,
  );
  return { svc, crm, brokerLeads, contracts, reservations };
}

/** Builds the full real chain recordCommissionForContract now validates
 * against: an approved BrokerLead -> a Reservation for that lead -> a
 * signed Contract for that reservation. Mirrors what SalesService.signContract
 * would have produced, just written directly since BrokersService doesn't
 * depend on SalesService. */
async function setupSignedContractForBroker(
  ctx: Awaited<ReturnType<typeof freshService>>,
  companyId: string,
  brokerCompanyId: string,
  opts: { totalPrice: number; discountPercent?: number; status?: Contract['status'] },
) {
  const brokerLead = await ctx.svc.submitBrokerLead({
    companyId,
    brokerCompanyId,
    submittedByUserId: 'broker-user-1',
    fullName: 'Referred Client',
    phone: `0${Math.floor(Math.random() * 1_000_000_000)}`,
  });
  const approved = await ctx.svc.approveBrokerLead(brokerLead.id, companyId, 'internal-user-1');
  const reservation = await ctx.reservations.save({
    id: `res-${approved.id}`,
    companyId,
    unitId: 'unit-1',
    clientId: approved.leadId!,
    status: 'converted',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const contract = await ctx.contracts.save({
    id: `contract-${approved.id}`,
    companyId,
    reservationId: reservation.id,
    unitId: reservation.unitId,
    clientId: reservation.clientId,
    creditedEmployeeUserId: 'agent-1',
    paymentPlanTemplateId: 'template-1',
    status: opts.status ?? 'signed',
    signedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    totalPrice: opts.totalPrice,
    discountPercent: opts.discountPercent,
  });
  return { brokerLead: approved, reservation, contract };
}

test('registering a broker company starts in pending status', async () => {
  const { svc } = await freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  assert.equal(company.status, 'pending');
});

test('approving a pending broker company transitions it to approved', async () => {
  const { svc } = await freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  const approved = await svc.approveBrokerCompany(company.id, 'c1');
  assert.equal(approved.status, 'approved');
});

test('approveBrokerCompany rejects a broker company belonging to a different company', async () => {
  const { svc } = await freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await assert.rejects(() => svc.approveBrokerCompany(company.id, 'c2'));
});

test('approving a non-pending broker company fails', async () => {
  const { svc } = await freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id, 'c1');
  await assert.rejects(() => svc.approveBrokerCompany(company.id, 'c1'));
});

test('suspending an approved broker company transitions it to suspended (distinct from rejected)', async () => {
  const { svc } = await freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id, 'c1');
  const suspended = await svc.suspendBrokerCompany(company.id, 'c1');
  assert.equal(suspended.status, 'suspended');
});

test('suspending a non-approved broker company fails', async () => {
  const { svc } = await freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await assert.rejects(() => svc.suspendBrokerCompany(company.id, 'c1'));
});

test('suspendBrokerCompany rejects a broker company belonging to a different company', async () => {
  const { svc } = await freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id, 'c1');
  await assert.rejects(() => svc.suspendBrokerCompany(company.id, 'c2'));
});

test('submitting a lead through an unapproved broker company is rejected', async () => {
  const { svc } = await freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await assert.rejects(() =>
    svc.submitBrokerLead({ companyId: 'c1', brokerCompanyId: company.id, submittedByUserId: 'broker-user-1', fullName: 'Client A', phone: '0100' }),
  );
});

test('quarantine gate: a submitted broker lead does not exist in the shared Lead table until approved', async () => {
  const { svc, crm } = await freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id, 'c1');
  const brokerLead = await svc.submitBrokerLead({ companyId: 'c1', brokerCompanyId: company.id, submittedByUserId: 'broker-user-1', fullName: 'Client A', phone: '0100' });

  const before = await crm.listForScope({ kind: 'company', companyId: 'c1' }, async () => ({}));
  assert.equal(before.length, 0);

  const approved = await svc.approveBrokerLead(brokerLead.id, 'c1', 'internal-user-1');
  assert.equal(approved.approvalStatus, 'approved');
  assert.ok(approved.leadId);

  const after = await crm.listForScope({ kind: 'company', companyId: 'c1' }, async () => ({}));
  assert.equal(after.length, 1);
});

test('submitBrokerLead sets a 60-day protection window', async () => {
  const { svc } = await freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id, 'c1');
  const before = Date.now();
  const brokerLead = await svc.submitBrokerLead({ companyId: 'c1', brokerCompanyId: company.id, submittedByUserId: 'broker-user-1', fullName: 'Client A', phone: '0100' });
  const days = (Date.parse(brokerLead.protectionExpiresAt) - before) / (24 * 60 * 60 * 1000);
  assert.ok(days > 59.9 && days < 60.1, `expected ~60 days, got ${days}`);
});

test('a second broker company cannot register the same prospect (by phone) while the first submission is still protected', async () => {
  const { svc } = await freshService();
  const companyA = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Broker A' });
  const companyB = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Broker B' });
  await svc.approveBrokerCompany(companyA.id, 'c1');
  await svc.approveBrokerCompany(companyB.id, 'c1');

  await svc.submitBrokerLead({ companyId: 'c1', brokerCompanyId: companyA.id, submittedByUserId: 'broker-user-a', fullName: 'Shared Prospect', phone: '0100' });
  await assert.rejects(
    () => svc.submitBrokerLead({ companyId: 'c1', brokerCompanyId: companyB.id, submittedByUserId: 'broker-user-b', fullName: 'Same Prospect Different Name', phone: '0100' }),
    /protected/i,
  );
});

test('the same broker company can re-submit the same prospect (protection blocks other brokers, not itself)', async () => {
  const { svc } = await freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Broker A' });
  await svc.approveBrokerCompany(company.id, 'c1');
  await svc.submitBrokerLead({ companyId: 'c1', brokerCompanyId: company.id, submittedByUserId: 'broker-user-a', fullName: 'Prospect', phone: '0100' });
  const second = await svc.submitBrokerLead({ companyId: 'c1', brokerCompanyId: company.id, submittedByUserId: 'broker-user-a', fullName: 'Prospect', phone: '0100' });
  assert.ok(second.id);
});

test('a second broker company CAN register the same prospect once the first submission was rejected', async () => {
  const { svc, crm } = await freshService();
  const companyA = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Broker A' });
  const companyB = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Broker B' });
  await svc.approveBrokerCompany(companyA.id, 'c1');
  await svc.approveBrokerCompany(companyB.id, 'c1');
  await crm.createLead({ companyId: 'c1', fullName: 'Existing Client', phone: '0100' });

  const first = await svc.submitBrokerLead({ companyId: 'c1', brokerCompanyId: companyA.id, submittedByUserId: 'broker-user-a', fullName: 'Prospect', phone: '0100' });
  // Rejected because the phone already matches a real Lead (quarantine dedup) — this also frees the protection.
  await assert.rejects(() => svc.approveBrokerLead(first.id, 'c1', 'internal-user-1'));

  const second = await svc.submitBrokerLead({ companyId: 'c1', brokerCompanyId: companyB.id, submittedByUserId: 'broker-user-b', fullName: 'Prospect', phone: '0100' });
  assert.ok(second.id);
});

test('a second broker company CAN register the same prospect once the first submission\'s protection window has expired', async () => {
  const { svc, brokerLeads } = await freshService();
  const companyA = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Broker A' });
  const companyB = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Broker B' });
  await svc.approveBrokerCompany(companyA.id, 'c1');
  await svc.approveBrokerCompany(companyB.id, 'c1');

  const first = await svc.submitBrokerLead({ companyId: 'c1', brokerCompanyId: companyA.id, submittedByUserId: 'broker-user-a', fullName: 'Prospect', phone: '0100' });
  // Simulate the window having already elapsed, without waiting 60 real days.
  await brokerLeads.save({ ...first, protectionExpiresAt: new Date(Date.now() - 1000).toISOString() });

  const second = await svc.submitBrokerLead({ companyId: 'c1', brokerCompanyId: companyB.id, submittedByUserId: 'broker-user-b', fullName: 'Prospect', phone: '0100' });
  assert.ok(second.id);
});

test('approveBrokerLead rejects a broker lead belonging to a different company', async () => {
  const { svc } = await freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id, 'c1');
  const brokerLead = await svc.submitBrokerLead({ companyId: 'c1', brokerCompanyId: company.id, submittedByUserId: 'broker-user-1', fullName: 'Client A', phone: '0100' });
  await assert.rejects(() => svc.approveBrokerLead(brokerLead.id, 'c2', 'internal-user-1'));
});

test('approving a broker lead with a duplicate phone is rejected, not merged', async () => {
  const { svc, crm } = await freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id, 'c1');
  await crm.createLead({ companyId: 'c1', fullName: 'Existing Client', phone: '0100' });

  const brokerLead = await svc.submitBrokerLead({ companyId: 'c1', brokerCompanyId: company.id, submittedByUserId: 'broker-user-1', fullName: 'Client A', phone: '0100' });
  await assert.rejects(() => svc.approveBrokerLead(brokerLead.id, 'c1', 'internal-user-1'));

  const leads = await crm.listForScope({ kind: 'company', companyId: 'c1' }, async () => ({}));
  assert.equal(leads.length, 1); // still just the original, not merged or duplicated
});

test('approving a broker lead with a duplicate national ID (different phone/email) is rejected, not merged', async () => {
  const { svc, crm } = await freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id, 'c1');
  await crm.createLead({ companyId: 'c1', fullName: 'Existing Client', phone: '0100', nationalId: 'NID-1' });

  const brokerLead = await svc.submitBrokerLead({
    companyId: 'c1',
    brokerCompanyId: company.id,
    submittedByUserId: 'broker-user-1',
    fullName: 'Same client, fake details',
    phone: '0999',
    email: 'fake@x.com',
    nationalId: 'NID-1',
  });
  await assert.rejects(() => svc.approveBrokerLead(brokerLead.id, 'c1', 'internal-user-1'));

  const leads = await crm.listForScope({ kind: 'company', companyId: 'c1' }, async () => ({}));
  assert.equal(leads.length, 1);
});

test('commission rate resolution: a broker-specific rule takes precedence over the company default', async () => {
  const ctx = await freshService();
  const { svc } = ctx;
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id, 'c1');
  await svc.setCommissionRule('c1', 2); // company-wide default
  await svc.setCommissionRule('c1', 5, company.id); // broker-specific
  const { contract } = await setupSignedContractForBroker(ctx, 'c1', company.id, { totalPrice: 100_000 });
  const commission = await svc.recordCommissionForContract('c1', company.id, contract.id);
  assert.equal(commission.amount, 5000);
});

test('recordCommissionForContract computes the amount from the contract\'s own netContractValue (totalPrice minus discount), never a caller-supplied figure', async () => {
  const ctx = await freshService();
  const { svc } = ctx;
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id, 'c1');
  await svc.setCommissionRule('c1', 10);
  const { contract } = await setupSignedContractForBroker(ctx, 'c1', company.id, { totalPrice: 200_000, discountPercent: 10 });
  const commission = await svc.recordCommissionForContract('c1', company.id, contract.id);
  // net = 200_000 * 0.9 = 180_000; commission = 10% of that = 18_000
  assert.equal(commission.amount, 18_000);
});

test('commission approval transitions pending to approved', async () => {
  const ctx = await freshService();
  const { svc } = ctx;
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id, 'c1');
  await svc.setCommissionRule('c1', 3);
  const { contract } = await setupSignedContractForBroker(ctx, 'c1', company.id, { totalPrice: 100_000 });
  const commission = await svc.recordCommissionForContract('c1', company.id, contract.id);
  assert.equal(commission.status, 'pending');
  const approved = await svc.approveCommission(commission.id, 'c1');
  assert.equal(approved.status, 'approved');
});

test('recordCommissionForContract rejects a broker company belonging to a different company', async () => {
  const ctx = await freshService();
  const { svc } = ctx;
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id, 'c1');
  await svc.setCommissionRule('c1', 3);
  const { contract } = await setupSignedContractForBroker(ctx, 'c1', company.id, { totalPrice: 100_000 });
  await assert.rejects(() => svc.recordCommissionForContract('c2', company.id, contract.id));
});

test('approveCommission rejects a commission belonging to a different company', async () => {
  const ctx = await freshService();
  const { svc } = ctx;
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id, 'c1');
  await svc.setCommissionRule('c1', 3);
  const { contract } = await setupSignedContractForBroker(ctx, 'c1', company.id, { totalPrice: 100_000 });
  const commission = await svc.recordCommissionForContract('c1', company.id, contract.id);
  await assert.rejects(() => svc.approveCommission(commission.id, 'c2'));
});

// ---- Section 6 fix: recordCommissionForContract validates against a real signed Contract ----

test('recordCommissionForContract rejects a contract that does not exist', async () => {
  const ctx = await freshService();
  const { svc } = ctx;
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id, 'c1');
  await svc.setCommissionRule('c1', 3);
  await assert.rejects(() => svc.recordCommissionForContract('c1', company.id, 'nonexistent-contract'));
});

test('recordCommissionForContract rejects a contract belonging to a different company (cross-tenant)', async () => {
  const ctx = await freshService();
  const { svc, contracts } = ctx;
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id, 'c1');
  await svc.setCommissionRule('c1', 3);
  const { contract } = await setupSignedContractForBroker(ctx, 'c1', company.id, { totalPrice: 100_000 });
  await contracts.save({ ...contract, companyId: 'other-company' });
  await assert.rejects(() => svc.recordCommissionForContract('c1', company.id, contract.id));
});

test('recordCommissionForContract rejects a contract that is not signed (e.g. draft or cancelled)', async () => {
  const ctx = await freshService();
  const { svc } = ctx;
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id, 'c1');
  await svc.setCommissionRule('c1', 3);
  const { contract } = await setupSignedContractForBroker(ctx, 'c1', company.id, { totalPrice: 100_000, status: 'cancelled' });
  await assert.rejects(() => svc.recordCommissionForContract('c1', company.id, contract.id), /signed/);
});

test('recordCommissionForContract rejects a signed contract whose client is not a lead this broker company actually registered (no relationship)', async () => {
  const ctx = await freshService();
  const { svc, crm, contracts, reservations } = ctx;
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id, 'c1');
  await svc.setCommissionRule('c1', 3);
  // A contract for an internally-sourced lead this broker never submitted.
  const internalLead = await crm.createLead({ companyId: 'c1', fullName: 'Walk-in Client', phone: '0777' });
  const reservation = await reservations.save({
    id: 'res-internal', companyId: 'c1', unitId: 'unit-x', clientId: internalLead.id, status: 'converted',
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const contract = await contracts.save({
    id: 'contract-internal', companyId: 'c1', reservationId: reservation.id, unitId: reservation.unitId,
    clientId: reservation.clientId, creditedEmployeeUserId: 'agent-1', paymentPlanTemplateId: 'template-1',
    status: 'signed', signedAt: new Date().toISOString(), createdAt: new Date().toISOString(), totalPrice: 100_000,
  });
  await assert.rejects(() => svc.recordCommissionForContract('c1', company.id, contract.id), /relationship/);
});

test('recordCommissionForContract rejects recording a second commission for the same contract', async () => {
  const ctx = await freshService();
  const { svc } = ctx;
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id, 'c1');
  await svc.setCommissionRule('c1', 3);
  const { contract } = await setupSignedContractForBroker(ctx, 'c1', company.id, { totalPrice: 100_000 });
  await svc.recordCommissionForContract('c1', company.id, contract.id);
  await assert.rejects(() => svc.recordCommissionForContract('c1', company.id, contract.id));
});
