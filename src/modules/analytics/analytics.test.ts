import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { AuditLog } from '../../infra/audit-log.js';
import { AnalyticsService } from './analytics.service.js';
import { CrmStageService } from '../crm/crm-stage.service.js';
import type { AuditLogEntry, Campaign, Commission, Contract, CrmStage, Lead, Opportunity, PaymentScheduleLine, Unit } from '../../domain/types.js';

async function freshService(companyIds: string[] = ['c1', 'c2']) {
  const leads = new InMemoryRepository<Lead>();
  const opportunities = new InMemoryRepository<Opportunity>();
  const contracts = new InMemoryRepository<Contract>();
  const scheduleLines = new InMemoryRepository<PaymentScheduleLine>();
  const units = new InMemoryRepository<Unit>();
  const commissions = new InMemoryRepository<Commission>();
  const auditEntries = new InMemoryRepository<AuditLogEntry>();
  const campaigns = new InMemoryRepository<Campaign>();
  const auditLog = new AuditLog(auditEntries);
  const crmStages = new CrmStageService(new InMemoryRepository<CrmStage>());
  for (const companyId of companyIds) {
    await crmStages.seedDefaultStages(companyId);
  }
  const svc = new AnalyticsService(leads, opportunities, contracts, scheduleLines, units, commissions, auditEntries, campaigns, crmStages);
  return { svc, leads, opportunities, contracts, scheduleLines, units, commissions, auditEntries, campaigns, auditLog, crmStages };
}

async function stageByKey(crmStages: CrmStageService, companyId: string, key: string): Promise<CrmStage> {
  const stages = await crmStages.listStages(companyId, true);
  const stage = stages.find((s) => s.key === key);
  if (!stage) throw new Error(`no seeded stage with key "${key}" for ${companyId}`);
  return stage;
}

test('salesFunnel counts leads by CRM stage, scoped to the company', async () => {
  const { svc, leads, crmStages } = await freshService();
  const fresh = await stageByKey(crmStages, 'c1', 'fresh');
  const qualified = await stageByKey(crmStages, 'c1', 'qualified');
  const freshC2 = await stageByKey(crmStages, 'c2', 'fresh');
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', stageId: fresh.id, createdAt: new Date().toISOString() });
  await leads.save({ id: 'l2', companyId: 'c1', fullName: 'B', phone: '2', stageId: qualified.id, createdAt: new Date().toISOString() });
  await leads.save({ id: 'l3', companyId: 'c2', fullName: 'C', phone: '3', stageId: freshC2.id, createdAt: new Date().toISOString() });
  const funnel = await svc.salesFunnel('c1');
  assert.equal(funnel.totalLeads, 2);
  assert.equal(funnel.stages.find((s) => s.stageKey === 'fresh')!.count, 1);
  assert.equal(funnel.stages.find((s) => s.stageKey === 'qualified')!.count, 1);
});

test('pipelineSummary counts opportunities by stage and contracts by status', async () => {
  const { svc, opportunities, contracts } = await freshService();
  await opportunities.save({ id: 'o1', companyId: 'c1', leadId: 'l1', ownerEmployeeUserId: 'u1', stage: 'open', createdAt: new Date().toISOString() });
  await opportunities.save({ id: 'o2', companyId: 'c1', leadId: 'l2', ownerEmployeeUserId: 'u1', stage: 'won', createdAt: new Date().toISOString() });
  await contracts.save({ id: 'c-1', companyId: 'c1', reservationId: 'r1', unitId: 'u1', clientId: 'l1', creditedEmployeeUserId: 'u1', paymentPlanTemplateId: 't1', status: 'signed', createdAt: new Date().toISOString() });
  const summary = await svc.pipelineSummary('c1');
  assert.equal(summary.openOpportunities, 1);
  assert.equal(summary.wonOpportunities, 1);
  assert.equal(summary.signedContracts, 1);
});

test('collectionsAging sums outstanding amounts per line status', async () => {
  const { svc, scheduleLines } = await freshService();
  await scheduleLines.save({ id: 's1', companyId: 'c1', contractId: 'c-1', sourceTemplateId: 't1', sourceTemplateVersion: 1, sequence: 0, label: 'Down payment', dueDate: new Date().toISOString(), amount: 1000, amountPaid: 0, status: 'overdue' });
  await scheduleLines.save({ id: 's2', companyId: 'c1', contractId: 'c-1', sourceTemplateId: 't1', sourceTemplateVersion: 1, sequence: 1, label: 'Installment 1', dueDate: new Date().toISOString(), amount: 500, amountPaid: 500, status: 'paid' });
  const aging = await svc.collectionsAging('c1');
  assert.equal(aging.overdue, 1000);
  assert.equal(aging.paid, 500);
});

test('inventoryOccupancy computes occupancy rate across reserved + contracted', async () => {
  const { svc, units } = await freshService();
  await units.save({ id: 'u1', companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000, status: 'available', createdAt: new Date().toISOString() });
  await units.save({ id: 'u2', companyId: 'c1', projectId: 'p1', code: 'A-2', unitType: 'apartment', areaSqm: 100, listPrice: 1000, status: 'contracted', createdAt: new Date().toISOString() });
  const occupancy = await svc.inventoryOccupancy('c1');
  assert.equal(occupancy.occupancyRatePercent, 50);
});

test('brokerPerformance aggregates commissions by broker company and status', async () => {
  const { svc, commissions } = await freshService();
  await commissions.save({ id: 'com1', companyId: 'c1', brokerCompanyId: 'bc1', contractId: 'c-1', amount: 100, status: 'pending', createdAt: new Date().toISOString() });
  await commissions.save({ id: 'com2', companyId: 'c1', brokerCompanyId: 'bc1', contractId: 'c-2', amount: 200, status: 'approved', createdAt: new Date().toISOString() });
  const perf = await svc.brokerPerformance('c1');
  assert.equal(perf.length, 1);
  assert.equal(perf[0]!.pendingAmount, 100);
  assert.equal(perf[0]!.approvedAmount, 200);
});

test('speedToFirstContact averages the real gap between lead creation and the first stage-change audit entry', async () => {
  const { svc, leads, auditLog, crmStages } = await freshService();
  const contacted = await stageByKey(crmStages, 'c1', 'contacted');
  const createdAt = new Date(Date.now() - 5 * 60 * 60 * 1000); // 5 hours ago
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', stageId: contacted.id, createdAt: createdAt.toISOString() });
  await auditLog.record({ companyId: 'c1', actorUserId: 'u1', action: 'edit', resource: 'lead', resourceId: 'l1', metadata: { toStageId: contacted.id } });
  const result = await svc.speedToFirstContact('c1');
  assert.equal(result.sampleSize, 1);
  assert.ok(result.averageHours !== null && result.averageHours >= 4.9 && result.averageHours <= 5.1);
});

test('speedToFirstContact returns null with zero sample size when no lead has ever been moved', async () => {
  const { svc, leads, crmStages } = await freshService();
  const fresh = await stageByKey(crmStages, 'c1', 'fresh');
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', stageId: fresh.id, createdAt: new Date().toISOString() });
  const result = await svc.speedToFirstContact('c1');
  assert.equal(result.averageHours, null);
  assert.equal(result.sampleSize, 0);
});

test('speedToFirstContact only counts the FIRST stage-change event per lead', async () => {
  const { svc, leads, auditLog, crmStages } = await freshService();
  const contacted = await stageByKey(crmStages, 'c1', 'contacted');
  const qualified = await stageByKey(crmStages, 'c1', 'qualified');
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', stageId: qualified.id, createdAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString() });
  await auditLog.record({ companyId: 'c1', actorUserId: 'u1', action: 'edit', resource: 'lead', resourceId: 'l1', metadata: { toStageId: contacted.id } });
  await auditLog.record({ companyId: 'c1', actorUserId: 'u1', action: 'edit', resource: 'lead', resourceId: 'l1', metadata: { toStageId: qualified.id } });
  const result = await svc.speedToFirstContact('c1');
  assert.equal(result.sampleSize, 1);
});

test('funnelConversionRates computes stage-to-stage percentages from the current snapshot', async () => {
  const { svc, leads, crmStages } = await freshService();
  const fresh = await stageByKey(crmStages, 'c1', 'fresh');
  const contacted = await stageByKey(crmStages, 'c1', 'contacted');
  const qualified = await stageByKey(crmStages, 'c1', 'qualified');
  const won = await stageByKey(crmStages, 'c1', 'won');
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', stageId: fresh.id, createdAt: new Date().toISOString() });
  await leads.save({ id: 'l2', companyId: 'c1', fullName: 'B', phone: '2', stageId: contacted.id, createdAt: new Date().toISOString() });
  await leads.save({ id: 'l3', companyId: 'c1', fullName: 'C', phone: '3', stageId: qualified.id, createdAt: new Date().toISOString() });
  await leads.save({ id: 'l4', companyId: 'c1', fullName: 'D', phone: '4', stageId: won.id, createdAt: new Date().toISOString() });
  const rates = await svc.funnelConversionRates('c1');
  assert.equal(rates.totalLeads, 4);
  const freshToContacted = rates.stageConversion.find((s) => s.fromStageName === 'Fresh Leads' && s.toStageName === 'Contacted');
  assert.equal(freshToContacted!.conversionPercent, 75); // 3 of 4 are at-or-beyond Contacted
  assert.equal(rates.overallWinRatePercent, 25); // 1 of 4 reached the Won stage
});

test('funnelConversionRates returns all zeros for an empty pipeline instead of dividing by zero', async () => {
  const { svc } = await freshService();
  const rates = await svc.funnelConversionRates('c1');
  assert.equal(rates.totalLeads, 0);
  assert.equal(rates.overallWinRatePercent, 0);
  assert.equal(rates.lostRatePercent, 0);
  assert.ok(rates.stageConversion.every((s) => s.conversionPercent === 0));
});

test('costPerQualifiedLead divides real campaign budget by real campaign-attributed qualified leads', async () => {
  const { svc, leads, campaigns, crmStages } = await freshService();
  const fresh = await stageByKey(crmStages, 'c1', 'fresh');
  const qualified = await stageByKey(crmStages, 'c1', 'qualified');
  const won = await stageByKey(crmStages, 'c1', 'won');
  await campaigns.save({ id: 'camp1', companyId: 'c1', name: 'Spring Promo', channel: 'digital', budget: 1000, startDate: new Date().toISOString(), status: 'active', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', sourceId: 'camp1', stageId: qualified.id, createdAt: new Date().toISOString() });
  await leads.save({ id: 'l2', companyId: 'c1', fullName: 'B', phone: '2', sourceId: 'camp1', stageId: fresh.id, createdAt: new Date().toISOString() });
  await leads.save({ id: 'l3', companyId: 'c1', fullName: 'C', phone: '3', stageId: won.id, createdAt: new Date().toISOString() }); // no sourceId — a free/referral lead
  const result = await svc.costPerQualifiedLead('c1');
  assert.equal(result.totalCampaignBudget, 1000);
  assert.equal(result.qualifiedLeadsFromCampaigns, 1); // only l1, not l2 (still in default stage) or l3 (no campaign spend behind it)
  assert.equal(result.costPerQualifiedLead, 1000);
});

test('costPerQualifiedLead returns null when no campaign-attributed lead has qualified yet', async () => {
  const { svc, campaigns } = await freshService();
  await campaigns.save({ id: 'camp1', companyId: 'c1', name: 'Spring Promo', channel: 'digital', budget: 1000, startDate: new Date().toISOString(), status: 'active', createdAt: new Date().toISOString() });
  const result = await svc.costPerQualifiedLead('c1');
  assert.equal(result.costPerQualifiedLead, null);
});

test('lostReasonBreakdown groups leads by exact lostReason text, most frequent first', async () => {
  const { svc, leads, crmStages } = await freshService();
  const fresh = await stageByKey(crmStages, 'c1', 'fresh');
  const lost = await stageByKey(crmStages, 'c1', 'lost');
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', stageId: lost.id, lostReason: 'Price too high', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l2', companyId: 'c1', fullName: 'B', phone: '2', stageId: lost.id, lostReason: 'Price too high', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l3', companyId: 'c1', fullName: 'C', phone: '3', stageId: lost.id, lostReason: 'Went with a competitor', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l4', companyId: 'c1', fullName: 'D', phone: '4', stageId: fresh.id, createdAt: new Date().toISOString() });
  const breakdown = await svc.lostReasonBreakdown('c1');
  assert.deepEqual(breakdown, [
    { reason: 'Price too high', count: 2 },
    { reason: 'Went with a competitor', count: 1 },
  ]);
});
