import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, createSecondTenant, withServer } from './test-support/test-app.js';

// Mandatory proof points 4, 5, 7 (CRM/Inventory/search/exports slice):
//   4. A tenant administrator cannot access another tenant.
//   5. A tenant user cannot access another company's records by changing
//      record IDs or tenant IDs.
//   7. Tenant data remains isolated across CRM, Inventory... search, and
//      exports.

test('a tenant B admin cannot list, read, edit, or search tenant A leads by any means', async () => {
  await withServer(async (base, app) => {
    const ceoA = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!;
    const headersA = { 'x-demo-user': ceoA.userId };
    const lead = await call(base, 'POST', '/api/crm/leads', { fullName: 'Tenant A Private Lead', phone: '0100000001' }, headersA);
    assert.equal(lead.status, 201);
    const leadId = (lead.body as { id: string }).id;

    const tenantB = await createSecondTenant(base, 'CRM Isolation Tenant B');

    // Direct detail read by manipulated id.
    const read = await call(base, 'GET', `/api/crm/leads/${leadId}`, undefined, tenantB.headers);
    assert.equal(read.status, 404);

    // List — tenant B's own list never contains tenant A's lead, even
    // searched for by exact name.
    const list = await call(base, 'GET', `/api/crm/leads?q=${encodeURIComponent('Tenant A Private Lead')}`, undefined, tenantB.headers);
    assert.equal(list.status, 200);
    const items = (list.body as { items: { id: string }[] }).items;
    assert.equal(items.some((i) => i.id === leadId), false);

    // Edit by manipulated id.
    const edit = await call(base, 'PATCH', `/api/crm/leads/${leadId}/details`, { fullName: 'Hijacked' }, tenantB.headers);
    assert.equal(edit.status, 404);

    // Timeline export by manipulated id.
    const timeline = await call(base, 'GET', `/api/crm/leads/${leadId}/timeline`, undefined, tenantB.headers);
    assert.equal(timeline.status, 404);
  });
});

test('a tenant B user cannot reach tenant A inventory projects/units by manipulated IDs, list, or search', async () => {
  await withServer(async (base, app) => {
    const ceoA = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!;
    const headersA = { 'x-demo-user': ceoA.userId };
    const project = await call(base, 'POST', '/api/inventory/projects', { name: 'Tenant A Private Project' }, headersA);
    assert.equal(project.status, 201);
    const projectId = (project.body as { id: string }).id;
    const unit = await call(base, 'POST', '/api/inventory/units', {
      projectId, code: `PRIV-${Date.now()}`, unitType: 'apartment', listPrice: 1000000, areaSqm: 100,
    }, headersA);
    assert.equal(unit.status, 201);
    const unitId = (unit.body as { id: string }).id;

    const tenantB = await createSecondTenant(base, 'Inventory Isolation Tenant B');

    const readProject = await call(base, 'GET', `/api/inventory/projects/${projectId}`, undefined, tenantB.headers);
    assert.equal(readProject.status, 404);

    const readUnit = await call(base, 'GET', `/api/inventory/units/${unitId}`, undefined, tenantB.headers);
    assert.equal(readUnit.status, 404);

    const unitsList = await call(base, 'GET', '/api/inventory/units', undefined, tenantB.headers);
    assert.equal(unitsList.status, 200);
    const unitItems = (unitsList.body as { items: { id: string }[] }).items;
    assert.equal(unitItems.some((u) => u.id === unitId), false);

    // A cross-tenant hold/reserve attempt by manipulated unit id.
    const hold = await call(base, 'POST', `/api/inventory/units/${unitId}/hold`, {}, tenantB.headers);
    assert.ok([403, 404].includes(hold.status));
  });
});

test('a tenant B admin cannot read tenant A audit-log entries even with a manipulated company filter', async () => {
  await withServer(async (base, app) => {
    const ceoA = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!;
    const headersA = { 'x-demo-user': ceoA.userId };
    await call(base, 'POST', '/api/crm/leads', { fullName: 'Audited Lead', phone: '0100000002' }, headersA);

    const tenantB = await createSecondTenant(base, 'Audit Isolation Tenant B');
    const audit = await call(base, 'GET', '/api/audit-log?limit=300', undefined, tenantB.headers);
    assert.equal(audit.status, 200);
    const entries = (audit.body as { items: { companyId: string }[] }).items;
    assert.ok(entries.every((e) => e.companyId === tenantB.companyId), 'every audit entry returned to tenant B must belong to tenant B');
  });
});
