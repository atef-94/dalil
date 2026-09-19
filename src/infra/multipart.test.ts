import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMultipart } from './multipart.js';

// Shaped exactly like what a browser's FormData/fetch actually sends —
// CRLF line endings, a boundary the browser generates, one text field and
// one file field with a binary-safe body.
function buildMultipart(boundary: string, parts: { name: string; filename?: string; contentType?: string; value: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    let disposition = `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename) disposition += `; filename="${part.filename}"`;
    chunks.push(Buffer.from(`${disposition}\r\n`));
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
    chunks.push(Buffer.from('\r\n'));
    chunks.push(part.value);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

test('parseMultipart extracts a plain text field', () => {
  const boundary = 'Boundary123';
  const body = buildMultipart(boundary, [{ name: 'targetType', value: Buffer.from('lead') }]);
  const result = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
  assert.deepEqual(result.fields, { targetType: 'lead' });
  assert.deepEqual(result.files, []);
});

test('parseMultipart extracts a file part with filename and content-type, preserving binary content', () => {
  const boundary = '----WebKitFormBoundaryABC123';
  const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10]); // arbitrary bytes, not valid utf8
  const body = buildMultipart(boundary, [
    { name: 'file', filename: 'leads.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', value: binary },
  ]);
  const result = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]!.fieldName, 'file');
  assert.equal(result.files[0]!.filename, 'leads.xlsx');
  assert.equal(result.files[0]!.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.ok(result.files[0]!.data.equals(binary));
});

test('parseMultipart handles a mix of fields and files in one request', () => {
  const boundary = 'mixedBoundary';
  const body = buildMultipart(boundary, [
    { name: 'targetType', value: Buffer.from('payment') },
    { name: 'file', filename: 'payments.csv', contentType: 'text/csv', value: Buffer.from('a,b\n1,2\n') },
    { name: 'note', value: Buffer.from('imported from bank export') },
  ]);
  const result = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
  assert.deepEqual(result.fields, { targetType: 'payment', note: 'imported from bank export' });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]!.data.toString('utf8'), 'a,b\n1,2\n');
});

test('parseMultipart throws HttpError when boundary is missing from content-type', () => {
  assert.throws(() => parseMultipart(Buffer.from('irrelevant'), 'multipart/form-data'), /boundary/);
});

test('parseMultipart throws HttpError when the boundary never appears in the body', () => {
  assert.throws(() => parseMultipart(Buffer.from('no boundary here'), 'multipart/form-data; boundary=xyz'), /boundary/);
});

test('parseMultipart handles quoted boundary values', () => {
  const boundary = 'quoted-boundary-1';
  const body = buildMultipart(boundary, [{ name: 'a', value: Buffer.from('1') }]);
  const result = parseMultipart(body, `multipart/form-data; boundary="${boundary}"`);
  assert.deepEqual(result.fields, { a: '1' });
});
