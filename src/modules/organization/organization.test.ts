import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { OrganizationService } from './organization.service.js';
import type { Branch, Company, Department, Employee } from '../../domain/types.js';

function freshService() {
  return new OrganizationService(
    new InMemoryRepository<Company>(),
    new InMemoryRepository<Employee>(),
    new InMemoryRepository<Branch>(),
    new InMemoryRepository<Department>(),
  );
}

test('creating an employee with a manager that does not exist in the company fails', async () => {
  const svc = freshService();
  await assert.rejects(() => svc.createEmployee({ companyId: 'c1', fullName: 'Bob', email: 'bob@c1.com', title: 'Agent', managerEmployeeId: 'nonexistent' }));
});

test('a direct circular reporting chain is rejected (A tries to manage their own manager)', async () => {
  const svc = freshService();
  const manager = await svc.createEmployee({ companyId: 'c1', fullName: 'Manager', email: 'mgr@c1.com', title: 'Manager' });
  const report = await svc.createEmployee({ companyId: 'c1', fullName: 'Report', email: 'report@c1.com', title: 'Agent', managerEmployeeId: manager.id });
  await assert.rejects(() => svc.reassignManager(manager.id, report.id, 'c1'));
});

test('an indirect circular reporting chain (A -> B -> C -> A) is rejected', async () => {
  const svc = freshService();
  const a = await svc.createEmployee({ companyId: 'c1', fullName: 'A', email: 'a@c1.com', title: 'Exec' });
  const b = await svc.createEmployee({ companyId: 'c1', fullName: 'B', email: 'b@c1.com', title: 'Mgr', managerEmployeeId: a.id });
  const c = await svc.createEmployee({ companyId: 'c1', fullName: 'C', email: 'c@c1.com', title: 'Agent', managerEmployeeId: b.id });
  await assert.rejects(() => svc.reassignManager(a.id, c.id, 'c1'));
});

test('a valid manager reassignment succeeds', async () => {
  const svc = freshService();
  const managerOne = await svc.createEmployee({ companyId: 'c1', fullName: 'Manager One', email: 'm1@c1.com', title: 'Manager' });
  const managerTwo = await svc.createEmployee({ companyId: 'c1', fullName: 'Manager Two', email: 'm2@c1.com', title: 'Manager' });
  const employee = await svc.createEmployee({ companyId: 'c1', fullName: 'Employee', email: 'e@c1.com', title: 'Agent', managerEmployeeId: managerOne.id });
  const updated = await svc.reassignManager(employee.id, managerTwo.id, 'c1');
  assert.equal(updated.managerEmployeeId, managerTwo.id);
});

test('reassignManager rejects an employee belonging to a different company', async () => {
  const svc = freshService();
  const managerOne = await svc.createEmployee({ companyId: 'c1', fullName: 'Manager One', email: 'm1@c1.com', title: 'Manager' });
  const employee = await svc.createEmployee({ companyId: 'c1', fullName: 'Employee', email: 'e@c1.com', title: 'Agent', managerEmployeeId: managerOne.id });
  await assert.rejects(() => svc.reassignManager(employee.id, managerOne.id, 'c2'));
});

test('terminating an employee sets status and terminatedAt', async () => {
  const svc = freshService();
  const employee = await svc.createEmployee({ companyId: 'c1', fullName: 'Employee', email: 'e@c1.com', title: 'Agent' });
  const terminated = await svc.terminate(employee.id, 'c1');
  assert.equal(terminated.status, 'terminated');
  assert.ok(terminated.terminatedAt);
});

test('terminate rejects an employee belonging to a different company', async () => {
  const svc = freshService();
  const employee = await svc.createEmployee({ companyId: 'c1', fullName: 'Employee', email: 'e@c1.com', title: 'Agent' });
  await assert.rejects(() => svc.terminate(employee.id, 'c2'));
});

test('listEmployees only returns employees for the requested company (multi-tenant isolation)', async () => {
  const svc = freshService();
  await svc.createEmployee({ companyId: 'c1', fullName: 'Employee One', email: 'e1@c1.com', title: 'Agent' });
  await svc.createEmployee({ companyId: 'c2', fullName: 'Employee Two', email: 'e2@c2.com', title: 'Agent' });
  const c1Employees = await svc.listEmployees('c1');
  assert.equal(c1Employees.length, 1);
  assert.equal(c1Employees[0]!.email, 'e1@c1.com');
});

test('creating a branch then listing it scoped to the company', async () => {
  const svc = freshService();
  await svc.createBranch({ companyId: 'c1', name: 'Cairo HQ' });
  await svc.createBranch({ companyId: 'c2', name: 'Other Co Branch' });
  const branches = await svc.listBranches('c1');
  assert.equal(branches.length, 1);
  assert.equal(branches[0]!.name, 'Cairo HQ');
});

test('creating a branch rejects an empty name', async () => {
  const svc = freshService();
  await assert.rejects(() => svc.createBranch({ companyId: 'c1', name: '  ' }));
});

test('creating a department with a branch from a different company is rejected', async () => {
  const svc = freshService();
  const branch = await svc.createBranch({ companyId: 'c2', name: 'Other Co Branch' });
  await assert.rejects(() => svc.createDepartment({ companyId: 'c1', name: 'Sales', branchId: branch.id }));
});

test('creating a department linked to a valid branch succeeds', async () => {
  const svc = freshService();
  const branch = await svc.createBranch({ companyId: 'c1', name: 'Cairo HQ' });
  const department = await svc.createDepartment({ companyId: 'c1', name: 'Sales', branchId: branch.id });
  assert.equal(department.branchId, branch.id);
});

test('creating an employee with a branchId from a different company is rejected', async () => {
  const svc = freshService();
  const branch = await svc.createBranch({ companyId: 'c2', name: 'Other Co Branch' });
  await assert.rejects(() => svc.createEmployee({ companyId: 'c1', fullName: 'Bob', email: 'bob@c1.com', title: 'Agent', branchId: branch.id }));
});

test('creating an employee with a departmentId from a different company is rejected', async () => {
  const svc = freshService();
  const department = await svc.createDepartment({ companyId: 'c2', name: 'Other Co Dept' });
  await assert.rejects(() => svc.createEmployee({ companyId: 'c1', fullName: 'Bob', email: 'bob@c1.com', title: 'Agent', departmentId: department.id }));
});

test('creating an employee with a valid branch and department succeeds', async () => {
  const svc = freshService();
  const branch = await svc.createBranch({ companyId: 'c1', name: 'Cairo HQ' });
  const department = await svc.createDepartment({ companyId: 'c1', name: 'Sales', branchId: branch.id });
  const employee = await svc.createEmployee({ companyId: 'c1', fullName: 'Bob', email: 'bob@c1.com', title: 'Agent', branchId: branch.id, departmentId: department.id });
  assert.equal(employee.branchId, branch.id);
  assert.equal(employee.departmentId, department.id);
});
