import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository, type Repository } from '../../infra/repository.js';
import { InventoryService, computePricePerMeter } from './inventory.service.js';
import type { Consultant, Developer, Facility, Launch, Project, ProjectFavorite, ProjectPhase, ProjectUnitSpec, Reservation, SalesPhoneNumber, Unit, UnitHold } from '../../domain/types.js';

function freshService() {
  return new InventoryService(
    new InMemoryRepository<Unit>(),
    new InMemoryRepository<UnitHold>(),
    new InMemoryRepository<Reservation>(),
    new InMemoryRepository<Project>(),
  );
}

function freshFullService() {
  return new InventoryService(
    new InMemoryRepository<Unit>(),
    new InMemoryRepository<UnitHold>(),
    new InMemoryRepository<Reservation>(),
    new InMemoryRepository<Project>(),
    new InMemoryRepository<Developer>(),
    new InMemoryRepository<ProjectPhase>(),
    new InMemoryRepository<Launch>(),
    new InMemoryRepository<Facility>(),
    new InMemoryRepository<Consultant>(),
    new InMemoryRepository<SalesPhoneNumber>(),
    new InMemoryRepository<ProjectUnitSpec>(),
    new InMemoryRepository<ProjectFavorite>(),
  );
}

test('creating a unit validates required fields', async () => {
  const svc = freshService();
  await assert.rejects(() => svc.createUnit({ companyId: 'c1', projectId: 'p1', code: '', unitType: 'apartment', areaSqm: 100, listPrice: 1000 }));
});

test('creating a project then listing it scoped to the company', async () => {
  const svc = freshService();
  await svc.createProject({ companyId: 'c1', name: 'Marina Towers', location: 'North Coast' });
  await svc.createProject({ companyId: 'c2', name: 'Other Co Project' });
  const projects = await svc.listProjects('c1');
  assert.equal(projects.length, 1);
  assert.equal(projects[0]!.name, 'Marina Towers');
});

test('creating a project rejects an empty name', async () => {
  const svc = freshService();
  await assert.rejects(() => svc.createProject({ companyId: 'c1', name: '' }));
});

test('creating a unit with a free-text projectId that does not match a real Project still succeeds (backward compatible)', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'legacy-free-text-id', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  assert.equal(unit.projectId, 'legacy-free-text-id');
});

test('duplicate unit code within the same company is rejected', async () => {
  const svc = freshService();
  await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-101', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  await assert.rejects(() => svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-101', unitType: 'apartment', areaSqm: 100, listPrice: 1000 }));
});

test('the same unit code is allowed across two different companies (multi-tenant isolation)', async () => {
  const svc = freshService();
  const u1 = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-101', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  const u2 = await svc.createUnit({ companyId: 'c2', projectId: 'p1', code: 'A-101', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  assert.notEqual(u1.id, u2.id);
});

test('listUnits filters by projectId when provided', async () => {
  const svc = freshService();
  await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  await svc.createUnit({ companyId: 'c1', projectId: 'p2', code: 'A-2', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  const result = await svc.listUnits('c1', 'p1');
  assert.equal(result.length, 1);
  assert.equal(result[0]!.code, 'A-1');
});

test('holding an available unit transitions it to held', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  await svc.holdUnit(unit.id, 'user-1', 'c1');
  const refreshed = await svc.getUnit(unit.id);
  assert.equal(refreshed!.status, 'held');
});

test('holding a non-available unit fails', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  await svc.holdUnit(unit.id, 'user-1', 'c1');
  await assert.rejects(() => svc.holdUnit(unit.id, 'user-2', 'c1'));
});

test('holding a unit belonging to a different company is rejected (cross-tenant IDOR)', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  await assert.rejects(() => svc.holdUnit(unit.id, 'user-1', 'c2'));
});

test('reserving an available unit transitions it to reserved and creates a Reservation', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  const reservation = await svc.reserveUnit(unit.id, 'lead-1', 'c1');
  const refreshed = await svc.getUnit(unit.id);
  assert.equal(refreshed!.status, 'reserved');
  assert.equal(reservation.status, 'active');
  assert.equal(reservation.clientId, 'lead-1');
});

test('listReservations returns only this company\'s reservations, optionally filtered by status', async () => {
  const svc = freshService();
  const unitA = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  const unitB = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-2', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  const unitOther = await svc.createUnit({ companyId: 'c2', projectId: 'p1', code: 'B-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  await svc.reserveUnit(unitA.id, 'lead-1', 'c1');
  await svc.reserveUnit(unitB.id, 'lead-2', 'c1');
  await svc.reserveUnit(unitOther.id, 'lead-3', 'c2');

  const all = await svc.listReservations('c1');
  assert.equal(all.length, 2);
  assert.ok(all.every((r) => r.companyId === 'c1'));

  const active = await svc.listReservations('c1', 'active');
  assert.equal(active.length, 2);
  const converted = await svc.listReservations('c1', 'converted');
  assert.equal(converted.length, 0);
});

test('reserving an already-reserved unit fails', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  await svc.reserveUnit(unit.id, 'lead-1', 'c1');
  await assert.rejects(() => svc.reserveUnit(unit.id, 'lead-2', 'c1'));
});

test('reserving a unit belonging to a different company is rejected (cross-tenant IDOR)', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  await assert.rejects(() => svc.reserveUnit(unit.id, 'lead-1', 'c2'));
});

test('markContracted transitions a unit to contracted', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  await svc.reserveUnit(unit.id, 'lead-1', 'c1');
  await svc.markContracted(unit.id);
  const refreshed = await svc.getUnit(unit.id);
  assert.equal(refreshed!.status, 'contracted');
});

test('updateUnitDetails updates type/area/price on an available unit', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  const updated = await svc.updateUnitDetails(unit.id, 'c1', { unitType: 'villa', areaSqm: 150, listPrice: 2000 });
  assert.equal(updated.unitType, 'villa');
  assert.equal(updated.areaSqm, 150);
  assert.equal(updated.listPrice, 2000);
  assert.equal(updated.status, 'available');
});

test('updateUnitDetails refuses to touch a reserved unit', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  await svc.reserveUnit(unit.id, 'lead-1', 'c1');
  await assert.rejects(() => svc.updateUnitDetails(unit.id, 'c1', { listPrice: 2000 }), /reserved/);
  const stillOriginal = await svc.getUnit(unit.id);
  assert.equal(stillOriginal!.listPrice, 1000);
});

test('updateUnitDetails refuses to touch a contracted (sold) unit', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  await svc.reserveUnit(unit.id, 'lead-1', 'c1');
  await svc.markContracted(unit.id);
  await assert.rejects(() => svc.updateUnitDetails(unit.id, 'c1', { listPrice: 2000 }), /contracted/);
});

test('updateUnitDetails rejects a unit belonging to a different company (cross-tenant IDOR)', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  await assert.rejects(() => svc.updateUnitDetails(unit.id, 'c2', { listPrice: 2000 }));
});

test('updateUnitDetails rejects a non-positive areaSqm or listPrice', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  await assert.rejects(() => svc.updateUnitDetails(unit.id, 'c1', { areaSqm: -5 }));
  await assert.rejects(() => svc.updateUnitDetails(unit.id, 'c1', { listPrice: 0 }));
});

test('markReservationConverted flips the reservation status', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  const reservation = await svc.reserveUnit(unit.id, 'lead-1', 'c1');
  const updated = await svc.markReservationConverted(reservation.id);
  assert.equal(updated.status, 'converted');
});

test('concurrency: 8 concurrent reserve calls on the same unit produce exactly 1 winner', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  const attempts = Array.from({ length: 8 }, (_, i) =>
    svc.reserveUnit(unit.id, `lead-${i}`, 'c1').then(
      () => 'ok' as const,
      () => 'fail' as const,
    ),
  );
  const results = await Promise.all(attempts);
  const wins = results.filter((r) => r === 'ok').length;
  assert.equal(wins, 1);
  const refreshed = await svc.getUnit(unit.id);
  assert.equal(refreshed!.status, 'reserved');
});

test('sweepExpiredReservationsDetailed releases the unit and cancels the reservation once expiresAt has passed', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  const reservation = await svc.reserveUnit(unit.id, 'lead-1', 'c1');
  const future = new Date(Date.parse(reservation.expiresAt) + 1000);

  const swept = await svc.sweepExpiredReservationsDetailed(future);
  assert.equal(swept.length, 1);
  assert.equal(swept[0]!.id, reservation.id);
  assert.equal(swept[0]!.status, 'cancelled');

  const refreshedUnit = await svc.getUnit(unit.id);
  assert.equal(refreshedUnit!.status, 'available');
});

test('sweepExpiredReservationsDetailed never touches a reservation that has not expired yet', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  await svc.reserveUnit(unit.id, 'lead-1', 'c1');

  const swept = await svc.sweepExpiredReservationsDetailed(new Date());
  assert.equal(swept.length, 0);
  const refreshedUnit = await svc.getUnit(unit.id);
  assert.equal(refreshedUnit!.status, 'reserved');
});

test('sweepExpiredReservationsDetailed never downgrades a unit that has since been contracted', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  const reservation = await svc.reserveUnit(unit.id, 'lead-1', 'c1');
  await svc.markContracted(unit.id);
  const future = new Date(Date.parse(reservation.expiresAt) + 1000);

  const swept = await svc.sweepExpiredReservationsDetailed(future);
  assert.equal(swept.length, 1, 'the reservation itself still expires (it never converted)');
  const refreshedUnit = await svc.getUnit(unit.id);
  assert.equal(refreshedUnit!.status, 'contracted', 'a contracted unit is never downgraded back to available');
});

test('sweepExpiredReservationsDetailed never touches an already-converted or already-cancelled reservation', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  const reservation = await svc.reserveUnit(unit.id, 'lead-1', 'c1');
  await svc.markReservationConverted(reservation.id);
  const future = new Date(Date.parse(reservation.expiresAt) + 1000);

  const swept = await svc.sweepExpiredReservationsDetailed(future);
  assert.equal(swept.length, 0);
});

test('sweepExpiredReservations returns just the count', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  const reservation = await svc.reserveUnit(unit.id, 'lead-1', 'c1');
  const future = new Date(Date.parse(reservation.expiresAt) + 1000);
  const count = await svc.sweepExpiredReservations(future);
  assert.equal(count, 1);
});

test('concurrency: 8 concurrent hold calls on the same unit produce exactly 1 winner', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  const attempts = Array.from({ length: 8 }, (_, i) =>
    svc.holdUnit(unit.id, `user-${i}`, 'c1').then(
      () => 'ok' as const,
      () => 'fail' as const,
    ),
  );
  const results = await Promise.all(attempts);
  const wins = results.filter((r) => r === 'ok').length;
  assert.equal(wins, 1);
});

// ---- computePricePerMeter ----

test('computePricePerMeter divides listPrice by areaSqm when no override is set', () => {
  assert.equal(computePricePerMeter({ listPrice: 2_000_000, areaSqm: 200, pricePerMeterOverride: undefined }), 10_000);
});

test('computePricePerMeter returns the explicit override untouched, never recomputing it', () => {
  assert.equal(computePricePerMeter({ listPrice: 2_000_000, areaSqm: 200, pricePerMeterOverride: 12_345 }), 12_345);
});

test('computePricePerMeter returns undefined when areaSqm is 0 (nothing sane to divide by)', () => {
  assert.equal(computePricePerMeter({ listPrice: 2_000_000, areaSqm: 0, pricePerMeterOverride: undefined }), undefined);
});

// ---- requireRepo guard: methods on unconfigured repos fail loudly, not silently ----

test('calling a new-entity method on a service built without those repos throws a clear 500, not a crash', async () => {
  const svc = freshService();
  await assert.rejects(() => svc.createDeveloper({ companyId: 'c1', name: 'Acme Developments' }), /Developer repository is not configured/);
});

// ---- Developer ----

test('createDeveloper validates name and resolveOrCreateDeveloper reuses an existing developer case-insensitively', async () => {
  const svc = freshFullService();
  await assert.rejects(() => svc.createDeveloper({ companyId: 'c1', name: '' }));
  const first = await svc.resolveOrCreateDeveloper('c1', 'Palm Hills Developments');
  const second = await svc.resolveOrCreateDeveloper('c1', 'palm hills developments');
  assert.equal(first.id, second.id);
  const all = await svc.listDevelopers('c1');
  assert.equal(all.length, 1);
});

test('getDeveloperPortfolio returns real Projects referencing the developer, scoped by company', async () => {
  const svc = freshFullService();
  const dev = await svc.createDeveloper({ companyId: 'c1', name: 'Emaar' });
  await svc.createProject({ companyId: 'c1', name: 'Marassi', developerId: dev.id });
  await svc.createProject({ companyId: 'c1', name: 'Unrelated Project' });
  await svc.createProject({ companyId: 'c2', name: 'Other Co Emaar Project', developerId: dev.id });
  const portfolio = await svc.getDeveloperPortfolio(dev.id, 'c1');
  assert.equal(portfolio.length, 1);
  assert.equal(portfolio[0]!.name, 'Marassi');
});

// ---- ProjectPhase ----

test('createProjectPhase validates required fields and listProjectPhases sorts by order', async () => {
  const svc = freshFullService();
  await assert.rejects(() => svc.createProjectPhase({ companyId: 'c1', projectId: '', name: 'Phase 1' }));
  await assert.rejects(() => svc.createProjectPhase({ companyId: 'c1', projectId: 'p1', name: '' }));
  await svc.createProjectPhase({ companyId: 'c1', projectId: 'p1', name: 'Phase 2', order: 2 });
  await svc.createProjectPhase({ companyId: 'c1', projectId: 'p1', name: 'Phase 1', order: 1 });
  const phases = await svc.listProjectPhases('c1', 'p1');
  assert.deepEqual(phases.map((p) => p.name), ['Phase 1', 'Phase 2']);
});

// ---- Launch ----

test('createLaunch validates required fields and listLaunches filters by project', async () => {
  const svc = freshFullService();
  await assert.rejects(() => svc.createLaunch({ companyId: 'c1', projectId: 'p1', name: '' }));
  await svc.createLaunch({ companyId: 'c1', projectId: 'p1', name: 'Launch A' });
  await svc.createLaunch({ companyId: 'c1', projectId: 'p2', name: 'Launch B' });
  const launches = await svc.listLaunches('c1', 'p1');
  assert.equal(launches.length, 1);
  assert.equal(launches[0]!.name, 'Launch A');
});

// ---- Facility ----

test('resolveOrCreateFacility reuses by case-insensitive name, and getProjectFacilities resolves ids to real rows', async () => {
  const svc = freshFullService();
  const pool = await svc.resolveOrCreateFacility('c1', 'Swimming Pool');
  const poolAgain = await svc.resolveOrCreateFacility('c1', 'swimming pool');
  assert.equal(pool.id, poolAgain.id);
  const gym = await svc.createFacility({ companyId: 'c1', name: 'Gym' });
  const project = await svc.createProject({ companyId: 'c1', name: 'Project X', facilityIds: [pool.id, gym.id] });
  const facilities = await svc.getProjectFacilities(project.id, 'c1');
  assert.deepEqual(facilities.map((f) => f.name).sort(), ['Gym', 'Swimming Pool']);
});

test('getProjectFacilities rejects a project belonging to a different company', async () => {
  const svc = freshFullService();
  const project = await svc.createProject({ companyId: 'c1', name: 'Project X' });
  await assert.rejects(() => svc.getProjectFacilities(project.id, 'c2'));
});

// ---- Consultant ----

test('resolveOrCreateConsultant reuses by name+role, and listConsultants filters by role', async () => {
  const svc = freshFullService();
  const eng1 = await svc.resolveOrCreateConsultant('c1', 'Dar Al-Handasah', 'engineering');
  const eng2 = await svc.resolveOrCreateConsultant('c1', 'dar al-handasah', 'engineering');
  assert.equal(eng1.id, eng2.id);
  await svc.createConsultant({ companyId: 'c1', name: 'PM Co', role: 'project_management' });
  const engineers = await svc.listConsultants('c1', 'engineering');
  assert.equal(engineers.length, 1);
  assert.equal(engineers[0]!.role, 'engineering');
});

// ---- SalesPhoneNumber ----

test('createSalesPhoneNumber validates required fields, listSalesPhoneNumbers only returns active numbers, deactivate flips isActive', async () => {
  const svc = freshFullService();
  await assert.rejects(() => svc.createSalesPhoneNumber({ companyId: 'c1', projectId: 'p1', phoneNumber: '' }));
  const phone = await svc.createSalesPhoneNumber({ companyId: 'c1', projectId: 'p1', phoneNumber: '+201001234567' });
  let active = await svc.listSalesPhoneNumbers('c1', 'p1');
  assert.equal(active.length, 1);
  await svc.deactivateSalesPhoneNumber(phone.id, 'c1');
  active = await svc.listSalesPhoneNumbers('c1', 'p1');
  assert.equal(active.length, 0);
});

test('deactivateSalesPhoneNumber rejects a number belonging to a different company (cross-tenant IDOR)', async () => {
  const svc = freshFullService();
  const phone = await svc.createSalesPhoneNumber({ companyId: 'c1', projectId: 'p1', phoneNumber: '+201001234567' });
  await assert.rejects(() => svc.deactivateSalesPhoneNumber(phone.id, 'c2'));
});

// ---- getProjectFullDetails ----

test('getProjectFullDetails joins developer/phases/launches/facilities/consultants/sales numbers for one project', async () => {
  const svc = freshFullService();
  const dev = await svc.createDeveloper({ companyId: 'c1', name: 'Sodic' });
  const eng = await svc.createConsultant({ companyId: 'c1', name: 'ECG', role: 'engineering' });
  const pool = await svc.createFacility({ companyId: 'c1', name: 'Pool' });
  const project = await svc.createProject({ companyId: 'c1', name: 'Villette', developerId: dev.id, engineeringConsultantId: eng.id, facilityIds: [pool.id] });
  await svc.createProjectPhase({ companyId: 'c1', projectId: project.id, name: 'Phase 1' });
  await svc.createLaunch({ companyId: 'c1', projectId: project.id, name: 'Launch 1' });
  await svc.createSalesPhoneNumber({ companyId: 'c1', projectId: project.id, phoneNumber: '+201000000000' });

  const details = await svc.getProjectFullDetails(project.id, 'c1');
  assert.equal(details.developer?.id, dev.id);
  assert.equal(details.phases.length, 1);
  assert.equal(details.launches.length, 1);
  assert.equal(details.facilities.length, 1);
  assert.equal(details.engineeringConsultant?.id, eng.id);
  assert.equal(details.salesPhoneNumbers.length, 1);
});

test('getProjectFullDetails rejects a project belonging to a different company', async () => {
  const svc = freshFullService();
  const project = await svc.createProject({ companyId: 'c1', name: 'Villette' });
  await assert.rejects(() => svc.getProjectFullDetails(project.id, 'c2'));
});

// ---- updateProjectDetails: non-destructive merge ----

test('updateProjectDetails only overwrites fields explicitly present in the patch, keeping everything else', async () => {
  const svc = freshFullService();
  const project = await svc.createProject({ companyId: 'c1', name: 'North Coast Villas', destination: 'North Coast', currency: 'EGP', priceFrom: 5_000_000 });
  const updated = await svc.updateProjectDetails(project.id, 'c1', { priceTo: 8_000_000 });
  assert.equal(updated.destination, 'North Coast', 'untouched field survives the partial update');
  assert.equal(updated.currency, 'EGP', 'untouched field survives the partial update');
  assert.equal(updated.priceFrom, 5_000_000, 'untouched field survives the partial update');
  assert.equal(updated.priceTo, 8_000_000, 'the one explicitly-patched field is applied');
});

test('updateProjectDetails rejects a project belonging to a different company', async () => {
  const svc = freshFullService();
  const project = await svc.createProject({ companyId: 'c1', name: 'Project X' });
  await assert.rejects(() => svc.updateProjectDetails(project.id, 'c2', { destination: 'New Cairo' }));
});

test('updateProjectDetails validates percent fields stay within 0-100', async () => {
  const svc = freshFullService();
  const project = await svc.createProject({ companyId: 'c1', name: 'Project X' });
  await assert.rejects(() => svc.updateProjectDetails(project.id, 'c1', { cashDiscountPercent: 150 }));
  await assert.rejects(() => svc.updateProjectDetails(project.id, 'c1', { maintenanceFeePercent: -5 }));
});

// ---- searchProjects ----

test('searchProjects filters by destination, developerId, price range, unit type, and free text', async () => {
  const svc = freshFullService();
  const dev = await svc.createDeveloper({ companyId: 'c1', name: 'Ora' });
  await svc.createProject({ companyId: 'c1', name: 'Zed Towers', destination: 'New Zayed', developerId: dev.id, priceFrom: 6_000_000, priceTo: 9_000_000, typeOfUnits: ['apartment', 'duplex'] });
  await svc.createProject({ companyId: 'c1', name: 'Marina Heights', destination: 'North Coast', priceFrom: 12_000_000, priceTo: 20_000_000, typeOfUnits: ['chalet'] });

  const byDestination = await svc.searchProjects('c1', { destination: 'New Zayed' });
  assert.equal(byDestination.length, 1);
  assert.equal(byDestination[0]!.name, 'Zed Towers');

  const byDeveloper = await svc.searchProjects('c1', { developerId: dev.id });
  assert.equal(byDeveloper.length, 1);

  const byPrice = await svc.searchProjects('c1', { minPriceFrom: 5_000_000, maxPriceTo: 10_000_000 });
  assert.equal(byPrice.length, 1);
  assert.equal(byPrice[0]!.name, 'Zed Towers');

  const byUnitType = await svc.searchProjects('c1', { unitType: 'chalet' });
  assert.equal(byUnitType.length, 1);
  assert.equal(byUnitType[0]!.name, 'Marina Heights');

  const byText = await svc.searchProjects('c1', { q: 'marina' });
  assert.equal(byText.length, 1);
  assert.equal(byText[0]!.name, 'Marina Heights');
});

test('searchProjects is scoped to the company and clamps limit to [1,200]', async () => {
  const svc = freshFullService();
  await svc.createProject({ companyId: 'c1', name: 'Project A' });
  await svc.createProject({ companyId: 'c2', name: 'Project B' });
  const results = await svc.searchProjects('c1', { limit: 0 });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.name, 'Project A');
});

test('searchProjects sorts by newest, price ascending, and price descending', async () => {
  const svc = freshFullService();
  const cheap = await svc.createProject({ companyId: 'c1', name: 'Cheap', priceFrom: 1_000_000, priceTo: 2_000_000 });
  await new Promise((r) => setTimeout(r, 2));
  const pricey = await svc.createProject({ companyId: 'c1', name: 'Pricey', priceFrom: 9_000_000, priceTo: 12_000_000 });

  const newest = await svc.searchProjects('c1', { sort: 'newest' });
  assert.deepEqual(newest.map((p) => p.id), [pricey.id, cheap.id]);

  const asc = await svc.searchProjects('c1', { sort: 'price_asc' });
  assert.deepEqual(asc.map((p) => p.id), [cheap.id, pricey.id]);

  const desc = await svc.searchProjects('c1', { sort: 'price_desc' });
  assert.deepEqual(desc.map((p) => p.id), [pricey.id, cheap.id]);
});

test('searchProjects filters by bedrooms via the project catalog unit specs, falling back to physical units when no specs exist', async () => {
  const svc = freshFullService();
  const withSpec = await svc.createProject({ companyId: 'c1', name: 'Has Spec' });
  await svc.createProjectUnitSpec({ companyId: 'c1', projectId: withSpec.id, unitType: 'apartment', bedrooms: 3 });
  const withUnitOnly = await svc.createProject({ companyId: 'c1', name: 'Has Unit Only' });
  await svc.createUnit({ companyId: 'c1', projectId: withUnitOnly.id, code: 'U1', unitType: 'apartment', areaSqm: 100, listPrice: 1_000_000, bedrooms: 2 });
  await svc.createProject({ companyId: 'c1', name: 'No Match' });

  const threeBed = await svc.searchProjects('c1', { bedrooms: 3 });
  assert.deepEqual(threeBed.map((p) => p.name), ['Has Spec']);

  const twoBed = await svc.searchProjects('c1', { bedrooms: 2 });
  assert.deepEqual(twoBed.map((p) => p.name), ['Has Unit Only']);
});

// ---- Project favorites ----

test('addProjectFavorite is idempotent, removeProjectFavorite un-favorites, and listFavoriteProjectIds is scoped per user+company', async () => {
  const svc = freshFullService();
  const project = await svc.createProject({ companyId: 'c1', name: 'Favorited Project' });

  await svc.addProjectFavorite('c1', 'user-1', project.id);
  await svc.addProjectFavorite('c1', 'user-1', project.id); // idempotent — no duplicate row
  let ids = await svc.listFavoriteProjectIds('c1', 'user-1');
  assert.deepEqual(ids, [project.id]);

  const otherUserIds = await svc.listFavoriteProjectIds('c1', 'user-2');
  assert.deepEqual(otherUserIds, []);

  await svc.removeProjectFavorite('c1', 'user-1', project.id);
  ids = await svc.listFavoriteProjectIds('c1', 'user-1');
  assert.deepEqual(ids, []);
});

test('addProjectFavorite rejects a project belonging to a different company (cross-tenant IDOR)', async () => {
  const svc = freshFullService();
  const project = await svc.createProject({ companyId: 'c1', name: 'Project X' });
  await assert.rejects(() => svc.addProjectFavorite('c2', 'user-1', project.id));
});

// ---- searchUnits ----

test('searchUnits combines bedroom/area/garden/finishing/view/destination filters and defaults to available units only', async () => {
  const svc = freshFullService();
  const dev = await svc.createDeveloper({ companyId: 'c1', name: 'Talaat Moustafa' });
  const project = await svc.createProject({ companyId: 'c1', name: 'Madinaty Extension', destination: 'New Cairo', developerId: dev.id });
  const otherProject = await svc.createProject({ companyId: 'c1', name: 'Elsewhere', destination: 'Sheikh Zayed' });

  const match = await svc.createUnit({
    companyId: 'c1',
    projectId: project.id,
    code: 'MX-1',
    unitType: 'apartment',
    areaSqm: 180,
    listPrice: 8_000_000,
    bedrooms: 3,
    gardenAreaSqm: 20,
    finishingType: 'Fully Finished',
    view: ['Lagoon', 'Garden'],
  });
  await svc.createUnit({ companyId: 'c1', projectId: project.id, code: 'MX-2', unitType: 'apartment', areaSqm: 250, listPrice: 15_000_000, bedrooms: 4, finishingType: 'Core & Shell' });
  const heldElsewhere = await svc.createUnit({ companyId: 'c1', projectId: otherProject.id, code: 'ELS-1', unitType: 'apartment', areaSqm: 180, listPrice: 8_000_000, bedrooms: 3 });
  await svc.holdUnit(heldElsewhere.id, 'user-1', 'c1');

  const results = await svc.searchUnits('c1', {
    destination: 'New Cairo',
    minBedrooms: 3,
    maxBedrooms: 3,
    minAreaSqm: 150,
    maxAreaSqm: 220,
    maxPrice: 10_000_000,
    finishingType: 'Fully Finished',
    view: 'Lagoon',
  });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.id, match.id);
});

test('searchUnits status defaults to available, excluding held/reserved units, but "any" includes them', async () => {
  const svc = freshFullService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  await svc.holdUnit(unit.id, 'user-1', 'c1');
  const availableOnly = await svc.searchUnits('c1', {});
  assert.equal(availableOnly.length, 0);
  const any = await svc.searchUnits('c1', { status: 'any' });
  assert.equal(any.length, 1);
});

test('searchUnits sorts ascending by listPrice and clamps limit to [1,200]', async () => {
  const svc = freshFullService();
  await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 5000 });
  await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-2', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-3', unitType: 'apartment', areaSqm: 100, listPrice: 3000 });
  const results = await svc.searchUnits('c1', { limit: 0 });
  assert.deepEqual(results.map((u) => u.listPrice), [1000]);
});

test('searchUnits free-text q matches code/unitType/buildingLabel', async () => {
  const svc = freshFullService();
  await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'PENTHOUSE-1', unitType: 'penthouse', areaSqm: 300, listPrice: 20_000_000, buildingLabel: 'Tower B' });
  await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-2', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  const results = await svc.searchUnits('c1', { q: 'tower b', status: 'any' });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.code, 'PENTHOUSE-1');
});

// ---- createUnit / updateUnitDetails: new fields ----

test('createUnit rejects negative bedrooms or gardenAreaSqm', async () => {
  const svc = freshFullService();
  await assert.rejects(() => svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000, bedrooms: -1 }));
  await assert.rejects(() => svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-2', unitType: 'apartment', areaSqm: 100, listPrice: 1000, gardenAreaSqm: -1 }));
});

test('updateUnitDetails is non-destructive: patching one new field keeps the others', async () => {
  const svc = freshFullService();
  const unit = await svc.createUnit({
    companyId: 'c1',
    projectId: 'p1',
    code: 'A-1',
    unitType: 'apartment',
    areaSqm: 100,
    listPrice: 1000,
    bedrooms: 2,
    finishingType: 'Semi Finished',
    view: ['Garden'],
  });
  const updated = await svc.updateUnitDetails(unit.id, 'c1', { floorLabel: '3rd Floor' });
  assert.equal(updated.floorLabel, '3rd Floor');
  assert.equal(updated.bedrooms, 2, 'untouched field survives the partial update');
  assert.equal(updated.finishingType, 'Semi Finished', 'untouched field survives the partial update');
  assert.deepEqual(updated.view, ['Garden'], 'untouched field survives the partial update');
});

// ---- Phase 0 fix: double-sell race between sweepExpiredReservationsDetailed
// and markContracted (both now serialize on the same per-unit KeyedMutex) ----

// A plain `Promise.all([markContracted(id), sweep(future)])` does NOT
// reliably discriminate this fix: InMemoryRepository has no real I/O delay,
// so markContracted's much shorter await-chain always finishes committing
// its write before the sweep's longer chain (findAll -> reservation.save ->
// unit.findById -> unit.save) reaches its own unit read, regardless of
// which call starts first in the array. Verified empirically — a version of
// this test using bare Promise.all passed even against the pre-fix,
// unguarded code. So instead we deterministically force the exact harmful
// interleaving the fix closes, using an instrumented Repository<Unit> that
// pauses the sweep's unit read (its `findById`) right after it captures a
// stale 'reserved' snapshot, letting a concurrent markContracted run to
// completion before the sweep is allowed to resume and (on unfixed code)
// overwrite 'contracted' back to 'available' using that stale snapshot.
test('concurrency (deterministic): a sweep paused mid-read cannot have its stale-snapshot write revert a markContracted that completed while it was paused', async () => {
  const realUnits = new InMemoryRepository<Unit>();
  let targetUnitId: string | undefined;
  let gateReached = false;
  let resolveReachedGate!: () => void;
  const reachedGate = new Promise<void>((resolve) => {
    resolveReachedGate = resolve;
  });
  let resolveReleaseGate!: () => void;
  const releaseGate = new Promise<void>((resolve) => {
    resolveReleaseGate = resolve;
  });

  // Wraps the real in-memory unit store so the sweep's read of the target
  // unit (and only that read, only once) blocks until the test explicitly
  // releases it — after a concurrent markContracted has had every chance
  // to run to completion.
  const instrumentedUnits: Repository<Unit> = {
    async findById(id) {
      const result = await realUnits.findById(id);
      if (id === targetUnitId && !gateReached) {
        gateReached = true;
        resolveReachedGate();
        await releaseGate;
      }
      return result;
    },
    findAll: (predicate) => realUnits.findAll(predicate),
    save: (item) => realUnits.save(item),
    deleteById: (id) => realUnits.deleteById(id),
  };

  const svc = new InventoryService(
    instrumentedUnits,
    new InMemoryRepository<UnitHold>(),
    new InMemoryRepository<Reservation>(),
    new InMemoryRepository<Project>(),
  );
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  const reservation = await svc.reserveUnit(unit.id, 'lead-1', 'c1');
  const future = new Date(Date.parse(reservation.expiresAt) + 1000);

  // Only arm the gate now — reserveUnit() above does its own internal
  // findById(unitId) through this same instrumented repo, which must be
  // left alone (not paused) or setup itself would hang.
  targetUnitId = unit.id;
  const sweepPromise = svc.sweepExpiredReservationsDetailed(future);
  await reachedGate; // sweep has read the unit (still 'reserved') and is now paused

  const markPromise = svc.markContracted(unit.id);
  // Flush the microtask/macrotask queue so markContracted (fixed code: only
  // queues on the mutex the paused sweep holds; unfixed code: runs to
  // completion immediately, since nothing guards it) gets every chance to
  // finish before we let the sweep resume.
  await new Promise((resolve) => setImmediate(resolve));

  resolveReleaseGate();
  await Promise.all([sweepPromise, markPromise]);

  const finalUnit = await svc.getUnit(unit.id);
  assert.equal(
    finalUnit!.status,
    'contracted',
    'a markContracted that completed while the sweep was mid-read must never be silently reverted once the sweep resumes and writes',
  );
});

test('sweepExpiredReservationsDetailed only sweeps the given companyId when one is passed, and every company when omitted (Phase 0: cross-tenant sweep fix)', async () => {
  const svc = freshService();
  const unitA = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  const unitB = await svc.createUnit({ companyId: 'c2', projectId: 'p1', code: 'B-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  const reservationA = await svc.reserveUnit(unitA.id, 'lead-1', 'c1');
  const reservationB = await svc.reserveUnit(unitB.id, 'lead-2', 'c2');
  const future = new Date(Math.max(Date.parse(reservationA.expiresAt), Date.parse(reservationB.expiresAt)) + 1000);

  const sweptForC1Only = await svc.sweepExpiredReservationsDetailed(future, 'c1');
  assert.equal(sweptForC1Only.length, 1);
  assert.equal(sweptForC1Only[0]!.companyId, 'c1');
  assert.equal((await svc.getUnit(unitA.id))!.status, 'available', "company c1's own expired reservation was swept");
  assert.equal((await svc.getUnit(unitB.id))!.status, 'reserved', "company c2's reservation must be untouched by a sweep scoped to c1");

  const sweptForEveryone = await svc.sweepExpiredReservationsDetailed(future);
  assert.equal(sweptForEveryone.length, 1);
  assert.equal(sweptForEveryone[0]!.companyId, 'c2');
  assert.equal((await svc.getUnit(unitB.id))!.status, 'available', 'an omitted companyId (the background tick) still sweeps every tenant');
});

// ---- Unit-code uniqueness: project-scoped, not company-wide ----

test('two different projects in the same company may reuse the same unit code (project-scoped uniqueness)', async () => {
  const svc = freshService();
  const a = await svc.createUnit({ companyId: 'c1', projectId: 'proj-a', code: 'A-101', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  const b = await svc.createUnit({ companyId: 'c1', projectId: 'proj-b', code: 'A-101', unitType: 'apartment', areaSqm: 120, listPrice: 1200 });
  assert.notEqual(a.id, b.id);
  assert.equal(a.projectId, 'proj-a');
  assert.equal(b.projectId, 'proj-b');
});

test('duplicate unit code within the same project is still rejected regardless of casing', async () => {
  const svc = freshService();
  await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'a-101', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  await assert.rejects(() => svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-101', unitType: 'apartment', areaSqm: 100, listPrice: 1000 }));
});

// ---- ProjectUnitSpec (catalog product ranges) ----

test('createProjectUnitSpec validates required fields and is scoped by company', async () => {
  const svc = freshFullService();
  await assert.rejects(() => svc.createProjectUnitSpec({ companyId: 'c1', projectId: '', unitType: 'apartment' }));
  await assert.rejects(() => svc.createProjectUnitSpec({ companyId: 'c1', projectId: 'p1', unitType: '' }));
  const spec = await svc.createProjectUnitSpec({
    companyId: 'c1', projectId: 'p1', unitType: 'Apartment', bedrooms: 2,
    buaFromSqm: 120, buaToSqm: 135, priceFrom: 8_000_000, priceTo: 10_000_000,
  });
  assert.equal(spec.unitType, 'Apartment');
  assert.equal(spec.buaFromSqm, 120);
  const listed = await svc.listProjectUnitSpecs('c1', 'p1');
  assert.equal(listed.length, 1);
  const otherCompany = await svc.listProjectUnitSpecs('c2', 'p1');
  assert.equal(otherCompany.length, 0);
});

test('createProjectUnitSpec rejects out-of-range percent fields and negative ranges', async () => {
  const svc = freshFullService();
  await assert.rejects(() => svc.createProjectUnitSpec({ companyId: 'c1', projectId: 'p1', unitType: 'apartment', cashDiscountPercent: 150 }));
  await assert.rejects(() => svc.createProjectUnitSpec({ companyId: 'c1', projectId: 'p1', unitType: 'apartment', buaFromSqm: -5 }));
});

test('updateProjectUnitSpec is non-destructive and rejects a spec from a different company', async () => {
  const svc = freshFullService();
  const spec = await svc.createProjectUnitSpec({ companyId: 'c1', projectId: 'p1', unitType: 'Apartment', bedrooms: 2, priceFrom: 8_000_000 });
  const updated = await svc.updateProjectUnitSpec(spec.id, 'c1', { priceTo: 10_000_000 });
  assert.equal(updated.priceFrom, 8_000_000, 'omitted field kept its value');
  assert.equal(updated.priceTo, 10_000_000);
  await assert.rejects(() => svc.updateProjectUnitSpec(spec.id, 'c2', { priceTo: 1 }));
});

test('resolveProjectUnitSpec creates once per natural key (project + phase + unitType + bedrooms) and updates in place on a second call, never duplicating', async () => {
  const svc = freshFullService();
  const first = await svc.resolveProjectUnitSpec({ companyId: 'c1', projectId: 'p1', unitType: 'Apartment', bedrooms: 2, buaFromSqm: 120, buaToSqm: 135 });
  const second = await svc.resolveProjectUnitSpec({ companyId: 'c1', projectId: 'p1', unitType: 'apartment', bedrooms: 2, buaFromSqm: 125, buaToSqm: 140 });
  assert.equal(first.id, second.id, 'same natural key (case-insensitive unitType) resolves to the same spec, not a duplicate');
  assert.equal(second.buaFromSqm, 125, 'the range was refreshed by the second row');

  const differentBedrooms = await svc.resolveProjectUnitSpec({ companyId: 'c1', projectId: 'p1', unitType: 'Apartment', bedrooms: 3 });
  assert.notEqual(differentBedrooms.id, first.id, 'a different bedroom count is a genuinely different spec');

  const all = await svc.listProjectUnitSpecs('c1', 'p1');
  assert.equal(all.length, 2);
});

// ---- Availability-import-driven status sync ----

test('updateUnitAvailabilityFromImport moves an available unit to a new status and records sourceStatus/provenance', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  const updated = await svc.updateUnitAvailabilityFromImport(unit.id, 'c1', 'contracted', 'Sold', { sourceImportId: 'imp-1', sourceRow: 5 });
  assert.equal(updated.status, 'contracted');
  assert.equal(updated.sourceStatus, 'Sold');
  assert.equal(updated.sourceImportId, 'imp-1');
  assert.equal(updated.sourceRow, 5);
});

test('updateUnitAvailabilityFromImport refuses to move a unit off a status backed by a real active hold/reservation', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000 });
  await svc.reserveUnit(unit.id, 'lead-1', 'c1');
  await assert.rejects(() => svc.updateUnitAvailabilityFromImport(unit.id, 'c1', 'available', 'Available'));
});

test('updateUnitAvailabilityFromImport allows re-syncing a status that has no backing internal hold/reservation (itself set by a prior import)', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000, initialStatus: 'contracted', sourceStatus: 'Sold' });
  const updated = await svc.updateUnitAvailabilityFromImport(unit.id, 'c1', 'available', 'Available');
  assert.equal(updated.status, 'available', 'no real hold/reservation ever backed the imported "Sold" status, so re-syncing it is safe');
});

test('createUnit accepts an initial non-available status for an existing-inventory-snapshot import, bypassing the hold/reservation machinery', async () => {
  const svc = freshService();
  const unit = await svc.createUnit({ companyId: 'c1', projectId: 'p1', code: 'A-1', unitType: 'apartment', areaSqm: 100, listPrice: 1000, initialStatus: 'reserved', sourceStatus: 'Booked' });
  assert.equal(unit.status, 'reserved');
  assert.equal(unit.sourceStatus, 'Booked');
});
