import { randomUUID } from 'node:crypto';
import type { Payment, PaymentMethod, PaymentScheduleLine, Receipt, Refund } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { FinanceError, NotFoundError, ValidationError } from '../../infra/errors.js';
import { KeyedMutex } from '../../infra/keyed-mutex.js';

export interface RecordPaymentInput {
  companyId: string;
  contractId: string;
  paymentScheduleLineId: string;
  amount: number;
  method: PaymentMethod;
  recordedByUserId: string;
}

export interface RecordRefundInput {
  companyId: string;
  contractId: string;
  paymentScheduleLineId: string;
  amount: number;
  reason: string;
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
  // Keyed by paymentScheduleLineId — without this, two concurrent
  // recordPayment/recordRefund calls (or a sweep) on the same line each read
  // a stale amountPaid, and the second save() silently overwrites the
  // first's update (SqliteRepository.save() is a full-row replace) even
  // though both Payment/Receipt rows are still created — the ledger and the
  // line's own balance permanently disagree. See recordPayment/recordRefund.
  private readonly lineMutex = new KeyedMutex();

  constructor(
    private readonly payments: Repository<Payment>,
    private readonly receipts: Repository<Receipt>,
    private readonly scheduleLines: Repository<PaymentScheduleLine>,
    private readonly refunds: Repository<Refund>,
  ) {}

  async recordPayment(input: RecordPaymentInput): Promise<{ payment: Payment; receipt: Receipt; line: PaymentScheduleLine }> {
    if (!(input.amount > 0)) throw new ValidationError('amount must be positive');

    return this.lineMutex.runExclusive(input.paymentScheduleLineId, async () => {
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
    });
  }

  /** Reverses money already collected on a schedule line. Always a
   * distinct, auditable Refund row rather than silently editing the
   * original Payment — the Universal Approval Engine gates every call
   * to this behind approval (see app.ts's 'refund' actionType), since
   * undoing a recorded receipt is inherently sensitive. */
  async recordRefund(input: RecordRefundInput): Promise<{ refund: Refund; line: PaymentScheduleLine }> {
    if (!(input.amount > 0)) throw new ValidationError('amount must be positive');
    if (!input.reason?.trim()) throw new ValidationError('reason is required');

    return this.lineMutex.runExclusive(input.paymentScheduleLineId, async () => {
      const line = await this.scheduleLines.findById(input.paymentScheduleLineId);
      if (!line || line.contractId !== input.contractId || line.companyId !== input.companyId) {
        throw new NotFoundError('payment schedule line not found for this contract');
      }
      if (input.amount > line.amountPaid + 0.005) {
        throw new FinanceError('refund amount cannot exceed the amount already paid on this line');
      }

      const newAmountPaid = Math.round((line.amountPaid - input.amount) * 100) / 100;
      // Anything less than fully paid can no longer carry the 'paid' status —
      // whether it was fully or only partially refunded, it reverts to
      // 'overdue' or 'upcoming' based on its due date, same as a line that
      // was never paid at all.
      const status: PaymentScheduleLine['status'] =
        newAmountPaid >= line.amount - 0.005 ? 'paid' : Date.parse(line.dueDate) < Date.now() ? 'overdue' : 'upcoming';
      const updatedLine: PaymentScheduleLine = { ...line, amountPaid: Math.max(0, newAmountPaid), status };
      await this.scheduleLines.save(updatedLine);

      const refund: Refund = {
        id: randomUUID(),
        companyId: input.companyId,
        contractId: input.contractId,
        paymentScheduleLineId: input.paymentScheduleLineId,
        amount: input.amount,
        reason: input.reason.trim(),
        recordedByUserId: input.recordedByUserId,
        createdAt: new Date().toISOString(),
      };
      await this.refunds.save(refund);

      return { refund, line: updatedLine };
    });
  }

  async listRefunds(companyId: string): Promise<Refund[]> {
    return this.refunds.findAll((r) => r.companyId === companyId);
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
  async sweepOverdue(now = new Date(), companyId?: string): Promise<number> {
    const swept = await this.sweepOverdueDetailed(now, companyId);
    return swept.length;
  }

  /** Same sweep as sweepOverdue(), but returns the lines it actually
   * flipped to 'overdue' — used by app.ts/main.ts to emit one
   * `payment.overdue_swept` domain event per line so the Automation Engine
   * can react (e.g. notify finance). A line that's already overdue is
   * never a candidate again, so each line only ever fires this once. Each
   * line's read-check-write runs inside the same per-line mutex
   * recordPayment/recordRefund use, so a payment landing concurrently on a
   * line this sweep is about to flag can never have its amountPaid/'paid'
   * update silently reverted by a sweep that read a stale pre-payment
   * snapshot.
   *
   * `companyId` is optional and, when omitted, sweeps every tenant — that's
   * correct for main.ts's periodic background tick, which is the only
   * caller meant to act across the whole deployment. Any HTTP-reachable
   * caller (the manual /api/finance/sweep-overdue route) MUST pass the
   * requesting user's own companyId, or it would let one tenant trigger a
   * mutation that touches every other tenant's payment schedule lines. */
  async sweepOverdueDetailed(now = new Date(), companyId?: string): Promise<PaymentScheduleLine[]> {
    const candidateIds = (
      await this.scheduleLines.findAll(
        (l) => (!companyId || l.companyId === companyId) && l.status !== 'paid' && l.status !== 'overdue' && Date.parse(l.dueDate) < now.getTime(),
      )
    ).map((l) => l.id);
    const swept: PaymentScheduleLine[] = [];
    for (const lineId of candidateIds) {
      const result = await this.lineMutex.runExclusive(lineId, async () => {
        const line = await this.scheduleLines.findById(lineId);
        if (!line || line.status === 'paid' || line.status === 'overdue' || Date.parse(line.dueDate) >= now.getTime()) {
          return undefined;
        }
        return this.scheduleLines.save({ ...line, status: 'overdue' });
      });
      if (result) swept.push(result);
    }
    return swept;
  }
}
