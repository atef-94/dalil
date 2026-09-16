import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { FinanceService } from './finance.service.js';
import type { Payment, PaymentScheduleLine, Receipt } from '../../domain/types.js';

function freshService() {
  const lines = new InMemoryRepository<PaymentScheduleLine>();
  const svc = new FinanceService(new InMemoryRepository<Payment>(), new InMemoryRepository<Receipt>(), lines);
  return { svc, lines };
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
  const balance = await svc.getBalance('contract-1');
  assert.equal(balance.totalDue, 3000);
  assert.equal(balance.totalPaid, 1000);
  assert.equal(balance.outstanding, 2000);
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
