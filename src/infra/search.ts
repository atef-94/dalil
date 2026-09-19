/**
 * A generic, case-insensitive substring search across a fixed set of an
 * item's own string fields — applied server-side, before pagination, so a
 * search actually reaches the full dataset instead of only whatever page
 * happens to already be loaded client-side. Deliberately not a full-text
 * index: every list this backs already loads its full per-company dataset
 * into memory for `paginate()`, so this costs nothing extra beyond the
 * `Array.prototype.filter` that was already happening.
 */
export function matchesQuery<T extends object>(item: T, fields: (keyof T)[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => {
    const value = (item as Record<string, unknown>)[field as string];
    return typeof value === 'string' && value.toLowerCase().includes(needle);
  });
}

/** Applies matchesQuery across an array only when a query string is
 * present, so callers can pass straight through to paginate() either way. */
export function searchFilter<T extends object>(items: T[], fields: (keyof T)[], query: string | null | undefined): T[] {
  if (!query || !query.trim()) return items;
  return items.filter((item) => matchesQuery(item, fields, query));
}
