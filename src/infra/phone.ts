/**
 * Normalizes a phone number into a stable, comparable canonical form
 * (E.164-ish: a leading '+' followed by digits only) so the same real
 * number typed in different formats — with/without spaces, dashes, a
 * leading 0, or a country code — always dedupes and stores identically.
 *
 * Egypt-aware: this product's phone numbers are overwhelmingly Egyptian
 * mobile numbers (local format 01XXXXXXXXX, country code +20), so a
 * leading-0 11-digit number or a bare 10-digit number starting with 1
 * (the same number with the leading 0 dropped) are both treated as local
 * Egyptian numbers missing their country code. Anything else — already
 * has a '+', or already starts with a plausible country code — is passed
 * through with only formatting characters stripped, so foreign numbers
 * aren't mangled.
 */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (!digits) return trimmed;

  if (hasPlus) return `+${digits}`;
  if (/^0[0-9]{10}$/.test(digits)) return `+20${digits.slice(1)}`; // 01XXXXXXXXX -> +201XXXXXXXXX
  if (/^1[0-9]{9}$/.test(digits)) return `+20${digits}`; // 1XXXXXXXXX (leading 0 dropped) -> +201XXXXXXXXX
  if (digits.startsWith('20')) return `+${digits}`; // already carries the 20 country code
  return `+${digits}`;
}
