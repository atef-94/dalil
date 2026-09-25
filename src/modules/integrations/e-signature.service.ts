import { randomUUID } from 'node:crypto';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Contract, SignatureEnvelope } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError, ValidationError, ForbiddenError } from '../../infra/errors.js';
import type { IntegrationService } from './integration.service.js';
import type { AutomationService } from '../automation/automation.service.js';

export interface SendForSignatureInput {
  companyId: string;
  contractId: string;
  signerEmail: string;
  /** Wherever the contract document itself already lives (a generated
   * print/export link, a DMS URL) — this service sends customers TO
   * sign a document, it doesn't generate one. */
  documentUrl: string;
  requestedByUserId: string;
}

export interface SignatureWebhookPayload {
  status: 'signed' | 'declined';
}

/**
 * The customer-facing side of contract sign-off: tracks whether a customer
 * actually digitally signed a contract, independent of Contract.status
 * (which stays exactly what SalesService.signContract always meant — the
 * commercial terms are locked in). Reuses IntegrationService's existing
 * connector/credential/retry/logging pipeline for the outbound send, the
 * same way every other provider does — this adds no second HTTP client,
 * only the envelope bookkeeping and the webhook-verification step that
 * makes a "the customer signed it" callback trustworthy rather than an
 * unverified POST from anyone who finds the URL.
 */
export class SignatureService {
  constructor(
    private readonly envelopes: Repository<SignatureEnvelope>,
    private readonly contracts: Repository<Contract>,
    private readonly integrations: IntegrationService,
    private readonly automation: AutomationService,
  ) {}

  async sendForSignature(input: SendForSignatureInput): Promise<SignatureEnvelope> {
    if (!input.signerEmail?.trim()) throw new ValidationError('signerEmail is required');
    if (!input.documentUrl?.trim()) throw new ValidationError('documentUrl is required');

    const contract = await this.contracts.findById(input.contractId);
    if (!contract || contract.companyId !== input.companyId) throw new NotFoundError('contract not found');

    const connections = await this.integrations.listConnections(input.companyId);
    const connection = connections.find((c) => c.provider === 'e_signature' && c.status !== 'disconnected');
    if (!connection) throw new NotFoundError('no connected e_signature integration for this company');

    const result = await this.integrations.send(input.companyId, 'e_signature', 'send_envelope', {
      contractId: input.contractId,
      to: input.signerEmail.trim(),
      documentUrl: input.documentUrl.trim(),
    }, input.requestedByUserId);

    const externalEnvelopeId = typeof result.envelopeId === 'string' ? result.envelopeId : randomUUID();

    const envelope: SignatureEnvelope = {
      id: randomUUID(),
      companyId: input.companyId,
      contractId: input.contractId,
      connectionId: connection.id,
      provider: 'e_signature',
      externalEnvelopeId,
      signerEmail: input.signerEmail.trim(),
      status: 'sent',
      requestedByUserId: input.requestedByUserId,
      sentAt: new Date().toISOString(),
    };
    return this.envelopes.save(envelope);
  }

  async listForContract(contractId: string, companyId: string): Promise<SignatureEnvelope[]> {
    return this.envelopes.findAll((e) => e.companyId === companyId && e.contractId === contractId);
  }

  async getEnvelope(id: string, companyId: string): Promise<SignatureEnvelope | undefined> {
    const envelope = await this.envelopes.findById(id);
    return envelope && envelope.companyId === companyId ? envelope : undefined;
  }

  /**
   * Verifies an inbound callback with the connection's own webhook secret
   * (HMAC-SHA256 over the exact raw body, timing-safe compared) before
   * touching any state — an unverified or mis-signed request never changes
   * an envelope, exactly the "webhook forgery" control the research called
   * for. Only a 'sent' envelope can transition; a second callback for an
   * already-decided envelope is a no-op, not an error, so provider retries
   * stay safe.
   */
  async handleWebhook(envelopeId: string, companyId: string, rawBody: string, signatureHeader: string | undefined): Promise<SignatureEnvelope> {
    const envelope = await this.getEnvelope(envelopeId, companyId);
    if (!envelope) throw new NotFoundError('signature envelope not found');

    const secretKey = `integration:${envelope.connectionId}:webhook_secret`;
    const secret = await this.automation.getDecryptedSecret(companyId, secretKey);
    if (!secret) throw new ValidationError('no webhook secret configured for this e-signature connection');
    if (!signatureHeader) throw new ForbiddenError('missing webhook signature');

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ForbiddenError('invalid webhook signature');
    }

    if (envelope.status !== 'sent') return envelope; // already decided — idempotent no-op on a retried callback

    let payload: SignatureWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as SignatureWebhookPayload;
    } catch {
      throw new ValidationError('webhook body must be valid JSON');
    }
    if (payload.status !== 'signed' && payload.status !== 'declined') {
      throw new ValidationError('webhook "status" must be "signed" or "declined"');
    }

    return this.envelopes.save({ ...envelope, status: payload.status, decidedAt: new Date().toISOString() });
  }
}
