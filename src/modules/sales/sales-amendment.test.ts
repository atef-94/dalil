import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { SalesService } from './sales.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { PaymentPlansService } from '../payment-plans/payment-plans.service.js';
import type { Contract, DiscountApprovalPolicy, Opportunity, PaymentScheduleLine, PaymentPlanTemplate, Project, Reservation, Unit, UnitHold } from '../../domain/types.js';

function freshService() {
  const opportunities = new InMemoryRepository<Opportunity>();
  const contracts = new InMemoryRepository<Contract>();
  const units = new InMemoryRepository<Unit>();
  const holds = new InMemoryRepository<UnitHold>();
  const reservations = new InMemoryRepository<Reservation>();
  const projects = new InMemoryRepository<Project>();
  const templates = new InMemoryRepository<PaymentPlanTemplate>();
  const scheduleLines = new InMemoryRepository<PaymentScheduleLine>();
  const discountApprovalPolicies = new InMemoryRepository<DiscountApprovalPolicy>();
  const inventory = new InventoryService(units, holds, reservations, projects);
  const paymentPlans = new PaymentPlansService(templates, scheduleLines);
  const svc = new SalesService(opportunities, contracts, inventory, paymentPlans, discountApprovalPolicies);
  return { svc, contracts, scheduleLines };
}

async function seedSignedContract(contracts: InMemoryRepository<Contract>, overrides: Partial<Contract> = {}): Promise<Contract> {
  return contracts.save({
    id: 'contract-1',
    companyId: 'c1',
    reservationId: 'r1',
    unitId: 'u1',
    clientId: 'client-1',
    creditedEmployeeUserId: 'agent-1',
    paymentPlanTemplateId: 't1',
    status: 'signed',
    signedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    totalPrice: 100000,
    ...overrides,
  });
}

async function seedLine(scheduleLines: InMemoryRepository<PaymentScheduleLine>, overrides: Partial<PaymentScheduleLine>): Promise<PaymentScheduleLine> {
  return scheduleLines.save({
    id: overrides.id ?? 'line-1',
    companyId: 'c1',
    contractId: 'contract-1',
    sourceTemplateId: 't1',
    sourceTemplateVersion: 1,
    sequence: 0,
    label: 'Down Payment',
    dueDate: new Date().toISOString(),
    amount: 20000,
    amountPaid: 0,
    status: 'upcoming',
    ...overrides,
  });
}

test('amendContract updates totalPrice and rescales unpaid lines to match the new balance', async () => {
  const { svc, contracts, scheduleLines } = freshService();
  await seedSignedContract(contracts);
  await seedLine(scheduleLines, { id: 'l1', amount: 20000, amountPaid: 0 });
  await seedLine(scheduleLines, { id: 'l2', sequence: 1, label: 'Installment 1', amount: 80000, amountPaid: 0 });

  const updated = await svc.amendContract({ companyId: 'c1', contractId: 'contract-1', newTotalPrice: 120000 });
  assert.equal(updated.totalPrice, 120000);

  const lines = await scheduleLines.findAll(() => true);
  const sum = lines.reduce((s, l) => s + l.amount, 0);
  assert.equal(sum, 120000);
  // Proportions preserved: l1 was 20% of the old total, still 20% of the new one.
  const l1 = lines.find((l) => l.id === 'l1')!;
  assert.equal(l1.amount, 24000);
});

test('amendContract never touches an already-paid or partially-paid line', async () => {
  const { svc, contracts, scheduleLines } = freshService();
  await seedSignedContract(contracts);
  await seedLine(scheduleLines, { id: 'l1', amount: 20000, amountPaid: 20000, status: 'paid' });
  await seedLine(scheduleLines, { id: 'l2', sequence: 1, label: 'Installment 1', amount: 80000, amountPaid: 0 });

  await svc.amendContract({ companyId: 'c1', contractId: 'contract-1', newTotalPrice: 140000 });

  const l1 = await scheduleLines.findById('l1');
  assert.equal(l1!.amount, 20000);
  assert.equal(l1!.amountPaid, 20000);
  const l2 = await scheduleLines.findById('l2');
  assert.equal(l2!.amount, 120000); // 140000 total - 20000 locked
});

test('amendContract rejects a new total price below what has already been paid', async () => {
  const { svc, contracts, scheduleLines } = freshService();
  await seedSignedContract(contracts);
  await seedLine(scheduleLines, { id: 'l1', amount: 90000, amountPaid: 90000, status: 'paid' });
  await seedLine(scheduleLines, { id: 'l2', sequence: 1, amount: 10000, amountPaid: 0 });

  await assert.rejects(() => svc.amendContract({ companyId: 'c1', contractId: 'contract-1', newTotalPrice: 50000 }));
});

test('amendContract applies discountPercent before comparing against locked/paid amounts', async () => {
  const { svc, contracts, scheduleLines } = freshService();
  await seedSignedContract(contracts);
  await seedLine(scheduleLines, { id: 'l1', amount: 20000, amountPaid: 0 });

  const updated = await svc.amendContract({ companyId: 'c1', contractId: 'contract-1', newTotalPrice: 100000, discountPercent: 10 });
  assert.equal(updated.totalPrice, 100000);
  const l1 = await scheduleLines.findById('l1');
  assert.equal(l1!.amount, 90000); // 100000 * 0.9, entirely unpaid so absorbs it all
});

test('amendContract rejects a contract that is not signed', async () => {
  const { svc, contracts } = freshService();
  await seedSignedContract(contracts, { status: 'cancelled' });
  await assert.rejects(() => svc.amendContract({ companyId: 'c1', contractId: 'contract-1', newTotalPrice: 100000 }));
});

test('amendContract rejects a contract from a different company (cross-tenant)', async () => {
  const { svc, contracts } = freshService();
  await seedSignedContract(contracts);
  await assert.rejects(() => svc.amendContract({ companyId: 'c2', contractId: 'contract-1', newTotalPrice: 100000 }));
});

test('amendContract rejects a non-positive newTotalPrice', async () => {
  const { svc, contracts } = freshService();
  await seedSignedContract(contracts);
  await assert.rejects(() => svc.amendContract({ companyId: 'c1', contractId: 'contract-1', newTotalPrice: 0 }));
});
