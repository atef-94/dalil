import { randomUUID } from 'node:crypto';
import type { BrokerCompany, BrokerLead, Commission, CommissionRule } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { BrokerError, ConflictError, NotFoundError, ValidationError } from '../../infra/errors.js';
import type { CrmService } from '../crm/crm.service.js';

export interface RegisterBrokerCompanyInput {
  companyId: string;
  name: string;
}

export interface SubmitBrokerLeadInput {
  companyId: string;
  brokerCompanyId: string;
  submittedByUserId: string;
  fullName: string;
  phone: string;
  email?: string;
  nationalId?: string;
}

/** Broker deal-registration protection window — same 60-day convention
 * CRM's own lead-ownership law already uses. */
const PROTECTION_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

export class BrokersService {
  constructor(
    private readonly brokerCompanies: Repository<BrokerCompany>,
    private readonly brokerLeads: Repository<BrokerLead>,
    private readonly commissionRules: Repository<CommissionRule>,
    private readonly commissions: Repository<Commission>,
    private readonly crm: CrmService,
  ) {}

  async registerBrokerCompany(input: RegisterBrokerCompanyInput): Promise<BrokerCompany> {
    if (!input.name?.trim()) throw new ValidationError('name is required');
    const brokerCompany: BrokerCompany = {
      id: randomUUID(),
      companyId: input.companyId,
      name: input.name.trim(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    return this.brokerCompanies.save(brokerCompany);
  }

  async listBrokerCompanies(companyId: string): Promise<BrokerCompany[]> {
    return this.brokerCompanies.findAll((bc) => bc.companyId === companyId);
  }

  async approveBrokerCompany(id: string, companyId: string): Promise<BrokerCompany> {
    const company = await this.brokerCompanies.findById(id);
    if (!company || company.companyId !== companyId) throw new NotFoundError('broker company not found');
    if (company.status !== 'pending') {
      throw new BrokerError(`broker company is not pending (current status: ${company.status})`);
    }
    return this.brokerCompanies.save({ ...company, status: 'approved' });
  }

  async suspendBrokerCompany(id: string, companyId: string): Promise<BrokerCompany> {
    const company = await this.brokerCompanies.findById(id);
    if (!company || company.companyId !== companyId) throw new NotFoundError('broker company not found');
    if (company.status !== 'approved') {
      throw new BrokerError(`only an approved broker company can be suspended (current status: ${company.status})`);
    }
    return this.brokerCompanies.save({ ...company, status: 'suspended' });
  }

  /** Quarantine gate: a broker-submitted lead does not exist in the shared
   * Lead table until an internal user approves it. Also enforces the
   * broker-deal-registration protection window: while another broker
   * company's submission for the same prospect (matched by phone, or
   * email/nationalId when given) is still pending approval and its
   * protectionExpiresAt hasn't passed, a second broker company cannot
   * register the same prospect — first submission wins exclusivity for the
   * window, exactly the research's "60-day protection" requirement. */
  async submitBrokerLead(input: SubmitBrokerLeadInput): Promise<BrokerLead> {
    if (!input.fullName?.trim()) throw new ValidationError('fullName is required');
    if (!input.phone?.trim()) throw new ValidationError('phone is required');

    const brokerCompany = await this.brokerCompanies.findById(input.brokerCompanyId);
    if (!brokerCompany || brokerCompany.status !== 'approved') {
      throw new BrokerError('broker company is not approved to submit leads');
    }

    const phone = input.phone.trim();
    const email = input.email?.trim();
    const nationalId = input.nationalId?.trim();
    const now = Date.now();
    const existing = await this.brokerLeads.findAll(
      (bl) =>
        bl.companyId === input.companyId &&
        bl.brokerCompanyId !== input.brokerCompanyId &&
        bl.approvalStatus === 'pending_approval' &&
        Date.parse(bl.protectionExpiresAt) > now &&
        (bl.phone === phone || (!!email && bl.email === email) || (!!nationalId && bl.nationalId === nationalId)),
    );
    if (existing.length > 0) {
      throw new ConflictError('this prospect is already protected under another broker company\'s pending registration');
    }

    const brokerLead: BrokerLead = {
      id: randomUUID(),
      companyId: input.companyId,
      brokerCompanyId: input.brokerCompanyId,
      submittedByUserId: input.submittedByUserId,
      fullName: input.fullName.trim(),
      phone,
      email,
      nationalId: nationalId || undefined,
      approvalStatus: 'pending_approval',
      protectionExpiresAt: new Date(now + PROTECTION_WINDOW_MS).toISOString(),
      createdAt: new Date().toISOString(),
    };
    return this.brokerLeads.save(brokerLead);
  }

  async listBrokerLeads(companyId: string): Promise<BrokerLead[]> {
    return this.brokerLeads.findAll((bl) => bl.companyId === companyId);
  }

  /**
   * Approving inherits CrmService's exact dedup check — a duplicate-phone
   * broker lead is rejected outright, never silently merged into the
   * existing Lead.
   */
  async approveBrokerLead(id: string, companyId: string, approverOwnerUserId?: string): Promise<BrokerLead> {
    const brokerLead = await this.brokerLeads.findById(id);
    if (!brokerLead || brokerLead.companyId !== companyId) throw new NotFoundError('broker lead not found');
    if (brokerLead.approvalStatus !== 'pending_approval') {
      throw new BrokerError(`broker lead is not pending approval (current status: ${brokerLead.approvalStatus})`);
    }

    try {
      const lead = await this.crm.createLead({
        companyId: brokerLead.companyId,
        fullName: brokerLead.fullName,
        phone: brokerLead.phone,
        email: brokerLead.email,
        nationalId: brokerLead.nationalId,
        sourceId: `broker:${brokerLead.brokerCompanyId}`,
        ownerEmployeeUserId: approverOwnerUserId,
      });
      return this.brokerLeads.save({ ...brokerLead, approvalStatus: 'approved', leadId: lead.id });
    } catch (err) {
      if (err instanceof ConflictError) {
        await this.brokerLeads.save({ ...brokerLead, approvalStatus: 'rejected_duplicate' });
        throw new BrokerError('a lead with this phone, email, or national ID already exists — not merged, rejected', 409);
      }
      throw err;
    }
  }

  async setCommissionRule(companyId: string, ratePercent: number, brokerCompanyId?: string): Promise<CommissionRule> {
    if (ratePercent < 0 || ratePercent > 100) throw new ValidationError('ratePercent must be between 0 and 100');
    const rule: CommissionRule = { id: randomUUID(), companyId, brokerCompanyId, ratePercent };
    return this.commissionRules.save(rule);
  }

  /** Broker-specific rate takes precedence over the company-wide default. */
  private async resolveRate(companyId: string, brokerCompanyId: string): Promise<number> {
    const rules = await this.commissionRules.findAll((r) => r.companyId === companyId);
    const specific = rules.find((r) => r.brokerCompanyId === brokerCompanyId);
    if (specific) return specific.ratePercent;
    const fallback = rules.find((r) => !r.brokerCompanyId);
    return fallback?.ratePercent ?? 0;
  }

  async recordCommissionForContract(companyId: string, brokerCompanyId: string, contractId: string, contractAmount: number): Promise<Commission> {
    const brokerCompany = await this.brokerCompanies.findById(brokerCompanyId);
    if (!brokerCompany || brokerCompany.companyId !== companyId) throw new NotFoundError('broker company not found');
    const ratePercent = await this.resolveRate(companyId, brokerCompanyId);
    const commission: Commission = {
      id: randomUUID(),
      companyId,
      brokerCompanyId,
      contractId,
      amount: Math.round(((contractAmount * ratePercent) / 100) * 100) / 100,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    return this.commissions.save(commission);
  }

  async listCommissionRules(companyId: string): Promise<CommissionRule[]> {
    return this.commissionRules.findAll((r) => r.companyId === companyId);
  }

  async listCommissions(companyId: string, brokerCompanyId?: string): Promise<Commission[]> {
    return this.commissions.findAll((c) => c.companyId === companyId && (!brokerCompanyId || c.brokerCompanyId === brokerCompanyId));
  }

  async approveCommission(id: string, companyId: string): Promise<Commission> {
    const commission = await this.commissions.findById(id);
    if (!commission || commission.companyId !== companyId) throw new NotFoundError('commission not found');
    if (commission.status !== 'pending') {
      throw new BrokerError(`commission is not pending (current status: ${commission.status})`);
    }
    return this.commissions.save({ ...commission, status: 'approved' });
  }
}
