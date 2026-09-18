import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestMapping, type ImportFieldDef } from './field-mapping.js';

const LEAD_FIELDS: ImportFieldDef[] = [
  { key: 'fullName', label: 'Full Name', aliases: ['name', 'client name'] },
  { key: 'phone', label: 'Phone', aliases: ['mobile', 'phone number', 'tel'] },
  { key: 'email', label: 'Email', aliases: ['email address'] },
];

test('suggestMapping matches exact header/label spellings case-insensitively', () => {
  const mapping = suggestMapping(['Full Name', 'Phone', 'Email'], LEAD_FIELDS);
  assert.deepEqual(mapping, { 'Full Name': 'fullName', Phone: 'phone', Email: 'email' });
});

test('suggestMapping matches against declared aliases, not just the label', () => {
  const mapping = suggestMapping(['Client Name', 'Mobile', 'Email Address'], LEAD_FIELDS);
  assert.deepEqual(mapping, { 'Client Name': 'fullName', Mobile: 'phone', 'Email Address': 'email' });
});

test('suggestMapping ignores punctuation/casing/spacing differences', () => {
  const mapping = suggestMapping(['phone_number', 'PHONE NUMBER', 'Phone-Number'], [{ key: 'phone', label: 'Phone Number' }]);
  // Only one column can claim the field — first match wins, the rest stay unmapped.
  assert.equal(mapping.phone_number, 'phone');
  assert.equal(mapping['PHONE NUMBER'], null);
  assert.equal(mapping['Phone-Number'], null);
});

test('suggestMapping never maps two different columns to the same field', () => {
  const mapping = suggestMapping(['Phone', 'Mobile'], LEAD_FIELDS);
  assert.equal(mapping.Phone, 'phone');
  assert.equal(mapping.Mobile, null);
});

test('suggestMapping leaves an unrecognized column unmapped rather than guessing', () => {
  const mapping = suggestMapping(['Favorite Color'], LEAD_FIELDS);
  assert.equal(mapping['Favorite Color'], null);
});

test('suggestMapping leaves an ambiguous substring match unmapped', () => {
  // "date" is a substring-candidate for both fields below — neither should win.
  const fields: ImportFieldDef[] = [
    { key: 'startDate', label: 'Start Date' },
    { key: 'endDate', label: 'End Date' },
  ];
  const mapping = suggestMapping(['Date'], fields);
  assert.equal(mapping.Date, null);
});

test('suggestMapping handles an empty/blank header without crashing', () => {
  const mapping = suggestMapping(['', '   '], LEAD_FIELDS);
  assert.equal(mapping[''], null);
});
