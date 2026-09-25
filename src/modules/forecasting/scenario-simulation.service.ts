import type { PaymentPlanFeeLine, PaymentPlanTemplate, PaymentFrequency } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError, ValidationError } from '../../infra/errors.js';
import { generateSchedule, type GeneratedLine } from '../payment-plans/schedule-generator.js';

export interface AdHocPlanInput {
  downPaymentType: 'percentage' | 'fixed';
  downPaymentValue: number;
  frequency: PaymentFrequency;
  customMonthInterval?: number;
  termMonths: number;
  fees?: PaymentPlanFeeLine[];
}

export interface ScenarioInput {
  totalPrice: number;
  discountPercent?: number;
  escalationPercentPerYear?: number;
  templateId?: string;
  adHocPlan?: AdHocPlanInput;
  annualDiscountRatePercentForNpv?: number;
  startDate?: string;
}

export interface ScenarioResult {
  totalPrice: number;
  discountPercent: number;
  discountAmount: number;
  netContractValue: number;
  totalCollectible: number;
  annualDiscountRatePercentForNpv: number;
  npv: number;
  schedule: GeneratedLine[];
  cashFlowByMonth: { month: string; amount: number }[];
}

export interface ScenarioComparison {
  scenario: ScenarioResult;
  baseline: ScenarioResult;
  delta: {
    netContractValueDelta: number;
    totalCollectibleDelta: number;
    npvDelta: number;
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pure, stateless "what-if" calculator — never persists anything, exactly
 * like PaymentPlansService.previewSchedule. Reuses the real
 * generateSchedule() engine (the same function that builds every actual
 * signed contract's schedule) so a simulated scenario and a real contract
 * are computed identically.
 */
export class ScenarioSimulationService {
  constructor(private readonly templates: Repository<PaymentPlanTemplate>) {}

  private async resolveTemplate(companyId: string, input: ScenarioInput): Promise<PaymentPlanTemplate> {
    if (input.templateId) {
      const template = await this.templates.findById(input.templateId);
      if (!template || template.companyId !== companyId) throw new NotFoundError('payment plan template not found');
      return template;
    }
    if (input.adHocPlan) {
      const plan = input.adHocPlan;
      return {
        id: 'scenario-adhoc',
        companyId,
        name: 'Ad-hoc scenario plan',
        version: 1,
        downPaymentType: plan.downPaymentType,
        downPaymentValue: plan.downPaymentValue,
        frequency: plan.frequency,
        customMonthInterval: plan.customMonthInterval,
        termMonths: plan.termMonths,
        fees: plan.fees ?? [],
        createdAt: new Date().toISOString(),
        archived: false,
      };
    }
    throw new ValidationError('either templateId or adHocPlan is required');
  }

  private monthsBetween(startIso: string, dueIso: string): number {
    const start = new Date(startIso);
    const due = new Date(dueIso);
    return (due.getUTCFullYear() - start.getUTCFullYear()) * 12 + (due.getUTCMonth() - start.getUTCMonth());
  }

  async runScenario(companyId: string, input: ScenarioInput): Promise<ScenarioResult> {
    if (!(input.totalPrice > 0)) throw new ValidationError('totalPrice must be positive');
    const discountPercent = input.discountPercent ?? 0;
    const annualDiscountRatePercentForNpv = input.annualDiscountRatePercentForNpv ?? 0;
    if (annualDiscountRatePercentForNpv < 0 || annualDiscountRatePercentForNpv > 100) {
      throw new ValidationError('annualDiscountRatePercentForNpv must be between 0 and 100');
    }
    const startDate = input.startDate ?? new Date().toISOString();
    const template = await this.resolveTemplate(companyId, input);

    const schedule = generateSchedule({
      template,
      totalPrice: input.totalPrice,
      discountPercent: input.discountPercent,
      escalationPercentPerYear: input.escalationPercentPerYear,
      startDate: new Date(startDate),
    });

    const netContractValue = round2(input.totalPrice * (1 - discountPercent / 100));
    const totalCollectible = round2(schedule.reduce((sum, l) => sum + l.amount, 0));
    const discountAmount = round2(input.totalPrice - netContractValue);

    const rate = annualDiscountRatePercentForNpv / 100;
    const npv = round2(
      schedule.reduce((sum, l) => {
        const monthsFromStart = this.monthsBetween(startDate, l.dueDate);
        const discountFactor = rate > 0 ? Math.pow(1 + rate, monthsFromStart / 12) : 1;
        return sum + l.amount / discountFactor;
      }, 0),
    );

    const byMonth = new Map<string, number>();
    for (const l of schedule) {
      const key = l.dueDate.slice(0, 7);
      byMonth.set(key, round2((byMonth.get(key) ?? 0) + l.amount));
    }
    const cashFlowByMonth = Array.from(byMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, amount]) => ({ month, amount }));

    return {
      totalPrice: input.totalPrice,
      discountPercent,
      discountAmount,
      netContractValue,
      totalCollectible,
      annualDiscountRatePercentForNpv,
      npv,
      schedule,
      cashFlowByMonth,
    };
  }

  async compareScenarios(companyId: string, scenario: ScenarioInput, baseline: ScenarioInput): Promise<ScenarioComparison> {
    const scenarioResult = await this.runScenario(companyId, scenario);
    const baselineResult = await this.runScenario(companyId, baseline);
    return {
      scenario: scenarioResult,
      baseline: baselineResult,
      delta: {
        netContractValueDelta: round2(scenarioResult.netContractValue - baselineResult.netContractValue),
        totalCollectibleDelta: round2(scenarioResult.totalCollectible - baselineResult.totalCollectible),
        npvDelta: round2(scenarioResult.npv - baselineResult.npv),
      },
    };
  }
}
