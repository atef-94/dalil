import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dict = JSON.parse(readFileSync(path.join(__dirname, '..', 'active_ai_franco_dictionary.json'), 'utf8'));

const WORD_LOOKUP = new Map(dict.word_dictionary.map((e) => [e.arabic, e.franco_variants]));

// Longest-arabic-substring-first letter map, so digraph-like sequences
// (e.g. 'ال' as a fused definite article) match before single letters.
const LETTER_MAP = [...dict.letter_map].sort((a, b) => b.arabic.length - a.arabic.length);

function transliterateWord(word, rng) {
  const known = WORD_LOOKUP.get(word);
  if (known) return known[rng.next() % known.length];

  let out = '';
  let i = 0;
  while (i < word.length) {
    let matched = false;
    for (const entry of LETTER_MAP) {
      if (word.startsWith(entry.arabic, i)) {
        const options = entry.franco;
        out += options[rng.next() % options.length];
        i += entry.arabic.length;
        matched = true;
        break;
      }
    }
    if (!matched) { out += word[i]; i += 1; }
  }
  return out;
}

// Converts an Arabic-script sentence into a Franco-Arabic (Arabizi)
// rendering, word by word: known real-estate/CRM vocabulary uses its
// curated variant, everything else falls back to the letter map. Numbers,
// Latin-script tokens (already-embedded English/brand names) and
// punctuation pass through unchanged.
export function toFranco(text, rng) {
  return text
    .split(/(\s+)/)
    .map((token) => {
      if (/^\s+$/.test(token) || token === '') return token;
      const stripped = token.replace(/[؟!.,،]/g, '');
      const trailing = token.slice(stripped.length);
      if (!/[؀-ۿ]/.test(stripped)) return token;
      return transliterateWord(stripped, rng) + trailing;
    })
    .join('');
}

const TYPO_SUBS = [
  [/ة\b/g, 'ه'],
  [/إ|أ|آ/g, 'ا'],
  [/ى\b/g, 'ي'],
];

// Applies common native-script Egyptian typing mistakes (taa marbuta /
// haa confusion, hamza-seat leveling, alef maksura / yaa confusion) —
// used only for the typing_errors_and_keyboard_switch category, never
// silently mixed into other categories.
export function injectArabicTypo(text, rng) {
  const [pattern, replacement] = TYPO_SUBS[rng.next() % TYPO_SUBS.length];
  return text.replace(pattern, replacement);
}

export function francoDictionaryStats() {
  return { words: dict.word_dictionary.length, letters: dict.letter_map.length, rules: dict.spelling_variation_rules.length };
}
