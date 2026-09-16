import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { OperationsService } from './operations.service.js';
import type { MaintenanceTicket, Unit } from '../../domain/types.js';

function freshService() {
  const units = new InMemoryRepository<Unit>();
  const tickets = new InMemoryRepository<MaintenanceTicket>();
  return { svc: new OperationsService(tickets, units), units };
}

async function seedUnit(units: InMemoryRepository<Unit>, companyId = 'c1'): Promise<Unit> {
  return units.save({
    id: 'unit-1',
    companyId,
    projectId: 'proj-1',
    code: 'A-1',
    unitType: 'apartment',
    areaSqm: 100,
    listPrice: 1_000_000,
    status: 'contracted',
    createdAt: new Date().toISOString(),
  });
}

test('creating a ticket for a nonexistent unit is rejected', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.createTicket({ companyId: 'c1', unitId: 'nope', title: 'Leak', priority: 'high', reportedByUserId: 'u1' }));
});

test('creating a ticket for a unit belonging to a different company is rejected (cross-tenant)', async () => {
  const { svc, units } = freshService();
  await seedUnit(units, 'c1');
  await assert.rejects(() => svc.createTicket({ companyId: 'c2', unitId: 'unit-1', title: 'Leak', priority: 'high', reportedByUserId: 'u1' }));
});

test('a valid ticket starts open', async () => {
  const { svc, units } = freshService();
  await seedUnit(units);
  const ticket = await svc.createTicket({ companyId: 'c1', unitId: 'unit-1', title: 'AC broken', priority: 'medium', reportedByUserId: 'u1' });
  assert.equal(ticket.status, 'open');
});

test('assigning a ticket sets assignedToUserId', async () => {
  const { svc, units } = freshService();
  await seedUnit(units);
  const ticket = await svc.createTicket({ companyId: 'c1', unitId: 'unit-1', title: 'AC broken', priority: 'medium', reportedByUserId: 'u1' });
  const assigned = await svc.assignTicket(ticket.id, 'c1', 'tech-1');
  assert.equal(assigned.assignedToUserId, 'tech-1');
});

test('a valid status transition open -> in_progress -> resolved -> closed succeeds', async () => {
  const { svc, units } = freshService();
  await seedUnit(units);
  const ticket = await svc.createTicket({ companyId: 'c1', unitId: 'unit-1', title: 'AC broken', priority: 'medium', reportedByUserId: 'u1' });
  await svc.updateStatus(ticket.id, 'c1', 'in_progress');
  const resolved = await svc.updateStatus(ticket.id, 'c1', 'resolved');
  assert.ok(resolved.resolvedAt);
  const closed = await svc.updateStatus(ticket.id, 'c1', 'closed');
  assert.equal(closed.status, 'closed');
});

test('an invalid status transition (open -> resolved) is rejected', async () => {
  const { svc, units } = freshService();
  await seedUnit(units);
  const ticket = await svc.createTicket({ companyId: 'c1', unitId: 'unit-1', title: 'AC broken', priority: 'medium', reportedByUserId: 'u1' });
  await assert.rejects(() => svc.updateStatus(ticket.id, 'c1', 'resolved'));
});

test('a closed ticket cannot transition further', async () => {
  const { svc, units } = freshService();
  await seedUnit(units);
  const ticket = await svc.createTicket({ companyId: 'c1', unitId: 'unit-1', title: 'AC broken', priority: 'low', reportedByUserId: 'u1' });
  await svc.updateStatus(ticket.id, 'c1', 'closed');
  await assert.rejects(() => svc.updateStatus(ticket.id, 'c1', 'open'));
});

test('assignTicket rejects a ticket belonging to a different company (cross-tenant)', async () => {
  const { svc, units } = freshService();
  await seedUnit(units);
  const ticket = await svc.createTicket({ companyId: 'c1', unitId: 'unit-1', title: 'AC broken', priority: 'low', reportedByUserId: 'u1' });
  await assert.rejects(() => svc.assignTicket(ticket.id, 'c2', 'tech-1'));
});

test('listForUnit returns only tickets for that unit, scoped to the company', async () => {
  const { svc, units } = freshService();
  await seedUnit(units);
  await units.save({ id: 'unit-2', companyId: 'c1', projectId: 'proj-1', code: 'A-2', unitType: 'apartment', areaSqm: 100, listPrice: 1_000_000, status: 'available', createdAt: new Date().toISOString() });
  await svc.createTicket({ companyId: 'c1', unitId: 'unit-1', title: 'A', priority: 'low', reportedByUserId: 'u1' });
  await svc.createTicket({ companyId: 'c1', unitId: 'unit-2', title: 'B', priority: 'low', reportedByUserId: 'u1' });
  const results = await svc.listForUnit('unit-1', 'c1');
  assert.equal(results.length, 1);
  assert.equal(results[0]!.title, 'A');
});
