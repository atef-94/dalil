import { randomUUID } from 'node:crypto';
import type { Branch, Company, Department, Employee } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { OrgValidationError, NotFoundError } from '../../infra/errors.js';

export interface CreateCompanyInput {
  name: string;
}

export interface CreateEmployeeInput {
  companyId: string;
  fullName: string;
  email: string;
  title: string;
  departmentId?: string;
  branchId?: string;
  teamId?: string;
  managerEmployeeId?: string;
}

export interface CreateBranchInput {
  companyId: string;
  name: string;
  address?: string;
}

export interface CreateDepartmentInput {
  companyId: string;
  name: string;
  branchId?: string;
}

export class OrganizationService {
  constructor(
    private readonly companies: Repository<Company>,
    private readonly employees: Repository<Employee>,
    private readonly branches: Repository<Branch>,
    private readonly departments: Repository<Department>,
  ) {}

  async createBranch(input: CreateBranchInput): Promise<Branch> {
    if (!input.name?.trim()) throw new OrgValidationError('name is required');
    const branch: Branch = {
      id: randomUUID(),
      companyId: input.companyId,
      name: input.name.trim(),
      address: input.address?.trim() || undefined,
      createdAt: new Date().toISOString(),
    };
    return this.branches.save(branch);
  }

  async listBranches(companyId: string): Promise<Branch[]> {
    return this.branches.findAll((b) => b.companyId === companyId);
  }

  async getBranch(id: string): Promise<Branch | undefined> {
    return this.branches.findById(id);
  }

  async createDepartment(input: CreateDepartmentInput): Promise<Department> {
    if (!input.name?.trim()) throw new OrgValidationError('name is required');
    if (input.branchId) {
      const branch = await this.branches.findById(input.branchId);
      if (!branch || branch.companyId !== input.companyId) {
        throw new OrgValidationError('branchId does not exist in this company');
      }
    }
    const department: Department = {
      id: randomUUID(),
      companyId: input.companyId,
      name: input.name.trim(),
      branchId: input.branchId,
      createdAt: new Date().toISOString(),
    };
    return this.departments.save(department);
  }

  async listDepartments(companyId: string): Promise<Department[]> {
    return this.departments.findAll((d) => d.companyId === companyId);
  }

  async getDepartment(id: string): Promise<Department | undefined> {
    return this.departments.findById(id);
  }

  async createCompany(input: CreateCompanyInput): Promise<Company> {
    if (!input.name?.trim()) {
      throw new OrgValidationError('name is required');
    }
    const id = randomUUID();
    const company: Company = { id, companyId: id, name: input.name.trim(), createdAt: new Date().toISOString() };
    return this.companies.save(company);
  }

  async createEmployee(input: CreateEmployeeInput): Promise<Employee> {
    if (!input.fullName?.trim()) throw new OrgValidationError('fullName is required');
    if (!input.email?.trim()) throw new OrgValidationError('email is required');
    if (!input.title?.trim()) throw new OrgValidationError('title is required');

    if (input.managerEmployeeId) {
      const manager = await this.employees.findById(input.managerEmployeeId);
      if (!manager || manager.companyId !== input.companyId) {
        throw new OrgValidationError('managerEmployeeId does not exist in this company');
      }
    }
    if (input.branchId) {
      const branch = await this.branches.findById(input.branchId);
      if (!branch || branch.companyId !== input.companyId) {
        throw new OrgValidationError('branchId does not exist in this company');
      }
    }
    if (input.departmentId) {
      const department = await this.departments.findById(input.departmentId);
      if (!department || department.companyId !== input.companyId) {
        throw new OrgValidationError('departmentId does not exist in this company');
      }
    }

    const employee: Employee = {
      id: randomUUID(),
      companyId: input.companyId,
      fullName: input.fullName.trim(),
      email: input.email.trim().toLowerCase(),
      title: input.title.trim(),
      departmentId: input.departmentId,
      branchId: input.branchId,
      teamId: input.teamId,
      managerEmployeeId: input.managerEmployeeId,
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    return this.employees.save(employee);
  }

  async listEmployees(companyId: string): Promise<Employee[]> {
    return this.employees.findAll((e) => e.companyId === companyId);
  }

  async getEmployee(id: string): Promise<Employee | undefined> {
    return this.employees.findById(id);
  }

  /**
   * Walks the proposed manager's reporting chain looking for `employeeId`.
   * Rejects both direct cycles (A manages B, B set to manage A) and
   * indirect ones (A -> B -> C -> A).
   */
  private async wouldCreateCycle(employeeId: string, proposedManagerId: string): Promise<boolean> {
    let currentId: string | undefined = proposedManagerId;
    const visited = new Set<string>();
    while (currentId) {
      if (currentId === employeeId) return true;
      if (visited.has(currentId)) return false; // already-broken chain elsewhere; not this employee's problem
      visited.add(currentId);
      const current = await this.employees.findById(currentId);
      currentId = current?.managerEmployeeId;
    }
    return false;
  }

  async reassignManager(employeeId: string, newManagerEmployeeId: string, companyId: string): Promise<Employee> {
    const employee = await this.employees.findById(employeeId);
    if (!employee || employee.companyId !== companyId) throw new NotFoundError('employee not found');

    if (newManagerEmployeeId === employeeId) {
      throw new OrgValidationError('an employee cannot manage themselves');
    }
    const newManager = await this.employees.findById(newManagerEmployeeId);
    if (!newManager || newManager.companyId !== employee.companyId) {
      throw new OrgValidationError('managerEmployeeId does not exist in this company');
    }
    if (await this.wouldCreateCycle(employeeId, newManagerEmployeeId)) {
      throw new OrgValidationError('this reassignment would create a circular reporting chain');
    }

    const updated: Employee = { ...employee, managerEmployeeId: newManagerEmployeeId };
    return this.employees.save(updated);
  }

  async terminate(employeeId: string, companyId: string): Promise<Employee> {
    const employee = await this.employees.findById(employeeId);
    if (!employee || employee.companyId !== companyId) throw new NotFoundError('employee not found');
    const updated: Employee = { ...employee, status: 'terminated', terminatedAt: new Date().toISOString() };
    return this.employees.save(updated);
  }
}
