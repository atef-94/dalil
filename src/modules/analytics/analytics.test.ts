import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { AuditLog } from '../../infra/audit-log.js';
import { AnalyticsService } from './analytics.service.js';
import type { AuditLogEntry, Campaign, Commission, Contract, Lead, Opportunity, PaymentScheduleLine, Unit } from '../../domain/types.js';

function freshService() {
  const leads = new InMemoryRepository<Lead>();
  const opportunities = new InMemoryRepository<Opportunity>();
  const contracts = new InMemoryRepository<Contract>();
  const scheduleLines = new InMemoryRepository<PaymentScheduleLine>();
  const units = new InMemoryRepository<Unit>();
  const commissions = new InMemoryRepository<Commission>();
  const auditEntries = new InMemoryRepository<AuditLogEntry>();
  const campaigns = new InMemoryRepository<Campaign>();
  const auditLog = new AuditLog(auditEntries);
  const svc = new AnalyticsService(leads, opportunities, contracts, scheduleLines, units, commissions, auditEntries, campaigns);
  return { svc, leads, opportunities, contracts, scheduleLines, units, commissions, auditEntries, campaigns, auditLog };
}

test('salesFunnel counts leads by status, scoped to the company', async () => {
  const { svc, leads } = freshService();
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', status: 'new', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l2', companyId: 'c1', fullName: 'B', phone: '2', status: 'qualified', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l3', companyId: 'c2', fullName: 'C', phone: '3', status: 'new', createdAt: new Date().toISOString() });
  const funnel = await svc.salesFunnel('c1');
  assert.equal(funnel.new, 1);
  assert.equal(funnel.qualified, 1);
});

test('pipelineSummary counts opportunities by stage and contracts by status', async () => {
  const { svc, opportunities, contracts } = freshService();
  await opportunities.save({ id: 'o1', companyId: 'c1', leadId: 'l1', ownerEmployeeUserId: 'u1', stage: 'open', createdAt: new Date().toISOString() });
  await opportunities.save({ id: 'o2', companyId: 'c1', leadId: 'l2', ownerEmployeeUserId: 'u1', stage: 'won', createdAt: new Date().toISOString() });
  await contracts.save({ id: 'c-1', companyId: 'c1', reservationId: 'r1', unitId: 'u1', clientId: 'l1', creditedEmployeeUserId: 'u1', paymentPlanTemplateId: 't1', status: 'signed', createdAt: new Date().toISOString() });
  const summary = await svc.pipelineSummary('c1');
  assert.equal(summary.openOpportunities, 1);
  assert.equal(summary.wonOpportunities, 1);
  assert.equal(summary.signedContracts, 1);
});

test('collectionsAging sums outstanding amounts per line status', async () => {
  const { svc, scheduleLines } = freshService();
  await scheduleLines.save({ id: 's1', companyId: 'c1', contractId: 'c-1', sourceTemplateId: 't1', sourceTemplateVersion: 1, sequence: 0, label: 'Down payment', dueDate: new Date().toISOString(), amount: 1000, amountPaid: 0, status: 'overdue' });
  await scheduleLines.save({ id: 's2', companyId: 'c1', contractId: 'c-1', sourceTemplateId: 't1', sourceTemplateVersion: 1, sequence: 1, label: 'Installment 1', dueDate: new Date().toISOString(), amount: 500, amountPaid: 500, status: 'paid' });
  const aging = await svc.collectionsAging('c1');
  assert.equal(aging.overdue, 1000);
  assert.equal(aging.paid, 500);
});

test('inventoryOccupancy computes occupancy rate across reserved + contracted', async () => {
  const { svc, units } = freshService();
  await units.save({ id: 'u1', companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000, status: 'available', createdAt: new Date().toISOString() });
  await units.save({ id: 'u2', companyId: 'c1', projectId: 'p1', code: 'A-2', unitType: 'apartment', areaSqm: 100, listPrice: 1000, status: 'contracted', createdAt: new Date().toISOString() });
  const occupancy = await svc.inventoryOccupancy('c1');
  assert.equal(occupancy.occupancyRatePercent, 50);
});

test('brokerPerformance aggregates commissions by broker company and status', async () => {
  const { svc, commissions } = freshService();
  await commissions.save({ id: 'com1', companyId: 'c1', brokerCompanyId: 'bc1', contractId: 'c-1', amount: 100, status: 'pending', createdAt: new Date().toISOString() });
  await commissions.save({ id: 'com2', companyId: 'c1', brokerCompanyId: 'bc1', contractId: 'c-2', amount: 200, status: 'approved', createdAt: new Date().toISOString() });
  const perf = await svc.brokerPerformance('c1');
  assert.equal(perf.length, 1);
  assert.equal(perf[0]!.pendingAmount, 100);
  assert.equal(perf[0]!.approvedAmount, 200);
});

test('speedToFirstContact averages the real gap between lead creation and the first contacted audit entry', async () => {
  const { svc, leads, auditLog } = freshService();
  const createdAt = new Date(Date.now() - 5 * 60 * 60 * 1000); // 5 hours ago
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', status: 'contacted', createdAt: createdAt.toISOString() });
  await auditLog.record({ companyId: 'c1', actorUserId: 'u1', action: 'edit', resource: 'lead', resourceId: 'l1', metadata: { fromStatus: 'new', toStatus: 'contacted' } });
  const result = await svc.speedToFirstContact('c1');
  assert.equal(result.sampleSize, 1);
  assert.ok(result.averageHours !== null && result.averageHours >= 4.9 && result.averageHours <= 5.1);
});

test('speedToFirstContact returns null with zero sample size when no lead has been contacted yet', async () => {
  const { svc, leads } = freshService();
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', status: 'new', createdAt: new Date().toISOString() });
  const result = await svc.speedToFirstContact('c1');
  assert.equal(result.averageHours, null);
  assert.equal(result.sampleSize, 0);
});

test('speedToFirstContact only counts the FIRST contacted event per lead', async () => {
  const { svc, leads, auditLog } = freshService();
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', status: 'qualified', createdAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString() });
  await auditLog.record({ companyId: 'c1', actorUserId: 'u1', action: 'edit', resource: 'lead', resourceId: 'l1', metadata: { fromStatus: 'new', toStatus: 'contacted' } });
  await auditLog.record({ companyId: 'c1', actorUserId: 'u1', action: 'edit', resource: 'lead', resourceId: 'l1', metadata: { fromStatus: 'contacted', toStatus: 'qualified' } });
  const result = await svc.speedToFirstContact('c1');
  assert.equal(result.sampleSize, 1);
});

test('funnelConversionRates computes stage-to-stage percentages from the current snapshot', async () => {
  const { svc, leads } = freshService();
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', status: 'new', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l2', companyId: 'c1', fullName: 'B', phone: '2', status: 'contacted', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l3', companyId: 'c1', fullName: 'C', phone: '3', status: 'qualified', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l4', companyId: 'c1', fullName: 'D', phone: '4', status: 'opportunity', createdAt: new Date().toISOString() });
  const rates = await svc.funnelConversionRates('c1');
  assert.equal(rates.totalLeads, 4);
  assert.equal(rates.newToContactedPercent, 75); // 3 of 4 are contacted-or-beyond
  assert.equal(rates.overallWinRatePercent, 25); // 1 of 4 reached opportunity
});

test('funnelConversionRates returns all zeros for an empty pipeline instead of dividing by zero', async () => {
  const { svc } = freshService();
  const rates = await svc.funnelConversionRates('c1');
  assert.equal(rates.totalLeads, 0);
  assert.equal(rates.newToContactedPercent, 0);
  assert.equal(rates.overallWinRatePercent, 0);
});

test('costPerQualifiedLead divides real campaign budget by real campaign-attributed qualified leads', async () => {
  const { svc, leads, campaigns } = freshService();
  await campaigns.save({ id: 'camp1', companyId: 'c1', name: 'Spring Promo', channel: 'digital', budget: 1000, startDate: new Date().toISOString(), status: 'active', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', sourceId: 'camp1', status: 'qualified', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l2', companyId: 'c1', fullName: 'B', phone: '2', sourceId: 'camp1', status: 'new', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l3', companyId: 'c1', fullName: 'C', phone: '3', status: 'opportunity', createdAt: new Date().toISOString() }); // no sourceId — a free/referral lead
  const result = await svc.costPerQualifiedLead('c1');
  assert.equal(result.totalCampaignBudget, 1000);
  assert.equal(result.qualifiedLeadsFromCampaigns, 1); // only l1, not l2 (not qualified) or l3 (no campaign spend behind it)
  assert.equal(result.costPerQualifiedLead, 1000);
});

test('costPerQualifiedLead returns null when no campaign-attributed lead has qualified yet', async () => {
  const { svc, campaigns } = freshService();
  await campaigns.save({ id: 'camp1', companyId: 'c1', name: 'Spring Promo', channel: 'digital', budget: 1000, startDate: new Date().toISOString(), status: 'active', createdAt: new Date().toISOString() });
  const result = await svc.costPerQualifiedLead('c1');
  assert.equal(result.costPerQualifiedLead, null);
});

test('lostReasonBreakdown groups leads by exact lostReason text, most frequent first', async () => {
  const { svc, leads } = freshService();
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', status: 'lost', lostReason: 'Price too high', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l2', companyId: 'c1', fullName: 'B', phone: '2', status: 'lost', lostReason: 'Price too high', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l3', companyId: 'c1', fullName: 'C', phone: '3', status: 'lost', lostReason: 'Went with a competitor', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l4', companyId: 'c1', fullName: 'D', phone: '4', status: 'new', createdAt: new Date().toISOString() });
  const breakdown = await svc.lostReasonBreakdown('c1');
  assert.deepEqual(breakdown, [
    { reason: 'Price too high', count: 2 },
    { reason: 'Went with a competitor', count: 1 },
  ]);
});
