import PDFDocument from 'pdfkit';
import type { Project, Quotation, Unit } from '../../domain/types.js';
import type { QuotationCalculation } from './quotation.service.js';

const PAGE_MARGIN = 50;
const FETCH_TIMEOUT_MS = 8000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Already-fetched image bytes for an Offer PDF — kept separate from
 * buildOfferPdf() itself so the PDF layout is unit-testable without a
 * network call (see fetchOfferImages(), which is what actually resolves
 * Project/Unit image URLs into these buffers for the real route). */
export interface OfferPdfImages {
  projectImages?: Buffer[];
  masterPlanImage?: Buffer;
  floorPlanImage?: Buffer;
}

/** Only http(s) URLs are ever fetched (never file://, data:, etc — this
 * runs server-side against admin-supplied URLs, not user file uploads) and
 * only recognizably-sized, recognizably-typed responses are accepted; any
 * failure degrades to "skip this image" rather than failing the whole PDF
 * — a broken/slow image link must never block sending an otherwise-valid
 * Offer. */
async function fetchImageBuffer(url: string | undefined): Promise<Buffer | undefined> {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(parsed, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return undefined;
    const contentType = res.headers.get('content-type') ?? '';
    if (!/^image\/(png|jpe?g)/i.test(contentType)) return undefined;
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > MAX_IMAGE_BYTES) return undefined;
    return Buffer.from(arrayBuffer);
  } catch {
    return undefined; // network error, timeout, or abort — degrade gracefully
  }
}

/** Resolves every image URL an Offer PDF might use into real bytes,
 * tolerating any individual failure. Kept separate from buildOfferPdf so
 * the PDF-layout logic itself never depends on network access. `unit`/
 * `project` are optional — a manually-entered unit (spec section 2B) has
 * neither a real Unit row nor necessarily a linked Project, so there is
 * simply nothing to fetch; the PDF renders those sections as unavailable
 * rather than fabricating them (see buildOfferPdf). */
export async function fetchOfferImages(unit: Unit | undefined, project: Project | undefined): Promise<OfferPdfImages> {
  const projectImageUrls = (project?.imageUrls ?? []).slice(0, 4);
  const [projectImages, masterPlanImage, floorPlanImage] = await Promise.all([
    Promise.all(projectImageUrls.map(fetchImageBuffer)).then((imgs) => imgs.filter((b): b is Buffer => !!b)),
    fetchImageBuffer(project?.masterPlanImageUrl),
    fetchImageBuffer(unit?.floorPlanImageUrl),
  ]);
  return { projectImages, masterPlanImage, floorPlanImage };
}

function formatDelivery(delivery: Project['delivery'] | Unit['delivery']): string {
  if (!delivery) return '—';
  if (delivery.exactDate) return new Date(delivery.exactDate).toLocaleDateString();
  const parts = [delivery.quarter ? `Q${delivery.quarter}` : undefined, delivery.year ? String(delivery.year) : undefined].filter(Boolean);
  const dateLabel = parts.join(' ') || undefined;
  return [dateLabel, delivery.phaseLabel].filter(Boolean).join(' — ') || '—';
}

function drawHeading(doc: PDFKit.PDFDocument, text: string): void {
  doc.fontSize(18).fillColor('#111').text(text, { align: 'left' });
  doc.moveDown(0.5);
  doc
    .moveTo(doc.x, doc.y)
    .lineTo(doc.page.width - PAGE_MARGIN, doc.y)
    .strokeColor('#ddd')
    .stroke();
  doc.moveDown(0.75);
}

function drawKeyValueGrid(doc: PDFKit.PDFDocument, rows: Array<[string, string]>): void {
  const colWidth = (doc.page.width - PAGE_MARGIN * 2) / 2;
  const startX = doc.x;
  let x = startX;
  let rowTop = doc.y;
  rows.forEach(([label, value], i) => {
    doc.fontSize(9).fillColor('#666').text(label, x, rowTop, { width: colWidth - 16 });
    doc.fontSize(12).fillColor('#111').text(value, x, doc.y, { width: colWidth - 16 });
    if (i % 2 === 0) {
      x = startX + colWidth;
    } else {
      x = startX;
      rowTop = doc.y + 14;
    }
  });
  doc.x = startX;
  doc.y = rowTop + 20;
}

/** Fits an image into a max box (preserving aspect ratio), draws it at
 * (x, drawY), and returns the box it actually occupied — the master-plan
 * page needs this exact box to place the unit's highlight rectangle at the
 * right pixel position, which pdfkit's own `fit` option doesn't expose. */
function drawFittedImage(doc: PDFKit.PDFDocument, buf: Buffer, x: number, drawY: number, maxWidth: number, maxHeight: number): { x: number; y: number; width: number; height: number } {
  // openImage is a real pdfkit runtime method (used internally by
  // doc.image()) but is missing from @types/pdfkit's declarations.
  const img = (doc as unknown as { openImage(src: Buffer): { width: number; height: number } }).openImage(buf);
  const scale = Math.min(maxWidth / img.width, maxHeight / img.height, 1);
  const width = img.width * scale;
  const height = img.height * scale;
  doc.image(buf, x, drawY, { width, height });
  return { x, y: drawY, width, height };
}

/**
 * Builds the multi-page Offer PDF a real sales workflow sends over
 * WhatsApp: cover with project imagery, unit info, the payment schedule
 * (from the Offer's own immutable scheduleSnapshot — see
 * quotation.service.ts — never a live recompute), the project master plan
 * with this unit highlighted, and the unit's own floor plan. Any image
 * that couldn't be resolved (see fetchOfferImages) is simply skipped —
 * never a reason to fail generating the document.
 */
const PAYMENT_TYPE_LABELS: Record<string, string> = {
  down_payment: 'Down Payment',
  installment: 'Installment',
  scheduled_payment: 'Scheduled Payment',
  fee: 'Fee',
};

function paymentTypeLabel(kind: string | undefined, label: string): string {
  if (kind && PAYMENT_TYPE_LABELS[kind]) return PAYMENT_TYPE_LABELS[kind]!;
  return label; // pre-existing rows without `kind` — same text they always rendered
}

export async function buildOfferPdf(quotation: Quotation, calc: QuotationCalculation, unit: Unit | undefined, project: Project | undefined, images: OfferPdfImages = {}): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const snap = calc.unitSnapshot;

  // ---- Page 1: Cover ----
  doc.fontSize(24).fillColor('#111').text(project?.name ?? snap.code, { align: 'left' });
  if (project?.destination) doc.fontSize(12).fillColor('#666').text(project.destination);
  doc.moveDown(1);
  const contentWidth = doc.page.width - PAGE_MARGIN * 2;
  let coverY = doc.y;
  for (const imgBuf of images.projectImages ?? []) {
    if (coverY > doc.page.height - PAGE_MARGIN - 120) break; // stop before running off the page
    const box = drawFittedImage(doc, imgBuf, PAGE_MARGIN, coverY, contentWidth, 220);
    coverY = box.y + box.height + 12;
  }
  doc.y = coverY;
  doc.moveDown(1);
  doc.fontSize(10).fillColor('#999').text(`Offer Reference: ${quotation.referenceNumber} (v${quotation.version})`, PAGE_MARGIN, doc.page.height - PAGE_MARGIN - 20);

  // ---- Page 2: Unit info ----
  // Sourced from unitSnapshot (the frozen, point-in-time copy — see
  // QuotationUnitSnapshot's own comment), never re-read live from `unit`,
  // so this page renders the unit exactly as it was when the offer was
  // generated even if the real Unit/Project have since changed. `unit`/
  // `project` are only used above (images) and below (master plan
  // highlight) for data that isn't itself part of the frozen snapshot.
  doc.addPage();
  drawHeading(doc, 'Unit Information');
  const deliveryLabel = unit ? (unit.delivery ? formatDelivery(unit.delivery) : formatDelivery(project?.delivery)) : '—';
  const parkingLabel = snap.parkingIncluded === undefined
    ? '—'
    : snap.parkingIncluded
      ? `Included${snap.parkingSpaces ? ` (${snap.parkingSpaces})` : ''}`
      : `Not included${snap.parkingPrice ? ` (+${snap.parkingPrice.toLocaleString()})` : ''}`;
  drawKeyValueGrid(doc, [
    ['Unit Code', snap.code],
    ['Unit Type', snap.unitType],
    ['Area (sqm)', String(snap.areaSqm)],
    ['Building', snap.buildingLabel ?? '—'],
    ['Floor', snap.floorLabel ?? '—'],
    ['Bedrooms', snap.bedrooms != null ? String(snap.bedrooms) : '—'],
    ['View', (snap.view ?? []).join(', ') || '—'],
    ['Garden Area (sqm)', snap.gardenAreaSqm != null ? String(snap.gardenAreaSqm) : '—'],
    ['Finishing', snap.finishingType ?? '—'],
    ['Delivery', deliveryLabel],
    ['Price / Meter', snap.pricePerMeter.toLocaleString()],
    ['Maintenance Fee', snap.maintenanceFeePercent != null ? `${snap.maintenanceFeePercent}% (${(snap.maintenanceFeeAmount ?? 0).toLocaleString()})` : '—'],
    ['Parking', parkingLabel],
  ]);

  // ---- Page 3: Payment plan ----
  doc.addPage();
  drawHeading(doc, 'Payment Plan');
  const v = calc.validation;
  drawKeyValueGrid(doc, [
    ['Total Price', calc.totalPrice.toLocaleString()],
    ['Discount %', `${calc.discountPercent}%`],
    ['Net Value', calc.netValue.toLocaleString()],
    ['Down Payment', calc.downPayment.toLocaleString()],
    ['Total Payable', v.totalPayable.toLocaleString()],
    v.overpayment > 0
      ? ['Overpayment', v.overpayment.toLocaleString()]
      : ['Remaining Balance', v.remainingBalance.toLocaleString()],
  ]);
  doc.moveDown(0.5);
  const tableTop = doc.y;
  const colX = { seq: PAGE_MARGIN, type: PAGE_MARGIN + 24, label: PAGE_MARGIN + 130, date: PAGE_MARGIN + 300, amount: PAGE_MARGIN + 420 };
  doc.fontSize(9).fillColor('#666');
  doc.text('#', colX.seq, tableTop);
  doc.text('Type', colX.type, tableTop);
  doc.text('Label', colX.label, tableTop);
  doc.text('Due Date', colX.date, tableTop);
  doc.text('Amount', colX.amount, tableTop);
  doc
    .moveTo(PAGE_MARGIN, tableTop + 14)
    .lineTo(doc.page.width - PAGE_MARGIN, tableTop + 14)
    .strokeColor('#ddd')
    .stroke();
  let rowY = tableTop + 20;
  calc.schedule.forEach((line, index) => {
    if (rowY > doc.page.height - PAGE_MARGIN - 20) {
      doc.addPage();
      rowY = PAGE_MARGIN;
    }
    doc.fontSize(10).fillColor('#111');
    doc.text(String(index + 1), colX.seq, rowY);
    doc.text(paymentTypeLabel(line.kind, line.label), colX.type, rowY, { width: colX.label - colX.type - 10 });
    doc.text(line.label, colX.label, rowY, { width: colX.date - colX.label - 10 });
    doc.text(new Date(line.dueDate).toLocaleDateString(), colX.date, rowY);
    doc.text(line.amount.toLocaleString(), colX.amount, rowY);
    rowY += 18;
  });

  // ---- Page 4: Master plan with unit highlighted ----
  // Only rendered when both a master-plan image and a real Unit's
  // masterPlanPosition exist — a manually-entered unit has neither, so
  // this section is simply absent rather than showing a misleading or
  // fabricated location (spec section 29.9: never fabricate).
  if (images.masterPlanImage) {
    doc.addPage();
    drawHeading(doc, 'Master Plan');
    const box = drawFittedImage(doc, images.masterPlanImage, PAGE_MARGIN, doc.y, contentWidth, doc.page.height - doc.y - PAGE_MARGIN);
    const pos = unit?.masterPlanPosition;
    if (pos) {
      const rectX = box.x + (pos.x / 100) * box.width;
      const rectY = box.y + (pos.y / 100) * box.height;
      const rectW = (pos.width / 100) * box.width;
      const rectH = (pos.height / 100) * box.height;
      doc.save();
      doc.lineWidth(2.5).strokeColor('#e11d48').rect(rectX, rectY, rectW, rectH).stroke();
      doc.restore();
    }
  }

  // ---- Page 5: Unit floor plan ----
  if (images.floorPlanImage) {
    doc.addPage();
    drawHeading(doc, `Unit ${snap.code} — Floor Plan`);
    drawFittedImage(doc, images.floorPlanImage, PAGE_MARGIN, doc.y, contentWidth, doc.page.height - doc.y - PAGE_MARGIN);
  }

  doc.end();
  return done;
}
