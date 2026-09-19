import { HttpError } from './errors.js';

/**
 * A minimal, dependency-free multipart/form-data parser — same philosophy
 * as csv.ts's hand-written CSV parser: this project reaches for a real npm
 * package only where the user explicitly authorized it (exceljs/pdfjs-dist,
 * for parsing untrusted uploaded file *contents*), not for HTTP plumbing
 * that's ours to control. Handles ordinary browser FormData uploads: text
 * fields and one or more files, each as its own binary-safe part.
 */
export interface MultipartFile {
  fieldName: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MultipartBody {
  fields: Record<string, string>;
  files: MultipartFile[];
}

function extractBoundary(contentType: string): string {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) throw new HttpError(400, 'multipart request missing boundary');
  return boundary.trim();
}

export function parseMultipart(buffer: Buffer, contentType: string): MultipartBody {
  const boundary = extractBoundary(contentType);
  const delimiter = Buffer.from(`--${boundary}`);
  const fields: Record<string, string> = {};
  const files: MultipartFile[] = [];

  let cursor = buffer.indexOf(delimiter);
  if (cursor === -1) throw new HttpError(400, 'malformed multipart body: boundary not found');
  cursor += delimiter.length;

  while (cursor < buffer.length) {
    // A "--" immediately after the boundary marks the closing delimiter.
    if (buffer[cursor] === 0x2d && buffer[cursor + 1] === 0x2d) break;
    // Otherwise a CRLF separates the boundary line from the part itself.
    if (buffer[cursor] === 0x0d && buffer[cursor + 1] === 0x0a) cursor += 2;

    const nextDelimiter = buffer.indexOf(delimiter, cursor);
    if (nextDelimiter === -1) break;
    // The part's own trailing CRLF sits right before the next boundary.
    const partEnd = nextDelimiter - 2;
    const part = buffer.subarray(cursor, Math.max(cursor, partEnd));

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerText = part.subarray(0, headerEnd).toString('utf8');
      const partBody = part.subarray(headerEnd + 4);
      const nameMatch = /name="([^"]*)"/i.exec(headerText);
      const filenameMatch = /filename="([^"]*)"/i.exec(headerText);
      const contentTypeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
      const fieldName = nameMatch?.[1] ?? '';

      if (filenameMatch) {
        files.push({
          fieldName,
          filename: filenameMatch[1] ?? '',
          contentType: contentTypeMatch?.[1]?.trim() ?? 'application/octet-stream',
          data: Buffer.from(partBody),
        });
      } else if (fieldName) {
        fields[fieldName] = partBody.toString('utf8');
      }
    }

    cursor = nextDelimiter + delimiter.length;
  }

  return { fields, files };
}
