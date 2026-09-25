import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBedrooms, parsePercent, parseCurrencyNumber, normalizeFinishing, parseDeliveryInfo, splitList } from './import-normalize.js';

test('parseBedrooms handles common English/Arabic spelling variants', () => {
  assert.equal(parseBedrooms('3 Beds'), 3);
  assert.equal(parseBedrooms('3 Bedrooms'), 3);
  assert.equal(parseBedrooms('3 BR'), 3);
  assert.equal(parseBedrooms('3 غرف'), 3);
  assert.equal(parseBedrooms('Studio'), 0);
  assert.equal(parseBedrooms('5+'), 5);
  assert.equal(parseBedrooms(''), undefined);
  assert.equal(parseBedrooms(undefined), undefined);
  assert.equal(parseBedrooms('no digits here'), undefined);
});

test('parsePercent normalizes %, spaced %, and fractional forms to a 0-100 value', () => {
  assert.equal(parsePercent('10%'), 10);
  assert.equal(parsePercent('10 %'), 10);
  assert.equal(parsePercent('0.10'), 10);
  assert.equal(parsePercent('15'), 15);
  assert.equal(parsePercent(''), undefined);
  assert.equal(parsePercent(undefined), undefined);
});

test('parseCurrencyNumber strips commas and currency symbols/letters', () => {
  assert.equal(parseCurrencyNumber('3,500,000'), 3500000);
  assert.equal(parseCurrencyNumber('EGP 3500000'), 3500000);
  assert.equal(parseCurrencyNumber('$450,000'), 450000);
  assert.equal(parseCurrencyNumber('not a number'), undefined);
});

test('normalizeFinishing canonicalizes known English/Arabic synonyms, preserves unknown values', () => {
  assert.equal(normalizeFinishing('Fully finish'), 'Fully Finished');
  assert.equal(normalizeFinishing('تشطيب كامل'), 'Fully Finished');
  assert.equal(normalizeFinishing('Semi-Finished'), 'Semi Finished');
  assert.equal(normalizeFinishing('نصف تشطيب'), 'Semi Finished');
  assert.equal(normalizeFinishing('Core & Shell'), 'Core & Shell');
  assert.equal(normalizeFinishing('Some Custom Label'), 'Some Custom Label');
  assert.equal(normalizeFinishing(''), undefined);
});

test('parseDeliveryInfo produces structured data at the right granularity, never a fabricated exact date', () => {
  assert.deepEqual(parseDeliveryInfo('2027-06-01'), { exactDate: '2027-06-01' });
  assert.deepEqual(parseDeliveryInfo('Q2 2028'), { quarter: 2, year: 2028 });
  assert.deepEqual(parseDeliveryInfo('Q3/2029'), { quarter: 3, year: 2029 });
  assert.deepEqual(parseDeliveryInfo('2030'), { year: 2030 });
  assert.deepEqual(parseDeliveryInfo('On Handover'), { phaseLabel: 'On Handover' });
  assert.equal(parseDeliveryInfo(''), undefined);
});

test('splitList splits on comma/semicolon/slash/Arabic "و", trims, drops empties', () => {
  assert.deepEqual(splitList('Clubhouse, Gym, Pool'), ['Clubhouse', 'Gym', 'Pool']);
  assert.deepEqual(splitList('Gym/Pool;Security'), ['Gym', 'Pool', 'Security']);
  assert.deepEqual(splitList('جيم و حمام سباحة'), ['جيم', 'حمام سباحة']);
  assert.deepEqual(splitList(''), []);
  assert.deepEqual(splitList(undefined), []);
});
