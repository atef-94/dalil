import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { BrokersService } from './brokers.service.js';
import { CrmService } from '../crm/crm.service.js';
import type { BrokerCompany, BrokerLead, Commission, CommissionRule, Lead } from '../../domain/types.js';

function freshService() {
  const crm = new CrmService(new InMemoryRepository<Lead>());
  const svc = new BrokersService(
    new InMemoryRepository<BrokerCompany>(),
    new InMemoryRepository<BrokerLead>(),
    new InMemoryRepository<CommissionRule>(),
    new InMemoryRepository<Commission>(),
    crm,
  );
  return { svc, crm };
}

test('registering a broker company starts in pending status', async () => {
  const { svc } = freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  assert.equal(company.status, 'pending');
});

test('approving a pending broker company transitions it to approved', async () => {
  const { svc } = freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  const approved = await svc.approveBrokerCompany(company.id);
  assert.equal(approved.status, 'approved');
});

test('approving a non-pending broker company fails', async () => {
  const { svc } = freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id);
  await assert.rejects(() => svc.approveBrokerCompany(company.id));
});

test('suspending an approved broker company transitions it to suspended (distinct from rejected)', async () => {
  const { svc } = freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id);
  const suspended = await svc.suspendBrokerCompany(company.id);
  assert.equal(suspended.status, 'suspended');
});

test('suspending a non-approved broker company fails', async () => {
  const { svc } = freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await assert.rejects(() => svc.suspendBrokerCompany(company.id));
});

test('submitting a lead through an unapproved broker company is rejected', async () => {
  const { svc } = freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await assert.rejects(() =>
    svc.submitBrokerLead({ companyId: 'c1', brokerCompanyId: company.id, submittedByUserId: 'broker-user-1', fullName: 'Client A', phone: '0100' }),
  );
});

test('quarantine gate: a submitted broker lead does not exist in the shared Lead table until approved', async () => {
  const { svc, crm } = freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id);
  const brokerLead = await svc.submitBrokerLead({ companyId: 'c1', brokerCompanyId: company.id, submittedByUserId: 'broker-user-1', fullName: 'Client A', phone: '0100' });

  const before = await crm.listForScope({ kind: 'company', companyId: 'c1' }, async () => ({}));
  assert.equal(before.length, 0);

  const approved = await svc.approveBrokerLead(brokerLead.id, 'internal-user-1');
  assert.equal(approved.approvalStatus, 'approved');
  assert.ok(approved.leadId);

  const after = await crm.listForScope({ kind: 'company', companyId: 'c1' }, async () => ({}));
  assert.equal(after.length, 1);
});

test('approving a broker lead with a duplicate phone is rejected, not merged', async () => {
  const { svc, crm } = freshService();
  const company = await svc.registerBrokerCompany({ companyId: 'c1', name: 'Acme Brokers' });
  await svc.approveBrokerCompany(company.id);
  await crm.createLead({ companyId: 'c1', fullName: 'Existing Client', phone: '0100' });

  const brokerLead = await svc.submitBrokerLead({ companyId: 'c1', brokerCompanyId: company.id, submittedByUserId: 'broker-user-1', fullName: 'Client A', phone: '0100' });
  await assert.rejects(() => svc.approveBrokerLead(brokerLead.id, 'internal-user-1'));

  const leads = await crm.listForScope({ kind: 'company', companyId: 'c1' }, async () => ({}));
  assert.equal(leads.length, 1); // still just the original, not merged or duplicated
});

test('commission rate resolution: a broker-specific rule takes precedence over the company default', async () => {
  const { svc } = freshService();
  await svc.setCommissionRule('c1', 2); // company-wide default
  await svc.setCommissionRule('c1', 5, 'broker-co-1'); // broker-specific
  const commission = await svc.recordCommissionForContract('c1', 'broker-co-1', 'contract-1', 100_000);
  assert.equal(commission.amount, 5000);
});

test('commission approval transitions pending to approved', async () => {
  const { svc } = freshService();
  await svc.setCommissionRule('c1', 3);
  const commission = await svc.recordCommissionForContract('c1', 'broker-co-1', 'contract-1', 100_000);
  assert.equal(commission.status, 'pending');
  const approved = await svc.approveCommission(commission.id);
  assert.equal(approved.status, 'approved');
});
