import type { Lead, User } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import type { ImportFieldDef } from '../../infra/field-mapping.js';
import { CrmService, type CreateLeadInput } from './crm.service.js';

/**
 * The explicit Lead Import field dictionary — every column a user's
 * Excel/CSV/PDF export can map onto. Kept in one place so the upload
 * preview screen, the mapping-suggestion step, and the actual import all
 * agree on exactly the same set of target fields.
 */
export const LEAD_IMPORT_FIELDS: ImportFieldDef[] = [
  { key: 'fullName', label: 'Full Name', aliases: ['name', 'client name', 'customer name', 'lead name'], required: true },
  { key: 'phone', label: 'Phone', aliases: ['mobile', 'phone number', 'tel', 'contact number', 'whatsapp'], required: true },
  { key: 'email', label: 'Email', aliases: ['email address', 'e-mail'] },
  { key: 'nationalId', label: 'National ID', aliases: ['civil id', 'id number', 'national id number'] },
  { key: 'sourceId', label: 'Source', aliases: ['lead source', 'campaign'] },
  { key: 'ownerEmail', label: 'Assigned Agent Email', aliases: ['sales agent', 'assigned agent', 'owner email', 'agent email'] },
  { key: 'tags', label: 'Tags', aliases: ['labels', 'tag'] },
  { key: 'priority', label: 'Priority', aliases: ['lead priority'] },
];

export type LeadImportRowStatus = 'valid' | 'duplicate' | 'invalid';

export interface LeadImportRowPreview {
  row: number; // 1-based
  status: LeadImportRowStatus;
  issues: string[];
  raw: Record<string, string>;
  /** Only set for status 'valid' — exactly what would be sent to
   * CrmService.createLead if this row is imported. */
  resolved?: {
    fullName: string;
    phone: string;
    email?: string;
    nationalId?: string;
    sourceId?: string;
    ownerEmail?: string;
    ownerResolved: boolean;
    tags?: string[];
    priority?: Lead['priority'];
  };
}

export interface LeadImportPreview {
  rows: LeadImportRowPreview[];
  totalRows: number;
  validCount: number;
  duplicateCount: number;
  invalidCount: number;
}

const VALID_PRIORITIES: Lead['priority'][] = ['low', 'medium', 'high', 'urgent'];

function normalizePriority(value: string | undefined): Lead['priority'] | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return (VALID_PRIORITIES as string[]).includes(normalized) ? (normalized as Lead['priority']) : undefined;
}

function parseTags(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  const tags = value
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

export interface LeadImportRowResult {
  row: number;
  status: 'created' | 'skipped' | 'error';
  leadId?: string;
  reason?: string;
}

export interface LeadImportResult {
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
  results: LeadImportRowResult[];
}

/**
 * Validates and duplicate-checks Lead Import rows and drives the actual
 * write — one row, one CrmService.createLead() call, exactly like the
 * pre-existing bulk-CSV `/api/crm/leads/import` route (see app.ts), so
 * there's still only one Lead-creation code path. This layer adds the
 * mapping/preview/duplicate-detection/conflict steps that route never had.
 */
export class LeadImportService {
  constructor(
    private readonly leads: Repository<Lead>,
    private readonly users: Repository<User>,
    private readonly crm: CrmService,
  ) {}

  /**
   * Builds a row-by-row preview without writing anything: validates
   * required fields, and flags duplicates both against existing DB leads
   * (phone/email/nationalId — the same identity signals CrmService itself
   * enforces) and against earlier rows in the same file, so two rows for
   * the same person in one spreadsheet don't both sail through as
   * "valid". This is deliberately the same logic buildPreview and
   * importRows below both call, so confirming an import can never behave
   * differently from what the user was shown.
   */
  async buildPreview(companyId: string, mappedRows: Record<string, string>[]): Promise<LeadImportPreview> {
    const existingLeads = await this.leads.findAll((l) => l.companyId === companyId);
    const companyUsers = await this.users.findAll((u) => u.companyId === companyId);
    const rows = await this.evaluateRows(companyId, mappedRows, existingLeads, companyUsers);
    return {
      rows,
      totalRows: rows.length,
      validCount: rows.filter((r) => r.status === 'valid').length,
      duplicateCount: rows.filter((r) => r.status === 'duplicate').length,
      invalidCount: rows.filter((r) => r.status === 'invalid').length,
    };
  }

  private async evaluateRows(
    companyId: string,
    mappedRows: Record<string, string>[],
    existingLeads: Lead[],
    companyUsers: User[],
  ): Promise<LeadImportRowPreview[]> {
    const seenPhones = new Set<string>();
    const seenEmails = new Set<string>();
    const seenNationalIds = new Set<string>();

    return mappedRows.map((raw, idx) => {
      const row = idx + 1;
      const fullName = raw.fullName?.trim();
      const phone = raw.phone?.trim();
      const issues: string[] = [];
      if (!fullName) issues.push('"Full Name" is required');
      if (!phone) issues.push('"Phone" is required');
      if (issues.length > 0) return { row, status: 'invalid' as const, issues, raw };

      const email = raw.email?.trim() || undefined;
      const nationalId = raw.nationalId?.trim() || undefined;

      const dupInDb = existingLeads.some(
        (l) => l.phone === phone || (!!email && !!l.email && l.email === email) || (!!nationalId && !!l.nationalId && l.nationalId === nationalId),
      );
      const dupInBatch = seenPhones.has(phone!) || (!!email && seenEmails.has(email)) || (!!nationalId && seenNationalIds.has(nationalId));
      if (dupInDb || dupInBatch) {
        return {
          row,
          status: 'duplicate' as const,
          issues: [dupInDb ? 'A lead with this phone, email, or national ID already exists' : 'Duplicate of an earlier row in this same file'],
          raw,
        };
      }
      seenPhones.add(phone!);
      if (email) seenEmails.add(email);
      if (nationalId) seenNationalIds.add(nationalId);

      const ownerEmail = raw.ownerEmail?.trim() || undefined;
      const owner = ownerEmail ? companyUsers.find((u) => u.email.toLowerCase() === ownerEmail.toLowerCase()) : undefined;
      const rowIssues: string[] = [];
      if (ownerEmail && !owner) rowIssues.push(`No user found with email "${ownerEmail}" — will import unassigned instead of failing the row`);

      return {
        row,
        status: 'valid' as const,
        issues: rowIssues,
        raw,
        resolved: {
          fullName: fullName!,
          phone: phone!,
          email,
          nationalId,
          sourceId: raw.sourceId?.trim() || undefined,
          ownerEmail,
          ownerResolved: !!owner,
          tags: parseTags(raw.tags),
          priority: normalizePriority(raw.priority),
        },
      };
    });
  }

  /**
   * Actually imports the rows a preview marked 'valid' (duplicate/invalid
   * rows are always skipped, never force-imported — this method
   * re-validates from scratch rather than trusting a possibly-stale
   * preview snapshot, so a lead created by someone else between preview
   * and confirm is still caught). Returns a per-row result exactly like
   * runImport()'s shape, for a consistent import-summary UI.
   */
  async importRows(
    companyId: string,
    actorUserId: string,
    mappedRows: Record<string, string>[],
    onCreated: (lead: Lead, resolved: NonNullable<LeadImportRowPreview['resolved']>) => Promise<void>,
  ): Promise<LeadImportResult> {
    const existingLeads = await this.leads.findAll((l) => l.companyId === companyId);
    const companyUsers = await this.users.findAll((u) => u.companyId === companyId);
    const evaluated = await this.evaluateRows(companyId, mappedRows, existingLeads, companyUsers);

    const results: LeadImportRowResult[] = [];
    for (const row of evaluated) {
      if (row.status === 'invalid') {
        results.push({ row: row.row, status: 'skipped', reason: row.issues.join('; ') });
        continue;
      }
      if (row.status === 'duplicate') {
        results.push({ row: row.row, status: 'skipped', reason: row.issues.join('; ') });
        continue;
      }
      const resolved = row.resolved!;
      const owner = resolved.ownerEmail ? companyUsers.find((u) => u.email.toLowerCase() === resolved.ownerEmail!.toLowerCase()) : undefined;
      const input: CreateLeadInput = {
        companyId,
        fullName: resolved.fullName,
        phone: resolved.phone,
        email: resolved.email,
        nationalId: resolved.nationalId,
        sourceId: resolved.sourceId,
        tags: resolved.tags,
        priority: resolved.priority,
        ownerEmployeeUserId: owner?.id ?? actorUserId,
      };
      try {
        const lead = await this.crm.createLead(input);
        await onCreated(lead, resolved);
        results.push({ row: row.row, status: 'created', leadId: lead.id });
      } catch (err) {
        results.push({ row: row.row, status: 'error', reason: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      total: results.length,
      succeeded: results.filter((r) => r.status === 'created').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      failed: results.filter((r) => r.status === 'error').length,
      results,
    };
  }
}
