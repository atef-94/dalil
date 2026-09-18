import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import type { CrmStage } from '../../domain/types.js';
import { CrmStageService } from './crm-stage.service.js';

function freshService() {
  return new CrmStageService(new InMemoryRepository<CrmStage>());
}

test('seedDefaultStages creates the full default pipeline with exactly one default stage', async () => {
  const svc = freshService();
  const stages = await svc.seedDefaultStages('c1');
  assert.equal(stages.length, 12);
  const defaults = stages.filter((s) => s.isDefault);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0]!.key, 'fresh');
  assert.ok(stages.some((s) => s.isWon));
  assert.ok(stages.filter((s) => s.isLost).length >= 1);
  // sorted by order
  for (let i = 1; i < stages.length; i++) assert.ok(stages[i]!.order >= stages[i - 1]!.order);
});

test('seedDefaultStages is idempotent — calling it twice never duplicates stages', async () => {
  const svc = freshService();
  const first = await svc.seedDefaultStages('c1');
  const second = await svc.seedDefaultStages('c1');
  assert.equal(first.length, second.length);
  assert.deepEqual(first.map((s) => s.id).sort(), second.map((s) => s.id).sort());
});

test('listStages excludes inactive stages by default, company-scoped', async () => {
  const svc = freshService();
  await svc.seedDefaultStages('c1');
  await svc.seedDefaultStages('c2');
  const custom = await svc.createStage({ companyId: 'c1', name: 'VIP Clients' });
  await svc.archiveStage(custom.id, 'c1');
  const activeC1 = await svc.listStages('c1');
  assert.equal(activeC1.length, 12); // 12 defaults, VIP archived out
  const c2 = await svc.listStages('c2');
  assert.equal(c2.length, 12);
});

test('createStage rejects a duplicate key, and both isWon+isLost at once', async () => {
  const svc = freshService();
  await svc.seedDefaultStages('c1');
  await assert.rejects(() => svc.createStage({ companyId: 'c1', name: 'Fresh Leads', key: 'fresh' }));
  await assert.rejects(() => svc.createStage({ companyId: 'c1', name: 'Bad', isWon: true, isLost: true }));
});

test('a custom admin-created stage gets a real order and default flags', async () => {
  const svc = freshService();
  await svc.seedDefaultStages('c1');
  const stage = await svc.createStage({ companyId: 'c1', name: 'VIP Clients', icon: 'star', color: '#f5a623' });
  assert.equal(stage.order, 12); // after the 12 seeded defaults
  assert.equal(stage.isDefault, false);
  assert.equal(stage.allowManualMove, true);
  assert.equal(stage.allowAutomationMove, true);
  assert.equal(stage.key, 'vip_clients');
});

test('updateStage rejects setting both isWon and isLost true', async () => {
  const svc = freshService();
  const [stage] = await svc.seedDefaultStages('c1');
  await assert.rejects(() => svc.updateStage(stage!.id, 'c1', { isWon: true, isLost: true }));
});

test('reorderStages reassigns order by the given sequence, rejects a foreign stage id', async () => {
  const svc = freshService();
  const stages = await svc.seedDefaultStages('c1');
  const reversedIds = [...stages].reverse().map((s) => s.id);
  const reordered = await svc.reorderStages('c1', reversedIds);
  assert.equal(reordered[0]!.id, reversedIds[0]);
  assert.equal(reordered[0]!.order, 0);

  const other = await svc.seedDefaultStages('c2');
  await assert.rejects(() => svc.reorderStages('c1', [other[0]!.id]));
});

test('setDefaultStage moves the flag — exactly one default remains', async () => {
  const svc = freshService();
  const stages = await svc.seedDefaultStages('c1');
  const contacted = stages.find((s) => s.key === 'contacted')!;
  await svc.setDefaultStage(contacted.id, 'c1');
  const all = await svc.listStages('c1');
  const defaults = all.filter((s) => s.isDefault);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0]!.id, contacted.id);
});

test('archiveStage refuses to archive the current default stage', async () => {
  const svc = freshService();
  const stages = await svc.seedDefaultStages('c1');
  const fresh = stages.find((s) => s.isDefault)!;
  await assert.rejects(() => svc.archiveStage(fresh.id, 'c1'));
});

test('getStage and archiveStage reject a stage belonging to a different company (cross-tenant)', async () => {
  const svc = freshService();
  const stagesA = await svc.seedDefaultStages('c1');
  await svc.seedDefaultStages('c2');
  const someStageA = stagesA.find((s) => !s.isDefault)!;
  await assert.rejects(() => svc.getStage(someStageA.id, 'c2'));
  await assert.rejects(() => svc.archiveStage(someStageA.id, 'c2'));
});

test('getDefaultStage throws when a company has no default stage configured', async () => {
  const svc = freshService();
  await assert.rejects(() => svc.getDefaultStage('empty-co'));
});
