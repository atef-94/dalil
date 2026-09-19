import { randomUUID } from 'node:crypto';
import type { GeneratedLine } from '../payment-plans/schedule-generator.js';
import type { Quotation, QuotationStatus, Unit } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import type { PaymentPlansService } from '../payment-plans/payment-plans.service.js';
import { NotFoundError, ValidationError } from '../../infra/errors.js';
import { netContractValue } from '../../domain/money.js';

export interface QuotationInputs {
  unitId: string;
  paymentPlanTemplateId: string;
  discountPercent?: number;
  escalationPercentPerYear?: number;
  /** Overrides the unit's own listPrice — e.g. a negotiated starting
   * price before any discount is applied. Defaults to unit.listPrice. */
  totalPriceOverride?: number;
}

export interface QuotationCalculation {
  unit: Unit;
  totalPrice: number;
  discountPercent: number;
  escalationPercentPerYear: number;
  netValue: number;
  downPayment: number;
  schedule: GeneratedLine[];
}

export interface GenerateQuotationInput extends QuotationInputs {
  companyId: string;
  leadId?: string;
  createdByUserId: string;
}

/**
 * Wraps PaymentPlansService's existing calculation engine
 * (schedule-generator.ts's generateSchedule, already used by both the
 * manual "Record Payment" flow and Contract signing) for pre-sale
 * quotations — the same engine computes the live UI preview, the
 * generated/persisted Quotation, and the PDF/Excel exports, so there is
 * never a second, possibly-divergent calculation path. Generating a
 * quotation only ever reads a Unit and a PaymentPlanTemplate — it never
 * writes to either, or to any Reservation/Contract/Finance record.
 */
export class QuotationService {
  constructor(
    private readonly quotations: Repository<Quotation>,
    private readonly units: Repository<Unit>,
    private readonly paymentPlans: PaymentPlansService,
  ) {}

  private async resolveUnit(companyId: string, unitId: string): Promise<Unit> {
    const unit = await this.units.findById(unitId);
    if (!unit || unit.companyId !== companyId) throw new NotFoundError('unit not found');
    return unit;
  }

  /** Live, no-commitment calculation — the interactive UI calls this on
   * every input change, and it is exactly what a persisted quotation's
   * `recompute()` replays later, so a saved quotation always matches what
   * the user actually saw. */
  async calculate(companyId: string, input: QuotationInputs): Promise<QuotationCalculation> {
    const unit = await this.resolveUnit(companyId, input.unitId);
    const totalPrice = input.totalPriceOverride ?? unit.listPrice;
    if (!(totalPrice > 0)) throw new ValidationError('totalPrice must be positive');
    const discountPercent = input.discountPercent ?? 0;
    const escalationPercentPerYear = input.escalationPercentPerYear ?? 0;

    const schedule = await this.paymentPlans.previewSchedule(input.paymentPlanTemplateId, companyId, totalPrice, discountPercent, escalationPercentPerYear);
    const downPayment = schedule.find((l) => l.label === 'Down Payment')?.amount ?? 0;

    return {
      unit,
      totalPrice,
      discountPercent,
      escalationPercentPerYear,
      netValue: netContractValue(totalPrice, discountPercent),
      downPayment,
      schedule,
    };
  }

  /** Persists a new, immutable version — never overwrites a prior
   * quotation. A new call for the same unit (and, if given, the same
   * lead) always gets its own id, its own incrementing `version`, and its
   * own unique `referenceNumber`. */
  async generate(input: GenerateQuotationInput): Promise<Quotation> {
    const unit = await this.resolveUnit(input.companyId, input.unitId);
    const totalPrice = input.totalPriceOverride ?? unit.listPrice;
    // Validates the template/inputs resolve to a real schedule before persisting anything.
    await this.calculate(input.companyId, input);

    const priorVersions = await this.quotations.findAll(
      (q) => q.companyId === input.companyId && q.unitId === input.unitId && (!input.leadId || q.leadId === input.leadId),
    );
    const referenceNumber = await this.nextReferenceNumber(input.companyId);
    const now = new Date().toISOString();

    const quotation: Quotation = {
      id: randomUUID(),
      companyId: input.companyId,
      referenceNumber,
      version: priorVersions.length + 1,
      unitId: unit.id,
      projectId: unit.projectId,
      leadId: input.leadId,
      paymentPlanTemplateId: input.paymentPlanTemplateId,
      status: 'generated',
      inputs: {
        totalPrice,
        discountPercent: input.discountPercent ?? 0,
        escalationPercentPerYear: input.escalationPercentPerYear ?? 0,
        startDate: now,
      },
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
    };
    return this.quotations.save(quotation);
  }

  async getQuotation(id: string, companyId: string): Promise<Quotation> {
    const quotation = await this.quotations.findById(id);
    if (!quotation || quotation.companyId !== companyId) throw new NotFoundError('quotation not found');
    return quotation;
  }

  /** Replays a persisted quotation's exact stored inputs through the same
   * engine `calculate()` uses — this is what the PDF/Excel export and the
   * "view saved quotation" screen call, so a quotation reopened a month
   * later reconciles exactly with what was generated (as long as the
   * referenced PaymentPlanTemplate itself hasn't since been edited — the
   * one honest limitation of not also snapshotting the template's own fee
   * lines, matching how PaymentScheduleLine's sourceTemplateVersion
   * exists for the same reason on a signed contract's real schedule). */
  async recompute(id: string, companyId: string): Promise<{ quotation: Quotation; calculation: QuotationCalculation }> {
    const quotation = await this.getQuotation(id, companyId);
    const calculation = await this.calculate(companyId, {
      unitId: quotation.unitId,
      paymentPlanTemplateId: quotation.paymentPlanTemplateId,
      discountPercent: quotation.inputs.discountPercent,
      escalationPercentPerYear: quotation.inputs.escalationPercentPerYear,
      totalPriceOverride: quotation.inputs.totalPrice,
    });
    return { quotation, calculation };
  }

  async listForCompany(companyId: string, filters: { unitId?: string; leadId?: string } = {}): Promise<Quotation[]> {
    const all = await this.quotations.findAll(
      (q) => q.companyId === companyId && (!filters.unitId || q.unitId === filters.unitId) && (!filters.leadId || q.leadId === filters.leadId),
    );
    return all.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async updateStatus(id: string, companyId: string, status: QuotationStatus): Promise<Quotation> {
    const quotation = await this.getQuotation(id, companyId);
    return this.quotations.save({ ...quotation, status, updatedAt: new Date().toISOString() });
  }

  private async nextReferenceNumber(companyId: string): Promise<string> {
    const existing = await this.quotations.findAll((q) => q.companyId === companyId);
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `Q-${datePart}-${String(existing.length + 1).padStart(4, '0')}`;
  }
}
