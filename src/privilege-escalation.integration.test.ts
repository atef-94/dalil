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

/**
 * Builds a real "Narrow Admin" role — edit:role at company scope (so it can
 * use the grants API at all) but only 'own'-scoped view:lead — assigns it
 * to a real user, and returns that user's x-demo-user header. This is a
 * deliberately weaker admin than the CEO: the CEO's grants already cover
 * every action/resource at company scope, so a CEO-based test could never
 * distinguish "has edit:role" from "actually holds the permission being
 * granted" — this narrower role is what actually exercises the guard.
 */
async function createNarrowAdmin(base: string, ceoHeaders: Record<string, string>, companyId: string) {
  const role = await call(base, 'POST', '/api/roles', { name: `Narrow Admin ${Date.now()}` }, ceoHeaders);
  const roleId = (role.body as { id: string }).id;
  await call(base, 'POST', `/api/roles/${roleId}/grants`, { action: 'edit', resource: 'role', scope: 'company' }, ceoHeaders);
  await call(base, 'POST', `/api/roles/${roleId}/grants`, { action: 'view', resource: 'lead', scope: 'own' }, ceoHeaders);

  const employee = await call(base, 'POST', '/api/organization/employees', {
    fullName: 'Narrow Admin', email: `narrow-admin-${Date.now()}@example.com`, title: 'Admin',
  }, ceoHeaders);
  const employeeId = (employee.body as { id: string }).id;
  const user = await call(base, 'POST', '/api/auth/register', {
    email: (employee.body as { email: string }).email, password: 'a-real-password-123', userType: 'employee_user', employeeId,
  }, ceoHeaders);
  const userId = (user.body as { id: string }).id;
  await call(base, 'POST', `/api/users/${userId}/roles`, { roleId }, ceoHeaders);
  return { headers: { 'x-demo-user': userId }, roleId };
}

test('a narrow admin (edit:role, but only own-scoped view:lead) cannot grant a company-wide view:lead to any role', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const ceoHeaders = { 'x-demo-user': ceoUserId };
    const narrowAdmin = await createNarrowAdmin(base, ceoHeaders, app.seedResult!.companyId);

    const targetRole = await call(base, 'POST', '/api/roles', { name: `Target ${Date.now()}` }, ceoHeaders);
    const targetRoleId = (targetRole.body as { id: string }).id;

    const escalation = await call(base, 'POST', `/api/roles/${targetRoleId}/grants`, {
      action: 'view', resource: 'lead', scope: 'company',
    }, narrowAdmin.headers);
    assert.equal(escalation.status, 403);
  });
});

test('that same narrow admin CAN grant a scope no wider than what it already holds (own-scoped view:lead)', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const ceoHeaders = { 'x-demo-user': ceoUserId };
    const narrowAdmin = await createNarrowAdmin(base, ceoHeaders, app.seedResult!.companyId);

    const targetRole = await call(base, 'POST', '/api/roles', { name: `Target ${Date.now()}` }, ceoHeaders);
    const targetRoleId = (targetRole.body as { id: string }).id;

    const legitimate = await call(base, 'POST', `/api/roles/${targetRoleId}/grants`, {
      action: 'view', resource: 'lead', scope: 'own',
    }, narrowAdmin.headers);
    assert.equal(legitimate.status, 201);
  });
});

test('a narrow admin cannot grant an action/resource it does not hold at all (e.g. edit:unit)', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const ceoHeaders = { 'x-demo-user': ceoUserId };
    const narrowAdmin = await createNarrowAdmin(base, ceoHeaders, app.seedResult!.companyId);

    const targetRole = await call(base, 'POST', '/api/roles', { name: `Target ${Date.now()}` }, ceoHeaders);
    const targetRoleId = (targetRole.body as { id: string }).id;

    const escalation = await call(base, 'POST', `/api/roles/${targetRoleId}/grants`, {
      action: 'edit', resource: 'unit', scope: 'own',
    }, narrowAdmin.headers);
    assert.equal(escalation.status, 403);
  });
});

test('a CEO (full company-wide admin) can still grant anything up to company scope — the guard never blocks legitimate admin use', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const ceoHeaders = { 'x-demo-user': ceoUserId };
    const role = await call(base, 'POST', '/api/roles', { name: `Full ${Date.now()}` }, ceoHeaders);
    const roleId = (role.body as { id: string }).id;
    const grant = await call(base, 'POST', `/api/roles/${roleId}/grants`, { action: 'view', resource: 'lead', scope: 'company' }, ceoHeaders);
    assert.equal(grant.status, 201);
  });
});
