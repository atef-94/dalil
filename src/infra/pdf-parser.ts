import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ValidationError } from './errors.js';

interface RawTextItem {
  str: string;
  x: number;
  y: number;
  page: number;
}

export interface ParsedPdfTable {
  headers: string[];
  rows: Record<string, string>[];
  /** False when the table-reconstruction heuristic below couldn't align
   * enough of the extracted text into a believable grid — e.g. a scanned/
   * image PDF with no real text layer, or a layout too irregular to trust.
   * Callers must show the user a clear error rather than import whatever
   * this produced. */
  reliable: boolean;
}

const Y_TOLERANCE = 3; // points; groups text baselines into the same visual row

async function extractTextItems(buffer: Buffer): Promise<RawTextItem[]> {
  let doc;
  try {
    doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false }).promise;
  } catch (err) {
    throw new ValidationError(`could not read this file as a PDF: ${err instanceof Error ? err.message : String(err)}`);
  }

  const items: RawTextItem[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const str = item.str.trim();
      if (!str) continue;
      // transform = [scaleX, skewX, skewY, scaleY, x, y] in PDF space
      // (origin bottom-left) — we only need x/y, not full text-matrix math,
      // since we cluster by proximity rather than rendering anything.
      const [, , , , x, y] = item.transform as number[];
      items.push({ str, x: x ?? 0, y: y ?? 0, page: pageNum });
    }
  }
  return items;
}

/**
 * Best-effort text-based table reconstruction: clusters extracted text
 * items into visual rows by Y-coordinate (within Y_TOLERANCE, per page,
 * top-to-bottom since PDF Y grows upward), treats the first row as column
 * headers, then assigns every other row's items to the header whose X
 * position they're closest to. This only works for PDFs with a real text
 * layer laid out as a grid (the common case for exported price
 * lists/ledgers) — it deliberately does not attempt OCR for scanned/image
 * PDFs, matching the requirement to show a clear error rather than
 * fabricate data on unreliable input (see assessReliability below).
 */
export async function parsePdfTable(buffer: Buffer): Promise<ParsedPdfTable> {
  const items = await extractTextItems(buffer);
  if (items.length === 0) return { headers: [], rows: [], reliable: false };

  const rowGroups = new Map<string, RawTextItem[]>();
  for (const item of items) {
    const bucket = Math.round(item.y / Y_TOLERANCE);
    const key = `${item.page}:${bucket}`;
    const arr = rowGroups.get(key) ?? [];
    arr.push(item);
    rowGroups.set(key, arr);
  }

  const orderedRows = Array.from(rowGroups.entries())
    .map(([key, arr]) => {
      const [pageStr, bucketStr] = key.split(':');
      return { page: Number(pageStr), bucket: Number(bucketStr), items: arr.sort((a, b) => a.x - b.x) };
    })
    // Top-to-bottom reading order: page ascending, then Y descending (PDF
    // space has the origin at the bottom of the page).
    .sort((a, b) => a.page - b.page || b.bucket - a.bucket);

  if (orderedRows.length < 2) return { headers: [], rows: [], reliable: false };

  const headerRow = orderedRows[0]!.items;
  const headers = headerRow.map((i) => i.str).filter(Boolean);
  const columnStarts = headerRow.map((i) => i.x);

  const rows: Record<string, string>[] = [];
  for (const group of orderedRows.slice(1)) {
    const record: Record<string, string> = {};
    headers.forEach((h) => (record[h] = ''));
    for (const item of group.items) {
      let bestIdx = 0;
      let bestDist = Infinity;
      columnStarts.forEach((cx, idx) => {
        const dist = Math.abs(item.x - cx);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = idx;
        }
      });
      const header = headers[bestIdx];
      if (header) record[header] = record[header] ? `${record[header]} ${item.str}` : item.str;
    }
    rows.push(record);
  }

  return { headers, rows, reliable: assessReliability(headers, rows) };
}

/**
 * A row is "believable" if at least half its detected columns actually got
 * a value — a real grid-shaped export fills most cells; a heuristic that
 * misfired on an irregular/scanned layout tends to produce mostly-empty or
 * wildly uneven rows. Requires most rows to clear that bar, and at least 2
 * header columns (a 1-column "table" is almost always mis-detection, not a
 * real one-field export).
 */
function assessReliability(headers: string[], rows: Record<string, string>[]): boolean {
  if (headers.length < 2 || rows.length === 0) return false;
  const believableRows = rows.filter((r) => {
    const filled = headers.filter((h) => r[h] && r[h]!.trim() !== '').length;
    return filled >= Math.ceil(headers.length / 2);
  });
  return believableRows.length / rows.length >= 0.7;
}
