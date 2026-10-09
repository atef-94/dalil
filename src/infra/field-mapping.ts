/**
 * Shared "smart column detection" used by every import pipeline (Lead,
 * Inventory, Payment) to suggest which detected file column maps to which
 * target field — never applied silently: the frontend always shows this
 * suggestion for the user to confirm or correct on the preview screen
 * before anything is imported.
 */
export interface ImportFieldDef {
  /** Target field key the specific importer's mapping/validation reads,
   * e.g. 'fullName', 'phone', 'unitCode'. */
  key: string;
  /** Human label shown in the mapping UI and matched against headers. */
  label: string;
  /** Alternate header spellings this field should also match, e.g.
   * ['mobile', 'tel', 'cell'] for a phone field. */
  aliases?: string[];
  required?: boolean;
  /** When this required field has no column mapped, an importer-specific
   * option (a key in that wizard's mappingOptions, e.g.
   * 'autoGenerateUnitCode') that — when enabled — recovers a real value
   * for it anyway, instead of the row simply failing. The frontend's
   * automatic-mapping check treats this field as satisfied whenever that
   * option is on, so a file missing this one column can still skip the
   * manual mapping screen. Never set for a field with no real fallback
   * (e.g. Project — there's no value to invent from nothing). */
  autoFallbackOptionKey?: string;
}

// Arabic combining diacritics (tashkeel) — stripped before matching so
// "المشروع" and "المُشْرُوع" normalize identically.
const ARABIC_DIACRITICS = /[ً-ٰٟۖ-ۭ]/g;

/** Lowercases, strips diacritics, folds common Arabic letter-shape
 * variants (alef forms -> ا, alef maksura -> ي, taa marbuta -> ه) so
 * spelling variants match, then keeps only ASCII alphanumerics AND Arabic
 * script characters (؀-ۿ) — everything else (spaces, punctuation,
 * parentheses) is dropped. Previously this stripped to `[a-z0-9]` only,
 * which silently collapsed every Arabic header to an empty string and left
 * it permanently unmapped; Arabic headers now normalize and match exactly
 * like English ones. */
function normalizeHeader(value: string): string {
  const folded = value
    .replace(ARABIC_DIACRITICS, '')
    .replace(/[آأإٱ]/g, 'ا') // آ أ إ ٱ -> ا
    .replace(/ى/g, 'ي') // ى -> ي
    .replace(/ة/g, 'ه') // ة -> ه
    .toLowerCase();
  return folded.replace(/[^a-z0-9؀-ۿ]+/g, '');
}

/**
 * Suggests one target field per detected column: an exact normalized match
 * against a field's label/aliases wins outright; failing that, a
 * substring match is only accepted when exactly one field qualifies (an
 * ambiguous substring match is left unmapped rather than guessed). Each
 * target field is used at most once, so two differently-worded columns can
 * never both silently collide onto the same field.
 */
export function suggestMapping(detectedColumns: string[], fields: ImportFieldDef[]): Record<string, string | null> {
  const candidates = fields.map((f) => ({
    key: f.key,
    normalized: [f.label, ...(f.aliases ?? [])].map(normalizeHeader),
  }));
  const used = new Set<string>();
  const mapping: Record<string, string | null> = {};

  for (const column of detectedColumns) {
    const normalizedColumn = normalizeHeader(column);
    if (!normalizedColumn) {
      mapping[column] = null;
      continue;
    }

    let matchedKey: string | null = null;

    for (const candidate of candidates) {
      if (used.has(candidate.key)) continue;
      if (candidate.normalized.includes(normalizedColumn)) {
        matchedKey = candidate.key;
        break;
      }
    }

    if (!matchedKey) {
      const substringMatches = candidates.filter(
        (candidate) =>
          !used.has(candidate.key) &&
          candidate.normalized.some((c) => c.length >= 3 && (normalizedColumn.includes(c) || c.includes(normalizedColumn))),
      );
      if (substringMatches.length === 1) matchedKey = substringMatches[0]!.key;
    }

    mapping[column] = matchedKey;
    if (matchedKey) used.add(matchedKey);
  }

  return mapping;
}

export type SheetKind = 'catalog' | 'availability' | 'summary' | 'unknown';

/**
 * Classifies a sheet's headers as a project-catalog table, a live-
 * availability table, a summary/fact-sheet, or unrecognized — scored
 * against two separate field dictionaries using the same suggestMapping
 * already used for column mapping, never a separate guessing heuristic.
 *
 * A dictionary only "claims" a sheet when at least one of its anchor
 * fields (the field(s) that give a row real identity — a unit code for
 * availability, a project/developer name for catalog) actually matched a
 * column; a sheet with a few loose matches but no anchor (a Fact Sheet's
 * "Type / Quantity / Min SQM / Max SQM / Min Price / Max Price" summary
 * table commonly scores a couple of loose matches this way) is classified
 * 'summary' rather than guessed into either real import path. A sheet with
 * no matches at all against either dictionary is 'unknown'.
 */
export function classifySheet(
  headers: string[],
  catalogFields: ImportFieldDef[],
  availabilityFields: ImportFieldDef[],
  catalogAnchorKeys: string[],
  availabilityAnchorKeys: string[],
): SheetKind {
  const catalogMapping = suggestMapping(headers, catalogFields);
  const availabilityMapping = suggestMapping(headers, availabilityFields);
  const catalogValues = Object.values(catalogMapping);
  const availabilityValues = Object.values(availabilityMapping);
  const catalogScore = catalogValues.filter(Boolean).length;
  const availabilityScore = availabilityValues.filter(Boolean).length;
  const hasCatalogAnchor = catalogAnchorKeys.some((k) => catalogValues.includes(k));
  const hasAvailabilityAnchor = availabilityAnchorKeys.some((k) => availabilityValues.includes(k));

  if (hasAvailabilityAnchor && availabilityScore >= catalogScore) return 'availability';
  if (hasCatalogAnchor && catalogScore >= availabilityScore) return 'catalog';
  if (catalogScore === 0 && availabilityScore === 0) return 'unknown';
  return 'summary';
}
