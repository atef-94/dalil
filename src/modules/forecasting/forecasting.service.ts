import type { Contract, Payment, PaymentScheduleLine, Unit } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { ValidationError } from '../../infra/errors.js';

export interface MonthlyHistoryEntry {
  month: string; // 'YYYY-MM'
  bookingsCount: number;
  bookingsValue: number;
  scheduledCollections: number;
  actualCollections: number;
}

export interface ForecastSeriesEntry {
  month: string;
  projectedNewBookingsValue: number;
  scheduledCollections: number;
  expectedCollections: number;
}

export interface ForecastResult {
  method: string;
  projectId?: string;
  trailingMonths: number;
  forecastMonths: number;
  historicalCollectionRatePercent: number | null;
  projectedNewBookingsPerMonth: number;
  totalScheduledFutureCollections: number;
  totalExpectedFutureCollections: number;
  series: ForecastSeriesEntry[];
}

export interface ActualVsForecast {
  month: string;
  trailingMonths: number;
  forecastBookingsValue: number;
  actualBookingsValue: number;
  forecastCollections: number;
  actualCollections: number;
  bookingsVariancePercent: number | null;
  collectionsVariancePercent: number | null;
}

function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

function shiftMonth(monthStr: string, delta: number): string {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Deterministic forecasting built entirely on real historical data and the
 * existing payment-plan engine's own output — no external ML/AI, no
 * randomness. "Scheduled" collections for future months are not a
 * projection at all: they're the real, already-persisted
 * PaymentScheduleLine rows for contracts already signed. Only two numbers
 * in this module are genuinely projected forward: (1) new bookings per
 * month, via a trailing simple moving average, and (2) the historical
 * collection rate (actual collected / scheduled) applied to known future
 * scheduled amounts to account for late/partial payment, the same way
 * every real finance team budgets against a collection-rate assumption.
 */
export class ForecastingService {
  constructor(
    private readonly contracts: Repository<Contract>,
    private readonly scheduleLines: Repository<PaymentScheduleLine>,
    private readonly payments: Repository<Payment>,
    private readonly units: Repository<Unit>,
  ) {}

  private async contractIdsInScope(companyId: string, projectId?: string): Promise<Set<string>> {
    const contracts = await this.contracts.findAll((c) => c.companyId === companyId);
    if (!projectId) return new Set(contracts.map((c) => c.id));
    const units = await this.units.findAll((u) => u.companyId === companyId && u.projectId === projectId);
    const unitIds = new Set(units.map((u) => u.id));
    return new Set(contracts.filter((c) => unitIds.has(c.unitId)).map((c) => c.id));
  }

  /** Trailing `months` calendar months up to and including the current
   * one, oldest first. */
  private async historicalMonthlyInternal(companyId: string, projectId: string | undefined, endMonth: string, months: number): Promise<MonthlyHistoryEntry[]> {
    if (months <= 0 || months > 60) throw new ValidationError('months must be between 1 and 60');
    const contractIds = await this.contractIdsInScope(companyId, projectId);
    const contracts = (await this.contracts.findAll((c) => c.companyId === companyId && contractIds.has(c.id) && c.status === 'signed' && !!c.signedAt));
    const lines = await this.scheduleLines.findAll((l) => l.companyId === companyId && contractIds.has(l.contractId));
    const payments = await this.payments.findAll((p) => p.companyId === companyId && contractIds.has(p.contractId));

    const startMonth = shiftMonth(endMonth, -(months - 1));
    const monthList: string[] = [];
    for (let i = 0; i < months; i++) monthList.push(shiftMonth(startMonth, i));

    return monthList.map((month) => {
      const bookedContracts = contracts.filter((c) => monthKey(c.signedAt!) === month);
      const scheduled = lines.filter((l) => monthKey(l.dueDate) === month).reduce((sum, l) => sum + l.amount, 0);
      const actual = payments.filter((p) => monthKey(p.createdAt) === month).reduce((sum, p) => sum + p.amount, 0);
      return {
        month,
        bookingsCount: bookedContracts.length,
        bookingsValue: round2(bookedContracts.reduce((sum, c) => sum + (c.totalPrice ?? 0), 0)),
        scheduledCollections: round2(scheduled),
        actualCollections: round2(actual),
      };
    });
  }

  /** Historical monthly bookings + collections, real data only, no
   * projection — the raw inputs a user reviews before generating a
   * forecast. */
  async historicalMonthly(companyId: string, projectId?: string, months = 12, now = new Date()): Promise<MonthlyHistoryEntry[]> {
    const endMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    return this.historicalMonthlyInternal(companyId, projectId, endMonth, months);
  }

  async forecastFuture(companyId: string, projectId?: string, trailingMonths = 3, forecastMonths = 6, now = new Date()): Promise<ForecastResult> {
    if (trailingMonths <= 0 || trailingMonths > 24) throw new ValidationError('trailingMonths must be between 1 and 24');
    if (forecastMonths <= 0 || forecastMonths > 24) throw new ValidationError('forecastMonths must be between 1 and 24');

    const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    // Trailing window excludes the current (partial) month so the average
    // isn't skewed by a month that hasn't finished yet.
    const lastCompleteMonth = shiftMonth(currentMonth, -1);
    const trailing = await this.historicalMonthlyInternal(companyId, projectId, lastCompleteMonth, trailingMonths);

    const projectedNewBookingsPerMonth = round2(trailing.reduce((sum, m) => sum + m.bookingsValue, 0) / trailing.length);
    const totalScheduled = trailing.reduce((sum, m) => sum + m.scheduledCollections, 0);
    const totalActual = trailing.reduce((sum, m) => sum + m.actualCollections, 0);
    const historicalCollectionRatePercent = totalScheduled > 0 ? round2((totalActual / totalScheduled) * 100) : null;
    const collectionRate = historicalCollectionRatePercent !== null ? historicalCollectionRatePercent / 100 : 1;

    const contractIds = await this.contractIdsInScope(companyId, projectId);
    const lines = await this.scheduleLines.findAll((l) => l.companyId === companyId && contractIds.has(l.contractId));

    const series: ForecastSeriesEntry[] = [];
    for (let i = 0; i < forecastMonths; i++) {
      const month = shiftMonth(currentMonth, i);
      const scheduledCollections = round2(
        lines.filter((l) => monthKey(l.dueDate) === month).reduce((sum, l) => sum + (l.amount - l.amountPaid), 0),
      );
      series.push({
        month,
        projectedNewBookingsValue: projectedNewBookingsPerMonth,
        scheduledCollections,
        expectedCollections: round2(scheduledCollections * collectionRate),
      });
    }

    return {
      method: `Trailing ${trailingMonths}-month simple moving average for new bookings; known future scheduled payment-plan installments for collections, discounted by the trailing ${trailingMonths}-month historical collection rate.`,
      projectId,
      trailingMonths,
      forecastMonths,
      historicalCollectionRatePercent,
      projectedNewBookingsPerMonth,
      totalScheduledFutureCollections: round2(series.reduce((sum, s) => sum + s.scheduledCollections, 0)),
      totalExpectedFutureCollections: round2(series.reduce((sum, s) => sum + s.expectedCollections, 0)),
      series,
    };
  }

  /** What the trailing-average method would have forecast for `month`,
   * using only the months before it, compared against what actually
   * happened — lets a user sanity-check the method against real
   * outcomes rather than trusting it blindly. */
  async compareActualVsForecast(companyId: string, month: string, projectId?: string, trailingMonths = 3): Promise<ActualVsForecast> {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new ValidationError('month must be in YYYY-MM format');
    if (trailingMonths <= 0 || trailingMonths > 24) throw new ValidationError('trailingMonths must be between 1 and 24');

    const monthBefore = shiftMonth(month, -1);
    const trailing = await this.historicalMonthlyInternal(companyId, projectId, monthBefore, trailingMonths);
    const forecastBookingsValue = round2(trailing.reduce((sum, m) => sum + m.bookingsValue, 0) / trailing.length);
    const totalScheduled = trailing.reduce((sum, m) => sum + m.scheduledCollections, 0);
    const totalActual = trailing.reduce((sum, m) => sum + m.actualCollections, 0);
    const rate = totalScheduled > 0 ? totalActual / totalScheduled : 1;

    const [actualEntry] = await this.historicalMonthlyInternal(companyId, projectId, month, 1);
    const forecastCollections = round2(actualEntry!.scheduledCollections * rate);

    const variance = (forecast: number, actual: number): number | null => (forecast !== 0 ? round2(((actual - forecast) / forecast) * 100) : null);

    return {
      month,
      trailingMonths,
      forecastBookingsValue,
      actualBookingsValue: actualEntry!.bookingsValue,
      forecastCollections,
      actualCollections: actualEntry!.actualCollections,
      bookingsVariancePercent: variance(forecastBookingsValue, actualEntry!.bookingsValue),
      collectionsVariancePercent: variance(forecastCollections, actualEntry!.actualCollections),
    };
  }
}
