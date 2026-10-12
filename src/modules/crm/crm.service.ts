import { randomUUID } from 'node:crypto';
import type { Lead, LeadSourceChannel, LeadInterestType } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { ValidationError, ConflictError, NotFoundError } from '../../infra/errors.js';
import type { ListScope } from '../permissions/rbac.evaluator.js';
import { filterByListScope, type ScopeOwnerKeys } from '../permissions/scope-filter.js';
import type { CrmStageService } from './crm-stage.service.js';
import { KeyedMutex } from '../../infra/keyed-mutex.js';
import { normalizePhone } from '../../infra/phone.js';

const LEAD_SOURCE_CHANNELS: LeadSourceChannel[] = ['facebook', 'google', 'referral', 'whatsapp', 'instagram', 'tiktok', 'other'];
const LEAD_INTEREST_TYPES: LeadInterestType[] = ['project', 'unit', 'product', 'service', 'other'];

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
  interestedInType?: LeadInterestType;
  interestedInLabel?: string;
  budgetMin?: number;
  budgetMax?: number;
}

export interface CreateLeadInput extends LeadCustomFields {
  companyId: string;
  fullName: string;
  phone: string;
  email?: string;
  nationalId?: string;
  sourceId?: string;
  source?: LeadSourceChannel;
  /** Explicit initial stage — omit to land in the company's default
   * (Fresh Leads) stage, which is the normal case. */
  stageId?: string;
  tags?: string[];
  priority?: Lead['priority'];
  ownerEmployeeUserId?: string;
  requiredSkill?: string;
  firstContactSlaDueAt?: string;
}

/** The fields the redesigned Lead form's "Edit Lead" surface can change —
 * LeadCustomFields' qualifying details plus the small set of core fields
 * that previously had no edit path at all (fullName/phone/source). */
export interface UpdateLeadFieldsInput extends LeadCustomFields {
  fullName?: string;
  phone?: string;
  source?: LeadSourceChannel;
}

function sanitizeSourceChannel(value: LeadSourceChannel | undefined): LeadSourceChannel | undefined {
  if (value === undefined) return undefined;
  if (!LEAD_SOURCE_CHANNELS.includes(value)) throw new ValidationError(`"source" must be one of: ${LEAD_SOURCE_CHANNELS.join(', ')}`);
  return value;
}

function sanitizeInterestType(value: LeadInterestType | undefined): LeadInterestType | undefined {
  if (value === undefined) return undefined;
  if (!LEAD_INTEREST_TYPES.includes(value)) throw new ValidationError(`"interestedInType" must be one of: ${LEAD_INTEREST_TYPES.join(', ')}`);
  return value;
}

const LEAD_OWNERSHIP_PROTECTION_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

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
    interestedInType: sanitizeInterestType(input.interestedInType),
    interestedInLabel: sanitizeString(input.interestedInLabel),
    budgetMin: sanitizeNumber(input.budgetMin, 'budgetMin'),
    budgetMax: sanitizeNumber(input.budgetMax, 'budgetMax'),
  };
  if (out.minAreaSqm !== undefined && out.maxAreaSqm !== undefined && out.minAreaSqm > out.maxAreaSqm) {
    throw new ValidationError('"minAreaSqm" cannot be greater than "maxAreaSqm"');
  }
  if (out.budgetMin !== undefined && out.budgetMax !== undefined && out.budgetMin > out.budgetMax) {
    throw new ValidationError('"budgetMin" cannot be greater than "budgetMax"');
  }
  for (const key of Object.keys(out) as (keyof LeadCustomFields)[]) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
}

/** Legacy LeadStatus -> default-stage key. Used by the one-time lead
 * migration below and by AutomationService's `update_lead_status` action
 * (for any workflow/AiPolicy row created before stages existed that
 * still sends `params.status` instead of `params.stageId`). */
export const LEGACY_STATUS_TO_STAGE_KEY: Record<string, string> = {
  new: 'fresh',
  contacted: 'no_answer',
  qualified: 'meeting',
  opportunity: 'contacts',
  lost: 'cancellation',
};

export class CrmService {
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly leads: Repository<Lead>,
    private readonly crmStages: CrmStageService,
  ) {}

  /** One-time, idempotent migration: any lead persisted before the
   * CrmStage engine existed has a `status` but no `stageId` (the
   * property is simply absent from its stored JSON, TypeScript's
   * required-field guarantee only holding for code written after this
   * change). Called from seed.ts on every boot; leads that already have
   * a stageId are left untouched, so this is cheap and safe to re-run. */
  async migrateLegacyStatuses(companyId: string): Promise<number> {
    const stages = await this.crmStages.listStages(companyId, true);
    const stageByKey = new Map(stages.map((s) => [s.key, s]));
    const defaultStage = stages.find((s) => s.isDefault);
    const legacy = await this.leads.findAll((l) => l.companyId === companyId && !l.stageId);
    let migrated = 0;
    for (const lead of legacy) {
      const key = lead.status ? LEGACY_STATUS_TO_STAGE_KEY[lead.status] : undefined;
      const stage = (key ? stageByKey.get(key) : undefined) ?? defaultStage;
      if (!stage) continue; // no default stage configured yet — leave for the next boot's migration pass
      await this.leads.save({ ...lead, stageId: stage.id });
      migrated++;
    }
    return migrated;
  }

  /** Phone (normalized to a canonical form — see normalizePhone) is the
   * sole duplicate-detection identifier, as requested by the redesigned
   * Lead form: a national ID is no longer collected on the form, so it's
   * no longer trustworthy as a dedup signal for leads created going
   * forward. Email is still matched too where present, since it costs
   * nothing and catches genuine dupes from older/imported rows that do
   * have one. This block is permanent (not time-boxed): the system
   * should never hold two Lead rows for the same person, no matter how
   * old the first one is. */
  private async findDuplicate(companyId: string, normalizedPhone: string, email?: string): Promise<Lead | undefined> {
    const candidates = await this.leads.findAll((l) => l.companyId === companyId);
    return candidates.find((l) =>
      normalizePhone(l.phone) === normalizedPhone ||
      (!!email && !!l.email && l.email === email),
    );
  }

  /** Public, read-only duplicate pre-check the Lead form calls before
   * submitting a new lead, so the sales rep sees a warning — and can open
   * the existing lead — before creation is even attempted, rather than
   * just getting a rejected request. */
  async checkDuplicateByPhone(companyId: string, phone: string): Promise<Lead | undefined> {
    if (!phone?.trim()) return undefined;
    return this.findDuplicate(companyId, normalizePhone(phone));
  }

  /** Locked on the company (not on a per-field key, since the duplicate
   * check itself matches on phone or email — see findDuplicate) so two
   * concurrent createLead calls for the same company can never both pass
   * the dedup check before either one has written its row. Lead creation
   * isn't hot enough for per-company serialization to matter; correctness
   * here matters more than throughput. */
  async createLead(input: CreateLeadInput): Promise<Lead> {
    if (!input.fullName?.trim()) throw new ValidationError('fullName is required');
    if (!input.phone?.trim()) throw new ValidationError('phone is required');

    return this.mutex.runExclusive(input.companyId, async () => {
      const nationalId = sanitizeString(input.nationalId);
      const normalizedPhone = normalizePhone(input.phone);
      const duplicate = await this.findDuplicate(input.companyId, normalizedPhone, input.email?.trim());
      if (duplicate) {
        throw new ConflictError('a lead with this phone number already exists');
      }
      const source = sanitizeSourceChannel(input.source);

      let stageId = input.stageId;
      if (stageId) {
        const stage = await this.crmStages.getStage(stageId, input.companyId);
        if (!stage.isActive) throw new ValidationError('cannot create a lead directly in an archived CRM stage');
      } else {
        stageId = (await this.crmStages.getDefaultStage(input.companyId)).id;
      }

      const lead: Lead = {
        id: randomUUID(),
        companyId: input.companyId,
        fullName: input.fullName.trim(),
        phone: normalizedPhone,
        email: input.email?.trim(),
        nationalId,
        sourceId: input.sourceId,
        source,
        stageId,
        tags: input.tags?.map((t) => t.trim()).filter(Boolean),
        priority: input.priority,
        ownerEmployeeUserId: input.ownerEmployeeUserId,
        // Captured once and never changed afterward — see
        // resolveCommissionOwner(), which uses this to keep commission
        // credit with whoever established first contact for 60 days, even
        // through a later reassignment (SLA auto-reassignment, a manual
        // reassign, etc).
        originalOwnerEmployeeUserId: input.ownerEmployeeUserId,
        createdAt: new Date().toISOString(),
        requiredSkill: input.requiredSkill?.trim() || undefined,
        firstContactSlaDueAt: input.firstContactSlaDueAt,
        ...sanitizeCustomFields(input),
      };
      return this.leads.save(lead);
    });
  }

  /** The lead-ownership protection law: for 60 days from first contact,
   * commission credit stays with whoever originally brought the lead in
   * — even if it's since been reassigned (by the SLA sweep, a manual
   * reassign, or anything else) — so a lead can't be effectively "stolen"
   * by re-routing it away from the agent who did the work of first
   * contact. After 60 days, credit follows the lead's current owner like
   * normal. Returns undefined if the lead was never assigned an owner at
   * all (nothing to protect or fall back to). */
  async resolveCommissionOwner(leadId: string, companyId: string, now: Date = new Date()): Promise<string | undefined> {
    const lead = await this.leads.findById(leadId);
    if (!lead || lead.companyId !== companyId) throw new NotFoundError('lead not found');
    const withinProtectionWindow = now.getTime() - Date.parse(lead.createdAt) <= LEAD_OWNERSHIP_PROTECTION_MS;
    if (withinProtectionWindow && lead.originalOwnerEmployeeUserId) {
      return lead.originalOwnerEmployeeUserId;
    }
    return lead.ownerEmployeeUserId;
  }

  /** Merges in whatever fields the caller passes — a real estate agent
   * fills these in progressively, not all at once at creation. Also the
   * "Edit Lead" surface's only write path for fullName/phone/source
   * (previously uneditable after creation). Locked on leadId — same
   * lost-update race as moveToStage. */
  async updateCustomFields(leadId: string, companyId: string, input: UpdateLeadFieldsInput): Promise<Lead> {
    return this.mutex.runExclusive(leadId, async () => {
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
        interestedInType: input.interestedInType ?? lead.interestedInType,
        interestedInLabel: input.interestedInLabel ?? lead.interestedInLabel,
        budgetMin: input.budgetMin ?? lead.budgetMin,
        budgetMax: input.budgetMax ?? lead.budgetMax,
      });
      if (input.fullName !== undefined && !input.fullName.trim()) {
        throw new ValidationError('fullName cannot be empty');
      }
      if (input.phone !== undefined && !input.phone.trim()) {
        throw new ValidationError('phone cannot be empty');
      }
      const fullName = input.fullName !== undefined ? input.fullName.trim() : lead.fullName;
      const phone = input.phone !== undefined ? normalizePhone(input.phone) : lead.phone;
      const source = input.source !== undefined ? sanitizeSourceChannel(input.source) : lead.source;
      return this.leads.save({ ...lead, ...sanitized, fullName, phone, source });
    });
  }

  async getLead(id: string): Promise<Lead | undefined> {
    return this.leads.findById(id);
  }

  async listForScope(scope: ListScope, resolveKeys: (lead: Lead) => Promise<ScopeOwnerKeys>): Promise<Lead[]> {
    if (scope.kind === 'none') return [];
    const all = await this.leads.findAll((l) => l.companyId === scope.companyId);
    return filterByListScope(all, scope, resolveKeys);
  }

  /** Moves a Lead to a different CRM stage — always the same one Lead
   * row, never duplicated. Replaces the old fixed-enum updateStatus(): the
   * configurable pipeline has real branches (e.g. Fresh -> Contacted ->
   * Lost) that a forward-only order can't express, so the only preserved
   * invariant is that moving into an isLost-flagged stage requires a
   * reason, and once a lead sits in an isLost stage it can only be moved
   * out again by an explicit call (never silently blocked, unlike the old
   * hard lock — a rep who mis-marked a lead lost can fix it). */
  /** Locked on leadId — without this, two concurrent moves of the same
   * lead (e.g. a manual move racing the SLA sweep's auto-reassignment, or
   * two reps clicking "move" at once) could both read the same
   * pre-move `lead`, and whichever save() lands second would silently
   * overwrite the first's stageId/lostReason (a lost update). */
  async moveToStage(leadId: string, companyId: string, stageId: string, lostReason?: string): Promise<Lead> {
    return this.mutex.runExclusive(leadId, async () => {
      const lead = await this.leads.findById(leadId);
      if (!lead || lead.companyId !== companyId) throw new NotFoundError('lead not found');

      const stage = await this.crmStages.getStage(stageId, companyId);
      if (!stage.isActive) throw new ValidationError('cannot move a lead into an archived CRM stage');

      if (stage.isLost && !lostReason?.trim()) {
        throw new ValidationError('lostReason is required when moving a lead into a Lost-flagged stage');
      }

      const updated: Lead = {
        ...lead,
        stageId: stage.id,
        lostReason: stage.isLost ? lostReason!.trim() : lead.lostReason,
      };
      return this.leads.save(updated);
    });
  }

  /** Locked on leadId — same lost-update race as moveToStage (e.g. this
   * racing the SLA sweep's own assignOwner call for the same lead). */
  async assignOwner(leadId: string, companyId: string, ownerEmployeeUserId: string): Promise<Lead> {
    return this.mutex.runExclusive(leadId, async () => {
      const lead = await this.leads.findById(leadId);
      if (!lead || lead.companyId !== companyId) throw new NotFoundError('lead not found');
      return this.leads.save({ ...lead, ownerEmployeeUserId });
    });
  }

  /** Locked on leadId — same lost-update race as moveToStage. */
  async updateTagsAndPriority(leadId: string, companyId: string, patch: { tags?: string[]; priority?: Lead['priority'] }): Promise<Lead> {
    return this.mutex.runExclusive(leadId, async () => {
      const lead = await this.leads.findById(leadId);
      if (!lead || lead.companyId !== companyId) throw new NotFoundError('lead not found');
      return this.leads.save({
        ...lead,
        tags: patch.tags !== undefined ? patch.tags.map((t) => t.trim()).filter(Boolean) : lead.tags,
        priority: patch.priority !== undefined ? patch.priority : lead.priority,
      });
    });
  }
}
