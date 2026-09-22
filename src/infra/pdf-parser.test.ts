import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePdfTable, extractPdfPlainText } from './pdf-parser.js';

/**
 * Hand-builds a minimal, valid, text-only PDF (one page, Helvetica, a grid
 * of absolutely-positioned text runs) — this project has no PDF-authoring
 * dependency (pdfjs-dist only reads PDFs), so tests construct real PDF
 * bytes directly rather than mocking pdfjs-dist's API.
 */
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

test('parsePdfTable reconstructs a clean grid-shaped PDF into headers + rows', async () => {
  const pdf = buildPdf([
    { text: 'Name', x: 50, y: 700 },
    { text: 'Phone', x: 200, y: 700 },
    { text: 'Email', x: 350, y: 700 },
    { text: 'Ahmed Ali', x: 50, y: 680 },
    { text: '0100000000', x: 200, y: 680 },
    { text: 'ahmed@example.com', x: 350, y: 680 },
    { text: 'Sara Youssef', x: 50, y: 660 },
    { text: '0111111111', x: 200, y: 660 },
    { text: 'sara@example.com', x: 350, y: 660 },
  ]);
  const table = await parsePdfTable(pdf);
  assert.deepEqual(table.headers, ['Name', 'Phone', 'Email']);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0]!.Name, 'Ahmed Ali');
  assert.equal(table.rows[0]!.Phone, '0100000000');
  assert.equal(table.rows[1]!.Email, 'sara@example.com');
  assert.equal(table.reliable, true);
});

test('parsePdfTable marks a sparse/irregular layout as unreliable rather than fabricating rows', async () => {
  const pdf = buildPdf([
    { text: 'A', x: 50, y: 700 },
    { text: 'B', x: 200, y: 700 },
    { text: 'C', x: 350, y: 700 },
    { text: 'onlyone', x: 50, y: 680 },
  ]);
  const table = await parsePdfTable(pdf);
  assert.equal(table.reliable, false);
});

test('parsePdfTable returns unreliable/empty for a PDF with no extractable text', async () => {
  const pdf = buildPdf([]);
  const table = await parsePdfTable(pdf);
  assert.deepEqual(table.headers, []);
  assert.deepEqual(table.rows, []);
  assert.equal(table.reliable, false);
});

test('parsePdfTable throws a clear ValidationError for a non-PDF file', async () => {
  await assert.rejects(() => parsePdfTable(Buffer.from('not a pdf at all')), /could not read this file as a PDF/);
});

test('extractPdfPlainText joins a text-bearing PDF into reading-order lines', async () => {
  const pdf = buildPdf([
    { text: 'Project: Marassi Heights', x: 50, y: 700 },
    { text: 'Unit No: A-104', x: 50, y: 680 },
    { text: 'Price: 3,500,000', x: 50, y: 660 },
  ]);
  const result = await extractPdfPlainText(pdf);
  assert.equal(result.hasTextLayer, true);
  const lines = result.text.split('\n');
  assert.equal(lines[0], 'Project: Marassi Heights');
  assert.equal(lines[1], 'Unit No: A-104');
  assert.equal(lines[2], 'Price: 3,500,000');
});

test('extractPdfPlainText reports no text layer for a PDF with zero extractable text', async () => {
  const pdf = buildPdf([]);
  const result = await extractPdfPlainText(pdf);
  assert.equal(result.hasTextLayer, false);
  assert.equal(result.text, '');
});
