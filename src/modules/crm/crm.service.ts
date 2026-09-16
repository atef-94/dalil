import { randomUUID } from 'node:crypto';
import type { Lead, LeadStatus } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { ValidationError, ConflictError, NotFoundError } from '../../infra/errors.js';
import type { ListScope } from '../permissions/rbac.evaluator.js';
import { filterByListScope, type ScopeOwnerKeys } from '../permissions/scope-filter.js';

export interface CreateLeadInput {
  companyId: string;
  fullName: string;
  phone: string;
  email?: string;
  sourceId?: string;
  ownerEmployeeUserId?: string;
}

const ORDER: LeadStatus[] = ['new', 'contacted', 'qualified', 'opportunity'];

export class CrmService {
  constructor(private readonly leads: Repository<Lead>) {}

  private async findDuplicate(companyId: string, phone: string, email?: string): Promise<Lead | undefined> {
    const candidates = await this.leads.findAll((l) => l.companyId === companyId);
    return candidates.find((l) => l.phone === phone || (!!email && !!l.email && l.email === email));
  }

  async createLead(input: CreateLeadInput): Promise<Lead> {
    if (!input.fullName?.trim()) throw new ValidationError('fullName is required');
    if (!input.phone?.trim()) throw new ValidationError('phone is required');

    const duplicate = await this.findDuplicate(input.companyId, input.phone.trim(), input.email?.trim());
    if (duplicate) {
      throw new ConflictError('a lead with this phone or email already exists');
    }

    const lead: Lead = {
      id: randomUUID(),
      companyId: input.companyId,
      fullName: input.fullName.trim(),
      phone: input.phone.trim(),
      email: input.email?.trim(),
      sourceId: input.sourceId,
      status: 'new',
      ownerEmployeeUserId: input.ownerEmployeeUserId,
      createdAt: new Date().toISOString(),
    };
    return this.leads.save(lead);
  }

  async getLead(id: string): Promise<Lead | undefined> {
    return this.leads.findById(id);
  }

  async listForScope(scope: ListScope, resolveKeys: (lead: Lead) => Promise<ScopeOwnerKeys>): Promise<Lead[]> {
    if (scope.kind === 'none') return [];
    const all = await this.leads.findAll((l) => l.companyId === scope.companyId);
    return filterByListScope(all, scope, resolveKeys);
  }

  async updateStatus(leadId: string, newStatus: LeadStatus, lostReason?: string): Promise<Lead> {
    const lead = await this.leads.findById(leadId);
    if (!lead) throw new NotFoundError('lead not found');

    if (lead.status === 'lost') {
      throw new ConflictError('cannot change status of a lost lead');
    }

    if (newStatus === 'lost') {
      if (!lostReason?.trim()) {
        throw new ValidationError('lostReason is required when marking a lead as lost');
      }
      const updated: Lead = { ...lead, status: 'lost', lostReason: lostReason.trim() };
      return this.leads.save(updated);
    }

    const currentIndex = ORDER.indexOf(lead.status);
    const nextIndex = ORDER.indexOf(newStatus);
    if (nextIndex === -1 || nextIndex <= currentIndex) {
      throw new ValidationError(`cannot transition lead from ${lead.status} to ${newStatus}`);
    }

    const updated: Lead = { ...lead, status: newStatus };
    return this.leads.save(updated);
  }
}
