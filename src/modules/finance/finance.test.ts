import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository, type Repository } from '../../infra/repository.js';
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

// ---- Phase 0 fix: lost-payment race between two concurrent recordPayment
// calls on the same schedule line (both now serialize on the same per-line
// KeyedMutex) ----

// A plain Promise.all([recordPayment(A), recordPayment(B)]) does not
// reliably discriminate this fix: with InMemoryRepository's synchronous
// Map-backed store, one call's read-to-write span runs as one uninterrupted
// synchronous stretch once its first await resolves, so its write always
// lands before the other call's read gets scheduled — no torn read ever
// occurs by accident. To force the actual harmful interleaving (both calls
// read amountPaid=0 before either writes, then the second write silently
// overwrites the first), we use an instrumented Repository<PaymentScheduleLine>
// that pauses the first call's read right after it captures a stale
// snapshot, deterministically letting a second, fully independent payment
// commit before the first one resumes and (on unfixed code) overwrites it.
test('concurrency (deterministic): two payments racing the same schedule line never lose an update — the sum of both amounts is always reflected', async () => {
  const realLines = new InMemoryRepository<PaymentScheduleLine>();
  await realLines.save({
    id: 'line-1',
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
  });

  let targetLineId: string | undefined;
  let gateReached = false;
  let resolveReachedGate!: () => void;
  const reachedGate = new Promise<void>((resolve) => {
    resolveReachedGate = resolve;
  });
  let resolveReleaseGate!: () => void;
  const releaseGate = new Promise<void>((resolve) => {
    resolveReleaseGate = resolve;
  });

  const instrumentedLines: Repository<PaymentScheduleLine> = {
    async findById(id) {
      const result = await realLines.findById(id);
      if (id === targetLineId && !gateReached) {
        gateReached = true;
        resolveReachedGate();
        await releaseGate;
      }
      return result;
    },
    findAll: (predicate) => realLines.findAll(predicate),
    save: (item) => realLines.save(item),
    deleteById: (id) => realLines.deleteById(id),
  };

  const svc = new FinanceService(new InMemoryRepository<Payment>(), new InMemoryRepository<Receipt>(), instrumentedLines, new InMemoryRepository<Refund>());

  targetLineId = 'line-1';
  const paymentA = svc.recordPayment({ companyId: 'c1', contractId: 'contract-1', paymentScheduleLineId: 'line-1', amount: 400, method: 'cash', recordedByUserId: 'u1' });
  await reachedGate; // A has read the line (amountPaid=0) and is now paused

  const paymentB = svc.recordPayment({ companyId: 'c1', contractId: 'contract-1', paymentScheduleLineId: 'line-1', amount: 600, method: 'cash', recordedByUserId: 'u2' });
  // Flush the microtask/macrotask queue so B (fixed code: only queues on the
  // mutex A holds; unfixed code: runs to completion immediately, since
  // nothing guards it) gets every chance to finish before A resumes.
  await new Promise((resolve) => setImmediate(resolve));

  resolveReleaseGate();
  await Promise.all([paymentA, paymentB]);

  const finalLine = await realLines.findById('line-1');
  assert.equal(finalLine!.amountPaid, 1000, 'both concurrent payments must be reflected — neither may silently overwrite the other');
  assert.equal(finalLine!.status, 'paid');
});

test('sweepOverdueDetailed only sweeps the given companyId when one is passed, and every company when omitted (Phase 0: cross-tenant sweep fix)', async () => {
  const { svc, lines } = freshService();
  await seedLine(lines, { id: 'line-c1', companyId: 'c1', dueDate: new Date(Date.now() - 86_400_000).toISOString() });
  await seedLine(lines, { id: 'line-c2', companyId: 'c2', dueDate: new Date(Date.now() - 86_400_000).toISOString() });

  const sweptForC1Only = await svc.sweepOverdueDetailed(new Date(), 'c1');
  assert.equal(sweptForC1Only.length, 1);
  assert.equal(sweptForC1Only[0]!.id, 'line-c1');
  assert.equal((await lines.findById('line-c2'))!.status, 'upcoming', "company c2's own overdue line must be untouched by a sweep scoped to c1");

  const sweptForEveryone = await svc.sweepOverdueDetailed(new Date());
  assert.equal(sweptForEveryone.length, 1);
  assert.equal(sweptForEveryone[0]!.id, 'line-c2');
});
