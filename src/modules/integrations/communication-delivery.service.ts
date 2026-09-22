import { randomUUID } from 'node:crypto';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CommunicationDeliveryEvent, CommunicationDeliveryStatus } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../infra/errors.js';
import type { AutomationService } from '../automation/automation.service.js';
import type { IntegrationService } from './integration.service.js';

const VALID_STATUSES: CommunicationDeliveryStatus[] = ['queued', 'sent', 'delivered', 'read', 'failed', 'rejected', 'unknown'];

export interface DeliveryWebhookPayload {
  providerMessageId: string;
  status: CommunicationDeliveryStatus;
  failureReason?: string;
}

/**
 * Real communication delivery tracking, closing the "API call succeeded ≠
 * message delivered" gap: IntegrationService.send() only logs that our
 * request to WhatsApp/SendGrid was accepted (status 'sent' on the initial
 * CommunicationDeliveryEvent it writes — see integration.service.ts). Every
 * later transition (delivered/read/failed/rejected) only ever comes from
 * here, driven by a real inbound webhook, HMAC-verified against that
 * connection's own webhook_secret exactly like SignatureService verifies
 * e-signature callbacks — an unverified or mis-signed request never
 * touches state. Not certified against WhatsApp Cloud API's or SendGrid's
 * exact raw payload shape (same honest, real-but-provider-agnostic scope
 * as every other connector in this codebase): this accepts a normalized
 * {providerMessageId, status, failureReason?} body, which a provider-specific
 * adapter would map their own webhook shape into before/at this handler.
 */
export class CommunicationDeliveryService {
  constructor(
    private readonly deliveryEvents: Repository<CommunicationDeliveryEvent>,
    private readonly integrations: IntegrationService,
    private readonly automation: AutomationService,
  ) {}

  /**
   * Verifies the inbound callback against connectionId's own webhook_secret
   * before appending anything. Idempotent in spirit but not identity-deduped
   * by design: a provider's retried callback for an already-recorded status
   * simply appends another row with the same status — harmless, and the
   * timeline stays a true append-only log rather than silently dropping a
   * legitimate repeat (e.g. two independent "delivered" then "read" events
   * both legitimately follow "sent").
   */
  async handleWebhook(
    companyId: string,
    connectionId: string,
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<CommunicationDeliveryEvent> {
    const connection = await this.integrations.getConnection(connectionId, companyId);
    if (connection.provider !== 'whatsapp' && connection.provider !== 'email') {
      throw new ValidationError('this connection does not support delivery-status webhooks');
    }

    const secretKey = `integration:${connection.id}:webhook_secret`;
    const secret = await this.automation.getDecryptedSecret(companyId, secretKey);
    if (!secret) throw new ValidationError('no webhook secret configured for this connection — set one via the credential store before enabling delivery webhooks');
    if (!signatureHeader) throw new ForbiddenError('missing webhook signature');

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ForbiddenError('invalid webhook signature');
    }

    let payload: DeliveryWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as DeliveryWebhookPayload;
    } catch {
      throw new ValidationError('webhook body must be valid JSON');
    }
    if (!payload.providerMessageId?.trim()) throw new ValidationError('"providerMessageId" is required');
    if (!VALID_STATUSES.includes(payload.status)) {
      throw new ValidationError(`"status" must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    // Carries forward the related-resource link from the message's own
    // initial 'sent' event, if one was recorded, so a later delivered/read
    // row still shows which lead/customer it belongs to.
    const priorForMessage = await this.deliveryEvents.findAll(
      (e) => e.companyId === companyId && e.providerMessageId === payload.providerMessageId,
    );
    const originating = priorForMessage.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];

    const event: CommunicationDeliveryEvent = {
      id: randomUUID(),
      companyId,
      connectionId,
      provider: connection.provider,
      providerMessageId: payload.providerMessageId,
      relatedResource: originating?.relatedResource,
      relatedResourceId: originating?.relatedResourceId,
      status: payload.status,
      failureReason: payload.failureReason,
      rawEvent: JSON.parse(rawBody) as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    };
    return this.deliveryEvents.save(event);
  }

  async getTimeline(companyId: string, providerMessageId: string): Promise<CommunicationDeliveryEvent[]> {
    const events = await this.deliveryEvents.findAll((e) => e.companyId === companyId && e.providerMessageId === providerMessageId);
    if (events.length === 0) throw new NotFoundError('no delivery events found for this message');
    return events.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }
}
