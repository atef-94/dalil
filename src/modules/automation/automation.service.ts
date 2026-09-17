import { randomUUID, createHash } from 'node:crypto';
import type {
  ActionName,
  AgentDecision,
  ApprovalRequest,
  ApprovalStatus,
  AutomationActionType,
  CampaignStatus,
  LeadStatus,
  MessageChannel,
  MessageRelatedResource,
  ResourceName,
  Secret,
  StepRunStatus,
  WorkflowActionConfig,
  WorkflowCondition,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunInitiator,
  WorkflowStatus,
  WorkflowStepDefinition,
  WorkflowStepRun,
  WorkflowTriggerConfig,
} from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { AutomationError, ForbiddenError, NotFoundError, ValidationError } from '../../infra/errors.js';
import { decryptSecret, encryptSecret } from '../../infra/security.js';
import type { DomainEvent } from '../../infra/event-bus.js';
import { AuditLog } from '../../infra/audit-log.js';
import { KeyedMutex } from '../../infra/keyed-mutex.js';
import { ConcurrencyLimiter } from '../../infra/concurrency-queue.js';
import { RbacEvaluator } from '../permissions/rbac.evaluator.js';
import { TaskService } from '../tasks/task.service.js';
import { CommunicationService } from '../communication/communication.service.js';
import { CrmService } from '../crm/crm.service.js';
import { MarketingService } from '../marketing/marketing.service.js';

export interface AutomationRepos {
  workflows: Repository<WorkflowDefinition>;
  runs: Repository<WorkflowRun>;
  stepRuns: Repository<WorkflowStepRun>;
  approvals: Repository<ApprovalRequest>;
  secrets: Repository<Secret>;
}

// Callers (routes, tests, templates) don't need to invent step ids — the
// engine assigns one when missing.
export type WorkflowStepInput = Omit<WorkflowStepDefinition, 'id'> & { id?: string };

export interface CreateWorkflowInput {
  companyId: string;
  name: string;
  description?: string;
  trigger: WorkflowTriggerConfig;
  steps: WorkflowStepInput[];
  createdByUserId: string;
}

export interface UpdateWorkflowInput {
  name?: string;
  description?: string;
  steps?: WorkflowStepInput[];
}

export interface WorkflowTemplate {
  key: string;
  name: string;
  description: string;
  trigger: WorkflowTriggerConfig;
  steps: Omit<WorkflowStepDefinition, 'id'>[];
}

export type SecretMetadata = Omit<Secret, 'encryptedValue' | 'iv' | 'authTag'>;

export interface AutomationStats {
  totalWorkflows: number;
  activeWorkflows: number;
  pausedWorkflows: number;
  archivedWorkflows: number;
  totalRuns: number;
  runningRuns: number;
  waitingApprovalRuns: number;
  completedRuns: number;
  failedRuns: number;
  cancelledRuns: number;
  pendingApprovals: number;
}

// The minimal context executeAction() needs — deliberately not tied to a
// WorkflowRun/WorkflowDefinition so the exact same dispatcher can be
// invoked directly (executeActionDirect) by the AI Execution Layer, which
// has no workflow run of its own.
interface ActionExecutionContext {
  companyId: string;
  actorUserId: string;
  triggerPayload: Record<string, unknown>;
}

// Built-in starting points surfaced by GET /api/automation/templates and the
// frontend's "new workflow" picker — not persisted rows, just definitions a
// caller copies into a real createWorkflow() call.
const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    key: 'new-lead-welcome-task',
    name: 'New Lead Welcome Task',
    description: 'Creates a follow-up task for the assigned owner whenever a new lead is created.',
    trigger: { type: 'event', eventType: 'lead.created' },
    steps: [
      {
        name: 'Create follow-up task',
        action: { type: 'create_task', params: { title: 'Follow up with {{fullName}}', description: 'New lead created via source {{sourceId}}' } },
      },
    ],
  },
  {
    key: 'qualified-lead-reassignment-approval',
    name: 'Qualified Lead Reassignment Approval',
    description: 'Requires manager approval before a newly qualified lead can be reassigned.',
    trigger: { type: 'event', eventType: 'lead.status_changed' },
    steps: [
      {
        name: 'Only when qualified',
        conditions: [{ field: 'status', operator: 'eq', value: 'qualified' }],
        action: { type: 'require_approval', params: { reason: 'Approve reassignment of a newly qualified lead' } },
      },
    ],
  },
  {
    key: 'overdue-payment-notice',
    name: 'Overdue Payment Notice',
    description: 'Sends an internal notification whenever a scheduled payment is swept as overdue.',
    trigger: { type: 'event', eventType: 'payment.overdue_swept' },
    steps: [
      { name: 'Notify finance', action: { type: 'send_message', params: { subject: 'Overdue payment', body: 'A scheduled payment was marked overdue.' } } },
    ],
  },
  {
    key: 'weekly-campaign-review',
    name: 'Weekly Campaign Review Reminder',
    description: 'Creates a recurring weekly reminder task to review active campaign performance.',
    trigger: { type: 'scheduled', intervalMinutes: 10080 },
    steps: [{ name: 'Create review task', action: { type: 'create_task', params: { title: 'Weekly campaign performance review' } } }],
  },
  {
    key: 'new-employee-onboarding-task',
    name: 'New Employee Onboarding Task',
    description: 'Creates an onboarding checklist task whenever a new employee record is created.',
    trigger: { type: 'event', eventType: 'employee.created' },
    steps: [{ name: 'Create onboarding task', action: { type: 'create_task', params: { title: 'Prepare onboarding for {{fullName}}' } } }],
  },
  {
    key: 'leave-request-notification',
    name: 'Leave Request Notification',
    description: 'Notifies HR internally whenever a new leave request is submitted.',
    trigger: { type: 'event', eventType: 'leave_request.created' },
    steps: [{ name: 'Notify HR', action: { type: 'send_message', params: { subject: 'New leave request', body: 'A new leave request was submitted and needs review.' } } }],
  },
  {
    key: 'lead-ai-outreach',
    name: 'Lead AI Outreach',
    description:
      'The full cross-module example: a new lead is handed to the Sales agent, which scores it and picks a next action — reaching out over a connected WhatsApp/Email integration when confident enough, otherwise a task — through the same permission/policy/approval/audit pipeline as any other AI action. A follow-up task is then created unconditionally as a safety net.',
    trigger: { type: 'event', eventType: 'lead.created' },
    steps: [
      { name: 'AI (Sales agent) decides the next action for this lead', action: { type: 'ai_decide', params: { agentKey: 'sales', subjectId: '{{id}}' } } },
      {
        name: 'Guaranteed follow-up task',
        action: { type: 'create_task', params: { title: 'Follow up with {{fullName}}', relatedResource: 'lead', relatedResourceId: '{{id}}' } },
      },
    ],
  },
  {
    key: 'customer-response-ai-followup',
    name: 'Customer Response AI Follow-up',
    description:
      'Closes the loop on Lead AI Outreach: an inbound webhook (e.g. a WhatsApp/Email provider relaying a customer reply) hands the lead back to the Sales agent to re-score and decide the next action. POST { "leadId": "..." } to this workflow\'s webhook URL.',
    trigger: { type: 'webhook', webhookSlug: 'customer-response' },
    steps: [
      { name: 'AI (Sales agent) re-evaluates the lead', action: { type: 'ai_decide', params: { agentKey: 'sales', subjectId: '{{leadId}}' } } },
    ],
  },
];

const ACTION_RESOURCE: Record<AutomationActionType, ResourceName> = {
  create_task: 'task',
  send_message: 'message',
  create_lead: 'lead',
  update_lead_status: 'lead',
  assign_lead_owner: 'lead',
  update_campaign_status: 'campaign',
  webhook_call: 'secret',
  integration_call: 'integration_connection',
  ai_decide: 'ai_action',
  require_approval: 'approval',
};

const ACTION_VERB: Record<AutomationActionType, ActionName> = {
  create_task: 'create',
  send_message: 'create',
  create_lead: 'create',
  update_lead_status: 'edit',
  assign_lead_owner: 'edit',
  update_campaign_status: 'edit',
  webhook_call: 'view',
  integration_call: 'create',
  ai_decide: 'create',
  require_approval: 'approve',
};

/**
 * The native Automation Engine. Workflows are not tied to an HTTP request —
 * they run off events, schedule ticks, or inbound webhooks — so unlike the
 * rest of ACTIVE's services (which rely on app.ts route handlers to check
 * RBAC before calling them), this engine owns its own permission checks: it
 * always executes as the workflow's creator (`workflow.createdByUserId`)
 * and re-checks that user's live RBAC grants before every single step,
 * every single run. A workflow can never do more than its creator is
 * currently authorized to do, and a later permission change (or a revoke)
 * takes effect on the very next run.
 */
export class AutomationService {
  // Closes a real TOCTOU race: two near-simultaneous deliveries of the same
  // event/webhook (a retried event, a webhook provider's own retry policy)
  // could otherwise both pass the "no existing run" check before either had
  // saved its run, producing two runs for one idempotency key. Keyed per
  // `${workflowId}:${idempotencyKey}` so unrelated triggers never block
  // each other.
  private readonly idempotencyMutex = new KeyedMutex();
  // Bounds how many workflow runs execute concurrently, process-wide — a
  // burst of triggers (e.g. many leads created at once) queues instead of
  // spawning unbounded concurrent webhook_call/etc. work.
  private readonly executionLimiter: ConcurrencyLimiter;
  // Late-bound rather than constructor-injected: IntegrationService itself
  // depends on AutomationService (for encrypted credential storage via
  // getDecryptedSecret/setSecret), so a constructor-level dependency in the
  // other direction would be circular. app.ts wires this once, right after
  // both services are constructed, via setIntegrationSender().
  private integrationSender?: (companyId: string, provider: string, action: string, params: Record<string, unknown>, userId: string) => Promise<Record<string, unknown>>;
  // Same late-binding as integrationSender, and for the same reason: the AI
  // Agent Orchestration layer (AiAgentService) is itself built on top of
  // AutomationService (it dispatches every action it decides on through
  // executeActionDirect), so a constructor-level dependency back onto it
  // here would be circular. This is what lets an `ai_decide` workflow step
  // hand a subject off to a specialized agent — Lead Created -> ai_decide
  // (sales agent scores + picks the next action, itself going through the
  // exact same permission/policy/approval/audit pipeline) -> the rest of
  // the workflow continues (e.g. a guaranteed follow-up task) regardless of
  // what the agent chose.
  private aiDecider?: (companyId: string, agentKey: string, subjectId: string, requestedByUserId: string) => Promise<AgentDecision>;

  constructor(
    private readonly repos: AutomationRepos,
    private readonly rbac: RbacEvaluator,
    private readonly tasks: TaskService,
    private readonly communication: CommunicationService,
    private readonly crm: CrmService,
    private readonly marketing: MarketingService,
    private readonly auditLog: AuditLog,
    private readonly encryptionSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Base delay before a retried step attempt, doubled each attempt
     * (capped) — 0 by default so tests stay instant; production wiring in
     * app.ts passes a real value. */
    private readonly retryBaseDelayMs = 0,
    maxConcurrentRuns = 10,
  ) {
    this.executionLimiter = new ConcurrencyLimiter(maxConcurrentRuns);
  }

  /** Wires the Integration Layer's send() in as the executor for
   * `integration_call` steps/AI actions — see the field comment above for
   * why this is late-bound rather than a constructor dependency. */
  setIntegrationSender(
    sender: (companyId: string, provider: string, action: string, params: Record<string, unknown>, userId: string) => Promise<Record<string, unknown>>,
  ): void {
    this.integrationSender = sender;
  }

  /** Wires the AI Agent Orchestration layer's decide() in as the executor
   * for `ai_decide` steps — see the field comment above for why this is
   * late-bound rather than a constructor dependency. */
  setAiDecider(decider: (companyId: string, agentKey: string, subjectId: string, requestedByUserId: string) => Promise<AgentDecision>): void {
    this.aiDecider = decider;
  }

  // ---- Workflow CRUD ----

  async createWorkflow(input: CreateWorkflowInput): Promise<WorkflowDefinition> {
    if (!input.name?.trim()) throw new ValidationError('name is required');
    this.validateTrigger(input.trigger);
    if (!input.steps || input.steps.length === 0) throw new ValidationError('at least one step is required');
    for (const step of input.steps) this.validateStep(step);

    if (input.trigger.type === 'webhook') {
      await this.assertWebhookSlugFree(input.companyId, input.trigger.webhookSlug!);
    }

    const now = new Date().toISOString();
    const workflow: WorkflowDefinition = {
      id: randomUUID(),
      companyId: input.companyId,
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      trigger: input.trigger,
      steps: input.steps.map((step) => ({ ...step, id: step.id || randomUUID() })),
      status: 'active',
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
    };
    return this.repos.workflows.save(workflow);
  }

  async updateWorkflow(id: string, companyId: string, updates: UpdateWorkflowInput): Promise<WorkflowDefinition> {
    const workflow = await this.repos.workflows.findById(id);
    if (!workflow || workflow.companyId !== companyId) throw new NotFoundError('workflow not found');
    if (updates.steps) {
      if (updates.steps.length === 0) throw new ValidationError('at least one step is required');
      for (const step of updates.steps) this.validateStep(step);
    }
    const updated: WorkflowDefinition = {
      ...workflow,
      name: updates.name?.trim() || workflow.name,
      description: updates.description !== undefined ? updates.description.trim() || undefined : workflow.description,
      steps: updates.steps ? updates.steps.map((step) => ({ ...step, id: step.id || randomUUID() })) : workflow.steps,
      updatedAt: new Date().toISOString(),
    };
    return this.repos.workflows.save(updated);
  }

  async setWorkflowStatus(id: string, companyId: string, status: WorkflowStatus): Promise<WorkflowDefinition> {
    const workflow = await this.repos.workflows.findById(id);
    if (!workflow || workflow.companyId !== companyId) throw new NotFoundError('workflow not found');
    return this.repos.workflows.save({ ...workflow, status, updatedAt: new Date().toISOString() });
  }

  async listWorkflows(companyId: string): Promise<WorkflowDefinition[]> {
    return this.repos.workflows.findAll((w) => w.companyId === companyId);
  }

  async getWorkflow(id: string, companyId: string): Promise<WorkflowDefinition> {
    const workflow = await this.repos.workflows.findById(id);
    if (!workflow || workflow.companyId !== companyId) throw new NotFoundError('workflow not found');
    return workflow;
  }

  listTemplates(): WorkflowTemplate[] {
    return WORKFLOW_TEMPLATES;
  }

  private validateTrigger(trigger: WorkflowTriggerConfig): void {
    if (trigger.type === 'event' && !trigger.eventType) throw new ValidationError('eventType is required for an event trigger');
    if (trigger.type === 'scheduled' && !((trigger.intervalMinutes ?? 0) > 0)) {
      throw new ValidationError('intervalMinutes must be a positive number for a scheduled trigger');
    }
    if (trigger.type === 'webhook' && !trigger.webhookSlug?.trim()) throw new ValidationError('webhookSlug is required for a webhook trigger');
  }

  private validateStep(step: WorkflowStepInput): void {
    if (!step.name?.trim()) throw new ValidationError('every step requires a name');
    if (!step.action?.type || !(step.action.type in ACTION_RESOURCE)) throw new ValidationError('every step requires a valid action type');
    for (const condition of step.conditions ?? []) {
      if (!condition.field?.trim()) throw new ValidationError('every condition requires a field');
    }
  }

  private async assertWebhookSlugFree(companyId: string, slug: string): Promise<void> {
    const clashing = await this.repos.workflows.findAll(
      (w) => w.companyId === companyId && w.status !== 'archived' && w.trigger.type === 'webhook' && w.trigger.webhookSlug === slug,
    );
    if (clashing.length > 0) throw new ValidationError(`a workflow with webhook slug "${slug}" already exists`);
  }

  // ---- Run history ----

  async listRuns(workflowId: string, companyId: string): Promise<WorkflowRun[]> {
    return this.repos.runs.findAll((r) => r.workflowId === workflowId && r.companyId === companyId);
  }

  async getRun(id: string, companyId: string): Promise<WorkflowRun> {
    const run = await this.repos.runs.findById(id);
    if (!run || run.companyId !== companyId) throw new NotFoundError('run not found');
    return run;
  }

  async listStepRuns(runId: string, companyId: string): Promise<WorkflowStepRun[]> {
    return this.repos.stepRuns.findAll((sr) => sr.runId === runId && sr.companyId === companyId);
  }

  // ---- Triggers ----

  async handleEvent(event: DomainEvent): Promise<WorkflowRun[]> {
    const workflows = await this.repos.workflows.findAll(
      (w) => w.companyId === event.companyId && w.status === 'active' && w.trigger.type === 'event' && w.trigger.eventType === event.type,
    );
    const results: WorkflowRun[] = [];
    for (const workflow of workflows) {
      const idempotencyKey = this.computeEventIdempotencyKey(event);
      const { run, created } = await this.getOrCreateRun(workflow, event.payload, event.type, 'system', event.actorUserId, idempotencyKey);
      results.push(created ? await this.executeRun(run.id) : run);
    }
    return results;
  }

  async runDueScheduledWorkflows(now: Date = new Date()): Promise<WorkflowRun[]> {
    const workflows = await this.repos.workflows.findAll((w) => w.status === 'active' && w.trigger.type === 'scheduled');
    const results: WorkflowRun[] = [];
    for (const workflow of workflows) {
      const intervalMs = (workflow.trigger.intervalMinutes ?? 0) * 60_000;
      if (intervalMs <= 0) continue;
      const last = workflow.lastScheduledRunAt ? Date.parse(workflow.lastScheduledRunAt) : 0;
      if (now.getTime() - last < intervalMs) continue;

      const bucket = Math.floor(now.getTime() / intervalMs);
      const idempotencyKey = `scheduled:${bucket}`;
      await this.repos.workflows.save({ ...workflow, lastScheduledRunAt: now.toISOString() });

      const { run, created } = await this.getOrCreateRun(workflow, {}, undefined, 'system', undefined, idempotencyKey);
      results.push(created ? await this.executeRun(run.id) : run);
    }
    return results;
  }

  async receiveWebhook(
    companyId: string,
    slug: string,
    payload: Record<string, unknown>,
    idempotencyKeyHeader?: string,
  ): Promise<WorkflowRun> {
    const candidates = await this.repos.workflows.findAll(
      (w) => w.companyId === companyId && w.status === 'active' && w.trigger.type === 'webhook' && w.trigger.webhookSlug === slug,
    );
    const workflow = candidates[0];
    if (!workflow) throw new NotFoundError('no active workflow is registered for this webhook');

    const idempotencyKey = idempotencyKeyHeader?.trim() || createHash('sha256').update(`${slug}:${JSON.stringify(payload)}`).digest('hex');
    const { run, created } = await this.getOrCreateRun(workflow, payload, undefined, 'system', undefined, idempotencyKey);
    return created ? this.executeRun(run.id) : run;
  }

  /** Atomically checks-for and creates the run for a given
   * (workflowId, idempotencyKey) pair — the mutex closes the race where two
   * near-simultaneous duplicate deliveries could otherwise both observe "no
   * existing run" and each create one. Execution itself happens *outside*
   * the lock (it can be slow — a webhook_call step — and by the time the
   * run row is saved, a concurrent duplicate will already see it via
   * findExistingRun). */
  private async getOrCreateRun(
    workflow: WorkflowDefinition,
    triggerPayload: Record<string, unknown>,
    triggerEventType: string | undefined,
    initiatedBy: WorkflowRunInitiator,
    initiatedByUserId: string | undefined,
    idempotencyKey: string,
  ): Promise<{ run: WorkflowRun; created: boolean }> {
    return this.idempotencyMutex.runExclusive(`${workflow.id}:${idempotencyKey}`, async () => {
      const existing = await this.findExistingRun(workflow.id, idempotencyKey);
      if (existing) return { run: existing, created: false };
      const run = await this.startRun(workflow, triggerPayload, triggerEventType, initiatedBy, initiatedByUserId, idempotencyKey);
      return { run, created: true };
    });
  }

  private computeEventIdempotencyKey(event: DomainEvent): string {
    if (event.dedupeKey?.trim()) return event.dedupeKey.trim();
    return createHash('sha256').update(`${event.type}:${JSON.stringify(event.payload)}`).digest('hex');
  }

  private async findExistingRun(workflowId: string, idempotencyKey: string): Promise<WorkflowRun | undefined> {
    const matches = await this.repos.runs.findAll((r) => r.workflowId === workflowId && r.idempotencyKey === idempotencyKey);
    return matches[0];
  }

  private async startRun(
    workflow: WorkflowDefinition,
    triggerPayload: Record<string, unknown>,
    triggerEventType: string | undefined,
    initiatedBy: WorkflowRunInitiator,
    initiatedByUserId: string | undefined,
    idempotencyKey: string,
  ): Promise<WorkflowRun> {
    const run: WorkflowRun = {
      id: randomUUID(),
      companyId: workflow.companyId,
      workflowId: workflow.id,
      status: 'running',
      triggerEventType,
      triggerPayload,
      idempotencyKey,
      currentStepIndex: 0,
      startedAt: new Date().toISOString(),
      initiatedBy,
      initiatedByUserId,
    };
    return this.repos.runs.save(run);
  }

  // ---- Execution ----

  /** Public entry point — every execution path (event/schedule/webhook/
   * manual/approval-resume/crash-recovery) funnels through here, so the
   * concurrency limiter's bound is process-wide, not per-trigger-type. */
  async executeRun(runId: string): Promise<WorkflowRun> {
    return this.executionLimiter.run(() => this.executeRunInternal(runId));
  }

  private async executeRunInternal(runId: string): Promise<WorkflowRun> {
    let run = await this.repos.runs.findById(runId);
    if (!run) throw new NotFoundError('run not found');
    if (run.status !== 'running') return run;

    const workflow = await this.repos.workflows.findById(run.workflowId);
    if (!workflow) throw new NotFoundError('workflow not found for run');

    for (let i = run.currentStepIndex; i < workflow.steps.length; i++) {
      const step = workflow.steps[i]!;
      const conditionsPass = (step.conditions ?? []).every((condition) => this.evaluateCondition(condition, run!.triggerPayload));

      if (!conditionsPass) {
        await this.recordStepRun(run, step, 'skipped');
        run = await this.advanceRun(run, i + 1);
        continue;
      }

      if (step.action.type === 'require_approval') {
        await this.recordStepRun(run, step, 'waiting_approval');
        const reason = typeof step.action.params.reason === 'string' ? step.action.params.reason : `Approval required for step "${step.name}"`;
        const approval: ApprovalRequest = {
          id: randomUUID(),
          companyId: run.companyId,
          runId: run.id,
          stepId: step.id,
          reason,
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        await this.repos.approvals.save(approval);
        run = { ...run, status: 'waiting_approval', currentStepIndex: i };
        run = await this.repos.runs.save(run);
        return run;
      }

      const maxAttempts = Math.max(1, (step.maxRetries ?? 0) + 1);
      let lastError: string | undefined;
      let output: Record<string, unknown> | undefined;
      let attempts = 0;
      let succeeded = false;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        attempts = attempt;
        if (attempt > 1 && this.retryBaseDelayMs > 0) {
          // Exponential backoff (capped at 30s) — retrying instantly against
          // a still-down endpoint almost never helps and just burns the
          // concurrency budget; a real gap in the original implementation.
          const delay = Math.min(this.retryBaseDelayMs * 2 ** (attempt - 2), 30_000);
          await this.sleep(delay);
        }
        try {
          output = await this.executeAction(step.action, {
            companyId: workflow.companyId,
            actorUserId: workflow.createdByUserId,
            triggerPayload: run.triggerPayload,
          });
          succeeded = true;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      if (succeeded) {
        await this.recordStepRun(run, step, 'succeeded', output, undefined, attempts);
        await this.auditLog.record({
          companyId: run.companyId,
          actorUserId: workflow.createdByUserId,
          action: 'execute',
          resource: 'workflow_run',
          resourceId: run.id,
          metadata: { stepId: step.id, actionType: step.action.type, workflowId: workflow.id, attempts },
        });
        run = await this.advanceRun(run, i + 1);
        continue;
      }

      await this.recordStepRun(run, step, 'failed', undefined, lastError, attempts);
      // Failures need to be as visible in the company-wide audit trail as
      // successes — a previously-unfixed gap where only successful steps
      // were audited, so a failing automation left no trace outside the
      // automation UI itself.
      await this.auditLog.record({
        companyId: run.companyId,
        actorUserId: workflow.createdByUserId,
        action: 'execute',
        resource: 'workflow_run',
        resourceId: run.id,
        metadata: { stepId: step.id, actionType: step.action.type, workflowId: workflow.id, attempts, failed: true, error: lastError },
      });
      if ((step.onFailure ?? 'stop') === 'stop') {
        run = await this.finishRun(run, 'failed', lastError);
        return run;
      }
      run = await this.advanceRun(run, i + 1);
    }

    if (run.status === 'running') {
      run = await this.finishRun(run, 'completed');
    }
    return run;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private evaluateCondition(condition: WorkflowCondition, payload: Record<string, unknown>): boolean {
    const actual = this.getPath(payload, condition.field);
    switch (condition.operator) {
      case 'eq':
        return actual === condition.value;
      case 'neq':
        return actual !== condition.value;
      case 'gt':
        return Number(actual) > Number(condition.value);
      case 'gte':
        return Number(actual) >= Number(condition.value);
      case 'lt':
        return Number(actual) < Number(condition.value);
      case 'lte':
        return Number(actual) <= Number(condition.value);
      case 'contains':
        if (Array.isArray(actual)) return actual.includes(condition.value);
        if (typeof actual === 'string') return actual.includes(String(condition.value));
        return false;
      case 'exists':
        return actual !== undefined && actual !== null;
      default:
        return false;
    }
  }

  private getPath(obj: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((acc, key) => {
      if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
      return undefined;
    }, obj);
  }

  private resolveTemplate(value: unknown, payload: Record<string, unknown>): unknown {
    if (typeof value === 'string') {
      return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
        const resolved = this.getPath(payload, path);
        return resolved === undefined || resolved === null ? '' : String(resolved);
      });
    }
    if (Array.isArray(value)) return value.map((entry) => this.resolveTemplate(entry, payload));
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
        result[key] = this.resolveTemplate(entryValue, payload);
      }
      return result;
    }
    return value;
  }

  private requireString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new AutomationError(`"${field}" is required`);
    return value.trim();
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  /**
   * Runs a single action immediately, outside of any workflow run — the
   * AI Execution Layer's only way to actually perform an action. Goes
   * through the exact same executeAction() dispatcher (and therefore the
   * exact same per-action-type RBAC check) as a workflow step; there is no
   * separate or lighter-weight path for AI-initiated actions.
   */
  async executeActionDirect(companyId: string, actorUserId: string, action: WorkflowActionConfig, contextPayload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.executeAction(action, { companyId, actorUserId, triggerPayload: contextPayload });
  }

  /** Non-throwing permission check for a given action type — lets a caller
   * (the AI Execution Layer) decide what to do about a denial (record it,
   * escalate it) instead of catching an exception. */
  async canPerformAction(actorUserId: string, actionType: AutomationActionType, companyId: string, ownerUserId?: string): Promise<boolean> {
    const resource = ACTION_RESOURCE[actionType];
    const verb = ACTION_VERB[actionType];
    return this.rbac.can(actorUserId, verb, resource, { companyId, ownerUserId });
  }

  /** Runs an existing workflow on demand (a "Run Now" button, or the AI
   * Execution Layer executing a business workflow) instead of waiting for
   * its configured trigger. Still goes through the same run/step-run/
   * approval machinery as an event/schedule/webhook-triggered run. */
  async triggerManualRun(
    workflowId: string,
    companyId: string,
    payload: Record<string, unknown>,
    initiatedBy: WorkflowRunInitiator,
    initiatedByUserId?: string,
    idempotencyKey?: string,
  ): Promise<WorkflowRun> {
    const workflow = await this.getWorkflow(workflowId, companyId);
    if (workflow.status !== 'active') throw new AutomationError('only an active workflow can be run manually');
    const key = idempotencyKey?.trim() || randomUUID();
    const { run, created } = await this.getOrCreateRun(workflow, payload, undefined, initiatedBy, initiatedByUserId, key);
    return created ? this.executeRun(run.id) : run;
  }

  /** Failure recovery: resumes a `failed` run from the exact step it
   * stopped on (currentStepIndex was never advanced past a step that
   * failed with onFailure:'stop') — e.g. after fixing the external
   * endpoint a webhook_call step was hitting. Without this, a failed run
   * was terminal forever; the only "recovery" was re-triggering the whole
   * workflow from scratch, which re-runs every already-succeeded step too. */
  async retryRun(runId: string, companyId: string): Promise<WorkflowRun> {
    const run = await this.getRun(runId, companyId);
    if (run.status !== 'failed') throw new AutomationError(`only a failed run can be retried (current status: ${run.status})`);
    const resumed = await this.repos.runs.save({ ...run, status: 'running', error: undefined, finishedAt: undefined });
    return this.executeRun(resumed.id);
  }

  /** Crash recovery: a run only ever stays `running` in storage if the
   * process died mid-execution (under normal operation executeRun runs to
   * a terminal/waiting status before the triggering call returns) — so any
   * run found `running` at boot is stuck and safe to resume from its
   * persisted currentStepIndex. Called once from main.ts on startup, which
   * is what turns the persisted WorkflowRun table into a real durable job
   * queue: work survives a process restart instead of being silently lost. */
  async recoverStuckRuns(): Promise<WorkflowRun[]> {
    const stuck = await this.repos.runs.findAll((r) => r.status === 'running');
    const results: WorkflowRun[] = [];
    for (const run of stuck) {
      results.push(await this.executeRun(run.id));
    }
    return results;
  }

  /** Company-wide execution monitoring — counts across workflows, runs, and
   * pending approvals, for a dashboard summary view. */
  async getStats(companyId: string): Promise<AutomationStats> {
    const [workflows, runs, approvals] = await Promise.all([
      this.repos.workflows.findAll((w) => w.companyId === companyId),
      this.repos.runs.findAll((r) => r.companyId === companyId),
      this.repos.approvals.findAll((a) => a.companyId === companyId && a.status === 'pending'),
    ]);
    const count = <T,>(items: T[], pred: (item: T) => boolean) => items.filter(pred).length;
    return {
      totalWorkflows: workflows.length,
      activeWorkflows: count(workflows, (w) => w.status === 'active'),
      pausedWorkflows: count(workflows, (w) => w.status === 'paused'),
      archivedWorkflows: count(workflows, (w) => w.status === 'archived'),
      totalRuns: runs.length,
      runningRuns: count(runs, (r) => r.status === 'running'),
      waitingApprovalRuns: count(runs, (r) => r.status === 'waiting_approval'),
      completedRuns: count(runs, (r) => r.status === 'completed'),
      failedRuns: count(runs, (r) => r.status === 'failed'),
      cancelledRuns: count(runs, (r) => r.status === 'cancelled'),
      pendingApprovals: approvals.length,
    };
  }

  private async requirePermission(actorUserId: string, action: WorkflowActionConfig, companyId: string, ownerUserId?: string): Promise<void> {
    const resource = ACTION_RESOURCE[action.type];
    const verb = ACTION_VERB[action.type];
    const allowed = await this.rbac.can(actorUserId, verb, resource, { companyId, ownerUserId });
    if (!allowed) throw new ForbiddenError(`workflow owner lacks ${verb}:${resource} permission required for this step`);
  }

  /**
   * The single action-executor dispatcher, used both by workflow step
   * execution (executeRun, below) and by direct, ad-hoc invocation
   * (executeActionDirect, below — the AI Execution Layer's only way to
   * actually perform an action). There is exactly one code path that
   * touches CrmService/CommunicationService/TaskService/MarketingService on
   * an action's behalf; nothing — not a workflow step, not an AI action —
   * bypasses the permission check each case performs before mutating
   * anything.
   */
  private async executeAction(action: WorkflowActionConfig, ctx: ActionExecutionContext): Promise<Record<string, unknown>> {
    const params = this.resolveTemplate(action.params, ctx.triggerPayload) as Record<string, unknown>;
    const actorUserId = ctx.actorUserId;
    const companyId = ctx.companyId;

    switch (action.type) {
      case 'create_task': {
        await this.requirePermission(actorUserId, action, companyId, actorUserId);
        const title = this.requireString(params.title, 'title');
        const task = await this.tasks.createTask({
          companyId,
          title,
          description: this.optionalString(params.description),
          dueAt: this.optionalString(params.dueAt),
          assignedToUserId: this.optionalString(params.assignedToUserId),
          relatedResource: params.relatedResource as MessageRelatedResource | undefined,
          relatedResourceId: this.optionalString(params.relatedResourceId),
          createdByUserId: actorUserId,
        });
        return { taskId: task.id };
      }
      case 'create_lead': {
        await this.requirePermission(actorUserId, action, companyId, actorUserId);
        const fullName = this.requireString(params.fullName, 'fullName');
        const phone = this.requireString(params.phone, 'phone');
        const lead = await this.crm.createLead({
          companyId,
          fullName,
          phone,
          email: this.optionalString(params.email),
          sourceId: this.optionalString(params.sourceId),
          ownerEmployeeUserId: this.optionalString(params.ownerEmployeeUserId) ?? actorUserId,
        });
        return { leadId: lead.id };
      }
      case 'send_message': {
        await this.requirePermission(actorUserId, action, companyId, actorUserId);
        const subject = this.requireString(params.subject, 'subject');
        const body = this.requireString(params.body, 'body');
        const message = await this.communication.sendMessage({
          companyId,
          fromUserId: actorUserId,
          toUserId: this.optionalString(params.toUserId),
          subject,
          body,
          channel: params.channel as MessageChannel | undefined,
          relatedResource: params.relatedResource as MessageRelatedResource | undefined,
          relatedResourceId: this.optionalString(params.relatedResourceId),
        });
        return { messageId: message.id };
      }
      case 'update_lead_status': {
        const leadId = this.requireString(params.leadId, 'leadId');
        const lead = await this.crm.getLead(leadId);
        if (!lead || lead.companyId !== companyId) throw new AutomationError('lead not found for this company', 404);
        await this.requirePermission(actorUserId, action, companyId, lead.ownerEmployeeUserId);
        const status = this.requireString(params.status, 'status') as LeadStatus;
        const updated = await this.crm.updateStatus(leadId, status, this.optionalString(params.lostReason));
        return { leadId: updated.id, status: updated.status };
      }
      case 'assign_lead_owner': {
        const leadId = this.requireString(params.leadId, 'leadId');
        const ownerEmployeeUserId = this.requireString(params.ownerEmployeeUserId, 'ownerEmployeeUserId');
        const lead = await this.crm.getLead(leadId);
        if (!lead || lead.companyId !== companyId) throw new AutomationError('lead not found for this company', 404);
        await this.requirePermission(actorUserId, action, companyId, lead.ownerEmployeeUserId);
        const updated = await this.crm.assignOwner(leadId, companyId, ownerEmployeeUserId);
        return { leadId: updated.id, ownerEmployeeUserId: updated.ownerEmployeeUserId };
      }
      case 'update_campaign_status': {
        const campaignId = this.requireString(params.campaignId, 'campaignId');
        const campaign = await this.marketing.getCampaign(campaignId);
        if (!campaign || campaign.companyId !== companyId) throw new AutomationError('campaign not found for this company', 404);
        await this.requirePermission(actorUserId, action, companyId);
        const status = this.requireString(params.status, 'status') as CampaignStatus;
        const updated = await this.marketing.updateStatus(campaignId, companyId, status);
        return { campaignId: updated.id, status: updated.status };
      }
      case 'webhook_call': {
        await this.requirePermission(actorUserId, action, companyId);
        const url = this.requireString(params.url, 'url');
        const method = this.optionalString(params.method) ?? 'POST';
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (params.headers && typeof params.headers === 'object') {
          for (const [key, headerValue] of Object.entries(params.headers as Record<string, unknown>)) {
            headers[key] = String(headerValue);
          }
        }
        const secretKey = this.optionalString(params.secretKey);
        if (secretKey) {
          const token = await this.getDecryptedSecret(companyId, secretKey);
          if (!token) throw new AutomationError(`secret "${secretKey}" not found`);
          headers.Authorization = `Bearer ${token}`;
        }
        const response = await this.fetchImpl(url, {
          method,
          headers,
          body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
        });
        if (!response.ok) throw new AutomationError(`webhook call failed with status ${response.status}`, 502);
        return { status: response.status };
      }
      case 'integration_call': {
        await this.requirePermission(actorUserId, action, companyId, actorUserId);
        if (!this.integrationSender) throw new AutomationError('no integration sender is configured for this deployment');
        const provider = this.requireString(params.provider, 'provider');
        const integrationAction = this.requireString(params.action, 'action');
        return this.integrationSender(companyId, provider, integrationAction, params, actorUserId);
      }
      case 'ai_decide': {
        await this.requirePermission(actorUserId, action, companyId, actorUserId);
        if (!this.aiDecider) throw new AutomationError('no AI decider is configured for this deployment');
        const agentKey = this.requireString(params.agentKey, 'agentKey');
        const subjectId = this.requireString(params.subjectId, 'subjectId');
        const decision = await this.aiDecider(companyId, agentKey, subjectId, actorUserId);
        return { ...decision };
      }
      default:
        throw new AutomationError(`unsupported action type: ${(action as WorkflowActionConfig).type}`);
    }
  }

  private async recordStepRun(
    run: WorkflowRun,
    step: WorkflowStepDefinition,
    status: StepRunStatus,
    output?: Record<string, unknown>,
    error?: string,
    attempts = 1,
  ): Promise<WorkflowStepRun> {
    const stepRun: WorkflowStepRun = {
      id: randomUUID(),
      companyId: run.companyId,
      runId: run.id,
      stepId: step.id,
      status,
      attempts,
      output,
      error,
      startedAt: new Date().toISOString(),
      finishedAt: status === 'waiting_approval' ? undefined : new Date().toISOString(),
    };
    return this.repos.stepRuns.save(stepRun);
  }

  private async advanceRun(run: WorkflowRun, nextIndex: number): Promise<WorkflowRun> {
    return this.repos.runs.save({ ...run, currentStepIndex: nextIndex });
  }

  private async finishRun(run: WorkflowRun, status: 'completed' | 'failed' | 'cancelled', error?: string): Promise<WorkflowRun> {
    return this.repos.runs.save({ ...run, status, error, finishedAt: new Date().toISOString() });
  }

  // ---- Approvals ----

  async listApprovals(companyId: string, status?: ApprovalStatus): Promise<ApprovalRequest[]> {
    return this.repos.approvals.findAll((a) => a.companyId === companyId && (!status || a.status === status));
  }

  async approveStep(approvalId: string, companyId: string, approverUserId: string): Promise<WorkflowRun> {
    const approval = await this.getPendingApproval(approvalId, companyId);
    if (!(await this.rbac.can(approverUserId, 'approve', 'approval', { companyId }))) {
      throw new ForbiddenError('missing approve:approval permission');
    }

    let run = await this.repos.runs.findById(approval.runId);
    if (!run || run.companyId !== companyId) throw new NotFoundError('run not found');
    const workflow = await this.repos.workflows.findById(run.workflowId);
    if (!workflow) throw new NotFoundError('workflow not found');
    const step = workflow.steps.find((s) => s.id === approval.stepId);
    if (!step) throw new NotFoundError('step not found');

    await this.repos.approvals.save({ ...approval, status: 'approved', decidedByUserId: approverUserId, decidedAt: new Date().toISOString() });
    await this.resolveWaitingStepRun(run.id, step.id, 'succeeded');

    run = await this.repos.runs.save({ ...run, status: 'running', currentStepIndex: run.currentStepIndex + 1 });
    return this.executeRun(run.id);
  }

  async rejectStep(approvalId: string, companyId: string, approverUserId: string, reason?: string): Promise<WorkflowRun> {
    const approval = await this.getPendingApproval(approvalId, companyId);
    if (!(await this.rbac.can(approverUserId, 'approve', 'approval', { companyId }))) {
      throw new ForbiddenError('missing approve:approval permission');
    }

    let run = await this.repos.runs.findById(approval.runId);
    if (!run || run.companyId !== companyId) throw new NotFoundError('run not found');
    const workflow = await this.repos.workflows.findById(run.workflowId);
    const step = workflow?.steps.find((s) => s.id === approval.stepId);
    const rejectionReason = reason?.trim() || 'rejected by approver';

    await this.repos.approvals.save({ ...approval, status: 'rejected', decidedByUserId: approverUserId, decidedAt: new Date().toISOString() });
    if (step) await this.resolveWaitingStepRun(run.id, step.id, 'failed', rejectionReason);

    run = await this.repos.runs.save({ ...run, status: 'cancelled', error: rejectionReason, finishedAt: new Date().toISOString() });
    return run;
  }

  private async getPendingApproval(approvalId: string, companyId: string): Promise<ApprovalRequest> {
    const approval = await this.repos.approvals.findById(approvalId);
    if (!approval || approval.companyId !== companyId) throw new NotFoundError('approval request not found');
    if (approval.status !== 'pending') throw new AutomationError(`approval request already ${approval.status}`);
    return approval;
  }

  private async resolveWaitingStepRun(runId: string, stepId: string, status: 'succeeded' | 'failed', error?: string): Promise<void> {
    const waiting = await this.repos.stepRuns.findAll((sr) => sr.runId === runId && sr.stepId === stepId && sr.status === 'waiting_approval');
    const latest = waiting[waiting.length - 1];
    if (latest) await this.repos.stepRuns.save({ ...latest, status, error, finishedAt: new Date().toISOString() });
  }

  // ---- Secrets ----

  async setSecret(companyId: string, key: string, value: string, createdByUserId: string): Promise<SecretMetadata> {
    if (!key?.trim()) throw new ValidationError('key is required');
    if (!value?.trim()) throw new ValidationError('value is required');
    const trimmedKey = key.trim();
    const existing = (await this.repos.secrets.findAll((s) => s.companyId === companyId && s.key === trimmedKey))[0];
    const encrypted = encryptSecret(value, this.encryptionSecret);
    const secret: Secret = {
      id: existing?.id ?? randomUUID(),
      companyId,
      key: trimmedKey,
      encryptedValue: encrypted.encryptedValue,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      createdByUserId,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    const saved = await this.repos.secrets.save(secret);
    return this.toSecretMetadata(saved);
  }

  async listSecrets(companyId: string): Promise<SecretMetadata[]> {
    const all = await this.repos.secrets.findAll((s) => s.companyId === companyId);
    return all.map((s) => this.toSecretMetadata(s));
  }

  /** Blocks deleting a secret that an active workflow's webhook_call step
   * still references, unless `force` is passed — a previously-unfixed gap
   * where deleting a secret silently broke any workflow using it at its
   * next run, with no warning until the run failed. */
  async deleteSecret(id: string, companyId: string, force = false): Promise<void> {
    const secret = await this.repos.secrets.findById(id);
    if (!secret || secret.companyId !== companyId) throw new NotFoundError('secret not found');
    if (!force) {
      const referencing = await this.workflowsReferencingSecret(companyId, secret.key);
      if (referencing.length > 0) {
        throw new AutomationError(
          `secret "${secret.key}" is referenced by active workflow(s): ${referencing.map((w) => w.name).join(', ')}. Pass force=true to delete anyway.`,
        );
      }
    }
    await this.repos.secrets.deleteById(id);
  }

  private async workflowsReferencingSecret(companyId: string, secretKey: string): Promise<WorkflowDefinition[]> {
    const workflows = await this.repos.workflows.findAll((w) => w.companyId === companyId && w.status === 'active');
    return workflows.filter((w) =>
      w.steps.some((step) => step.action.type === 'webhook_call' && step.action.params.secretKey === secretKey),
    );
  }

  private toSecretMetadata(secret: Secret): SecretMetadata {
    const { encryptedValue, iv, authTag, ...meta } = secret;
    void encryptedValue;
    void iv;
    void authTag;
    return meta;
  }

  /** Public so other modules that legitimately need a stored credential —
   * currently the Integration Layer's connector adapters — can reuse this
   * same encrypted store instead of building a second one. Still never
   * exposed over HTTP: no route returns a decrypted value. */
  async getDecryptedSecret(companyId: string, key: string): Promise<string | undefined> {
    const secret = (await this.repos.secrets.findAll((s) => s.companyId === companyId && s.key === key))[0];
    if (!secret) return undefined;
    return decryptSecret({ encryptedValue: secret.encryptedValue, iv: secret.iv, authTag: secret.authTag }, this.encryptionSecret);
  }
}
