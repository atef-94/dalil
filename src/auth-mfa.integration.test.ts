import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApplication } from './app.js';
import { generateTotpCode } from './infra/totp.js';

async function freshApp(overrides: Partial<Parameters<typeof buildApplication>[0]> = {}) {
  return buildApplication({ nodeEnv: 'test', tokenSecret: 'test-secret', allowedOrigins: [], seed: true, ...overrides });
}

async function withServer(
  run: (base: string, app: Awaited<ReturnType<typeof freshApp>>) => Promise<void>,
  overrides: Partial<Parameters<typeof buildApplication>[0]> = {},
) {
  const app = await freshApp(overrides);
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

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

test('full MFA enrollment flow: enroll -> verify -> login then requires a code -> succeeds with a valid one', async () => {
  await withServer(async (base, app) => {
    const ceoUser = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!;
    const login1 = await call(base, 'POST', '/api/auth/login', {
      companyId: app.seedResult!.companyId, email: ceoUser.email, password: 'demo-password-not-for-production',
    });
    assert.equal(login1.status, 200);
    const headers = { Authorization: `Bearer ${(login1.body as { token: string }).token}` };

    const enroll = await call(base, 'POST', '/api/me/mfa/enroll', undefined, headers);
    assert.equal(enroll.status, 200);
    const { secret, otpauthUri } = enroll.body as { secret: string; otpauthUri: string };
    assert.ok(secret);
    assert.match(otpauthUri, /^otpauth:\/\/totp\//);

    const verify = await call(base, 'POST', '/api/me/mfa/verify', { code: generateTotpCode(secret) }, headers);
    assert.equal(verify.status, 200);
    const { recoveryCodes } = verify.body as { recoveryCodes: string[] };
    assert.equal(recoveryCodes.length, 10);

    // Password alone is no longer enough.
    const loginNoCode = await call(base, 'POST', '/api/auth/login', {
      companyId: app.seedResult!.companyId, email: ceoUser.email, password: 'demo-password-not-for-production',
    });
    assert.equal(loginNoCode.status, 401);
    assert.deepEqual(loginNoCode.body, { error: 'mfa_required' });

    const loginWithCode = await call(base, 'POST', '/api/auth/login', {
      companyId: app.seedResult!.companyId, email: ceoUser.email, password: 'demo-password-not-for-production', totpCode: generateTotpCode(secret),
    });
    assert.equal(loginWithCode.status, 200);
  });
});

test('a recovery code logs in once and is then rejected on reuse', async () => {
  await withServer(async (base, app) => {
    const ceoUser = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!;
    const login1 = await call(base, 'POST', '/api/auth/login', {
      companyId: app.seedResult!.companyId, email: ceoUser.email, password: 'demo-password-not-for-production',
    });
    const headers = { Authorization: `Bearer ${(login1.body as { token: string }).token}` };
    const enroll = await call(base, 'POST', '/api/me/mfa/enroll', undefined, headers);
    const { secret } = enroll.body as { secret: string };
    const verify = await call(base, 'POST', '/api/me/mfa/verify', { code: generateTotpCode(secret) }, headers);
    const code = (verify.body as { recoveryCodes: string[] }).recoveryCodes[0]!;

    const loginWithRecovery = await call(base, 'POST', '/api/auth/login', {
      companyId: app.seedResult!.companyId, email: ceoUser.email, password: 'demo-password-not-for-production', totpCode: code,
    });
    assert.equal(loginWithRecovery.status, 200);

    const reuse = await call(base, 'POST', '/api/auth/login', {
      companyId: app.seedResult!.companyId, email: ceoUser.email, password: 'demo-password-not-for-production', totpCode: code,
    });
    assert.equal(reuse.status, 401);
  });
});

test('/api/me/mfa/* routes require authentication', async () => {
  await withServer(async (base) => {
    const enroll = await call(base, 'POST', '/api/me/mfa/enroll');
    assert.equal(enroll.status, 401);
  });
});

test('a platform owner logging in without MFA in production gets a mfaSetupRequired flag, and cannot self-disable MFA once enrolled', async () => {
  const ownerEmail1 = `owner1-${Date.now()}@platform.test`;
  const ownerEmail2 = `owner2-${Date.now()}@platform.test`;
  await withServer(
    async (base) => {
      const login1 = await call(base, 'POST', '/api/auth/login', {
        companyId: '__platform__', email: ownerEmail1, password: 'owner-1-password-123',
      });
      assert.equal(login1.status, 200);
      assert.equal((login1.body as { mfaSetupRequired: boolean }).mfaSetupRequired, true);
      const headers = { Authorization: `Bearer ${(login1.body as { token: string }).token}` };

      const enroll = await call(base, 'POST', '/api/me/mfa/enroll', undefined, headers);
      const { secret } = enroll.body as { secret: string };
      await call(base, 'POST', '/api/me/mfa/verify', { code: generateTotpCode(secret) }, headers);

      const login2 = await call(base, 'POST', '/api/auth/login', {
        companyId: '__platform__', email: ownerEmail1, password: 'owner-1-password-123', totpCode: generateTotpCode(secret),
      });
      assert.equal((login2.body as { mfaSetupRequired: boolean }).mfaSetupRequired, false);
      const headers2 = { Authorization: `Bearer ${(login2.body as { token: string }).token}` };

      const disable = await call(base, 'POST', '/api/me/mfa/disable', undefined, headers2);
      assert.equal(disable.status, 403);
    },
    {
      nodeEnv: 'production',
      tokenSecret: 'a-real-production-secret-not-dev',
      ownerEmail1,
      ownerEmail2,
      ownerPassword1: 'owner-1-password-123',
      ownerPassword2: 'owner-2-password-123',
      seed: false,
    },
  );
});
