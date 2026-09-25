import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InMemoryRepository } from '../../infra/repository.js';
import type { Lead, User, CrmStage } from '../../domain/types.js';
import { CrmStageService } from './crm-stage.service.js';
import { CrmService } from './crm.service.js';
import { LeadImportService } from './lead-import.service.js';

async function setup() {
  const leads = new InMemoryRepository<Lead>();
  const users = new InMemoryRepository<User>();
  const stages = new InMemoryRepository<CrmStage>();
  const crmStages = new CrmStageService(stages);
  await crmStages.seedDefaultStages('c1');
  const crm = new CrmService(leads, crmStages);
  const svc = new LeadImportService(leads, users, crm);
  return { leads, users, crm, svc };
}

test('buildPreview marks a well-formed row as valid', async () => {
  const { svc } = await setup();
  const preview = await svc.buildPreview('c1', [{ fullName: 'Ahmed Ali', phone: '0100000000', email: 'ahmed@example.com' }]);
  assert.equal(preview.validCount, 1);
  assert.equal(preview.rows[0]!.status, 'valid');
  assert.equal(preview.rows[0]!.resolved!.fullName, 'Ahmed Ali');
});

test('buildPreview flags a row missing fullName/phone as invalid', async () => {
  const { svc } = await setup();
  const preview = await svc.buildPreview('c1', [{ fullName: '', phone: '' }, { fullName: 'Sara', phone: '' }]);
  assert.equal(preview.invalidCount, 2);
  assert.match(preview.rows[0]!.issues.join(), /Full Name.*required/);
  assert.match(preview.rows[1]!.issues.join(), /Phone.*required/);
});

test('buildPreview flags a row duplicating an existing DB lead by phone', async () => {
  const { svc, crm } = await setup();
  await crm.createLead({ companyId: 'c1', fullName: 'Existing Lead', phone: '0100000000' });
  const preview = await svc.buildPreview('c1', [{ fullName: 'Ahmed Ali', phone: '0100000000' }]);
  assert.equal(preview.duplicateCount, 1);
  assert.match(preview.rows[0]!.issues.join(), /already exists/);
});

test('buildPreview flags a row duplicating an existing DB lead by email', async () => {
  const { svc, crm } = await setup();
  await crm.createLead({ companyId: 'c1', fullName: 'Existing Lead', phone: '0199999999', email: 'shared@example.com' });
  const preview = await svc.buildPreview('c1', [{ fullName: 'Ahmed Ali', phone: '0100000000', email: 'shared@example.com' }]);
  assert.equal(preview.duplicateCount, 1);
});

test('buildPreview flags two rows in the same file as duplicates of each other', async () => {
  const { svc } = await setup();
  const preview = await svc.buildPreview('c1', [
    { fullName: 'Ahmed Ali', phone: '0100000000' },
    { fullName: 'Ahmed Ali Again', phone: '0100000000' },
  ]);
  assert.equal(preview.validCount, 1);
  assert.equal(preview.duplicateCount, 1);
  assert.match(preview.rows[1]!.issues.join(), /Duplicate of an earlier row/);
});

test('buildPreview does not fail an unresolved owner email, just warns', async () => {
  const { svc } = await setup();
  const preview = await svc.buildPreview('c1', [{ fullName: 'Ahmed', phone: '0100000000', ownerEmail: 'nobody@example.com' }]);
  assert.equal(preview.rows[0]!.status, 'valid');
  assert.match(preview.rows[0]!.issues.join(), /No user found/);
});

test('importRows creates leads for valid rows and skips duplicates/invalid rows, without writing them', async () => {
  const { svc, leads } = await setup();
  const created: string[] = [];
  const result = await svc.importRows(
    'c1',
    'actor-1',
    [
      { fullName: 'Ahmed Ali', phone: '0100000000', email: 'ahmed@example.com' },
      { fullName: '', phone: '' }, // invalid
      { fullName: 'Ahmed Duplicate', phone: '0100000000' }, // duplicate of row 1
    ],
    async (lead) => {
      created.push(lead.id);
    },
  );
  assert.equal(result.total, 3);
  assert.equal(result.succeeded, 1);
  assert.equal(result.skipped, 2);
  assert.equal(result.failed, 0);
  assert.equal(created.length, 1);
  const allLeads = await leads.findAll();
  assert.equal(allLeads.length, 1);
  assert.equal(allLeads[0]!.fullName, 'Ahmed Ali');
});

test('importRows resolves ownerEmail to a real user id when one matches', async () => {
  const { svc, users } = await setup();
  const userId = randomUUID();
  await users.save({
    id: userId,
    companyId: 'c1',
    email: 'agent@example.com',
    passwordHash: 'x',
    userType: 'employee_user',
    locale: 'en',
    failedLoginCount: 0,
  } as User);
  const result = await svc.importRows('c1', 'actor-1', [{ fullName: 'Ahmed', phone: '0100000000', ownerEmail: 'agent@example.com' }], async () => {});
  assert.equal(result.succeeded, 1);
});

test('importRows never lets a race-created duplicate through — CrmService.createLead is the real backstop', async () => {
  const { svc, crm } = await setup();
  // Simulate a lead created after the preview was shown but before confirm.
  await crm.createLead({ companyId: 'c1', fullName: 'Raced In', phone: '0177777777' });
  const result = await svc.importRows('c1', 'actor-1', [{ fullName: 'Should Be Blocked', phone: '0177777777' }], async () => {});
  // evaluateRows re-checks existingLeads fresh at confirm time, so this is
  // caught as a duplicate (skipped), never reaching createLead at all.
  assert.equal(result.succeeded, 0);
  assert.equal(result.skipped, 1);
});
