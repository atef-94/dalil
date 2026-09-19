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
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
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
