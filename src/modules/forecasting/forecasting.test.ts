import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { ForecastingService } from './forecasting.service.js';
import type { Contract, Payment, PaymentScheduleLine, Unit } from '../../domain/types.js';

function freshService() {
  const contracts = new InMemoryRepository<Contract>();
  const scheduleLines = new InMemoryRepository<PaymentScheduleLine>();
  const payments = new InMemoryRepository<Payment>();
  const units = new InMemoryRepository<Unit>();
  const svc = new ForecastingService(contracts, scheduleLines, payments, units);
  return { svc, contracts, scheduleLines, payments, units };
}

// Fixed reference "now" so month-boundary math is deterministic regardless
// of when the suite actually runs.
const NOW = new Date('2026-06-15T00:00:00.000Z');
const isoInMonth = (year: number, month: number, day = 15) => new Date(Date.UTC(year, month - 1, day)).toISOString();

test('historicalMonthly sums bookings and collections per calendar month, scoped to the company', async () => {
  const { svc, contracts, scheduleLines, payments } = freshService();
  await contracts.save({ id: 'c1', companyId: 'co1', reservationId: 'r1', unitId: 'u1', clientId: 'l1', creditedEmployeeUserId: 'a1', paymentPlanTemplateId: 't1', status: 'signed', signedAt: isoInMonth(2026, 5), createdAt: isoInMonth(2026, 5), totalPrice: 100000 });
  await contracts.save({ id: 'c2', companyId: 'co2', reservationId: 'r2', unitId: 'u2', clientId: 'l2', creditedEmployeeUserId: 'a2', paymentPlanTemplateId: 't1', status: 'signed', signedAt: isoInMonth(2026, 5), createdAt: isoInMonth(2026, 5), totalPrice: 999999 });
  await scheduleLines.save({ id: 's1', companyId: 'co1', contractId: 'c1', sourceTemplateId: 't1', sourceTemplateVersion: 1, sequence: 0, label: 'Down Payment', dueDate: isoInMonth(2026, 5), amount: 20000, amountPaid: 20000, status: 'paid' });
  await payments.save({ id: 'p1', companyId: 'co1', contractId: 'c1', paymentScheduleLineId: 's1', amount: 20000, method: 'cash', recordedByUserId: 'a1', createdAt: isoInMonth(2026, 5) });

  const history = await svc.historicalMonthly('co1', undefined, 3, NOW);
  assert.equal(history.length, 3);
  const may = history.find((h) => h.month === '2026-05')!;
  assert.equal(may.bookingsCount, 1);
  assert.equal(may.bookingsValue, 100000);
  assert.equal(may.scheduledCollections, 20000);
  assert.equal(may.actualCollections, 20000);
});

test('historicalMonthly filters by projectId via unit lookup', async () => {
  const { svc, contracts, units } = freshService();
  await units.save({ id: 'u1', companyId: 'co1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 100000, status: 'contracted', createdAt: isoInMonth(2026, 5) });
  await units.save({ id: 'u2', companyId: 'co1', projectId: 'p2', code: 'B-1', unitType: 'apartment', areaSqm: 100, listPrice: 200000, status: 'contracted', createdAt: isoInMonth(2026, 5) });
  await contracts.save({ id: 'c1', companyId: 'co1', reservationId: 'r1', unitId: 'u1', clientId: 'l1', creditedEmployeeUserId: 'a1', paymentPlanTemplateId: 't1', status: 'signed', signedAt: isoInMonth(2026, 5), createdAt: isoInMonth(2026, 5), totalPrice: 100000 });
  await contracts.save({ id: 'c2', companyId: 'co1', reservationId: 'r2', unitId: 'u2', clientId: 'l2', creditedEmployeeUserId: 'a1', paymentPlanTemplateId: 't1', status: 'signed', signedAt: isoInMonth(2026, 5), createdAt: isoInMonth(2026, 5), totalPrice: 200000 });

  const historyP1 = await svc.historicalMonthly('co1', 'p1', 2, NOW);
  assert.equal(historyP1.find((h) => h.month === '2026-05')!.bookingsValue, 100000);
  const historyAll = await svc.historicalMonthly('co1', undefined, 2, NOW);
  assert.equal(historyAll.find((h) => h.month === '2026-05')!.bookingsValue, 300000);
});

test('forecastFuture projects new bookings as a trailing average and reuses real known future schedule lines', async () => {
  const { svc, contracts, scheduleLines, payments } = freshService();
  // Three complete trailing months (Mar/Apr/May 2026) each with one 90,000 booking.
  for (const month of [3, 4, 5]) {
    const cid = `c-${month}`;
    await contracts.save({ id: cid, companyId: 'co1', reservationId: `r-${month}`, unitId: `u-${month}`, clientId: `l-${month}`, creditedEmployeeUserId: 'a1', paymentPlanTemplateId: 't1', status: 'signed', signedAt: isoInMonth(2026, month), createdAt: isoInMonth(2026, month), totalPrice: 90000 });
    await scheduleLines.save({ id: `s-${month}`, companyId: 'co1', contractId: cid, sourceTemplateId: 't1', sourceTemplateVersion: 1, sequence: 0, label: 'Down Payment', dueDate: isoInMonth(2026, month), amount: 18000, amountPaid: 18000, status: 'paid' });
    await payments.save({ id: `p-${month}`, companyId: 'co1', contractId: cid, paymentScheduleLineId: `s-${month}`, amount: 18000, method: 'cash', recordedByUserId: 'a1', createdAt: isoInMonth(2026, month) });
  }
  // A known future installment (already scheduled, not projected) due in July 2026.
  await scheduleLines.save({ id: 's-future', companyId: 'co1', contractId: 'c-5', sourceTemplateId: 't1', sourceTemplateVersion: 1, sequence: 1, label: 'Installment 1', dueDate: isoInMonth(2026, 7), amount: 10000, amountPaid: 0, status: 'upcoming' });

  const forecast = await svc.forecastFuture('co1', undefined, 3, 3, NOW);
  assert.equal(forecast.projectedNewBookingsPerMonth, 90000);
  assert.equal(forecast.historicalCollectionRatePercent, 100);
  const july = forecast.series.find((s) => s.month === '2026-07')!;
  assert.equal(july.scheduledCollections, 10000);
  assert.equal(july.expectedCollections, 10000);
});

test('forecastFuture applies a historical collection rate below 100% to future scheduled amounts', async () => {
  const { svc, contracts, scheduleLines, payments } = freshService();
  await contracts.save({ id: 'c1', companyId: 'co1', reservationId: 'r1', unitId: 'u1', clientId: 'l1', creditedEmployeeUserId: 'a1', paymentPlanTemplateId: 't1', status: 'signed', signedAt: isoInMonth(2026, 5), createdAt: isoInMonth(2026, 5), totalPrice: 100000 });
  await scheduleLines.save({ id: 's1', companyId: 'co1', contractId: 'c1', sourceTemplateId: 't1', sourceTemplateVersion: 1, sequence: 0, label: 'Down Payment', dueDate: isoInMonth(2026, 5), amount: 20000, amountPaid: 10000, status: 'overdue' });
  await payments.save({ id: 'p1', companyId: 'co1', contractId: 'c1', paymentScheduleLineId: 's1', amount: 10000, method: 'cash', recordedByUserId: 'a1', createdAt: isoInMonth(2026, 5) });
  await scheduleLines.save({ id: 's-future', companyId: 'co1', contractId: 'c1', sourceTemplateId: 't1', sourceTemplateVersion: 1, sequence: 1, label: 'Installment 1', dueDate: isoInMonth(2026, 7), amount: 10000, amountPaid: 0, status: 'upcoming' });

  const forecast = await svc.forecastFuture('co1', undefined, 1, 3, NOW);
  assert.equal(forecast.historicalCollectionRatePercent, 50);
  const july = forecast.series.find((s) => s.month === '2026-07')!;
  assert.equal(july.expectedCollections, 5000);
});

test('forecastFuture rejects an out-of-range trailingMonths/forecastMonths', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.forecastFuture('co1', undefined, 0, 6, NOW));
  await assert.rejects(() => svc.forecastFuture('co1', undefined, 3, 100, NOW));
});

test('compareActualVsForecast contrasts the trailing-average forecast for a month against what actually happened', async () => {
  const { svc, contracts } = freshService();
  await contracts.save({ id: 'c-3', companyId: 'co1', reservationId: 'r3', unitId: 'u3', clientId: 'l3', creditedEmployeeUserId: 'a1', paymentPlanTemplateId: 't1', status: 'signed', signedAt: isoInMonth(2026, 3), createdAt: isoInMonth(2026, 3), totalPrice: 80000 });
  await contracts.save({ id: 'c-4', companyId: 'co1', reservationId: 'r4', unitId: 'u4', clientId: 'l4', creditedEmployeeUserId: 'a1', paymentPlanTemplateId: 't1', status: 'signed', signedAt: isoInMonth(2026, 4), createdAt: isoInMonth(2026, 4), totalPrice: 80000 });
  // Actual May booking is much larger than the Mar/Apr trailing average.
  await contracts.save({ id: 'c-5', companyId: 'co1', reservationId: 'r5', unitId: 'u5', clientId: 'l5', creditedEmployeeUserId: 'a1', paymentPlanTemplateId: 't1', status: 'signed', signedAt: isoInMonth(2026, 5), createdAt: isoInMonth(2026, 5), totalPrice: 160000 });

  const comparison = await svc.compareActualVsForecast('co1', '2026-05', undefined, 2);
  assert.equal(comparison.forecastBookingsValue, 80000);
  assert.equal(comparison.actualBookingsValue, 160000);
  assert.equal(comparison.bookingsVariancePercent, 100);
});

test('compareActualVsForecast rejects a malformed month', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.compareActualVsForecast('co1', 'not-a-month'));
});
