import type { AuditLogEntry, Campaign, Commission, Contract, Lead, Opportunity, PaymentScheduleLine, Unit } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import type { CrmStageService } from '../crm/crm-stage.service.js';

export interface StageFunnelEntry {
  stageId: string;
  stageKey: string;
  stageName: string;
  order: number;
  isDefault: boolean;
  isWon: boolean;
  isLost: boolean;
  count: number;
}

/** Real-time snapshot of how many leads currently sit in each of the
 * company's configured CRM stages (in pipeline order) — replaces the old
 * fixed new/contacted/qualified/opportunity/lost shape so it works with
 * whatever pipeline (including custom admin-added stages) the company
 * actually has. */
export interface SalesFunnel {
  stages: StageFunnelEntry[];
  totalLeads: number;
}

export interface PipelineSummary {
  openOpportunities: number;
  reservedOpportunities: number;
  wonOpportunities: number;
  signedContracts: number;
  cancelledContracts: number;
}

export interface CollectionsAging {
  upcoming: number;
  due: number;
  overdue: number;
  paid: number;
}

export interface InventoryOccupancy {
  available: number;
  held: number;
  reserved: number;
  contracted: number;
  cancelled: number;
  occupancyRatePercent: number;
}

export interface BrokerPerformanceEntry {
  brokerCompanyId: string;
  pendingAmount: number;
  approvedAmount: number;
  paidAmount: number;
}

export interface SpeedToFirstContact {
  /** Average hours between a lead's createdAt and the first time it was
   * ever moved out of its starting stage (any stage change at all) —
   * the stage-agnostic equivalent of "time to first contact", since a
   * configurable pipeline has no single hardcoded 'contacted' stage to
   * look for. null when no lead has ever been moved yet. */
  averageHours: number | null;
  sampleSize: number;
}

export interface StageConversionStep {
  fromStageName: string;
  toStageName: string;
  conversionPercent: number;
}

/**
 * A snapshot-based funnel: what fraction of leads CURRENTLY sit at or
 * beyond each stage, right now — not a time-series cohort analysis (which
 * would need tracking each lead's deepest-ever stage before it was lost,
 * data this system doesn't keep). Same underlying counts as
 * salesFunnel(), just expressed as stage-to-stage percentages, generalized
 * to the company's real (possibly custom) pipeline order instead of a
 * fixed 4-stage list.
 */
export interface FunnelConversionRates {
  totalLeads: number;
  stageConversion: StageConversionStep[];
  overallWinRatePercent: number;
  lostRatePercent: number;
}

export interface CostPerQualifiedLead {
  totalCampaignBudget: number;
  qualifiedLeadsFromCampaigns: number;
  /** null when no campaign-attributed lead has qualified yet — there's
   * no real per-lead cost to report. */
  costPerQualifiedLead: number | null;
}

export interface LostReasonBreakdownEntry {
  reason: string;
  count: number;
}

export class AnalyticsService {
  constructor(
    private readonly leads: Repository<Lead>,
    private readonly opportunities: Repository<Opportunity>,
    private readonly contracts: Repository<Contract>,
    private readonly scheduleLines: Repository<PaymentScheduleLine>,
    private readonly units: Repository<Unit>,
    private readonly commissions: Repository<Commission>,
    private readonly auditEntries: Repository<AuditLogEntry>,
    private readonly campaigns: Repository<Campaign>,
    private readonly crmStages: CrmStageService,
  ) {}

  async salesFunnel(companyId: string): Promise<SalesFunnel> {
    const [all, stages] = await Promise.all([this.leads.findAll((l) => l.companyId === companyId), this.crmStages.listStages(companyId, true)]);
    const countByStage = new Map<string, number>();
    for (const lead of all) countByStage.set(lead.stageId, (countByStage.get(lead.stageId) ?? 0) + 1);
    return {
      totalLeads: all.length,
      stages: stages
        .sort((a, b) => a.order - b.order)
        .map((s) => ({ stageId: s.id, stageKey: s.key, stageName: s.name, order: s.order, isDefault: s.isDefault, isWon: s.isWon, isLost: s.isLost, count: countByStage.get(s.id) ?? 0 })),
    };
  }

  async pipelineSummary(companyId: string): Promise<PipelineSummary> {
    const opportunities = await this.opportunities.findAll((o) => o.companyId === companyId);
    const contracts = await this.contracts.findAll((c) => c.companyId === companyId);
    return {
      openOpportunities: opportunities.filter((o) => o.stage === 'open').length,
      reservedOpportunities: opportunities.filter((o) => o.stage === 'reserved').length,
      wonOpportunities: opportunities.filter((o) => o.stage === 'won').length,
      signedContracts: contracts.filter((c) => c.status === 'signed').length,
      cancelledContracts: contracts.filter((c) => c.status === 'cancelled').length,
    };
  }

  async collectionsAging(companyId: string): Promise<CollectionsAging> {
    const lines = await this.scheduleLines.findAll((l) => l.companyId === companyId);
    const sumOutstanding = (status: PaymentScheduleLine['status']) =>
      Math.round(lines.filter((l) => l.status === status).reduce((sum, l) => sum + (l.amount - l.amountPaid), 0) * 100) / 100;
    return {
      upcoming: sumOutstanding('upcoming'),
      due: sumOutstanding('due'),
      overdue: sumOutstanding('overdue'),
      paid: Math.round(lines.filter((l) => l.status === 'paid').reduce((sum, l) => sum + l.amountPaid, 0) * 100) / 100,
    };
  }

  async inventoryOccupancy(companyId: string): Promise<InventoryOccupancy> {
    const units = await this.units.findAll((u) => u.companyId === companyId);
    const counts = {
      available: units.filter((u) => u.status === 'available').length,
      held: units.filter((u) => u.status === 'held').length,
      reserved: units.filter((u) => u.status === 'reserved').length,
      contracted: units.filter((u) => u.status === 'contracted').length,
      cancelled: units.filter((u) => u.status === 'cancelled').length,
    };
    const occupied = counts.reserved + counts.contracted;
    const occupancyRatePercent = units.length > 0 ? Math.round((occupied / units.length) * 1000) / 10 : 0;
    return { ...counts, occupancyRatePercent };
  }

  async brokerPerformance(companyId: string): Promise<BrokerPerformanceEntry[]> {
    const commissions = await this.commissions.findAll((c) => c.companyId === companyId);
    const byBroker = new Map<string, BrokerPerformanceEntry>();
    for (const commission of commissions) {
      const entry = byBroker.get(commission.brokerCompanyId) ?? {
        brokerCompanyId: commission.brokerCompanyId,
        pendingAmount: 0,
        approvedAmount: 0,
        paidAmount: 0,
      };
      if (commission.status === 'pending') entry.pendingAmount += commission.amount;
      else if (commission.status === 'approved') entry.approvedAmount += commission.amount;
      else if (commission.status === 'paid') entry.paidAmount += commission.amount;
      byBroker.set(commission.brokerCompanyId, entry);
    }
    return Array.from(byBroker.values());
  }

  /** Reads the real stage-change audit trail (app.ts records
   * {fromStageId, toStageId} on the 'lead' resource every time a lead's
   * stage changes) to find, for each lead, the first time it was ever
   * moved at all — then averages the gap from creation. Stage-agnostic:
   * any first move counts as "first contact", since a configurable
   * pipeline has no single hardcoded stage name to look for. */
  async speedToFirstContact(companyId: string): Promise<SpeedToFirstContact> {
    const leads = await this.leads.findAll((l) => l.companyId === companyId);
    const leadById = new Map(leads.map((l) => [l.id, l]));

    const stageChangeEvents = await this.auditEntries.findAll(
      (a) => a.companyId === companyId && a.resource === 'lead' && !!a.metadata?.toStageId,
    );

    const firstMoveAtByLead = new Map<string, number>();
    for (const event of stageChangeEvents) {
      const at = Date.parse(event.createdAt);
      const existing = firstMoveAtByLead.get(event.resourceId);
      if (existing === undefined || at < existing) firstMoveAtByLead.set(event.resourceId, at);
    }

    const gapsHours: number[] = [];
    for (const [leadId, firstMoveAt] of firstMoveAtByLead) {
      const lead = leadById.get(leadId);
      if (!lead) continue;
      const gapHours = (firstMoveAt - Date.parse(lead.createdAt)) / (60 * 60 * 1000);
      if (gapHours >= 0) gapsHours.push(gapHours);
    }

    if (gapsHours.length === 0) return { averageHours: null, sampleSize: 0 };
    const average = gapsHours.reduce((sum, h) => sum + h, 0) / gapsHours.length;
    return { averageHours: Math.round(average * 10) / 10, sampleSize: gapsHours.length };
  }

  /** Stage-to-stage conversion, generalized to the company's real (and
   * possibly custom) pipeline: for each consecutive pair of active,
   * non-terminal stages in order, what fraction of leads currently sitting
   * at-or-beyond the earlier stage are at-or-beyond the later one. A lead
   * counts as "at or beyond" stage S once it's in S or a later stage, or
   * in the isWon stage (having passed every non-terminal stage to get
   * there); a lead in an isLost stage no longer counts toward any bucket,
   * matching the old semantics where a lost lead dropped out of the
   * funnel entirely. */
  async funnelConversionRates(companyId: string): Promise<FunnelConversionRates> {
    const [leads, stages] = await Promise.all([this.leads.findAll((l) => l.companyId === companyId), this.crmStages.listStages(companyId, true)]);
    const stageById = new Map(stages.map((s) => [s.id, s]));
    const nonTerminal = stages.filter((s) => !s.isWon && !s.isLost).sort((a, b) => a.order - b.order);
    const total = leads.length;
    const lostCount = leads.filter((l) => stageById.get(l.stageId)?.isLost).length;
    const wonCount = leads.filter((l) => stageById.get(l.stageId)?.isWon).length;

    const atOrBeyond = (minOrder: number): number =>
      leads.filter((l) => {
        const stage = stageById.get(l.stageId);
        if (!stage) return false;
        if (stage.isWon) return true;
        if (stage.isLost) return false;
        return stage.order >= minOrder;
      }).length;

    const stageConversion: StageConversionStep[] = [];
    for (let i = 0; i < nonTerminal.length - 1; i++) {
      const from = nonTerminal[i]!;
      const to = nonTerminal[i + 1]!;
      const atFrom = atOrBeyond(from.order);
      const atTo = atOrBeyond(to.order);
      stageConversion.push({
        fromStageName: from.name,
        toStageName: to.name,
        conversionPercent: atFrom > 0 ? Math.round((atTo / atFrom) * 1000) / 10 : 0,
      });
    }

    const pct = (numerator: number, denominator: number) => (denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0);
    return {
      totalLeads: total,
      stageConversion,
      overallWinRatePercent: pct(wonCount, total),
      lostRatePercent: pct(lostCount, total),
    };
  }

  /** Real spend (Campaign.budget) divided by real "qualified-or-better"
   * lead count — only leads whose sourceId actually matches one of this
   * company's campaigns are counted, so a walk-in/referral lead with no
   * ad spend behind it never dilutes the number. "Qualified" is
   * generalized (the configurable pipeline has no single hardcoded
   * Qualified stage) to mean any lead that has moved past the company's
   * default (Fresh Leads) stage without being lost — real engagement,
   * not just an unopened lead. */
  async costPerQualifiedLead(companyId: string): Promise<CostPerQualifiedLead> {
    const [campaigns, stages] = await Promise.all([this.campaigns.findAll((c) => c.companyId === companyId), this.crmStages.listStages(companyId, true)]);
    const campaignIds = new Set(campaigns.map((c) => c.id));
    const totalCampaignBudget = Math.round(campaigns.reduce((sum, c) => sum + c.budget, 0) * 100) / 100;
    const stageById = new Map(stages.map((s) => [s.id, s]));

    const leads = await this.leads.findAll((l) => l.companyId === companyId && !!l.sourceId && campaignIds.has(l.sourceId));
    const qualifiedLeadsFromCampaigns = leads.filter((l) => {
      const stage = stageById.get(l.stageId);
      return !!stage && !stage.isLost && !stage.isDefault;
    }).length;

    return {
      totalCampaignBudget,
      qualifiedLeadsFromCampaigns,
      costPerQualifiedLead: qualifiedLeadsFromCampaigns > 0 ? Math.round((totalCampaignBudget / qualifiedLeadsFromCampaigns) * 100) / 100 : null,
    };
  }

  /** Groups on the exact lostReason text an agent typed — it's a
   * free-text field (see CrmService.moveToStage), so this reports real
   * recurring phrases rather than inventing a fixed taxonomy the system
   * never actually captured. */
  async lostReasonBreakdown(companyId: string): Promise<LostReasonBreakdownEntry[]> {
    const [leads, stages] = await Promise.all([this.leads.findAll((l) => l.companyId === companyId), this.crmStages.listStages(companyId, true)]);
    const stageById = new Map(stages.map((s) => [s.id, s]));
    const lostLeads = leads.filter((l) => stageById.get(l.stageId)?.isLost && !!l.lostReason?.trim());
    const counts = new Map<string, number>();
    for (const lead of lostLeads) {
      const reason = lead.lostReason!.trim();
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);
  }
}
