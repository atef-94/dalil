import ExcelJS from 'exceljs';
import { ValidationError } from './errors.js';
import { suggestMapping, type ImportFieldDef } from './field-mapping.js';

export interface ParsedSheet {
  headers: string[];
  rows: Record<string, string>[];
  /** One entry per formula-error cell found (e.g. "#REF!", "#DIV/0!") in a
   * data row — these are always read as blank in the row itself (never
   * treated as legitimate data), and reported here instead so the importer
   * can flag the affected row rather than silently losing the problem. */
  formulaErrors: string[];
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

/** A formula-error cell's exceljs value shape is `{error: '#REF!'}` (or
 * nested inside `{formula, result: {error: '#REF!'}}`) — detected
 * separately from cellToString so a caller can report it as a real problem
 * instead of it silently disappearing into an empty string. */
function cellFormulaError(value: unknown): string | undefined {
  if (value === null || value === undefined || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.error === 'string') return obj.error;
  if (obj.result !== undefined) return cellFormulaError(obj.result);
  return undefined;
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

/** Reads one worksheet's rows into dense string arrays, picks out the real
 * header row (see detectHeaderRowIndex), and turns everything after it into
 * header -> value records. The one-sheet building block both parseXlsx
 * (first sheet only, for callers that only ever expect one) and
 * parseXlsxAllSheets (every non-empty sheet, for a workbook that spreads
 * its data across several — one tab per project is a common real-estate
 * export shape) are built from. */
function parseWorksheet(sheet: ExcelJS.Worksheet, fields?: ImportFieldDef[]): ParsedSheet {
  const allRows: string[][] = [];
  const allRowErrors: (string | undefined)[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as unknown[]; // exceljs pads index 0; real cells start at 1
    // A row whose trailing/middle cells were never touched (no value, no
    // style) comes back as a genuinely sparse array — real holes, not
    // `undefined` elements. `.map()` silently skips holes, which used to be
    // "safe" only because every consumer downstream (`.map`/`.forEach`/
    // `.filter`) also skips them — but a plain `for...of` loop (as
    // suggestMapping uses) does NOT skip holes, and yields `undefined` for
    // each one, which then crashes the first `.replace()` call on it. Build
    // the row explicitly by index instead, so every position — hole or not
    // — becomes a real string via cellToString(undefined) === ''.
    const cells: string[] = [];
    const errors: (string | undefined)[] = [];
    for (let i = 1; i < values.length; i++) {
      cells.push(cellToString(values[i]));
      errors.push(cellFormulaError(values[i]));
    }
    allRows.push(cells);
    allRowErrors.push(errors);
  });
  if (allRows.length === 0) return { headers: [], rows: [], formulaErrors: [] };

  const headerRowIndex = detectHeaderRowIndex(allRows, fields);
  const headers = (allRows[headerRowIndex] ?? []).map((c) => c.trim());
  const rows: Record<string, string>[] = [];
  const formulaErrors: string[] = [];
  let dataRowNumber = 0;
  for (let i = headerRowIndex + 1; i < allRows.length; i++) {
    const cells = allRows[i]!;
    if (cells.every((c) => c.trim() === '')) continue; // skip fully blank rows
    dataRowNumber += 1;
    const record: Record<string, string> = {};
    const rowErrors = allRowErrors[i]!;
    headers.forEach((h, idx) => {
      if (!h) return;
      record[h] = (cells[idx] ?? '').trim();
      const err = rowErrors[idx];
      if (err) formulaErrors.push(`row ${dataRowNumber}, column "${h}": formula error (${err})`);
    });
    rows.push(record);
  }

  return { headers: headers.filter(Boolean), rows, formulaErrors };
}

async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
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
  return workbook;
}

/**
 * Parses a real .xlsx/.xls workbook buffer into header + row records, same
 * "headers -> Record<string,string> per row" shape parseCsvRecords already
 * produces, so every downstream consumer (field-mapping, dedupe, import
 * services) works identically regardless of whether the source file was a
 * CSV or an Excel workbook. Only reads the first non-empty sheet — see
 * parseXlsxAllSheets for a workbook whose data is split across several tabs.
 *
 * `fields`, when supplied, lets the parser auto-detect which row is the
 * real header row instead of always assuming row 1 — see
 * detectHeaderRowIndex's own comment for why that matters.
 */
export async function parseXlsx(buffer: Buffer, fields?: ImportFieldDef[]): Promise<ParsedSheet> {
  const workbook = await loadWorkbook(buffer);
  const sheet = workbook.worksheets.find((s) => s.rowCount > 0);
  if (!sheet) return { headers: [], rows: [], formulaErrors: [] };
  return parseWorksheet(sheet, fields);
}

export interface ParsedWorkbookSheet extends ParsedSheet {
  sheetName: string;
}

/**
 * Same per-sheet parsing as parseXlsx, but for every non-empty sheet in the
 * workbook instead of just the first — a real broker/developer portfolio
 * export commonly puts one project per tab (e.g. sheets named "Stayn",
 * "Connect4", "Jiran", ...) rather than one flat table with a Project
 * column, and parseXlsx alone would silently import only the first tab and
 * drop every other project with no error at all. The caller decides what
 * to do with each sheet's name (e.g. ImportSessionService's
 * sheetNameAsColumn option injects it as that sheet's Project value).
 */
export async function parseXlsxAllSheets(buffer: Buffer, fields?: ImportFieldDef[]): Promise<ParsedWorkbookSheet[]> {
  const workbook = await loadWorkbook(buffer);
  const sheets: ParsedWorkbookSheet[] = [];
  for (const sheet of workbook.worksheets) {
    if (sheet.rowCount === 0) continue;
    const parsed = parseWorksheet(sheet, fields);
    if (parsed.headers.length === 0) continue;
    sheets.push({ sheetName: sheet.name, ...parsed });
  }
  return sheets;
}
