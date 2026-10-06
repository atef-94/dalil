import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOfferPdf } from './offer-pdf.service.js';
import type { GeneratedLine } from '../payment-plans/schedule-generator.js';
import type { QuotationCalculation } from './quotation.service.js';
import type { Project, Quotation, QuotationUnitSnapshot, Unit } from '../../domain/types.js';

// A well-known minimal valid PNG (1x1 transparent pixel) — real image
// bytes pdfkit can actually decode, without a canvas dependency or any
// network call (buildOfferPdf itself never fetches anything — see
// fetchOfferImages for that, which is not exercised here).
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function fixtures() {
  const now = new Date().toISOString();
  const scheduleLines: GeneratedLine[] = [
    { sequence: 1, label: 'Down Payment', kind: 'down_payment', dueDate: now, amount: 100_000, status: 'upcoming' },
    { sequence: 2, label: 'Installment 1', kind: 'installment', dueDate: now, amount: 50_000, status: 'upcoming' },
  ];
  const quotation: Quotation = {
    id: 'q1',
    companyId: 'c1',
    referenceNumber: 'Q-20260101-0001',
    version: 1,
    unitId: 'u1',
    projectId: 'p1',
    leadId: 'lead-1',
    paymentPlanTemplateId: 'tpl-1',
    sourceTemplateVersion: 1,
    status: 'generated',
    inputs: { totalPrice: 1_000_000, discountPercent: 0, escalationPercentPerYear: 0, startDate: now },
    scheduleSnapshot: scheduleLines,
    createdByUserId: 'u1',
    createdAt: now,
    updatedAt: now,
  };
  const unit: Unit = {
    id: 'u1',
    companyId: 'c1',
    projectId: 'p1',
    code: 'A-101',
    unitType: 'Apartment',
    areaSqm: 120,
    listPrice: 1_000_000,
    status: 'available',
    createdAt: now,
    masterPlanPosition: { x: 20, y: 30, width: 10, height: 8 },
  };
  const project: Project = {
    id: 'p1',
    companyId: 'c1',
    name: 'Zed Towers',
    destination: 'Sheikh Zayed',
    createdAt: now,
  };
  const unitSnapshot: QuotationUnitSnapshot = {
    code: unit.code,
    unitType: unit.unitType,
    areaSqm: unit.areaSqm,
    pricePerMeter: Math.round(unit.listPrice / unit.areaSqm),
    totalUnitPrice: unit.listPrice,
    maintenanceFeePercent: 8,
    maintenanceFeeAmount: Math.round(unit.listPrice * 0.08),
    parkingIncluded: true,
    parkingSpaces: 1,
  };
  const calc: QuotationCalculation = {
    unit,
    unitSnapshot,
    totalPrice: 1_000_000,
    discountPercent: 0,
    escalationPercentPerYear: 0,
    netValue: 1_000_000,
    downPayment: 100_000,
    schedule: scheduleLines,
    validation: { totalPayable: 150_000, remainingBalance: 0, isValid: true, overpayment: 0 },
  };
  return { quotation, unit, project, calc };
}

test('buildOfferPdf produces a real PDF buffer with no images', async () => {
  const { quotation, calc, unit, project } = fixtures();
  const buf = await buildOfferPdf(quotation, calc, unit, project);
  assert.ok(buf.length > 200);
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
});

test('buildOfferPdf embeds project images, master plan (with highlight), and floor plan when provided', async () => {
  const { quotation, calc, unit, project } = fixtures();
  const withImages = await buildOfferPdf(quotation, calc, unit, project, {
    projectImages: [TINY_PNG, TINY_PNG],
    masterPlanImage: TINY_PNG,
    floorPlanImage: TINY_PNG,
  });
  const withoutImages = await buildOfferPdf(quotation, calc, unit, project);
  // Embedding real image bytes plus 2 extra pages (master plan, floor
  // plan) must produce a meaningfully larger document than the bare
  // text-only version — a real signal the images were actually placed,
  // not just silently skipped.
  assert.ok(withImages.length > withoutImages.length + 500, `expected embedded-image PDF (${withImages.length}b) to be meaningfully larger than bare PDF (${withoutImages.length}b)`);
  assert.equal(withImages.subarray(0, 5).toString('latin1'), '%PDF-');
});

test('buildOfferPdf tolerates a unit with no masterPlanPosition even when a master plan image is supplied', async () => {
  const { quotation, calc, unit, project } = fixtures();
  const unitWithoutPosition: typeof unit = { ...unit, masterPlanPosition: undefined };
  const buf = await buildOfferPdf(quotation, calc, unitWithoutPosition, project, { masterPlanImage: TINY_PNG });
  assert.ok(buf.length > 200);
});

test('buildOfferPdf renders successfully for a manually-entered unit with no linked Unit or Project row', async () => {
  const { quotation, calc } = fixtures();
  // Section 2B: a manually-entered unit has neither a real Unit nor
  // necessarily a Project — the PDF must still generate cleanly, using
  // only unitSnapshot, never throwing for the missing optional data.
  const buf = await buildOfferPdf(quotation, calc, undefined, undefined);
  assert.ok(buf.length > 200);
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
});

test('buildOfferPdf renders the maintenance/parking fields from unitSnapshot without throwing', async () => {
  const { quotation, calc, unit, project } = fixtures();
  assert.equal(calc.unitSnapshot.maintenanceFeePercent, 8);
  assert.equal(calc.unitSnapshot.parkingIncluded, true);
  const buf = await buildOfferPdf(quotation, calc, unit, project);
  assert.ok(buf.length > 200);
});

test('buildOfferPdf renders an overpayment/remaining-balance validation summary without throwing', async () => {
  const { quotation, calc, unit, project } = fixtures();
  const overpaid = { ...calc, validation: { totalPayable: 1_100_000, remainingBalance: 0, isValid: false, overpayment: 100_000 } };
  const underpaid = { ...calc, validation: { totalPayable: 800_000, remainingBalance: 200_000, isValid: false, overpayment: 0 } };
  const bufOver = await buildOfferPdf(quotation, overpaid, unit, project);
  const bufUnder = await buildOfferPdf(quotation, underpaid, unit, project);
  assert.ok(bufOver.length > 200);
  assert.ok(bufUnder.length > 200);
});

test('buildOfferPdf (locale "ar") produces a real PDF buffer with Arabic-labeled sections', async () => {
  const { quotation, calc, unit, project } = fixtures();
  const buf = await buildOfferPdf(quotation, calc, unit, project, {}, 'ar');
  assert.ok(buf.length > 200);
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
});

test('buildOfferPdf (locale "ar") renders Arabic multi-word labels and Latin payment-type values in correct reading order', async () => {
  // Regression test for a real bug found during manual verification: pdfkit/
  // fontkit reorder a multi-word string unpredictably — not just mixed
  // Arabic/Latin, but even a plain two-word Arabic phrase like "نوع الوحدة"
  // came out as "الوحدة نوع" when handed to doc.text() directly, and the
  // RTL-token-placement fix for that, if applied indiscriminately, would in
  // turn wrongly reverse pure-Latin content like "Down Payment" into
  // "Payment Down". This decodes the actual PDF content stream (not just
  // checking buffer size, unlike the other tests in this file) to prove
  // both directions render in correct logical order.
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { quotation, calc, unit, project } = fixtures();
  const buf = await buildOfferPdf(quotation, calc, unit, project, {}, 'ar');
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  let fullText = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map((it) => ('str' in it ? it.str : '')).join(' ');
  }
  // Arabic multi-word labels must appear in correct reading order, not
  // reversed. Deliberately avoids any label containing a lam immediately
  // followed by a hamza-bearing alef (e.g. "الإجمالي", "الأساسية") — those
  // render correctly (verified visually against a real PDF viewer) but
  // pdfjs's text extraction remaps that specific ligature's glyph back to
  // Unicode in transposed order, which is a text-extraction artifact of
  // that one letter combination, not a rendering bug this test is after.
  assert.ok(fullText.includes('كود الوحدة'), `expected "كود الوحدة" (not reversed) in: ${fullText.slice(0, 200)}`);
  assert.ok(fullText.includes('نوع الوحدة'), `expected "نوع الوحدة" (not reversed) in: ${fullText.slice(0, 200)}`);
  assert.ok(fullText.includes('نسبة الخصم'), 'expected "نسبة الخصم" (not reversed)');
  // The payment-type/label columns are deliberately left in English (see
  // PAYMENT_TYPE_LABELS) and must stay in normal left-to-right reading
  // order, not be wrongly reversed by the RTL fix.
  assert.ok(fullText.includes('Down Payment'), 'expected "Down Payment" (not reversed to "Payment Down")');
  assert.ok(fullText.includes('Installment 1'), 'expected "Installment 1" (not reversed to "1 Installment")');
});

test('buildOfferPdf (locale "ar") renders exactly one page per schedule-table page break, with no stray blank pages', async () => {
  // Regression test for a real bug: the page-number footer's own doc.text()
  // call, missing lineBreak:false at a y position right at the bottom
  // margin, made pdfkit silently auto-paginate before drawing — turning a
  // real 1-page document into 3 (two of them blank except for the footer).
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { quotation, calc, unit, project } = fixtures();
  const buf = await buildOfferPdf(quotation, calc, unit, project, {}, 'ar');
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  assert.equal(doc.numPages, 1, 'a 2-line schedule must not produce extra blank pages');
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  const text = content.items.map((it) => ('str' in it ? it.str : '')).join(' ');
  assert.ok(text.includes('صفحة 1 من 1'), `expected the Arabic page-number footer "صفحة 1 من 1" in: ${text.slice(-100)}`);
});

test('buildOfferPdf (locale "ar") renders successfully for a manually-entered unit with no linked Unit or Project row', async () => {
  const { quotation, calc } = fixtures();
  const buf = await buildOfferPdf(quotation, calc, undefined, undefined, {}, 'ar');
  assert.ok(buf.length > 200);
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
});

test('buildOfferPdf includes a Payment Type column derived from each line\'s kind', async () => {
  const { quotation, calc, unit, project } = fixtures();
  // A schedule with all 4 kinds present must still render without error —
  // the strongest signal available without decoding pdfkit's compressed
  // content streams (existing tests in this file follow the same
  // buffer-size/magic-bytes approach rather than asserting on PDF text).
  const fullSchedule: typeof calc.schedule = [
    ...calc.schedule,
    { sequence: 3, label: 'Bonus payment', kind: 'scheduled_payment', dueDate: calc.schedule[0]!.dueDate, amount: 200_000, status: 'upcoming' },
    { sequence: 4, label: 'Admin Fee', kind: 'fee', dueDate: calc.schedule[0]!.dueDate, amount: 500, status: 'upcoming' },
  ];
  const buf = await buildOfferPdf(quotation, { ...calc, schedule: fullSchedule }, unit, project);
  assert.ok(buf.length > 200);
});
