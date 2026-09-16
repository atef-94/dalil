import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { HrService } from './hr.service.js';
import type { Employee, LeaveRequest } from '../../domain/types.js';

function freshService() {
  const employees = new InMemoryRepository<Employee>();
  const leaveRequests = new InMemoryRepository<LeaveRequest>();
  return { svc: new HrService(leaveRequests, employees), employees };
}

async function seedEmployee(employees: InMemoryRepository<Employee>, companyId = 'c1'): Promise<Employee> {
  return employees.save({
    id: 'emp-1',
    companyId,
    fullName: 'Test Employee',
    email: 'e@c1.com',
    title: 'Agent',
    status: 'active',
    createdAt: new Date().toISOString(),
  });
}

test('requesting leave for a nonexistent employee is rejected', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.requestLeave({ companyId: 'c1', employeeId: 'nope', type: 'annual', startDate: '2026-01-01', endDate: '2026-01-05' }));
});

test('requesting leave for an employee belonging to a different company is rejected (cross-tenant)', async () => {
  const { svc, employees } = freshService();
  await seedEmployee(employees, 'c1');
  await assert.rejects(() => svc.requestLeave({ companyId: 'c2', employeeId: 'emp-1', type: 'annual', startDate: '2026-01-01', endDate: '2026-01-05' }));
});

test('requesting leave with endDate before startDate is rejected', async () => {
  const { svc, employees } = freshService();
  await seedEmployee(employees);
  await assert.rejects(() => svc.requestLeave({ companyId: 'c1', employeeId: 'emp-1', type: 'annual', startDate: '2026-01-05', endDate: '2026-01-01' }));
});

test('a valid leave request starts pending', async () => {
  const { svc, employees } = freshService();
  await seedEmployee(employees);
  const leave = await svc.requestLeave({ companyId: 'c1', employeeId: 'emp-1', type: 'sick', startDate: '2026-01-01', endDate: '2026-01-02' });
  assert.equal(leave.status, 'pending');
});

test('approving a pending leave request transitions it to approved', async () => {
  const { svc, employees } = freshService();
  await seedEmployee(employees);
  const leave = await svc.requestLeave({ companyId: 'c1', employeeId: 'emp-1', type: 'annual', startDate: '2026-01-01', endDate: '2026-01-02' });
  const approved = await svc.approveLeave(leave.id, 'c1', 'manager-1');
  assert.equal(approved.status, 'approved');
  assert.equal(approved.decidedByUserId, 'manager-1');
  assert.ok(approved.decidedAt);
});

test('approving an already-decided leave request is rejected', async () => {
  const { svc, employees } = freshService();
  await seedEmployee(employees);
  const leave = await svc.requestLeave({ companyId: 'c1', employeeId: 'emp-1', type: 'annual', startDate: '2026-01-01', endDate: '2026-01-02' });
  await svc.approveLeave(leave.id, 'c1', 'manager-1');
  await assert.rejects(() => svc.approveLeave(leave.id, 'c1', 'manager-1'));
});

test('approveLeave rejects a leave request belonging to a different company (cross-tenant)', async () => {
  const { svc, employees } = freshService();
  await seedEmployee(employees);
  const leave = await svc.requestLeave({ companyId: 'c1', employeeId: 'emp-1', type: 'annual', startDate: '2026-01-01', endDate: '2026-01-02' });
  await assert.rejects(() => svc.approveLeave(leave.id, 'c2', 'manager-1'));
});

test('rejecting a pending leave request transitions it to rejected', async () => {
  const { svc, employees } = freshService();
  await seedEmployee(employees);
  const leave = await svc.requestLeave({ companyId: 'c1', employeeId: 'emp-1', type: 'unpaid', startDate: '2026-01-01', endDate: '2026-01-02' });
  const rejected = await svc.rejectLeave(leave.id, 'c1', 'manager-1');
  assert.equal(rejected.status, 'rejected');
});

test('cancelling own pending leave request succeeds', async () => {
  const { svc, employees } = freshService();
  await seedEmployee(employees);
  const leave = await svc.requestLeave({ companyId: 'c1', employeeId: 'emp-1', type: 'annual', startDate: '2026-01-01', endDate: '2026-01-02' });
  const cancelled = await svc.cancelLeave(leave.id, 'c1', 'emp-1');
  assert.equal(cancelled.status, 'cancelled');
});

test('cancelling another employee\'s leave request is rejected', async () => {
  const { svc, employees } = freshService();
  await seedEmployee(employees);
  const leave = await svc.requestLeave({ companyId: 'c1', employeeId: 'emp-1', type: 'annual', startDate: '2026-01-01', endDate: '2026-01-02' });
  await assert.rejects(() => svc.cancelLeave(leave.id, 'c1', 'someone-else'));
});

test('listForEmployee only returns that employee\'s requests, scoped to the company', async () => {
  const { svc, employees } = freshService();
  await seedEmployee(employees);
  await employees.save({ id: 'emp-2', companyId: 'c1', fullName: 'Other', email: 'o@c1.com', title: 'Agent', status: 'active', createdAt: new Date().toISOString() });
  await svc.requestLeave({ companyId: 'c1', employeeId: 'emp-1', type: 'annual', startDate: '2026-01-01', endDate: '2026-01-02' });
  await svc.requestLeave({ companyId: 'c1', employeeId: 'emp-2', type: 'annual', startDate: '2026-02-01', endDate: '2026-02-02' });
  const results = await svc.listForEmployee('emp-1', 'c1');
  assert.equal(results.length, 1);
  assert.equal(results[0]!.employeeId, 'emp-1');
});
