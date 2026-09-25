import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { MarketingService } from './marketing.service.js';
import { CrmStageService } from '../crm/crm-stage.service.js';
import type { Campaign, CrmStage, Lead } from '../../domain/types.js';

async function freshService(companyIds: string[] = ['c1', 'c2']) {
  const campaigns = new InMemoryRepository<Campaign>();
  const leads = new InMemoryRepository<Lead>();
  const crmStages = new CrmStageService(new InMemoryRepository<CrmStage>());
  for (const companyId of companyIds) {
    await crmStages.seedDefaultStages(companyId);
  }
  return { svc: new MarketingService(campaigns, leads, crmStages), leads, crmStages };
}

async function stageByKey(crmStages: CrmStageService, companyId: string, key: string): Promise<CrmStage> {
  const stages = await crmStages.listStages(companyId, true);
  const stage = stages.find((s) => s.key === key);
  if (!stage) throw new Error(`no seeded stage with key "${key}" for ${companyId}`);
  return stage;
}

test('creating a campaign starts planned', async () => {
  const { svc } = await freshService();
  const campaign = await svc.createCampaign({ companyId: 'c1', name: 'Spring Launch', channel: 'digital', budget: 5000, startDate: '2026-03-01' });
  assert.equal(campaign.status, 'planned');
});

test('creating a campaign rejects a negative budget', async () => {
  const { svc } = await freshService();
  await assert.rejects(() => svc.createCampaign({ companyId: 'c1', name: 'Spring Launch', channel: 'digital', budget: -1, startDate: '2026-03-01' }));
});

test('valid status transition planned -> active -> completed', async () => {
  const { svc } = await freshService();
  const campaign = await svc.createCampaign({ companyId: 'c1', name: 'Spring Launch', channel: 'digital', budget: 5000, startDate: '2026-03-01' });
  const active = await svc.updateStatus(campaign.id, 'c1', 'active');
  assert.equal(active.status, 'active');
  const completed = await svc.updateStatus(campaign.id, 'c1', 'completed');
  assert.equal(completed.status, 'completed');
});

test('an invalid status transition (planned -> completed) is rejected', async () => {
  const { svc } = await freshService();
  const campaign = await svc.createCampaign({ companyId: 'c1', name: 'Spring Launch', channel: 'digital', budget: 5000, startDate: '2026-03-01' });
  await assert.rejects(() => svc.updateStatus(campaign.id, 'c1', 'completed'));
});

test('updateStatus rejects a campaign belonging to a different company (cross-tenant)', async () => {
  const { svc } = await freshService();
  const campaign = await svc.createCampaign({ companyId: 'c1', name: 'Spring Launch', channel: 'digital', budget: 5000, startDate: '2026-03-01' });
  await assert.rejects(() => svc.updateStatus(campaign.id, 'c2', 'active'));
});

test('campaignPerformance attributes leads by sourceId and computes conversion rate', async () => {
  const { svc, leads, crmStages } = await freshService();
  const won = await stageByKey(crmStages, 'c1', 'contacts');
  const qualified = await stageByKey(crmStages, 'c1', 'meeting');
  const fresh = await stageByKey(crmStages, 'c1', 'fresh');
  const campaign = await svc.createCampaign({ companyId: 'c1', name: 'Spring Launch', channel: 'digital', budget: 5000, startDate: '2026-03-01' });
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', sourceId: campaign.id, stageId: won.id, createdAt: new Date().toISOString() });
  await leads.save({ id: 'l2', companyId: 'c1', fullName: 'B', phone: '2', sourceId: campaign.id, stageId: qualified.id, createdAt: new Date().toISOString() });
  await leads.save({ id: 'l3', companyId: 'c1', fullName: 'C', phone: '3', sourceId: campaign.id, stageId: fresh.id, createdAt: new Date().toISOString() });
  await leads.save({ id: 'l4', companyId: 'c1', fullName: 'D', phone: '4', sourceId: 'other-source', stageId: won.id, createdAt: new Date().toISOString() });

  const perf = await svc.campaignPerformance(campaign.id, 'c1');
  assert.equal(perf.leadCount, 3);
  assert.equal(perf.qualifiedCount, 2); // l1 (won) and l2 (qualified) both moved past the default stage; l3 is still Fresh
  assert.equal(perf.convertedCount, 1); // only l1 reached the Won stage
  assert.equal(perf.conversionRate, 33.3);
});

test('campaignPerformance rejects a campaign belonging to a different company (cross-tenant)', async () => {
  const { svc } = await freshService();
  const campaign = await svc.createCampaign({ companyId: 'c1', name: 'Spring Launch', channel: 'digital', budget: 5000, startDate: '2026-03-01' });
  await assert.rejects(() => svc.campaignPerformance(campaign.id, 'c2'));
});
