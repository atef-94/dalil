import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { InMemoryRepository } from '../../infra/repository.js';
import { RbacEvaluator } from '../permissions/rbac.evaluator.js';
import { AuditLog } from '../../infra/audit-log.js';
import { EventBus, type DomainEvent } from '../../infra/event-bus.js';
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
import { FacebookLeadsService } from './facebook-leads.service.js';
import type {
  ActionName, ApprovalRequest, AuditLogEntry, Campaign, CommunicationDeliveryEvent, Contract, CrmStage, Employee,
  FacebookLeadEvent, IntegrationConnection, IntegrationEvent, Lead, Message, Opportunity, Payment,
  PaymentPlanTemplate, PaymentScheduleLine, PermissionGrant, PermissionOverride, Project, Quotation,
  Receipt, Refund, Reservation, ResourceName, Role, Secret, Task, Unit, UnitHold, User, UserRole,
  WorkflowDefinition, WorkflowRun, WorkflowStepRun,
} from '../../domain/types.js';

const APP_SECRET = 'test-facebook-app-secret';
const VERIFY_TOKEN = 'test-verify-token';

function sign(rawBody: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')}`;
}

// `null` (not the default-triggering `undefined`) means "explicitly unset" —
// JS default parameters kick in for an explicitly-passed `undefined` too,
// so a plain `string | undefined` parameter couldn't distinguish "use the
// default" from "test the unconfigured case".
function freshHarness(appSecret: string | null = APP_SECRET, verifyToken: string | null = VERIFY_TOKEN) {
  const resolvedAppSecret = appSecret === null ? undefined : appSecret;
  const resolvedVerifyToken = verifyToken === null ? undefined : verifyToken;
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
  const quotations = new QuotationService(new InMemoryRepository<Quotation>(), units, new InMemoryRepository<Project>(), paymentPlans);
  const leadScoring = new LeadScoringService(leads, crmStages);
  const finance = new FinanceService(payments, receipts, scheduleLines, refunds);
  const sales = new SalesService(opportunities, contracts, inventory, paymentPlans);

  const automation = new AutomationService(
    { workflows, runs, stepRuns, approvals, secrets },
    rbac, tasks, communication, crm, crmStages, marketing, finance, sales,
    inventory, leadScoring, quotations, paymentPlans, auditLog,
    'test-encryption-secret-not-for-production',
  );

  const eventBus = new EventBus();
  eventBus.subscribe(async (event) => {
    await automation.handleEvent(event);
  });
  const emitEvent = (event: DomainEvent) => eventBus.emit(event);

  const connections = new InMemoryRepository<IntegrationConnection>();
  const events = new InMemoryRepository<IntegrationEvent>();
  const deliveryEvents = new InMemoryRepository<CommunicationDeliveryEvent>();
  let fetchImpl: typeof fetch = (async () => new Response(JSON.stringify({ field_data: [] }), { status: 200 })) as typeof fetch;
  const integrations = new IntegrationService(
    { connections, events, deliveryEvents }, automation, auditLog,
    ((url, init) => fetchImpl(url, init)) as typeof fetch, 0, 30,
  );

  const facebookLeadEvents = new InMemoryRepository<FacebookLeadEvent>();
  const facebookLeads = new FacebookLeadsService(
    { connections, events: facebookLeadEvents },
    integrations,
    crm,
    auditLog,
    emitEvent,
    resolvedAppSecret,
    resolvedVerifyToken,
  );

  return {
    facebookLeads, integrations, automation, crm, crmStages, leads, connections, facebookLeadEvents,
    workflows, runs, tasksRepo, auditLogRepo, users, roles, grants, userRoles,
    setFetchImpl: (impl: typeof fetch) => { fetchImpl = impl; },
  };
}

/** Grants a user company-wide permission for the given action/resource
 * pairs — mirrors automation.test.ts's seedUserWithGrants exactly. A
 * workflow executes its steps as its own createdByUserId, so a test that
 * wants a workflow step (e.g. create_task) to actually succeed needs this,
 * not just a connected Facebook Page. */
async function seedUserWithGrants(
  h: ReturnType<typeof freshHarness>,
  companyId: string,
  userId: string,
  grantList: { action: ActionName; resource: ResourceName }[],
) {
  await h.users.save({
    id: userId, companyId, email: `${userId}@c.com`, passwordHash: 'x', userType: 'employee_user',
    locale: 'en', failedLoginCount: 0, createdAt: new Date().toISOString(), totpEnabled: false,
  });
  const role: Role = { id: `role-${userId}`, companyId, name: 'Test Role', isSystem: false };
  await h.roles.save(role);
  await h.userRoles.save({ id: `ur-${userId}`, userId, roleId: role.id });
  for (const g of grantList) {
    await h.grants.save({ id: `grant-${userId}-${g.action}-${g.resource}`, roleId: role.id, action: g.action, resource: g.resource, scope: 'company', sensitivity: 'standard' });
  }
}

async function connectPage(
  h: ReturnType<typeof freshHarness>,
  companyId: string,
  pageId: string,
  token = 'page-token-abc',
) {
  await h.crmStages.seedDefaultStages(companyId);
  return h.integrations.connect({
    companyId, provider: 'facebook_leads', displayName: 'My Page',
    config: { pageId }, credentials: { page_access_token: token }, createdByUserId: 'u1',
  });
}

function fieldDataResponse(fields: Record<string, string>) {
  return new Response(
    JSON.stringify({ field_data: Object.entries(fields).map(([name, v]) => ({ name, values: [v] })) }),
    { status: 200 },
  );
}

// ---- Signature verification ----

test('verifySignature rejects when the app secret is not configured', () => {
  const h = freshHarness(null, VERIFY_TOKEN);
  assert.throws(() => h.facebookLeads.verifySignature('{}', sign('{}')), /not configured/i);
});

test('verifySignature rejects a missing signature header', () => {
  const h = freshHarness();
  assert.throws(() => h.facebookLeads.verifySignature('{}', undefined), /missing or malformed/i);
});

test('verifySignature rejects a malformed signature header (no sha256= prefix)', () => {
  const h = freshHarness();
  assert.throws(() => h.facebookLeads.verifySignature('{}', 'deadbeef'), /missing or malformed/i);
});

test('verifySignature rejects a wrong signature', () => {
  const h = freshHarness();
  assert.throws(() => h.facebookLeads.verifySignature('{"a":1}', 'sha256=' + '0'.repeat(64)), /invalid webhook signature/i);
});

test('verifySignature accepts a correctly HMAC-signed raw body', () => {
  const h = freshHarness();
  const rawBody = JSON.stringify({ entry: [] });
  assert.doesNotThrow(() => h.facebookLeads.verifySignature(rawBody, sign(rawBody)));
});

test('verifySignature is computed over the exact raw bytes, not a re-serialization', () => {
  const h = freshHarness();
  // Two JSON strings that parse to the "same" object but are byte-different
  // (key order) must produce different signatures — proving this really
  // verifies raw bytes, not a normalized/re-stringified form.
  const rawA = '{"a":1,"b":2}';
  const rawB = '{"b":2,"a":1}';
  const sigForA = sign(rawA);
  assert.doesNotThrow(() => h.facebookLeads.verifySignature(rawA, sigForA));
  assert.throws(() => h.facebookLeads.verifySignature(rawB, sigForA), /invalid webhook signature/i);
});

// ---- GET challenge verification ----

test('verifyChallenge rejects when the verify token is not configured', () => {
  const h = freshHarness(APP_SECRET, null);
  assert.throws(() => h.facebookLeads.verifyChallenge('subscribe', 'anything', 'chal'), /webhook verification failed/i);
});

test('verifyChallenge rejects a wrong mode or token', () => {
  const h = freshHarness();
  assert.throws(() => h.facebookLeads.verifyChallenge('unsubscribe', VERIFY_TOKEN, 'chal'), /webhook verification failed/i);
  assert.throws(() => h.facebookLeads.verifyChallenge('subscribe', 'wrong-token', 'chal'), /webhook verification failed/i);
});

test('verifyChallenge returns the challenge verbatim on a correct request', () => {
  const h = freshHarness();
  const result = h.facebookLeads.verifyChallenge('subscribe', VERIFY_TOKEN, '123456789');
  assert.equal(result, '123456789');
});

// ---- Payload parsing ----

test('extractLeadgenChanges parses a real Meta leadgen payload shape', () => {
  const h = freshHarness();
  const payload = {
    object: 'page',
    entry: [
      {
        id: 'page-1',
        time: 123,
        changes: [{ field: 'leadgen', value: { leadgen_id: 'lead-1', form_id: 'form-1', page_id: 'page-1', created_time: 1 } }],
      },
    ],
  };
  const changes = h.facebookLeads.extractLeadgenChanges(payload);
  assert.deepEqual(changes, [{ pageId: 'page-1', leadgenId: 'lead-1', formId: 'form-1' }]);
});

test('extractLeadgenChanges ignores non-leadgen changes and malformed entries', () => {
  const h = freshHarness();
  const payload = {
    object: 'page',
    entry: [
      { id: 'page-1', changes: [{ field: 'feed', value: {} }] },
      { id: 'page-2', changes: [{ field: 'leadgen', value: { leadgen_id: 'lead-2' } }] },
      'not-an-object',
    ],
  };
  const changes = h.facebookLeads.extractLeadgenChanges(payload);
  assert.deepEqual(changes, [{ pageId: 'page-2', leadgenId: 'lead-2', formId: undefined }]);
});

test('extractLeadgenChanges returns an empty array for empty/malformed payloads', () => {
  const h = freshHarness();
  assert.deepEqual(h.facebookLeads.extractLeadgenChanges(undefined), []);
  assert.deepEqual(h.facebookLeads.extractLeadgenChanges(null), []);
  assert.deepEqual(h.facebookLeads.extractLeadgenChanges({}), []);
  assert.deepEqual(h.facebookLeads.extractLeadgenChanges({ entry: 'not-an-array' }), []);
});

// ---- handleLeadgenChange: core flow ----

test('handleLeadgenChange for an unknown page creates nothing and reports unknown_page', async () => {
  const h = freshHarness();
  const result = await h.facebookLeads.handleLeadgenChange({ pageId: 'no-such-page', leadgenId: 'lead-x' });
  assert.deepEqual(result, { outcome: 'unknown_page' });
  assert.equal((await h.leads.findAll(() => true)).length, 0);
});

test('handleLeadgenChange creates a real lead via CrmService.createLead, with source "facebook"', async () => {
  const h = freshHarness();
  await connectPage(h, 'c1', 'page-1');
  h.setFetchImpl(async () => fieldDataResponse({ full_name: 'Amir Hassan', phone_number: '01012345678', email: 'amir@example.com' }));

  const result = await h.facebookLeads.handleLeadgenChange({ pageId: 'page-1', leadgenId: 'lead-1', formId: 'form-1' });
  assert.equal(result.outcome, 'created');
  assert.ok(result.outcome === 'created' && result.leadId);

  const lead = await h.crm.getLead(result.outcome === 'created' ? result.leadId : '');
  assert.ok(lead);
  assert.equal(lead!.fullName, 'Amir Hassan');
  assert.equal(lead!.source, 'facebook');
  assert.equal(lead!.email, 'amir@example.com');
});

test('handleLeadgenChange falls back to first_name + last_name when full_name is absent', async () => {
  const h = freshHarness();
  await connectPage(h, 'c1', 'page-1');
  h.setFetchImpl(async () => fieldDataResponse({ first_name: 'Sara', last_name: 'Ali', phone_number: '01099998888' }));
  const result = await h.facebookLeads.handleLeadgenChange({ pageId: 'page-1', leadgenId: 'lead-2' });
  assert.equal(result.outcome, 'created');
  const lead = await h.crm.getLead(result.outcome === 'created' ? result.leadId : '');
  assert.ok(lead);
  assert.equal(lead!.fullName, 'Sara Ali');
});

test('a created lead triggers the lead.created event, audit logging, and an active automation workflow', async () => {
  const h = freshHarness();
  await connectPage(h, 'c1', 'page-1');
  await seedUserWithGrants(h, 'c1', 'u1', [{ action: 'create', resource: 'task' }]);
  h.setFetchImpl(async () => fieldDataResponse({ full_name: 'Nour Said', phone_number: '01055554444' }));
  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Welcome task for Facebook leads',
    createdByUserId: 'u1',
    trigger: { type: 'event', eventType: 'lead.created' },
    steps: [{ name: 'Create task', action: { type: 'create_task', params: { title: 'Follow up with {{fullName}}' } } }],
  });

  const result = await h.facebookLeads.handleLeadgenChange({ pageId: 'page-1', leadgenId: 'lead-3' });
  assert.equal(result.outcome, 'created');

  const runs = await h.runs.findAll((r) => r.companyId === 'c1');
  assert.equal(runs.length, 1, 'the lead.created workflow must have actually run');
  assert.equal(runs[0]!.status, 'completed');

  const auditEntries = await h.auditLogRepo.findAll((e) => e.companyId === 'c1' && e.resource === 'lead' && e.action === 'create');
  assert.equal(auditEntries.length, 1);
  assert.equal(auditEntries[0]!.metadata?.source, 'facebook');
});

test('a lead missing a required field (no usable phone) is skipped, not created, and never retried as an error', async () => {
  const h = freshHarness();
  await connectPage(h, 'c1', 'page-1');
  h.setFetchImpl(async () => fieldDataResponse({ full_name: 'No Phone Person' }));
  const result = await h.facebookLeads.handleLeadgenChange({ pageId: 'page-1', leadgenId: 'lead-4' });
  assert.deepEqual(result, { outcome: 'skipped_invalid_data', companyId: 'c1' });
  assert.equal((await h.leads.findAll(() => true)).length, 0);
  const ledger = await h.facebookLeadEvents.findAll((e) => e.leadgenId === 'lead-4');
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]!.status, 'skipped_invalid_data');
});

// ---- Idempotency ----

test('the same leadgen_id delivered twice sequentially creates exactly one lead', async () => {
  const h = freshHarness();
  await connectPage(h, 'c1', 'page-1');
  h.setFetchImpl(async () => fieldDataResponse({ full_name: 'Repeat Person', phone_number: '01022223333' }));

  const first = await h.facebookLeads.handleLeadgenChange({ pageId: 'page-1', leadgenId: 'lead-dup' });
  const second = await h.facebookLeads.handleLeadgenChange({ pageId: 'page-1', leadgenId: 'lead-dup' });

  assert.equal(first.outcome, 'created');
  assert.equal(second.outcome, 'already_processed');
  assert.equal(second.outcome === 'already_processed' && second.leadId, first.outcome === 'created' ? first.leadId : undefined);
  assert.equal((await h.leads.findAll((l) => l.companyId === 'c1')).length, 1);
});

test('two concurrent deliveries of the same leadgen_id still create exactly one lead', async () => {
  const h = freshHarness();
  await connectPage(h, 'c1', 'page-1');
  h.setFetchImpl(async () => fieldDataResponse({ full_name: 'Concurrent Person', phone_number: '01033334444' }));

  const [a, b] = await Promise.all([
    h.facebookLeads.handleLeadgenChange({ pageId: 'page-1', leadgenId: 'lead-concurrent' }),
    h.facebookLeads.handleLeadgenChange({ pageId: 'page-1', leadgenId: 'lead-concurrent' }),
  ]);

  const outcomes = [a.outcome, b.outcome].sort();
  assert.deepEqual(outcomes, ['already_processed', 'created']);
  assert.equal((await h.leads.findAll((l) => l.companyId === 'c1')).length, 1, 'exactly one lead must exist despite the race');
});

// ---- Phone-duplicate handling (separate from leadgen_id idempotency) ----

test('a phone number that collides with an existing lead is recorded as duplicate_phone, not retried, and creates no second lead', async () => {
  const h = freshHarness();
  await connectPage(h, 'c1', 'page-1');
  await h.crm.createLead({ companyId: 'c1', fullName: 'Already Here', phone: '01066667777' });

  h.setFetchImpl(async () => fieldDataResponse({ full_name: 'Facebook Copy', phone_number: '01066667777' }));
  const result = await h.facebookLeads.handleLeadgenChange({ pageId: 'page-1', leadgenId: 'lead-phone-dup' });

  assert.deepEqual(result, { outcome: 'duplicate_phone', companyId: 'c1' });
  assert.equal((await h.leads.findAll((l) => l.companyId === 'c1')).length, 1, 'no second lead must be created');
  const ledger = await h.facebookLeadEvents.findAll((e) => e.leadgenId === 'lead-phone-dup');
  assert.equal(ledger[0]!.status, 'duplicate_phone');
});

// ---- Cross-company isolation ----

test('a leadgen change for one company\'s Page can never create a lead in a different company', async () => {
  const h = freshHarness();
  await connectPage(h, 'company-a', 'page-a');
  await connectPage(h, 'company-b', 'page-b');
  h.setFetchImpl(async () => fieldDataResponse({ full_name: 'Tenant A Lead', phone_number: '01011112222' }));

  const result = await h.facebookLeads.handleLeadgenChange({ pageId: 'page-a', leadgenId: 'lead-tenant-a' });
  assert.equal(result.outcome, 'created');
  assert.equal(result.outcome === 'created' && result.companyId, 'company-a');

  const companyBLeads = await h.leads.findAll((l) => l.companyId === 'company-b');
  assert.equal(companyBLeads.length, 0, 'company B must never receive a lead from company A\'s Page');
  const companyALeads = await h.leads.findAll((l) => l.companyId === 'company-a');
  assert.equal(companyALeads.length, 1);
});

test('a disconnected connection\'s Page is treated as unknown — never resurrected into the wrong/stale company', async () => {
  const h = freshHarness();
  const connection = await connectPage(h, 'c1', 'page-1');
  await h.integrations.disconnect(connection.id, 'c1');
  h.setFetchImpl(async () => fieldDataResponse({ full_name: 'Too Late', phone_number: '01000001111' }));

  const result = await h.facebookLeads.handleLeadgenChange({ pageId: 'page-1', leadgenId: 'lead-after-disconnect' });
  assert.deepEqual(result, { outcome: 'unknown_page' });
});

// ---- Operational failures (must propagate so the caller can signal "retry") ----

test('a Graph API failure propagates as a thrown error (not swallowed), and leaves no ledger row', async () => {
  const h = freshHarness();
  await connectPage(h, 'c1', 'page-1');
  h.setFetchImpl(async () => new Response('', { status: 500 }));

  await assert.rejects(() => h.facebookLeads.handleLeadgenChange({ pageId: 'page-1', leadgenId: 'lead-fail' }));
  const ledger = await h.facebookLeadEvents.findAll((e) => e.leadgenId === 'lead-fail');
  assert.equal(ledger.length, 0, 'an operational failure must not be recorded as processed — a retry must actually retry');
  assert.equal((await h.leads.findAll((l) => l.companyId === 'c1')).length, 0);
});

test('a retried delivery after a transient failure succeeds and creates exactly one lead', async () => {
  const h = freshHarness();
  await connectPage(h, 'c1', 'page-1');
  let attempt = 0;
  h.setFetchImpl(async () => {
    attempt++;
    if (attempt === 1) return new Response('', { status: 503 });
    return fieldDataResponse({ full_name: 'Retried Person', phone_number: '01077778888' });
  });

  await assert.rejects(() => h.facebookLeads.handleLeadgenChange({ pageId: 'page-1', leadgenId: 'lead-retry' }));
  const retried = await h.facebookLeads.handleLeadgenChange({ pageId: 'page-1', leadgenId: 'lead-retry' });
  assert.equal(retried.outcome, 'created');
  assert.equal((await h.leads.findAll((l) => l.companyId === 'c1')).length, 1);
});

// ---- Secrecy: never exposes the token/secret ----

test('no returned outcome, ledger row, or audit entry ever contains the page access token or app secret', async () => {
  const h = freshHarness();
  await connectPage(h, 'c1', 'page-1', 'super-secret-token-value');
  h.setFetchImpl(async () => fieldDataResponse({ full_name: 'Private Person', phone_number: '01044445555' }));
  await h.facebookLeads.handleLeadgenChange({ pageId: 'page-1', leadgenId: 'lead-secret' });

  const ledger = await h.facebookLeadEvents.findAll((e) => e.leadgenId === 'lead-secret');
  const auditEntries = await h.auditLogRepo.findAll((e) => e.companyId === 'c1');
  const serializedLedger = JSON.stringify(ledger);
  const serializedAudit = JSON.stringify(auditEntries);
  assert.ok(!serializedLedger.includes('super-secret-token-value'));
  assert.ok(!serializedAudit.includes('super-secret-token-value'));
  assert.ok(!serializedLedger.includes(APP_SECRET));
  assert.ok(!serializedAudit.includes(APP_SECRET));
});
