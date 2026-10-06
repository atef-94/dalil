import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Project, Quotation, QuotationStatus, Unit } from '../../domain/types.js';
import type { QuotationCalculation } from './quotation.service.js';

const PAGE_MARGIN = 50;
const FETCH_TIMEOUT_MS = 8000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/modules/quotations/offer-pdf.service.ts (or the compiled
// dist/modules/quotations/offer-pdf.service.js) is two directories below
// the repo root, which is also where public/ lives (see main.ts's own
// `join(__dirname, '..', 'public')` from one level up) — three '..' gets
// from here to the repo root in both the dev (tsx, src/) and prod
// (compiled, dist/) layouts, since neither moves this file's relative
// depth. Only loaded when a PDF actually needs Arabic text (see
// registerArabicFonts), never for the existing English-only path.
const CAIRO_REGULAR_PATH = join(__dirname, '..', '..', '..', 'public', 'fonts', 'Cairo-Regular.ttf');
const CAIRO_BOLD_PATH = join(__dirname, '..', '..', '..', 'public', 'fonts', 'Cairo-Bold.ttf');

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
  doc.fontSize(16).fillColor('#111').text(text, { align: 'left' });
  doc.moveDown(0.3);
  doc
    .moveTo(doc.x, doc.y)
    .lineTo(doc.page.width - PAGE_MARGIN, doc.y)
    .strokeColor('#ddd')
    .stroke();
  doc.moveDown(0.5);
}

function drawKeyValueGrid(doc: PDFKit.PDFDocument, rows: Array<[string, string]>): void {
  const colWidth = (doc.page.width - PAGE_MARGIN * 2) / 2;
  const startX = doc.x;
  let x = startX;
  let rowTop = doc.y;
  rows.forEach(([label, value], i) => {
    // Rows are drawn at explicit x/y, which (unlike flowing text) pdfkit
    // never auto-paginates — so a tall grid must check for itself, the
    // same way the schedule table below does, or its later rows simply
    // render past the bottom of the page.
    if (i % 2 === 0 && rowTop > doc.page.height - PAGE_MARGIN - 34) {
      doc.addPage();
      rowTop = PAGE_MARGIN;
    }
    doc.fontSize(9).fillColor('#666').text(label, x, rowTop, { width: colWidth - 16 });
    doc.fontSize(12).fillColor('#111').text(value, x, doc.y, { width: colWidth - 16 });
    if (i % 2 === 0) {
      x = startX + colWidth;
    } else {
      x = startX;
      rowTop = doc.y + 8;
    }
  });
  doc.x = startX;
  doc.y = rowTop + 12;
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

// ---- Arabic (RTL) rendering ----
// pdfkit/fontkit shape Arabic glyphs correctly within a single contiguous
// script run (confirmed by rendering a round-trip through a real PDF
// viewer), but they do NOT implement the full Unicode Bidi Algorithm
// (UAX#9) for a string that mixes Arabic and Latin/digit runs — e.g.
// "مشروع Stayn - وحدة رقم G1-04" came out with the runs in the wrong
// relative order when handed to doc.text() as one string. Rather than
// pull in a full bidi/reshaping pipeline, every string THIS module
// constructs for the Arabic layout is either pure-Arabic (so a plain
// doc.text() call shapes correctly on its own) or built from explicitly
// positioned segments via drawRtlLine() below, which places each segment
// at a manually computed x position — sidestepping pdfkit's bidi gap
// entirely instead of fighting it. Raw data values (unit codes, imported
// type strings) are rendered as-is and may rarely still mix scripts
// within themselves; that residual case isn't solved here.
const arabicFontsRegistered: WeakSet<PDFKit.PDFDocument> = new WeakSet();
function registerArabicFonts(doc: PDFKit.PDFDocument): void {
  if (arabicFontsRegistered.has(doc)) return;
  doc.registerFont('Cairo', CAIRO_REGULAR_PATH);
  doc.registerFont('Cairo-Bold', CAIRO_BOLD_PATH);
  arabicFontsRegistered.add(doc);
}

const QUOTATION_STATUS_LABELS_AR: Record<QuotationStatus, string> = {
  draft: 'مسودة',
  generated: 'نشط',
  sent: 'تم الإرسال',
  accepted: 'مقبول',
  expired: 'منتهي',
  cancelled: 'ملغي',
};

interface RtlSegment {
  text: string;
  bold?: boolean;
  size?: number;
  color?: string;
}

// U+0600–06FF covers Arabic; a string with none of these codepoints is
// pure Latin/digits and never hits pdfkit's multi-token reordering bug
// (see drawRtlWords below) — it's handled with a single, ordinary
// doc.text() call, same as the rest of this codebase already does
// everywhere else, rather than being forced through RTL token placement
// that would wrongly reverse e.g. "Down Payment" to "Payment Down".
const ARABIC_CHAR_RE = /[؀-ۿ]/;

/** Measures the width `drawRtlWords` would need for `text` at the given
 * font/size — the sum of each whitespace-separated token's width plus the
 * fixed inter-token gap, matching exactly what drawRtlWords lays out. */
function measureRtlWords(doc: PDFKit.PDFDocument, text: string, bold: boolean, size: number): number {
  doc.font(bold ? 'Cairo-Bold' : 'Cairo').fontSize(size);
  const tokens = text.split(' ').filter(Boolean);
  let total = 0;
  tokens.forEach((tok, i) => {
    total += doc.widthOfString(tok);
    if (i < tokens.length - 1) total += 4;
  });
  return total;
}

/** The one true text-drawing primitive for the whole Arabic layout. pdfkit/
 * fontkit shape a SINGLE Arabic word's glyphs correctly (confirmed by
 * rendering through a real PDF viewer), but reorders multi-word strings
 * unpredictably — not just mixed Arabic/Latin content, but even a plain
 * two-word Arabic phrase like "نوع الوحدة" comes out as "الوحدة نوع"
 * regardless of alignment, explicit width, or x/y positioning. Splitting
 * on whitespace and placing each token at an explicitly computed x
 * (instead of ever handing pdfkit a multi-token string) sidesteps that bug
 * entirely rather than fighting it: pdfkit never gets the chance to
 * reorder what it never sees as more than one token at a time. Only
 * called for text containing Arabic (see containsArabic) — pure-Latin
 * text skips this path entirely (see drawRtlWordsCentered). */
function drawRtlWords(doc: PDFKit.PDFDocument, text: string, rightX: number, y: number, opts: { bold?: boolean; size?: number; color?: string } = {}): void {
  doc.font(opts.bold ? 'Cairo-Bold' : 'Cairo').fontSize(opts.size ?? 10.5).fillColor(opts.color ?? '#111');
  const tokens = text.split(' ').filter(Boolean);
  let cursorX = rightX;
  for (const tok of tokens) {
    const w = doc.widthOfString(tok);
    cursorX -= w;
    doc.text(tok, cursorX, y, { lineBreak: false });
    cursorX -= 4;
  }
}

/** Centers `text` within [cellX, cellX + cellWidth] at the given y.
 * Arabic-containing text goes through the word-by-word RTL placement
 * above; pure-Latin/digit text (payment type/label columns, dates,
 * amounts — never translated, see PAYMENT_TYPE_LABELS) is centered with
 * an ordinary single doc.text() call, which pdfkit already gets right on
 * its own and which the RTL token placement would otherwise wrongly
 * reverse (e.g. "Installment 1" → "1 Installment"). */
function drawRtlWordsCentered(doc: PDFKit.PDFDocument, text: string, cellX: number, y: number, cellWidth: number, opts: { bold?: boolean; size?: number; color?: string } = {}): void {
  if (!ARABIC_CHAR_RE.test(text)) {
    doc.font(opts.bold ? 'Cairo-Bold' : 'Cairo').fontSize(opts.size ?? 10.5).fillColor(opts.color ?? '#111');
    doc.text(text, cellX, y, { width: cellWidth, align: 'center', lineBreak: false });
    return;
  }
  const total = measureRtlWords(doc, text, !!opts.bold, opts.size ?? 10.5);
  const rightX = cellX + (cellWidth + total) / 2;
  drawRtlWords(doc, text, rightX, y, opts);
}

/** Draws `segments` right-to-left starting at `rightX`, in LOGICAL
 * (reading) order — segments[0] is read first and lands rightmost. Each
 * segment's own text is placed token-by-token via drawRtlWords, so neither
 * the segments relative to each other nor the words within a segment ever
 * go through pdfkit's unreliable multi-token layout. */
function drawRtlLine(doc: PDFKit.PDFDocument, segments: RtlSegment[], rightX: number, y: number): void {
  let cursorX = rightX;
  for (const seg of segments) {
    const bold = !!seg.bold;
    const size = seg.size ?? 11;
    if (ARABIC_CHAR_RE.test(seg.text)) {
      const w = measureRtlWords(doc, seg.text, bold, size);
      drawRtlWords(doc, seg.text, cursorX, y, { bold, size, color: seg.color });
      cursorX -= w + 5;
    } else {
      // A data value (project name, unit code) with no Arabic in it — a
      // plain multi-word Latin segment (e.g. "Zed Towers") would be wrongly
      // word-reversed by the RTL token placement above, so it gets an
      // ordinary single doc.text() call instead, same as drawRtlWordsCentered.
      doc.font(bold ? 'Cairo-Bold' : 'Cairo').fontSize(size).fillColor(seg.color ?? '#111');
      const w = doc.widthOfString(seg.text);
      cursorX -= w;
      doc.text(seg.text, cursorX, y, { lineBreak: false });
      cursorX -= 5;
    }
  }
}

/** A right-aligned section heading with a short blue accent bar at the
 * right margin (mirrors drawHeading() above for RTL) followed by a
 * full-width divider rule. */
function drawArabicHeading(doc: PDFKit.PDFDocument, text: string): void {
  const rightX = doc.page.width - PAGE_MARGIN;
  const barWidth = 3;
  const barHeight = 15;
  doc.save().rect(rightX - barWidth, doc.y + 1, barWidth, barHeight).fill('#2563eb').restore();
  drawRtlWords(doc, text, rightX - barWidth - 8, doc.y + 2, { bold: true, size: 13 });
  doc.moveDown(1.1);
  doc.moveTo(PAGE_MARGIN, doc.y).lineTo(rightX, doc.y).strokeColor('#ddd').stroke();
  doc.moveDown(0.5);
}

/** A bordered "label row, then value row" grid, 3 fields per row,
 * right-to-left column order — matches the reference Arabic Offer design
 * (label cells shaded, value cells white, both bordered). A short trailing
 * group (fewer than 3 fields) only draws the cells it actually has, same
 * as the reference leaving the rest of that row blank. */
function drawArabicInfoTable(doc: PDFKit.PDFDocument, fields: Array<{ label: string; value: string }>): void {
  const pageRight = doc.page.width - PAGE_MARGIN;
  const colWidth = (pageRight - PAGE_MARGIN) / 3;
  const labelRowHeight = 20;
  const valueRowHeight = 24;

  for (let i = 0; i < fields.length; i += 3) {
    const group = fields.slice(i, i + 3);
    if (doc.y + labelRowHeight + valueRowHeight > doc.page.height - PAGE_MARGIN) {
      doc.addPage();
      doc.y = PAGE_MARGIN;
    }
    const labelRowTop = doc.y;
    const valueRowTop = labelRowTop + labelRowHeight;
    group.forEach((field, c) => {
      const colLeftX = pageRight - (c + 1) * colWidth;
      doc.rect(colLeftX, labelRowTop, colWidth, labelRowHeight).fillAndStroke('#eef2f9', '#d0d7e2');
      drawRtlWordsCentered(doc, field.label, colLeftX + 3, labelRowTop + 5, colWidth - 6, { bold: true, size: 8.5, color: '#44546a' });
      doc.rect(colLeftX, valueRowTop, colWidth, valueRowHeight).strokeColor('#d0d7e2').stroke();
      drawRtlWordsCentered(doc, field.value, colLeftX + 3, valueRowTop + 6, colWidth - 6, { size: 10.5 });
    });
    doc.y = valueRowTop + valueRowHeight;
  }
  doc.y += 10;
}

const AR_SCHEDULE_COLS = [
  { key: 'seq', label: 'م', width: 0.08 },
  { key: 'type', label: 'النوع', width: 0.2 },
  { key: 'label', label: 'البيان (Label)', width: 0.24 },
  { key: 'date', label: 'تاريخ الاستحقاق', width: 0.24 },
  { key: 'amount', label: 'المبلغ (جنيه)', width: 0.24 },
] as const;

/** Draws the "جدول الأقساط" column-header row (navy background, white
 * bold text, right-to-left column order) at the current doc.y and
 * advances past it — used both for the table's first header and to
 * re-draw it at the top of every page the table continues onto, matching
 * the reference design. */
function drawArabicScheduleHeaderRow(doc: PDFKit.PDFDocument): number {
  const pageRight = doc.page.width - PAGE_MARGIN;
  const totalWidth = pageRight - PAGE_MARGIN;
  const rowHeight = 22;
  const rowTop = doc.y;
  let colRight = pageRight;
  doc.rect(PAGE_MARGIN, rowTop, totalWidth, rowHeight).fill('#1e3a5f');
  for (const col of AR_SCHEDULE_COLS) {
    const w = totalWidth * col.width;
    drawRtlWordsCentered(doc, col.label, colRight - w, rowTop + 6, w, { bold: true, size: 9, color: '#fff' });
    colRight -= w;
  }
  doc.y = rowTop + rowHeight;
  return doc.y;
}

/** The full "جدول الأقساط" table: header row + alternating-stripe,
 * bordered data rows, each line translated to the raw type/label/date/
 * amount text (same payment-type mapping and values as the English
 * layout — only the surrounding Arabic chrome differs). Repeats the
 * header row at the top of any continuation page. */
function drawArabicScheduleTable(doc: PDFKit.PDFDocument, schedule: QuotationCalculation['schedule']): void {
  const pageRight = doc.page.width - PAGE_MARGIN;
  const totalWidth = pageRight - PAGE_MARGIN;
  const rowHeight = 22;
  drawArabicScheduleHeaderRow(doc);

  schedule.forEach((line, index) => {
    if (doc.y + rowHeight > doc.page.height - PAGE_MARGIN) {
      doc.addPage();
      doc.y = PAGE_MARGIN;
      drawArabicScheduleHeaderRow(doc);
    }
    const rowTop = doc.y;
    const stripe = index % 2 === 1 ? '#f5f7fa' : '#ffffff';
    doc.rect(PAGE_MARGIN, rowTop, totalWidth, rowHeight).fillAndStroke(stripe, '#e5e9f0');
    const cellValues: Record<(typeof AR_SCHEDULE_COLS)[number]['key'], string> = {
      seq: String(index + 1),
      type: paymentTypeLabel(line.kind, line.label),
      label: line.label,
      date: new Date(line.dueDate).toLocaleDateString(),
      amount: line.amount.toLocaleString(),
    };
    let colRight = pageRight;
    for (const col of AR_SCHEDULE_COLS) {
      const w = totalWidth * col.width;
      drawRtlWordsCentered(doc, cellValues[col.key], colRight - w, rowTop + 6, w, { size: 9.5 });
      colRight -= w;
    }
    doc.y = rowTop + rowHeight;
  });
  doc.y += 10;
}

/** Same as drawRtlLine, but centers the whole assembled line on the page
 * instead of starting from a fixed right edge — used for the Arabic unit
 * page's "مشروع {Project} - وحدة رقم {Code}" title. */
function drawRtlLineCentered(doc: PDFKit.PDFDocument, segments: RtlSegment[], y: number): void {
  let totalWidth = 0;
  segments.forEach((seg, i) => {
    doc.font(seg.bold ? 'Cairo-Bold' : 'Cairo').fontSize(seg.size ?? 11);
    totalWidth += doc.widthOfString(seg.text);
    if (i < segments.length - 1) totalWidth += 5;
  });
  const rightX = doc.page.width / 2 + totalWidth / 2;
  drawRtlLine(doc, segments, rightX, y);
}

/** Writes "صفحة X من Y" centered at the bottom of every page already
 * drawn — must run last, right before doc.end(), since it walks the
 * document's buffered pages (bufferPages: true) rather than the live
 * page pdfkit is currently drawing on. */
function drawArabicPageNumbers(doc: PDFKit.PDFDocument): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Mixed Arabic/digit text at an explicit y near the very bottom edge —
    // without lineBreak:false, pdfkit's default overflow check treats that
    // position as not fitting and silently appends a brand-new page before
    // drawing (observed firsthand: this one omission alone turned a real
    // 2-page document into 4, two of them blank except for this footer).
    drawRtlWordsCentered(doc, `صفحة ${i + 1 - range.start} من ${range.count}`, PAGE_MARGIN, doc.page.height - PAGE_MARGIN + 12, doc.page.width - PAGE_MARGIN * 2, { size: 9, color: '#888' });
  }
}

export async function buildOfferPdf(
  quotation: Quotation,
  calc: QuotationCalculation,
  unit: Unit | undefined,
  project: Project | undefined,
  images: OfferPdfImages = {},
  locale: 'en' | 'ar' = 'en',
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  if (locale === 'ar') registerArabicFonts(doc);
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
  const afterCoverY = doc.y;
  // A footer note pinned to the bottom of the cover page — drawn at an
  // explicit y near the page bottom, which (like any explicit-position
  // text) advances doc.y to wherever it lands. Restore doc.y to the real
  // end of the flowing content right after, so the "is there room for the
  // next section" checks below measure actual content height, not this
  // footer's incidental position (which would otherwise make an
  // almost-empty cover page look full and force a pointless page break).
  if (locale === 'ar') {
    // Mixed Arabic label + Latin reference number — goes through
    // drawRtlLine (not a raw doc.text call) for the same reason as
    // everywhere else in this file's Arabic path (see its big comment).
    drawRtlLine(
      doc,
      [
        { text: 'مرجع العرض:', size: 10, color: '#999' },
        { text: `${quotation.referenceNumber} (v${quotation.version})`, size: 10, color: '#999' },
      ],
      doc.page.width - PAGE_MARGIN,
      doc.page.height - PAGE_MARGIN - 20,
    );
  } else {
    doc.fontSize(10).fillColor('#999').text(`Offer Reference: ${quotation.referenceNumber} (v${quotation.version})`, PAGE_MARGIN, doc.page.height - PAGE_MARGIN - 20);
  }
  doc.y = afterCoverY;

  const deliveryLabel = unit ? (unit.delivery ? formatDelivery(unit.delivery) : formatDelivery(project?.delivery)) : '—';

  if (locale === 'ar') {
    // ---- Arabic unit + payment-plan page: a combined title, one bordered
    // "label row / value row" grid covering unit details AND the price
    // summary (the reference design merges what the English layout keeps
    // as two separate sections), then the striped, paginated installment
    // table — see drawArabicInfoTable / drawArabicScheduleTable above.
    if (doc.y > doc.page.height - PAGE_MARGIN - 80) doc.addPage();
    drawRtlLineCentered(
      doc,
      [
        { text: 'مشروع', bold: true, size: 18 },
        { text: project?.name ?? snap.code, bold: true, size: 18 },
        { text: '- وحدة رقم', bold: true, size: 18 },
        { text: snap.code, bold: true, size: 18 },
      ],
      doc.y,
    );
    doc.moveDown(1.5);
    doc.moveTo(PAGE_MARGIN, doc.y).lineTo(doc.page.width - PAGE_MARGIN, doc.y).strokeColor('#ddd').stroke();
    doc.moveDown(0.8);

    const parkingLabelAr = snap.parkingIncluded === undefined
      ? '—'
      : snap.parkingIncluded
        ? `يشمل${snap.parkingSpaces ? ` (${snap.parkingSpaces})` : ''}`
        : `لا يشمل${snap.parkingPrice ? ` (+${snap.parkingPrice.toLocaleString()})` : ''}`;

    drawArabicHeading(doc, 'بيانات الوحدة الأساسية');
    drawArabicInfoTable(doc, [
      { label: 'كود الوحدة', value: snap.code },
      { label: 'نوع الوحدة', value: snap.unitType },
      { label: 'الطابق', value: snap.floorLabel ?? '—' },
      { label: 'المساحة', value: `${snap.areaSqm} م²` },
      { label: 'عدد الغرف', value: snap.bedrooms != null ? String(snap.bedrooms) : '—' },
      { label: 'المبنى', value: snap.buildingLabel ?? '—' },
      { label: 'الإطلالة', value: (snap.view ?? []).join('، ') || '—' },
      { label: 'مساحة الحديقة', value: snap.gardenAreaSqm != null ? `${snap.gardenAreaSqm} م²` : '—' },
      { label: 'التشطيب', value: snap.finishingType ?? '—' },
      { label: 'التسليم', value: deliveryLabel },
      { label: 'السعر / المتر', value: `${snap.pricePerMeter.toLocaleString()} جنيه` },
      { label: 'رسوم الصيانة', value: snap.maintenanceFeePercent != null ? `${snap.maintenanceFeePercent}% (${(snap.maintenanceFeeAmount ?? 0).toLocaleString()})` : '—' },
      { label: 'موقف السيارات', value: parkingLabelAr },
      { label: 'السعر الإجمالي', value: `${calc.totalPrice.toLocaleString()} جنيه` },
      { label: 'نسبة الخصم', value: `${calc.discountPercent}%` },
      { label: 'المقدم', value: `${calc.downPayment.toLocaleString()} جنيه` },
      { label: 'الحالة', value: QUOTATION_STATUS_LABELS_AR[quotation.status] },
    ]);

    if (doc.y > doc.page.height - PAGE_MARGIN - 60) doc.addPage();
    drawArabicHeading(doc, 'جدول الأقساط');
    drawArabicScheduleTable(doc, calc.schedule);
  } else {
    // ---- Unit info ----
    // Sourced from unitSnapshot (the frozen, point-in-time copy — see
    // QuotationUnitSnapshot's own comment), never re-read live from `unit`,
    // so this page renders the unit exactly as it was when the offer was
    // generated even if the real Unit/Project have since changed. `unit`/
    // `project` are only used above (images) and below (master plan
    // highlight) for data that isn't itself part of the frozen snapshot.
    // Only breaks to a new page when there isn't even room for the heading
    // itself (e.g. a tall cover image ran right to the bottom) — the grid
    // below has its own per-row overflow check, so this only needs to avoid
    // orphaning the heading, not pre-guess the whole section's height.
    if (doc.y > doc.page.height - PAGE_MARGIN - 60) doc.addPage();
    drawHeading(doc, 'Unit Information');
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

    // ---- Payment plan ----
    // Same approach as Unit Information above — only guards against orphaning
    // the heading itself; the summary grid and schedule table below each
    // have their own row-by-row overflow check.
    if (doc.y > doc.page.height - PAGE_MARGIN - 60) doc.addPage();
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
      if (rowY > doc.page.height - PAGE_MARGIN - 16) {
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
  }

  // ---- Master plan with unit highlighted (own page — needs full-page room) ----
  // Only rendered when both a master-plan image and a real Unit's
  // masterPlanPosition exist — a manually-entered unit has neither, so
  // this section is simply absent rather than showing a misleading or
  // fabricated location (spec section 29.9: never fabricate).
  if (images.masterPlanImage) {
    doc.addPage();
    drawHeading(doc, locale === 'ar' ? 'المخطط الرئيسي' : 'Master Plan');
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

  // ---- Unit floor plan (own page — needs full-page room) ----
  if (images.floorPlanImage) {
    doc.addPage();
    drawHeading(doc, locale === 'ar' ? `مخطط الوحدة ${snap.code}` : `Unit ${snap.code} — Floor Plan`);
    drawFittedImage(doc, images.floorPlanImage, PAGE_MARGIN, doc.y, contentWidth, doc.page.height - doc.y - PAGE_MARGIN);
  }

  if (locale === 'ar') drawArabicPageNumbers(doc);

  doc.end();
  return done;
}
