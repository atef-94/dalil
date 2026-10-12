import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTotpSecret, generateTotpCode, verifyTotpCode, buildTotpUri, generateRecoveryCodes } from './totp.js';

test('a code generated for a secret verifies against that same secret', () => {
  const secret = generateTotpSecret();
  const code = generateTotpCode(secret);
  assert.equal(verifyTotpCode(secret, code), true);
});

test('a code generated for one secret does not verify against a different secret', () => {
  const secretA = generateTotpSecret();
  const secretB = generateTotpSecret();
  const code = generateTotpCode(secretA);
  assert.equal(verifyTotpCode(secretB, code), false);
});

test('a malformed code (not 6 digits) is rejected outright', () => {
  const secret = generateTotpSecret();
  assert.equal(verifyTotpCode(secret, '123'), false);
  assert.equal(verifyTotpCode(secret, 'abcdef'), false);
});

test('a code from one time step in the past still verifies (clock-drift tolerance)', () => {
  const secret = generateTotpSecret();
  const now = Date.now();
  const previousStepCode = generateTotpCode(secret, now - 30_000);
  assert.equal(verifyTotpCode(secret, previousStepCode, now), true);
});

test('a code from far outside the tolerance window is rejected', () => {
  const secret = generateTotpSecret();
  const now = Date.now();
  const farPastCode = generateTotpCode(secret, now - 10 * 60_000);
  assert.equal(verifyTotpCode(secret, farPastCode, now), false);
});

test('two freshly generated secrets are different (real randomness, not a fixed value)', () => {
  assert.notEqual(generateTotpSecret(), generateTotpSecret());
});

test('the otpauth URI embeds the secret and the account email', () => {
  const secret = generateTotpSecret();
  const uri = buildTotpUri(secret, 'owner@example.com');
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.ok(uri.includes(secret));
  assert.ok(uri.includes(encodeURIComponent('owner@example.com')) || uri.includes('owner@example.com'));
});

test('generateRecoveryCodes returns the requested count of distinct codes', () => {
  const codes = generateRecoveryCodes(10);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) {
    assert.match(code, /^\d{6}-\d{6}$/);
  }
});
