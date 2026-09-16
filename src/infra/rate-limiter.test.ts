import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindowRateLimiter } from './rate-limiter.js';

test('allows requests under the limit', () => {
  const limiter = new SlidingWindowRateLimiter(1000, 3);
  assert.equal(limiter.consume('ip-1').allowed, true);
  assert.equal(limiter.consume('ip-1').allowed, true);
  assert.equal(limiter.consume('ip-1').allowed, true);
});

test('blocks requests once the limit is exceeded within the window', () => {
  const limiter = new SlidingWindowRateLimiter(1000, 2);
  assert.equal(limiter.consume('ip-1').allowed, true);
  assert.equal(limiter.consume('ip-1').allowed, true);
  assert.equal(limiter.consume('ip-1').allowed, false);
});

test('different keys are isolated from each other', () => {
  const limiter = new SlidingWindowRateLimiter(1000, 1);
  assert.equal(limiter.consume('ip-1').allowed, true);
  assert.equal(limiter.consume('ip-2').allowed, true);
  assert.equal(limiter.consume('ip-1').allowed, false);
});

test('the window slides: requests are allowed again once old hits age out', () => {
  const limiter = new SlidingWindowRateLimiter(1000, 1);
  const t0 = 1_000_000;
  assert.equal(limiter.consume('ip-1', t0).allowed, true);
  assert.equal(limiter.consume('ip-1', t0 + 500).allowed, false);
  assert.equal(limiter.consume('ip-1', t0 + 1500).allowed, true);
});

test('prune removes entries with no hits left in the window', () => {
  const limiter = new SlidingWindowRateLimiter(1000, 1);
  const t0 = 1_000_000;
  limiter.consume('ip-1', t0);
  limiter.prune(t0 + 2000);
  // after pruning, the key should behave as fresh again
  assert.equal(limiter.consume('ip-1', t0 + 2000).allowed, true);
});
