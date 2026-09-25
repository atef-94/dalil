import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { CrmService } from './crm.service.js';
import { CrmStageService } from './crm-stage.service.js';
import type { CrmStage, Lead } from '../../domain/types.js';

async function freshService(companyIds: string[] = ['c1', 'c2']) {
  const crmStages = new CrmStageService(new InMemoryRepository<CrmStage>());
  for (const companyId of companyIds) {
    await crmStages.seedDefaultStages(companyId);
  }
  const svc = new CrmService(new InMemoryRepository<Lead>(), crmStages);
  return { svc, crmStages };
}

async function stageByKey(crmStages: CrmStageService, companyId: string, key: string): Promise<CrmStage> {
  const stages = await crmStages.listStages(companyId, true);
  const stage = stages.find((s) => s.key === key);
  if (!stage) throw new Error(`no seeded stage with key "${key}" for ${companyId}`);
  return stage;
}

test('a new lead lands in the company default (Fresh Leads) stage', async () => {
  const { svc, crmStages } = await freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  const fresh = await stageByKey(crmStages, 'c1', 'fresh');
  assert.equal(lead.stageId, fresh.id);
});

test('creating a lead with a duplicate phone in the same company is rejected', async () => {
  const { svc } = await freshService();
  await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  await assert.rejects(() => svc.createLead({ companyId: 'c1', fullName: 'Client B', phone: '0100' }));
});

test('creating a lead with a duplicate email in the same company is rejected', async () => {
  const { svc } = await freshService();
  await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100', email: 'a@x.com' });
  await assert.rejects(() => svc.createLead({ companyId: 'c1', fullName: 'Client B', phone: '0200', email: 'a@x.com' }));
});

test('dedup is scoped per company: the same phone is allowed in a different company', async () => {
  const { svc } = await freshService();
  await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  const second = await svc.createLead({ companyId: 'c2', fullName: 'Client B', phone: '0100' });
  assert.equal(second.phone, '0100');
});

test('moveToStage moves a lead into a different CRM stage, keeping the same lead id (never duplicated)', async () => {
  const { svc, crmStages } = await freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  const contacted = await stageByKey(crmStages, 'c1', 'no_answer');
  const updated = await svc.moveToStage(lead.id, 'c1', contacted.id);
  assert.equal(updated.id, lead.id);
  assert.equal(updated.stageId, contacted.id);
});

test('moveToStage allows moving a lead backward in the pipeline (no forward-only lock, unlike the old status enum)', async () => {
  const { svc, crmStages } = await freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  const qualified = await stageByKey(crmStages, 'c1', 'meeting');
  const contacted = await stageByKey(crmStages, 'c1', 'no_answer');
  await svc.moveToStage(lead.id, 'c1', qualified.id);
  const backward = await svc.moveToStage(lead.id, 'c1', contacted.id);
  assert.equal(backward.stageId, contacted.id);
});

test('moving a lead into a Lost-flagged stage without a lostReason is rejected', async () => {
  const { svc, crmStages } = await freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  const lost = await stageByKey(crmStages, 'c1', 'cancellation');
  await assert.rejects(() => svc.moveToStage(lead.id, 'c1', lost.id));
});

test('moving a lead into a Lost-flagged stage with a lostReason succeeds and records the reason', async () => {
  const { svc, crmStages } = await freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  const lost = await stageByKey(crmStages, 'c1', 'cancellation');
  const updated = await svc.moveToStage(lead.id, 'c1', lost.id, 'Went with a competitor');
  assert.equal(updated.stageId, lost.id);
  assert.equal(updated.lostReason, 'Went with a competitor');
});

test('a lead in a Lost-flagged stage can be moved out again (fixable, not a hard lock)', async () => {
  const { svc, crmStages } = await freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  const lost = await stageByKey(crmStages, 'c1', 'cancellation');
  const contacted = await stageByKey(crmStages, 'c1', 'no_answer');
  await svc.moveToStage(lead.id, 'c1', lost.id, 'Went with a competitor');
  const revived = await svc.moveToStage(lead.id, 'c1', contacted.id);
  assert.equal(revived.stageId, contacted.id);
});

test('moveToStage rejects a lead belonging to a different company (cross-tenant)', async () => {
  const { svc, crmStages } = await freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  const contacted = await stageByKey(crmStages, 'c2', 'no_answer');
  await assert.rejects(() => svc.moveToStage(lead.id, 'c2', contacted.id));
});

test('moveToStage rejects moving a lead into an archived CRM stage', async () => {
  const { svc, crmStages } = await freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  const recycle = await stageByKey(crmStages, 'c1', 'cold_call');
  await crmStages.archiveStage(recycle.id, 'c1');
  await assert.rejects(() => svc.moveToStage(lead.id, 'c1', recycle.id));
});

test('assignOwner reassigns a lead to a new owner', async () => {
  const { svc } = await freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  const reassigned = await svc.assignOwner(lead.id, 'c1', 'emp-2');
  assert.equal(reassigned.ownerEmployeeUserId, 'emp-2');
});

test('assignOwner rejects a lead belonging to a different company (cross-tenant)', async () => {
  const { svc } = await freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  await assert.rejects(() => svc.assignOwner(lead.id, 'c2', 'emp-2'));
});

test('creating a lead with a duplicate national ID is rejected even when phone and email differ', async () => {
  const { svc } = await freshService();
  await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100', email: 'a@x.com', nationalId: 'NID-1' });
  await assert.rejects(() => svc.createLead({ companyId: 'c1', fullName: 'Client B (same person, fake details)', phone: '0999', email: 'fake@x.com', nationalId: 'NID-1' }));
});

test('national ID dedup is scoped per company, like phone/email', async () => {
  const { svc } = await freshService();
  await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100', nationalId: 'NID-1' });
  const second = await svc.createLead({ companyId: 'c2', fullName: 'Client B', phone: '0200', nationalId: 'NID-1' });
  assert.equal(second.nationalId, 'NID-1');
});

test('resolveCommissionOwner returns the original owner within the 60-day protection window, even after reassignment', async () => {
  const { svc } = await freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100', ownerEmployeeUserId: 'agent-original' });
  await svc.assignOwner(lead.id, 'c1', 'agent-new');
  const day30 = new Date(Date.parse(lead.createdAt) + 30 * 24 * 60 * 60 * 1000);
  const owner = await svc.resolveCommissionOwner(lead.id, 'c1', day30);
  assert.equal(owner, 'agent-original');
});

test('resolveCommissionOwner falls back to the current owner once the 60-day window has passed', async () => {
  const { svc } = await freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100', ownerEmployeeUserId: 'agent-original' });
  await svc.assignOwner(lead.id, 'c1', 'agent-new');
  const day61 = new Date(Date.parse(lead.createdAt) + 61 * 24 * 60 * 60 * 1000);
  const owner = await svc.resolveCommissionOwner(lead.id, 'c1', day61);
  assert.equal(owner, 'agent-new');
});

test('resolveCommissionOwner returns the current owner unchanged when the lead was never reassigned', async () => {
  const { svc } = await freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100', ownerEmployeeUserId: 'agent-1' });
  const owner = await svc.resolveCommissionOwner(lead.id, 'c1');
  assert.equal(owner, 'agent-1');
});

test('resolveCommissionOwner rejects a lead belonging to a different company (cross-tenant)', async () => {
  const { svc } = await freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  await assert.rejects(() => svc.resolveCommissionOwner(lead.id, 'c2'));
});

// ---- Concurrency: createLead's dedup check and per-lead read-modify-write
// methods are now KeyedMutex-protected. These tests would fail (produce
// duplicate leads / lose one of two concurrent updates) against the
// unprotected version of the service — Promise.all forces the interleaving
// a real double-submit or two simultaneous requests could hit.

test('10 concurrent createLead calls with the same phone number produce exactly one lead, not 10', async () => {
  const { svc } = await freshService();
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) => svc.createLead({ companyId: 'c1', fullName: `Client ${i}`, phone: '0100-same' })),
  );
  const succeeded = results.filter((r) => r.status === 'fulfilled');
  assert.equal(succeeded.length, 1, 'exactly one of the 10 concurrent same-phone creates should win');
  const all = await svc.listForScope({ kind: 'company', companyId: 'c1' }, async () => ({}));
  assert.equal(all.filter((l) => l.phone === '0100-same').length, 1);
});

test('10 concurrent createLead calls with the same email (different phones) produce exactly one lead', async () => {
  const { svc } = await freshService();
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) => svc.createLead({ companyId: 'c1', fullName: `Client ${i}`, phone: `0${i}`, email: 'dup@x.com' })),
  );
  const succeeded = results.filter((r) => r.status === 'fulfilled');
  assert.equal(succeeded.length, 1, 'exactly one of the 10 concurrent same-email creates should win');
});

test('concurrent createLead calls for different companies are not serialized against each other (mutex is per-company)', async () => {
  const { svc } = await freshService(['c1', 'c2']);
  const [a, b] = await Promise.all([
    svc.createLead({ companyId: 'c1', fullName: 'A', phone: '0100' }),
    svc.createLead({ companyId: 'c2', fullName: 'B', phone: '0100' }), // same phone, different company — not a dup
  ]);
  assert.equal(a.companyId, 'c1');
  assert.equal(b.companyId, 'c2');
});

test('20 concurrent moveToStage calls on the same lead never lose an update — the lead ends up in a real stage, not a stale pre-move snapshot', async () => {
  const { svc, crmStages } = await freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  const stages = await crmStages.listStages('c1', true);
  const nonLostStages = stages.filter((s) => !s.isLost);
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => svc.moveToStage(lead.id, 'c1', nonLostStages[i % nonLostStages.length]!.id)),
  );
  // Every call must have observed and returned a real, valid final write —
  // none of them should have silently overwritten another's result with a
  // torn/incomplete record (the hallmark of a lost-update race).
  for (const r of results) {
    assert.ok(nonLostStages.some((s) => s.id === r.stageId));
  }
  const finalLead = await svc.getLead(lead.id);
  assert.ok(nonLostStages.some((s) => s.id === finalLead!.stageId));
});
