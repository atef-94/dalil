import { randomUUID } from 'node:crypto';
import type { ImportSession, ImportFileType, ImportTargetType } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError, ValidationError } from '../../infra/errors.js';
import { parseCsvRecords } from '../../infra/csv.js';
import { parseXlsx, parseXlsxAllSheets } from '../../infra/xlsx-parser.js';
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
  /** A real broker/developer portfolio export commonly puts one project per
   * worksheet tab (e.g. sheets named "Stayn", "Connect4", "Jiran", ...)
   * instead of one flat table with a Project column — parseXlsx alone only
   * ever reads the first sheet, silently dropping every other project with
   * no error. When set (to the exact column name the target field dictionary
   * expects, e.g. "Project"), every non-empty sheet is read and merged into
   * one row set, with that column filled in from the sheet's own name for
   * any row that doesn't already have a real value there — so a sheet that
   * happens to carry its own explicit Project column is left alone, and
   * only a sheet with no such column at all gets its name injected. .xlsx
   * only; ignored for CSV/PDF (which are always single-table anyway). */
  sheetNameAsColumn?: string;
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
    } else if (fileType === 'xlsx' && input.sheetNameAsColumn) {
      const projectColumn = input.sheetNameAsColumn;
      const sheets = await parseXlsxAllSheets(input.fileBuffer, input.fields);
      // A real multi-sheet export rarely spells the same column the same
      // way on every tab (e.g. "Type" on one sheet, "Unit Type" on
      // another; "code" vs "Code"; "Floor" vs "FLOOR"). Taking a flat
      // union of raw header text — the naive approach — leaves those as
      // separate columns, and suggestMapping only ever awards one column
      // per target field (by design, so two differently-worded columns
      // never silently collide within a single sheet). The result: every
      // sheet after the first "loses" the field to whichever sheet's
      // spelling got processed first, and its rows come through with that
      // required field blank — exactly what a real 7-sheet file surfaced.
      // Instead, each sheet's own headers are mapped to target fields
      // independently (safe: no single real sheet has two columns for the
      // same field), and every sheet after the first has its columns
      // renamed to match the first sheet's spelling for that same field —
      // so the merged row set ends up with one column per field, filled
      // in from whichever sheet actually carried it.
      const fieldKeyToCanonicalHeader = new Map<string, string>();
      const headerSet = new Set<string>([projectColumn]);
      rows = [];
      for (const sheet of sheets) {
        const sheetMapping = suggestMapping(sheet.headers, input.fields);
        const renameHeader = new Map<string, string>();
        for (const header of sheet.headers) {
          const fieldKey = sheetMapping[header];
          if (!fieldKey) continue;
          const canonical = fieldKeyToCanonicalHeader.get(fieldKey);
          if (canonical) {
            if (canonical !== header) renameHeader.set(header, canonical);
          } else {
            fieldKeyToCanonicalHeader.set(fieldKey, header);
          }
        }
        for (const header of sheet.headers) headerSet.add(renameHeader.get(header) ?? header);
        for (const row of sheet.rows) {
          const merged: Record<string, string> = {};
          for (const [header, value] of Object.entries(row)) {
            merged[renameHeader.get(header) ?? header] = value;
          }
          if (!merged[projectColumn]?.trim()) merged[projectColumn] = sheet.sheetName;
          rows.push(merged);
        }
      }
      headers = sheets.length > 0 ? Array.from(headerSet) : [];
    } else if (fileType === 'xlsx') {
      const parsed = await parseXlsx(input.fileBuffer, input.fields);
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
   *
   * A multi-sheet import (sheetNameAsColumn) can legitimately need two
   * differently-named raw columns mapped onto the same target field — e.g.
   * one sheet's price column wasn't recognized as the same field as
   * another sheet's during auto-detection, so the user maps both by hand.
   * Any single row only ever has real data under ONE of those columns (the
   * other is blank, since it belongs to a different sheet) — plain
   * iteration order would let whichever column happens to come last in the
   * mapping always win, silently blanking out a real value with an empty
   * one from the row's "other" sheet. A blank never overwrites a value
   * already set for that field; a second real value (a genuine conflict)
   * still wins, same as before.
   */
  mapRows(session: ImportSession): Record<string, string>[] {
    const mapping = session.confirmedMapping ?? session.suggestedMapping;
    return session.rawRows.map((row) => {
      const mapped: Record<string, string> = {};
      for (const [column, fieldKey] of Object.entries(mapping)) {
        if (!fieldKey) continue;
        const value = row[column] ?? '';
        if (value === '' && mapped[fieldKey]) continue;
        mapped[fieldKey] = value;
      }
      return mapped;
    });
  }
}
