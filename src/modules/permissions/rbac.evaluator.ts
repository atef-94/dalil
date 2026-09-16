import type {
  ActionName,
  Employee,
  PermissionGrant,
  PermissionOverride,
  ResourceName,
  Role,
  ScopeName,
  User,
  UserRole,
} from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';

export interface RbacRepos {
  users: Repository<User>;
  employees: Repository<Employee>;
  roles: Repository<Role>;
  grants: Repository<PermissionGrant>;
  userRoles: Repository<UserRole>;
  overrides: Repository<PermissionOverride>;
}

// Context describing the specific record a write/read check is being made
// against. Omit for create-type actions (there is no existing record yet).
export interface RecordTarget {
  companyId: string;
  ownerUserId?: string;
  departmentId?: string;
  branchId?: string;
  managerEmployeeId?: string; // the direct manager of the record's owner (for 'team' scope)
  brokerCompanyId?: string;
  submittedByUserId?: string;
}

const SCOPE_PRIORITY: ScopeName[] = ['company', 'branch', 'department', 'team', 'own', 'broker_own'];

export type ListScope =
  | { kind: 'none' }
  | { kind: 'company'; companyId: string }
  | { kind: 'branch'; companyId: string; branchId: string }
  | { kind: 'department'; companyId: string; departmentId: string }
  | { kind: 'team'; companyId: string; managerEmployeeId: string }
  | { kind: 'own'; companyId: string; userId: string }
  | { kind: 'broker_own'; companyId: string; brokerCompanyId: string };

function isActive(expiresAt: string | undefined, now: number): boolean {
  return !expiresAt || Date.parse(expiresAt) > now;
}

// Default-deny, four-dimension evaluator: Action x Resource x Scope x Sensitivity.
export class RbacEvaluator {
  constructor(private readonly repos: RbacRepos) {}

  private async activeUserRoles(userId: string, now: number): Promise<UserRole[]> {
    const all = await this.repos.userRoles.findAll((ur) => ur.userId === userId);
    return all.filter((ur) => isActive(ur.expiresAt, now));
  }

  private async matchingOverride(
    userId: string,
    action: ActionName,
    resource: ResourceName,
    now: number,
  ): Promise<PermissionOverride | undefined> {
    const overrides = await this.repos.overrides.findAll(
      (o) => o.userId === userId && o.action === action && o.resource === resource && isActive(o.expiresAt, now),
    );
    // Revoke beats grant: if any active revoke exists, it wins outright.
    const revoke = overrides.find((o) => o.effect === 'revoke');
    if (revoke) return revoke;
    return overrides.find((o) => o.effect === 'grant');
  }

  private async grantsFor(userId: string, action: ActionName, resource: ResourceName, now: number): Promise<PermissionGrant[]> {
    const userRoles = await this.activeUserRoles(userId, now);
    const roleIds = new Set(userRoles.map((ur) => ur.roleId));
    if (roleIds.size === 0) return [];
    const allGrants = await this.repos.grants.findAll(
      (g) => roleIds.has(g.roleId) && g.action === action && g.resource === resource,
    );
    return allGrants;
  }

  private async employeeFor(user: User): Promise<Employee | undefined> {
    if (!user.employeeId) return undefined;
    return this.repos.employees.findById(user.employeeId);
  }

  /**
   * Single-record check for write/read endpoints. `target` describes the
   * record being acted on; omit it for create-type actions.
   */
  async can(userId: string, action: ActionName, resource: ResourceName, target?: RecordTarget): Promise<boolean> {
    const now = Date.now();
    const user = await this.repos.users.findById(userId);
    if (!user) return false;

    const override = await this.matchingOverride(userId, action, resource, now);
    if (override?.effect === 'revoke') return false;

    if (target && target.companyId !== user.companyId) {
      // Multi-tenant hard wall: an override can never reach across tenants.
      return false;
    }

    if (override?.effect === 'grant') return true;

    // Broker hard-wall: a broker_user is never allowed a scope broader than
    // broker_own, even if a grant is misconfigured with a wider scope.
    if (user.userType === 'broker_user') {
      const grants = await this.grantsFor(userId, action, resource, now);
      if (grants.length === 0) return false;
      if (!target) return true; // create-type action, no record to scope-check yet
      return target.submittedByUserId === userId || (!!target.brokerCompanyId && target.brokerCompanyId === user.brokerCompanyId);
    }

    const grants = await this.grantsFor(userId, action, resource, now);
    if (grants.length === 0) return false;
    if (!target) return true; // create-type action

    const employee = await this.employeeFor(user);

    for (const grant of grants) {
      if (await this.scopeAllows(grant.scope, user, employee, target)) {
        return true;
      }
    }
    return false;
  }

  private async scopeAllows(
    scope: ScopeName,
    user: User,
    employee: Employee | undefined,
    target: RecordTarget,
  ): Promise<boolean> {
    switch (scope) {
      case 'company':
        return target.companyId === user.companyId;
      case 'branch':
        return !!employee?.branchId && employee.branchId === target.branchId;
      case 'department':
        return !!employee?.departmentId && employee.departmentId === target.departmentId;
      case 'team':
        return !!employee && !!target.managerEmployeeId && employee.id === target.managerEmployeeId;
      case 'own':
        return target.ownerUserId === user.id;
      case 'broker_own':
        return target.submittedByUserId === user.id || (!!target.brokerCompanyId && target.brokerCompanyId === user.brokerCompanyId);
      default:
        return false;
    }
  }

  /**
   * Resolves the broadest scope a user is entitled to for a *list*-type
   * endpoint, separately from single-record checks. Fixes a real bug where
   * list endpoints used to fabricate a single-record target that could never
   * satisfy a department/branch/team-scoped grant.
   */
  async getListAccessScope(userId: string, action: ActionName, resource: ResourceName): Promise<ListScope> {
    const now = Date.now();
    const user = await this.repos.users.findById(userId);
    if (!user) return { kind: 'none' };

    const override = await this.matchingOverride(userId, action, resource, now);
    if (override?.effect === 'revoke') return { kind: 'none' };

    if (user.userType === 'broker_user') {
      const grants = await this.grantsFor(userId, action, resource, now);
      if (grants.length === 0 && override?.effect !== 'grant') return { kind: 'none' };
      if (!user.brokerCompanyId) return { kind: 'none' };
      return { kind: 'broker_own', companyId: user.companyId, brokerCompanyId: user.brokerCompanyId };
    }

    if (override?.effect === 'grant') {
      return { kind: 'company', companyId: user.companyId };
    }

    const grants = await this.grantsFor(userId, action, resource, now);
    if (grants.length === 0) return { kind: 'none' };

    const employee = await this.employeeFor(user);
    const scopes = new Set(grants.map((g) => g.scope));

    for (const scope of SCOPE_PRIORITY) {
      if (!scopes.has(scope)) continue;
      switch (scope) {
        case 'company':
          return { kind: 'company', companyId: user.companyId };
        case 'branch':
          if (employee?.branchId) return { kind: 'branch', companyId: user.companyId, branchId: employee.branchId };
          break;
        case 'department':
          if (employee?.departmentId) {
            return { kind: 'department', companyId: user.companyId, departmentId: employee.departmentId };
          }
          break;
        case 'team':
          if (employee) return { kind: 'team', companyId: user.companyId, managerEmployeeId: employee.id };
          break;
        case 'own':
          return { kind: 'own', companyId: user.companyId, userId: user.id };
        case 'broker_own':
          if (user.brokerCompanyId) {
            return { kind: 'broker_own', companyId: user.companyId, brokerCompanyId: user.brokerCompanyId };
          }
          break;
      }
    }
    return { kind: 'none' };
  }
}
