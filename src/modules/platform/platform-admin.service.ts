import type { AuditLogEntry, Company } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError, ValidationError } from '../../infra/errors.js';
import type { AuditLog } from '../../infra/audit-log.js';
import { PLATFORM_COMPANY_ID } from '../permissions/platform-owner.js';
import { OnboardingService, type SignupInput, type SignupResult } from '../onboarding/onboarding.service.js';

/**
 * Platform-owner-only tenant management. Every method here is reached only
 * through routes gated on isPlatformOwner(actor.email) directly (see
 * app.ts) — never through rbac.can()/the tenant grant system, which has no
 * platform concept at all (see platform-owner.ts's own doc comment for why
 * that's deliberate). createTenant() wraps OnboardingService.signupNewCompany
 * unchanged — the only thing that changes versus the old public
 * POST /api/auth/signup is who's allowed to call it.
 */
export class PlatformAdminService {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly companies: Repository<Company>,
    private readonly auditLog: AuditLog,
  ) {}

  async createTenant(input: SignupInput, actorOwnerUserId: string): Promise<SignupResult> {
    const result = await this.onboarding.signupNewCompany(input);
    await this.auditLog.record({
      companyId: PLATFORM_COMPANY_ID,
      actorUserId: actorOwnerUserId,
      action: 'create',
      resource: 'platform_tenant',
      resourceId: result.company.id,
      metadata: { platformAction: 'create_tenant', tenantName: result.company.name, tenantId: result.company.id },
    });
    return result;
  }

  /** Every tenant except the platform's own sentinel company. */
  async listTenants(): Promise<Company[]> {
    const all = await this.companies.findAll();
    return all.filter((c) => c.id !== PLATFORM_COMPANY_ID);
  }

  async setTenantStatus(companyId: string, status: 'active' | 'suspended', actorOwnerUserId: string): Promise<Company> {
    if (companyId === PLATFORM_COMPANY_ID) throw new ValidationError('the platform company itself cannot be suspended');
    const company = await this.companies.findById(companyId);
    if (!company) throw new NotFoundError('company not found');
    const updated = await this.companies.save({ ...company, status });
    await this.auditLog.record({
      companyId: PLATFORM_COMPANY_ID,
      actorUserId: actorOwnerUserId,
      action: 'edit',
      resource: 'platform_tenant',
      resourceId: companyId,
      metadata: { platformAction: status === 'suspended' ? 'suspend_tenant' : 'reactivate_tenant', tenantId: companyId },
    });
    return updated;
  }

  /** Unscoped platform-wide audit trail — platform-owner use only. */
  async listPlatformAuditTrail(): Promise<AuditLogEntry[]> {
    return this.auditLog.listAll();
  }
}
