import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { InventoryService } from './inventory.service.js';
import { InventoryImportService, INVENTORY_IMPORT_FIELDS, CATALOG_IMPORT_FIELDS, AVAILABILITY_IMPORT_FIELDS } from './inventory-import.service.js';
import { suggestMapping } from '../../infra/field-mapping.js';
import type { Consultant, Developer, Facility, Launch, Project, ProjectPhase, ProjectUnitSpec, Reservation, SalesPhoneNumber, Unit, UnitHold } from '../../domain/types.js';

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

/** Same repo set as setup(), but with the 6 new master-data repos wired in
 * too — needed for any test that exercises developer/facility/consultant/
 * phase/sales-phone resolution during import. */
function setupFull() {
  const inventory = new InventoryService(
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
  );
  const svc = new InventoryImportService(inventory);
  return { inventory, svc };
}

/** Re-keys raw file rows (header -> value) to field-key rows (fieldKey ->
 * value) using a suggested/confirmed mapping — the same transformation
 * ImportSessionService.mapRows() performs in production, reproduced here so
 * these tests can exercise the real production field dictionary
 * (INVENTORY_IMPORT_FIELDS) end-to-end without needing a file-upload
 * session. */
function applyMapping(rawRows: Record<string, string>[], mapping: Record<string, string | null>): Record<string, string>[] {
  return rawRows.map((row) => {
    const mapped: Record<string, string> = {};
    for (const [column, fieldKey] of Object.entries(mapping)) {
      if (!fieldKey) continue;
      mapped[fieldKey] = row[column] ?? '';
    }
    return mapped;
  });
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

// ---- Unit-level extra fields flow through to the created Unit ----

test('importRows writes bedrooms/view/finishing/garden area/floor/design/building/delivery/price-per-meter onto a newly created unit', async () => {
  const { inventory, svc } = setupFull();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  let written: Unit | undefined;
  const result = await svc.importRows(
    'c1',
    [
      {
        projectName: project.name,
        unitCode: 'A-101',
        unitType: 'apartment',
        areaSqm: '120',
        listPrice: '1500000',
        bedrooms: '3 Bedrooms',
        view: 'Lagoon, Garden',
        finishingType: 'fully finish',
        unitGardenAreaSqm: '30',
        floorLabel: 'Ground',
        designType: 'Type A',
        buildingLabel: 'B3',
        deliveryDate: 'Q2 2028',
        pricePerMeter: '12500',
      },
    ],
    async (unit) => {
      written = unit;
    },
  );
  assert.equal(result.succeeded, 1);
  assert.ok(written);
  assert.equal(written!.bedrooms, 3);
  assert.deepEqual(written!.view, ['Lagoon', 'Garden']);
  assert.equal(written!.finishingType, 'Fully Finished');
  assert.equal(written!.gardenAreaSqm, 30);
  assert.equal(written!.floorLabel, 'Ground');
  assert.equal(written!.designType, 'Type A');
  assert.equal(written!.buildingLabel, 'B3');
  assert.deepEqual(written!.delivery, { quarter: 2, year: 2028 });
  assert.equal(written!.pricePerMeterOverride, 12500);
});

test('importRows resolves a Phase name to a real ProjectPhase, creating it once and reusing it on later rows', async () => {
  const { inventory, svc } = setupFull();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  await svc.importRows(
    'c1',
    [
      { projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '120', listPrice: '1500000', phaseName: 'Phase 1' },
      { projectName: project.name, unitCode: 'A-102', unitType: 'apartment', areaSqm: '130', listPrice: '1600000', phaseName: 'Phase 1' },
    ],
    async () => {},
  );
  const phases = await inventory.listProjectPhases('c1', project.id);
  assert.equal(phases.length, 1, 'the same phase name is resolved to one real Phase, not duplicated per row');
  const units = await inventory.listUnits('c1', project.id);
  assert.ok(units.every((u) => u.phaseId === phases[0]!.id));
});

// ---- Project-level extra fields flow through non-destructively across rows ----

test('importRows resolves developer/consultants/facilities by name (creating them) and applies destination/ministerial-decision/cash-discount/maintenance-fee to the Project', async () => {
  const { inventory, svc } = setupFull();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  await svc.importRows(
    'c1',
    [
      {
        projectName: project.name,
        unitCode: 'A-101',
        unitType: 'apartment',
        areaSqm: '120',
        listPrice: '1500000',
        destination: 'North Coast',
        developerName: 'Emaar Misr',
        engineeringConsultant: 'Dar Al-Handasah',
        projectManagementCompany: 'PM Experts',
        facilities: 'Pool, Gym',
        ministerialDecisionNumber: 'MD-2024-55',
        cashDiscount: '10%',
        maintenanceFeePercent: '8%',
      },
    ],
    async () => {},
  );

  const updated = await inventory.getProject(project.id);
  assert.equal(updated!.destination, 'North Coast');
  assert.equal(updated!.ministerialDecisionNumber, 'MD-2024-55');
  assert.equal(updated!.cashDiscountPercent, 10);
  assert.equal(updated!.maintenanceFeePercent, 8);

  const developer = await inventory.getDeveloper(updated!.developerId!);
  assert.equal(developer!.name, 'Emaar Misr');

  const facilities = await inventory.getProjectFacilities(project.id, 'c1');
  assert.deepEqual(facilities.map((f) => f.name).sort(), ['Gym', 'Pool']);

  const consultants = await inventory.listConsultants('c1');
  assert.ok(consultants.some((c) => c.name === 'Dar Al-Handasah' && c.role === 'engineering'));
  assert.ok(consultants.some((c) => c.name === 'PM Experts' && c.role === 'project_management'));
});

test('importRows unions facility names across multiple rows for the same project rather than overwriting', async () => {
  const { inventory, svc } = setupFull();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  await svc.importRows(
    'c1',
    [
      { projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '120', listPrice: '1500000', facilities: 'Pool' },
      { projectName: project.name, unitCode: 'A-102', unitType: 'apartment', areaSqm: '130', listPrice: '1600000', facilities: 'Gym' },
    ],
    async () => {},
  );
  const facilities = await inventory.getProjectFacilities(project.id, 'c1');
  assert.deepEqual(facilities.map((f) => f.name).sort(), ['Gym', 'Pool'], 'facilities accumulate across rows instead of the second row wiping out the first');
});

test('importRows creates exactly one SalesPhoneNumber even when the same number repeats across many rows for the same project', async () => {
  const { inventory, svc } = setupFull();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  await svc.importRows(
    'c1',
    [
      { projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '120', listPrice: '1500000', salesDirectPhone: '+201001234567' },
      { projectName: project.name, unitCode: 'A-102', unitType: 'apartment', areaSqm: '130', listPrice: '1600000', salesDirectPhone: '+201001234567' },
    ],
    async () => {},
  );
  const phones = await inventory.listSalesPhoneNumbers('c1', project.id);
  assert.equal(phones.length, 1);
});

test('importRows preserves an explicit developer-supplied Price Per Meter with source "developer", never silently overwritten', async () => {
  const { inventory, svc } = setupFull();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  await svc.importRows(
    'c1',
    [{ projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '120', listPrice: '1500000', pricePerMeter: '13000' }],
    async () => {},
  );
  const updated = await inventory.getProject(project.id);
  assert.equal(updated!.pricePerMeter, 13000);
  assert.equal(updated!.pricePerMeterSource, 'developer');
});

test('updateProjectDetails patches from later rows never blank out project fields set by earlier rows in the same import', async () => {
  const { inventory, svc } = setupFull();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  await svc.importRows(
    'c1',
    [
      { projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '120', listPrice: '1500000', destination: 'North Coast' },
      { projectName: project.name, unitCode: 'A-102', unitType: 'apartment', areaSqm: '130', listPrice: '1600000', ministerialDecisionNumber: 'MD-99' },
    ],
    async () => {},
  );
  const updated = await inventory.getProject(project.id);
  assert.equal(updated!.destination, 'North Coast', 'set by row 1, must survive row 2 (which never mentions destination)');
  assert.equal(updated!.ministerialDecisionNumber, 'MD-99');
});

// ---- Validation: new fields ----

test('buildPreview rejects a negative Garden Area', async () => {
  const { inventory, svc } = setup();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  const preview = await svc.buildPreview('c1', [{ projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '120', listPrice: '1500000', unitGardenAreaSqm: '-30' }]);
  assert.equal(preview.invalidCount, 1);
  assert.match(preview.rows[0]!.issues.join(), /Garden Area.*>= 0/);
});

test('buildPreview rejects a Cash Discount or Maintenance Fee outside 0-100', async () => {
  const { inventory, svc } = setup();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  const highDiscount = await svc.buildPreview('c1', [{ projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '120', listPrice: '1500000', cashDiscount: '150' }]);
  assert.equal(highDiscount.invalidCount, 1);
  assert.match(highDiscount.rows[0]!.issues.join(), /Cash Discount.*between 0 and 100/);

  const negativeMaintenance = await svc.buildPreview('c1', [{ projectName: project.name, unitCode: 'A-102', unitType: 'apartment', areaSqm: '120', listPrice: '1500000', maintenanceFeePercent: '-5' }]);
  assert.equal(negativeMaintenance.invalidCount, 1);
  assert.match(negativeMaintenance.rows[0]!.issues.join(), /Maintenance Fees %.*between 0 and 100/);
});

test('buildPreview treats a non-empty Payment Plan column as informational only, never blocking the row', async () => {
  const { inventory, svc } = setup();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  const preview = await svc.buildPreview('c1', [{ projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '120', listPrice: '1500000', paymentPlan: '10% DP, 8 years installments' }]);
  assert.equal(preview.validCount, 1);
  assert.match(preview.rows[0]!.issues.join(), /informational only/);
});

// ---- Full pipeline: Arabic headers -> suggestMapping -> import, using the real production field dictionary ----

test('a real Arabic-header file maps and imports correctly end-to-end through INVENTORY_IMPORT_FIELDS', async () => {
  const { inventory, svc } = setupFull();
  const project = await inventory.createProject({ companyId: 'c1', name: 'مدينتي' });

  const headers = ['المشروع', 'رقم الوحدة', 'نوع الوحدة', 'مساحة الوحدة', 'السعر', 'عدد الغرف', 'تشطيب', 'الوجهة', 'المطور'];
  const mapping = suggestMapping(headers, INVENTORY_IMPORT_FIELDS);
  for (const h of headers) {
    assert.notEqual(mapping[h], null, `expected Arabic header "${h}" to be auto-mapped`);
  }

  const rawRows = [
    {
      المشروع: 'مدينتي',
      'رقم الوحدة': 'AR-101',
      'نوع الوحدة': 'شقة',
      'مساحة الوحدة': '150',
      السعر: '3000000',
      'عدد الغرف': '3 غرف',
      تشطيب: 'تشطيب كامل',
      الوجهة: 'القاهرة الجديدة',
      المطور: 'طلعت مصطفى',
    },
  ];
  const mappedRows = applyMapping(rawRows, mapping);

  const preview = await svc.buildPreview('c1', mappedRows);
  assert.equal(preview.validCount, 1, preview.rows[0]?.issues.join(';'));

  let written: Unit | undefined;
  const result = await svc.importRows('c1', mappedRows, async (unit) => {
    written = unit;
  });
  assert.equal(result.succeeded, 1);
  assert.ok(written);
  assert.equal(written!.code, 'AR-101');
  assert.equal(written!.areaSqm, 150);
  assert.equal(written!.listPrice, 3_000_000);
  assert.equal(written!.bedrooms, 3);
  assert.equal(written!.finishingType, 'Fully Finished');

  const updatedProject = await inventory.getProject(project.id);
  assert.equal(updatedProject!.destination, 'القاهرة الجديدة');
  const developer = await inventory.getDeveloper(updatedProject!.developerId!);
  assert.equal(developer!.name, 'طلعت مصطفى');
});

// ---- autoGenerateUnitCode / autoCreateMissingProjects (default preset
// fallback rules for the seamless auto-import flow) ----

test('without autoGenerateUnitCode, a row with no Unit Code is invalid', async () => {
  const { inventory, svc } = setup();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  const preview = await svc.buildPreview('c1', [{ projectName: project.name, unitCode: '', unitType: 'apartment', areaSqm: '120', listPrice: '1500000' }]);
  assert.equal(preview.invalidCount, 1);
  assert.match(preview.rows[0]!.issues.join(), /Unit Code.*required/);
});

test('autoGenerateUnitCode generates a unique code per row so the import can proceed without a Unit Code column', async () => {
  const { inventory, svc } = setup();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  const preview = await svc.buildPreview(
    'c1',
    [
      { projectName: project.name, unitCode: '', unitType: 'apartment', areaSqm: '120', listPrice: '1500000' },
      { projectName: project.name, unitCode: '', unitType: 'apartment', areaSqm: '130', listPrice: '1600000' },
    ],
    { autoGenerateUnitCode: true },
  );
  assert.equal(preview.validCount, 2);
  const codes = preview.rows.map((r) => r.resolved!.unitCode);
  assert.notEqual(codes[0], codes[1], 'generated codes must be unique within the same file');
  assert.match(preview.rows[0]!.issues.join(), /unit code auto-generated/);

  let written: Unit | undefined;
  const result = await svc.importRows('c1', [
    { projectName: project.name, unitCode: '', unitType: 'apartment', areaSqm: '120', listPrice: '1500000' },
  ], async (unit) => { written = unit; }, { autoGenerateUnitCode: true });
  assert.equal(result.succeeded, 1);
  assert.ok(written!.code.length > 0);
});

test('without autoCreateMissingProjects, a row targeting an unknown project is invalid, never silently creating one', async () => {
  const { svc } = setup();
  const preview = await svc.buildPreview('c1', [{ projectName: 'Nonexistent Project', unitCode: 'A-1', unitType: 'apartment', areaSqm: '120', listPrice: '1500000' }]);
  assert.equal(preview.invalidCount, 1);
  assert.match(preview.rows[0]!.issues.join(), /not found/);
});

test('autoCreateMissingProjects marks the row as a create and importRows actually creates the new Project', async () => {
  const { inventory, svc } = setup();
  const projectName = `Brand New Project ${Date.now()}`;
  const preview = await svc.buildPreview('c1', [{ projectName, unitCode: 'A-1', unitType: 'apartment', areaSqm: '120', listPrice: '1500000' }], { autoCreateMissingProjects: true });
  assert.equal(preview.validCount, 1);
  assert.match(preview.rows[0]!.issues.join(), /will create new project/);

  let written: Unit | undefined;
  const result = await svc.importRows(
    'c1',
    [{ projectName, unitCode: 'A-1', unitType: 'apartment', areaSqm: '120', listPrice: '1500000' }],
    async (unit) => { written = unit; },
    { autoCreateMissingProjects: true },
  );
  assert.equal(result.succeeded, 1);
  const projects = await inventory.listProjects('c1');
  const created = projects.find((p) => p.name === projectName);
  assert.ok(created, 'the missing project was created automatically');
  assert.equal(written!.projectId, created!.id);
});

test('autoCreateMissingProjects creates the project only once even when many rows in the same file target it', async () => {
  const { inventory, svc } = setup();
  const projectName = `Shared New Project ${Date.now()}`;
  const result = await svc.importRows(
    'c1',
    [
      { projectName, unitCode: 'A-1', unitType: 'apartment', areaSqm: '120', listPrice: '1500000' },
      { projectName, unitCode: 'A-2', unitType: 'apartment', areaSqm: '130', listPrice: '1600000' },
    ],
    async () => {},
    { autoCreateMissingProjects: true },
  );
  assert.equal(result.succeeded, 2);
  const projects = await inventory.listProjects('c1');
  assert.equal(projects.filter((p) => p.name === projectName).length, 1, 'the same project name is created once, not once per row');
});

test('autoGenerateUnitCode and autoCreateMissingProjects can combine: a file with neither a Unit Code column nor a pre-existing project still imports end-to-end', async () => {
  const { inventory, svc } = setup();
  const projectName = `Combined Fallback Project ${Date.now()}`;
  const result = await svc.importRows(
    'c1',
    [{ projectName, unitCode: '', unitType: 'apartment', areaSqm: '120', listPrice: '1500000' }],
    async () => {},
    { autoGenerateUnitCode: true, autoCreateMissingProjects: true },
  );
  assert.equal(result.succeeded, 1);
  const units = await inventory.listUnits('c1');
  assert.equal(units.length, 1);
  assert.ok(units[0]!.code.length > 0);
});

// ---- Widened required-field alias coverage: locks in that every new
// alias resolves to the right field, and that broadening these lists
// introduced no new cross-field ambiguity against the real production
// dictionary (INVENTORY_IMPORT_FIELDS) — this is what actually fixes the
// reported "defaults to Do not import for most columns" bug for common
// real-estate export header spellings. ----

test('a representative batch of common English/Arabic real-estate export headers each resolve to the correct field, unambiguously', () => {
  const cases: [string, string][] = [
    ['Project', 'projectName'], ['Compound', 'projectName'], ['Compound Name', 'projectName'], ['Development Name', 'projectName'],
    ['Unit ID', 'unitCode'], ['Unit Ref', 'unitCode'], ['Apt No', 'unitCode'], ['Unit#', 'unitCode'],
    ['Property Type', 'unitType'], ['Unit Category', 'unitType'],
    ['Area M2', 'areaSqm'], ['Total Area', 'areaSqm'], ['SQM', 'areaSqm'], ['Sq.M', 'areaSqm'],
    ['Selling Price', 'listPrice'], ['Unit Value', 'listPrice'], ['Price EGP', 'listPrice'],
    ['الكمبوند', 'projectName'], ['اسم الكمبوند', 'projectName'],
    ['رقم العقار', 'unitCode'], ['رقم الشقة', 'unitCode'],
    ['نوع العقار', 'unitType'],
    ['المساحة', 'areaSqm'], ['مساحة الوحده', 'areaSqm'],
    ['السعر الإجمالي', 'listPrice'], ['قيمة الوحدة', 'listPrice'],
    // Project-level "Price From/To" must never be swallowed by the
    // unit-level listPriceFrom/listPriceTo fields, and vice versa.
    ['Price From', 'listPriceFrom'], ['Price To', 'listPriceTo'],
    ['Project Price From', 'projectPriceFrom'], ['Project Price To', 'projectPriceTo'],
  ];
  for (const [header, expectedKey] of cases) {
    const mapping = suggestMapping([header], INVENTORY_IMPORT_FIELDS);
    assert.equal(mapping[header], expectedKey, `expected "${header}" to map to ${expectedKey}, got ${mapping[header]}`);
  }
});

// ---- Availability status: import + normalization ----

test('importRows sets an initial status on a newly created unit when the source row has a recognized status', async () => {
  const { inventory, svc } = setup();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  const result = await svc.importRows(
    'c1',
    [{ projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '120', listPrice: '1500000', availabilityStatus: 'Sold' }],
    async () => {},
  );
  assert.equal(result.succeeded, 1);
  const [unit] = await inventory.listUnits('c1');
  assert.equal(unit!.status, 'contracted');
  assert.equal(unit!.sourceStatus, 'Sold');
});

test('importRows updates an existing available unit\'s status when a re-import reports a new recognized status (Available -> Hold)', async () => {
  const { inventory, svc } = setup();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  const row = { projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '120', listPrice: '1500000' };
  await svc.importRows('c1', [row], async () => {});
  const [before] = await inventory.listUnits('c1');
  assert.equal(before!.status, 'available');

  const result = await svc.importRows('c1', [{ ...row, availabilityStatus: 'hold' }], async () => {});
  assert.equal(result.succeeded, 1);
  const [after] = await inventory.listUnits('c1');
  assert.equal(after!.status, 'held');
  assert.equal(after!.sourceStatus, 'hold');
});

test('an unrecognized status value is flagged as informational and never silently defaults to available', async () => {
  const { inventory, svc } = setup();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  const preview = await svc.buildPreview('c1', [
    { projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '120', listPrice: '1500000', availabilityStatus: 'Under Offer' },
  ]);
  assert.equal(preview.validCount, 1, 'an unrecognized status is a warning, not a blocking error');
  assert.match(preview.rows[0]!.issues.join(';'), /"Status" value "Under Offer" is not recognized/);

  const result = await svc.importRows(
    'c1',
    [{ projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '120', listPrice: '1500000', availabilityStatus: 'Under Offer' }],
    async () => {},
  );
  assert.equal(result.succeeded, 1);
  const [unit] = await inventory.listUnits('c1');
  assert.equal(unit!.status, 'available', 'an unrecognized status is never silently defaulted to available (it just never overwrote the create default)');
  assert.equal(unit!.sourceStatus, undefined);
});

test('importRows never touches status on an unrelated commercial-field-only re-import (no status column present)', async () => {
  const { inventory, svc } = setup();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Marina Towers' });
  await svc.importRows('c1', [{ projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '120', listPrice: '1500000' }], async () => {});
  await svc.importRows('c1', [{ projectName: project.name, unitCode: 'A-101', unitType: 'apartment', areaSqm: '125', listPrice: '1600000' }], async () => {});
  const [unit] = await inventory.listUnits('c1');
  assert.equal(unit!.status, 'available');
  assert.equal(unit!.areaSqm, 125, 'the commercial refresh itself still applies');
});

// ---- Project Catalog import (ProjectUnitSpec rows, never a physical Unit) ----

test('buildProjectUnitSpecPreview validates a catalog row and never requires a unit code', async () => {
  const { inventory, svc } = setupFull();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Vye' });
  const preview = await svc.buildProjectUnitSpecPreview('c1', [
    { projectName: project.name, unitType: 'Apartment', bedrooms: '2', projectBuaFrom: '120', projectBuaTo: '135', projectPriceFrom: '8000000', projectPriceTo: '10000000' },
  ]);
  assert.equal(preview.validCount, 1);
  assert.equal(preview.rows[0]!.resolved!.unitType, 'Apartment');
});

test('importProjectUnitSpecRows creates a ProjectUnitSpec and never creates a physical Unit — a catalog row has no unit identity', async () => {
  const { inventory, svc } = setupFull();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Vye' });
  const result = await svc.importProjectUnitSpecRows('c1', [
    { projectName: project.name, unitType: 'Apartment', bedrooms: '2', projectBuaFrom: '120', projectBuaTo: '135', projectPriceFrom: '8000000', projectPriceTo: '10000000' },
    { projectName: project.name, unitType: 'Villa', bedrooms: '3', projectBuaFrom: '250', projectBuaTo: '300' },
  ]);
  assert.equal(result.succeeded, 2);
  const specs = await inventory.listProjectUnitSpecs('c1', project.id);
  assert.equal(specs.length, 2);
  const units = await inventory.listUnits('c1');
  assert.equal(units.length, 0, 'importing a Project Catalog file must never fabricate a physical Unit from a range row');
});

test('re-importing the same Project Catalog file updates the existing spec in place, never duplicating it', async () => {
  const { inventory, svc } = setupFull();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Vye' });
  const row = { projectName: project.name, unitType: 'Apartment', bedrooms: '2', projectBuaFrom: '120', projectBuaTo: '135' };
  await svc.importProjectUnitSpecRows('c1', [row]);
  const result = await svc.importProjectUnitSpecRows('c1', [{ ...row, projectBuaFrom: '125', projectBuaTo: '140' }]);
  assert.equal(result.results[0]!.status, 'updated');
  const specs = await inventory.listProjectUnitSpecs('c1', project.id);
  assert.equal(specs.length, 1, 'no duplicate spec was created');
  assert.equal(specs[0]!.buaFromSqm, 125, 'the range was refreshed');
});

test('a catalog row targeting an unknown project is invalid unless autoCreateMissingProjects is set, matching the availability path\'s own behavior', async () => {
  const { svc, inventory } = setupFull();
  const invalidPreview = await svc.buildProjectUnitSpecPreview('c1', [{ projectName: 'Brand New Compound', unitType: 'Apartment' }]);
  assert.equal(invalidPreview.invalidCount, 1);

  const result = await svc.importProjectUnitSpecRows('c1', [{ projectName: 'Brand New Compound', unitType: 'Apartment' }], { autoCreateMissingProjects: true });
  assert.equal(result.succeeded, 1);
  const projects = await inventory.listProjects('c1');
  assert.ok(projects.some((p) => p.name === 'Brand New Compound'));
});

// ---- Cross-format proof: the same canonical Unit model results from
// differently-named columns, mapped through the one shared alias engine —
// simulating two developers' real availability exports (e.g. a STAY'N-style
// "Code/Type/Building/Floor/Flat/Rooms/Area/Garden/Price/Status" sheet vs a
// CONNECT-4-style "Code/Floor/Unit Type/Price Per Meter/Final Price/Status"
// sheet) never producing two different data shapes. ----

test('two differently-worded availability header sets both resolve, through suggestMapping, onto the exact same canonical Unit after import', async () => {
  const { inventory, svc } = setup();
  const project = await inventory.createProject({ companyId: 'c1', name: 'Portfolio Co' });

  const formatA = { Code: 'A-1', Type: 'Apartment', Area: '120', Price: '3000000', Status: 'Available' };
  const formatB = { 'Unit No': 'B-1', 'Property Type': 'Apartment', 'Total Area': '120', 'Selling Price': '3000000', Availability: 'Available' };

  for (const raw of [formatA, formatB]) {
    const mapping = suggestMapping(Object.keys(raw), AVAILABILITY_IMPORT_FIELDS);
    const mapped: Record<string, string> = { projectName: project.name };
    for (const [col, fieldKey] of Object.entries(mapping)) {
      if (fieldKey) mapped[fieldKey] = (raw as Record<string, string>)[col]!;
    }
    const result = await svc.importRows('c1', [mapped], async () => {});
    assert.equal(result.succeeded, 1, `format failed to import: ${JSON.stringify(raw)}`);
  }

  const units = await inventory.listUnits('c1', project.id);
  assert.equal(units.length, 2);
  for (const u of units) {
    assert.equal(u.unitType, 'Apartment');
    assert.equal(u.areaSqm, 120);
    assert.equal(u.listPrice, 3_000_000);
    assert.equal(u.status, 'available');
  }
});

test('CATALOG_IMPORT_FIELDS and AVAILABILITY_IMPORT_FIELDS are both non-empty subsets of the one shared INVENTORY_IMPORT_FIELDS dictionary (one mapping engine, not two)', () => {
  const allKeys = new Set(INVENTORY_IMPORT_FIELDS.map((f) => f.key));
  assert.ok(CATALOG_IMPORT_FIELDS.length > 0);
  assert.ok(AVAILABILITY_IMPORT_FIELDS.length > 0);
  for (const f of [...CATALOG_IMPORT_FIELDS, ...AVAILABILITY_IMPORT_FIELDS]) {
    assert.ok(allKeys.has(f.key), `${f.key} should come from the one shared dictionary`);
  }
});
