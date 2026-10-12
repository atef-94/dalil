import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileAsset } from '../domain/types.js';
import type { Repository } from './repository.js';
import { ValidationError, NotFoundError } from './errors.js';

/** Content types this app will store and re-serve — project media only
 * (cover image, master plan, gallery photo, brochure). Anything else is
 * rejected outright rather than stored with a guessed/unknown type, since
 * this file is later served back with that same Content-Type header. */
const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB — generous for a brochure PDF or a high-res photo, not unbounded

function extensionFor(contentType: string): string {
  switch (contentType) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    case 'application/pdf': return '.pdf';
    default: return '';
  }
}

/**
 * The one place in this app where a "file" field is backed by real stored
 * bytes rather than a pasted external URL — every other media field
 * (locationMapUrl, ministerialDecisionDocumentUrl, floorPlanImageUrl, …)
 * stays the existing "paste an already-hosted URL" convention; this only
 * covers Project media (cover image, master plan, gallery, brochure) per
 * the explicit decision to support real upload for that one case.
 *
 * Storage is a plain directory on disk (the same persistent volume the
 * SQLite file itself lives on in production — see main.ts), one
 * sub-directory per company, so a tenant's files are trivially enumerable
 * and never interleaved with another tenant's on disk. `FileAsset` rows are
 * the source of truth for tenant ownership; `storagePath` is only ever
 * read back after that row's companyId has already been checked.
 */
export class FileStorageService {
  constructor(
    private readonly uploadsDir: string,
    private readonly fileAssets: Repository<FileAsset>,
  ) {}

  async saveFile(input: {
    companyId: string;
    uploadedByUserId: string;
    originalName: string;
    contentType: string;
    data: Buffer;
  }): Promise<FileAsset> {
    if (!ALLOWED_CONTENT_TYPES.has(input.contentType)) {
      throw new ValidationError(`unsupported file type "${input.contentType}" — only images (PNG/JPEG/WEBP/GIF) and PDF are accepted`);
    }
    if (input.data.length === 0) {
      throw new ValidationError('uploaded file is empty');
    }
    if (input.data.length > MAX_FILE_BYTES) {
      throw new ValidationError(`file is too large (${Math.round(input.data.length / 1024 / 1024)}MB) — the limit is ${MAX_FILE_BYTES / 1024 / 1024}MB`);
    }

    const id = randomUUID();
    const relativePath = join(input.companyId, `${id}${extensionFor(input.contentType)}`);
    const absolutePath = join(this.uploadsDir, relativePath);
    await mkdir(join(this.uploadsDir, input.companyId), { recursive: true });
    await writeFile(absolutePath, input.data);

    const asset: FileAsset = {
      id,
      companyId: input.companyId,
      originalName: input.originalName,
      contentType: input.contentType,
      sizeBytes: input.data.length,
      storagePath: relativePath,
      uploadedByUserId: input.uploadedByUserId,
      createdAt: new Date().toISOString(),
    };
    return this.fileAssets.save(asset);
  }

  /** Tenant-scoped read — a fileId from a different company is treated
   * identically to a nonexistent one (never leaks whether it exists). */
  async getFile(fileId: string, companyId: string): Promise<{ asset: FileAsset; data: Buffer }> {
    const asset = await this.fileAssets.findById(fileId);
    if (!asset || asset.companyId !== companyId) {
      throw new NotFoundError('file not found');
    }
    const data = await readFile(join(this.uploadsDir, asset.storagePath));
    return { asset, data };
  }
}
