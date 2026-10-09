import type { Company, Employee, Role, User } from '../../domain/types.js';
import { ValidationError } from '../../infra/errors.js';
import type { OrganizationService } from '../organization/organization.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { RoleManagementService } from '../permissions/role-management.service.js';
import { ACTIONS, RESOURCES } from '../permissions/manifest.builder.js';
import type { CrmStageService } from '../crm/crm-stage.service.js';

export interface SignupInput {
  companyName: string;
  fullName: string;
  email: string;
  password: string;
  locale?: 'en' | 'ar';
}

export interface SignupResult {
  token: string;
  user: User;
  company: Company;
  employee: Employee;
  role: Role;
}

/**
 * Creates a brand-new tenant in one step: the company, the founding
 * employee, the user account, an unrestricted company-scoped "Owner" role,
 * and assigns it — so the founding account can immediately create
 * employees, issue invitations, and grant/limit their permissions through
 * the role-management API.
 *
 * No longer reachable as public self-service signup (that endpoint has been
 * removed — registration is invitation-only, per the platform's tenant-
 * isolation requirements). The sole caller now is PlatformAdminService.
 * createTenant(), itself gated on isPlatformOwner(); this service's own
 * logic is unchanged and still a plain, unprivileged building block.
 */
export class OnboardingService {
  constructor(
    private readonly organization: OrganizationService,
    private readonly auth: AuthService,
    private readonly roleManagement: RoleManagementService,
    private readonly crmStages: CrmStageService,
  ) {}

  async signupNewCompany(input: SignupInput): Promise<SignupResult> {
    if (!input.companyName?.trim()) throw new ValidationError('companyName is required');
    if (!input.fullName?.trim()) throw new ValidationError('fullName is required');

    const company = await this.organization.createCompany({ name: input.companyName });
    // Every company needs a CRM pipeline to create leads into at all —
    // seedDemoData() does this for the fixed demo company, but a real
    // self-service signup never went through that path, so
    // crm.createLead()'s getDefaultStage() lookup would fail for every
    // real tenant with "no default CRM stage configured for this
    // company". Idempotent, same as the demo seed's call.
    await this.crmStages.seedDefaultStages(company.id);
    const employee = await this.organization.createEmployee({
      companyId: company.id,
      fullName: input.fullName,
      email: input.email,
      title: 'Owner',
    });
    const user = await this.auth.register({
      companyId: company.id,
      email: input.email,
      password: input.password,
      userType: 'employee_user',
      locale: input.locale ?? 'en',
      employeeId: employee.id,
    });

    const role = await this.roleManagement.createRole(company.id, 'Owner');
    for (const resource of RESOURCES) {
      for (const action of ACTIONS) {
        await this.roleManagement.addGrant(company.id, role.id, { action, resource, scope: 'company' });
      }
    }
    await this.roleManagement.assignRole(user.id, role.id);

    const token = this.auth.issueTokenForUser(user);
    return { token, user, company, employee, role };
  }
}
