import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone } from './phone.js';

test('normalizes an Egyptian local-format number (leading 0) to +20', () => {
  assert.equal(normalizePhone('01012345678'), '+201012345678');
});

test('normalizes an already-international number unchanged', () => {
  assert.equal(normalizePhone('+201012345678'), '+201012345678');
});

test('normalizes formatting variations (spaces, dashes) to the same canonical value', () => {
  assert.equal(normalizePhone('010 1234 5678'), '+201012345678');
  assert.equal(normalizePhone('010-1234-5678'), '+201012345678');
  assert.equal(normalizePhone('+20 10 1234 5678'), '+201012345678');
});

test('normalizes a country-code number missing its plus sign', () => {
  assert.equal(normalizePhone('201012345678'), '+201012345678');
});

test('normalizes a 10-digit Egyptian mobile missing its leading zero', () => {
  assert.equal(normalizePhone('1012345678'), '+201012345678');
});

test('leaves a non-Egyptian international number intact aside from formatting', () => {
  assert.equal(normalizePhone('+1 415 555 2671'), '+14155552671');
});

test('returns the trimmed original string when there are no digits at all', () => {
  assert.equal(normalizePhone('   '), '');
});
