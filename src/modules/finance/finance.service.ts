import { randomUUID } from 'node:crypto';
import type { Payment, PaymentMethod, PaymentScheduleLine, Receipt } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { FinanceError, NotFoundError, ValidationError } from '../../infra/errors.js';

export interface RecordPaymentInput {
  companyId: string;
  contractId: string;
  paymentScheduleLineId: string;
  amount: number;
  method: PaymentMethod;
  recordedByUserId: string;
}

export interface Balance {
  contractId: string;
  totalDue: number;
  totalPaid: number;
  outstanding: number;
}

let receiptCounter = 0;

export class FinanceService {
  constructor(
    private readonly payments: Repository<Payment>,
    private readonly receipts: Repository<Receipt>,
    private readonly scheduleLines: Repository<PaymentScheduleLine>,
  ) {}

  async recordPayment(input: RecordPaymentInput): Promise<{ payment: Payment; receipt: Receipt; line: PaymentScheduleLine }> {
    if (!(input.amount > 0)) throw new ValidationError('amount must be positive');

    const line = await this.scheduleLines.findById(input.paymentScheduleLineId);
    if (!line || line.contractId !== input.contractId || line.companyId !== input.companyId) {
      throw new NotFoundError('payment schedule line not found for this contract');
    }
    if (line.status === 'paid') {
      throw new FinanceError('this payment schedule line is already fully paid');
    }

    const newAmountPaid = Math.round((line.amountPaid + input.amount) * 100) / 100;
    if (newAmountPaid > line.amount + 0.005) {
      throw new FinanceError('payment would overpay this schedule line');
    }

    const updatedLine: PaymentScheduleLine = {
      ...line,
      amountPaid: newAmountPaid,
      status: newAmountPaid >= line.amount - 0.005 ? 'paid' : line.status,
    };
    await this.scheduleLines.save(updatedLine);

    const payment: Payment = {
      id: randomUUID(),
      companyId: input.companyId,
      contractId: input.contractId,
      paymentScheduleLineId: input.paymentScheduleLineId,
      amount: input.amount,
      method: input.method,
      recordedByUserId: input.recordedByUserId,
      createdAt: new Date().toISOString(),
    };
    await this.payments.save(payment);

    receiptCounter += 1;
    const receipt: Receipt = {
      id: randomUUID(),
      companyId: input.companyId,
      paymentId: payment.id,
      receiptNumber: `RCPT-${new Date().getUTCFullYear()}-${String(receiptCounter).padStart(6, '0')}`,
      issuedAt: new Date().toISOString(),
    };
    await this.receipts.save(receipt);

    return { payment, receipt, line: updatedLine };
  }

  async getScheduleLine(id: string, companyId: string): Promise<PaymentScheduleLine | undefined> {
    const line = await this.scheduleLines.findById(id);
    return line && line.companyId === companyId ? line : undefined;
  }

  async getBalance(contractId: string, companyId: string): Promise<Balance> {
    const lines = await this.scheduleLines.findAll((l) => l.contractId === contractId && l.companyId === companyId);
    const totalDue = lines.reduce((sum, l) => sum + l.amount, 0);
    const totalPaid = lines.reduce((sum, l) => sum + l.amountPaid, 0);
    return {
      contractId,
      totalDue: Math.round(totalDue * 100) / 100,
      totalPaid: Math.round(totalPaid * 100) / 100,
      outstanding: Math.round((totalDue - totalPaid) * 100) / 100,
    };
  }

  /** Never touches lines already marked 'paid'. Safe to call repeatedly. */
  async sweepOverdue(now = new Date()): Promise<number> {
    const swept = await this.sweepOverdueDetailed(now);
    return swept.length;
  }

  /** Same sweep as sweepOverdue(), but returns the lines it actually
   * flipped to 'overdue' — used by app.ts/main.ts to emit one
   * `payment.overdue_swept` domain event per line so the Automation Engine
   * can react (e.g. notify finance). A line that's already overdue is
   * never a candidate again, so each line only ever fires this once. */
  async sweepOverdueDetailed(now = new Date()): Promise<PaymentScheduleLine[]> {
    const candidates = await this.scheduleLines.findAll(
      (l) => l.status !== 'paid' && l.status !== 'overdue' && Date.parse(l.dueDate) < now.getTime(),
    );
    const swept: PaymentScheduleLine[] = [];
    for (const line of candidates) {
      swept.push(await this.scheduleLines.save({ ...line, status: 'overdue' }));
    }
    return swept;
  }
}
