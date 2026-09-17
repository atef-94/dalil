import { randomUUID } from 'node:crypto';
import type { Lead, LeadStatus } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { ValidationError, ConflictError, NotFoundError } from '../../infra/errors.js';
import type { ListScope } from '../permissions/rbac.evaluator.js';
import { filterByListScope, type ScopeOwnerKeys } from '../permissions/scope-filter.js';

export interface LeadCustomFields {
  propertyTypeWanted?: string;
  purchaseGoal?: string;
  preferredLocation?: string;
  minAreaSqm?: number;
  maxAreaSqm?: number;
  expectedDeliveryTimeline?: string;
  maxDownPayment?: number;
  maxInstallment?: number;
  preferredTenorMonths?: number;
  preferredTransferMethod?: string;
}

export interface CreateLeadInput extends LeadCustomFields {
  companyId: string;
  fullName: string;
  phone: string;
  email?: string;
  sourceId?: string;
  ownerEmployeeUserId?: string;
  requiredSkill?: string;
  firstContactSlaDueAt?: string;
}

function sanitizeString(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sanitizeNumber(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`"${field}" must be a non-negative number`);
  }
  return value;
}

function sanitizeCustomFields(input: LeadCustomFields): LeadCustomFields {
  const out: LeadCustomFields = {
    propertyTypeWanted: sanitizeString(input.propertyTypeWanted),
    purchaseGoal: sanitizeString(input.purchaseGoal),
    preferredLocation: sanitizeString(input.preferredLocation),
    expectedDeliveryTimeline: sanitizeString(input.expectedDeliveryTimeline),
    preferredTransferMethod: sanitizeString(input.preferredTransferMethod),
    minAreaSqm: sanitizeNumber(input.minAreaSqm, 'minAreaSqm'),
    maxAreaSqm: sanitizeNumber(input.maxAreaSqm, 'maxAreaSqm'),
    maxDownPayment: sanitizeNumber(input.maxDownPayment, 'maxDownPayment'),
    maxInstallment: sanitizeNumber(input.maxInstallment, 'maxInstallment'),
    preferredTenorMonths: sanitizeNumber(input.preferredTenorMonths, 'preferredTenorMonths'),
  };
  if (out.minAreaSqm !== undefined && out.maxAreaSqm !== undefined && out.minAreaSqm > out.maxAreaSqm) {
    throw new ValidationError('"minAreaSqm" cannot be greater than "maxAreaSqm"');
  }
  for (const key of Object.keys(out) as (keyof LeadCustomFields)[]) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
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
      requiredSkill: input.requiredSkill?.trim() || undefined,
      firstContactSlaDueAt: input.firstContactSlaDueAt,
      ...sanitizeCustomFields(input),
    };
    return this.leads.save(lead);
  }

  /** Merges in whatever custom fields the caller passes — a real estate
   * agent fills these in progressively, not all at once at creation. */
  async updateCustomFields(leadId: string, companyId: string, input: LeadCustomFields): Promise<Lead> {
    const lead = await this.leads.findById(leadId);
    if (!lead || lead.companyId !== companyId) throw new NotFoundError('lead not found');
    const sanitized = sanitizeCustomFields({
      minAreaSqm: input.minAreaSqm ?? lead.minAreaSqm,
      maxAreaSqm: input.maxAreaSqm ?? lead.maxAreaSqm,
      maxDownPayment: input.maxDownPayment ?? lead.maxDownPayment,
      maxInstallment: input.maxInstallment ?? lead.maxInstallment,
      preferredTenorMonths: input.preferredTenorMonths ?? lead.preferredTenorMonths,
      propertyTypeWanted: input.propertyTypeWanted ?? lead.propertyTypeWanted,
      purchaseGoal: input.purchaseGoal ?? lead.purchaseGoal,
      preferredLocation: input.preferredLocation ?? lead.preferredLocation,
      expectedDeliveryTimeline: input.expectedDeliveryTimeline ?? lead.expectedDeliveryTimeline,
      preferredTransferMethod: input.preferredTransferMethod ?? lead.preferredTransferMethod,
    });
    return this.leads.save({ ...lead, ...sanitized });
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

  async assignOwner(leadId: string, companyId: string, ownerEmployeeUserId: string): Promise<Lead> {
    const lead = await this.leads.findById(leadId);
    if (!lead || lead.companyId !== companyId) throw new NotFoundError('lead not found');
    return this.leads.save({ ...lead, ownerEmployeeUserId });
  }
}
