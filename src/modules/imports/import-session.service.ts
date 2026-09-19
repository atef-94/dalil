import { randomUUID } from 'node:crypto';
import type { ImportSession, ImportFileType, ImportTargetType } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError, ValidationError } from '../../infra/errors.js';
import { parseCsvRecords } from '../../infra/csv.js';
import { parseXlsx } from '../../infra/xlsx-parser.js';
import { parsePdfTable } from '../../infra/pdf-parser.js';
import { suggestMapping, type ImportFieldDef } from '../../infra/field-mapping.js';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h — long enough to map/preview/confirm without racing an expiry

export interface CreateImportSessionInput {
  companyId: string;
  createdByUserId: string;
  targetType: ImportTargetType;
  fileName: string;
  fileBuffer: Buffer;
  contentType: string;
  /** The target field dictionary for this import (Lead/Inventory/Payment
   * each own theirs) — used only to suggest a mapping; validation and
   * duplicate/conflict detection stay the caller's own responsibility. */
  fields: ImportFieldDef[];
  /** Real-world exports of merged-cell spreadsheets (e.g. a developer's
   * price list where "Project"/"Developer" is merged down a whole block of
   * unit-type rows) read back with every row but the first blank in that
   * column. Opt-in (never silent) — when true, a blank cell is replaced
   * with the last non-blank value seen above it in the same column, which
   * is exactly what a merged cell visually means. */
  fillDownBlankCells?: boolean;
}

/** A blank cell in a merged-cell export means "same as the value above" —
 * replaces it with the nearest non-blank value seen so far in that column.
 * A column that is genuinely blank throughout stays blank. */
function fillDownBlanks(headers: string[], rows: Record<string, string>[]): Record<string, string>[] {
  const lastSeen: Record<string, string> = {};
  return rows.map((row) => {
    const filled: Record<string, string> = { ...row };
    for (const header of headers) {
      const value = filled[header];
      if (value !== undefined && value.trim() !== '') {
        lastSeen[header] = value;
      } else if (lastSeen[header] !== undefined) {
        filled[header] = lastSeen[header]!;
      }
    }
    return filled;
  });
}

/**
 * The one shared upload -> parse -> detect-columns -> suggest-mapping
 * pipeline stage reused by Lead Import, Inventory Import, and Payment
 * Import — so there are three field dictionaries and three
 * validate/dedupe/write paths, not three copies of "how do I read an
 * uploaded file". Everything past this point (preview, duplicate
 * detection, conflict detection, confirm) is target-specific and lives in
 * each importer's own service.
 */
export class ImportSessionService {
  constructor(private readonly sessions: Repository<ImportSession>) {}

  private detectFileType(fileName: string, contentType: string): ImportFileType {
    const ext = fileName.toLowerCase().split('.').pop() ?? '';
    if (ext === 'csv' || contentType.includes('csv')) return 'csv';
    if (ext === 'xlsx' || ext === 'xls' || contentType.includes('spreadsheet') || contentType.includes('excel')) return 'xlsx';
    if (ext === 'pdf' || contentType.includes('pdf')) return 'pdf';
    throw new ValidationError(`unsupported file "${fileName}" — only .csv, .xlsx/.xls, and .pdf are supported`);
  }

  async createSession(input: CreateImportSessionInput): Promise<ImportSession> {
    const fileType = this.detectFileType(input.fileName, input.contentType);

    let headers: string[];
    let rows: Record<string, string>[];
    let reliable = true;

    if (fileType === 'csv') {
      rows = parseCsvRecords(input.fileBuffer.toString('utf8'));
      headers = rows.length > 0 ? Object.keys(rows[0]!) : [];
    } else if (fileType === 'xlsx') {
      const parsed = await parseXlsx(input.fileBuffer);
      headers = parsed.headers;
      rows = parsed.rows;
    } else {
      const parsed = await parsePdfTable(input.fileBuffer);
      headers = parsed.headers;
      rows = parsed.rows;
      reliable = parsed.reliable;
    }

    if (headers.length === 0) {
      throw new ValidationError('could not detect any columns in this file — check that it has a header row and real tabular data');
    }
    if (!reliable) {
      throw new ValidationError(
        'this PDF\'s layout could not be reliably read as a table (common for scanned/image PDFs) — try exporting it as Excel/CSV instead, or a cleaner PDF export',
      );
    }
    if (input.fillDownBlankCells) {
      rows = fillDownBlanks(headers, rows);
    }

    const now = Date.now();
    const session: ImportSession = {
      id: randomUUID(),
      companyId: input.companyId,
      createdByUserId: input.createdByUserId,
      targetType: input.targetType,
      fileName: input.fileName,
      fileType,
      status: 'uploaded',
      detectedColumns: headers,
      suggestedMapping: suggestMapping(headers, input.fields),
      rawRows: rows,
      reliable,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    };
    return this.sessions.save(session);
  }

  async getSession(id: string, companyId: string): Promise<ImportSession> {
    const session = await this.sessions.findById(id);
    if (!session || session.companyId !== companyId) throw new NotFoundError('import session not found');
    if (Date.parse(session.expiresAt) < Date.now() && session.status !== 'confirmed') {
      throw new ValidationError('this import session has expired — please re-upload the file');
    }
    return session;
  }

  async confirmMapping(id: string, companyId: string, mapping: Record<string, string | null>, options?: Record<string, unknown>): Promise<ImportSession> {
    const session = await this.getSession(id, companyId);
    const updated: ImportSession = { ...session, confirmedMapping: mapping, importOptions: options, status: 'mapped' };
    return this.sessions.save(updated);
  }

  async markConfirmed(id: string, companyId: string): Promise<ImportSession> {
    const session = await this.getSession(id, companyId);
    const updated: ImportSession = { ...session, status: 'confirmed' };
    return this.sessions.save(updated);
  }

  /** Import History: every session this company has ever created, newest
   * first, optionally filtered to one target type (lead/inventory_unit/
   * payment) — the frontend renders this so an admin can see exactly what
   * was imported, by whom, and its final outcome status. */
  async listForCompany(companyId: string, targetType?: ImportSession['targetType']): Promise<ImportSession[]> {
    const sessions = await this.sessions.findAll((s) => s.companyId === companyId && (!targetType || s.targetType === targetType));
    return sessions.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  /**
   * Re-keys every raw row from detected-file-column-names to
   * target-field-keys using the confirmed mapping (falling back to the
   * suggested one before confirmation, e.g. for an early preview). A
   * column mapped to null is dropped. This is the shape every specific
   * importer's validation/dedupe/conflict logic reads.
   */
  mapRows(session: ImportSession): Record<string, string>[] {
    const mapping = session.confirmedMapping ?? session.suggestedMapping;
    return session.rawRows.map((row) => {
      const mapped: Record<string, string> = {};
      for (const [column, fieldKey] of Object.entries(mapping)) {
        if (!fieldKey) continue;
        mapped[fieldKey] = row[column] ?? '';
      }
      return mapped;
    });
  }
}
