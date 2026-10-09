import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApplication } from './app.js';

const OWNER_EMAIL = 'owner1@platform.test';
const OWNER_PASSWORD = 'owner-1-password-123';

async function freshApp() {
  return buildApplication({
    nodeEnv: 'test',
    tokenSecret: 'test-secret',
    allowedOrigins: [],
    seed: true,
    ownerEmail1: OWNER_EMAIL,
    ownerEmail2: 'owner2@platform.test',
    ownerPassword1: OWNER_PASSWORD,
    ownerPassword2: 'owner-2-password-123',
  });
}

async function postJson(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

/** Creates a brand-new tenant via the owner-gated /api/platform/tenants route
 * (the only way to do this now that public signup is gone) and returns the
 * bearer-token headers for its founding user, exactly like the old
 * self-service signup response did. */
async function createSecondTenant(base: string, namePrefix: string) {
  const ownerLogin = await postJson(base, '/api/auth/login', {
    companyId: '__platform__', email: OWNER_EMAIL, password: OWNER_PASSWORD,
  });
  const ownerHeaders = { authorization: `Bearer ${(ownerLogin.body as { token: string }).token}` };
  const tenant = await postJson(base, '/api/platform/tenants', {
    companyName: `${namePrefix} ${Date.now()}`,
    fullName: 'Owner B',
    email: `${namePrefix.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}@example.com`,
    password: 'a-real-password-123',
  }, ownerHeaders);
  assert.equal(tenant.status, 201);
  return { authorization: `Bearer ${(tenant.body as { token: string }).token}` };
}

async function withServer(run: (base: string, app: Awaited<ReturnType<typeof freshApp>>) => Promise<void>) {
  const app = await freshApp();
  const server = app.httpServer.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`, app);
  } finally {
    await app.httpServer.close();
  }
}

async function uploadFile(base: string, path: string, filename: string, contentType: string, data: Buffer, headers: Record<string, string> = {}) {
  const form = new FormData();
  form.set('file', new Blob([data], { type: contentType }), filename);
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: form });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function getJson(base: string, path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, { headers });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

test('project media file upload/download round-trips the exact bytes', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const data = Buffer.from('fake master plan png bytes');

    const upload = await uploadFile(base, '/api/inventory/files/upload', 'master-plan.png', 'image/png', data, headers);
    assert.equal(upload.status, 201);
    const uploadBody = upload.body as { fileId: string; url: string; contentType: string; originalName: string };
    assert.equal(uploadBody.contentType, 'image/png');
    assert.equal(uploadBody.originalName, 'master-plan.png');
    assert.equal(uploadBody.url, `/api/inventory/files/${uploadBody.fileId}`);

    const download = await getJson(base, uploadBody.url, headers);
    assert.equal(download.status, 200);
    const downloadBody = download.body as { contentType: string; base64: string; originalName: string };
    assert.equal(downloadBody.contentType, 'image/png');
    assert.equal(Buffer.from(downloadBody.base64, 'base64').toString(), data.toString());
  });
});

test('project media file upload is rejected for a role lacking edit:project, and download requires authentication', async () => {
  await withServer(async (base, app) => {
    const agentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;
    const headers = { 'x-demo-user': agentUserId };
    const upload = await uploadFile(base, '/api/inventory/files/upload', 'x.png', 'image/png', Buffer.from('x'), headers);
    assert.equal(upload.status, 403);

    const anon = await getJson(base, '/api/inventory/files/some-id');
    assert.equal(anon.status, 401);
  });
});

test('project media file download rejects a fileId belonging to a different company with 404', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const upload = await uploadFile(base, '/api/inventory/files/upload', 'brochure.pdf', 'application/pdf', Buffer.from('%PDF-1.4 fake'), headers);
    const { fileId } = upload.body as { fileId: string };

    // A completely separate real tenant (Tenant B), via owner-gated tenant creation.
    const otherHeaders = await createSecondTenant(base, 'File Upload Tenant B');

    const crossTenant = await getJson(base, `/api/inventory/files/${fileId}`, otherHeaders);
    assert.equal(crossTenant.status, 404);
  });
});

test('an unsupported content type is rejected with 400', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const upload = await uploadFile(base, '/api/inventory/files/upload', 'script.js', 'application/javascript', Buffer.from('x'), headers);
    assert.equal(upload.status, 400);
  });
});
