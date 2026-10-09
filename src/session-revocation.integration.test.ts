import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApplication } from './app.js';

async function freshApp() {
  return buildApplication({ nodeEnv: 'test', tokenSecret: 'test-secret', allowedOrigins: [], seed: true });
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

test('logout revokes the exact token used, and that token can never be used again', async () => {
  await withServer(async (base, app) => {
    const ceoUser = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!;
    const login = await call(base, 'POST', '/api/auth/login', {
      companyId: app.seedResult!.companyId, email: ceoUser.email, password: 'demo-password-not-for-production',
    });
    const token = (login.body as { token: string }).token;
    const headers = { Authorization: `Bearer ${token}` };

    const beforeLogout = await call(base, 'GET', '/api/audit-log?limit=1', undefined, headers);
    assert.equal(beforeLogout.status, 200);

    const logout = await call(base, 'POST', '/api/auth/logout', {}, headers);
    assert.equal(logout.status, 200);

    const afterLogout = await call(base, 'GET', '/api/audit-log?limit=1', undefined, headers);
    assert.equal(afterLogout.status, 401);
  });
});

test('logging out of one session does not revoke a different, still-valid session for the same user', async () => {
  await withServer(async (base, app) => {
    const ceoUser = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!;
    const login1 = await call(base, 'POST', '/api/auth/login', {
      companyId: app.seedResult!.companyId, email: ceoUser.email, password: 'demo-password-not-for-production',
    });
    const login2 = await call(base, 'POST', '/api/auth/login', {
      companyId: app.seedResult!.companyId, email: ceoUser.email, password: 'demo-password-not-for-production',
    });
    const headers1 = { Authorization: `Bearer ${(login1.body as { token: string }).token}` };
    const headers2 = { Authorization: `Bearer ${(login2.body as { token: string }).token}` };

    await call(base, 'POST', '/api/auth/logout', {}, headers1);

    const stillWorks = await call(base, 'GET', '/api/audit-log?limit=1', undefined, headers2);
    assert.equal(stillWorks.status, 200);
  });
});

test('POST /api/users/:id/revoke-sessions kills every token a user holds, even ones never individually logged out', async () => {
  await withServer(async (base, app) => {
    const ceoUser = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!;
    const login1 = await call(base, 'POST', '/api/auth/login', {
      companyId: app.seedResult!.companyId, email: ceoUser.email, password: 'demo-password-not-for-production',
    });
    const login2 = await call(base, 'POST', '/api/auth/login', {
      companyId: app.seedResult!.companyId, email: ceoUser.email, password: 'demo-password-not-for-production',
    });
    const headers1 = { Authorization: `Bearer ${(login1.body as { token: string }).token}` };
    const headers2 = { Authorization: `Bearer ${(login2.body as { token: string }).token}` };

    const revoke = await call(base, 'POST', `/api/users/${ceoUser.userId}/revoke-sessions`, {}, headers1);
    assert.equal(revoke.status, 200);

    const check1 = await call(base, 'GET', '/api/audit-log?limit=1', undefined, headers1);
    const check2 = await call(base, 'GET', '/api/audit-log?limit=1', undefined, headers2);
    assert.equal(check1.status, 401);
    assert.equal(check2.status, 401);
  });
});

test('a Sales Agent cannot revoke another user\'s sessions without edit:employee', async () => {
  await withServer(async (base, app) => {
    const ceoUser = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!;
    const agentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;
    const attempt = await call(base, 'POST', `/api/users/${ceoUser.userId}/revoke-sessions`, {}, { 'x-demo-user': agentUserId });
    assert.equal(attempt.status, 403);
  });
});

test('a user can always revoke their own other sessions (self-service)', async () => {
  await withServer(async (base, app) => {
    const agentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;
    const revoke = await call(base, 'POST', `/api/users/${agentUserId}/revoke-sessions`, {}, { 'x-demo-user': agentUserId });
    assert.equal(revoke.status, 200);
  });
});

test('full password-reset flow: request -> token audit-logged (never in the HTTP response) -> confirm -> old sessions killed -> new password works', async () => {
  await withServer(async (base, app) => {
    const ceoUser = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!;
    const oldLogin = await call(base, 'POST', '/api/auth/login', {
      companyId: app.seedResult!.companyId, email: ceoUser.email, password: 'demo-password-not-for-production',
    });
    const oldHeaders = { Authorization: `Bearer ${(oldLogin.body as { token: string }).token}` };

    const request = await call(base, 'POST', '/api/auth/password-reset/request', {
      companyId: app.seedResult!.companyId, email: ceoUser.email,
    });
    assert.equal(request.status, 200);
    assert.deepEqual(request.body, { success: true });
    // The raw token must never be in the public response body.
    assert.equal(JSON.stringify(request.body).includes('rawToken'), false);

    const audit = await call(base, 'GET', '/api/audit-log?limit=300', undefined, { 'x-demo-user': ceoUser.userId });
    const entry = (audit.body as { items: { action: string; resource: string; resourceId: string; metadata?: { resetTokenForOperatorRelay?: string } }[] }).items
      .find((e) => e.resource === 'password_reset_token' && e.resourceId === ceoUser.userId);
    assert.ok(entry, 'expected a password_reset_token audit entry');
    const rawToken = entry!.metadata!.resetTokenForOperatorRelay!;
    assert.ok(rawToken);

    const confirm = await call(base, 'POST', '/api/auth/password-reset/confirm', { token: rawToken, newPassword: 'a-brand-new-password-1' });
    assert.equal(confirm.status, 200);

    // The reset killed every pre-existing session.
    const oldSessionCheck = await call(base, 'GET', '/api/audit-log?limit=1', undefined, oldHeaders);
    assert.equal(oldSessionCheck.status, 401);

    // Old password no longer works; new one does.
    const loginOldPassword = await call(base, 'POST', '/api/auth/login', {
      companyId: app.seedResult!.companyId, email: ceoUser.email, password: 'demo-password-not-for-production',
    });
    assert.equal(loginOldPassword.status, 401);
    const loginNewPassword = await call(base, 'POST', '/api/auth/login', {
      companyId: app.seedResult!.companyId, email: ceoUser.email, password: 'a-brand-new-password-1',
    });
    assert.equal(loginNewPassword.status, 200);

    // The token is single-use.
    const reuse = await call(base, 'POST', '/api/auth/password-reset/confirm', { token: rawToken, newPassword: 'yet-another-password-2' });
    assert.equal(reuse.status, 400);
  });
});

test('requesting a password reset for an unknown email returns the exact same generic success (no account enumeration)', async () => {
  await withServer(async (base, app) => {
    const known = await call(base, 'POST', '/api/auth/password-reset/request', {
      companyId: app.seedResult!.companyId, email: 'no-such-user@example.com',
    });
    assert.equal(known.status, 200);
    assert.deepEqual(known.body, { success: true });
  });
});
