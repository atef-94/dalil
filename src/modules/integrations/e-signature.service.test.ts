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
import { SignatureService } from './e-signature.service.js';
import type {
  ApprovalRequest, AuditLogEntry, Campaign, Contract, CrmStage, Employee, IntegrationConnection, IntegrationEvent,
  Lead, Message, Opportunity, Payment, PaymentPlanTemplate, PaymentScheduleLine, PermissionGrant, PermissionOverride,
  Project, Quotation, Receipt, Refund, Reservation, Role, Secret, SignatureEnvelope, Task, Unit, UnitHold, User, UserRole,
  WorkflowDefinition, WorkflowRun, WorkflowStepRun,
} from '../../domain/types.js';

function freshHarness() {
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
    rbac, tasks, communication, crm, crmStages, marketing, finance, sales,
    inventory, leadScoring, quotations, paymentPlans, auditLog,
    'test-encryption-secret-not-for-production',
  );

  const connections = new InMemoryRepository<IntegrationConnection>();
  const events = new InMemoryRepository<IntegrationEvent>();
  let fetchImpl: typeof fetch = (async () => new Response(JSON.stringify({ envelopeId: 'env-abc' }), { status: 201 })) as typeof fetch;
  const integrations = new IntegrationService(
    { connections, events }, automation, auditLog,
    ((url, init) => fetchImpl(url, init)) as typeof fetch, 0, 30,
  );

  const envelopes = new InMemoryRepository<SignatureEnvelope>();
  const signatures = new SignatureService(envelopes, contracts, integrations, automation);

  return { signatures, integrations, automation, contracts, setFetchImpl: (impl: typeof fetch) => { fetchImpl = impl; } };
}

async function seedContract(h: ReturnType<typeof freshHarness>, companyId = 'c1'): Promise<Contract> {
  const contract: Contract = {
    id: 'contract-1', companyId, reservationId: 'r1', unitId: 'u1', clientId: 'lead-1',
    creditedEmployeeUserId: 'emp-1', paymentPlanTemplateId: 'tpl-1', status: 'signed', createdAt: new Date().toISOString(),
  };
  await h.contracts.save(contract);
  return contract;
}

async function connectESignature(h: ReturnType<typeof freshHarness>, companyId = 'c1') {
  return h.integrations.connect({
    companyId, provider: 'e_signature', displayName: 'My E-Signature', config: { accountId: 'acct-1' },
    credentials: { api_key: 'key-sig', webhook_secret: 'whsec-1' }, createdByUserId: 'u1',
  });
}

test('sendForSignature creates a sent envelope referencing the real outbound envelope id', async () => {
  const h = freshHarness();
  await seedContract(h);
  await connectESignature(h);
  const envelope = await h.signatures.sendForSignature({
    companyId: 'c1', contractId: 'contract-1', signerEmail: 'buyer@example.com',
    documentUrl: 'https://docs.example.com/contract-1.pdf', requestedByUserId: 'u1',
  });
  assert.equal(envelope.status, 'sent');
  assert.equal(envelope.externalEnvelopeId, 'env-abc');
  assert.equal(envelope.contractId, 'contract-1');
});

test('sendForSignature rejects a contract from a different company (cross-tenant IDOR)', async () => {
  const h = freshHarness();
  await seedContract(h, 'c1');
  await connectESignature(h, 'c2');
  await assert.rejects(() =>
    h.signatures.sendForSignature({ companyId: 'c2', contractId: 'contract-1', signerEmail: 'buyer@example.com', documentUrl: 'https://x', requestedByUserId: 'u1' }),
  );
});

test('sendForSignature rejects when no e_signature connector is connected', async () => {
  const h = freshHarness();
  await seedContract(h);
  await assert.rejects(() =>
    h.signatures.sendForSignature({ companyId: 'c1', contractId: 'contract-1', signerEmail: 'buyer@example.com', documentUrl: 'https://x', requestedByUserId: 'u1' }),
  );
});

test('handleWebhook rejects a request with a missing signature', async () => {
  const h = freshHarness();
  await seedContract(h);
  await connectESignature(h);
  const envelope = await h.signatures.sendForSignature({
    companyId: 'c1', contractId: 'contract-1', signerEmail: 'buyer@example.com', documentUrl: 'https://x', requestedByUserId: 'u1',
  });
  await assert.rejects(() => h.signatures.handleWebhook(envelope.id, 'c1', JSON.stringify({ status: 'signed' }), undefined), /signature/i);
});

test('handleWebhook rejects a request with an invalid HMAC signature', async () => {
  const h = freshHarness();
  await seedContract(h);
  await connectESignature(h);
  const envelope = await h.signatures.sendForSignature({
    companyId: 'c1', contractId: 'contract-1', signerEmail: 'buyer@example.com', documentUrl: 'https://x', requestedByUserId: 'u1',
  });
  await assert.rejects(() => h.signatures.handleWebhook(envelope.id, 'c1', JSON.stringify({ status: 'signed' }), 'not-the-real-signature'), /invalid webhook signature/i);
  const stillSent = await h.signatures.getEnvelope(envelope.id, 'c1');
  assert.equal(stillSent!.status, 'sent', 'an unverified callback must never change envelope state');
});

test('handleWebhook accepts a correctly HMAC-signed callback and flips the envelope to signed', async () => {
  const h = freshHarness();
  await seedContract(h);
  await connectESignature(h);
  const envelope = await h.signatures.sendForSignature({
    companyId: 'c1', contractId: 'contract-1', signerEmail: 'buyer@example.com', documentUrl: 'https://x', requestedByUserId: 'u1',
  });
  const rawBody = JSON.stringify({ status: 'signed' });
  const signature = createHmac('sha256', 'whsec-1').update(rawBody).digest('hex');
  const updated = await h.signatures.handleWebhook(envelope.id, 'c1', rawBody, signature);
  assert.equal(updated.status, 'signed');
  assert.ok(updated.decidedAt);
});

test('handleWebhook is idempotent: a second verified callback for an already-decided envelope is a no-op', async () => {
  const h = freshHarness();
  await seedContract(h);
  await connectESignature(h);
  const envelope = await h.signatures.sendForSignature({
    companyId: 'c1', contractId: 'contract-1', signerEmail: 'buyer@example.com', documentUrl: 'https://x', requestedByUserId: 'u1',
  });
  const rawBody = JSON.stringify({ status: 'signed' });
  const signature = createHmac('sha256', 'whsec-1').update(rawBody).digest('hex');
  await h.signatures.handleWebhook(envelope.id, 'c1', rawBody, signature);

  const declineBody = JSON.stringify({ status: 'declined' });
  const declineSig = createHmac('sha256', 'whsec-1').update(declineBody).digest('hex');
  const second = await h.signatures.handleWebhook(envelope.id, 'c1', declineBody, declineSig);
  assert.equal(second.status, 'signed', 'the first decision stands — a later callback never overwrites it');
});

test('handleWebhook rejects a cross-tenant envelope id', async () => {
  const h = freshHarness();
  await seedContract(h);
  await connectESignature(h);
  const envelope = await h.signatures.sendForSignature({
    companyId: 'c1', contractId: 'contract-1', signerEmail: 'buyer@example.com', documentUrl: 'https://x', requestedByUserId: 'u1',
  });
  const rawBody = JSON.stringify({ status: 'signed' });
  const signature = createHmac('sha256', 'whsec-1').update(rawBody).digest('hex');
  await assert.rejects(() => h.signatures.handleWebhook(envelope.id, 'c2', rawBody, signature));
});

test('listForContract returns only this company\'s envelopes for the given contract', async () => {
  const h = freshHarness();
  await seedContract(h);
  await connectESignature(h);
  await h.signatures.sendForSignature({ companyId: 'c1', contractId: 'contract-1', signerEmail: 'a@x.com', documentUrl: 'https://x', requestedByUserId: 'u1' });
  const list = await h.signatures.listForContract('contract-1', 'c1');
  assert.equal(list.length, 1);
  assert.equal(list[0]!.signerEmail, 'a@x.com');
});
