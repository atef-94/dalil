import type { AuditLogEntry, Contract, Employee, Lead, Message, Opportunity, Reservation, Task, User } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError } from '../../infra/errors.js';

export type LeadTimelineEntryType =
  | 'lead_created'
  | 'stage_changed'
  | 'owner_changed'
  | 'lead_updated'
  | 'message'
  | 'task_created'
  | 'task_completed'
  | 'opportunity_created'
  | 'reservation_created'
  | 'contract_signed'
  | 'contract_cancelled';

export interface LeadTimelineEntry {
  type: LeadTimelineEntryType;
  at: string;
  summary: string;
  /** Raw actor id, when one exists — undefined for entries with no real
   * actor (e.g. a reservation created by a background sweep). */
  actorUserId?: string;
  /** Resolved display name (Employee.fullName, falling back to the
   * User's email, then the raw id) — 'AI Agent' when actorType is
   * 'ai_agent', 'System' when there is genuinely no human actor. */
  actorName: string;
  actorType: 'user' | 'ai_agent';
  detail?: Record<string, unknown>;
}

export interface LeadTimeline {
  lead: Lead;
  entries: LeadTimelineEntry[]; // chronological, oldest first
}

/**
 * A unified, append-only activity view for one lead, built entirely from
 * data ACTIVE actually records — no fabricated "digital footprint" or
 * click-tracking data the system was never given. Sources: the lead
 * record itself, its audit trail (stage/owner/field changes — every one
 * of these audit rows is a permanent, never-overwritten record; a lead
 * moving stage twice, or back to a stage it already left, produces two
 * separate rows, never one row mutated in place), messages/comments and
 * tasks/follow-ups logged against it, and any reservation/opportunity/
 * contract it produced. Every returned entry is annotated with who did
 * it (resolved to a real name) and whether that was a human user or the
 * AI Agent acting autonomously (see AuditLogEntry.actorType).
 */
export class LeadTimelineService {
  constructor(
    private readonly leads: Repository<Lead>,
    private readonly auditEntries: Repository<AuditLogEntry>,
    private readonly messages: Repository<Message>,
    private readonly tasks: Repository<Task>,
    private readonly opportunities: Repository<Opportunity>,
    private readonly contracts: Repository<Contract>,
    // Optional: only used to resolve actorUserId -> a real display name
    // and to add Reservation entries. Every existing test/call site that
    // constructed this service before these existed keeps compiling.
    private readonly users?: Repository<User>,
    private readonly employees?: Repository<Employee>,
    private readonly reservations?: Repository<Reservation>,
  ) {}

  private async resolveActorName(userId: string | undefined, actorType: 'user' | 'ai_agent' = 'user'): Promise<string> {
    if (actorType === 'ai_agent') return 'AI Agent';
    if (!userId) return 'System';
    const user = await this.users?.findById(userId);
    if (user?.employeeId) {
      const employee = await this.employees?.findById(user.employeeId);
      if (employee?.fullName) return employee.fullName;
    }
    return user?.email ?? userId;
  }

  async getTimeline(leadId: string, companyId: string): Promise<LeadTimeline> {
    const lead = await this.leads.findById(leadId);
    if (!lead || lead.companyId !== companyId) throw new NotFoundError('lead not found');

    const auditTrail = (await this.auditEntries.findAll((a) => a.companyId === companyId && a.resource === 'lead' && a.resourceId === leadId)).sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );

    // The 'create' audit row (when present — leads created before audit
    // logging existed have none) carries the real creator; merged into
    // lead_created instead of rendered as its own separate entry.
    const createEntry = auditTrail.find((a) => a.action === 'create');
    const entries: LeadTimelineEntry[] = [
      {
        type: 'lead_created',
        at: lead.createdAt,
        summary: lead.sourceId ? `Lead created from ${lead.sourceId}` : 'Lead created',
        actorUserId: createEntry?.actorUserId,
        actorName: await this.resolveActorName(createEntry?.actorUserId, createEntry?.actorType),
        actorType: createEntry?.actorType ?? 'user',
      },
    ];

    // Stage-change history — every transition is its own permanent audit
    // row (PATCH .../stage and the AI/automation update_lead_status path
    // both write one), so moving back to a previously-visited stage keeps
    // the full history rather than collapsing it. `timeInPreviousStageMs`
    // is derived from the gap since the lead's creation or its last stage
    // change, whichever is more recent — a real elapsed duration, not a
    // stored/editable number.
    const stageChanges = auditTrail.filter((a) => a.action === 'edit' && typeof a.metadata?.toStageId === 'string');
    let previousStageEnteredAt = lead.createdAt;
    for (const entry of stageChanges) {
      const meta = entry.metadata ?? {};
      const timeInPreviousStageMs = Date.parse(entry.createdAt) - Date.parse(previousStageEnteredAt);
      entries.push({
        type: 'stage_changed',
        at: entry.createdAt,
        summary: `Stage changed to "${meta.toStatus}"${typeof meta.lostReason === 'string' ? ` (${meta.lostReason})` : ''}`,
        actorUserId: entry.actorUserId,
        actorName: await this.resolveActorName(entry.actorUserId, entry.actorType),
        actorType: entry.actorType ?? 'user',
        detail: { ...meta, timeInPreviousStageMs },
      });
      previousStageEnteredAt = entry.createdAt;
    }

    for (const entry of auditTrail.filter((a) => a.action === 'assign' && typeof a.metadata?.newOwnerUserId === 'string')) {
      entries.push({
        type: 'owner_changed',
        at: entry.createdAt,
        summary: 'Owner reassigned',
        actorUserId: entry.actorUserId,
        actorName: await this.resolveActorName(entry.actorUserId, entry.actorType),
        actorType: entry.actorType ?? 'user',
        detail: entry.metadata,
      });
    }

    // "Important Lead Data Changes" — custom fields (incl. budget-like
    // fields) and tags/priority, each recorded with its own
    // previousValues/newValues by the routes that call this (see
    // PATCH .../details and .../tags in app.ts).
    for (const entry of auditTrail.filter((a) => a.action === 'edit' && Array.isArray(a.metadata?.fieldsChanged))) {
      const fields = entry.metadata!.fieldsChanged as string[];
      entries.push({
        type: 'lead_updated',
        at: entry.createdAt,
        summary: `Updated ${fields.join(', ')}`,
        actorUserId: entry.actorUserId,
        actorName: await this.resolveActorName(entry.actorUserId, entry.actorType),
        actorType: entry.actorType ?? 'user',
        detail: entry.metadata,
      });
    }

    // Comments/notes/calls/WhatsApp/email — Message rows are never
    // updated after creation (see CommunicationService.sendMessage: only
    // ever inserted, never re-saved), so every one of these is permanent.
    const messages = await this.messages.findAll((m) => m.companyId === companyId && m.relatedResource === 'lead' && m.relatedResourceId === leadId);
    for (const m of messages) {
      const bodyPreview = m.body.length > 140 ? `${m.body.slice(0, 140)}…` : m.body;
      const channelLabel = m.channel && m.channel !== 'internal' ? ` (${m.channel})` : '';
      entries.push({
        type: 'message',
        at: m.createdAt,
        summary: `${m.subject}${channelLabel}: ${bodyPreview}`,
        actorUserId: m.fromUserId,
        actorName: await this.resolveActorName(m.fromUserId, m.actorType),
        actorType: m.actorType ?? 'user',
        detail: { channel: m.channel, status: m.status, body: m.body },
      });
    }

    // Follow-ups (Task): one entry when created, a second when it
    // actually completes/is cancelled (completedAt is only ever set once,
    // by TaskService.completeTask/cancelTask).
    const tasks = await this.tasks.findAll((t) => t.companyId === companyId && t.relatedResource === 'lead' && t.relatedResourceId === leadId);
    for (const t of tasks) {
      entries.push({
        type: 'task_created',
        at: t.createdAt,
        summary: `Follow-up created: "${t.title}"`,
        actorUserId: t.createdByUserId,
        actorName: await this.resolveActorName(t.createdByUserId, t.actorType),
        actorType: t.actorType ?? 'user',
        detail: { taskId: t.id, status: t.status, dueAt: t.dueAt },
      });
      if (t.completedAt) {
        entries.push({
          type: 'task_completed',
          at: t.completedAt,
          summary: `Follow-up ${t.status === 'cancelled' ? 'cancelled' : 'completed'}: "${t.title}"`,
          actorUserId: t.completedByUserId,
          actorName: await this.resolveActorName(t.completedByUserId),
          actorType: 'user',
          detail: { taskId: t.id, status: t.status },
        });
      }
    }

    const opportunities = await this.opportunities.findAll((o) => o.companyId === companyId && o.leadId === leadId);
    for (const o of opportunities) {
      entries.push({
        type: 'opportunity_created',
        at: o.createdAt,
        summary: 'Offer created',
        actorUserId: o.ownerEmployeeUserId,
        actorName: await this.resolveActorName(o.ownerEmployeeUserId),
        actorType: 'user',
        detail: { opportunityId: o.id, stage: o.stage },
      });
    }

    // Reservation Created — a real record from Unit hold/reserve
    // (InventoryService.reserveUnit). Status-change history isn't shown
    // separately: nothing in the reservation pipeline threads an actor id
    // through markReservationConverted/markReservationCancelled today, so
    // rather than fabricate a "who" this shows the reservation's current
    // status inline on its one real, dated event.
    if (this.reservations) {
      const reservations = await this.reservations.findAll((r) => r.companyId === companyId && r.clientId === leadId);
      for (const r of reservations) {
        entries.push({
          type: 'reservation_created',
          at: r.createdAt,
          summary: `Reservation created (currently: ${r.status})`,
          actorType: 'user',
          actorName: 'System',
          detail: { reservationId: r.id, unitId: r.unitId, status: r.status },
        });
      }
    }

    // Contract.clientId holds the originating lead's id (see
    // PortalService.getCustomer360, which resolves contracts the same way).
    const contracts = await this.contracts.findAll((c) => c.companyId === companyId && c.clientId === leadId);
    for (const c of contracts) {
      if (c.signedAt) {
        entries.push({
          type: 'contract_signed',
          at: c.signedAt,
          summary: 'Contract signed',
          actorUserId: c.creditedEmployeeUserId,
          actorName: await this.resolveActorName(c.creditedEmployeeUserId),
          actorType: 'user',
          detail: { contractId: c.id },
        });
      }
      if (c.status === 'cancelled') {
        // The contract itself has no cancelledAt field — the accurate
        // moment lives in its own audit trail (app.ts records it there
        // when POST /api/sales/contracts/:contractId/cancel runs).
        const cancelEntry = (await this.auditEntries.findAll((a) => a.companyId === companyId && a.resource === 'contract' && a.resourceId === c.id && a.metadata?.cancelled === true))[0];
        entries.push({
          type: 'contract_cancelled',
          at: cancelEntry?.createdAt ?? c.createdAt,
          summary: 'Contract cancelled',
          actorUserId: cancelEntry?.actorUserId,
          actorName: await this.resolveActorName(cancelEntry?.actorUserId, cancelEntry?.actorType),
          actorType: cancelEntry?.actorType ?? 'user',
          detail: { contractId: c.id },
        });
      }
    }

    entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return { lead, entries };
  }
}
