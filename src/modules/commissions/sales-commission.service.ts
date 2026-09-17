import { randomUUID } from 'node:crypto';
import type { Employee, SalesCommission, SalesCommissionRule, SalesCommissionTier, User } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError, SalesCommissionError, ValidationError } from '../../infra/errors.js';

export interface SetSalesCommissionRuleInput {
  companyId: string;
  tier: SalesCommissionTier;
  ratePercent: number;
  employeeUserId?: string;
}

/**
 * Internal Sales Commission Engine — parallel to BrokersService's broker
 * commission machinery, reusing the same rate-resolution and
 * pending→approved→paid lifecycle pattern, but resolving payees from the
 * org chart (Employee.managerEmployeeId) instead of a broker company.
 *
 * A contract's 'base' commission always goes to whoever the 60-day
 * lead-ownership law says should be credited (CrmService.resolveCommissionOwner
 * — resolved by the caller before signContract runs, so this service only
 * ever sees the final creditedEmployeeUserId). An 'override' commission,
 * when a rate is configured for it, goes to that employee's direct
 * manager — never further up the chain, matching the spec's "Supervisor
 * Override" tier (a distinct, separately-configurable "Manager Override"
 * tier would need its own resolution step; not built here since nothing
 * in the current org model distinguishes a supervisor from a manager
 * beyond one reporting level).
 */
export class SalesCommissionService {
  constructor(
    private readonly rules: Repository<SalesCommissionRule>,
    private readonly commissions: Repository<SalesCommission>,
    private readonly employees: Repository<Employee>,
    private readonly users: Repository<User>,
  ) {}

  async setCommissionRule(input: SetSalesCommissionRuleInput): Promise<SalesCommissionRule> {
    if (input.tier !== 'base' && input.tier !== 'override') throw new ValidationError('tier must be "base" or "override"');
    if (!(input.ratePercent >= 0 && input.ratePercent <= 100)) throw new ValidationError('ratePercent must be between 0 and 100');
    if (input.employeeUserId) {
      const user = await this.users.findById(input.employeeUserId);
      if (!user || user.companyId !== input.companyId) throw new ValidationError('employeeUserId is not a user in this company');
    }
    const rule: SalesCommissionRule = {
      id: randomUUID(),
      companyId: input.companyId,
      tier: input.tier,
      employeeUserId: input.employeeUserId,
      ratePercent: input.ratePercent,
    };
    return this.rules.save(rule);
  }

  async listCommissionRules(companyId: string): Promise<SalesCommissionRule[]> {
    return this.rules.findAll((r) => r.companyId === companyId);
  }

  /** Employee-specific rate for this tier takes precedence over the
   * company-wide default rate for the same tier — identical precedence
   * rule to BrokersService's broker-specific-over-company-default. */
  private async resolveRate(companyId: string, tier: SalesCommissionTier, employeeUserId: string): Promise<number> {
    const rules = await this.rules.findAll((r) => r.companyId === companyId && r.tier === tier);
    const specific = rules.find((r) => r.employeeUserId === employeeUserId);
    if (specific) return specific.ratePercent;
    const fallback = rules.find((r) => !r.employeeUserId);
    return fallback?.ratePercent ?? 0;
  }

  private async resolveManagerUserId(companyId: string, employeeUserId: string): Promise<string | undefined> {
    const user = await this.users.findById(employeeUserId);
    if (!user?.employeeId) return undefined;
    const employee = await this.employees.findById(user.employeeId);
    if (!employee?.managerEmployeeId) return undefined;
    const managerUsers = await this.users.findAll(
      (u) => u.companyId === companyId && u.userType === 'employee_user' && u.employeeId === employee.managerEmployeeId,
    );
    return managerUsers[0]?.id;
  }

  /** Records the base (and, when configured and a manager exists,
   * override) commission lines for a newly-signed contract. Idempotent —
   * calling it twice for the same contractId is a no-op the second time,
   * so an accidental double-call (e.g. a retried request) can never
   * double-pay commission. Skips silently (returns []) when no base rate
   * is configured, so a company that never sets up commission rules sees
   * no behavior change from this engine's existence. */
  async recordCommissionsForContract(companyId: string, contractId: string, creditedEmployeeUserId: string, totalPrice: number): Promise<SalesCommission[]> {
    const existing = await this.commissions.findAll((c) => c.companyId === companyId && c.contractId === contractId);
    if (existing.length > 0) return [];

    const created: SalesCommission[] = [];

    const baseRate = await this.resolveRate(companyId, 'base', creditedEmployeeUserId);
    if (baseRate > 0) {
      created.push(
        await this.commissions.save({
          id: randomUUID(),
          companyId,
          contractId,
          employeeUserId: creditedEmployeeUserId,
          tier: 'base',
          ratePercent: baseRate,
          amount: Math.round(((totalPrice * baseRate) / 100) * 100) / 100,
          status: 'pending',
          createdAt: new Date().toISOString(),
        }),
      );
    }

    const managerUserId = await this.resolveManagerUserId(companyId, creditedEmployeeUserId);
    if (managerUserId) {
      const overrideRate = await this.resolveRate(companyId, 'override', managerUserId);
      if (overrideRate > 0) {
        created.push(
          await this.commissions.save({
            id: randomUUID(),
            companyId,
            contractId,
            employeeUserId: managerUserId,
            tier: 'override',
            ratePercent: overrideRate,
            amount: Math.round(((totalPrice * overrideRate) / 100) * 100) / 100,
            status: 'pending',
            createdAt: new Date().toISOString(),
          }),
        );
      }
    }

    return created;
  }

  async listCommissions(companyId: string, employeeUserId?: string): Promise<SalesCommission[]> {
    return this.commissions.findAll((c) => c.companyId === companyId && (!employeeUserId || c.employeeUserId === employeeUserId));
  }

  async getCommission(id: string): Promise<SalesCommission | undefined> {
    return this.commissions.findById(id);
  }

  async approveCommission(id: string, companyId: string): Promise<SalesCommission> {
    const commission = await this.commissions.findById(id);
    if (!commission || commission.companyId !== companyId) throw new NotFoundError('sales commission not found');
    if (commission.status !== 'pending') {
      throw new SalesCommissionError(`commission is not pending (current status: ${commission.status})`);
    }
    return this.commissions.save({ ...commission, status: 'approved' });
  }

  async markCommissionPaid(id: string, companyId: string): Promise<SalesCommission> {
    const commission = await this.commissions.findById(id);
    if (!commission || commission.companyId !== companyId) throw new NotFoundError('sales commission not found');
    if (commission.status !== 'approved') {
      throw new SalesCommissionError(`only an approved commission can be marked paid (current status: ${commission.status})`);
    }
    return this.commissions.save({ ...commission, status: 'paid' });
  }

  async clawbackCommission(id: string, companyId: string, reason: string): Promise<SalesCommission> {
    const commission = await this.commissions.findById(id);
    if (!commission || commission.companyId !== companyId) throw new NotFoundError('sales commission not found');
    if (commission.status !== 'approved' && commission.status !== 'paid') {
      throw new SalesCommissionError(`only an approved or paid commission can be clawed back (current status: ${commission.status})`);
    }
    if (!reason?.trim()) throw new ValidationError('a clawback reason is required');
    return this.commissions.save({ ...commission, status: 'clawed_back', clawedBackReason: reason.trim() });
  }
}
