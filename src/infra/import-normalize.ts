/**
 * Shared data-normalization helpers for the Import Engine (Inventory today,
 * reusable by any future importer) — each function turns a real range of
 * developer-export spelling variants (English and Arabic) into one
 * structured value, never guessing when the input doesn't actually contain
 * a recognizable value (returns undefined rather than inventing 0/false).
 */

/** "3 Beds" / "3 Bedrooms" / "3 BR" / "3 غرف" / "Studio" / "5+" -> a number.
 * "Studio" normalizes to 0 (no separate bedroom). "5+" normalizes to 5 —
 * the numeric floor of an open-ended range, not a guess at the true count. */
export function parseBedrooms(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  const text = raw.trim().toLowerCase();
  if (/^studio$|استوديو/.test(text)) return 0;
  const match = text.match(/\d+/);
  if (!match) return undefined;
  const n = Number(match[0]);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** "10%" / "10 %" / "0.10" -> 10 (a 0-100 percentage, never a 0-1 fraction).
 * A bare number > 1 is taken as already being a percentage; a bare number
 * <= 1 (and > 0) is taken as a fraction and scaled up — "0.10" and "10%"
 * both mean the same real-world 10%. */
export function parsePercent(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  const hasPercentSign = raw.includes('%');
  const cleaned = raw.replace(/[%\s]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return undefined;
  if (hasPercentSign) return n;
  return n > 0 && n <= 1 ? n * 100 : n;
}

/** Strips thousands separators and currency symbols/letters, keeping the
 * sign and decimal point — "3,500,000" / "EGP 3500000" / "$450,000" -> a
 * plain number. Returns undefined for anything that isn't really numeric. */
export function parseCurrencyNumber(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  const cleaned = raw.replace(/,/g, '').replace(/[^0-9.\-]/g, '');
  if (!cleaned) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

const FINISHING_SYNONYMS: { canonical: string; patterns: RegExp[] }[] = [
  { canonical: 'Core & Shell', patterns: [/core\s*&?\s*shell/i, /^shell$/i, /على\s*الطوب/, /دون\s*تشطيب/] },
  { canonical: 'Semi Finished', patterns: [/semi[\s-]?finish/i, /نصف\s*تشطيب/] },
  { canonical: 'Fully Finished + ACs', patterns: [/fully?\s*finish.*a\/?c/i, /finish.*with\s*ac/i, /تشطيب.*تكييف/] },
  { canonical: 'Furnished', patterns: [/furnish/i, /مفروش/] },
  { canonical: 'Fully Finished', patterns: [/fully?\s*finish/i, /تشطيب\s*كامل/, /تشطيب\s*كاملة/] },
];

/** Canonicalizes a free-text finishing value against known synonyms
 * (English + Arabic) so "Fully finish"/"تشطيب كامل"/"Fully Finished" all
 * land on the same label. An unrecognized value is returned trimmed as-is
 * — never forced into a fixed enum, since the system deliberately supports
 * configurable finishing types beyond this list. */
export function normalizeFinishing(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const trimmed = raw.trim();
  for (const { canonical, patterns } of FINISHING_SYNONYMS) {
    if (patterns.some((p) => p.test(trimmed))) return canonical;
  }
  return trimmed;
}

export interface ParsedDeliveryInfo {
  exactDate?: string;
  quarter?: 1 | 2 | 3 | 4;
  year?: number;
  phaseLabel?: string;
}

/** "2027-06-01" -> exact date. "Q2 2028" / "Q2/2028" -> quarter+year.
 * "2029" alone -> year only. Anything else non-empty is kept as a
 * phaseLabel (e.g. "On Handover", "Delivery Phase 2") rather than forced
 * into an incorrect exact date — matches the spec's explicit instruction
 * not to fabricate false precision from an approximate developer estimate. */
export function parseDeliveryInfo(raw: string | undefined): ParsedDeliveryInfo | undefined {
  if (!raw?.trim()) return undefined;
  const text = raw.trim();

  const quarterMatch = text.match(/q([1-4])[\s/-]*(\d{4})/i);
  if (quarterMatch) {
    return { quarter: Number(quarterMatch[1]) as 1 | 2 | 3 | 4, year: Number(quarterMatch[2]) };
  }

  if (/^\d{4}$/.test(text)) {
    return { year: Number(text) };
  }

  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed) && /\d{4}-\d{1,2}-\d{1,2}/.test(text)) {
    return { exactDate: new Date(parsed).toISOString().slice(0, 10) };
  }

  return { phaseLabel: text };
}

/** Splits a free-text list column on comma, slash, semicolon, or the
 * Arabic conjunction "و" between words — "Clubhouse, Gym, Pool" / "جيم و
 * حمام سباحة" -> ["Clubhouse", "Gym", "Pool"] / ["جيم", "حمام سباحة"].
 * Trims each item and drops empties; never splits on a bare space so
 * multi-word items (e.g. "Swimming Pool") stay intact. */
export function splitList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[,;/]|\sو\s/)
    .map((s) => s.trim())
    .filter(Boolean);
}
