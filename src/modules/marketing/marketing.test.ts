import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { MarketingService } from './marketing.service.js';
import type { Campaign, Lead } from '../../domain/types.js';

function freshService() {
  const campaigns = new InMemoryRepository<Campaign>();
  const leads = new InMemoryRepository<Lead>();
  return { svc: new MarketingService(campaigns, leads), leads };
}

test('creating a campaign starts planned', async () => {
  const { svc } = freshService();
  const campaign = await svc.createCampaign({ companyId: 'c1', name: 'Spring Launch', channel: 'digital', budget: 5000, startDate: '2026-03-01' });
  assert.equal(campaign.status, 'planned');
});

test('creating a campaign rejects a negative budget', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.createCampaign({ companyId: 'c1', name: 'Spring Launch', channel: 'digital', budget: -1, startDate: '2026-03-01' }));
});

test('valid status transition planned -> active -> completed', async () => {
  const { svc } = freshService();
  const campaign = await svc.createCampaign({ companyId: 'c1', name: 'Spring Launch', channel: 'digital', budget: 5000, startDate: '2026-03-01' });
  const active = await svc.updateStatus(campaign.id, 'c1', 'active');
  assert.equal(active.status, 'active');
  const completed = await svc.updateStatus(campaign.id, 'c1', 'completed');
  assert.equal(completed.status, 'completed');
});

test('an invalid status transition (planned -> completed) is rejected', async () => {
  const { svc } = freshService();
  const campaign = await svc.createCampaign({ companyId: 'c1', name: 'Spring Launch', channel: 'digital', budget: 5000, startDate: '2026-03-01' });
  await assert.rejects(() => svc.updateStatus(campaign.id, 'c1', 'completed'));
});

test('updateStatus rejects a campaign belonging to a different company (cross-tenant)', async () => {
  const { svc } = freshService();
  const campaign = await svc.createCampaign({ companyId: 'c1', name: 'Spring Launch', channel: 'digital', budget: 5000, startDate: '2026-03-01' });
  await assert.rejects(() => svc.updateStatus(campaign.id, 'c2', 'active'));
});

test('campaignPerformance attributes leads by sourceId and computes conversion rate', async () => {
  const { svc, leads } = freshService();
  const campaign = await svc.createCampaign({ companyId: 'c1', name: 'Spring Launch', channel: 'digital', budget: 5000, startDate: '2026-03-01' });
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', sourceId: campaign.id, status: 'opportunity', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l2', companyId: 'c1', fullName: 'B', phone: '2', sourceId: campaign.id, status: 'qualified', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l3', companyId: 'c1', fullName: 'C', phone: '3', sourceId: campaign.id, status: 'new', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l4', companyId: 'c1', fullName: 'D', phone: '4', sourceId: 'other-source', status: 'opportunity', createdAt: new Date().toISOString() });

  const perf = await svc.campaignPerformance(campaign.id, 'c1');
  assert.equal(perf.leadCount, 3);
  assert.equal(perf.qualifiedCount, 2);
  assert.equal(perf.convertedCount, 1);
  assert.equal(perf.conversionRate, 33.3);
});

test('campaignPerformance rejects a campaign belonging to a different company (cross-tenant)', async () => {
  const { svc } = freshService();
  const campaign = await svc.createCampaign({ companyId: 'c1', name: 'Spring Launch', channel: 'digital', budget: 5000, startDate: '2026-03-01' });
  await assert.rejects(() => svc.campaignPerformance(campaign.id, 'c2'));
});
