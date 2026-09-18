import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netContractValue } from './money.js';

test('netContractValue applies the discount percentage to the raw price', () => {
  assert.equal(netContractValue(1000000, 12), 880000);
});

test('netContractValue returns the raw price unchanged when no discount is given', () => {
  assert.equal(netContractValue(1000000, undefined), 1000000);
  assert.equal(netContractValue(1000000, 0), 1000000);
});

test('netContractValue rounds to the nearest cent', () => {
  assert.equal(netContractValue(999999, 33), 669999.33);
});
