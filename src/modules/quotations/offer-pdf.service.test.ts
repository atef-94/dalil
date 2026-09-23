import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOfferPdf } from './offer-pdf.service.js';
import type { QuotationCalculation } from './quotation.service.js';
import type { Project, Quotation, Unit } from '../../domain/types.js';

// A well-known minimal valid PNG (1x1 transparent pixel) — real image
// bytes pdfkit can actually decode, without a canvas dependency or any
// network call (buildOfferPdf itself never fetches anything — see
// fetchOfferImages for that, which is not exercised here).
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function fixtures() {
  const now = new Date().toISOString();
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
    scheduleSnapshot: [
      { sequence: 1, label: 'Down Payment', dueDate: now, amount: 100_000, status: 'upcoming' },
      { sequence: 2, label: 'Installment 1', dueDate: now, amount: 50_000, status: 'upcoming' },
    ],
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
  const calc: QuotationCalculation = {
    unit,
    totalPrice: 1_000_000,
    discountPercent: 0,
    escalationPercentPerYear: 0,
    netValue: 1_000_000,
    downPayment: 100_000,
    schedule: quotation.scheduleSnapshot,
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
