import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryRepository } from './repository.js';
import { FileStorageService } from './file-storage.js';
import type { FileAsset } from '../domain/types.js';

function service() {
  const dir = mkdtempSync(join(tmpdir(), 'active-os-filestore-test-'));
  const svc = new FileStorageService(dir, new InMemoryRepository<FileAsset>());
  return { svc, dir };
}

test('saveFile then getFile round-trips the exact bytes and metadata', async () => {
  const { svc, dir } = service();
  const data = Buffer.from('fake png bytes');
  const asset = await svc.saveFile({ companyId: 'c1', uploadedByUserId: 'u1', originalName: 'cover.png', contentType: 'image/png', data });

  assert.equal(asset.companyId, 'c1');
  assert.equal(asset.originalName, 'cover.png');
  assert.equal(asset.sizeBytes, data.length);

  const read = await svc.getFile(asset.id, 'c1');
  assert.deepEqual(read.data, data);
  assert.equal(read.asset.contentType, 'image/png');
  rmSync(dir, { recursive: true, force: true });
});

test('getFile rejects a fileId belonging to a different company the same as a nonexistent one', async () => {
  const { svc, dir } = service();
  const asset = await svc.saveFile({ companyId: 'c1', uploadedByUserId: 'u1', originalName: 'brochure.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-1.4 fake') });

  await assert.rejects(() => svc.getFile(asset.id, 'c2'), /not found/);
  await assert.rejects(() => svc.getFile('nonexistent-id', 'c1'), /not found/);
  rmSync(dir, { recursive: true, force: true });
});

test('saveFile rejects an unsupported content type', async () => {
  const { svc, dir } = service();
  await assert.rejects(
    () => svc.saveFile({ companyId: 'c1', uploadedByUserId: 'u1', originalName: 'script.js', contentType: 'application/javascript', data: Buffer.from('x') }),
    /unsupported file type/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('saveFile rejects an empty file and a file over the size limit', async () => {
  const { svc, dir } = service();
  await assert.rejects(
    () => svc.saveFile({ companyId: 'c1', uploadedByUserId: 'u1', originalName: 'empty.png', contentType: 'image/png', data: Buffer.alloc(0) }),
    /empty/,
  );
  await assert.rejects(
    () => svc.saveFile({ companyId: 'c1', uploadedByUserId: 'u1', originalName: 'huge.png', contentType: 'image/png', data: Buffer.alloc(16 * 1024 * 1024) }),
    /too large/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('two companies uploading a file never collide on disk — each keeps its own isolated copy', async () => {
  const { svc, dir } = service();
  const a = await svc.saveFile({ companyId: 'c1', uploadedByUserId: 'u1', originalName: 'master-plan.png', contentType: 'image/png', data: Buffer.from('company one bytes') });
  const b = await svc.saveFile({ companyId: 'c2', uploadedByUserId: 'u2', originalName: 'master-plan.png', contentType: 'image/png', data: Buffer.from('company two bytes') });

  const readA = await svc.getFile(a.id, 'c1');
  const readB = await svc.getFile(b.id, 'c2');
  assert.equal(readA.data.toString(), 'company one bytes');
  assert.equal(readB.data.toString(), 'company two bytes');
  rmSync(dir, { recursive: true, force: true });
});
