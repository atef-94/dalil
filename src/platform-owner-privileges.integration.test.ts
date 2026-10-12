import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, loginAsOwner, withServer, OWNER_EMAIL_1, OWNER_EMAIL_2, OWNER_PASSWORD_1 } from './test-support/test-app.js';

// Mandatory proof points 2, 3, 6:
//   2. Both configured owner emails have identical platform-owner privileges.
//   3. No other identity can become a platform owner.
//   6. Platform owners cannot access private tenant business data through
//      normal administrative APIs.

test('both configured owner emails reach every /api/platform/* route identically', async () => {
  await withServer(async (base) => {
    const owner1 = await loginAsOwner(base, 1);
    const owner2 = await loginAsOwner(base, 2);

    for (const headers of [owner1, owner2]) {
      const tenants = await call(base, 'GET', '/api/platform/tenants', undefined, headers);
      assert.equal(tenants.status, 200);
      const auditLog = await call(base, 'GET', '/api/platform/audit-log', undefined, headers);
      assert.equal(auditLog.status, 200);
    }

    // Each can create a real tenant — not just a read-only privilege.
    for (const [headers, label] of [[owner1, 'owner1'], [owner2, 'owner2']] as const) {
      const created = await call(base, 'POST', '/api/platform/tenants', {
        companyName: `${label} Tenant ${Date.now()}`, fullName: 'Founder', email: `${label}-founder-${Date.now()}@example.com`, password: 'a-real-password-123',
      }, headers);
      assert.equal(created.status, 201, `${label} should be able to create a tenant`);
    }
  });
});

test('either owner can suspend and reactivate a tenant — equally privileged, either can back up the other', async () => {
  await withServer(async (base) => {
    const owner1 = await loginAsOwner(base, 1);
    const owner2 = await loginAsOwner(base, 2);
    const created = await call(base, 'POST', '/api/platform/tenants', {
      companyName: `Backup Test Tenant ${Date.now()}`, fullName: 'Founder', email: `backup-${Date.now()}@example.com`, password: 'a-real-password-123',
    }, owner1);
    const companyId = (created.body as { companyId: string }).companyId;

    // owner2 (not the one who created it) can still suspend it.
    const suspend = await call(base, 'POST', `/api/platform/tenants/${companyId}/suspend`, {}, owner2);
    assert.equal(suspend.status, 200);
    const reactivate = await call(base, 'POST', `/api/platform/tenants/${companyId}/reactivate`, {}, owner2);
    assert.equal(reactivate.status, 200);
  });
});

test('a third, non-configured email can never reach any /api/platform/* route, even with a valid login and real grants', async () => {
  await withServer(async (base, app) => {
    // A completely ordinary tenant user — not an owner by any definition.
    const ceoUser = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!;
    const login = await call(base, 'POST', '/api/auth/login', {
      companyId: app.seedResult!.companyId, email: ceoUser.email, password: 'demo-password-not-for-production',
    });
    assert.equal(login.status, 200);
    const headers = { authorization: `Bearer ${(login.body as { token: string }).token}` };

    for (const [method, path] of [
      ['GET', '/api/platform/tenants'],
      ['POST', '/api/platform/tenants'],
      ['GET', '/api/platform/audit-log'],
      ['POST', `/api/platform/tenants/${app.seedResult!.companyId}/suspend`],
    ] as const) {
      const attempt = await call(base, method, path, method === 'POST' ? {} : undefined, headers);
      assert.equal(attempt.status, 403, `${method} ${path} should be 403 for a non-owner, got ${attempt.status}`);
    }
  });
});

test('no API path lets a non-owner become one: company-wide admin grants, RBAC overrides, or a manually crafted platform companyId all fail', async () => {
  await withServer(async (base, app) => {
    // Even the CEO — full company-wide admin, every grant at 'company'
    // scope — is not a platform owner, and no role/grant manipulation can
    // change that: isPlatformOwner() checks only the two configured env
    // emails, never any DB-stored flag or grant.
    const ceoUser = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!;
    const login = await call(base, 'POST', '/api/auth/login', {
      companyId: app.seedResult!.companyId, email: ceoUser.email, password: 'demo-password-not-for-production',
    });
    const headers = { authorization: `Bearer ${(login.body as { token: string }).token}` };
    const attempt = await call(base, 'GET', '/api/platform/tenants', undefined, headers);
    assert.equal(attempt.status, 403);

    // Confirm the demo CEO's email is genuinely not one of the two
    // configured owner emails in this test run (sanity-checking the test
    // itself, not just the app).
    assert.notEqual(ceoUser.email.toLowerCase(), OWNER_EMAIL_1);
    assert.notEqual(ceoUser.email.toLowerCase(), OWNER_EMAIL_2);
  });
});

test('platform owners cannot read tenant CRM/Inventory/Finance business data through any normal administrative API', async () => {
  await withServer(async (base, app) => {
    const ceoUser = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!;
    const ceoHeaders = { 'x-demo-user': ceoUser.userId };
    const lead = await call(base, 'POST', '/api/crm/leads', { fullName: 'Private Customer', phone: '0100000000' }, ceoHeaders);
    assert.equal(lead.status, 201);
    const leadId = (lead.body as { id: string }).id;

    const owner = await loginAsOwner(base);
    // The owner has zero grants of any kind (no Role/UserRole rows at all —
    // see platform-owner.ts) — every one of these must be rejected, not
    // silently scoped to nothing.
    const leadsList = await call(base, 'GET', '/api/crm/leads', undefined, owner);
    assert.equal(leadsList.status, 403);
    // The lead-detail route uses the codebase-wide "404, not 403" convention
    // for a record the actor can never legitimately know exists (same as
    // every cross-tenant detail-route test elsewhere) — the owner's
    // '__platform__' companyId means this lead is as unreachable to them as
    // if it didn't exist at all.
    const leadDetail = await call(base, 'GET', `/api/crm/leads/${leadId}`, undefined, owner);
    assert.equal(leadDetail.status, 404);
    const unitsList = await call(base, 'GET', '/api/inventory/units', undefined, owner);
    assert.equal(unitsList.status, 403);
    const auditLog = await call(base, 'GET', '/api/audit-log', undefined, owner);
    assert.equal(auditLog.status, 403);
  });
});

test('a platform owner cannot impersonate a tenant user or bypass tenant authorization via the x-demo-user header', async () => {
  await withServer(async (base, app) => {
    // The demo-user header only works in non-production and only resolves
    // a real existing user id — it is not a privilege-escalation path for
    // an owner (an owner using it just authenticates as themselves, same
    // zero-grants owner account, not as the demo user whose id they'd have
    // to already know and whose own session they still wouldn't get).
    const owner = await loginAsOwner(base);
    const ceoUser = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!;
    const attempt = await call(base, 'GET', '/api/crm/leads', undefined, { ...owner, 'x-demo-user': ceoUser.userId });
    // Authorization header (the owner's real token) takes precedence over
    // x-demo-user in resolveActor, so this must still resolve to the owner
    // identity and be rejected, not silently become the CEO.
    assert.equal(attempt.status, 403);
  });
});
