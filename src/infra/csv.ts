/**
 * A minimal, dependency-free RFC4180-ish CSV parser — this project has no
 * runtime dependencies (see package.json), so bulk import doesn't reach for
 * one either. Handles quoted fields (commas/newlines/escaped "" inside
 * quotes) and both CRLF and LF line endings.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  function endField() {
    row.push(field);
    field = '';
  }
  function endRow() {
    endField();
    rows.push(row);
    row = [];
  }

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) endRow();

  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Parses CSV text using the first row as headers, returning one object
 * per data row keyed by header (trimmed). Rows shorter than the header are
 * padded with empty strings; extra columns beyond the header are ignored. */
export function parseCsvRecords(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const headers = rows[0]!.map((h) => h.trim());
  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => {
      record[h] = (row[idx] ?? '').trim();
    });
    return record;
  });
}
