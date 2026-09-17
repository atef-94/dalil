import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { CommunicationService } from './communication.service.js';
import type { Message } from '../../domain/types.js';

function freshService() {
  return new CommunicationService(new InMemoryRepository<Message>());
}

test('sending a message rejects an empty subject', async () => {
  const svc = freshService();
  await assert.rejects(() => svc.sendMessage({ companyId: 'c1', fromUserId: 'u1', subject: '', body: 'hi' }));
});

test('a sent message defaults to channel internal and status sent', async () => {
  const svc = freshService();
  const message = await svc.sendMessage({ companyId: 'c1', fromUserId: 'u1', toUserId: 'u2', subject: 'Hi', body: 'Please review this lead.' });
  assert.equal(message.channel, 'internal');
  assert.equal(message.status, 'sent');
});

test('an explicit channel is preserved (logged only, no external gateway)', async () => {
  const svc = freshService();
  const message = await svc.sendMessage({ companyId: 'c1', fromUserId: 'u1', toUserId: 'u2', subject: 'Reminder', body: 'Your payment is due.', channel: 'whatsapp' });
  assert.equal(message.channel, 'whatsapp');
});

test('markRead transitions status and sets readAt', async () => {
  const svc = freshService();
  const message = await svc.sendMessage({ companyId: 'c1', fromUserId: 'u1', toUserId: 'u2', subject: 'Hi', body: 'body' });
  const read = await svc.markRead(message.id, 'c1', 'u2');
  assert.equal(read.status, 'read');
  assert.ok(read.readAt);
});

test('markRead rejects a reader who is not the recipient', async () => {
  const svc = freshService();
  const message = await svc.sendMessage({ companyId: 'c1', fromUserId: 'u1', toUserId: 'u2', subject: 'Hi', body: 'body' });
  await assert.rejects(() => svc.markRead(message.id, 'c1', 'someone-else'));
});

test('markRead rejects a message belonging to a different company (cross-tenant)', async () => {
  const svc = freshService();
  const message = await svc.sendMessage({ companyId: 'c1', fromUserId: 'u1', toUserId: 'u2', subject: 'Hi', body: 'body' });
  await assert.rejects(() => svc.markRead(message.id, 'c2', 'u2'));
});

test('listForResource returns only messages tied to that resource, scoped to the company', async () => {
  const svc = freshService();
  await svc.sendMessage({ companyId: 'c1', fromUserId: 'u1', subject: 'A', body: 'body', relatedResource: 'lead', relatedResourceId: 'lead-1' });
  await svc.sendMessage({ companyId: 'c1', fromUserId: 'u1', subject: 'B', body: 'body', relatedResource: 'lead', relatedResourceId: 'lead-2' });
  const results = await svc.listForResource('lead', 'lead-1', 'c1');
  assert.equal(results.length, 1);
  assert.equal(results[0]!.subject, 'A');
});

test('listForUser returns messages where the user is sender or recipient', async () => {
  const svc = freshService();
  await svc.sendMessage({ companyId: 'c1', fromUserId: 'u1', toUserId: 'u2', subject: 'A', body: 'body' });
  await svc.sendMessage({ companyId: 'c1', fromUserId: 'u3', toUserId: 'u4', subject: 'B', body: 'body' });
  const results = await svc.listForUser('u2', 'c1');
  assert.equal(results.length, 1);
  assert.equal(results[0]!.subject, 'A');
});
