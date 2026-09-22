import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { InMemoryRepository } from '../../infra/repository.js';
import { RbacEvaluator } from '../permissions/rbac.evaluator.js';
import { AuditLog } from '../../infra/audit-log.js';
import { TaskService } from '../tasks/task.service.js';
import { CommunicationService } from '../communication/communication.service.js';
import { CrmService } from '../crm/crm.service.js';
import { CrmStageService } from '../crm/crm-stage.service.js';
import { MarketingService } from '../marketing/marketing.service.js';
import { FinanceService } from '../finance/finance.service.js';
import { SalesService } from '../sales/sales.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { PaymentPlansService } from '../payment-plans/payment-plans.service.js';
import { QuotationService } from '../quotations/quotation.service.js';
import { LeadScoringService } from '../ai/lead-scoring.service.js';
import { AutomationService } from '../automation/automation.service.js';
import { IntegrationService } from './integration.service.js';
import { CommunicationDeliveryService } from './communication-delivery.service.js';
import type {
  ApprovalRequest,
  AuditLogEntry,
  Campaign,
  CommunicationDeliveryEvent,
  Contract,
  CrmStage,
  Employee,
  IntegrationConnection,
  IntegrationEvent,
  Lead,
  Message,
  Opportunity,
  Payment,
  PaymentPlanTemplate,
  PaymentScheduleLine,
  PermissionGrant,
  PermissionOverride,
  Project,
  Quotation,
  Receipt,
  Refund,
  Reservation,
  Role,
  Secret,
  Task,
  Unit,
  UnitHold,
  User,
  UserRole,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStepRun,
} from '../../domain/types.js';

function freshHarness(retryBaseDelayMs = 0, rateLimitPerMinute = 30) {
  const users = new InMemoryRepository<User>();
  const employees = new InMemoryRepository<Employee>();
  const roles = new InMemoryRepository<Role>();
  const grants = new InMemoryRepository<PermissionGrant>();
  const userRoles = new InMemoryRepository<UserRole>();
  const overrides = new InMemoryRepository<PermissionOverride>();
  const rbac = new RbacEvaluator({ users, employees, roles, grants, userRoles, overrides });

  const workflows = new InMemoryRepository<WorkflowDefinition>();
  const runs = new InMemoryRepository<WorkflowRun>();
  const stepRuns = new InMemoryRepository<WorkflowStepRun>();
  const approvals = new InMemoryRepository<ApprovalRequest>();
  const secrets = new InMemoryRepository<Secret>();
  const tasksRepo = new InMemoryRepository<Task>();
  const messages = new InMemoryRepository<Message>();
  const leads = new InMemoryRepository<Lead>();
  const campaigns = new InMemoryRepository<Campaign>();
  const auditLogRepo = new InMemoryRepository<AuditLogEntry>();

  const crmStages = new CrmStageService(new InMemoryRepository<CrmStage>());
  const tasks = new TaskService(tasksRepo);
  const communication = new CommunicationService(messages);
  const crm = new CrmService(leads, crmStages);
  const marketing = new MarketingService(campaigns, leads, crmStages);
  const auditLog = new AuditLog(auditLogRepo);

  const opportunities = new InMemoryRepository<Opportunity>();
  const contracts = new InMemoryRepository<Contract>();
  const payments = new InMemoryRepository<Payment>();
  const receipts = new InMemoryRepository<Receipt>();
  const refunds = new InMemoryRepository<Refund>();
  const scheduleLines = new InMemoryRepository<PaymentScheduleLine>();
  const units = new InMemoryRepository<Unit>();
  const holds = new InMemoryRepository<UnitHold>();
  const reservations = new InMemoryRepository<Reservation>();
  const projects = new InMemoryRepository<Project>();
  const templates = new InMemoryRepository<PaymentPlanTemplate>();
  const inventory = new InventoryService(units, holds, reservations, projects);
  const paymentPlans = new PaymentPlansService(templates, scheduleLines);
  const quotations = new QuotationService(new InMemoryRepository<Quotation>(), units, paymentPlans);
  const leadScoring = new LeadScoringService(leads, crmStages);
  const finance = new FinanceService(payments, receipts, scheduleLines, refunds);
  const sales = new SalesService(opportunities, contracts, inventory, paymentPlans);

  const automation = new AutomationService(
    { workflows, runs, stepRuns, approvals, secrets },
    rbac,
    tasks,
    communication,
    crm,
    crmStages,
    marketing,
    finance,
    sales,
    inventory,
    leadScoring,
    quotations,
    paymentPlans,
    auditLog,
    'test-encryption-secret-not-for-production',
  );

  const connections = new InMemoryRepository<IntegrationConnection>();
  const events = new InMemoryRepository<IntegrationEvent>();
  const deliveryEvents = new InMemoryRepository<CommunicationDeliveryEvent>();

  const fetchCalls: { url: string; init?: RequestInit }[] = [];
  let fetchImpl: typeof fetch = (async (url, init) => {
    fetchCalls.push({ url: String(url), init: init as RequestInit | undefined });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const integrations = new IntegrationService(
    { connections, events, deliveryEvents },
    automation,
    auditLog,
    ((url: Parameters<typeof fetch>[0], init?: RequestInit) => fetchImpl(url, init)) as typeof fetch,
    retryBaseDelayMs,
    rateLimitPerMinute,
  );

  const communicationDelivery = new CommunicationDeliveryService(deliveryEvents, integrations, automation);

  return {
    integrations,
    automation,
    connections,
    deliveryEvents,
    communicationDelivery,
    auditLogRepo,
    fetchCalls,
    setFetchImpl: (impl: typeof fetch) => {
      fetchImpl = impl;
    },
  };
}

test('listConnectors returns metadata for all 7 providers', () => {
  const h = freshHarness();
  const connectors = h.integrations.listConnectors();
  const providers = connectors.map((c) => c.provider).sort();
  assert.deepEqual(providers, ['custom_api', 'e_signature', 'email', 'google_calendar', 'meta_ads', 'payment_stripe', 'whatsapp']);
});

test('connect rejects a request missing a required credential field', async () => {
  const h = freshHarness();
  await assert.rejects(() =>
    h.integrations.connect({ companyId: 'c1', provider: 'whatsapp', displayName: 'My WhatsApp', config: { phoneNumberId: '123' }, credentials: {}, createdByUserId: 'u1' }),
  );
});

test('connect rejects a request missing a required config field', async () => {
  const h = freshHarness();
  await assert.rejects(() =>
    h.integrations.connect({ companyId: 'c1', provider: 'whatsapp', displayName: 'My WhatsApp', config: {}, credentials: { access_token: 'tok' }, createdByUserId: 'u1' }),
  );
});

test('connect stores credentials encrypted, never in plaintext on the connection record', async () => {
  const h = freshHarness();
  const connection = await h.integrations.connect({
    companyId: 'c1', provider: 'whatsapp', displayName: 'My WhatsApp', config: { phoneNumberId: '123' },
    credentials: { access_token: 'super-secret-token' }, createdByUserId: 'u1',
  });
  assert.equal(connection.status, 'connected');
  assert.equal(JSON.stringify(connection).includes('super-secret-token'), false);
  assert.equal(connection.credentialKeys.length, 1);
});

test('send dispatches a real-shaped WhatsApp API call using the stored credentials', async () => {
  const h = freshHarness();
  const connection = await h.integrations.connect({
    companyId: 'c1', provider: 'whatsapp', displayName: 'My WhatsApp', config: { phoneNumberId: 'phone-123' },
    credentials: { access_token: 'tok-abc' }, createdByUserId: 'u1',
  });
  const result = await h.integrations.send('c1', 'whatsapp', 'send_message', { to: '+15551234', body: 'Hello' }, 'u1');
  assert.equal((result as { status: number }).status, 200);
  assert.equal(h.fetchCalls.length, 1);
  assert.match(h.fetchCalls[0]!.url, /graph\.facebook\.com\/v20\.0\/phone-123\/messages/);
  const headers = h.fetchCalls[0]!.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer tok-abc');

  const events = await h.integrations.listEvents('c1');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.status, 'success');
  void connection;
});

test('send retries on failure and eventually succeeds', async () => {
  const h = freshHarness(10);
  await h.integrations.connect({
    companyId: 'c1', provider: 'email', displayName: 'My Email', config: { fromAddress: 'noreply@x.com' },
    credentials: { api_key: 'key-1' }, createdByUserId: 'u1',
  });
  let attempts = 0;
  h.setFetchImpl((async () => {
    attempts++;
    if (attempts < 2) return new Response('down', { status: 500 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch);

  const result = await h.integrations.send('c1', 'email', 'send_message', { to: 'a@b.com', subject: 'Hi', body: 'Hello' }, 'u1');
  assert.equal((result as { status: number }).status, 200);
  assert.equal(attempts, 2);
});

test('send fails after exhausting retries and records a failed IntegrationEvent + audit log entry', async () => {
  const h = freshHarness();
  const connection = await h.integrations.connect({
    companyId: 'c1', provider: 'email', displayName: 'My Email', config: { fromAddress: 'noreply@x.com' },
    credentials: { api_key: 'key-1' }, createdByUserId: 'u1',
  });
  h.setFetchImpl((async () => new Response('down', { status: 500 })) as typeof fetch);

  await assert.rejects(() => h.integrations.send('c1', 'email', 'send_message', { to: 'a@b.com', subject: 'Hi', body: 'Hello' }, 'u1'));

  const events = await h.integrations.listEvents('c1');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.status, 'failed');

  const updatedConnection = await h.integrations.getConnection(connection.id, 'c1');
  assert.equal(updatedConnection.status, 'error');
  assert.ok(updatedConnection.lastError);

  const auditEntries = await h.auditLogRepo.findAll((e) => e.resourceId === connection.id && (e.metadata as Record<string, unknown> | undefined)?.failed === true);
  assert.equal(auditEntries.length, 1);
});

test('send is rate-limited per (company, provider)', async () => {
  const h = freshHarness(0, 2);
  await h.integrations.connect({
    companyId: 'c1', provider: 'whatsapp', displayName: 'My WhatsApp', config: { phoneNumberId: '123' },
    credentials: { access_token: 'tok' }, createdByUserId: 'u1',
  });
  await h.integrations.send('c1', 'whatsapp', 'send_message', { to: '+1', body: 'a' }, 'u1');
  await h.integrations.send('c1', 'whatsapp', 'send_message', { to: '+1', body: 'b' }, 'u1');
  await assert.rejects(() => h.integrations.send('c1', 'whatsapp', 'send_message', { to: '+1', body: 'c' }, 'u1'), /rate limit/i);
});

test('send throws when no connection exists for the provider', async () => {
  const h = freshHarness();
  await assert.rejects(() => h.integrations.send('c1', 'whatsapp', 'send_message', { to: '+1', body: 'a' }, 'u1'));
});

test('disconnect marks the connection disconnected and removes its stored credentials', async () => {
  const h = freshHarness();
  const connection = await h.integrations.connect({
    companyId: 'c1', provider: 'whatsapp', displayName: 'My WhatsApp', config: { phoneNumberId: '123' },
    credentials: { access_token: 'tok' }, createdByUserId: 'u1',
  });
  const disconnected = await h.integrations.disconnect(connection.id, 'c1');
  assert.equal(disconnected.status, 'disconnected');
  await assert.rejects(() => h.integrations.send('c1', 'whatsapp', 'send_message', { to: '+1', body: 'a' }, 'u1'));
});

test('getConnection rejects a connection belonging to a different company (cross-tenant)', async () => {
  const h = freshHarness();
  const connection = await h.integrations.connect({
    companyId: 'c1', provider: 'whatsapp', displayName: 'My WhatsApp', config: { phoneNumberId: '123' },
    credentials: { access_token: 'tok' }, createdByUserId: 'u1',
  });
  await assert.rejects(() => h.integrations.getConnection(connection.id, 'c2'));
});

test('stripe charge is sent as form-encoded per the real Stripe API shape', async () => {
  const h = freshHarness();
  await h.integrations.connect({
    companyId: 'c1', provider: 'payment_stripe', displayName: 'My Stripe', config: {},
    credentials: { secret_key: 'sk_test_123' }, createdByUserId: 'u1',
  });
  await h.integrations.send('c1', 'payment_stripe', 'charge', { amountCents: 5000, currency: 'usd', source: 'tok_visa' }, 'u1');
  const call = h.fetchCalls[0]!;
  assert.match(call.url, /api\.stripe\.com\/v1\/charges/);
  assert.equal((call.init?.headers as Record<string, string>)['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(call.init?.body, 'amount=5000&currency=usd&source=tok_visa');
});

test('custom_api connector builds the URL from baseUrl + path and forwards the api_key credential', async () => {
  const h = freshHarness();
  await h.integrations.connect({
    companyId: 'c1', provider: 'custom_api', displayName: 'Some Service', config: { baseUrl: 'https://api.example.com' },
    credentials: { api_key: 'key-xyz' }, createdByUserId: 'u1',
  });
  await h.integrations.send('c1', 'custom_api', 'call', { path: '/v1/things', method: 'POST', body: { hello: 'world' } }, 'u1');
  const call = h.fetchCalls[0]!;
  assert.equal(call.url, 'https://api.example.com/v1/things');
  assert.equal((call.init?.headers as Record<string, string>).Authorization, 'Bearer key-xyz');
});

test('e_signature connector sends a DocuSign-shaped envelope request and returns the envelope id', async () => {
  const h = freshHarness();
  await h.integrations.connect({
    companyId: 'c1', provider: 'e_signature', displayName: 'My E-Signature', config: { accountId: 'acct-1' },
    credentials: { api_key: 'key-sig', webhook_secret: 'whsec-1' }, createdByUserId: 'u1',
  });
  h.setFetchImpl((async (url, init) => {
    h.fetchCalls.push({ url: String(url), init: init as RequestInit | undefined });
    return new Response(JSON.stringify({ envelopeId: 'env-123' }), { status: 201 });
  }) as typeof fetch);
  const result = await h.integrations.send('c1', 'e_signature', 'send_envelope', { to: 'buyer@example.com', documentUrl: 'https://docs.example.com/c1.pdf', contractId: 'contract-1' }, 'u1');
  assert.equal((result as { envelopeId: string }).envelopeId, 'env-123');
  const call = h.fetchCalls[0]!;
  assert.match(call.url, /demo\.docusign\.net\/restapi\/v2\.1\/accounts\/acct-1\/envelopes/);
  assert.equal((call.init?.headers as Record<string, string>).Authorization, 'Bearer key-sig');
  const body = JSON.parse(call.init?.body as string);
  assert.equal(body.recipients.signers[0].email, 'buyer@example.com');
});

test('the delivery log never records raw message content, only a safe field summary', async () => {
  const h = freshHarness();
  await h.integrations.connect({
    companyId: 'c1', provider: 'whatsapp', displayName: 'My WhatsApp', config: { phoneNumberId: '123' },
    credentials: { access_token: 'tok' }, createdByUserId: 'u1',
  });
  await h.integrations.send('c1', 'whatsapp', 'send_message', { to: '+15551234', body: 'a very private message' }, 'u1');
  const events = await h.integrations.listEvents('c1');
  assert.equal(JSON.stringify(events).includes('a very private message'), false);
});

// ---- Real communication delivery tracking: "API call succeeded" is never
// treated as "message delivered" — see CommunicationDeliveryService. ----

test('a successful WhatsApp send records an initial CommunicationDeliveryEvent with status "sent", using the real provider message id', async () => {
  const h = freshHarness();
  await h.integrations.connect({
    companyId: 'c1', provider: 'whatsapp', displayName: 'My WhatsApp', config: { phoneNumberId: '123' },
    credentials: { access_token: 'tok' }, createdByUserId: 'u1',
  });
  h.setFetchImpl((async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.ABC123' }] }), { status: 200 })) as typeof fetch);

  await h.integrations.send('c1', 'whatsapp', 'send_message', { to: '+15551234', body: 'hi', leadId: 'lead-1' }, 'u1');

  const timeline = await h.integrations.getDeliveryTimeline('c1', 'wamid.ABC123');
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0]!.status, 'sent');
  assert.equal(timeline[0]!.relatedResourceId, 'lead-1');
});

test('a WhatsApp send with no message id in the response records no delivery event — never fabricated', async () => {
  const h = freshHarness();
  await h.integrations.connect({
    companyId: 'c1', provider: 'whatsapp', displayName: 'My WhatsApp', config: { phoneNumberId: '123' },
    credentials: { access_token: 'tok' }, createdByUserId: 'u1',
  });
  h.setFetchImpl((async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch);

  await h.integrations.send('c1', 'whatsapp', 'send_message', { to: '+15551234', body: 'hi' }, 'u1');

  const timeline = await h.integrations.getDeliveryTimeline('c1', 'nonexistent');
  assert.equal(timeline.length, 0);
  const status = await h.integrations.getLatestDeliveryStatusForResource('c1', 'lead-1');
  assert.equal(status, undefined);
});

test('a verified delivery webhook appends a real "delivered" transition to the message timeline', async () => {
  const h = freshHarness();
  const connection = await h.integrations.connect({
    companyId: 'c1', provider: 'whatsapp', displayName: 'My WhatsApp', config: { phoneNumberId: '123' },
    credentials: { access_token: 'tok', webhook_secret: 'whsec-comm-1' }, createdByUserId: 'u1',
  });
  h.setFetchImpl((async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.XYZ' }] }), { status: 200 })) as typeof fetch);
  await h.integrations.send('c1', 'whatsapp', 'send_message', { to: '+15551234', body: 'hi', leadId: 'lead-9' }, 'u1');

  const body = JSON.stringify({ providerMessageId: 'wamid.XYZ', status: 'delivered' });
  const signature = createHmac('sha256', 'whsec-comm-1').update(body).digest('hex');
  const event = await h.communicationDelivery.handleWebhook('c1', connection.id, body, signature);
  assert.equal(event.status, 'delivered');
  assert.equal(event.relatedResourceId, 'lead-9'); // carried forward from the originating 'sent' event

  const timeline = await h.integrations.getDeliveryTimeline('c1', 'wamid.XYZ');
  assert.deepEqual(timeline.map((e) => e.status), ['sent', 'delivered']);
});

test('a delivery webhook with an invalid signature is rejected and never appends anything', async () => {
  const h = freshHarness();
  const connection = await h.integrations.connect({
    companyId: 'c1', provider: 'whatsapp', displayName: 'My WhatsApp', config: { phoneNumberId: '123' },
    credentials: { access_token: 'tok', webhook_secret: 'whsec-real' }, createdByUserId: 'u1',
  });
  const body = JSON.stringify({ providerMessageId: 'wamid.X', status: 'delivered' });
  const forgedSignature = createHmac('sha256', 'wrong-secret').update(body).digest('hex');
  await assert.rejects(() => h.communicationDelivery.handleWebhook('c1', connection.id, body, forgedSignature));
});

test('a delivery webhook for a connection with no webhook_secret configured is rejected', async () => {
  const h = freshHarness();
  const connection = await h.integrations.connect({
    companyId: 'c1', provider: 'whatsapp', displayName: 'My WhatsApp', config: { phoneNumberId: '123' },
    credentials: { access_token: 'tok' }, createdByUserId: 'u1', // no webhook_secret
  });
  const body = JSON.stringify({ providerMessageId: 'wamid.X', status: 'delivered' });
  const signature = createHmac('sha256', 'anything').update(body).digest('hex');
  await assert.rejects(() => h.communicationDelivery.handleWebhook('c1', connection.id, body, signature));
});

test('a delivery webhook for a connection belonging to a different company is rejected (cross-tenant)', async () => {
  const h = freshHarness();
  const connection = await h.integrations.connect({
    companyId: 'c1', provider: 'whatsapp', displayName: 'My WhatsApp', config: { phoneNumberId: '123' },
    credentials: { access_token: 'tok', webhook_secret: 'whsec-1' }, createdByUserId: 'u1',
  });
  const body = JSON.stringify({ providerMessageId: 'wamid.X', status: 'delivered' });
  const signature = createHmac('sha256', 'whsec-1').update(body).digest('hex');
  await assert.rejects(() => h.communicationDelivery.handleWebhook('c2', connection.id, body, signature));
});
