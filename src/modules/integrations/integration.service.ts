import { randomUUID } from 'node:crypto';
import type { CommunicationDeliveryEvent, IntegrationConnection, IntegrationEventStatus, IntegrationProvider } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { AutomationError, NotFoundError, ValidationError } from '../../infra/errors.js';
import { SlidingWindowRateLimiter } from '../../infra/rate-limiter.js';
import { AuditLog } from '../../infra/audit-log.js';
import { AutomationService } from '../automation/automation.service.js';
import type { IntegrationEvent } from '../../domain/types.js';

export interface IntegrationRepos {
  connections: Repository<IntegrationConnection>;
  events: Repository<IntegrationEvent>;
  deliveryEvents: Repository<CommunicationDeliveryEvent>;
}

export interface ConnectorDefinition {
  provider: IntegrationProvider;
  name: string;
  description: string;
  configFields: string[];
  credentialFields: string[];
  actions: string[];
}

// Descriptive metadata for the frontend's "connect a provider" form and for
// the Automation Engine/AI layer to know what an integration_call action
// needs — the same pattern as the Automation Engine's Tool Registry. Never
// consulted for security; connect()/send() validate the real requirements.
const CONNECTOR_REGISTRY: ConnectorDefinition[] = [
  {
    provider: 'whatsapp',
    name: 'WhatsApp Business',
    description: 'Send WhatsApp messages via the Meta Cloud API. Also accepts an optional "webhook_secret" credential (not required to connect) to HMAC-verify inbound delivery-status callbacks — see CommunicationDeliveryService.',
    configFields: ['phoneNumberId'],
    credentialFields: ['access_token'],
    actions: ['send_message'],
  },
  {
    provider: 'email',
    name: 'Email (SendGrid)',
    description: 'Send transactional email via the SendGrid API. Also accepts an optional "webhook_secret" credential (not required to connect) to HMAC-verify inbound delivery-status callbacks — see CommunicationDeliveryService.',
    configFields: ['fromAddress'],
    credentialFields: ['api_key'],
    actions: ['send_message'],
  },
  {
    provider: 'meta_ads',
    name: 'Meta Ads',
    description: 'Update a Meta (Facebook/Instagram) ad campaign status.',
    configFields: ['adAccountId'],
    credentialFields: ['access_token'],
    actions: ['update_campaign_status'],
  },
  {
    provider: 'google_calendar',
    name: 'Google Calendar',
    description: 'Create calendar events for follow-ups and meetings.',
    configFields: ['calendarId'],
    credentialFields: ['access_token'],
    actions: ['create_event'],
  },
  {
    provider: 'payment_stripe',
    name: 'Stripe',
    description: 'Charge a payment via the Stripe API.',
    configFields: [],
    credentialFields: ['secret_key'],
    actions: ['charge'],
  },
  {
    provider: 'e_signature',
    name: 'E-Signature (DocuSign-compatible)',
    description: 'Send a contract document for e-signature via a DocuSign-shaped REST API and receive a webhook-verified signed/declined callback.',
    configFields: ['accountId'],
    credentialFields: ['api_key', 'webhook_secret'],
    actions: ['send_envelope'],
  },
  {
    provider: 'custom_api',
    name: 'Custom API',
    description: 'Generic authenticated REST passthrough for other approved third-party services.',
    configFields: ['baseUrl'],
    credentialFields: ['api_key'],
    actions: ['call'],
  },
];

export interface ConnectIntegrationInput {
  companyId: string;
  provider: IntegrationProvider;
  displayName: string;
  config?: Record<string, unknown>;
  credentials: Record<string, string>;
  createdByUserId: string;
}

const MAX_ATTEMPTS = 3;

/**
 * The Integration Layer: a secure, generic framework for connecting ACTIVE
 * to external providers (WhatsApp, Email, Meta Ads, Google Calendar,
 * payment providers, and — via `custom_api` — any other approved
 * third-party REST API), with real credential security, rate limiting,
 * retries, logging, and failure handling. This is what closes the
 * Communication module's long-documented gap ("logged only, no real
 * external gateway").
 *
 * Credentials are never stored here directly: connect() writes each one
 * through AutomationService's existing encrypted Secret store (the same
 * AES-256-GCM store webhook_call actions use) — this module never
 * duplicates that encryption logic, only reuses it. Every send() call is
 * rate-limited per (company, provider), retried with backoff on failure,
 * and logged to both a dedicated IntegrationEvent delivery log and the
 * shared AuditLog — so a failure is always visible, never silent.
 */
export class IntegrationService {
  private readonly rateLimiter: SlidingWindowRateLimiter;

  constructor(
    private readonly repos: IntegrationRepos,
    private readonly automation: AutomationService,
    private readonly auditLog: AuditLog,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Base retry delay (ms), 0 by default so tests stay instant — see
     * AutomationService's identical retryBaseDelayMs pattern. */
    private readonly retryBaseDelayMs = 0,
    rateLimitPerMinute = 30,
  ) {
    this.rateLimiter = new SlidingWindowRateLimiter(60_000, rateLimitPerMinute);
  }

  listConnectors(): ConnectorDefinition[] {
    return CONNECTOR_REGISTRY;
  }

  async connect(input: ConnectIntegrationInput): Promise<IntegrationConnection> {
    if (!input.displayName?.trim()) throw new ValidationError('displayName is required');
    const definition = CONNECTOR_REGISTRY.find((c) => c.provider === input.provider);
    if (!definition) throw new ValidationError(`unsupported provider: ${input.provider}`);
    for (const field of definition.credentialFields) {
      if (!input.credentials[field]?.trim()) throw new ValidationError(`credential "${field}" is required for ${input.provider}`);
    }
    for (const field of definition.configFields) {
      if (input.config?.[field] === undefined || input.config[field] === '') {
        throw new ValidationError(`config field "${field}" is required for ${input.provider}`);
      }
    }

    const id = randomUUID();
    const credentialKeys: string[] = [];
    for (const [field, value] of Object.entries(input.credentials)) {
      const key = `integration:${id}:${field}`;
      await this.automation.setSecret(input.companyId, key, value, input.createdByUserId);
      credentialKeys.push(key);
    }

    const now = new Date().toISOString();
    const connection: IntegrationConnection = {
      id,
      companyId: input.companyId,
      provider: input.provider,
      displayName: input.displayName.trim(),
      config: input.config ?? {},
      credentialKeys,
      status: 'connected',
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
    };
    return this.repos.connections.save(connection);
  }

  async disconnect(id: string, companyId: string): Promise<IntegrationConnection> {
    const connection = await this.getConnection(id, companyId);
    const secrets = await this.automation.listSecrets(companyId);
    for (const key of connection.credentialKeys) {
      const match = secrets.find((s) => s.key === key);
      if (match) await this.automation.deleteSecret(match.id, companyId, true);
    }
    return this.repos.connections.save({ ...connection, status: 'disconnected', updatedAt: new Date().toISOString() });
  }

  async listConnections(companyId: string): Promise<IntegrationConnection[]> {
    return this.repos.connections.findAll((c) => c.companyId === companyId);
  }

  async getConnection(id: string, companyId: string): Promise<IntegrationConnection> {
    const connection = await this.repos.connections.findById(id);
    if (!connection || connection.companyId !== companyId) throw new NotFoundError('integration connection not found');
    return connection;
  }

  async listEvents(companyId: string, connectionId?: string): Promise<IntegrationEvent[]> {
    return this.repos.events.findAll((e) => e.companyId === companyId && (!connectionId || e.connectionId === connectionId));
  }

  /** The full, real delivery timeline for one message — every status
   * transition a verified webhook has actually reported, oldest first.
   * An empty array for a message that was just sent means exactly that:
   * no delivery confirmation has arrived yet, not "assumed delivered". */
  async getDeliveryTimeline(companyId: string, providerMessageId: string): Promise<CommunicationDeliveryEvent[]> {
    const events = await this.repos.deliveryEvents.findAll((e) => e.companyId === companyId && e.providerMessageId === providerMessageId);
    return events.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  /** The most recent delivery status ACTIVE has actually observed for a
   * given related resource (typically a lead) — what the AI queries
   * instead of assuming "API call succeeded" means "message delivered".
   * Returns undefined when nothing has been sent to this resource yet. */
  async getLatestDeliveryStatusForResource(companyId: string, relatedResourceId: string): Promise<CommunicationDeliveryEvent | undefined> {
    const events = await this.repos.deliveryEvents.findAll((e) => e.companyId === companyId && e.relatedResourceId === relatedResourceId);
    return events.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  }

  /**
   * Sends one outbound call through a company's connected provider.
   * Pipeline: find the active connection -> rate limit -> resolve
   * credentials from the encrypted store -> dispatch with retry/backoff ->
   * log the outcome (IntegrationEvent + AuditLog) either way.
   */
  async send(
    companyId: string,
    provider: IntegrationProvider,
    action: string,
    params: Record<string, unknown>,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const connections = await this.repos.connections.findAll((c) => c.companyId === companyId && c.provider === provider && c.status !== 'disconnected');
    const connection = connections[0];
    if (!connection) throw new NotFoundError(`no connected ${provider} integration for this company`);

    const rateLimit = this.rateLimiter.consume(`${companyId}:${provider}`);
    if (!rateLimit.allowed) {
      await this.recordEvent(companyId, connection.id, provider, action, 'rate_limited', params, 0, 'rate limit exceeded');
      throw new AutomationError(`rate limit exceeded for ${provider} — try again shortly`, 429);
    }

    const credentials = await this.resolveCredentials(companyId, connection);

    let attempts = 0;
    let lastError: string | undefined;
    let result: Record<string, unknown> | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      attempts = attempt;
      if (attempt > 1 && this.retryBaseDelayMs > 0) {
        await this.sleep(Math.min(this.retryBaseDelayMs * 2 ** (attempt - 2), 30_000));
      }
      try {
        result = await this.dispatch(provider, action, connection, credentials, params);
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    if (result) {
      await this.recordEvent(companyId, connection.id, provider, action, 'success', params, attempts);
      await this.repos.connections.save({ ...connection, status: 'connected', lastError: undefined, lastUsedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await this.auditLog.record({
        companyId, actorUserId: userId, action: 'execute', resource: 'integration_connection', resourceId: connection.id,
        metadata: { provider, integrationAction: action, attempts },
      });
      if ((provider === 'whatsapp' || provider === 'email') && typeof result.providerMessageId === 'string') {
        // 'sent' is the honest starting status: the provider accepted the
        // request, nothing more — a real delivered/read/failed transition
        // only ever comes from a verified webhook callback (see
        // CommunicationDeliveryService.handleWebhook), never assumed here.
        await this.repos.deliveryEvents.save({
          id: randomUUID(),
          companyId,
          connectionId: connection.id,
          provider,
          providerMessageId: result.providerMessageId,
          relatedResource: typeof params.leadId === 'string' ? 'lead' : undefined,
          relatedResourceId: typeof params.leadId === 'string' ? params.leadId : undefined,
          status: 'sent',
          createdAt: new Date().toISOString(),
        });
      }
      return result;
    }

    await this.recordEvent(companyId, connection.id, provider, action, 'failed', params, attempts, lastError);
    await this.repos.connections.save({ ...connection, status: 'error', lastError, updatedAt: new Date().toISOString() });
    await this.auditLog.record({
      companyId, actorUserId: userId, action: 'execute', resource: 'integration_connection', resourceId: connection.id,
      metadata: { provider, integrationAction: action, attempts, failed: true, error: lastError },
    });
    throw new AutomationError(`${provider} ${action} failed after ${attempts} attempt(s): ${lastError}`, 502);
  }

  private async resolveCredentials(companyId: string, connection: IntegrationConnection): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const key of connection.credentialKeys) {
      const field = key.split(':').slice(2).join(':');
      const value = await this.automation.getDecryptedSecret(companyId, key);
      if (value !== undefined) result[field] = value;
    }
    return result;
  }

  private async recordEvent(
    companyId: string,
    connectionId: string,
    provider: IntegrationProvider,
    action: string,
    status: IntegrationEventStatus,
    params: Record<string, unknown>,
    attempts: number,
    error?: string,
  ): Promise<void> {
    const event: IntegrationEvent = {
      id: randomUUID(),
      companyId,
      connectionId,
      provider,
      action,
      status,
      requestSummary: this.summarize(params),
      attempts,
      error,
      createdAt: new Date().toISOString(),
    };
    await this.repos.events.save(event);
  }

  /** Never logs raw params verbatim — a `body`/`text`/`description` field
   * could contain sensitive customer content — just a shape summary
   * (which fields were present) plus explicitly-safe identifying fields. */
  private summarize(params: Record<string, unknown>): Record<string, unknown> {
    const safeKeys = ['to', 'leadId', 'campaignId', 'contractId', 'subject'];
    const summary: Record<string, unknown> = { fields: Object.keys(params) };
    for (const key of safeKeys) {
      if (params[key] !== undefined) summary[key] = params[key];
    }
    return summary;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private requireString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`"${field}" is required`);
    return value.trim();
  }

  private async dispatch(
    provider: IntegrationProvider,
    action: string,
    connection: IntegrationConnection,
    credentials: Record<string, string>,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (provider) {
      case 'whatsapp':
        return this.sendWhatsApp(connection, credentials, params);
      case 'email':
        return this.sendEmail(connection, credentials, params);
      case 'meta_ads':
        return this.callMetaAds(connection, credentials, action, params);
      case 'google_calendar':
        return this.createCalendarEvent(connection, credentials, params);
      case 'payment_stripe':
        return this.chargeStripe(credentials, params);
      case 'e_signature':
        return this.sendSignatureEnvelope(connection, credentials, params);
      case 'custom_api':
        return this.callCustomApi(connection, credentials, params);
      default:
        throw new AutomationError(`unsupported provider: ${provider}`);
    }
  }

  // ---- WhatsApp Business (Meta Cloud API) ----
  private async sendWhatsApp(connection: IntegrationConnection, credentials: Record<string, string>, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const to = this.requireString(params.to, 'to');
    const body = this.requireString(params.body, 'body');
    const phoneNumberId = this.requireString(connection.config.phoneNumberId, 'phoneNumberId');
    const token = this.requireString(credentials.access_token, 'access_token');
    const res = await this.fetchImpl(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    });
    if (!res.ok) throw new Error(`WhatsApp API returned ${res.status}`);
    // Real shape: { messages: [{ id: "wamid.xxx" }] } — only trusted when
    // actually present; never fabricated when the response doesn't carry it.
    const responseBody = (await res.json().catch(() => ({}))) as { messages?: { id?: string }[] };
    const providerMessageId = responseBody.messages?.[0]?.id;
    return { status: res.status, ...(providerMessageId ? { providerMessageId } : {}) };
  }

  // ---- Email (SendGrid) ----
  private async sendEmail(connection: IntegrationConnection, credentials: Record<string, string>, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const to = this.requireString(params.to, 'to');
    const subject = this.requireString(params.subject, 'subject');
    const body = this.requireString(params.body, 'body');
    const fromAddress = this.requireString(connection.config.fromAddress, 'fromAddress');
    const apiKey = this.requireString(credentials.api_key, 'api_key');
    const res = await this.fetchImpl('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: fromAddress },
        subject,
        content: [{ type: 'text/plain', value: body }],
      }),
    });
    if (!res.ok) throw new Error(`SendGrid API returned ${res.status}`);
    // SendGrid returns its message id in the X-Message-Id response header,
    // not the (empty, 202) body — only trusted when the header is actually
    // present; never fabricated when it isn't.
    const providerMessageId = res.headers.get('X-Message-Id') ?? undefined;
    return { status: res.status, ...(providerMessageId ? { providerMessageId } : {}) };
  }

  // ---- Meta Ads ----
  private async callMetaAds(connection: IntegrationConnection, credentials: Record<string, string>, action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (action !== 'update_campaign_status') throw new AutomationError(`unsupported meta_ads action: ${action}`);
    const campaignId = this.requireString(params.campaignId, 'campaignId');
    const status = this.requireString(params.status, 'status').toUpperCase();
    const token = this.requireString(credentials.access_token, 'access_token');
    const res = await this.fetchImpl(`https://graph.facebook.com/v20.0/${campaignId}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error(`Meta Ads API returned ${res.status}`);
    return { status: res.status };
  }

  // ---- Google Calendar ----
  private async createCalendarEvent(connection: IntegrationConnection, credentials: Record<string, string>, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const summary = this.requireString(params.summary, 'summary');
    const startTime = this.requireString(params.startTime, 'startTime');
    const endTime = this.requireString(params.endTime, 'endTime');
    const calendarId = this.requireString(connection.config.calendarId, 'calendarId');
    const token = this.requireString(credentials.access_token, 'access_token');
    const res = await this.fetchImpl(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary, start: { dateTime: startTime }, end: { dateTime: endTime } }),
    });
    if (!res.ok) throw new Error(`Google Calendar API returned ${res.status}`);
    return { status: res.status };
  }

  // ---- Stripe ----
  private async chargeStripe(credentials: Record<string, string>, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const amountCents = params.amountCents;
    if (typeof amountCents !== 'number' || amountCents <= 0) throw new ValidationError('"amountCents" must be a positive number');
    const currency = this.requireString(params.currency, 'currency');
    const source = this.requireString(params.source, 'source');
    const secretKey = this.requireString(credentials.secret_key, 'secret_key');
    const body = new URLSearchParams({ amount: String(amountCents), currency, source });
    if (typeof params.description === 'string') body.set('description', params.description);
    const res = await this.fetchImpl('https://api.stripe.com/v1/charges', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`Stripe API returned ${res.status}`);
    return { status: res.status };
  }

  // ---- E-Signature ----
  // Generic envelope-creation request shape (subject, one document
  // referenced by URL, one signer) — not certified against a specific
  // vendor's exact field contract, same honest scope as every other
  // connector here (a thin, real REST wrapper an admin points at their own
  // account, not a vendor-verified integration).
  private async sendSignatureEnvelope(connection: IntegrationConnection, credentials: Record<string, string>, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const to = this.requireString(params.to, 'to');
    const documentUrl = this.requireString(params.documentUrl, 'documentUrl');
    const contractId = this.requireString(params.contractId, 'contractId');
    const accountId = this.requireString(connection.config.accountId, 'accountId');
    const apiKey = this.requireString(credentials.api_key, 'api_key');
    // baseUri is per-account with a real e-signature provider (issued at
    // OAuth time) — config.baseUri lets an admin point at their own,
    // defaulting to the provider's public developer sandbox host.
    const baseUri = typeof connection.config.baseUri === 'string' && connection.config.baseUri ? connection.config.baseUri : 'demo.docusign.net';
    const res = await this.fetchImpl(`https://${baseUri}/restapi/v2.1/accounts/${encodeURIComponent(accountId)}/envelopes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        emailSubject: `Please sign contract ${contractId}`,
        documents: [{ documentUrl }],
        recipients: { signers: [{ email: to, recipientId: '1' }] },
        status: 'sent',
      }),
    });
    if (!res.ok) throw new Error(`e-signature API returned ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { envelopeId?: string };
    return { status: res.status, envelopeId: body.envelopeId };
  }

  // ---- Generic custom API (other approved third-party services) ----
  private async callCustomApi(connection: IntegrationConnection, credentials: Record<string, string>, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = this.requireString(params.path, 'path');
    const method = typeof params.method === 'string' && params.method.trim() ? params.method.trim() : 'POST';
    const baseUrl = this.requireString(connection.config.baseUrl, 'baseUrl');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (credentials.api_key) headers.Authorization = `Bearer ${credentials.api_key}`;
    const res = await this.fetchImpl(`${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`, {
      method,
      headers,
      body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
    });
    if (!res.ok) throw new Error(`custom API returned ${res.status}`);
    return { status: res.status };
  }
}
