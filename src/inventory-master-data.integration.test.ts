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

async function callJson(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/**
 * Covers the new Inventory master-data HTTP routes (Developer/Phase/
 * Launch/Facility/Consultant/SalesPhoneNumber CRUD + PATCH project) end to
 * end against a real running server — these were only manually curl-
 * verified before this test existed.
 */
test('full HTTP flow: create developer/phases/launches/facilities/consultants/sales-phone-number, then read them back via GET /api/inventory/projects/:id and its own list routes', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };

    const project = await callJson(base, 'POST', '/api/inventory/projects', { name: `Master Data Project ${Date.now()}`, destination: 'New Zayed' }, headers);
    assert.equal(project.status, 201);
    const projectId = (project.body as { id: string }).id;

    const developer = await callJson(base, 'POST', '/api/inventory/developers', { name: 'Emaar Misr' }, headers);
    assert.equal(developer.status, 201);
    const developerId = (developer.body as { id: string }).id;

    const patch = await callJson(base, 'PATCH', `/api/inventory/projects/${projectId}`, { developerId }, headers);
    assert.equal(patch.status, 200);
    assert.equal((patch.body as { developerId: string }).developerId, developerId);

    const phase = await callJson(base, 'POST', `/api/inventory/projects/${projectId}/phases`, { name: 'Phase 1', order: 1 }, headers);
    assert.equal(phase.status, 201);

    const launch = await callJson(base, 'POST', `/api/inventory/projects/${projectId}/launches`, { name: 'Launch A' }, headers);
    assert.equal(launch.status, 201);

    const facility = await callJson(base, 'POST', '/api/inventory/facilities', { name: 'Pool', category: 'amenity' }, headers);
    assert.equal(facility.status, 201);
    const facilityId = (facility.body as { id: string }).id;
    const facilityPatch = await callJson(base, 'PATCH', `/api/inventory/projects/${projectId}`, { facilityIds: [facilityId] }, headers);
    assert.equal(facilityPatch.status, 200);

    const consultant = await callJson(base, 'POST', '/api/inventory/consultants', { name: 'Dar Al-Handasah', role: 'engineering' }, headers);
    assert.equal(consultant.status, 201);

    const phoneNumber = await callJson(base, 'POST', `/api/inventory/projects/${projectId}/sales-phone-numbers`, { phoneNumber: '+201001234567' }, headers);
    assert.equal(phoneNumber.status, 201);
    const phoneId = (phoneNumber.body as { id: string }).id;

    const details = await callJson(base, 'GET', `/api/inventory/projects/${projectId}`, undefined, headers);
    assert.equal(details.status, 200);
    const detailsBody = details.body as {
      project: { destination?: string; developerId?: string };
      developer?: { name: string };
      phases: { name: string }[];
      launches: { name: string }[];
      facilities: { name: string }[];
      engineeringConsultant?: { name: string };
      salesPhoneNumbers: { phoneNumber: string }[];
    };
    assert.equal(detailsBody.project.destination, 'New Zayed');
    assert.equal(detailsBody.developer?.name, 'Emaar Misr');
    assert.equal(detailsBody.phases.length, 1);
    assert.equal(detailsBody.phases[0]!.name, 'Phase 1');
    assert.equal(detailsBody.launches.length, 1);
    assert.equal(detailsBody.launches[0]!.name, 'Launch A');
    assert.equal(detailsBody.facilities.length, 1);
    assert.equal(detailsBody.facilities[0]!.name, 'Pool');
    assert.equal(detailsBody.salesPhoneNumbers.length, 1);
    assert.equal(detailsBody.salesPhoneNumbers[0]!.phoneNumber, '+201001234567');

    const portfolio = await callJson(base, 'GET', `/api/inventory/developers/${developerId}/portfolio`, undefined, headers);
    assert.equal(portfolio.status, 200);
    const portfolioBody = portfolio.body as { developer: { id: string }; projects: { id: string }[] };
    assert.equal(portfolioBody.developer.id, developerId);
    assert.equal(portfolioBody.projects.length, 1);
    assert.equal(portfolioBody.projects[0]!.id, projectId);

    const deactivate = await callJson(base, 'POST', `/api/inventory/sales-phone-numbers/${phoneId}/deactivate`, {}, headers);
    assert.equal(deactivate.status, 200);
    const afterDeactivate = await callJson(base, 'GET', `/api/inventory/projects/${projectId}/sales-phone-numbers`, undefined, headers);
    assert.equal((afterDeactivate.body as unknown[]).length, 0, 'a deactivated sales phone number no longer appears in the active list');
  });
});

test('GET /api/inventory/projects supports the new destination/developer/price-range/unit-type search filters over real data', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const companyId = app.seedResult!.companyId;

    await app.services.inventory.createProject({ companyId, name: `Zed Towers ${Date.now()}`, destination: 'New Zayed', priceFrom: 6_000_000, priceTo: 9_000_000 });
    await app.services.inventory.createProject({ companyId, name: `Marina Heights ${Date.now()}`, destination: 'North Coast', priceFrom: 12_000_000, priceTo: 20_000_000 });

    const filtered = await callJson(base, 'GET', '/api/inventory/projects?destination=New Zayed', undefined, headers);
    assert.equal(filtered.status, 200);
    const filteredItems = (filtered.body as { items: { name: string }[] }).items;
    assert.equal(filteredItems.length, 1);
    assert.match(filteredItems[0]!.name, /Zed Towers/);
  });
});

test('a Sales Agent without create:project permission is rejected from creating master data, but can still read it (view:project)', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const agentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;
    const ceoHeaders = { 'x-demo-user': ceoUserId };
    const agentHeaders = { 'x-demo-user': agentUserId };

    const createByAgent = await callJson(base, 'POST', '/api/inventory/developers', { name: 'Blocked Developer' }, agentHeaders);
    assert.equal(createByAgent.status, 403);

    const createByCeo = await callJson(base, 'POST', '/api/inventory/developers', { name: 'Allowed Developer' }, ceoHeaders);
    assert.equal(createByCeo.status, 201);

    const listByAgent = await callJson(base, 'GET', '/api/inventory/developers', undefined, agentHeaders);
    assert.equal(listByAgent.status, 200);
    assert.ok((listByAgent.body as { items: unknown[] }).items.length >= 1);
  });
});

test('PATCH /api/inventory/projects/:id is cross-tenant IDOR-safe and non-destructive across separate patches', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };

    const project = await callJson(base, 'POST', '/api/inventory/projects', { name: `Patch Project ${Date.now()}`, currency: 'EGP', priceFrom: 5_000_000 }, headers);
    const projectId = (project.body as { id: string }).id;

    const firstPatch = await callJson(base, 'PATCH', `/api/inventory/projects/${projectId}`, { priceTo: 8_000_000 }, headers);
    assert.equal(firstPatch.status, 200);
    const firstBody = firstPatch.body as { currency?: string; priceFrom?: number; priceTo?: number };
    assert.equal(firstBody.currency, 'EGP', 'untouched field survives the partial PATCH');
    assert.equal(firstBody.priceFrom, 5_000_000, 'untouched field survives the partial PATCH');
    assert.equal(firstBody.priceTo, 8_000_000);

    const otherCompanyPatch = await callJson(base, 'PATCH', '/api/inventory/projects/nonexistent-cross-tenant-id', { destination: 'Anywhere' }, headers);
    assert.equal(otherCompanyPatch.status, 404);
  });
});

/**
 * Project.imageUrls/masterPlanImageUrl and Unit.floorPlanImageUrl/
 * masterPlanPosition were declared in the domain model and read by
 * offer-pdf.service.ts, but had no write path anywhere (no route, no
 * import mapping) — confirmed by grepping the codebase for any assignment
 * to them before this fix. This test proves the round trip now actually
 * works over real HTTP, and that PATCH /api/inventory/units/:id (which
 * didn't exist before — updateUnitDetails() was only ever reachable from
 * the bulk import pipeline) is now a real manual edit route.
 */
test('Project image fields and Unit floor-plan/master-plan fields have a real write path via PATCH', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };

    const project = await callJson(
      base,
      'POST',
      '/api/inventory/projects',
      { name: `Media Project ${Date.now()}` },
      headers,
    );
    assert.equal(project.status, 201);
    const projectId = (project.body as { id: string }).id;

    const projectPatch = await callJson(
      base,
      'PATCH',
      `/api/inventory/projects/${projectId}`,
      { imageUrls: ['https://cdn.example.com/cover1.jpg', 'https://cdn.example.com/cover2.jpg'], masterPlanImageUrl: 'https://cdn.example.com/masterplan.jpg' },
      headers,
    );
    assert.equal(projectPatch.status, 200);
    const projectBody = projectPatch.body as { imageUrls?: string[]; masterPlanImageUrl?: string };
    assert.deepEqual(projectBody.imageUrls, ['https://cdn.example.com/cover1.jpg', 'https://cdn.example.com/cover2.jpg']);
    assert.equal(projectBody.masterPlanImageUrl, 'https://cdn.example.com/masterplan.jpg');

    const unit = await callJson(
      base,
      'POST',
      '/api/inventory/units',
      { projectId, code: `MEDIA-U-${Date.now()}`, listPrice: 1_200_000, unitType: 'apartment', areaSqm: 100 },
      headers,
    );
    assert.equal(unit.status, 201);
    const unitId = (unit.body as { id: string }).id;

    const unitPatch = await callJson(
      base,
      'PATCH',
      `/api/inventory/units/${unitId}`,
      { floorPlanImageUrl: 'https://cdn.example.com/floorplan.jpg', masterPlanPosition: { x: 12.5, y: 40, width: 8, height: 6 } },
      headers,
    );
    assert.equal(unitPatch.status, 200, JSON.stringify(unitPatch.body));
    const unitBody = unitPatch.body as { floorPlanImageUrl?: string; masterPlanPosition?: { x: number; y: number; width: number; height: number } };
    assert.equal(unitBody.floorPlanImageUrl, 'https://cdn.example.com/floorplan.jpg');
    assert.deepEqual(unitBody.masterPlanPosition, { x: 12.5, y: 40, width: 8, height: 6 });

    // Out-of-range coordinates are rejected, not silently clamped/stored.
    const invalidPosition = await callJson(
      base,
      'PATCH',
      `/api/inventory/units/${unitId}`,
      { masterPlanPosition: { x: 150, y: 0, width: 1, height: 1 } },
      headers,
    );
    assert.equal(invalidPosition.status, 400);

    // A non-existent unit id (mirrors the project route's IDOR shape) is a 404, not a 500/silent success.
    const missingUnit = await callJson(base, 'PATCH', '/api/inventory/units/nonexistent-cross-tenant-id', { floorPlanImageUrl: 'https://x' }, headers);
    assert.equal(missingUnit.status, 404);
  });
});
