import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { InventoryService } from './inventory.service.js';
import { InventoryImportService } from './inventory-import.service.js';
import type { Project, Reservation, Unit, UnitHold } from '../../domain/types.js';

function setup() {
  const inventory = new InventoryService(
    new InMemoryRepository<Unit>(),
    new InMemoryRepository<UnitHold>(),
    new InMemoryRepository<Reservation>(),
    new InMemoryRepository<Project>(),
  );
  const svc = new InventoryImportService(inventory);
  return { inventory, svc };
}

test('buildPreview marks a well-formed new-unit row as a create', async () => {
  const { inventory, svc } = setup();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  const preview = await svc.buildPreview('c1', [{ projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '120', listPrice: '1500000' }]);
  assert.equal(preview.validCount, 1);
  assert.equal(preview.rows[0]!.resolved!.action, 'create');
});

test('buildPreview flags missing required fields as invalid', async () => {
  const { svc } = setup();
  const preview = await svc.buildPreview('c1', [{ projectName: '', unitCode: '', unitType: '', areaSqm: '', listPrice: '' }]);
  assert.equal(preview.invalidCount, 1);
  assert.match(preview.rows[0]!.issues.join(), /Project.*required/);
});

test('buildPreview flags a non-numeric area/price as invalid', async () => {
  const { inventory, svc } = setup();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  const preview = await svc.buildPreview('c1', [{ projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: 'abc', listPrice: '1500000' }]);
  assert.equal(preview.invalidCount, 1);
});

test('buildPreview flags an unresolvable project name as invalid, never auto-creating one', async () => {
  const { svc } = setup();
  const preview = await svc.buildPreview('c1', [{ projectName: 'Nonexistent Project', unitCode: 'A-101', unitType: 'apartment', areaSqm: '120', listPrice: '1500000' }]);
  assert.equal(preview.invalidCount, 1);
  assert.match(preview.rows[0]!.issues.join(), /not found/);
});

test('buildPreview marks a row matching an existing AVAILABLE unit as an update', async () => {
  const { inventory, svc } = setup();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  const unit = await inventory.createUnit({ companyId: 'c1', projectId: project.id, code: 'A-101', unitType: 'apartment', areaSqm: 100, listPrice: 1000000 });
  const preview = await svc.buildPreview('c1', [{ projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '110', listPrice: '1100000' }]);
  assert.equal(preview.validCount, 1);
  assert.equal(preview.rows[0]!.resolved!.action, 'update');
  assert.equal(preview.rows[0]!.resolved!.existingUnitId, unit.id);
});

test('buildPreview flags a row matching a RESERVED unit as a protected conflict, never touching it', async () => {
  const { inventory, svc } = setup();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  const unit = await inventory.createUnit({ companyId: 'c1', projectId: project.id, code: 'A-101', unitType: 'apartment', areaSqm: 100, listPrice: 1000000 });
  await inventory.reserveUnit(unit.id, 'lead-1', 'c1');
  const preview = await svc.buildPreview('c1', [{ projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '110', listPrice: '1100000' }]);
  assert.equal(preview.conflictCount, 1);
  assert.match(preview.rows[0]!.issues.join(), /reserved.*protected/);
});

test('buildPreview flags a row matching a CONTRACTED (sold) unit as a protected conflict', async () => {
  const { inventory, svc } = setup();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  const unit = await inventory.createUnit({ companyId: 'c1', projectId: project.id, code: 'A-101', unitType: 'apartment', areaSqm: 100, listPrice: 1000000 });
  await inventory.reserveUnit(unit.id, 'lead-1', 'c1');
  await inventory.markContracted(unit.id);
  const preview = await svc.buildPreview('c1', [{ projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '110', listPrice: '1100000' }]);
  assert.equal(preview.conflictCount, 1);
  assert.match(preview.rows[0]!.issues.join(), /contracted.*protected/);
});

test('buildPreview flags two rows in the same file targeting the same project+unit code as a conflict', async () => {
  const { inventory, svc } = setup();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  const preview = await svc.buildPreview('c1', [
    { projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '120', listPrice: '1500000' },
    { projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '125', listPrice: '1550000' },
  ]);
  assert.equal(preview.validCount, 1);
  assert.equal(preview.conflictCount, 1);
  assert.match(preview.rows[1]!.issues.join(), /another row in this same file/);
});

test('importRows creates new units and updates available ones, skipping sold/reserved conflicts and invalid rows', async () => {
  const { inventory, svc } = setup();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  const availableUnit = await inventory.createUnit({ companyId: 'c1', projectId: project.id, code: 'A-101', unitType: 'apartment', areaSqm: 100, listPrice: 1000000 });
  const soldUnit = await inventory.createUnit({ companyId: 'c1', projectId: project.id, code: 'A-102', unitType: 'apartment', areaSqm: 100, listPrice: 1000000 });
  await inventory.reserveUnit(soldUnit.id, 'lead-1', 'c1');
  await inventory.markContracted(soldUnit.id);

  const written: string[] = [];
  const result = await svc.importRows(
    'c1',
    [
      { projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '110', listPrice: '1100000' }, // update
      { projectName: project.name, unitCode: 'A-102', unitType: 'apartment', areaSqm: '999', listPrice: '9999999' }, // protected conflict
      { projectName: project.name, unitCode: 'B-201', unitType: 'villa', areaSqm: '300', listPrice: '3000000' }, // create
      { projectName: project.name, unitCode: '', unitType: '', areaSqm: '', listPrice: '' }, // invalid
    ],
    async (unit) => {
      written.push(unit.id);
    },
  );

  assert.equal(result.total, 4);
  assert.equal(result.succeeded, 2);
  assert.equal(result.skipped, 2);
  assert.equal(result.failed, 0);
  assert.equal(written.length, 2);

  const updatedAvailable = await inventory.getUnit(availableUnit.id);
  assert.equal(updatedAvailable!.areaSqm, 110);
  assert.equal(updatedAvailable!.listPrice, 1100000);

  const untouchedSold = await inventory.getUnit(soldUnit.id);
  assert.equal(untouchedSold!.areaSqm, 100);
  assert.equal(untouchedSold!.listPrice, 1000000);
  assert.equal(untouchedSold!.status, 'contracted');

  const newUnits = await inventory.listUnits('c1', project.id);
  assert.equal(newUnits.length, 3);
});
