import { randomBytes, scryptSync, timingSafeEqual, createHmac, createHash, createCipheriv, createDecipheriv } from 'node:crypto';

const SCRYPT_KEYLEN = 64;
// A flat, non-refreshable TTL (no refresh-token flow exists) — long enough
// to cover a normal work session without forcing a re-login mid-task. The
// previous 15-minute value silently broke every screen after a short idle
// gap: the frontend clears the token on any 401 but had no re-auth prompt,
// so a mid-session expiry looked like random features "not working".
const TOKEN_TTL_SECONDS = 12 * 60 * 60; // 12-hour token TTL

// ---- Password hashing (scrypt, Node's built-in KDF) ----

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, derived] = stored.split(':');
  if (!salt || !derived) return false;
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(derived, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

// ---- One-way hashing for high-entropy bearer tokens (invitation accept
// links, password-reset links) — deterministic SHA-256, NOT scrypt. These
// tokens are already randomBytes(32)-generated, not human passwords, so
// there's no offline-cracking risk a slow KDF would defend against; using a
// deterministic hash instead means the accept/reset flow can look a row up
// BY the token's hash directly (repo.findAll(t => t.tokenHash === hash))
// instead of scanning and scrypt-verifying every still-pending row. ----

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export function generateRawToken(): string {
  return randomBytes(32).toString('hex');
}

// ---- HMAC-SHA256-signed tokens (JWT-shaped: header.payload.signature, base64url) ----

export interface TokenPayload {
  sub: string; // userId
  companyId: string;
  userType: string;
  iat: number;
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function signToken(payload: Omit<TokenPayload, 'iat' | 'exp'>, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: TokenPayload = { ...payload, iat: now, exp: now + TOKEN_TTL_SECONDS };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(fullPayload));
  const signature = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function verifyToken(token: string, secret: string): TokenPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('malformed token');
  }
  const [encodedHeader, encodedPayload, signature] = parts as [string, string, string];
  const expectedSignature = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSignature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('invalid token signature');
  }
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as TokenPayload;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    throw new Error('token expired');
  }
  return payload;
}

// ---- Symmetric encryption at rest (AES-256-GCM) for stored secrets
// (automation webhook/API credentials) — never used for passwords, which
// stay scrypt-hashed and one-way above. The key is derived once from the
// server's encryption secret so callers never handle raw key bytes. ----

function deriveEncryptionKey(secret: string): Buffer {
  // A fixed, non-secret salt is fine here: this KDF's job is only to turn
  // an arbitrary-length secret string into a 32-byte AES-256 key, not to
  // defend against a leaked secret (the secret itself is the real defense,
  // same threat model as TOKEN_SECRET for signToken above).
  return scryptSync(secret, 'active-os-secret-store-v1', 32);
}

export interface EncryptedPayload {
  encryptedValue: string; // hex
  iv: string; // hex
  authTag: string; // hex
}

export function encryptSecret(plaintext: string, secret: string): EncryptedPayload {
  const key = deriveEncryptionKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    encryptedValue: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  };
}

export function decryptSecret(payload: EncryptedPayload, secret: string): string {
  const key = deriveEncryptionKey(secret);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(payload.authTag, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(payload.encryptedValue, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}
