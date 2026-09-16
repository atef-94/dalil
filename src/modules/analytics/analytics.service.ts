import type { Commission, Contract, Lead, Opportunity, PaymentScheduleLine, Unit } from '../../domain/types.js';
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

export class AnalyticsService {
  constructor(
    private readonly leads: Repository<Lead>,
    private readonly opportunities: Repository<Opportunity>,
    private readonly contracts: Repository<Contract>,
    private readonly scheduleLines: Repository<PaymentScheduleLine>,
    private readonly units: Repository<Unit>,
    private readonly commissions: Repository<Commission>,
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
}
