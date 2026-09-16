import type { PaymentFrequency, PaymentPlanTemplate, PaymentScheduleLineStatus } from '../../domain/types.js';
import { ValidationError } from '../../infra/errors.js';

export interface GeneratedLine {
  sequence: number;
  label: string;
  dueDate: string; // ISO date
  amount: number;
  status: PaymentScheduleLineStatus;
}

export interface GenerateScheduleInput {
  template: PaymentPlanTemplate;
  totalPrice: number;
  discountPercent?: number; // deal-specific discount off totalPrice, 0-100
  escalationPercentPerYear?: number; // installments grow by this % each elapsed year
  startDate?: Date; // defaults to now; contract signing date in practice
}

const FREQUENCY_MONTHS: Record<Exclude<PaymentFrequency, 'custom'>, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

function intervalMonths(template: PaymentPlanTemplate): number {
  if (template.frequency === 'custom') {
    if (!template.customMonthInterval || template.customMonthInterval <= 0) {
      throw new ValidationError('customMonthInterval must be a positive number for a custom frequency');
    }
    return template.customMonthInterval;
  }
  return FREQUENCY_MONTHS[template.frequency];
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  result.setMonth(result.getMonth() + months);
  return result;
}

// Rounds to cents, then feeds the residual (positive or negative) into the
// final line so the whole set sums to the exact target — no drift from
// repeated floating-point division.
function roundExactSum(rawAmounts: number[], target: number): number[] {
  const rounded = rawAmounts.map((a) => Math.round(a * 100) / 100);
  const sum = rounded.reduce((acc, a) => acc + a, 0);
  const residual = Math.round((target - sum) * 100) / 100;
  if (rounded.length === 0) return rounded;
  rounded[rounded.length - 1] = Math.round((rounded[rounded.length - 1]! + residual) * 100) / 100;
  return rounded;
}

export function validateTemplate(template: PaymentPlanTemplate): void {
  if (!template.name?.trim()) throw new ValidationError('template name is required');
  if (template.downPaymentType === 'percentage') {
    if (template.downPaymentValue < 0 || template.downPaymentValue > 100) {
      throw new ValidationError('percentage down payment must be between 0 and 100');
    }
  } else if (template.downPaymentType === 'fixed') {
    if (template.downPaymentValue < 0) {
      throw new ValidationError('fixed down payment must be non-negative');
    }
  } else {
    throw new ValidationError('downPaymentType must be "percentage" or "fixed"');
  }
  if (template.termMonths <= 0 || template.termMonths > 240) {
    throw new ValidationError('termMonths must be between 1 and 240 (20 years)');
  }
  if (template.frequency === 'custom' && (!template.customMonthInterval || template.customMonthInterval <= 0)) {
    throw new ValidationError('customMonthInterval is required and must be positive for a custom frequency');
  }
  for (const fee of template.fees) {
    if (!fee.label?.trim()) throw new ValidationError('each fee requires a label');
    if (fee.amount < 0) throw new ValidationError('fee amounts must be non-negative');
    if (fee.dueMonthOffset < 0) throw new ValidationError('fee dueMonthOffset must be non-negative');
  }
}

export function generateSchedule(input: GenerateScheduleInput): GeneratedLine[] {
  const { template } = input;
  validateTemplate(template);

  if (!(input.totalPrice > 0)) {
    throw new ValidationError('totalPrice must be positive');
  }
  const discountPercent = input.discountPercent ?? 0;
  if (discountPercent < 0 || discountPercent >= 100) {
    throw new ValidationError('discountPercent must be between 0 and 100 (exclusive)');
  }
  const escalationPercentPerYear = input.escalationPercentPerYear ?? 0;
  const startDate = input.startDate ?? new Date();

  const effectivePrice = Math.round(input.totalPrice * (1 - discountPercent / 100) * 100) / 100;
  const downPaymentAmount =
    template.downPaymentType === 'percentage'
      ? Math.round(((effectivePrice * template.downPaymentValue) / 100) * 100) / 100
      : Math.min(template.downPaymentValue, effectivePrice);
  const remaining = Math.round((effectivePrice - downPaymentAmount) * 100) / 100;
  if (remaining < 0) {
    throw new ValidationError('down payment cannot exceed the total price');
  }

  const months = intervalMonths(template);
  const numberOfInstallments = Math.max(1, Math.floor(template.termMonths / months));

  const lines: GeneratedLine[] = [];
  let sequence = 0;

  lines.push({
    sequence: sequence++,
    label: 'Down Payment',
    dueDate: startDate.toISOString(),
    amount: downPaymentAmount,
    status: 'upcoming',
  });

  if (remaining > 0) {
    // Weight each installment by (1 + escalation)^(elapsed years), then
    // normalize so the raw weighted amounts still sum to `remaining` exactly
    // before cent-rounding takes over.
    const weights = Array.from({ length: numberOfInstallments }, (_, i) => {
      const elapsedYears = Math.floor((i * months) / 12);
      return Math.pow(1 + escalationPercentPerYear / 100, elapsedYears);
    });
    const weightSum = weights.reduce((a, b) => a + b, 0);
    const rawAmounts = weights.map((w) => (remaining * w) / weightSum);
    const amounts = roundExactSum(rawAmounts, remaining);

    for (let i = 0; i < numberOfInstallments; i++) {
      const dueDate = addMonths(startDate, (i + 1) * months);
      lines.push({
        sequence: sequence++,
        label: `Installment ${i + 1}`,
        dueDate: dueDate.toISOString(),
        amount: amounts[i]!,
        status: 'upcoming',
      });
    }
  }

  for (const fee of template.fees) {
    lines.push({
      sequence: sequence++,
      label: fee.label,
      dueDate: addMonths(startDate, fee.dueMonthOffset).toISOString(),
      amount: fee.amount,
      status: 'upcoming',
    });
  }

  return lines;
}
