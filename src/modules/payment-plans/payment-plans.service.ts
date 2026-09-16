import { randomUUID } from 'node:crypto';
import type { PaymentPlanFeeLine, PaymentPlanTemplate, PaymentScheduleLine } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError } from '../../infra/errors.js';
import { generateSchedule, validateTemplate, type GenerateScheduleInput } from './schedule-generator.js';

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
      createdAt: new Date().toISOString(),
      archived: false,
    };
    validateTemplate(template);
    return this.templates.save(template);
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

  async previewSchedule(templateId: string, totalPrice: number, discountPercent?: number, escalationPercentPerYear?: number) {
    const template = await this.templates.findById(templateId);
    if (!template) throw new NotFoundError('template not found');
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
    const existing = await this.scheduleLines.findAll((l) => l.contractId === contractId);
    if (existing.length > 0) {
      return existing.sort((a, b) => a.sequence - b.sequence);
    }

    const template = await this.templates.findById(templateId);
    if (!template) throw new NotFoundError('template not found');

    const generated = generateSchedule({ template, totalPrice, discountPercent, escalationPercentPerYear });
    const lines: PaymentScheduleLine[] = [];
    for (const line of generated) {
      const saved = await this.scheduleLines.save({
        id: randomUUID(),
        companyId,
        contractId,
        sourceTemplateId: template.id,
        sourceTemplateVersion: template.version,
        sequence: line.sequence,
        label: line.label,
        dueDate: line.dueDate,
        amount: line.amount,
        amountPaid: 0,
        status: line.status,
      });
      lines.push(saved);
    }
    return lines;
  }

  async getScheduleForContract(contractId: string): Promise<PaymentScheduleLine[]> {
    const lines = await this.scheduleLines.findAll((l) => l.contractId === contractId);
    return lines.sort((a, b) => a.sequence - b.sequence);
  }
}
