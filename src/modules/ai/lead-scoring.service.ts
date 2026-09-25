import type { CrmStage, Lead } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError } from '../../infra/errors.js';
import type { CrmStageService } from '../crm/crm-stage.service.js';

export interface LeadScore {
  leadId: string;
  score: number;
  factors: { label: string; points: number }[];
}

const RECENCY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks
const WON_STAGE_POINTS = 90;
const MIN_STAGE_POINTS = 10;
const MAX_NON_TERMINAL_STAGE_POINTS = 60;

/**
 * A transparent, rule-based lead priority score — not a machine-learning or
 * LLM model. No external AI API is configured for this deployment, so this
 * computes a deterministic 0-100 score from real signals already in the
 * data (pipeline stage, recency, whether an owner is assigned) and shows
 * its work via `factors`, rather than presenting an unverifiable black-box
 * number. Swapping in a real ML/LLM-backed scorer later is a drop-in
 * replacement for this service's `score` method.
 *
 * Stage weighting is relative, not name-based: a lead's points scale with
 * how far along the company's own (possibly custom) pipeline its current
 * stage sits — isWon stages score the same as the old fixed 'opportunity'
 * status did (90), isLost stages score 0, and every stage in between is
 * spread proportionally across MIN..MAX_NON_TERMINAL_STAGE_POINTS by
 * order. A company that never customizes its pipeline gets the exact
 * same 10/35/60/90/0 spread the old fixed enum produced, since the
 * seeded defaults preserve that shape.
 */
export class LeadScoringService {
  constructor(
    private readonly leads: Repository<Lead>,
    private readonly crmStages: CrmStageService,
  ) {}

  private stagePoints(stage: CrmStage | undefined, nonTerminalStages: CrmStage[]): number {
    if (!stage) return MIN_STAGE_POINTS;
    if (stage.isLost) return 0;
    if (stage.isWon) return WON_STAGE_POINTS;
    const idx = nonTerminalStages.findIndex((s) => s.id === stage.id);
    if (idx === -1 || nonTerminalStages.length <= 1) return MIN_STAGE_POINTS;
    const ratio = idx / (nonTerminalStages.length - 1);
    return Math.round(MIN_STAGE_POINTS + ratio * (MAX_NON_TERMINAL_STAGE_POINTS - MIN_STAGE_POINTS));
  }

  private computeScore(lead: Lead, stage: CrmStage | undefined, nonTerminalStages: CrmStage[], now: number): LeadScore {
    const factors: { label: string; points: number }[] = [];

    if (stage?.isLost) {
      return { leadId: lead.id, score: 0, factors: [{ label: 'lead is lost', points: 0 }] };
    }

    const statusPoints = this.stagePoints(stage, nonTerminalStages);
    factors.push({ label: `pipeline stage: ${stage?.name ?? 'unknown'}`, points: statusPoints });

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
    const stages = await this.crmStages.listStages(companyId, true);
    const stage = stages.find((s) => s.id === lead.stageId);
    const nonTerminalStages = stages.filter((s) => !s.isWon && !s.isLost).sort((a, b) => a.order - b.order);
    return this.computeScore(lead, stage, nonTerminalStages, Date.now());
  }

  async rankedLeads(companyId: string): Promise<LeadScore[]> {
    const stages = await this.crmStages.listStages(companyId, true);
    const stageById = new Map(stages.map((s) => [s.id, s]));
    const nonTerminalStages = stages.filter((s) => !s.isWon && !s.isLost).sort((a, b) => a.order - b.order);
    const leads = await this.leads.findAll((l) => l.companyId === companyId && !stageById.get(l.stageId)?.isLost);
    const now = Date.now();
    return leads.map((l) => this.computeScore(l, stageById.get(l.stageId), nonTerminalStages, now)).sort((a, b) => b.score - a.score);
  }
}
