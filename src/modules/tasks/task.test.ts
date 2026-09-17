import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { TaskService } from './task.service.js';
import type { Task } from '../../domain/types.js';

function freshService() {
  const tasks = new InMemoryRepository<Task>();
  return { svc: new TaskService(tasks), tasks };
}

test('creating a task with an empty title is rejected', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.createTask({ companyId: 'c1', title: '   ', createdByUserId: 'u1' }));
});

test('a valid task starts open', async () => {
  const { svc } = freshService();
  const task = await svc.createTask({ companyId: 'c1', title: 'Follow up with lead', createdByUserId: 'u1' });
  assert.equal(task.status, 'open');
  assert.equal(task.title, 'Follow up with lead');
  assert.equal(task.createdByUserId, 'u1');
});

test('completing a task transitions it to done', async () => {
  const { svc } = freshService();
  const task = await svc.createTask({ companyId: 'c1', title: 'Call customer', createdByUserId: 'u1' });
  const done = await svc.completeTask(task.id, 'c1');
  assert.equal(done.status, 'done');
  assert.ok(done.completedAt);
});

test('completing a task belonging to a different company is rejected (cross-tenant)', async () => {
  const { svc } = freshService();
  const task = await svc.createTask({ companyId: 'c1', title: 'Call customer', createdByUserId: 'u1' });
  await assert.rejects(() => svc.completeTask(task.id, 'c2'));
});

test('completing an already-completed task is rejected', async () => {
  const { svc } = freshService();
  const task = await svc.createTask({ companyId: 'c1', title: 'Call customer', createdByUserId: 'u1' });
  await svc.completeTask(task.id, 'c1');
  await assert.rejects(() => svc.completeTask(task.id, 'c1'));
});

test('completing a nonexistent task is rejected', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.completeTask('nope', 'c1'));
});

test('cancelling an open task transitions it to cancelled', async () => {
  const { svc } = freshService();
  const task = await svc.createTask({ companyId: 'c1', title: 'Send proposal', createdByUserId: 'u1' });
  const cancelled = await svc.cancelTask(task.id, 'c1');
  assert.equal(cancelled.status, 'cancelled');
});

test('cancelling a task belonging to a different company is rejected (cross-tenant)', async () => {
  const { svc } = freshService();
  const task = await svc.createTask({ companyId: 'c1', title: 'Send proposal', createdByUserId: 'u1' });
  await assert.rejects(() => svc.cancelTask(task.id, 'c2'));
});

test('cancelling an already-cancelled task is rejected', async () => {
  const { svc } = freshService();
  const task = await svc.createTask({ companyId: 'c1', title: 'Send proposal', createdByUserId: 'u1' });
  await svc.cancelTask(task.id, 'c1');
  await assert.rejects(() => svc.cancelTask(task.id, 'c1'));
});

test('listForUser only returns tasks assigned to that user, scoped to the company', async () => {
  const { svc } = freshService();
  await svc.createTask({ companyId: 'c1', title: 'Task A', assignedToUserId: 'u1', createdByUserId: 'u1' });
  await svc.createTask({ companyId: 'c1', title: 'Task B', assignedToUserId: 'u2', createdByUserId: 'u1' });
  await svc.createTask({ companyId: 'c2', title: 'Task C', assignedToUserId: 'u1', createdByUserId: 'u1' });
  const results = await svc.listForUser('u1', 'c1');
  assert.equal(results.length, 1);
  assert.equal(results[0]!.title, 'Task A');
});

test('listForCompany returns all tasks for that company only', async () => {
  const { svc } = freshService();
  await svc.createTask({ companyId: 'c1', title: 'Task A', createdByUserId: 'u1' });
  await svc.createTask({ companyId: 'c1', title: 'Task B', createdByUserId: 'u1' });
  await svc.createTask({ companyId: 'c2', title: 'Task C', createdByUserId: 'u1' });
  const results = await svc.listForCompany('c1');
  assert.equal(results.length, 2);
});
