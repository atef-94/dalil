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
export function paginate<T>(items: T[], query: URLSearchParams): Page<T> {
  const rawLimit = Number(query.get('limit'));
  const rawOffset = Number(query.get('offset'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
}
