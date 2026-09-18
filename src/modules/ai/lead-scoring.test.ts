import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { LeadScoringService } from './lead-scoring.service.js';
import { CrmStageService } from '../crm/crm-stage.service.js';
import type { CrmStage, Lead } from '../../domain/types.js';

async function freshService(companyIds: string[] = ['c1', 'c2']) {
  const leads = new InMemoryRepository<Lead>();
  const crmStages = new CrmStageService(new InMemoryRepository<CrmStage>());
  for (const companyId of companyIds) {
    await crmStages.seedDefaultStages(companyId);
  }
  const svc = new LeadScoringService(leads, crmStages);
  return { svc, leads, crmStages };
}

async function stageByKey(crmStages: CrmStageService, companyId: string, key: string): Promise<CrmStage> {
  const stages = await crmStages.listStages(companyId, true);
  const stage = stages.find((s) => s.key === key);
  if (!stage) throw new Error(`no seeded stage with key "${key}" for ${companyId}`);
  return stage;
}

test('scoreLead rejects a nonexistent lead', async () => {
  const { svc } = await freshService();
  await assert.rejects(() => svc.scoreLead('nope', 'c1'));
});

test('a lead in a Lost-flagged stage always scores 0', async () => {
  const { svc, leads, crmStages } = await freshService();
  const lost = await stageByKey(crmStages, 'c1', 'lost');
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', stageId: lost.id, lostReason: 'no budget', createdAt: new Date().toISOString() });
  const result = await svc.scoreLead('l1', 'c1');
  assert.equal(result.score, 0);
});

test('a fresh Won-stage lead with an owner scores higher than a stale default-stage lead with no owner', async () => {
  const { svc, leads, crmStages } = await freshService();
  const fresh = await stageByKey(crmStages, 'c1', 'fresh');
  const won = await stageByKey(crmStages, 'c1', 'won');
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'Stale', phone: '1', stageId: fresh.id, createdAt: old });
  await leads.save({ id: 'l2', companyId: 'c1', fullName: 'Hot', phone: '2', stageId: won.id, ownerEmployeeUserId: 'u1', sourceId: 'campaign-1', createdAt: new Date().toISOString() });
  const stale = await svc.scoreLead('l1', 'c1');
  const hot = await svc.scoreLead('l2', 'c1');
  assert.ok(hot.score > stale.score);
});

test('scoreLead rejects a lead belonging to a different company (cross-tenant)', async () => {
  const { svc, leads, crmStages } = await freshService();
  const fresh = await stageByKey(crmStages, 'c1', 'fresh');
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', stageId: fresh.id, createdAt: new Date().toISOString() });
  await assert.rejects(() => svc.scoreLead('l1', 'c2'));
});

test('rankedLeads excludes leads in a Lost-flagged stage and sorts descending by score', async () => {
  const { svc, leads, crmStages } = await freshService();
  const fresh = await stageByKey(crmStages, 'c1', 'fresh');
  const won = await stageByKey(crmStages, 'c1', 'won');
  const lost = await stageByKey(crmStages, 'c1', 'lost');
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'New', phone: '1', stageId: fresh.id, createdAt: new Date().toISOString() });
  await leads.save({ id: 'l2', companyId: 'c1', fullName: 'Won', phone: '2', stageId: won.id, createdAt: new Date().toISOString() });
  await leads.save({ id: 'l3', companyId: 'c1', fullName: 'Lost', phone: '3', stageId: lost.id, lostReason: 'x', createdAt: new Date().toISOString() });
  const ranked = await svc.rankedLeads('c1');
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0]!.leadId, 'l2');
  assert.ok(ranked[0]!.score >= ranked[1]!.score);
});

test('rankedLeads only returns leads for the requested company (multi-tenant isolation)', async () => {
  const { svc, leads, crmStages } = await freshService();
  const freshC1 = await stageByKey(crmStages, 'c1', 'fresh');
  const freshC2 = await stageByKey(crmStages, 'c2', 'fresh');
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', stageId: freshC1.id, createdAt: new Date().toISOString() });
  await leads.save({ id: 'l2', companyId: 'c2', fullName: 'B', phone: '2', stageId: freshC2.id, createdAt: new Date().toISOString() });
  const ranked = await svc.rankedLeads('c1');
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.leadId, 'l1');
});
