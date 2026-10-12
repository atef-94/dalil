import { randomUUID } from 'node:crypto';
import type { ActionName, PermissionGrant, ResourceName, Role, ScopeName, SensitivityTier, UserRole } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError, ValidationError, ForbiddenError } from '../../infra/errors.js';
import { RbacEvaluator, SCOPE_PRIORITY } from './rbac.evaluator.js';

export interface AddGrantInput {
  action: ActionName;
  resource: ResourceName;
  scope: ScopeName;
  sensitivity?: SensitivityTier;
}

/**
 * The role-management API the original report flagged as missing: without
 * it, the only roles that function are the four hardcoded demo roles tied
 * to fixed demo userIds. This lets a company's own Owner/admin create real
 * custom roles, grant/revoke specific permissions on them, and assign or
 * revoke those roles for real registered users — connecting real login to
 * real, assignable RBAC.
 */
export class RoleManagementService {
  constructor(
    private readonly roles: Repository<Role>,
    private readonly grants: Repository<PermissionGrant>,
    private readonly userRoles: Repository<UserRole>,
    /** Optional so existing tests that construct this service directly
     * (without a full RbacEvaluator) keep working unchanged — addGrant()'s
     * privilege-escalation guard below simply no-ops when it's absent. Every
     * real caller in app.ts passes the real one. */
    private readonly rbac?: RbacEvaluator,
  ) {}

  async createRole(companyId: string, name: string): Promise<Role> {
    if (!name?.trim()) throw new ValidationError('name is required');
    const role: Role = { id: randomUUID(), companyId, name: name.trim(), isSystem: false };
    return this.roles.save(role);
  }

  async listRoles(companyId: string): Promise<Role[]> {
    return this.roles.findAll((r) => r.companyId === companyId);
  }

  async getRole(id: string): Promise<Role | undefined> {
    return this.roles.findById(id);
  }

  /**
   * `actorUserId` guards against privilege escalation: a company admin with
   * only edit:role (not the permission being granted itself) could
   * otherwise create a role granting itself — or any other user — broader
   * access than it actually holds, including a scope wider than its own
   * (e.g. a 'department'-scoped manager granting a 'company'-wide view:lead
   * grant to any role, then assigning that role to themselves). Skipped
   * (no-op) when `actorUserId` is omitted or `rbac` wasn't supplied to the
   * constructor, so every pre-existing call site keeps working unchanged;
   * every real app.ts route below passes both.
   */
  async addGrant(companyId: string, roleId: string, input: AddGrantInput, actorUserId?: string): Promise<PermissionGrant> {
    const role = await this.roles.findById(roleId);
    if (!role || role.companyId !== companyId) throw new NotFoundError('role not found');

    if (actorUserId && this.rbac && input.scope !== 'broker_own') {
      const actorScope = await this.rbac.getListAccessScope(actorUserId, input.action, input.resource);
      if (actorScope.kind === 'none') {
        throw new ForbiddenError(`cannot grant ${input.action}:${input.resource} — you do not hold that permission yourself`);
      }
      const grantedRank = SCOPE_PRIORITY.indexOf(input.scope);
      const actorRank = SCOPE_PRIORITY.indexOf(actorScope.kind as ScopeName);
      if (grantedRank < actorRank) {
        throw new ForbiddenError(
          `cannot grant ${input.action}:${input.resource} at scope '${input.scope}' — broader than your own '${actorScope.kind}' access to it`,
        );
      }
    }

    const grant: PermissionGrant = {
      id: randomUUID(),
      roleId,
      action: input.action,
      resource: input.resource,
      scope: input.scope,
      sensitivity: input.sensitivity ?? 'standard',
    };
    return this.grants.save(grant);
  }

  async listGrants(roleId: string): Promise<PermissionGrant[]> {
    return this.grants.findAll((g) => g.roleId === roleId);
  }

  async removeGrant(companyId: string, roleId: string, grantId: string): Promise<boolean> {
    const role = await this.roles.findById(roleId);
    if (!role || role.companyId !== companyId) throw new NotFoundError('role not found');
    const grant = await this.grants.findById(grantId);
    if (!grant || grant.roleId !== roleId) throw new NotFoundError('grant not found on this role');
    return this.grants.deleteById(grantId);
  }

  async assignRole(userId: string, roleId: string, expiresAt?: string): Promise<UserRole> {
    const role = await this.roles.findById(roleId);
    if (!role) throw new NotFoundError('role not found');
    const userRole: UserRole = { id: randomUUID(), userId, roleId, expiresAt };
    return this.userRoles.save(userRole);
  }

  async listUserRoles(userId: string): Promise<UserRole[]> {
    return this.userRoles.findAll((ur) => ur.userId === userId);
  }

  async revokeUserRole(userId: string, userRoleId: string): Promise<boolean> {
    const userRole = await this.userRoles.findById(userRoleId);
    if (!userRole || userRole.userId !== userId) throw new NotFoundError('role assignment not found for this user');
    return this.userRoles.deleteById(userRoleId);
  }
}
