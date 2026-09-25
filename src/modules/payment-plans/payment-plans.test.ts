import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { PaymentPlansService } from './payment-plans.service.js';
import type { PaymentPlanTemplate, PaymentScheduleLine } from '../../domain/types.js';

function freshService() {
  const templates = new InMemoryRepository<PaymentPlanTemplate>();
  const scheduleLines = new InMemoryRepository<PaymentScheduleLine>();
  const svc = new PaymentPlansService(templates, scheduleLines);
  return { svc, templates, scheduleLines };
}

const baseTemplateInput = {
  companyId: 'c1',
  name: 'Standard 20/80',
  downPaymentType: 'percentage' as const,
  downPaymentValue: 20,
  frequency: 'monthly' as const,
  termMonths: 12,
  fees: [],
};

test('createTemplate persists a version-1 template and rejects an invalid one', async () => {
  const { svc } = freshService();
  const template = await svc.createTemplate(baseTemplateInput);
  assert.equal(template.version, 1);
  assert.equal(template.archived, false);
  await assert.rejects(() => svc.createTemplate({ ...baseTemplateInput, termMonths: 0 }));
});

test('listTemplates scopes by company and excludes archived templates', async () => {
  const { svc, templates } = freshService();
  await svc.createTemplate(baseTemplateInput);
  await svc.createTemplate({ ...baseTemplateInput, companyId: 'c2' });
  const archived = await svc.createTemplate(baseTemplateInput);
  await templates.save({ ...archived, archived: true });

  const list = await svc.listTemplates('c1');
  assert.equal(list.length, 1);
});

test('updateTemplate bumps the version and never mutates already-generated schedules', async () => {
  const { svc } = freshService();
  const template = await svc.createTemplate(baseTemplateInput);
  const lines = await svc.generateForContract('contract-1', 'c1', template.id, 100000);
  assert.equal(lines[0]!.sourceTemplateVersion, 1);

  const updated = await svc.updateTemplate(template.id, { downPaymentValue: 30 });
  assert.equal(updated.version, 2);

  const stillOriginal = await svc.getScheduleForContract('contract-1', 'c1');
  assert.equal(stillOriginal[0]!.sourceTemplateVersion, 1);
  assert.equal(stillOriginal[0]!.amount, 20000); // still 20% of 100000, not the new 30%
});

test('updateTemplate rejects a nonexistent template', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.updateTemplate('missing', { downPaymentValue: 10 }));
});

test('previewSchedule generates without persisting anything', async () => {
  const { svc, scheduleLines } = freshService();
  const template = await svc.createTemplate(baseTemplateInput);
  const preview = await svc.previewSchedule(template.id, 'c1', 100000);
  assert.ok(preview.length > 1);
  const persisted = await scheduleLines.findAll(() => true);
  assert.equal(persisted.length, 0);
});

test('previewSchedule rejects a cross-tenant template', async () => {
  const { svc } = freshService();
  const template = await svc.createTemplate(baseTemplateInput);
  await assert.rejects(() => svc.previewSchedule(template.id, 'c2', 100000));
});

test('previewSchedule rejects a nonexistent template', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.previewSchedule('missing', 'c1', 100000));
});

test('generateForContract persists real schedule lines summing to the total price', async () => {
  const { svc } = freshService();
  const template = await svc.createTemplate(baseTemplateInput);
  const lines = await svc.generateForContract('contract-1', 'c1', template.id, 500000);
  // Summing many already-cent-rounded floats can leave a sub-cent binary
  // float residual (e.g. 500000.0000000002) — round the aggregate before
  // comparing, the same way FinanceService.getBalance already does for
  // every real balance shown to a user.
  const sum = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  assert.equal(sum, 500000);
  assert.ok(lines.every((l) => l.status === 'upcoming' && l.amountPaid === 0));
});

test('generateForContract is idempotent — a second call returns the same persisted lines, not duplicates', async () => {
  const { svc, scheduleLines } = freshService();
  const template = await svc.createTemplate(baseTemplateInput);
  const first = await svc.generateForContract('contract-1', 'c1', template.id, 500000);
  const second = await svc.generateForContract('contract-1', 'c1', template.id, 999999999); // different price ignored on replay
  assert.deepEqual(first.map((l) => l.id), second.map((l) => l.id));
  const allLines = await scheduleLines.findAll((l) => l.contractId === 'contract-1');
  assert.equal(allLines.length, first.length);
});

test('generateForContract rejects a cross-tenant template', async () => {
  const { svc } = freshService();
  const template = await svc.createTemplate(baseTemplateInput);
  await assert.rejects(() => svc.generateForContract('contract-1', 'c2', template.id, 500000));
});

test('getScheduleForContract returns lines sorted by sequence, scoped to the company', async () => {
  const { svc } = freshService();
  const template = await svc.createTemplate(baseTemplateInput);
  await svc.generateForContract('contract-1', 'c1', template.id, 240000);
  const lines = await svc.getScheduleForContract('contract-1', 'c1');
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i]!.sequence > lines[i - 1]!.sequence);
  const crossTenant = await svc.getScheduleForContract('contract-1', 'c2');
  assert.equal(crossTenant.length, 0);
});

test('rescaleUnpaidLines proportionally rescales unpaid lines to sum to the new target', async () => {
  const { svc, scheduleLines } = freshService();
  const template = await svc.createTemplate(baseTemplateInput);
  await svc.generateForContract('contract-1', 'c1', template.id, 100000);
  const rescaled = await svc.rescaleUnpaidLines('contract-1', 'c1', 150000);
  const sum = Math.round(rescaled.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  assert.equal(sum, 150000);
});

test('rescaleUnpaidLines never touches a paid or partially-paid line', async () => {
  const { svc, scheduleLines } = freshService();
  const template = await svc.createTemplate(baseTemplateInput);
  const lines = await svc.generateForContract('contract-1', 'c1', template.id, 100000);
  const downPayment = lines[0]!;
  await scheduleLines.save({ ...downPayment, amountPaid: downPayment.amount, status: 'paid' });

  await svc.rescaleUnpaidLines('contract-1', 'c1', 90000);
  const untouched = await scheduleLines.findById(downPayment.id);
  assert.equal(untouched!.amount, downPayment.amount);
  assert.equal(untouched!.amountPaid, downPayment.amount);
});

test('rescaleUnpaidLines rejects a negative target', async () => {
  const { svc } = freshService();
  const template = await svc.createTemplate(baseTemplateInput);
  await svc.generateForContract('contract-1', 'c1', template.id, 100000);
  await assert.rejects(() => svc.rescaleUnpaidLines('contract-1', 'c1', -1));
});

test('rescaleUnpaidLines rejects absorbing a positive balance when every line is already paid', async () => {
  const { svc, scheduleLines } = freshService();
  const template = await svc.createTemplate(baseTemplateInput);
  const lines = await svc.generateForContract('contract-1', 'c1', template.id, 100000);
  for (const line of lines) {
    await scheduleLines.save({ ...line, amountPaid: line.amount, status: 'paid' });
  }
  await assert.rejects(() => svc.rescaleUnpaidLines('contract-1', 'c1', 5000));
});
