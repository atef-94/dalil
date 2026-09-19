import ExcelJS from 'exceljs';
import { ValidationError } from './errors.js';

export interface ParsedSheet {
  headers: string[];
  rows: Record<string, string>[];
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    // Rich text (`{richText: [...]}`), hyperlinks (`{text, hyperlink}`), and
    // formula cells (`{formula, result}`) are all exceljs cell.value shapes
    // — take the human-visible text, never the formula source or markup.
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.richText)) {
      return (obj.richText as { text?: string }[]).map((r) => r.text ?? '').join('');
    }
    if (typeof obj.text === 'string') return obj.text;
    if (obj.result !== undefined) return cellToString(obj.result);
    if (obj.error) return '';
    return '';
  }
  return String(value);
}

/**
 * Parses a real .xlsx/.xls workbook buffer into header + row records, using
 * the first non-empty sheet's first row as headers — same
 * "headers -> Record<string,string> per row" shape parseCsvRecords already
 * produces, so every downstream consumer (field-mapping, dedupe, import
 * services) works identically regardless of whether the source file was a
 * CSV or an Excel workbook.
 */
export async function parseXlsx(buffer: Buffer): Promise<ParsedSheet> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs's own index.d.ts declares a bogus global `Buffer extends
    // ArrayBuffer` that merges with (and corrupts) Node's real Buffer type
    // program-wide the moment its types are imported anywhere — a known
    // exceljs typings defect, not a real runtime incompatibility (the
    // merged type is structurally broken enough that even `as unknown as
    // Buffer` still fails the following assignability check, so this call
    // site opts all the way out with `any` instead). The cast is scoped to
    // this one call rather than weakening this module's own Buffer usage.
    await workbook.xlsx.load(buffer as any);
  } catch (err) {
    throw new ValidationError(`could not read this file as an Excel workbook: ${err instanceof Error ? err.message : String(err)}`);
  }

  const sheet = workbook.worksheets.find((s) => s.rowCount > 0);
  if (!sheet) return { headers: [], rows: [] };

  let headers: string[] = [];
  const rows: Record<string, string>[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values = row.values as unknown[]; // exceljs pads index 0; real cells start at 1
    const cells = values.slice(1).map(cellToString);
    if (rowNumber === 1) {
      headers = cells.map((c) => c.trim());
      return;
    }
    if (cells.every((c) => c.trim() === '')) return; // skip fully blank rows
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => {
      if (!h) return;
      record[h] = (cells[idx] ?? '').trim();
    });
    rows.push(record);
  });

  return { headers: headers.filter(Boolean), rows };
}
