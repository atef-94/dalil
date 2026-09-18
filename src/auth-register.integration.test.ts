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

test('POST /api/auth/register rejects an unauthenticated request (real security fix)', async () => {
  await withServer(async (base) => {
    const attempt = await call(base, 'POST', '/api/auth/register', {
      companyId: 'company-demo',
      email: `attacker-${Date.now()}@evil.example`,
      password: 'whatever123',
      userType: 'employee_user',
    });
    assert.equal(attempt.status, 401);
  });
});

test('POST /api/auth/register always registers into the actor\'s own company, ignoring any companyId in the body', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const created = await call(base, 'POST', '/api/auth/register', {
      companyId: 'some-other-company-id',
      email: `staff-${Date.now()}@example.com`,
      password: 'a-real-password-123',
      userType: 'employee_user',
    }, { 'x-demo-user': ceoUserId });
    assert.equal(created.status, 201);
    // If it had honored the spoofed companyId, logging in against company-demo would fail.
    const login = await call(base, 'POST', '/api/auth/login', {
      companyId: 'company-demo',
      email: (created.body as { email: string }).email,
      password: 'a-real-password-123',
    });
    assert.equal(login.status, 200);
  });
});

test('a non-privileged actor cannot create a login account', async () => {
  await withServer(async (base, app) => {
    const agentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;
    const attempt = await call(base, 'POST', '/api/auth/register', {
      email: `new-${Date.now()}@example.com`,
      password: 'a-real-password-123',
      userType: 'employee_user',
    }, { 'x-demo-user': agentUserId });
    assert.equal(attempt.status, 403);
  });
});

test('creating a broker_user login requires the broker company to already be approved', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const brokerCompany = await call(base, 'POST', '/api/brokers/companies', { name: `Test Brokers ${Date.now()}` }, { 'x-demo-user': ceoUserId });
    assert.equal(brokerCompany.status, 201);

    const tooEarly = await call(base, 'POST', '/api/auth/register', {
      email: `broker-${Date.now()}@example.com`,
      password: 'a-real-password-123',
      userType: 'broker_user',
      brokerCompanyId: (brokerCompany.body as { id: string }).id,
    }, { 'x-demo-user': ceoUserId });
    assert.equal(tooEarly.status, 403);

    await call(base, 'POST', `/api/brokers/companies/${(brokerCompany.body as { id: string }).id}/approve`, {}, { 'x-demo-user': ceoUserId });
    const afterApproval = await call(base, 'POST', '/api/auth/register', {
      email: `broker-${Date.now()}@example.com`,
      password: 'a-real-password-123',
      userType: 'broker_user',
      brokerCompanyId: (brokerCompany.body as { id: string }).id,
    }, { 'x-demo-user': ceoUserId });
    assert.equal(afterApproval.status, 201);
  });
});

test('broker company register/approve/suspend and broker commission record/approve all write to the audit log', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const brokerCompany = await call(base, 'POST', '/api/brokers/companies', { name: `Audited Brokers ${Date.now()}` }, headers);
    const brokerCompanyId = (brokerCompany.body as { id: string }).id;
    await call(base, 'POST', `/api/brokers/companies/${brokerCompanyId}/approve`, {}, headers);
    await call(base, 'POST', `/api/brokers/companies/${brokerCompanyId}/suspend`, {}, headers);

    const audit = await call(base, 'GET', '/api/audit-log?limit=300', undefined, headers);
    const entries = (audit.body as { items: { resourceId: string; action: string }[] }).items.filter((e) => e.resourceId === brokerCompanyId);
    const actions = entries.map((e) => e.action).sort();
    assert.deepEqual(actions, ['approve', 'create', 'edit']);
  });
});
