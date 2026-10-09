const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Closes a documented gap: list endpoints previously returned every
 * matching row with no limit/offset support at all. */
export function paginate<T>(items: T[], query: URLSearchParams, expectedCompanyId?: string): Page<T> {
  if (expectedCompanyId) assertSingleTenant(items, expectedCompanyId);
  const rawLimit = Number(query.get('limit'));
  const rawOffset = Number(query.get('offset'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
}

/**
 * Defense-in-depth, not itself a security boundary — the real boundary is
 * each service method's own companyId check plus RbacEvaluator's hard wall
 * (rbac.evaluator.ts), both already enforced long before a list ever
 * reaches here. This is a programmer-error detector: if a caller ever
 * passes `paginate()` an array that was supposed to be pre-filtered to one
 * tenant but wasn't (a bug, not an attack by itself), this throws loudly
 * instead of silently shipping another tenant's row in the response.
 * Opt-in per call site via paginate()'s optional third argument — existing
 * call sites that omit it are unaffected.
 */
export function assertSingleTenant<T>(items: T[], expectedCompanyId: string): void {
  for (const item of items) {
    const companyId = (item as Record<string, unknown>).companyId;
    if (companyId !== undefined && companyId !== expectedCompanyId) {
      throw new Error(
        `[tenant-isolation invariant] paginate(): item.companyId (${String(companyId)}) !== expectedCompanyId (${expectedCompanyId}) — a cross-tenant row reached the response layer`,
      );
    }
  }
}
