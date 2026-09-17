import type { Lead } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError } from '../../infra/errors.js';

export interface LeadScore {
  leadId: string;
  score: number;
  factors: { label: string; points: number }[];
}

const STATUS_WEIGHT: Record<Lead['status'], number> = {
  new: 10,
  contacted: 35,
  qualified: 60,
  opportunity: 90,
  lost: 0,
};

const RECENCY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks

/**
 * A transparent, rule-based lead priority score — not a machine-learning or
 * LLM model. No external AI API is configured for this deployment, so this
 * computes a deterministic 0-100 score from real signals already in the
 * data (funnel stage, recency, whether an owner is assigned) and shows its
 * work via `factors`, rather than presenting an unverifiable black-box
 * number. Swapping in a real ML/LLM-backed scorer later is a drop-in
 * replacement for this service's `score` method.
 */
export class LeadScoringService {
  constructor(private readonly leads: Repository<Lead>) {}

  private computeScore(lead: Lead, now: number): LeadScore {
    const factors: { label: string; points: number }[] = [];

    if (lead.status === 'lost') {
      return { leadId: lead.id, score: 0, factors: [{ label: 'lead is lost', points: 0 }] };
    }

    const statusPoints = STATUS_WEIGHT[lead.status];
    factors.push({ label: `funnel stage: ${lead.status}`, points: statusPoints });

    const ageMs = now - Date.parse(lead.createdAt);
    const recencyPoints = ageMs <= RECENCY_WINDOW_MS ? Math.round(10 * (1 - ageMs / RECENCY_WINDOW_MS)) : 0;
    if (recencyPoints > 0) factors.push({ label: 'created within the last 2 weeks', points: recencyPoints });

    const ownerPoints = lead.ownerEmployeeUserId ? 10 : 0;
    if (ownerPoints > 0) factors.push({ label: 'has an assigned owner', points: ownerPoints });

    const sourcePoints = lead.sourceId ? 5 : 0;
    if (sourcePoints > 0) factors.push({ label: 'has a tracked source', points: sourcePoints });

    const score = Math.max(0, Math.min(100, statusPoints + recencyPoints + ownerPoints + sourcePoints));
    return { leadId: lead.id, score, factors };
  }

  async scoreLead(leadId: string, companyId: string): Promise<LeadScore> {
    const lead = await this.leads.findById(leadId);
    if (!lead || lead.companyId !== companyId) throw new NotFoundError('lead not found');
    return this.computeScore(lead, Date.now());
  }

  async rankedLeads(companyId: string): Promise<LeadScore[]> {
    const leads = await this.leads.findAll((l) => l.companyId === companyId && l.status !== 'lost');
    const now = Date.now();
    return leads.map((l) => this.computeScore(l, now)).sort((a, b) => b.score - a.score);
  }
}
