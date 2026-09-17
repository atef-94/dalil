/**
 * Runs a CSV bulk import row-by-row rather than as one all-or-nothing
 * transaction: a typo in row 40 of 200 shouldn't block the other 199 real
 * rows, and the caller needs to know exactly which rows succeeded, which
 * failed and why, and which CSV columns this import doesn't support (so a
 * silently-ignored column never gets mistaken for one that was saved).
 */
export interface ImportRowResult {
  row: number; // 1-based, counting from the first data row (header excluded)
  status: 'created' | 'error' | 'skipped';
  id?: string;
  error?: string;
}

/** Throw this from a runImport handler to mark a row as deliberately
 * skipped rather than failed — e.g. a Finance CSV row that's still "Due"
 * with nothing paid yet has nothing to record, which isn't an error in
 * the row's data, just nothing this import does anything with. */
export class SkipRow extends Error {}

export interface ImportResult {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: ImportRowResult[];
  unsupportedColumns: string[];
}

export async function runImport<T extends { id: string }>(
  records: Record<string, string>[],
  unsupportedColumns: string[],
  handler: (record: Record<string, string>, row: number) => Promise<T>,
): Promise<ImportResult> {
  const results: ImportRowResult[] = [];
  for (let i = 0; i < records.length; i++) {
    const row = i + 1;
    try {
      const created = await handler(records[i]!, row);
      results.push({ row, status: 'created', id: created.id });
    } catch (err) {
      if (err instanceof SkipRow) {
        results.push({ row, status: 'skipped', error: err.message });
      } else {
        results.push({ row, status: 'error', error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return {
    total: results.length,
    succeeded: results.filter((r) => r.status === 'created').length,
    failed: results.filter((r) => r.status === 'error').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    results,
    unsupportedColumns,
  };
}
