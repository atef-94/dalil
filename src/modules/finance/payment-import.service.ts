import type { Lead, Payment, PaymentMethod, Receipt, PaymentScheduleLine } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import type { ImportFieldDef } from '../../infra/field-mapping.js';
import type { InventoryService } from '../inventory/inventory.service.js';
import type { SalesService } from '../sales/sales.service.js';
import type { PaymentPlansService } from '../payment-plans/payment-plans.service.js';
import { FinanceService } from './finance.service.js';

/**
 * The explicit Payment Import field dictionary. A finance export's own
 * "Contract ID"/"Receipt ID" values never match this system's generated
 * IDs unless they came from ACTIVE itself, so rows are resolved by
 * human-friendly keys instead — Phone (-> the client's signed contract) or
 * Project+Unit (-> the same), plus Installment Number (-> that schedule
 * line by its real sequence number) — exactly the same resolution the
 * pre-existing bulk-CSV `/api/finance/payments/import` route already uses
 * (see app.ts), just reachable through the staged upload/preview/confirm
 * pipeline for real Excel/PDF exports with unpredictable headers.
 */
export const PAYMENT_IMPORT_FIELDS: ImportFieldDef[] = [
  { key: 'phone', label: 'Phone', aliases: ['mobile', 'client phone', 'contact number'] },
  { key: 'projectName', label: 'Project', aliases: ['project name'] },
  { key: 'unitCode', label: 'Unit', aliases: ['unit code', 'unit number'] },
  { key: 'installmentNumber', label: 'Installment Number', aliases: ['installment', 'installment no', 'sequence'], required: true },
  { key: 'amount', label: 'Amount Paid', aliases: ['amount', 'paid amount', 'amount paid (egp)'], required: true },
  { key: 'method', label: 'Payment Method', aliases: ['method', 'payment type'], required: true },
];

const METHOD_MAP: Record<string, PaymentMethod> = {
  'bank transfer': 'transfer',
  transfer: 'transfer',
  cheque: 'cheque',
  check: 'cheque',
  'visa pos': 'card',
  card: 'card',
  cash: 'cash',
};

export type PaymentImportRowStatus = 'valid' | 'conflict' | 'invalid';

export interface PaymentImportRowPreview {
  row: number;
  status: PaymentImportRowStatus;
  issues: string[];
  raw: Record<string, string>;
  resolved?: {
    contractId: string;
    paymentScheduleLineId: string;
    installmentSequence: number;
    amount: number;
    method: PaymentMethod;
  };
}

export interface PaymentImportPreview {
  rows: PaymentImportRowPreview[];
  totalRows: number;
  validCount: number;
  conflictCount: number;
  invalidCount: number;
}

export interface PaymentImportRowResult {
  row: number;
  status: 'recorded' | 'skipped' | 'error';
  paymentId?: string;
  reason?: string;
}

export interface PaymentImportResult {
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
  results: PaymentImportRowResult[];
}

/**
 * Validates and resolves Payment Import rows and drives the actual write —
 * one row, one FinanceService.recordPayment() call, exactly like the
 * pre-existing bulk-CSV Finance/Collections route, so payments still only
 * ever get recorded through that one code path (with its own
 * already-fully-paid / overpay rejections acting as the final backstop
 * against double-recording, the same role CrmService.createLead plays for
 * Lead Import's duplicate protection).
 */
export class PaymentImportService {
  constructor(
    private readonly leads: Repository<Lead>,
    private readonly inventory: InventoryService,
    private readonly sales: SalesService,
    private readonly paymentPlans: PaymentPlansService,
    private readonly finance: FinanceService,
  ) {}

  private async resolveContractId(companyId: string, raw: Record<string, string>): Promise<{ contractId?: string; issue?: string }> {
    const projectName = raw.projectName?.trim();
    const unitCode = raw.unitCode?.trim();
    if (projectName && unitCode) {
      const projects = await this.inventory.listProjects(companyId);
      const project = projects.find((p) => p.name === projectName);
      if (!project) return { issue: `project "${projectName}" not found` };
      const units = await this.inventory.listUnits(companyId, project.id);
      const unit = units.find((u) => u.code === unitCode);
      if (!unit) return { issue: `unit "${unitCode}" not found in project "${projectName}"` };
      const contracts = await this.sales.listContracts(companyId);
      const contract = contracts.find((c) => c.unitId === unit.id && c.status === 'signed');
      if (!contract) return { issue: `no signed contract found for unit "${unitCode}"` };
      return { contractId: contract.id };
    }

    const phone = raw.phone?.trim();
    if (phone) {
      const lead = (await this.leads.findAll((l) => l.companyId === companyId && l.phone === phone))[0];
      if (!lead) return { issue: `no lead found with phone "${phone}"` };
      const contracts = await this.sales.listContracts(companyId);
      const contract = contracts.find((c) => c.clientId === lead.id && c.status === 'signed');
      if (!contract) return { issue: `no signed contract found for phone "${phone}"` };
      return { contractId: contract.id };
    }

    return { issue: 'row has neither Phone nor Project+Unit to identify the contract' };
  }

  private async evaluateRows(companyId: string, mappedRows: Record<string, string>[]): Promise<PaymentImportRowPreview[]> {
    const results: PaymentImportRowPreview[] = [];
    const seenLineIds = new Set<string>(); // catches two rows in the same file targeting the same installment

    for (let idx = 0; idx < mappedRows.length; idx++) {
      const row = idx + 1;
      const raw = mappedRows[idx]!;
      const issues: string[] = [];

      const amount = Number((raw.amount ?? '').replace(/,/g, ''));
      if (!Number.isFinite(amount) || amount <= 0) issues.push('"Amount Paid" must be a positive number');

      const methodKey = (raw.method ?? '').trim().toLowerCase();
      const method = METHOD_MAP[methodKey];
      if (!method) issues.push(`unrecognized "Payment Method": "${raw.method ?? ''}"`);

      // Sequence numbers are 0-based (the down payment is installment 0,
      // the first regular installment is 1, ...) — the same convention
      // the pre-existing bulk-CSV Finance/Collections route already uses,
      // so an empty string (which Number('') would otherwise read as a
      // valid 0) is checked for explicitly rather than silently treated
      // as "down payment".
      const installmentRaw = raw.installmentNumber?.trim() ?? '';
      const sequence = Number(installmentRaw);
      if (installmentRaw === '' || !Number.isInteger(sequence) || sequence < 0) {
        issues.push('"Installment Number" is required and must be a whole number (0 = down payment, 1 = first installment, ...)');
      }

      if (issues.length > 0) {
        results.push({ row, status: 'invalid', issues, raw });
        continue;
      }

      const { contractId, issue } = await this.resolveContractId(companyId, raw);
      if (!contractId) {
        results.push({ row, status: 'invalid', issues: [issue!], raw });
        continue;
      }

      const schedule = await this.paymentPlans.getScheduleForContract(contractId, companyId);
      const line = schedule.find((l) => l.sequence === sequence);
      if (!line) {
        results.push({ row, status: 'invalid', issues: [`no schedule line found with installment number ${sequence} for this contract`], raw });
        continue;
      }

      const conflictReason = this.detectConflict(line, amount, seenLineIds);
      if (conflictReason) {
        results.push({ row, status: 'conflict', issues: [conflictReason], raw });
        continue;
      }
      seenLineIds.add(line.id);

      results.push({
        row,
        status: 'valid',
        issues: [],
        raw,
        resolved: { contractId, paymentScheduleLineId: line.id, installmentSequence: sequence, amount, method: method! },
      });
    }

    return results;
  }

  /** Protects settled installments and prevents two rows in one file from
   * both paying the same line — FinanceService.recordPayment enforces the
   * same rules server-side too, but flagging it here lets the preview
   * show the user why a row won't import instead of only finding out
   * after confirming. */
  private detectConflict(line: PaymentScheduleLine, amount: number, seenLineIdsInBatch: Set<string>): string | undefined {
    if (line.status === 'paid') return 'this installment is already fully paid';
    if (seenLineIdsInBatch.has(line.id)) return 'another row in this same file already targets this installment';
    const newAmountPaid = Math.round((line.amountPaid + amount) * 100) / 100;
    if (newAmountPaid > line.amount + 0.005) return `amount would overpay this installment (remaining: ${(line.amount - line.amountPaid).toFixed(2)})`;
    return undefined;
  }

  async buildPreview(companyId: string, mappedRows: Record<string, string>[]): Promise<PaymentImportPreview> {
    const rows = await this.evaluateRows(companyId, mappedRows);
    return {
      rows,
      totalRows: rows.length,
      validCount: rows.filter((r) => r.status === 'valid').length,
      conflictCount: rows.filter((r) => r.status === 'conflict').length,
      invalidCount: rows.filter((r) => r.status === 'invalid').length,
    };
  }

  async importRows(
    companyId: string,
    actorUserId: string,
    mappedRows: Record<string, string>[],
    onRecorded: (recorded: { payment: Payment; receipt: Receipt; line: PaymentScheduleLine }) => Promise<void>,
  ): Promise<PaymentImportResult> {
    const evaluated = await this.evaluateRows(companyId, mappedRows);
    const results: PaymentImportRowResult[] = [];
    for (const row of evaluated) {
      if (row.status !== 'valid') {
        results.push({ row: row.row, status: 'skipped', reason: row.issues.join('; ') });
        continue;
      }
      const resolved = row.resolved!;
      try {
        const recorded = await this.finance.recordPayment({
          companyId,
          contractId: resolved.contractId,
          paymentScheduleLineId: resolved.paymentScheduleLineId,
          amount: resolved.amount,
          method: resolved.method,
          recordedByUserId: actorUserId,
        });
        await onRecorded(recorded);
        results.push({ row: row.row, status: 'recorded', paymentId: recorded.payment.id });
      } catch (err) {
        results.push({ row: row.row, status: 'error', reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return {
      total: results.length,
      succeeded: results.filter((r) => r.status === 'recorded').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      failed: results.filter((r) => r.status === 'error').length,
      results,
    };
  }
}
