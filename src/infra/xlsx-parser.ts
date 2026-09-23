import ExcelJS from 'exceljs';
import { ValidationError } from './errors.js';
import { suggestMapping, type ImportFieldDef } from './field-mapping.js';

export interface ParsedSheet {
  headers: string[];
  rows: Record<string, string>[];
}

/** Counts how many of a candidate row's cells would map onto a real target
 * field — used to pick out the real header row from among a handful of
 * candidates, never to guess at actual column mapping (that's still
 * suggestMapping's job on the real headers once chosen). */
function scoreHeaderCandidate(cells: string[], fields: ImportFieldDef[]): number {
  return Object.values(suggestMapping(cells, fields)).filter(Boolean).length;
}

/**
 * Real developer/broker price-list exports often lead with one or more
 * banner rows above the real header row — a merged "Project Name" title
 * spanning the whole sheet width, a logo caption, a generated-on date —
 * before the actual "Unit Type / Area / Price / ..." column headers. Taking
 * physical row 1 as the header unconditionally (the old behavior) reads
 * that banner text as if it were column names, which then fails to match
 * any known field alias — every column ends up "— Do not import —" and the
 * whole file looks like it "won't import" even though it's a perfectly
 * ordinary spreadsheet.
 *
 * When a field dictionary is supplied, this scores each of the first few
 * rows by how many cells would map onto a real field and picks the
 * best-scoring one — strictly better than row 1's own score, so a
 * well-formed file (headers already on row 1) is completely unaffected;
 * only a header row score has to be beaten. Falls back to row 1 (index 0)
 * when no field dictionary is given, or when nothing scores higher (e.g. a
 * genuinely unrecognized header row) — matching the previous behavior
 * exactly rather than guessing.
 */
function detectHeaderRowIndex(candidateRows: string[][], fields?: ImportFieldDef[]): number {
  if (!fields || fields.length === 0 || candidateRows.length === 0) return 0;
  const searchLimit = Math.min(candidateRows.length, 10);
  let bestIndex = 0;
  let bestScore = scoreHeaderCandidate(candidateRows[0]!, fields);
  for (let i = 1; i < searchLimit; i++) {
    const score = scoreHeaderCandidate(candidateRows[i]!, fields);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
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
 * Parses a real .xlsx/.xls workbook buffer into header + row records, same
 * "headers -> Record<string,string> per row" shape parseCsvRecords already
 * produces, so every downstream consumer (field-mapping, dedupe, import
 * services) works identically regardless of whether the source file was a
 * CSV or an Excel workbook.
 *
 * `fields`, when supplied, lets the parser auto-detect which row is the
 * real header row instead of always assuming row 1 — see
 * detectHeaderRowIndex's own comment for why that matters.
 */
export async function parseXlsx(buffer: Buffer, fields?: ImportFieldDef[]): Promise<ParsedSheet> {
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

  const allRows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as unknown[]; // exceljs pads index 0; real cells start at 1
    allRows.push(values.slice(1).map(cellToString));
  });
  if (allRows.length === 0) return { headers: [], rows: [] };

  const headerRowIndex = detectHeaderRowIndex(allRows, fields);
  const headers = (allRows[headerRowIndex] ?? []).map((c) => c.trim());
  const rows: Record<string, string>[] = [];
  for (const cells of allRows.slice(headerRowIndex + 1)) {
    if (cells.every((c) => c.trim() === '')) continue; // skip fully blank rows
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => {
      if (!h) return;
      record[h] = (cells[idx] ?? '').trim();
    });
    rows.push(record);
  }

  return { headers: headers.filter(Boolean), rows };
}
