import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import type { FacebookLeadEvent, IntegrationConnection } from '../../domain/types.js';
import type { DomainEvent } from '../../infra/event-bus.js';
import type { Repository } from '../../infra/repository.js';
import { AuditLog } from '../../infra/audit-log.js';
import { ConflictError, ForbiddenError, ValidationError } from '../../infra/errors.js';
import { KeyedMutex } from '../../infra/keyed-mutex.js';
import type { CreateLeadInput, CrmService } from '../crm/crm.service.js';
import type { IntegrationService } from './integration.service.js';

export interface FacebookLeadsRepos {
  connections: Repository<IntegrationConnection>;
  events: Repository<FacebookLeadEvent>;
}

/** One `leadgen` change notification extracted from a raw webhook payload —
 * see extractLeadgenChanges for the real Meta payload shape this is parsed
 * from. */
export interface FacebookLeadgenChange {
  pageId: string;
  formId?: string;
  leadgenId: string;
}

export type FacebookLeadOutcome =
  | { outcome: 'created'; leadId: string; companyId: string }
  | { outcome: 'already_processed'; leadId?: string; companyId: string }
  | { outcome: 'duplicate_phone'; companyId: string }
  | { outcome: 'skipped_invalid_data'; companyId: string }
  /** No IntegrationConnection's config.pageId matches — this Page has
   * never been connected by any tenant (or was disconnected). Not an
   * error: Meta will keep sending leadgen events for every Page it has a
   * live subscription for, whether or not anyone in ACTIVE has connected
   * it yet; this is the expected, silent outcome until they do. Past
   * leads from before a Page was connected are not retroactively
   * recoverable — Meta does not re-deliver old webhook events. */
  | { outcome: 'unknown_page' };

/**
 * Facebook/Instagram Instant Lead Forms: turns a verified Meta `leadgen`
 * webhook delivery into a real ACTIVE Lead, through the exact same
 * CrmService.createLead() every other lead-creation path (manual form, CSV
 * import, file import) uses — no parallel lead-creation logic.
 *
 * Unlike the Integration Layer's per-company webhook routes (communication
 * delivery, e-signature), Meta's webhook model has exactly one URL per
 * Meta App, shared by every connected company's Pages — so the company is
 * never taken from the URL or the payload's own claims, only resolved by
 * looking up which company's IntegrationConnection has the verified
 * webhook's Page ID in its config (see findConnectionForPage). The
 * signature check (verifySignature) is what makes trusting that payload at
 * all safe in the first place.
 */
export class FacebookLeadsService {
  // Per-leadgen_id lock: Meta can deliver the same event twice in close
  // succession (its own retry racing the original, slow delivery) — this
  // closes the same TOCTOU gap AutomationService.receiveWebhook's
  // idempotencyMutex closes for workflow webhooks, so two concurrent
  // deliveries for one lead can never both pass the "not yet processed"
  // check before either has saved its ledger row.
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly repos: FacebookLeadsRepos,
    private readonly integrations: IntegrationService,
    private readonly crm: CrmService,
    private readonly auditLog: AuditLog,
    private readonly emitEvent: (event: DomainEvent) => Promise<void>,
    /** The Meta App's App Secret, used only to verify X-Hub-Signature-256
     * — undefined (unconfigured) means every delivery is rejected, never
     * silently accepted unverified. */
    private readonly appSecret: string | undefined,
    /** The arbitrary string this ACTIVE deployment and the Meta Developer
     * Console's webhook subscription form both know — Meta echoes it back
     * on the GET verification handshake as proof the request actually
     * came from whoever configured the subscription. Undefined
     * (unconfigured) means the handshake always fails. */
    private readonly verifyToken: string | undefined,
  ) {}

  /** Verifies Meta's `X-Hub-Signature-256: sha256=<hex>` header against the
   * exact raw request body — the same HMAC-SHA256-over-raw-bytes scheme
   * CommunicationDeliveryService.verifySignature uses for WhatsApp/email
   * delivery callbacks, adapted to Meta's header format. Throws
   * ForbiddenError (never returns false) so a caller can't accidentally
   * forget to check a boolean result. */
  verifySignature(rawBody: string, signatureHeader: string | undefined): void {
    if (!this.appSecret) {
      throw new ForbiddenError('Facebook webhook is not configured');
    }
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
      throw new ForbiddenError('missing or malformed X-Hub-Signature-256 header');
    }
    const provided = signatureHeader.slice('sha256='.length);
    const expected = createHmac('sha256', this.appSecret).update(rawBody).digest('hex');
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ForbiddenError('invalid webhook signature');
    }
  }

  /** The one-time (and periodically re-run, if Meta re-verifies)
   * `hub.challenge` handshake every Meta webhook subscription requires
   * before it starts delivering events. Returns the challenge string to
   * echo back verbatim — the caller is responsible for sending it as a
   * plain-text response, not JSON (Meta compares it byte-for-byte). */
  verifyChallenge(mode: string | undefined, token: string | undefined, challenge: string | undefined): string {
    if (!this.appSecret) {
      throw new ForbiddenError('Facebook webhook is not configured');
    }
    if (mode !== 'subscribe' || !token || token !== this.verifyToken || !challenge) {
      throw new ForbiddenError('webhook verification failed');
    }
    return challenge;
  }

  /** Parses Meta's real leadgen webhook payload shape:
   * `{ object: 'page', entry: [{ id, changes: [{ field: 'leadgen', value: { page_id, form_id, leadgen_id } }] }] }`.
   * Deliberately permissive — an unexpected/empty/malformed payload simply
   * yields no changes (nothing to process, a 200 with zero work done)
   * rather than throwing, since Meta also uses this same endpoint for
   * unrelated page-object subscriptions and test pings this integration
   * doesn't care about. */
  extractLeadgenChanges(payload: unknown): FacebookLeadgenChange[] {
    if (!payload || typeof payload !== 'object') return [];
    const entries = (payload as { entry?: unknown }).entry;
    if (!Array.isArray(entries)) return [];
    const changes: FacebookLeadgenChange[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const entryPageId = typeof (entry as { id?: unknown }).id === 'string' ? (entry as { id: string }).id : undefined;
      const entryChanges = (entry as { changes?: unknown }).changes;
      if (!Array.isArray(entryChanges)) continue;
      for (const change of entryChanges) {
        if (!change || typeof change !== 'object' || (change as { field?: unknown }).field !== 'leadgen') continue;
        const value = (change as { value?: unknown }).value;
        if (!value || typeof value !== 'object') continue;
        const leadgenId = (value as { leadgen_id?: unknown }).leadgen_id;
        const pageId = (value as { page_id?: unknown }).page_id ?? entryPageId;
        const formId = (value as { form_id?: unknown }).form_id;
        if (typeof leadgenId === 'string' && leadgenId && typeof pageId === 'string' && pageId) {
          changes.push({ pageId, leadgenId, formId: typeof formId === 'string' ? formId : undefined });
        }
      }
    }
    return changes;
  }

  /** Processes one leadgen change end to end: idempotency check -> resolve
   * the owning company exclusively by matching the verified webhook's Page
   * ID against a configured IntegrationConnection (never the payload's own
   * claims beyond that Page ID, and never a client-supplied company id) ->
   * fetch the real submitted field data from the Graph API -> map it to a
   * lead -> create it through CrmService.createLead.
   *
   * Throws only for a genuinely transient/operational failure (Graph API
   * error, an unreadable/missing stored credential, an unexpected
   * repository error) — callers should treat a thrown error as "ask Meta
   * to retry this delivery". Every other outcome (unknown page, a lead
   * that's already been processed, Meta's own data missing a required
   * field, a phone number colliding with an existing lead) is a normal,
   * non-retryable result returned instead of thrown — retrying any of
   * those would just reproduce the identical outcome forever. */
  async handleLeadgenChange(change: FacebookLeadgenChange): Promise<FacebookLeadOutcome> {
    return this.mutex.runExclusive(change.leadgenId, async () => {
      const already = (await this.repos.events.findAll((e) => e.leadgenId === change.leadgenId))[0];
      if (already) {
        return { outcome: 'already_processed', leadId: already.leadId, companyId: already.companyId };
      }

      const connection = await this.findConnectionForPage(change.pageId);
      if (!connection) {
        return { outcome: 'unknown_page' };
      }

      const credentials = await this.integrations.resolveCredentials(connection.companyId, connection);
      const accessToken = credentials.page_access_token;
      if (!accessToken) {
        // An operational problem with this company's own connection (the
        // token was never stored, or its decryption failed) — not
        // something retrying the same webhook fixes by itself, but also
        // not safe to silently drop: surfacing it as a thrown error keeps
        // it visible (a 5xx in the deploy logs) rather than swallowed.
        throw new Error(`facebook_leads connection ${connection.id} has no usable page_access_token`);
      }

      const fieldData = await this.integrations.fetchFacebookLeadData(change.leadgenId, accessToken);
      const input = this.mapToCreateLeadInput(connection.companyId, fieldData);

      try {
        if (!input) {
          await this.recordEvent(connection, change, 'skipped_invalid_data', undefined, 'Meta returned no usable full name/phone for this lead');
          return { outcome: 'skipped_invalid_data', companyId: connection.companyId };
        }
        const lead = await this.crm.createLead(input);
        await this.recordEvent(connection, change, 'processed', lead.id);
        await this.auditLog.record({
          companyId: connection.companyId,
          actorUserId: 'system:facebook_leads',
          action: 'create',
          resource: 'lead',
          resourceId: lead.id,
          metadata: { source: 'facebook', leadgenId: change.leadgenId, pageId: change.pageId, formId: change.formId },
        });
        await this.emitEvent({
          companyId: connection.companyId,
          type: 'lead.created',
          payload: { ...lead },
          dedupeKey: `lead.created:${lead.id}`,
        });
        return { outcome: 'created', leadId: lead.id, companyId: connection.companyId };
      } catch (err) {
        if (err instanceof ConflictError) {
          // A legitimate, expected outcome — see FacebookLeadEvent's doc
          // comment for why this is handled separately from (and never
          // confused with) the leadgen_id idempotency check above: this
          // is CrmService's own pre-existing per-company phone-dedup
          // guard, tripped by a lead that already exists (from any
          // source) with this same phone number. Retrying the identical
          // webhook would hit the exact same collision again, so this is
          // recorded and acknowledged, not retried.
          await this.recordEvent(connection, change, 'duplicate_phone', undefined, err.message);
          await this.auditLog.record({
            companyId: connection.companyId,
            actorUserId: 'system:facebook_leads',
            action: 'create',
            resource: 'lead',
            resourceId: change.leadgenId,
            metadata: { source: 'facebook', leadgenId: change.leadgenId, pageId: change.pageId, duplicatePhone: true },
          });
          return { outcome: 'duplicate_phone', companyId: connection.companyId };
        }
        if (err instanceof ValidationError) {
          // Meta's own data didn't satisfy CrmService's requirements (e.g.
          // a phone number createLead's own normalizer rejects) — same
          // "retrying reproduces the identical failure" reasoning as
          // duplicate_phone above.
          await this.recordEvent(connection, change, 'skipped_invalid_data', undefined, err.message);
          return { outcome: 'skipped_invalid_data', companyId: connection.companyId };
        }
        throw err; // genuine operational failure — let the caller signal "retry this delivery"
      }
    });
  }

  private async findConnectionForPage(pageId: string): Promise<IntegrationConnection | undefined> {
    // Deliberately unscoped by companyId — this *is* the company
    // resolution step (see class doc comment). Only a 'connected'
    // facebook_leads connection counts; a disconnected one's Page no
    // longer belongs to anyone as far as this webhook is concerned.
    const matches = await this.repos.connections.findAll(
      (c) => c.provider === 'facebook_leads' && c.status === 'connected' && c.config.pageId === pageId,
    );
    return matches[0];
  }

  /** Maps Meta's Lead Ads field names to CreateLeadInput. Meta's standard
   * fields use snake_case names (full_name, first_name, last_name,
   * phone_number, email); anything else on the form (custom questions)
   * is simply not carried over — this mapping only claims the fields
   * CreateLeadInput actually has a place for, the same honest scope as
   * every other connector in this module. */
  private mapToCreateLeadInput(companyId: string, fieldData: Record<string, string>): CreateLeadInput | undefined {
    const fullName = (fieldData.full_name?.trim()) || [fieldData.first_name, fieldData.last_name].filter((s) => s?.trim()).join(' ').trim();
    const phone = fieldData.phone_number?.trim();
    if (!fullName || !phone) return undefined;
    return {
      companyId,
      fullName,
      phone,
      email: fieldData.email?.trim() || undefined,
      source: 'facebook',
    };
  }

  private async recordEvent(
    connection: IntegrationConnection,
    change: FacebookLeadgenChange,
    status: FacebookLeadEvent['status'],
    leadId: string | undefined,
    note?: string,
  ): Promise<void> {
    const event: FacebookLeadEvent = {
      id: randomUUID(),
      companyId: connection.companyId,
      connectionId: connection.id,
      pageId: change.pageId,
      formId: change.formId,
      leadgenId: change.leadgenId,
      status,
      leadId,
      note,
      createdAt: new Date().toISOString(),
    };
    await this.repos.events.save(event);
  }
}
