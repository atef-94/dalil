import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestMapping, classifySheet, type ImportFieldDef } from './field-mapping.js';
import { CATALOG_IMPORT_FIELDS, AVAILABILITY_IMPORT_FIELDS, CATALOG_ANCHOR_KEYS, AVAILABILITY_ANCHOR_KEYS } from '../modules/inventory/inventory-import.service.js';

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

// ---- classifySheet (sheet-kind detection for the canonical import engine) ----

function classify(headers: string[]) {
  return classifySheet(headers, CATALOG_IMPORT_FIELDS, AVAILABILITY_IMPORT_FIELDS, CATALOG_ANCHOR_KEYS, AVAILABILITY_ANCHOR_KEYS);
}

test('classifySheet recognizes a live-availability sheet (Code/Floor/Unit Type/Price/Status)', () => {
  assert.equal(classify(['Code', 'Type', 'Building', 'Floor', 'Flat', 'Rooms', 'Area', 'Garden', 'Price', 'Status']), 'availability');
});

test('classifySheet recognizes a project-catalog sheet (Developer/Project/Phase/BUA From-To/Price From-To)', () => {
  assert.equal(
    classify(['Developer', 'Project', 'Phase', 'Unit Type', 'Bedrooms', 'BUA From', 'BUA To', 'Price From', 'Price To', 'Finishing', 'Delivery']),
    'catalog',
  );
});

test('classifySheet recognizes the same live-availability shape under CONNECT 4-style headers (Floor/In Door/Out Door/Price per Meter/Final Price)', () => {
  assert.equal(classify(['Code', 'Floor', 'Unit Type', 'In Door', 'Out Door', 'Price Per Meter', 'Final Price', 'Status']), 'availability');
});

test('classifySheet flags a Fact Sheet / summary table (Type, Quantity, Min/Max SQM, Min/Max Price) as summary, never as catalog or availability', () => {
  const kind = classify(['Type', 'Quantity', 'Min SQM', 'Max SQM', 'Min Unit Price', 'Max Unit Price']);
  assert.notEqual(kind, 'catalog');
  assert.notEqual(kind, 'availability');
});

test('classifySheet returns unknown for headers with no real overlap with either dictionary', () => {
  assert.equal(classify(['Notes', 'Generated On', 'Confidential']), 'unknown');
});

test('classifySheet never lets a stray field-name overlap alone claim a sheet without its anchor (Unit Type/Bedrooms alone, no Code and no Project/Developer)', () => {
  const kind = classify(['Unit Type', 'Bedrooms', 'Finishing']);
  assert.notEqual(kind, 'availability');
  assert.notEqual(kind, 'catalog');
});
