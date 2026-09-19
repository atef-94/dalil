import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { AuditLog } from '../../infra/audit-log.js';
import { CrmService } from './crm.service.js';
import { CrmStageService } from './crm-stage.service.js';
import { LeadTimelineService } from './lead-timeline.service.js';
import type { AuditLogEntry, Contract, CrmStage, Lead, Message, Opportunity, Task } from '../../domain/types.js';

async function freshHarness(companyId = 'c1') {
  const leads = new InMemoryRepository<Lead>();
  const auditEntries = new InMemoryRepository<AuditLogEntry>();
  const messages = new InMemoryRepository<Message>();
  const tasks = new InMemoryRepository<Task>();
  const opportunities = new InMemoryRepository<Opportunity>();
  const contracts = new InMemoryRepository<Contract>();
  const crmStages = new CrmStageService(new InMemoryRepository<CrmStage>());
  await crmStages.seedDefaultStages(companyId);
  const crm = new CrmService(leads, crmStages);
  const auditLog = new AuditLog(auditEntries);
  const svc = new LeadTimelineService(leads, auditEntries, messages, tasks, opportunities, contracts);
  return { leads, auditEntries, messages, tasks, opportunities, contracts, crm, crmStages, auditLog, svc };
}

async function stageByKey(crmStages: CrmStageService, companyId: string, key: string): Promise<CrmStage> {
  const stages = await crmStages.listStages(companyId, true);
  const stage = stages.find((s) => s.key === key);
  if (!stage) throw new Error(`no seeded stage with key "${key}" for ${companyId}`);
  return stage;
}

test('getTimeline rejects a lead from a different company', async () => {
  const h = await freshHarness();
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'A', phone: '01' });
  await assert.rejects(() => h.svc.getTimeline(lead.id, 'c2'));
});

test('getTimeline always includes a lead_created entry as the first entry', async () => {
  const h = await freshHarness();
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'A', phone: '01', sourceId: 'website' });
  const timeline = await h.svc.getTimeline(lead.id, 'c1');
  assert.equal(timeline.entries[0]!.type, 'lead_created');
  assert.match(timeline.entries[0]!.summary, /website/);
});

test('getTimeline surfaces stage changes from the audit trail, oldest first', async () => {
  const h = await freshHarness();
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'A', phone: '01' });
  const contacted = await stageByKey(h.crmStages, 'c1', 'contacted');
  const qualified = await stageByKey(h.crmStages, 'c1', 'qualified');

  // Mirrors exactly what the PATCH /api/crm/leads/:leadId/stage route
  // writes: toStatus carries the new stage's display name (not a legacy
  // enum value) purely so LeadTimelineService's unmodified toStatus
  // detection still renders a readable entry — see app.ts.
  await h.crm.moveToStage(lead.id, 'c1', contacted.id);
  await h.auditLog.record({ companyId: 'c1', actorUserId: 'u1', action: 'edit', resource: 'lead', resourceId: lead.id, metadata: { toStageId: contacted.id, toStatus: contacted.name } });
  await h.crm.moveToStage(lead.id, 'c1', qualified.id);
  await h.auditLog.record({ companyId: 'c1', actorUserId: 'u1', action: 'edit', resource: 'lead', resourceId: lead.id, metadata: { toStageId: qualified.id, toStatus: qualified.name } });

  const timeline = await h.svc.getTimeline(lead.id, 'c1');
  const statusEntries = timeline.entries.filter((e) => e.type === 'status_changed');
  assert.equal(statusEntries.length, 2);
  assert.match(statusEntries[0]!.summary, /Contacted/);
  assert.match(statusEntries[1]!.summary, /Qualified/);
});

test('getTimeline includes messages, tasks, opportunities, and signed contracts', async () => {
  const h = await freshHarness();
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
  const h = await freshHarness();
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
  const h = await freshHarness();
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'A', phone: '01' });
  await h.crm.updateCustomFields(lead.id, 'c1', { propertyTypeWanted: 'apartment', minAreaSqm: 100, maxAreaSqm: 150 });
  const updated = await h.crm.updateCustomFields(lead.id, 'c1', { maxDownPayment: 500000 });
  assert.equal(updated.propertyTypeWanted, 'apartment');
  assert.equal(updated.minAreaSqm, 100);
  assert.equal(updated.maxDownPayment, 500000);
});

test('updateCustomFields rejects a negative numeric value', async () => {
  const h = await freshHarness();
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'A', phone: '01' });
  await assert.rejects(() => h.crm.updateCustomFields(lead.id, 'c1', { maxDownPayment: -1 }));
});

test('updateCustomFields rejects minAreaSqm greater than maxAreaSqm', async () => {
  const h = await freshHarness();
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'A', phone: '01' });
  await assert.rejects(() => h.crm.updateCustomFields(lead.id, 'c1', { minAreaSqm: 200, maxAreaSqm: 100 }));
});

test('updateCustomFields rejects a lead from a different company', async () => {
  const h = await freshHarness();
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'A', phone: '01' });
  await assert.rejects(() => h.crm.updateCustomFields(lead.id, 'c2', { propertyTypeWanted: 'villa' }));
});

test('createLead persists custom fields set at creation time', async () => {
  const h = await freshHarness();
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'A', phone: '01', propertyTypeWanted: 'villa', preferredTenorMonths: 24 });
  assert.equal(lead.propertyTypeWanted, 'villa');
  assert.equal(lead.preferredTenorMonths, 24);
});
