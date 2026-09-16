import { randomUUID } from 'node:crypto';
import type { Campaign, CampaignChannel, CampaignStatus, Lead } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError, ValidationError } from '../../infra/errors.js';

export interface CreateCampaignInput {
  companyId: string;
  name: string;
  channel: CampaignChannel;
  budget: number;
  startDate: string;
  endDate?: string;
}

export interface CampaignPerformance {
  campaignId: string;
  campaignName: string;
  leadCount: number;
  qualifiedCount: number;
  convertedCount: number;
  conversionRate: number;
}

const VALID_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  planned: ['active', 'cancelled'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export class MarketingService {
  constructor(
    private readonly campaigns: Repository<Campaign>,
    private readonly leads: Repository<Lead>,
  ) {}

  async createCampaign(input: CreateCampaignInput): Promise<Campaign> {
    if (!input.name?.trim()) throw new ValidationError('name is required');
    if (!(input.budget >= 0)) throw new ValidationError('budget must not be negative');
    if (Number.isNaN(Date.parse(input.startDate))) throw new ValidationError('startDate must be a valid date');

    const campaign: Campaign = {
      id: randomUUID(),
      companyId: input.companyId,
      name: input.name.trim(),
      channel: input.channel,
      budget: input.budget,
      startDate: input.startDate,
      endDate: input.endDate,
      status: 'planned',
      createdAt: new Date().toISOString(),
    };
    return this.campaigns.save(campaign);
  }

  async listCampaigns(companyId: string): Promise<Campaign[]> {
    return this.campaigns.findAll((c) => c.companyId === companyId);
  }

  async getCampaign(id: string): Promise<Campaign | undefined> {
    return this.campaigns.findById(id);
  }

  async updateStatus(id: string, companyId: string, status: CampaignStatus): Promise<Campaign> {
    const campaign = await this.campaigns.findById(id);
    if (!campaign || campaign.companyId !== companyId) throw new NotFoundError('campaign not found');
    if (!VALID_TRANSITIONS[campaign.status].includes(status)) {
      throw new ValidationError(`cannot move a ${campaign.status} campaign to ${status}`);
    }
    return this.campaigns.save({ ...campaign, status });
  }

  /**
   * Attributes leads to a campaign via Lead.sourceId === campaign.id — the
   * frontend passes the campaign's own id as the source when creating a
   * lead from a campaign-tracked channel, so no separate join table is
   * needed.
   */
  async campaignPerformance(id: string, companyId: string): Promise<CampaignPerformance> {
    const campaign = await this.campaigns.findById(id);
    if (!campaign || campaign.companyId !== companyId) throw new NotFoundError('campaign not found');

    const attributedLeads = await this.leads.findAll((l) => l.companyId === companyId && l.sourceId === campaign.id);
    const qualifiedCount = attributedLeads.filter((l) => l.status === 'qualified' || l.status === 'opportunity').length;
    const convertedCount = attributedLeads.filter((l) => l.status === 'opportunity').length;

    return {
      campaignId: campaign.id,
      campaignName: campaign.name,
      leadCount: attributedLeads.length,
      qualifiedCount,
      convertedCount,
      conversionRate: attributedLeads.length > 0 ? Math.round((convertedCount / attributedLeads.length) * 1000) / 10 : 0,
    };
  }
}
