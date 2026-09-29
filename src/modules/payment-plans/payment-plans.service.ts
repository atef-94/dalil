import { randomUUID } from 'node:crypto';
import type {
  PaymentPlanFeeLine, PaymentPlanTemplate, PaymentPlanMethod, PaymentPlanScheduledPayment,
  PaymentScheduleLine,
} from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError, ValidationError } from '../../infra/errors.js';
import { generateSchedule, validateTemplate, type GenerateScheduleInput, type GenerateScheduleResult } from './schedule-generator.js';

export interface CreateTemplateInput {
  companyId: string;
  projectId?: string;
  name: string;
  downPaymentType: 'percentage' | 'fixed';
  downPaymentValue: number;
  frequency: PaymentPlanTemplate['frequency'];
  customMonthInterval?: number;
  termMonths: number;
  fees: PaymentPlanFeeLine[];
  /** Defaults to 'equal_installments' when omitted. */
  paymentMethod?: PaymentPlanMethod;
  recurringInstallmentAmount?: number;
  scheduledPayments?: PaymentPlanScheduledPayment[];
  /** Marks a template as a single quotation's own inline terms rather than
   * a reusable one — see PaymentPlanTemplate.adHoc's own comment. */
  adHoc?: boolean;
}

export class PaymentPlansService {
  constructor(
    private readonly templates: Repository<PaymentPlanTemplate>,
    private readonly scheduleLines: Repository<PaymentScheduleLine>,
  ) {}

  async createTemplate(input: CreateTemplateInput): Promise<PaymentPlanTemplate> {
    const template: PaymentPlanTemplate = {
      id: randomUUID(),
      companyId: input.companyId,
      projectId: input.projectId,
      name: input.name,
      version: 1,
      downPaymentType: input.downPaymentType,
      downPaymentValue: input.downPaymentValue,
      frequency: input.frequency,
      customMonthInterval: input.customMonthInterval,
      termMonths: input.termMonths,
      fees: input.fees ?? [],
      paymentMethod: input.paymentMethod,
      recurringInstallmentAmount: input.recurringInstallmentAmount,
      scheduledPayments: input.scheduledPayments,
      adHoc: input.adHoc,
      createdAt: new Date().toISOString(),
      archived: false,
    };
    validateTemplate(template);
    return this.templates.save(template);
  }

  /** Creates and persists an ad-hoc (non-reusable) template from a single
   * Quotation's own inline payment terms — see PaymentPlanTemplate.adHoc's
   * comment for why this exists instead of forcing every one-off
   * quotation to reuse or create a listed reusable template. */
  async createAdHocTemplate(input: Omit<CreateTemplateInput, 'adHoc'>): Promise<PaymentPlanTemplate> {
    return this.createTemplate({ ...input, adHoc: true });
  }

  /** Reusable templates only — excludes ad-hoc ones created inline from a
   * single quotation's own terms, so the picker UI never lists one-off
   * clutter alongside genuinely reusable company/project templates. */
  async listReusableTemplates(companyId: string): Promise<PaymentPlanTemplate[]> {
    return this.templates.findAll((t) => t.companyId === companyId && !t.archived && !t.adHoc);
  }

  async listTemplates(companyId: string): Promise<PaymentPlanTemplate[]> {
    return this.templates.findAll((t) => t.companyId === companyId && !t.archived);
  }

  async getTemplate(id: string): Promise<PaymentPlanTemplate | undefined> {
    return this.templates.findById(id);
  }

  /**
   * Templates never mutate past-generated schedules: editing bumps the
   * version, and every generated PaymentScheduleLine snapshots the
   * sourceTemplateId + sourceTemplateVersion it was generated from.
   */
  async updateTemplate(id: string, patch: Partial<CreateTemplateInput>): Promise<PaymentPlanTemplate> {
    const existing = await this.templates.findById(id);
    if (!existing) throw new NotFoundError('template not found');
    const updated: PaymentPlanTemplate = {
      ...existing,
      ...patch,
      id: existing.id,
      companyId: existing.companyId,
      version: existing.version + 1,
    };
    validateTemplate(updated);
    return this.templates.save(updated);
  }

  async previewSchedule(templateId: string, companyId: string, totalPrice: number, discountPercent?: number, escalationPercentPerYear?: number): Promise<GenerateScheduleResult> {
    const template = await this.templates.findById(templateId);
    if (!template || template.companyId !== companyId) throw new NotFoundError('template not found');
    const input: GenerateScheduleInput = { template, totalPrice, discountPercent, escalationPercentPerYear };
    return generateSchedule(input);
  }

  /**
   * Idempotent: calling this twice for the same contract does not create
   * duplicate lines — it returns the schedule already on file.
   */
  async generateForContract(
    contractId: string,
    companyId: string,
    templateId: string,
    totalPrice: number,
    discountPercent?: number,
    escalationPercentPerYear?: number,
  ): Promise<PaymentScheduleLine[]> {
    const existing = await this.scheduleLines.findAll((l) => l.contractId === contractId && l.companyId === companyId);
    if (existing.length > 0) {
      return existing.sort((a, b) => a.sequence - b.sequence);
    }

    const template = await this.templates.findById(templateId);
    if (!template || template.companyId !== companyId) throw new NotFoundError('template not found');

    const generated = generateSchedule({ template, totalPrice, discountPercent, escalationPercentPerYear });
    // A signed contract is a real financial commitment, not a draft — unlike
    // a Quotation (which may legitimately be saved in an unreconciled state
    // for later editing, per the existing draft-status precedent), a
    // contract's schedule must reconcile before it's ever persisted.
    if (!generated.validation.isValid) {
      throw new ValidationError(
        generated.validation.overpayment > 0
          ? `payment plan overpays the total by ${generated.validation.overpayment}`
          : `payment plan leaves a remaining balance of ${generated.validation.remainingBalance}`,
      );
    }
    const lines: PaymentScheduleLine[] = [];
    for (const line of generated.lines) {
      const saved = await this.scheduleLines.save({
        id: randomUUID(),
        companyId,
        contractId,
        sourceTemplateId: template.id,
        sourceTemplateVersion: template.version,
        sequence: line.sequence,
        label: line.label,
        kind: line.kind,
        dueDate: line.dueDate,
        amount: line.amount,
        amountPaid: 0,
        status: line.status,
      });
      lines.push(saved);
    }
    return lines;
  }

  async getScheduleForContract(contractId: string, companyId: string): Promise<PaymentScheduleLine[]> {
    const lines = await this.scheduleLines.findAll((l) => l.contractId === contractId && l.companyId === companyId);
    return lines.sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * Contract Amendment support: rescales every not-yet-paid line
   * (amountPaid === 0) proportionally so they sum exactly to
   * `newUnpaidTotal`, keeping each line's original label/dueDate/sequence.
   * Lines already paid or partially paid are never touched here — the
   * caller (SalesService.amendContract) is responsible for excluding
   * their amounts from `newUnpaidTotal` first. Fee lines are rescaled
   * along with installments for simplicity, since an amendment changes
   * the deal's economics as a whole.
   */
  async rescaleUnpaidLines(contractId: string, companyId: string, newUnpaidTotal: number): Promise<PaymentScheduleLine[]> {
    if (newUnpaidTotal < 0) throw new ValidationError('newUnpaidTotal cannot be negative');
    const lines = await this.getScheduleForContract(contractId, companyId);
    const unpaid = lines.filter((l) => l.amountPaid === 0);
    if (unpaid.length === 0) {
      if (newUnpaidTotal > 0.005) throw new ValidationError('no unpaid schedule lines exist to absorb the new balance');
      return [];
    }

    const oldTotal = unpaid.reduce((sum, l) => sum + l.amount, 0);
    const rawAmounts = unpaid.map((l) => (oldTotal > 0 ? (l.amount * newUnpaidTotal) / oldTotal : newUnpaidTotal / unpaid.length));
    const rounded = rawAmounts.map((a) => Math.round(a * 100) / 100);
    const sum = rounded.reduce((a, b) => a + b, 0);
    const residual = Math.round((newUnpaidTotal - sum) * 100) / 100;
    rounded[rounded.length - 1] = Math.round((rounded[rounded.length - 1]! + residual) * 100) / 100;

    const saved: PaymentScheduleLine[] = [];
    for (let i = 0; i < unpaid.length; i++) {
      saved.push(await this.scheduleLines.save({ ...unpaid[i]!, amount: rounded[i]! }));
    }
    return saved;
  }
}
