import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { InventoryService } from './inventory.service.js';
import type { Project, Reservation, Unit, UnitHold } from '../../domain/types.js';

function freshService() {
  return new InventoryService(
    new InMemoryRepository<Unit>(),
    new InMemoryRepository<UnitHold>(),
    new InMemoryRepository<Reservation>(),
    new InMemoryRepository<Project>(),
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
