import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { AuditLog } from '../../infra/audit-log.js';
import { CrmService } from './crm.service.js';
import { LeadTimelineService } from './lead-timeline.service.js';
import type { AuditLogEntry, Contract, Lead, Message, Opportunity, Task } from '../../domain/types.js';

function freshHarness() {
  const leads = new InMemoryRepository<Lead>();
  const auditEntries = new InMemoryRepository<AuditLogEntry>();
  const messages = new InMemoryRepository<Message>();
  const tasks = new InMemoryRepository<Task>();
  const opportunities = new InMemoryRepository<Opportunity>();
  const contracts = new InMemoryRepository<Contract>();
  const crm = new CrmService(leads);
  const auditLog = new AuditLog(auditEntries);
  const svc = new LeadTimelineService(leads, auditEntries, messages, tasks, opportunities, contracts);
  return { leads, auditEntries, messages, tasks, opportunities, contracts, crm, auditLog, svc };
}

test('getTimeline rejects a lead from a different company', async () => {
  const h = freshHarness();
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'A', phone: '01' });
  await assert.rejects(() => h.svc.getTimeline(lead.id, 'c2'));
});

test('getTimeline always includes a lead_created entry as the first entry', async () => {
  const h = freshHarness();
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'A', phone: '01', sourceId: 'website' });
  const timeline = await h.svc.getTimeline(lead.id, 'c1');
  assert.equal(timeline.entries[0]!.type, 'lead_created');
  assert.match(timeline.entries[0]!.summary, /website/);
});

test('getTimeline surfaces status changes from the audit trail, oldest first', async () => {
  const h = freshHarness();
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'A', phone: '01' });
  await h.crm.updateStatus(lead.id, 'contacted');
  await h.auditLog.record({ companyId: 'c1', actorUserId: 'u1', action: 'edit', resource: 'lead', resourceId: lead.id, metadata: { fromStatus: 'new', toStatus: 'contacted' } });
  await h.crm.updateStatus(lead.id, 'qualified');
  await h.auditLog.record({ companyId: 'c1', actorUserId: 'u1', action: 'edit', resource: 'lead', resourceId: lead.id, metadata: { fromStatus: 'contacted', toStatus: 'qualified' } });

  const timeline = await h.svc.getTimeline(lead.id, 'c1');
  const statusEntries = timeline.entries.filter((e) => e.type === 'status_changed');
  assert.equal(statusEntries.length, 2);
  assert.match(statusEntries[0]!.summary, /contacted/);
  assert.match(statusEntries[1]!.summary, /qualified/);
});

test('getTimeline includes messages, tasks, opportunities, and signed contracts', async () => {
  const h = freshHarness();
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'A', phone: '01' });
  await h.messages.save({ id: 'm1', companyId: 'c1', relatedResource: 'lead', relatedResourceId: lead.id, fromUserId: 'u1', subject: 'Hello', body: 'hi', channel: 'internal', status: 'sent', createdAt: new Date().toISOString() });
  await h.tasks.save({ id: 't1', companyId: 'c1', relatedResource: 'lead', relatedResourceId: lead.id, title: 'Follow up', status: 'open', createdByUserId: 'u1', createdAt: new Date().toISOString() });
  await h.opportunities.save({ id: 'o1', companyId: 'c1', leadId: lead.id, ownerEmployeeUserId: 'u1', stage: 'open', createdAt: new Date().toISOString() });
  await h.contracts.save({ id: 'ct1', companyId: 'c1', reservationId: 'r1', unitId: 'unit1', clientId: lead.id, creditedEmployeeUserId: 'u1', paymentPlanTemplateId: 'tpl1', status: 'signed', signedAt: new Date().toISOString(), createdAt: new Date().toISOString() });

  const timeline = await h.svc.getTimeline(lead.id, 'c1');
  const types = timeline.entries.map((e) => e.type);
  assert.ok(types.includes('message'));
  assert.ok(types.includes('task'));
  assert.ok(types.includes('opportunity_created'));
  assert.ok(types.includes('contract_signed'));
});

test('getTimeline uses the real cancellation audit timestamp for a cancelled contract, not the contract creation time', async () => {
  const h = freshHarness();
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'A', phone: '01' });
  const createdAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
  await h.contracts.save({ id: 'ct1', companyId: 'c1', reservationId: 'r1', unitId: 'unit1', clientId: lead.id, creditedEmployeeUserId: 'u1', paymentPlanTemplateId: 'tpl1', status: 'cancelled', createdAt });
  const cancelledAt = new Date('2026-02-01T00:00:00.000Z').toISOString();
  await h.auditEntries.save({ id: 'a1', companyId: 'c1', actorUserId: 'u1', action: 'edit', resource: 'contract', resourceId: 'ct1', metadata: { cancelled: true }, createdAt: cancelledAt });

  const timeline = await h.svc.getTimeline(lead.id, 'c1');
  const cancelEntry = timeline.entries.find((e) => e.type === 'contract_cancelled');
  assert.equal(cancelEntry!.at, cancelledAt);
});

test('updateCustomFields merges progressively without clobbering fields not mentioned in a later call', async () => {
  const h = freshHarness();
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'A', phone: '01' });
  await h.crm.updateCustomFields(lead.id, 'c1', { propertyTypeWanted: 'apartment', minAreaSqm: 100, maxAreaSqm: 150 });
  const updated = await h.crm.updateCustomFields(lead.id, 'c1', { maxDownPayment: 500000 });
  assert.equal(updated.propertyTypeWanted, 'apartment');
  assert.equal(updated.minAreaSqm, 100);
  assert.equal(updated.maxDownPayment, 500000);
});

test('updateCustomFields rejects a negative numeric value', async () => {
  const h = freshHarness();
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'A', phone: '01' });
  await assert.rejects(() => h.crm.updateCustomFields(lead.id, 'c1', { maxDownPayment: -1 }));
});

test('updateCustomFields rejects minAreaSqm greater than maxAreaSqm', async () => {
  const h = freshHarness();
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'A', phone: '01' });
  await assert.rejects(() => h.crm.updateCustomFields(lead.id, 'c1', { minAreaSqm: 200, maxAreaSqm: 100 }));
});

test('updateCustomFields rejects a lead from a different company', async () => {
  const h = freshHarness();
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'A', phone: '01' });
  await assert.rejects(() => h.crm.updateCustomFields(lead.id, 'c2', { propertyTypeWanted: 'villa' }));
});

test('createLead persists custom fields set at creation time', async () => {
  const h = freshHarness();
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'A', phone: '01', propertyTypeWanted: 'villa', preferredTenorMonths: 24 });
  assert.equal(lead.propertyTypeWanted, 'villa');
  assert.equal(lead.preferredTenorMonths, 24);
});
