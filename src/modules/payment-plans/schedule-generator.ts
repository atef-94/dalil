import type {
  PaymentFrequency, PaymentPlanTemplate, PaymentPlanScheduledPayment,
  PaymentScheduleLineStatus, PaymentScheduleLineKind,
} from '../../domain/types.js';
import { ValidationError } from '../../infra/errors.js';

export interface GeneratedLine {
  sequence: number;
  label: string;
  kind: PaymentScheduleLineKind;
  dueDate: string; // ISO date
  amount: number;
  status: PaymentScheduleLineStatus;
}

export interface ScheduleValidation {
  totalPayable: number;
  remainingBalance: number;
  isValid: boolean;
  overpayment: number;
}

export interface GenerateScheduleResult {
  lines: GeneratedLine[];
  validation: ScheduleValidation;
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

// undefined always means 'equal_installments' — see PaymentPlanTemplate.paymentMethod's
// own comment: every template constructed before this field existed (and every
// existing call-site across the codebase that builds one without it) keeps behaving
// exactly as before, with zero migration required.
function effectivePaymentMethod(template: PaymentPlanTemplate): 'equal_installments' | 'installments_plus_scheduled' {
  return template.paymentMethod ?? 'equal_installments';
}

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
  if (effectivePaymentMethod(template) === 'installments_plus_scheduled') {
    if (template.recurringInstallmentAmount !== undefined && template.recurringInstallmentAmount < 0) {
      throw new ValidationError('recurringInstallmentAmount must be non-negative');
    }
    for (const sp of template.scheduledPayments ?? []) {
      validateScheduledPayment(sp);
    }
  }
}

function validateScheduledPayment(sp: PaymentPlanScheduledPayment): void {
  if (sp.amount < 0) throw new ValidationError('scheduled payment amount must be non-negative');
  if (!sp.dueDate || Number.isNaN(new Date(sp.dueDate).getTime())) {
    throw new ValidationError('scheduled payment dueDate must be a valid date');
  }
}

const CENT_TOLERANCE = 0.01;

function reconcile(effectivePrice: number, totalPayable: number): ScheduleValidation {
  const diff = Math.round((effectivePrice - totalPayable) * 100) / 100;
  if (diff > CENT_TOLERANCE) {
    return { totalPayable, remainingBalance: diff, isValid: false, overpayment: 0 };
  }
  if (diff < -CENT_TOLERANCE) {
    return { totalPayable, remainingBalance: 0, isValid: false, overpayment: Math.round(-diff * 100) / 100 };
  }
  return { totalPayable, remainingBalance: 0, isValid: true, overpayment: 0 };
}

export function generateSchedule(input: GenerateScheduleInput): GenerateScheduleResult {
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
  // Each elapsed year's weight is (1 + escalationPercentPerYear/100)^years —
  // at exactly -100 that base is 0 (every installment past year 1 becomes
  // 0), and below -100 it goes negative, which an odd elapsed-years count
  // then keeps negative: a real, reproducible bug where a long-enough plan
  // (>=13 months) silently produced negative installment amounts that still
  // summed to the right total and passed validation as "isValid: true".
  // A shrinking-installments plan is legitimate business-wise (escalation
  // between -100 and 0), so only the mathematically-broken range is rejected.
  if (escalationPercentPerYear <= -100) {
    throw new ValidationError('escalationPercentPerYear must be greater than -100');
  }
  const startDate = input.startDate ?? new Date();
  const method = effectivePaymentMethod(template);

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

  lines.push({
    sequence: 0,
    label: 'Down Payment',
    kind: 'down_payment',
    dueDate: startDate.toISOString(),
    amount: downPaymentAmount,
    status: 'upcoming',
  });

  let installmentsTotal = 0;
  if (method === 'installments_plus_scheduled' && template.recurringInstallmentAmount !== undefined) {
    // A manually fixed recurring amount (e.g. "50,000/quarter") — no
    // escalation, no forced sum-to-`remaining`: the gap (if any) is exactly
    // what scheduledPayments below is meant to cover, and validation
    // surfaces it rather than silently absorbing it into the last line the
    // way the auto-calculated path does.
    const fixedAmount = Math.round(template.recurringInstallmentAmount * 100) / 100;
    for (let i = 0; i < numberOfInstallments; i++) {
      const dueDate = addMonths(startDate, (i + 1) * months);
      lines.push({
        sequence: 0,
        label: `Installment ${i + 1}`,
        kind: 'installment',
        dueDate: dueDate.toISOString(),
        amount: fixedAmount,
        status: 'upcoming',
      });
      installmentsTotal += fixedAmount;
    }
  } else if (remaining > 0) {
    // Weight each installment by (1 + escalation)^(elapsed years), then
    // normalize so the raw weighted amounts still sum to `remaining` exactly
    // before cent-rounding takes over. Used both for 'equal_installments'
    // and for 'installments_plus_scheduled' when no manual override amount
    // was given (the recurring installment then falls back to this same
    // auto-calculated equal share).
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
        sequence: 0,
        label: `Installment ${i + 1}`,
        kind: 'installment',
        dueDate: dueDate.toISOString(),
        amount: amounts[i]!,
        status: 'upcoming',
      });
      installmentsTotal += amounts[i]!;
    }
  }

  let scheduledPaymentsTotal = 0;
  if (method === 'installments_plus_scheduled') {
    for (const sp of template.scheduledPayments ?? []) {
      const amount = Math.round(sp.amount * 100) / 100;
      lines.push({
        sequence: 0,
        label: sp.label?.trim() || 'Scheduled Payment',
        kind: 'scheduled_payment',
        dueDate: new Date(sp.dueDate).toISOString(),
        amount,
        status: 'upcoming',
      });
      scheduledPaymentsTotal += amount;
    }
  }

  for (const fee of template.fees) {
    lines.push({
      sequence: 0,
      label: fee.label,
      kind: 'fee',
      dueDate: addMonths(startDate, fee.dueMonthOffset).toISOString(),
      amount: fee.amount,
      status: 'upcoming',
    });
  }

  // Scheduled payments carry independent, user-picked exact dates (section
  // 11 of the spec this was built for: never tied to the installment
  // cadence), so the only way to produce one coherent, chronologically
  // ordered schedule (section 12) across down payment / installments /
  // scheduled payments / fees is to sort by date after building every line,
  // then reassign sequence numbers — insertion order alone isn't reliable
  // once scheduled payments can fall before, between, or after installments.
  lines.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  lines.forEach((line, i) => { line.sequence = i; });

  const totalPayable = Math.round((downPaymentAmount + installmentsTotal + scheduledPaymentsTotal) * 100) / 100;
  const validation = reconcile(effectivePrice, totalPayable);

  return { lines, validation };
}
