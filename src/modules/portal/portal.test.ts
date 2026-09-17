import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { PortalService } from './portal.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { Contract, Customer, Lead, LegalDocument, Message, Opportunity, PaymentScheduleLine, Task, User } from '../../domain/types.js';

function freshService() {
  const customers = new InMemoryRepository<Customer>();
  const leads = new InMemoryRepository<Lead>();
  const contracts = new InMemoryRepository<Contract>();
  const scheduleLines = new InMemoryRepository<PaymentScheduleLine>();
  const users = new InMemoryRepository<User>();
  const auth = new AuthService(users, 'test-secret');
  const opportunities = new InMemoryRepository<Opportunity>();
  const legalDocuments = new InMemoryRepository<LegalDocument>();
  const messages = new InMemoryRepository<Message>();
  const tasks = new InMemoryRepository<Task>();
  const svc = new PortalService(customers, leads, contracts, scheduleLines, auth, opportunities, legalDocuments, messages, tasks);
  return { svc, leads, contracts, scheduleLines, users, opportunities, legalDocuments, messages, tasks };
}

async function seedLead(leads: InMemoryRepository<Lead>, companyId = 'c1'): Promise<Lead> {
  return leads.save({ id: 'lead-1', companyId, fullName: 'Portal Client', phone: '0555-1234', status: 'opportunity', createdAt: new Date().toISOString() });
}

test('granting portal access for a nonexistent lead is rejected', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.grantPortalAccess({ companyId: 'c1', leadId: 'nope', email: 'client@example.com', password: 'password123' }));
});

test('granting portal access for a lead belonging to a different company is rejected (cross-tenant)', async () => {
  const { svc, leads } = freshService();
  await seedLead(leads, 'c1');
  await assert.rejects(() => svc.grantPortalAccess({ companyId: 'c2', leadId: 'lead-1', email: 'client@example.com', password: 'password123' }));
});

test('granting portal access twice for the same lead is rejected', async () => {
  const { svc, leads } = freshService();
  await seedLead(leads);
  await svc.grantPortalAccess({ companyId: 'c1', leadId: 'lead-1', email: 'client@example.com', password: 'password123' });
  await assert.rejects(() => svc.grantPortalAccess({ companyId: 'c1', leadId: 'lead-1', email: 'client2@example.com', password: 'password123' }));
});

test('listCustomers returns only this company\'s customers', async () => {
  const { svc, leads } = freshService();
  await seedLead(leads, 'c1');
  await leads.save({ id: 'lead-2', companyId: 'c2', fullName: 'Other Co Client', phone: '0555-9999', status: 'opportunity', createdAt: new Date().toISOString() });
  await svc.grantPortalAccess({ companyId: 'c1', leadId: 'lead-1', email: 'client@example.com', password: 'password123' });
  await svc.grantPortalAccess({ companyId: 'c2', leadId: 'lead-2', email: 'other@example.com', password: 'password123' });

  const c1Customers = await svc.listCustomers('c1');
  assert.equal(c1Customers.length, 1);
  assert.equal(c1Customers[0]!.fullName, 'Portal Client');
});

test('a customer can see only their own contracts', async () => {
  const { svc, leads, contracts } = freshService();
  await seedLead(leads);
  const { customer } = await svc.grantPortalAccess({ companyId: 'c1', leadId: 'lead-1', email: 'client@example.com', password: 'password123' });
  await contracts.save({ id: 'contract-1', companyId: 'c1', reservationId: 'r1', unitId: 'u1', clientId: 'lead-1', creditedEmployeeUserId: 'e1', paymentPlanTemplateId: 't1', status: 'signed', createdAt: new Date().toISOString() });
  await contracts.save({ id: 'contract-2', companyId: 'c1', reservationId: 'r2', unitId: 'u2', clientId: 'other-lead', creditedEmployeeUserId: 'e1', paymentPlanTemplateId: 't1', status: 'signed', createdAt: new Date().toISOString() });
  const myContracts = await svc.myContracts(customer.id, 'c1');
  assert.equal(myContracts.length, 1);
  assert.equal(myContracts[0]!.id, 'contract-1');
});

test('myContracts rejects a customer belonging to a different company (cross-tenant)', async () => {
  const { svc, leads } = freshService();
  await seedLead(leads);
  const { customer } = await svc.grantPortalAccess({ companyId: 'c1', leadId: 'lead-1', email: 'client@example.com', password: 'password123' });
  await assert.rejects(() => svc.myContracts(customer.id, 'c2'));
});

test('myContractSchedule rejects a contract that does not belong to this customer (cross-account IDOR)', async () => {
  const { svc, leads, contracts, scheduleLines } = freshService();
  await seedLead(leads);
  const { customer } = await svc.grantPortalAccess({ companyId: 'c1', leadId: 'lead-1', email: 'client@example.com', password: 'password123' });
  await contracts.save({ id: 'contract-2', companyId: 'c1', reservationId: 'r2', unitId: 'u2', clientId: 'other-lead', creditedEmployeeUserId: 'e1', paymentPlanTemplateId: 't1', status: 'signed', createdAt: new Date().toISOString() });
  await scheduleLines.save({ id: 's1', companyId: 'c1', contractId: 'contract-2', sourceTemplateId: 't1', sourceTemplateVersion: 1, sequence: 0, label: 'Down payment', dueDate: new Date().toISOString(), amount: 1000, amountPaid: 0, status: 'upcoming' });
  await assert.rejects(() => svc.myContractSchedule(customer.id, 'c1', 'contract-2'));
});

test('myContractSchedule returns sorted lines for the customer\'s own contract', async () => {
  const { svc, leads, contracts, scheduleLines } = freshService();
  await seedLead(leads);
  const { customer } = await svc.grantPortalAccess({ companyId: 'c1', leadId: 'lead-1', email: 'client@example.com', password: 'password123' });
  await contracts.save({ id: 'contract-1', companyId: 'c1', reservationId: 'r1', unitId: 'u1', clientId: 'lead-1', creditedEmployeeUserId: 'e1', paymentPlanTemplateId: 't1', status: 'signed', createdAt: new Date().toISOString() });
  await scheduleLines.save({ id: 's2', companyId: 'c1', contractId: 'contract-1', sourceTemplateId: 't1', sourceTemplateVersion: 1, sequence: 1, label: 'Installment 1', dueDate: new Date().toISOString(), amount: 500, amountPaid: 0, status: 'upcoming' });
  await scheduleLines.save({ id: 's1', companyId: 'c1', contractId: 'contract-1', sourceTemplateId: 't1', sourceTemplateVersion: 1, sequence: 0, label: 'Down payment', dueDate: new Date().toISOString(), amount: 1000, amountPaid: 0, status: 'upcoming' });
  const schedule = await svc.myContractSchedule(customer.id, 'c1', 'contract-1');
  assert.equal(schedule.length, 2);
  assert.equal(schedule[0]!.label, 'Down payment');
});

test('getCustomer360 rejects a nonexistent customer', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.getCustomer360('nope', 'c1'));
});

test('getCustomer360 rejects a customer belonging to a different company (cross-tenant)', async () => {
  const { svc, leads } = freshService();
  await seedLead(leads);
  const { customer } = await svc.grantPortalAccess({ companyId: 'c1', leadId: 'lead-1', email: 'client@example.com', password: 'password123' });
  await assert.rejects(() => svc.getCustomer360(customer.id, 'c2'));
});

test('getCustomer360 aggregates opportunities, contracts, schedules, legal documents, messages, and tasks for this customer only', async () => {
  const { svc, leads, contracts, scheduleLines, opportunities, legalDocuments, messages, tasks } = freshService();
  await seedLead(leads);
  const { customer } = await svc.grantPortalAccess({ companyId: 'c1', leadId: 'lead-1', email: 'client@example.com', password: 'password123' });

  await opportunities.save({ id: 'opp-1', companyId: 'c1', leadId: 'lead-1', ownerEmployeeUserId: 'e1', stage: 'open', createdAt: new Date().toISOString() });
  await opportunities.save({ id: 'opp-other', companyId: 'c1', leadId: 'other-lead', ownerEmployeeUserId: 'e1', stage: 'open', createdAt: new Date().toISOString() });

  await contracts.save({ id: 'contract-1', companyId: 'c1', reservationId: 'r1', unitId: 'u1', clientId: 'lead-1', creditedEmployeeUserId: 'e1', paymentPlanTemplateId: 't1', status: 'signed', createdAt: new Date().toISOString() });
  await scheduleLines.save({ id: 's1', companyId: 'c1', contractId: 'contract-1', sourceTemplateId: 't1', sourceTemplateVersion: 1, sequence: 0, label: 'Down payment', dueDate: new Date().toISOString(), amount: 1000, amountPaid: 0, status: 'upcoming' });
  await legalDocuments.save({ id: 'doc-1', companyId: 'c1', contractId: 'contract-1', type: 'title_deed', name: 'Title deed', status: 'pending', uploadedByUserId: 'e1', createdAt: new Date().toISOString() });

  await messages.save({ id: 'msg-1', companyId: 'c1', fromUserId: 'e1', subject: 'Welcome', body: 'hi', channel: 'email', status: 'sent', relatedResource: 'lead', relatedResourceId: 'lead-1', createdAt: new Date().toISOString() });
  await messages.save({ id: 'msg-other', companyId: 'c1', fromUserId: 'e1', subject: 'Unrelated', body: 'hi', channel: 'email', status: 'sent', relatedResource: 'lead', relatedResourceId: 'other-lead', createdAt: new Date().toISOString() });

  await tasks.save({ id: 'task-1', companyId: 'c1', title: 'Follow up', relatedResource: 'lead', relatedResourceId: 'lead-1', status: 'open', createdByUserId: 'e1', createdAt: new Date().toISOString() });

  const profile = await svc.getCustomer360(customer.id, 'c1');
  assert.equal(profile.lead?.id, 'lead-1');
  assert.equal(profile.opportunities.length, 1);
  assert.equal(profile.opportunities[0]!.id, 'opp-1');
  assert.equal(profile.contracts.length, 1);
  assert.equal(profile.scheduleByContract.length, 1);
  assert.equal(profile.scheduleByContract[0]!.lines.length, 1);
  assert.equal(profile.legalDocuments.length, 1);
  assert.equal(profile.messages.length, 1);
  assert.equal(profile.messages[0]!.id, 'msg-1');
  assert.equal(profile.tasks.length, 1);
});
