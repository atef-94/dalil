import { createHmac, randomBytes, randomInt } from 'node:crypto';

// RFC 6238 TOTP (HOTP, RFC 4226, applied to a 30-second time step) built on
// Node's built-in createHmac — no otplib/speakeasy dependency needed for an
// algorithm this small. SHA-1 is used deliberately: it's what RFC 6238
// specifies and what every real authenticator app (Google/Microsoft/Authy)
// expects — it is not a cryptographic weakness here, since TOTP's security
// comes from the shared-secret HMAC, not from SHA-1 collision resistance.

const STEP_SECONDS = 30;
const DIGITS = 6;
const DIGITS_MOD = 10 ** DIGITS;
// Tolerate the previous/current/next 30s step (+/-30s of clock drift)
// before rejecting a code — matches common authenticator-app leniency.
const VERIFY_WINDOW_STEPS = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(encoded: string): Buffer {
  const clean = encoded.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh random TOTP shared secret, base32-encoded (the form every
 * authenticator app's "enter code manually" field expects). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secretBase32: string, counter: number): string {
  const key = base32Decode(secretBase32);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(binary % DIGITS_MOD).padStart(DIGITS, '0');
}

/** The current 6-digit code for a secret — used only by tests (a real
 * authenticator app computes this independently from the enrolled secret). */
export function generateTotpCode(secretBase32: string, at: number = Date.now()): string {
  return hotp(secretBase32, Math.floor(at / 1000 / STEP_SECONDS));
}

/** Verifies a user-submitted code against the stored secret, tolerating
 * +/-1 time step of clock drift. */
export function verifyTotpCode(secretBase32: string, code: string, at: number = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const currentStep = Math.floor(at / 1000 / STEP_SECONDS);
  for (let delta = -VERIFY_WINDOW_STEPS; delta <= VERIFY_WINDOW_STEPS; delta++) {
    if (hotp(secretBase32, currentStep + delta) === code) return true;
  }
  return false;
}

/** An otpauth:// URI an authenticator app can scan/import directly (as a QR
 * code rendered client-side, or typed in manually from the secret alone). */
export function buildTotpUri(secretBase32: string, accountEmail: string, issuer = 'ACTIVE'): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** One-time recovery codes shown to the user exactly once at enrollment —
 * only their scrypt hashes are ever stored (same one-way pattern as
 * passwords; see security.ts hashPassword/verifyPassword). */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const part = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
    codes.push(`${part()}-${part()}`);
  }
  return codes;
}
