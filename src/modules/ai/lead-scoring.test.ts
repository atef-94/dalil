import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { LeadScoringService } from './lead-scoring.service.js';
import type { Lead } from '../../domain/types.js';

function freshService() {
  return { svc: new LeadScoringService(new InMemoryRepository<Lead>()), leads: new InMemoryRepository<Lead>() };
}

test('scoreLead rejects a nonexistent lead', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.scoreLead('nope', 'c1'));
});

test('a lost lead always scores 0', async () => {
  const leads = new InMemoryRepository<Lead>();
  const svc = new LeadScoringService(leads);
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', status: 'lost', lostReason: 'no budget', createdAt: new Date().toISOString() });
  const result = await svc.scoreLead('l1', 'c1');
  assert.equal(result.score, 0);
});

test('a fresh opportunity-stage lead with an owner scores higher than a stale new lead with no owner', async () => {
  const leads = new InMemoryRepository<Lead>();
  const svc = new LeadScoringService(leads);
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'Stale', phone: '1', status: 'new', createdAt: old });
  await leads.save({ id: 'l2', companyId: 'c1', fullName: 'Hot', phone: '2', status: 'opportunity', ownerEmployeeUserId: 'u1', sourceId: 'campaign-1', createdAt: new Date().toISOString() });
  const stale = await svc.scoreLead('l1', 'c1');
  const hot = await svc.scoreLead('l2', 'c1');
  assert.ok(hot.score > stale.score);
});

test('scoreLead rejects a lead belonging to a different company (cross-tenant)', async () => {
  const leads = new InMemoryRepository<Lead>();
  const svc = new LeadScoringService(leads);
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', status: 'new', createdAt: new Date().toISOString() });
  await assert.rejects(() => svc.scoreLead('l1', 'c2'));
});

test('rankedLeads excludes lost leads and sorts descending by score', async () => {
  const leads = new InMemoryRepository<Lead>();
  const svc = new LeadScoringService(leads);
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'New', phone: '1', status: 'new', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l2', companyId: 'c1', fullName: 'Opp', phone: '2', status: 'opportunity', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l3', companyId: 'c1', fullName: 'Lost', phone: '3', status: 'lost', lostReason: 'x', createdAt: new Date().toISOString() });
  const ranked = await svc.rankedLeads('c1');
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0]!.leadId, 'l2');
  assert.ok(ranked[0]!.score >= ranked[1]!.score);
});

test('rankedLeads only returns leads for the requested company (multi-tenant isolation)', async () => {
  const leads = new InMemoryRepository<Lead>();
  const svc = new LeadScoringService(leads);
  await leads.save({ id: 'l1', companyId: 'c1', fullName: 'A', phone: '1', status: 'new', createdAt: new Date().toISOString() });
  await leads.save({ id: 'l2', companyId: 'c2', fullName: 'B', phone: '2', status: 'new', createdAt: new Date().toISOString() });
  const ranked = await svc.rankedLeads('c1');
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.leadId, 'l1');
});
