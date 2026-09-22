import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { InventoryImportService } from '../inventory/inventory-import.service.js';
import { DocumentIntelligenceService } from './document-intelligence.service.js';
import type { DocumentExtractedField, DocumentExtractionRun, Project, Reservation, Unit, UnitHold } from '../../domain/types.js';

/** Same minimal hand-built PDF technique as pdf-parser.test.ts — no PDF-
 * authoring dependency exists in this project, so tests construct real PDF
 * bytes directly. */
function buildPdf(lines: { text: string; x: number; y: number }[]): Buffer {
  const escape = (s: string) => s.replace(/[()\\]/g, (m) => '\\' + m);
  const content = lines.map((l) => `BT /F1 10 Tf ${l.x} ${l.y} Td (${escape(l.text)}) Tj ET`).join('\n');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>\nendobj',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj',
    `5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj + '\n';
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

function freshHarness() {
  const projects = new InMemoryRepository<Project>();
  const units = new InMemoryRepository<Unit>();
  const holds = new InMemoryRepository<UnitHold>();
  const reservations = new InMemoryRepository<Reservation>();
  const inventory = new InventoryService(units, holds, reservations, projects);
  const inventoryImport = new InventoryImportService(inventory);
  const runs = new InMemoryRepository<DocumentExtractionRun>();
  const fields = new InMemoryRepository<DocumentExtractedField>();
  const svc = new DocumentIntelligenceService(runs, fields, inventoryImport);
  return { svc, inventory, runs, fields };
}

const FULL_SPEC_SHEET = buildPdf([
  { text: 'Project: Marassi Heights', x: 50, y: 760 },
  { text: 'Unit No: A-104', x: 50, y: 740 },
  { text: 'Unit Type: Apartment', x: 50, y: 720 },
  { text: 'Building: B3', x: 50, y: 700 },
  { text: 'Floor: 4', x: 50, y: 680 },
  { text: 'Area: 145', x: 50, y: 660 },
  { text: 'Price: 4250000', x: 50, y: 640 },
  { text: 'Delivery Date: 2027-06-01', x: 50, y: 620 },
  { text: 'Finishing: Fully Finished', x: 50, y: 600 },
  { text: 'Customer Name: Nour Hassan', x: 50, y: 580 },
  { text: 'Customer Phone: 01099998888', x: 50, y: 560 },
  { text: 'Broker: Amr Real Estate', x: 50, y: 540 },
]);

test('classify() identifies a text-bearing PDF vs a scanned/image one', () => {
  const h = freshHarness();
  assert.equal(h.svc.classify('spec.pdf', true), 'pdf_text');
  assert.equal(h.svc.classify('scan.pdf', false), 'pdf_scanned');
  assert.equal(h.svc.classify('photo.jpg', undefined), 'image');
  assert.equal(h.svc.classify('deed.docx', undefined), 'unsupported');
});

test('extractFromPdf on a scanned (no-text-layer) PDF is blocked with a real, honest reason — never fabricated OCR', async () => {
  const h = freshHarness();
  const blankPdf = buildPdf([]);
  const { run, fields } = await h.svc.extractFromPdf('c1', 'u1', 'scan.pdf', blankPdf);
  assert.equal(run.status, 'blocked');
  assert.equal(run.documentKind, 'pdf_scanned');
  assert.match(run.blockedReason ?? '', /OCR is not available/);
  assert.equal(fields.length, 0);
});

test('extractFromPdf on a real text-bearing spec sheet extracts labeled fields with high confidence', async () => {
  const h = freshHarness();
  const { run, fields } = await h.svc.extractFromPdf('c1', 'u1', 'spec.pdf', FULL_SPEC_SHEET);
  assert.equal(run.status, 'extracted');
  const byKey = new Map(fields.map((f) => [f.fieldKey, f]));
  assert.equal(byKey.get('projectName')?.rawValue, 'Marassi Heights');
  assert.equal(byKey.get('projectName')?.confidence, 'high');
  assert.equal(byKey.get('unitCode')?.rawValue, 'A-104');
  assert.equal(byKey.get('areaSqm')?.rawValue, '145');
  assert.equal(byKey.get('areaSqm')?.confidence, 'high');
  assert.equal(byKey.get('listPrice')?.rawValue, '4250000');
  assert.equal(byKey.get('customerPhone')?.rawValue, '01099998888');
  assert.equal(byKey.get('brokerName')?.rawValue, 'Amr Real Estate');
});

test('extractFromPdf never invents a value for a field with no match in the document', async () => {
  const h = freshHarness();
  const sparse = buildPdf([{ text: 'Project: Only This Field', x: 50, y: 700 }]);
  const { fields } = await h.svc.extractFromPdf('c1', 'u1', 'sparse.pdf', sparse);
  assert.equal(fields.length, 1);
  assert.equal(fields[0]!.fieldKey, 'projectName');
});

test('confirmExtraction imports a real Unit via InventoryImportService when all required fields are present', async () => {
  const h = freshHarness();
  const { run } = await h.svc.extractFromPdf('c1', 'u1', 'spec.pdf', FULL_SPEC_SHEET);
  let writtenUnitId: string | undefined;
  const result = await h.svc.confirmExtraction(run.id, 'c1', 'u1', async (unit) => {
    writtenUnitId = unit.id;
  }, { autoCreateMissingProjects: true });
  assert.equal(result.succeeded, 1);
  assert.ok(writtenUnitId);
  const updatedRun = await h.runs.findById(run.id);
  assert.equal(updatedRun?.status, 'imported');
  assert.equal(updatedRun?.importedUnitId, writtenUnitId);

  const unit = await h.inventory.getUnit(writtenUnitId!);
  assert.equal(unit?.areaSqm, 145);
  assert.equal(unit?.listPrice, 4250000);
});

test('confirmExtraction refuses when a required field is missing, without touching inventory', async () => {
  const h = freshHarness();
  const partial = buildPdf([{ text: 'Project: Missing Fields', x: 50, y: 700 }]);
  const { run } = await h.svc.extractFromPdf('c1', 'u1', 'partial.pdf', partial);
  await assert.rejects(() => h.svc.confirmExtraction(run.id, 'c1', 'u1', async () => {}), /required field\(s\) missing/);
  const updatedRun = await h.runs.findById(run.id);
  assert.equal(updatedRun?.status, 'extracted');
});

test('correctField lets a human override a value, and confirmExtraction then uses the correction', async () => {
  const h = freshHarness();
  const sheet = buildPdf([
    { text: 'Project: Correctable Co', x: 50, y: 760 },
    { text: 'Unit No: X-1', x: 50, y: 740 },
    { text: 'Unit Type: Villa', x: 50, y: 720 },
    { text: 'Area: notanumber', x: 50, y: 700 },
    { text: 'Price: 1000000', x: 50, y: 680 },
  ]);
  const { run, fields } = await h.svc.extractFromPdf('c1', 'u1', 'sheet.pdf', sheet);
  const areaField = fields.find((f) => f.fieldKey === 'areaSqm')!;
  assert.equal(areaField.confidence, 'medium'); // matched inline but didn't parse as a number

  // Without a correction, "medium" confidence is still usable (only 'low'
  // requires an explicit correction) — but the raw value is not numeric,
  // so InventoryImportService itself skips the row as invalid rather than
  // this service throwing.
  const uncorrected = await h.svc.confirmExtraction(run.id, 'c1', 'u1', async () => {}, { autoCreateMissingProjects: true });
  assert.equal(uncorrected.succeeded, 0);
  assert.equal((await h.runs.findById(run.id))?.status, 'extracted');

  await h.svc.correctField(areaField.id, 'c1', '210');
  const result = await h.svc.confirmExtraction(run.id, 'c1', 'u1', async () => {}, { autoCreateMissingProjects: true });
  assert.equal(result.succeeded, 1);
});

test('markReviewed and rejectExtraction record who acted and when', async () => {
  const h = freshHarness();
  const { run } = await h.svc.extractFromPdf('c1', 'u1', 'spec.pdf', FULL_SPEC_SHEET);
  const reviewed = await h.svc.markReviewed(run.id, 'c1', 'reviewer-1');
  assert.equal(reviewed.status, 'reviewed');
  assert.equal(reviewed.reviewedByUserId, 'reviewer-1');
  assert.ok(reviewed.reviewedAt);

  const { run: run2 } = await h.svc.extractFromPdf('c1', 'u1', 'spec2.pdf', FULL_SPEC_SHEET);
  const rejected = await h.svc.rejectExtraction(run2.id, 'c1', 'reviewer-2');
  assert.equal(rejected.status, 'rejected');
});

test('a company cannot read or act on another company\'s extraction run (tenant isolation)', async () => {
  const h = freshHarness();
  const { run } = await h.svc.extractFromPdf('c1', 'u1', 'spec.pdf', FULL_SPEC_SHEET);
  await assert.rejects(() => h.svc.getRun(run.id, 'c2'));
  await assert.rejects(() => h.svc.markReviewed(run.id, 'c2', 'x'));
  await assert.rejects(() => h.svc.confirmExtraction(run.id, 'c2', 'x', async () => {}));
});

test('confirmExtraction cannot be run twice on the same extraction run', async () => {
  const h = freshHarness();
  const { run } = await h.svc.extractFromPdf('c1', 'u1', 'spec.pdf', FULL_SPEC_SHEET);
  await h.svc.confirmExtraction(run.id, 'c1', 'u1', async () => {}, { autoCreateMissingProjects: true });
  await assert.rejects(() => h.svc.confirmExtraction(run.id, 'c1', 'u1', async () => {}, { autoCreateMissingProjects: true }), /already been imported/);
});
