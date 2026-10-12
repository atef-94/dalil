import { randomUUID } from 'node:crypto';
import type { Employee, Invitation, Role, User } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { generateRawToken, hashToken } from '../../infra/security.js';
import { ValidationError, NotFoundError } from '../../infra/errors.js';
import type { OrganizationService } from './organization.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { RoleManagementService } from '../permissions/role-management.service.js';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface CreateInvitationInput {
  companyId: string;
  email: string;
  roleId: string;
  createdByUserId: string;
}

export interface AcceptInvitationInput {
  token: string;
  fullName: string;
  password: string;
  locale?: 'en' | 'ar';
}

/**
 * The only way (besides platform-owner-initiated tenant creation — see
 * platform-admin.service.ts) a new account can be created now that public
 * self-service signup is gone. Reuses the exact same admin-gated chain
 * `/api/organization/employees` + `/api/auth/register` + `/api/users/:id/
 * roles` already used — this service doesn't duplicate any of that logic,
 * it only adds the token-issuance/acceptance layer on top, with the
 * companyId/roleId baked into the invitation row rather than ever trusted
 * from the accepting client.
 */
export class InvitationService {
  constructor(
    private readonly invitations: Repository<Invitation>,
    private readonly roles: Repository<Role>,
    private readonly organization: OrganizationService,
    private readonly auth: AuthService,
    private readonly roleManagement: RoleManagementService,
  ) {}

  async createInvitation(input: CreateInvitationInput): Promise<{ invitation: Invitation; rawToken: string }> {
    const email = input.email?.trim().toLowerCase();
    if (!email) throw new ValidationError('email is required');
    const role = await this.roles.findById(input.roleId);
    if (!role || role.companyId !== input.companyId) throw new NotFoundError('role not found');

    const rawToken = generateRawToken();
    const invitation: Invitation = {
      id: randomUUID(),
      companyId: input.companyId,
      email,
      roleId: input.roleId,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS).toISOString(),
      createdByUserId: input.createdByUserId,
      createdAt: new Date().toISOString(),
    };
    await this.invitations.save(invitation);
    return { invitation, rawToken };
  }

  async listInvitations(companyId: string): Promise<Invitation[]> {
    return this.invitations.findAll((i) => i.companyId === companyId);
  }

  async revokeInvitation(companyId: string, invitationId: string): Promise<void> {
    const invitation = await this.invitations.findById(invitationId);
    if (!invitation || invitation.companyId !== companyId) throw new NotFoundError('invitation not found');
    await this.invitations.save({ ...invitation, revokedAt: new Date().toISOString() });
  }

  /** Looks a still-valid (not expired/accepted/revoked) invitation up by its
   * raw token — never exposes companyId/roleId/tokenHash to an unauthenticated
   * caller beyond what the accept-page UI needs (email, which company). */
  async getInvitationByToken(rawToken: string): Promise<{ email: string; companyName: string } | undefined> {
    const invitation = await this.findValidInvitation(rawToken);
    if (!invitation) return undefined;
    const company = await this.organization.getCompany(invitation.companyId);
    return { email: invitation.email, companyName: company?.name ?? '' };
  }

  async acceptInvitation(input: AcceptInvitationInput): Promise<{ token: string; user: User; employee: Employee }> {
    const invitation = await this.findValidInvitation(input.token);
    if (!invitation) throw new ValidationError('invitation is invalid, expired, or already used');
    if (!input.fullName?.trim()) throw new ValidationError('fullName is required');

    const employee = await this.organization.createEmployee({
      companyId: invitation.companyId,
      fullName: input.fullName,
      email: invitation.email,
      title: 'Team Member',
    });
    const user = await this.auth.register({
      companyId: invitation.companyId,
      email: invitation.email,
      password: input.password,
      userType: 'employee_user',
      locale: input.locale ?? 'en',
      employeeId: employee.id,
    });
    await this.roleManagement.assignRole(user.id, invitation.roleId);
    await this.invitations.save({ ...invitation, acceptedAt: new Date().toISOString() });

    const token = this.auth.issueTokenForUser(user);
    return { token, user, employee };
  }

  private async findValidInvitation(rawToken: string): Promise<Invitation | undefined> {
    if (!rawToken) return undefined;
    const tokenHash = hashToken(rawToken);
    const now = Date.now();
    const [invitation] = await this.invitations.findAll(
      (i) => i.tokenHash === tokenHash && !i.acceptedAt && !i.revokedAt && Date.parse(i.expiresAt) > now,
    );
    return invitation;
  }
}
