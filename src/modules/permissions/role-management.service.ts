import { randomUUID } from 'node:crypto';
import type { ActionName, PermissionGrant, ResourceName, Role, ScopeName, SensitivityTier, UserRole } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError, ValidationError } from '../../infra/errors.js';

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

  async addGrant(companyId: string, roleId: string, input: AddGrantInput): Promise<PermissionGrant> {
    const role = await this.roles.findById(roleId);
    if (!role || role.companyId !== companyId) throw new NotFoundError('role not found');
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
