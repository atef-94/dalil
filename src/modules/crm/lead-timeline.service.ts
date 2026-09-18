import type { AuditLogEntry, Contract, Lead, Message, Opportunity, Task } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError } from '../../infra/errors.js';

export type LeadTimelineEntryType =
  | 'lead_created'
  | 'status_changed'
  | 'owner_changed'
  | 'message'
  | 'task'
  | 'opportunity_created'
  | 'contract_signed'
  | 'contract_cancelled';

export interface LeadTimelineEntry {
  type: LeadTimelineEntryType;
  at: string;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface LeadTimeline {
  lead: Lead;
  entries: LeadTimelineEntry[]; // chronological, oldest first
}

/**
 * A unified activity view for one lead, built entirely from data ACTIVE
 * actually records — no fabricated "digital footprint" or click-tracking
 * data the system was never given. Sources: the lead record itself, its
 * audit trail (status/owner changes), messages and tasks logged against
 * it, and any opportunity/contract it produced.
 */
export class LeadTimelineService {
  constructor(
    private readonly leads: Repository<Lead>,
    private readonly auditEntries: Repository<AuditLogEntry>,
    private readonly messages: Repository<Message>,
    private readonly tasks: Repository<Task>,
    private readonly opportunities: Repository<Opportunity>,
    private readonly contracts: Repository<Contract>,
  ) {}

  async getTimeline(leadId: string, companyId: string): Promise<LeadTimeline> {
    const lead = await this.leads.findById(leadId);
    if (!lead || lead.companyId !== companyId) throw new NotFoundError('lead not found');

    const entries: LeadTimelineEntry[] = [
      { type: 'lead_created', at: lead.createdAt, summary: lead.sourceId ? `Lead created from ${lead.sourceId}` : 'Lead created' },
    ];

    const auditTrail = await this.auditEntries.findAll((a) => a.companyId === companyId && a.resource === 'lead' && a.resourceId === leadId);
    for (const entry of auditTrail) {
      const meta = entry.metadata ?? {};
      if (entry.action === 'create') continue; // already represented by lead_created above
      if (typeof meta.toStatus === 'string') {
        entries.push({
          type: 'status_changed',
          at: entry.createdAt,
          summary: `Status changed to "${meta.toStatus}"${typeof meta.lostReason === 'string' ? ` (${meta.lostReason})` : ''}`,
          detail: meta,
        });
      } else if (typeof meta.newOwnerUserId === 'string') {
        entries.push({ type: 'owner_changed', at: entry.createdAt, summary: 'Owner reassigned', detail: meta });
      }
    }

    const messages = await this.messages.findAll((m) => m.companyId === companyId && m.relatedResource === 'lead' && m.relatedResourceId === leadId);
    for (const m of messages) {
      const bodyPreview = m.body.length > 140 ? `${m.body.slice(0, 140)}…` : m.body;
      const channelLabel = m.channel && m.channel !== 'internal' ? ` (${m.channel})` : '';
      entries.push({ type: 'message', at: m.createdAt, summary: `${m.subject}${channelLabel}: ${bodyPreview}`, detail: { channel: m.channel, status: m.status } });
    }

    const tasks = await this.tasks.findAll((t) => t.companyId === companyId && t.relatedResource === 'lead' && t.relatedResourceId === leadId);
    for (const t of tasks) {
      entries.push({ type: 'task', at: t.createdAt, summary: `Task created: "${t.title}"`, detail: { status: t.status, dueAt: t.dueAt } });
    }

    const opportunities = await this.opportunities.findAll((o) => o.companyId === companyId && o.leadId === leadId);
    for (const o of opportunities) {
      entries.push({ type: 'opportunity_created', at: o.createdAt, summary: 'Opportunity created', detail: { opportunityId: o.id, stage: o.stage } });
    }

    // Contract.clientId holds the originating lead's id (see
    // PortalService.getCustomer360, which resolves contracts the same way).
    const contracts = await this.contracts.findAll((c) => c.companyId === companyId && c.clientId === leadId);
    for (const c of contracts) {
      if (c.signedAt) entries.push({ type: 'contract_signed', at: c.signedAt, summary: 'Contract signed', detail: { contractId: c.id } });
      if (c.status === 'cancelled') {
        // The contract itself has no cancelledAt field — the accurate
        // moment lives in its own audit trail (app.ts records it there
        // when POST /api/sales/contracts/:contractId/cancel runs).
        const cancelEntry = (await this.auditEntries.findAll((a) => a.companyId === companyId && a.resource === 'contract' && a.resourceId === c.id && a.metadata?.cancelled === true))[0];
        entries.push({ type: 'contract_cancelled', at: cancelEntry?.createdAt ?? c.createdAt, summary: 'Contract cancelled', detail: { contractId: c.id } });
      }
    }

    entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return { lead, entries };
  }
}
