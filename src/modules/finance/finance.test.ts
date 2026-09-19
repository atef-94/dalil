import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { FinanceService } from './finance.service.js';
import type { Payment, PaymentScheduleLine, Receipt, Refund } from '../../domain/types.js';

function freshService() {
  const lines = new InMemoryRepository<PaymentScheduleLine>();
  const refunds = new InMemoryRepository<Refund>();
  const svc = new FinanceService(new InMemoryRepository<Payment>(), new InMemoryRepository<Receipt>(), lines, refunds);
  return { svc, lines, refunds };
}

async function seedLine(lines: InMemoryRepository<PaymentScheduleLine>, overrides: Partial<PaymentScheduleLine> = {}): Promise<PaymentScheduleLine> {
  return lines.save({
    id: overrides.id ?? 'line-1',
    companyId: 'c1',
    contractId: 'contract-1',
    sourceTemplateId: 'tpl-1',
    sourceTemplateVersion: 1,
    sequence: 0,
    label: 'Installment 1',
    dueDate: new Date().toISOString(),
    amount: 1000,
    amountPaid: 0,
    status: 'upcoming',
    ...overrides,
  });
}

test('a full payment marks the schedule line as paid', async () => {
  const { svc, lines } = freshService();
  await seedLine(lines);
  const { line } = await svc.recordPayment({ companyId: 'c1', contractId: 'contract-1', paymentScheduleLineId: 'line-1', amount: 1000, method: 'cash', recordedByUserId: 'u1' });
  assert.equal(line.status, 'paid');
});

test('a partial payment accumulates without marking the line paid', async () => {
  const { svc, lines } = freshService();
  await seedLine(lines);
  const { line } = await svc.recordPayment({ companyId: 'c1', contractId: 'contract-1', paymentScheduleLineId: 'line-1', amount: 400, method: 'cash', recordedByUserId: 'u1' });
  assert.equal(line.amountPaid, 400);
  assert.notEqual(line.status, 'paid');
});

test('partial payments accumulate correctly across multiple calls', async () => {
  const { svc, lines } = freshService();
  await seedLine(lines);
  await svc.recordPayment({ companyId: 'c1', contractId: 'contract-1', paymentScheduleLineId: 'line-1', amount: 400, method: 'cash', recordedByUserId: 'u1' });
  const { line } = await svc.recordPayment({ companyId: 'c1', contractId: 'contract-1', paymentScheduleLineId: 'line-1', amount: 600, method: 'cash', recordedByUserId: 'u1' });
  assert.equal(line.amountPaid, 1000);
  assert.equal(line.status, 'paid');
});

test('a payment that would overpay the line is rejected', async () => {
  const { svc, lines } = freshService();
  await seedLine(lines);
  await assert.rejects(() => svc.recordPayment({ companyId: 'c1', contractId: 'contract-1', paymentScheduleLineId: 'line-1', amount: 1500, method: 'cash', recordedByUserId: 'u1' }));
});

test('a payment against an already-paid line is rejected (no double payment)', async () => {
  const { svc, lines } = freshService();
  await seedLine(lines);
  await svc.recordPayment({ companyId: 'c1', contractId: 'contract-1', paymentScheduleLineId: 'line-1', amount: 1000, method: 'cash', recordedByUserId: 'u1' });
  await assert.rejects(() => svc.recordPayment({ companyId: 'c1', contractId: 'contract-1', paymentScheduleLineId: 'line-1', amount: 1, method: 'cash', recordedByUserId: 'u1' }));
});

test('getBalance sums outstanding across all lines for a contract', async () => {
  const { svc, lines } = freshService();
  await seedLine(lines, { id: 'line-1', amount: 1000 });
  await seedLine(lines, { id: 'line-2', amount: 2000, sequence: 1 });
  await svc.recordPayment({ companyId: 'c1', contractId: 'contract-1', paymentScheduleLineId: 'line-1', amount: 1000, method: 'cash', recordedByUserId: 'u1' });
  const balance = await svc.getBalance('contract-1', 'c1');
  assert.equal(balance.totalDue, 3000);
  assert.equal(balance.totalPaid, 1000);
  assert.equal(balance.outstanding, 2000);
});

test('recordPayment rejects a schedule line belonging to a different company (cross-tenant IDOR)', async () => {
  const { svc, lines } = freshService();
  await seedLine(lines);
  await assert.rejects(() =>
    svc.recordPayment({ companyId: 'c2', contractId: 'contract-1', paymentScheduleLineId: 'line-1', amount: 500, method: 'cash', recordedByUserId: 'u1' }),
  );
});

test('sweepOverdue moves a past-due upcoming line to overdue', async () => {
  const { svc, lines } = freshService();
  await seedLine(lines, { dueDate: new Date(Date.now() - 86_400_000).toISOString() });
  const swept = await svc.sweepOverdue();
  assert.equal(swept, 1);
  const line = await lines.findById('line-1');
  assert.equal(line!.status, 'overdue');
});

test('sweepOverdue never touches a line already marked paid', async () => {
  const { svc, lines } = freshService();
  await seedLine(lines, { dueDate: new Date(Date.now() - 86_400_000).toISOString(), status: 'paid', amountPaid: 1000 });
  const swept = await svc.sweepOverdue();
  assert.equal(swept, 0);
  const line = await lines.findById('line-1');
  assert.equal(line!.status, 'paid');
});

test('recordRefund reverses money already collected and records a Refund row', async () => {
  const { svc, lines, refunds } = freshService();
  await seedLine(lines, { amountPaid: 1000, status: 'paid' });
  const { refund, line } = await svc.recordRefund({ companyId: 'c1', contractId: 'contract-1', paymentScheduleLineId: 'line-1', amount: 400, reason: 'client requested partial refund', recordedByUserId: 'u1' });
  assert.equal(line.amountPaid, 600);
  assert.notEqual(line.status, 'paid');
  assert.equal(refund.amount, 400);
  const stored = await refunds.findAll(() => true);
  assert.equal(stored.length, 1);
});

test('recordRefund rejects an amount exceeding what was actually paid on the line', async () => {
  const { svc, lines } = freshService();
  await seedLine(lines, { amountPaid: 400 });
  await assert.rejects(() => svc.recordRefund({ companyId: 'c1', contractId: 'contract-1', paymentScheduleLineId: 'line-1', amount: 500, reason: 'test', recordedByUserId: 'u1' }));
});

test('recordRefund requires a non-empty reason', async () => {
  const { svc, lines } = freshService();
  await seedLine(lines, { amountPaid: 1000, status: 'paid' });
  await assert.rejects(() => svc.recordRefund({ companyId: 'c1', contractId: 'contract-1', paymentScheduleLineId: 'line-1', amount: 100, reason: '  ', recordedByUserId: 'u1' }));
});

test('recordRefund rejects a schedule line belonging to a different company (cross-tenant)', async () => {
  const { svc, lines } = freshService();
  await seedLine(lines, { amountPaid: 1000, status: 'paid' });
  await assert.rejects(() => svc.recordRefund({ companyId: 'c2', contractId: 'contract-1', paymentScheduleLineId: 'line-1', amount: 100, reason: 'test', recordedByUserId: 'u1' }));
});

test('a full refund of a fully-paid, not-yet-due line returns it to upcoming', async () => {
  const { svc, lines } = freshService();
  await seedLine(lines, { amountPaid: 1000, status: 'paid', dueDate: new Date(Date.now() + 86_400_000).toISOString() });
  const { line } = await svc.recordRefund({ companyId: 'c1', contractId: 'contract-1', paymentScheduleLineId: 'line-1', amount: 1000, reason: 'full refund', recordedByUserId: 'u1' });
  assert.equal(line.amountPaid, 0);
  assert.equal(line.status, 'upcoming');
});
