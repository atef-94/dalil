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

const INVENTORY_FIELDS: ImportFieldDef[] = [
  { key: 'projectName', label: 'Project', aliases: ['project name', 'اسم المشروع', 'المشروع'] },
  { key: 'unitCode', label: 'Unit Code', aliases: ['unit', 'unit number', 'unit no', 'رقم الوحدة', 'كود الوحدة'] },
  { key: 'unitType', label: 'Unit Type', aliases: ['type', 'نوع الوحدة'] },
  { key: 'areaSqm', label: 'Area (sqm)', aliases: ['area', 'مساحة الوحدة'] },
  { key: 'listPrice', label: 'List Price', aliases: ['price', 'السعر'] },
];

test('suggestMapping matches Arabic headers against Arabic aliases (previously always unmapped)', () => {
  const mapping = suggestMapping(['المشروع', 'رقم الوحدة', 'نوع الوحدة', 'مساحة الوحدة', 'السعر'], INVENTORY_FIELDS);
  assert.deepEqual(mapping, {
    المشروع: 'projectName',
    'رقم الوحدة': 'unitCode',
    'نوع الوحدة': 'unitType',
    'مساحة الوحدة': 'areaSqm',
    السعر: 'listPrice',
  });
});

test('suggestMapping folds Arabic diacritics and letter-shape variants before matching', () => {
  // Tashkeel (diacritics) added, and alef-hamza (أ) used instead of plain alef.
  const mapping = suggestMapping(['أَلْمَشْرُوع'], [{ key: 'projectName', label: 'Project', aliases: ['المشروع'] }]);
  assert.equal(mapping['أَلْمَشْرُوع'], 'projectName');
});

test('suggestMapping handles a mixed Arabic/English header file, matching each independently', () => {
  const mapping = suggestMapping(['Project', 'رقم الوحدة', 'Unit Type', 'مساحة الوحدة', 'Price'], INVENTORY_FIELDS);
  assert.deepEqual(mapping, {
    Project: 'projectName',
    'رقم الوحدة': 'unitCode',
    'Unit Type': 'unitType',
    'مساحة الوحدة': 'areaSqm',
    Price: 'listPrice',
  });
});

test('suggestMapping leaves an unrecognized Arabic header unmapped rather than guessing', () => {
  const mapping = suggestMapping(['لون مفضل'], INVENTORY_FIELDS);
  assert.equal(mapping['لون مفضل'], null);
});
