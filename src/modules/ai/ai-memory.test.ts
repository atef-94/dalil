import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { AiMemoryService } from './ai-memory.service.js';
import type { AiMemory } from '../../domain/types.js';

function freshService() {
  const repo = new InMemoryRepository<AiMemory>();
  return { svc: new AiMemoryService(repo), repo };
}

test('remember rejects missing content', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.remember({
    companyId: 'c1',
    category: 'lead',
    content: '',
    source: { type: 'user_note' },
  }));
});

test('remember rejects missing source', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.remember({
    companyId: 'c1',
    category: 'lead',
    content: 'note',
    source: undefined as unknown as { type: 'user_note' },
  }));
});

test('remember rejects out-of-range confidence', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.remember({
    companyId: 'c1',
    category: 'lead',
    content: 'note',
    source: { type: 'user_note' },
    confidence: 150,
  }));
});

test('remember rejects subjectType without subjectId and vice versa', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.remember({
    companyId: 'c1',
    category: 'lead',
    content: 'note',
    source: { type: 'user_note' },
    subjectType: 'lead',
  }));
  await assert.rejects(() => svc.remember({
    companyId: 'c1',
    category: 'lead',
    content: 'note',
    source: { type: 'user_note' },
    subjectId: 'l1',
  }));
});

test('remember defaults confidence and sensitivity, stores real provenance', async () => {
  const { svc } = freshService();
  const memory = await svc.remember({
    companyId: 'c1',
    category: 'lead',
    content: 'Prefers WhatsApp over calls',
    subjectType: 'lead',
    subjectId: 'l1',
    source: { type: 'agent_decision', id: 'd1' },
  });
  assert.equal(memory.confidence, 60);
  assert.equal(memory.sensitivity, 'standard');
  assert.equal(memory.source.type, 'agent_decision');
  assert.equal(memory.source.id, 'd1');
});

test('recall excludes memories from a different company (tenant isolation)', async () => {
  const { svc } = freshService();
  await svc.remember({ companyId: 'c1', category: 'company', content: 'c1 fact', source: { type: 'system' } });
  await svc.remember({ companyId: 'c2', category: 'company', content: 'c2 fact', source: { type: 'system' } });
  const result = await svc.recall('c1', {});
  assert.equal(result.length, 1);
  assert.equal(result[0]!.content, 'c1 fact');
});

test('recall excludes invalidated memories', async () => {
  const { svc } = freshService();
  const memory = await svc.remember({ companyId: 'c1', category: 'company', content: 'fact', source: { type: 'system' } });
  await svc.invalidate(memory.id, 'c1', 'u1');
  const result = await svc.recall('c1', {});
  assert.equal(result.length, 0);
});

test('recall excludes expired memories', async () => {
  const { svc } = freshService();
  await svc.remember({
    companyId: 'c1',
    category: 'working',
    content: 'stale fact',
    source: { type: 'system' },
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const result = await svc.recall('c1', {});
  assert.equal(result.length, 0);
});

test('recall ranks subject-matching memory above a non-matching one of equal age/confidence', async () => {
  const { svc } = freshService();
  await svc.remember({ companyId: 'c1', category: 'lead', content: 'about a different lead', subjectType: 'lead', subjectId: 'other', source: { type: 'system' }, confidence: 60 });
  await svc.remember({ companyId: 'c1', category: 'lead', content: 'about this lead', subjectType: 'lead', subjectId: 'l1', source: { type: 'system' }, confidence: 60 });
  const result = await svc.recall('c1', { subjectType: 'lead', subjectId: 'l1' });
  assert.equal(result[0]!.content, 'about this lead');
});

test('recall respects the limit parameter', async () => {
  const { svc } = freshService();
  for (let i = 0; i < 5; i++) {
    await svc.remember({ companyId: 'c1', category: 'company', content: `fact ${i}`, source: { type: 'system' } });
  }
  const result = await svc.recall('c1', {}, 2);
  assert.equal(result.length, 2);
});

test('invalidate is idempotent and rejects cross-tenant access', async () => {
  const { svc } = freshService();
  const memory = await svc.remember({ companyId: 'c1', category: 'company', content: 'fact', source: { type: 'system' } });
  const first = await svc.invalidate(memory.id, 'c1', 'u1');
  const second = await svc.invalidate(memory.id, 'c1', 'u2');
  assert.equal(first.invalidatedAt, second.invalidatedAt);
  await assert.rejects(() => svc.invalidate(memory.id, 'c2', 'u1'));
});

test('get rejects a memory belonging to a different company', async () => {
  const { svc } = freshService();
  const memory = await svc.remember({ companyId: 'c1', category: 'company', content: 'fact', source: { type: 'system' } });
  await assert.rejects(() => svc.get(memory.id, 'c2'));
});

test('sweepExpiredMemories invalidates only past-expiry, non-invalidated rows', async () => {
  const { svc, repo } = freshService();
  const expired = await svc.remember({ companyId: 'c1', category: 'working', content: 'old', source: { type: 'system' }, expiresAt: new Date(Date.now() - 1000).toISOString() });
  const live = await svc.remember({ companyId: 'c1', category: 'working', content: 'fresh', source: { type: 'system' }, expiresAt: new Date(Date.now() + 100000).toISOString() });
  const swept = await svc.sweepExpiredMemories();
  assert.equal(swept, 1);
  assert.ok((await repo.findById(expired.id))!.invalidatedAt);
  assert.ok(!(await repo.findById(live.id))!.invalidatedAt);
});
