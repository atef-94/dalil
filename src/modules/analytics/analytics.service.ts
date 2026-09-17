import type { AuditLogEntry, Campaign, Commission, Contract, Lead, Opportunity, PaymentScheduleLine, Unit } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';

export interface SalesFunnel {
  new: number;
  contacted: number;
  qualified: number;
  opportunity: number;
  lost: number;
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
   * moved to 'contacted', across every lead that has actually reached
   * that status. null when no lead has been contacted yet — there's
   * nothing real to average. */
  averageHours: number | null;
  sampleSize: number;
}

/**
 * A snapshot-based funnel: what fraction of leads CURRENTLY sit at or
 * beyond each stage, right now — not a time-series cohort analysis (which
 * would need tracking each lead's deepest-ever stage before it was lost,
 * data this system doesn't keep). Same underlying counts as
 * salesFunnel(), just expressed as stage-to-stage percentages.
 */
export interface FunnelConversionRates {
  totalLeads: number;
  newToContactedPercent: number;
  contactedToQualifiedPercent: number;
  qualifiedToOpportunityPercent: number;
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
  ) {}

  async salesFunnel(companyId: string): Promise<SalesFunnel> {
    const all = await this.leads.findAll((l) => l.companyId === companyId);
    return {
      new: all.filter((l) => l.status === 'new').length,
      contacted: all.filter((l) => l.status === 'contacted').length,
      qualified: all.filter((l) => l.status === 'qualified').length,
      opportunity: all.filter((l) => l.status === 'opportunity').length,
      lost: all.filter((l) => l.status === 'lost').length,
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

  /** Reads the real status-change audit trail (app.ts records
   * {fromStatus, toStatus} on the 'lead' resource every time a lead's
   * status changes) to find, for each lead, the first time it was ever
   * moved to 'contacted' — then averages the gap from creation. */
  async speedToFirstContact(companyId: string): Promise<SpeedToFirstContact> {
    const leads = await this.leads.findAll((l) => l.companyId === companyId);
    const leadById = new Map(leads.map((l) => [l.id, l]));

    const contactedEvents = await this.auditEntries.findAll(
      (a) => a.companyId === companyId && a.resource === 'lead' && a.metadata?.toStatus === 'contacted',
    );

    const firstContactAtByLead = new Map<string, number>();
    for (const event of contactedEvents) {
      const at = Date.parse(event.createdAt);
      const existing = firstContactAtByLead.get(event.resourceId);
      if (existing === undefined || at < existing) firstContactAtByLead.set(event.resourceId, at);
    }

    const gapsHours: number[] = [];
    for (const [leadId, firstContactAt] of firstContactAtByLead) {
      const lead = leadById.get(leadId);
      if (!lead) continue;
      const gapHours = (firstContactAt - Date.parse(lead.createdAt)) / (60 * 60 * 1000);
      if (gapHours >= 0) gapsHours.push(gapHours);
    }

    if (gapsHours.length === 0) return { averageHours: null, sampleSize: 0 };
    const average = gapsHours.reduce((sum, h) => sum + h, 0) / gapsHours.length;
    return { averageHours: Math.round(average * 10) / 10, sampleSize: gapsHours.length };
  }

  async funnelConversionRates(companyId: string): Promise<FunnelConversionRates> {
    const funnel = await this.salesFunnel(companyId);
    const total = funnel.new + funnel.contacted + funnel.qualified + funnel.opportunity + funnel.lost;
    const atOrBeyondContacted = funnel.contacted + funnel.qualified + funnel.opportunity;
    const atOrBeyondQualified = funnel.qualified + funnel.opportunity;
    const atOrBeyondOpportunity = funnel.opportunity;

    const pct = (numerator: number, denominator: number) => (denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0);
    return {
      totalLeads: total,
      newToContactedPercent: pct(atOrBeyondContacted, total),
      contactedToQualifiedPercent: pct(atOrBeyondQualified, atOrBeyondContacted),
      qualifiedToOpportunityPercent: pct(atOrBeyondOpportunity, atOrBeyondQualified),
      overallWinRatePercent: pct(atOrBeyondOpportunity, total),
      lostRatePercent: pct(funnel.lost, total),
    };
  }

  /** Real spend (Campaign.budget) divided by real qualified-lead count —
   * only leads whose sourceId actually matches one of this company's
   * campaigns are counted, so a walk-in/referral lead with no ad spend
   * behind it never dilutes the number. */
  async costPerQualifiedLead(companyId: string): Promise<CostPerQualifiedLead> {
    const campaigns = await this.campaigns.findAll((c) => c.companyId === companyId);
    const campaignIds = new Set(campaigns.map((c) => c.id));
    const totalCampaignBudget = Math.round(campaigns.reduce((sum, c) => sum + c.budget, 0) * 100) / 100;

    const leads = await this.leads.findAll((l) => l.companyId === companyId && !!l.sourceId && campaignIds.has(l.sourceId));
    const qualifiedLeadsFromCampaigns = leads.filter((l) => l.status === 'qualified' || l.status === 'opportunity').length;

    return {
      totalCampaignBudget,
      qualifiedLeadsFromCampaigns,
      costPerQualifiedLead: qualifiedLeadsFromCampaigns > 0 ? Math.round((totalCampaignBudget / qualifiedLeadsFromCampaigns) * 100) / 100 : null,
    };
  }

  /** Groups on the exact lostReason text an agent typed — it's a
   * free-text field (see CrmService.updateStatus), so this reports real
   * recurring phrases rather than inventing a fixed taxonomy the system
   * never actually captured. */
  async lostReasonBreakdown(companyId: string): Promise<LostReasonBreakdownEntry[]> {
    const lostLeads = await this.leads.findAll((l) => l.companyId === companyId && l.status === 'lost' && !!l.lostReason?.trim());
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
