import { randomUUID } from 'node:crypto';
import { generateSchedule, type GeneratedLine, type ScheduleValidation } from '../payment-plans/schedule-generator.js';
import type {
  Quotation, QuotationStatus, QuotationUnitSnapshot, Unit, Project, PaymentPlanTemplate,
  PaymentPlanFeeLine, PaymentPlanMethod, PaymentPlanScheduledPayment, PaymentFrequency,
} from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import type { PaymentPlansService } from '../payment-plans/payment-plans.service.js';
import { NotFoundError, ValidationError } from '../../infra/errors.js';
import { netContractValue } from '../../domain/money.js';

// A unit not yet in Inventory (spec section 2B: "Payment Plan not connected
// to an existing Inventory Unit"): the caller supplies the same
// financial/physical attributes a real Unit would carry. There is no Unit
// row to link, so the resulting Quotation's `unitId` stays unset and
// `unitSnapshot` (built from this input) is the sole source of truth from
// the start, never something to "fall back to" later.
export interface ManualUnitInput {
  code: string;
  unitType: string;
  areaSqm: number;
  listPrice: number;
  buildingLabel?: string;
  floorLabel?: string;
  bedrooms?: number;
  view?: string[];
  gardenAreaSqm?: number;
  finishingType?: string;
  maintenanceFeePercent?: number;
  parkingIncluded?: boolean;
  parkingSpaces?: number;
  parkingPrice?: number;
}

// One-off payment terms entered directly on a single Quotation instead of
// picking an existing reusable PaymentPlanTemplate. Never a second
// calculation path: calculate() feeds these straight into the same
// generateSchedule() a real template uses, and generate() persists them as
// an ad-hoc PaymentPlanTemplate (PaymentPlansService.createAdHocTemplate)
// exactly once, at save time — never on every live-preview recalculation —
// so there is still only ever one Payment Plan entity, per the spec's
// explicit "not two separate template types" requirement.
export interface InlineTermsInput {
  downPaymentType: 'percentage' | 'fixed';
  downPaymentValue: number;
  frequency: PaymentFrequency;
  customMonthInterval?: number;
  termMonths: number;
  fees?: PaymentPlanFeeLine[];
  paymentMethod?: PaymentPlanMethod;
  recurringInstallmentAmount?: number;
  scheduledPayments?: PaymentPlanScheduledPayment[];
}

export interface QuotationInputs {
  /** Exactly one of unitId or manualUnit is required. */
  unitId?: string;
  manualUnit?: ManualUnitInput;
  /** Only meaningful alongside manualUnit — a manually-entered unit may
   * still belong to a known Project (never fabricated if omitted). */
  manualProjectId?: string;
  /** Exactly one of paymentPlanTemplateId or inlineTerms is required. */
  paymentPlanTemplateId?: string;
  inlineTerms?: InlineTermsInput;
  discountPercent?: number;
  escalationPercentPerYear?: number;
  /** Overrides the unit's own listPrice — e.g. a negotiated starting
   * price before any discount is applied. Defaults to unit.listPrice
   * (or manualUnit.listPrice when there is no real Unit). */
  totalPriceOverride?: number;
}

export interface QuotationCalculation {
  /** Undefined when this calculation came from a manually-entered unit —
   * unitSnapshot is then the only source of unit data. */
  unit?: Unit;
  unitSnapshot: QuotationUnitSnapshot;
  totalPrice: number;
  discountPercent: number;
  escalationPercentPerYear: number;
  netValue: number;
  downPayment: number;
  schedule: GeneratedLine[];
  validation: ScheduleValidation;
}

export interface GenerateQuotationInput extends QuotationInputs {
  companyId: string;
  leadId?: string;
  createdByUserId: string;
}

function buildTransientTemplate(companyId: string, terms: InlineTermsInput): PaymentPlanTemplate {
  return {
    id: 'transient',
    companyId,
    name: 'Inline Terms',
    version: 1,
    downPaymentType: terms.downPaymentType,
    downPaymentValue: terms.downPaymentValue,
    frequency: terms.frequency,
    customMonthInterval: terms.customMonthInterval,
    termMonths: terms.termMonths,
    fees: terms.fees ?? [],
    paymentMethod: terms.paymentMethod,
    recurringInstallmentAmount: terms.recurringInstallmentAmount,
    scheduledPayments: terms.scheduledPayments,
    createdAt: new Date().toISOString(),
    archived: false,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Wraps PaymentPlansService's existing calculation engine
 * (schedule-generator.ts's generateSchedule, already used by both the
 * manual "Record Payment" flow and Contract signing) for pre-sale
 * quotations — the same engine computes the live UI preview, the
 * generated/persisted Quotation, and the PDF/Excel exports, so there is
 * never a second, possibly-divergent calculation path. Generating a
 * quotation only ever reads a Unit/Project and a PaymentPlanTemplate — it
 * never writes to either, or to any Reservation/Contract/Finance record
 * (an ad-hoc PaymentPlanTemplate for inline terms is the one exception,
 * and even that is just another PaymentPlanTemplate row, not a new kind of
 * write).
 */
export class QuotationService {
  constructor(
    private readonly quotations: Repository<Quotation>,
    private readonly units: Repository<Unit>,
    private readonly projects: Repository<Project>,
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

  private async resolveSource(companyId: string, input: QuotationInputs): Promise<{ unit?: Unit; manualUnit?: ManualUnitInput }> {
    const hasUnitId = !!input.unitId;
    const hasManual = !!input.manualUnit;
    if (hasUnitId === hasManual) {
      throw new ValidationError('exactly one of unitId or manualUnit is required');
    }
    if (input.unitId) {
      return { unit: await this.resolveUnit(companyId, input.unitId) };
    }
    if (!input.manualUnit!.code?.trim()) throw new ValidationError('manualUnit.code is required');
    if (!(input.manualUnit!.listPrice > 0)) throw new ValidationError('manualUnit.listPrice must be positive');
    if (!(input.manualUnit!.areaSqm > 0)) throw new ValidationError('manualUnit.areaSqm must be positive');
    return { manualUnit: input.manualUnit };
  }

  private async buildUnitSnapshot(
    source: { unit?: Unit; manualUnit?: ManualUnitInput },
    totalPrice: number,
  ): Promise<QuotationUnitSnapshot> {
    if (source.unit) {
      const u = source.unit;
      const project = await this.projects.findById(u.projectId);
      const maintenanceFeePercent = u.maintenanceFeePercentOverride ?? project?.maintenanceFeePercent;
      const pricePerMeter = u.pricePerMeterOverride ?? (u.areaSqm > 0 ? round2(totalPrice / u.areaSqm) : 0);
      return {
        code: u.code,
        unitType: u.unitType,
        areaSqm: u.areaSqm,
        buildingLabel: u.buildingLabel,
        floorLabel: u.floorLabel,
        bedrooms: u.bedrooms,
        view: u.view,
        gardenAreaSqm: u.gardenAreaSqm,
        finishingType: u.finishingType ?? project?.finishingType,
        pricePerMeter,
        totalUnitPrice: totalPrice,
        maintenanceFeePercent,
        maintenanceFeeAmount: maintenanceFeePercent !== undefined ? round2((totalPrice * maintenanceFeePercent) / 100) : undefined,
        parkingIncluded: u.parkingIncluded,
        parkingSpaces: u.parkingSpaces,
        parkingPrice: u.parkingPrice,
      };
    }
    const m = source.manualUnit!;
    const pricePerMeter = m.areaSqm > 0 ? round2(totalPrice / m.areaSqm) : 0;
    return {
      code: m.code,
      unitType: m.unitType,
      areaSqm: m.areaSqm,
      buildingLabel: m.buildingLabel,
      floorLabel: m.floorLabel,
      bedrooms: m.bedrooms,
      view: m.view,
      gardenAreaSqm: m.gardenAreaSqm,
      finishingType: m.finishingType,
      pricePerMeter,
      totalUnitPrice: totalPrice,
      maintenanceFeePercent: m.maintenanceFeePercent,
      maintenanceFeeAmount: m.maintenanceFeePercent !== undefined ? round2((totalPrice * m.maintenanceFeePercent) / 100) : undefined,
      parkingIncluded: m.parkingIncluded,
      parkingSpaces: m.parkingSpaces,
      parkingPrice: m.parkingPrice,
    };
  }

  /** Live, no-commitment calculation — the interactive UI calls this on
   * every input change, and it is exactly what a persisted quotation's
   * `recompute()` replays later, so a saved quotation always matches what
   * the user actually saw. Never persists anything, even when inlineTerms
   * is used (a transient, unsaved PaymentPlanTemplate-shaped object feeds
   * the same generateSchedule() a real template uses — see
   * buildTransientTemplate). */
  async calculate(companyId: string, input: QuotationInputs): Promise<QuotationCalculation> {
    const source = await this.resolveSource(companyId, input);
    const unitListPrice = source.unit ? source.unit.listPrice : source.manualUnit!.listPrice;
    const totalPrice = input.totalPriceOverride ?? unitListPrice;
    if (!(totalPrice > 0)) throw new ValidationError('totalPrice must be positive');
    const discountPercent = input.discountPercent ?? 0;
    const escalationPercentPerYear = input.escalationPercentPerYear ?? 0;

    const hasTemplateId = !!input.paymentPlanTemplateId;
    const hasInline = !!input.inlineTerms;
    if (hasTemplateId === hasInline) {
      throw new ValidationError('exactly one of paymentPlanTemplateId or inlineTerms is required');
    }

    const result = hasTemplateId
      ? await this.paymentPlans.previewSchedule(input.paymentPlanTemplateId!, companyId, totalPrice, discountPercent, escalationPercentPerYear)
      : generateSchedule({
          template: buildTransientTemplate(companyId, input.inlineTerms!),
          totalPrice,
          discountPercent,
          escalationPercentPerYear,
        });

    const downPayment = result.lines.find((l) => l.kind === 'down_payment')?.amount ?? 0;
    const unitSnapshot = await this.buildUnitSnapshot(source, totalPrice);

    return {
      unit: source.unit,
      unitSnapshot,
      totalPrice,
      discountPercent,
      escalationPercentPerYear,
      netValue: netContractValue(totalPrice, discountPercent),
      downPayment,
      schedule: result.lines,
      validation: result.validation,
    };
  }

  /** Persists a new, immutable version — never overwrites a prior
   * quotation. A new call for the same unit (and, if given, the same
   * lead) always gets its own id, its own incrementing `version`, and its
   * own unique `referenceNumber`. The generated schedule is computed once,
   * right here, and stored as scheduleSnapshot — never recomputed from a
   * possibly-since-edited Unit/Template on later reads (see recompute()).
   * `unitSnapshot` freezes the unit's own attributes the same way, closing
   * the gap where only the schedule numbers used to be a true deep
   * snapshot. */
  async generate(input: GenerateQuotationInput): Promise<Quotation> {
    const calculation = await this.calculate(input.companyId, input);

    let paymentPlanTemplateId: string;
    let sourceTemplateVersion: number;
    if (input.paymentPlanTemplateId) {
      const template = await this.paymentPlans.getTemplate(input.paymentPlanTemplateId);
      if (!template || template.companyId !== input.companyId) throw new NotFoundError('template not found');
      paymentPlanTemplateId = template.id;
      sourceTemplateVersion = template.version;
    } else {
      const t = input.inlineTerms!;
      const created = await this.paymentPlans.createAdHocTemplate({
        companyId: input.companyId,
        name: `Inline Terms (${calculation.unitSnapshot.code})`,
        downPaymentType: t.downPaymentType,
        downPaymentValue: t.downPaymentValue,
        frequency: t.frequency,
        customMonthInterval: t.customMonthInterval,
        termMonths: t.termMonths,
        fees: t.fees ?? [],
        paymentMethod: t.paymentMethod,
        recurringInstallmentAmount: t.recurringInstallmentAmount,
        scheduledPayments: t.scheduledPayments,
      });
      paymentPlanTemplateId = created.id;
      sourceTemplateVersion = created.version;
    }

    const priorVersions = await this.quotations.findAll((q) => {
      if (q.companyId !== input.companyId) return false;
      if (input.leadId && q.leadId !== input.leadId) return false;
      if (input.unitId) return q.unitId === input.unitId;
      return !q.unitId && q.unitSnapshot?.code === calculation.unitSnapshot.code;
    });
    const referenceNumber = await this.nextReferenceNumber(input.companyId);
    const now = new Date().toISOString();

    const quotation: Quotation = {
      id: randomUUID(),
      companyId: input.companyId,
      referenceNumber,
      version: priorVersions.length + 1,
      unitId: calculation.unit?.id,
      projectId: calculation.unit?.projectId ?? input.manualProjectId,
      leadId: input.leadId,
      unitSnapshot: calculation.unitSnapshot,
      paymentPlanTemplateId,
      sourceTemplateVersion,
      status: 'generated',
      inputs: {
        totalPrice: calculation.totalPrice,
        discountPercent: calculation.discountPercent,
        escalationPercentPerYear: calculation.escalationPercentPerYear,
        startDate: now,
      },
      scheduleSnapshot: calculation.schedule.map((l) => ({
        sequence: l.sequence, label: l.label, kind: l.kind, dueDate: l.dueDate, amount: l.amount, status: l.status,
      })),
      validation: calculation.validation,
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
   * own stored scheduleSnapshot/inputs/unitSnapshot — this is what the
   * PDF/Excel export and the "view saved quotation" screen call, so a
   * quotation reopened a month later renders byte-for-byte what was
   * generated, even if the unit's price or the payment plan template have
   * since been edited or the unit deleted. `unit` is fetched only for a
   * quotation old enough to predate `unitSnapshot` (never for its current
   * listPrice, which recompute never reads) — callers should prefer
   * `unitSnapshot` and only fall back to a live Unit fetch when it's
   * absent. */
  async recompute(id: string, companyId: string): Promise<{ quotation: Quotation; calculation: QuotationCalculation }> {
    const quotation = await this.getQuotation(id, companyId);
    const unit = quotation.unitId ? await this.resolveUnit(companyId, quotation.unitId) : undefined;
    const unitSnapshot = quotation.unitSnapshot ?? (unit ? await this.buildUnitSnapshot({ unit }, quotation.inputs.totalPrice) : undefined);
    if (!unitSnapshot) throw new NotFoundError('quotation has no unit snapshot and no linked unit');
    const calculation: QuotationCalculation = {
      unit,
      unitSnapshot,
      totalPrice: quotation.inputs.totalPrice,
      discountPercent: quotation.inputs.discountPercent,
      escalationPercentPerYear: quotation.inputs.escalationPercentPerYear,
      netValue: netContractValue(quotation.inputs.totalPrice, quotation.inputs.discountPercent),
      downPayment: quotation.scheduleSnapshot.find((l) => l.kind === 'down_payment' || l.label === 'Down Payment')?.amount ?? 0,
      schedule: quotation.scheduleSnapshot.map((l) => ({ ...l, kind: l.kind ?? inferKind(l.label) })),
      validation: quotation.validation ?? { totalPayable: quotation.inputs.totalPrice, remainingBalance: 0, isValid: true, overpayment: 0 },
    };
    return { quotation, calculation };
  }

  async listForCompany(companyId: string, filters: { unitId?: string; leadId?: string } = {}): Promise<Quotation[]> {
    const all = await this.quotations.findAll(
      (q) => q.companyId === companyId && (!filters.unitId || q.unitId === filters.unitId) && (!filters.leadId || q.leadId === filters.leadId),
    );
    return all.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  /** A quotation may only move to a customer-facing status ('sent' /
   * 'accepted') once its frozen schedule actually reconciles — the spec's
   * "prevent final saving/activation until the financial plan is valid"
   * requirement, applied at the status-transition boundary rather than at
   * generate() time so an out-of-balance plan can still be saved and
   * edited as a draft/'generated' quotation (the existing draft-status
   * precedent this codebase already has for Quotation). */
  async updateStatus(id: string, companyId: string, status: QuotationStatus): Promise<Quotation> {
    const quotation = await this.getQuotation(id, companyId);
    if ((status === 'sent' || status === 'accepted') && quotation.validation && !quotation.validation.isValid) {
      throw new ValidationError(
        quotation.validation.overpayment > 0
          ? `cannot mark as ${status}: payment plan overpays by ${quotation.validation.overpayment}`
          : `cannot mark as ${status}: payment plan leaves a remaining balance of ${quotation.validation.remainingBalance}`,
      );
    }
    return this.quotations.save({ ...quotation, status, updatedAt: new Date().toISOString() });
  }

  private async nextReferenceNumber(companyId: string): Promise<string> {
    const existing = await this.quotations.findAll((q) => q.companyId === companyId);
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `Q-${datePart}-${String(existing.length + 1).padStart(4, '0')}`;
  }
}

// Best-effort fallback for pre-existing scheduleSnapshot entries saved
// before `kind` existed — matches the label conventions generateSchedule()
// has always used, so old quotations render the same Payment Type column
// new ones do without needing a data migration.
function inferKind(label: string): GeneratedLine['kind'] {
  if (label === 'Down Payment') return 'down_payment';
  if (label.startsWith('Installment')) return 'installment';
  if (label === 'Scheduled Payment') return 'scheduled_payment';
  return 'fee';
}
