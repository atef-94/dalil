import type { Employee, Lead, LeadDistributionMode, LeadDistributionPool, User } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { ValidationError } from '../../infra/errors.js';
import { CrmService } from './crm.service.js';
import type { CrmStageService } from './crm-stage.service.js';

export interface ConfigurePoolInput {
  companyId: string;
  mode: LeadDistributionMode;
  memberUserIds: string[];
  slaMinutes: number;
}

export interface NewLeadAssignment {
  ownerUserId: string;
  firstContactSlaDueAt: string;
}

export interface SlaBreach {
  leadId: string;
  companyId: string;
  previousOwnerUserId?: string;
  newOwnerUserId?: string;
  reassignmentCount: number;
}

/**
 * Lead Distribution + SLA: auto-assigns newly-created leads across a
 * company's configured pool of employee-users (round-robin, optionally
 * narrowed to those with a matching skill), then — on the same 60s tick
 * that already sweeps overdue payments (see app.ts sweepOverdueAndEmit) —
 * auto-reassigns any lead still sitting in 'new' past its SLA deadline and
 * adds a penalty point to the employee who missed it.
 *
 * A company that never calls configurePool sees no behavior change at
 * all: pickOwnerForNewLead returns undefined and every lead keeps falling
 * back to its creator, exactly as before this feature existed.
 */
export class LeadDistributionService {
  constructor(
    private readonly pools: Repository<LeadDistributionPool>,
    private readonly users: Repository<User>,
    private readonly employees: Repository<Employee>,
    private readonly leads: Repository<Lead>,
    private readonly crm: CrmService,
    private readonly crmStages: CrmStageService,
  ) {}

  async configurePool(input: ConfigurePoolInput): Promise<LeadDistributionPool> {
    if (!input.memberUserIds?.length) {
      throw new ValidationError('memberUserIds must include at least one employee user');
    }
    if (!(input.slaMinutes > 0)) {
      throw new ValidationError('slaMinutes must be a positive number');
    }
    for (const userId of input.memberUserIds) {
      const user = await this.users.findById(userId);
      if (!user || user.companyId !== input.companyId || user.userType !== 'employee_user') {
        throw new ValidationError(`memberUserIds contains a user that is not an employee of this company: ${userId}`);
      }
    }

    const existing = await this.pools.findById(input.companyId);
    const pool: LeadDistributionPool = {
      id: input.companyId,
      companyId: input.companyId,
      mode: input.mode,
      memberUserIds: input.memberUserIds,
      slaMinutes: input.slaMinutes,
      // Reset the cursor whenever the member list changes shape so a
      // shrunken pool can't leave lastAssignedIndex pointing past the end.
      lastAssignedIndex: existing && existing.memberUserIds.length === input.memberUserIds.length ? existing.lastAssignedIndex : -1,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return this.pools.save(pool);
  }

  async getPool(companyId: string): Promise<LeadDistributionPool | undefined> {
    return this.pools.findById(companyId);
  }

  private async employeeForUser(userId: string): Promise<Employee | undefined> {
    const user = await this.users.findById(userId);
    if (!user?.employeeId) return undefined;
    return this.employees.findById(user.employeeId);
  }

  /** Walks memberUserIds starting just after `fromIndex`, wrapping once,
   * returning the first entry that satisfies `isEligible` along with its
   * index — or undefined if nothing qualifies. */
  private findNext(members: string[], fromIndex: number, isEligible: (userId: string) => boolean): { userId: string; index: number } | undefined {
    const n = members.length;
    for (let step = 1; step <= n; step++) {
      const index = (fromIndex + step) % n;
      const userId = members[index]!;
      if (isEligible(userId)) return { userId, index };
    }
    return undefined;
  }

  /** Picks the next owner for a brand-new lead per the company's pool, if
   * one is configured. Returns undefined when no pool exists — callers
   * fall back to their own default (e.g. the creating user). */
  async pickOwnerForNewLead(companyId: string, requiredSkill?: string): Promise<NewLeadAssignment | undefined> {
    const pool = await this.pools.findById(companyId);
    if (!pool || pool.memberUserIds.length === 0) return undefined;

    let eligible = new Set(pool.memberUserIds);
    if (pool.mode === 'skill_based' && requiredSkill) {
      const matched = new Set<string>();
      for (const userId of pool.memberUserIds) {
        const employee = await this.employeeForUser(userId);
        if (employee?.skills?.includes(requiredSkill)) matched.add(userId);
      }
      // Fall back to the full pool when nobody has the required skill —
      // an unmatched lead still gets a real owner rather than sitting
      // unassigned because no one happens to carry that tag yet.
      if (matched.size > 0) eligible = matched;
    }

    const picked = this.findNext(pool.memberUserIds, pool.lastAssignedIndex, (userId) => eligible.has(userId));
    if (!picked) return undefined;

    await this.pools.save({ ...pool, lastAssignedIndex: picked.index, updatedAt: new Date().toISOString() });
    return {
      ownerUserId: picked.userId,
      firstContactSlaDueAt: new Date(Date.now() + pool.slaMinutes * 60_000).toISOString(),
    };
  }

  /** Finds every lead still stuck in 'new' past its SLA deadline, bumps a
   * penalty point onto the employee who had it, and hands it to the next
   * pool member in rotation (or re-flags it with a fresh deadline if the
   * pool has no one else to give it to). Safe to call repeatedly — each
   * breach resets the lead's own deadline, so a lead that keeps missing
   * SLA keeps cycling rather than being processed twice for the same
   * window or getting stuck forever. */
  async sweepSlaBreaches(now: Date = new Date()): Promise<SlaBreach[]> {
    const overdueCandidates = await this.leads.findAll(
      (l) => !!l.firstContactSlaDueAt && Date.parse(l.firstContactSlaDueAt) < now.getTime(),
    );

    // A lead only breaches SLA while it's still sitting untouched in its
    // company's default ("Fresh Leads") stage — once moved anywhere else,
    // first contact has effectively happened. Default-stage id is looked
    // up once per company, not once per lead.
    const defaultStageIdByCompany = new Map<string, string | undefined>();
    const dueLeads: Lead[] = [];
    for (const lead of overdueCandidates) {
      if (!defaultStageIdByCompany.has(lead.companyId)) {
        const defaultStage = await this.crmStages.listStages(lead.companyId, true).then((stages) => stages.find((s) => s.isDefault));
        defaultStageIdByCompany.set(lead.companyId, defaultStage?.id);
      }
      if (lead.stageId === defaultStageIdByCompany.get(lead.companyId)) dueLeads.push(lead);
    }

    const breaches: SlaBreach[] = [];
    for (const lead of dueLeads) {
      const pool = await this.pools.findById(lead.companyId);
      if (!pool || pool.memberUserIds.length === 0) continue; // distribution turned off since assignment

      const previousOwnerUserId = lead.ownerEmployeeUserId;
      if (previousOwnerUserId) {
        const employee = await this.employeeForUser(previousOwnerUserId);
        if (employee) {
          await this.employees.save({ ...employee, slaPenaltyPoints: (employee.slaPenaltyPoints ?? 0) + 1 });
        }
      }

      const reassignment = this.findNext(pool.memberUserIds, pool.lastAssignedIndex, (userId) => userId !== previousOwnerUserId);

      let updated = lead;
      if (reassignment) {
        updated = await this.crm.assignOwner(lead.id, lead.companyId, reassignment.userId);
        await this.pools.save({ ...pool, lastAssignedIndex: reassignment.index, updatedAt: now.toISOString() });
      }

      const reassignmentCount = (lead.reassignmentCount ?? 0) + 1;
      updated = await this.leads.save({
        ...updated,
        firstContactSlaDueAt: new Date(now.getTime() + pool.slaMinutes * 60_000).toISOString(),
        slaBreachedAt: now.toISOString(),
        reassignmentCount,
      });

      breaches.push({
        leadId: updated.id,
        companyId: updated.companyId,
        previousOwnerUserId,
        newOwnerUserId: reassignment?.userId,
        reassignmentCount,
      });
    }
    return breaches;
  }
}
