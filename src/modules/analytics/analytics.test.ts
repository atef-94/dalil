import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { AnalyticsService } from './analytics.service.js';
import type { Commission, Contract, Lead, Opportunity, PaymentScheduleLine, Unit } from '../../domain/types.js';

function freshService() {
  const leads = new InMemoryRepository<Lead>();
  const opportunities = new InMemoryRepository<Opportunity>();
  const contracts = new InMemoryRepository<Contract>();
  const scheduleLines = new InMemoryRepository<PaymentScheduleLine>();
  const units = new InMemoryRepository<Unit>();
  const commissions = new InMemoryRepository<Commission>();
  const svc = new AnalyticsService(leads, opportunities, contracts, scheduleLines, units, commissions);
  return { svc, leads, opportunities, contracts, scheduleLines, units, commissions };
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
