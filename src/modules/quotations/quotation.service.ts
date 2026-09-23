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

  /** Looks a unit up by its own code (case-insensitive) rather than its
   * internal id — this is what "type a unit code, auto-fill everything"
   * (the Offer builder's entry point) needs, since a salesperson knows the
   * code printed on the price list, never the database id. */
  async findUnitByCode(companyId: string, code: string): Promise<Unit> {
    const trimmed = code.trim();
    if (!trimmed) throw new ValidationError('a unit code is required');
    const units = await this.units.findAll((u) => u.companyId === companyId && u.code.trim().toLowerCase() === trimmed.toLowerCase());
    const unit = units[0];
    if (!unit) throw new NotFoundError(`no unit found with code "${code}"`);
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
   * own unique `referenceNumber`. The generated schedule is computed once,
   * right here, and stored as scheduleSnapshot — never recomputed from a
   * possibly-since-edited Unit/Template on later reads (see recompute()). */
  async generate(input: GenerateQuotationInput): Promise<Quotation> {
    const unit = await this.resolveUnit(input.companyId, input.unitId);
    const totalPrice = input.totalPriceOverride ?? unit.listPrice;
    const calculation = await this.calculate(input.companyId, input);
    const template = await this.paymentPlans.getTemplate(input.paymentPlanTemplateId);
    if (!template || template.companyId !== input.companyId) throw new NotFoundError('template not found');

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
      sourceTemplateVersion: template.version,
      status: 'generated',
      inputs: {
        totalPrice,
        discountPercent: input.discountPercent ?? 0,
        escalationPercentPerYear: input.escalationPercentPerYear ?? 0,
        startDate: now,
      },
      scheduleSnapshot: calculation.schedule.map((l) => ({ sequence: l.sequence, label: l.label, dueDate: l.dueDate, amount: l.amount, status: l.status })),
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

  /** Rebuilds the QuotationCalculation view purely from the quotation's
   * own stored scheduleSnapshot/inputs — this is what the PDF/Excel export
   * and the "view saved quotation" screen call, so a quotation reopened a
   * month later renders byte-for-byte what was generated, even if the
   * unit's price or the payment plan template have since been edited or
   * the unit deleted (unit is fetched only for display metadata — code,
   * project, area — never for its current listPrice, which recompute
   * never reads). */
  async recompute(id: string, companyId: string): Promise<{ quotation: Quotation; calculation: QuotationCalculation }> {
    const quotation = await this.getQuotation(id, companyId);
    const unit = await this.resolveUnit(companyId, quotation.unitId);
    const calculation: QuotationCalculation = {
      unit,
      totalPrice: quotation.inputs.totalPrice,
      discountPercent: quotation.inputs.discountPercent,
      escalationPercentPerYear: quotation.inputs.escalationPercentPerYear,
      netValue: netContractValue(quotation.inputs.totalPrice, quotation.inputs.discountPercent),
      downPayment: quotation.scheduleSnapshot.find((l) => l.label === 'Down Payment')?.amount ?? 0,
      schedule: quotation.scheduleSnapshot,
    };
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
