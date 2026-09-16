import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { OrganizationService } from './organization.service.js';
import type { Company, Employee } from '../../domain/types.js';

function freshService() {
  return new OrganizationService(new InMemoryRepository<Company>(), new InMemoryRepository<Employee>());
}

test('creating an employee with a manager that does not exist in the company fails', async () => {
  const svc = freshService();
  await assert.rejects(() => svc.createEmployee({ companyId: 'c1', fullName: 'Bob', email: 'bob@c1.com', title: 'Agent', managerEmployeeId: 'nonexistent' }));
});

test('a direct circular reporting chain is rejected (A tries to manage their own manager)', async () => {
  const svc = freshService();
  const manager = await svc.createEmployee({ companyId: 'c1', fullName: 'Manager', email: 'mgr@c1.com', title: 'Manager' });
  const report = await svc.createEmployee({ companyId: 'c1', fullName: 'Report', email: 'report@c1.com', title: 'Agent', managerEmployeeId: manager.id });
  await assert.rejects(() => svc.reassignManager(manager.id, report.id));
});

test('an indirect circular reporting chain (A -> B -> C -> A) is rejected', async () => {
  const svc = freshService();
  const a = await svc.createEmployee({ companyId: 'c1', fullName: 'A', email: 'a@c1.com', title: 'Exec' });
  const b = await svc.createEmployee({ companyId: 'c1', fullName: 'B', email: 'b@c1.com', title: 'Mgr', managerEmployeeId: a.id });
  const c = await svc.createEmployee({ companyId: 'c1', fullName: 'C', email: 'c@c1.com', title: 'Agent', managerEmployeeId: b.id });
  await assert.rejects(() => svc.reassignManager(a.id, c.id));
});

test('a valid manager reassignment succeeds', async () => {
  const svc = freshService();
  const managerOne = await svc.createEmployee({ companyId: 'c1', fullName: 'Manager One', email: 'm1@c1.com', title: 'Manager' });
  const managerTwo = await svc.createEmployee({ companyId: 'c1', fullName: 'Manager Two', email: 'm2@c1.com', title: 'Manager' });
  const employee = await svc.createEmployee({ companyId: 'c1', fullName: 'Employee', email: 'e@c1.com', title: 'Agent', managerEmployeeId: managerOne.id });
  const updated = await svc.reassignManager(employee.id, managerTwo.id);
  assert.equal(updated.managerEmployeeId, managerTwo.id);
});

test('terminating an employee sets status and terminatedAt', async () => {
  const svc = freshService();
  const employee = await svc.createEmployee({ companyId: 'c1', fullName: 'Employee', email: 'e@c1.com', title: 'Agent' });
  const terminated = await svc.terminate(employee.id);
  assert.equal(terminated.status, 'terminated');
  assert.ok(terminated.terminatedAt);
});

test('listEmployees only returns employees for the requested company (multi-tenant isolation)', async () => {
  const svc = freshService();
  await svc.createEmployee({ companyId: 'c1', fullName: 'Employee One', email: 'e1@c1.com', title: 'Agent' });
  await svc.createEmployee({ companyId: 'c2', fullName: 'Employee Two', email: 'e2@c2.com', title: 'Agent' });
  const c1Employees = await svc.listEmployees('c1');
  assert.equal(c1Employees.length, 1);
  assert.equal(c1Employees[0]!.email, 'e1@c1.com');
});
