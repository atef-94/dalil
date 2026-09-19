import { randomUUID } from 'node:crypto';
import type {
  ActionName,
  AgentAlternative,
  AgentDecision,
  AgentDecisionStatus,
  AiActionRequest,
  AiActionStatus,
  AiAutonomyLevel,
  AiPolicy,
  ApprovalRequest,
  AutomationActionType,
  Lead,
  ResourceName,
} from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { AuditLog } from '../../infra/audit-log.js';
import { AutomationError, ForbiddenError, NotFoundError, ValidationError } from '../../infra/errors.js';
import { RbacEvaluator } from '../permissions/rbac.evaluator.js';
import { ACTION_RESOURCE, ACTION_VERB, AutomationService } from '../automation/automation.service.js';
import { CrmService } from '../crm/crm.service.js';
import type { CrmStageService } from '../crm/crm-stage.service.js';
import { MarketingService } from '../marketing/marketing.service.js';
import { OperationsService } from '../operations/operations.service.js';
import { HrService } from '../hr/hr.service.js';
import { FinanceService } from '../finance/finance.service.js';
import { IntegrationService } from '../integrations/integration.service.js';
import { LeadScoringService } from './lead-scoring.service.js';
import { LegalService } from '../legal/legal.service.js';
import { BrokersService } from '../brokers/brokers.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { AnalyticsService } from '../analytics/analytics.service.js';

export interface AiRepos {
  actionRequests: Repository<AiActionRequest>;
  policies: Repository<AiPolicy>;
  approvals: Repository<ApprovalRequest>;
  agentDecisions: Repository<AgentDecision>;
}

// ---- Tool Registry ----
// Every AI action executes through one of these registered tools — this is
// the single catalogue a human building a workflow, an agent's own decision
// explanation, or the frontend consults to answer "what can the AI/
// Automation Engine do, under what conditions?". `requiredPermission` is
// not a second, hand-maintained copy of the authority check: it's read
// directly from automation.service.ts's exported ACTION_RESOURCE/
// ACTION_VERB maps below, the exact same maps
// AutomationService.canPerformAction()/executeAction() enforce at
// execution time, so the two can never drift apart. `riskLevel` and
// `department` are the Phase 7 classification the spec asks for — real
// judgments about blast radius (an unscoped webhook call or a financial
// record change is 'high'; an internal task/message is 'low'), not
// decoration. `approvalRequired` reflects this deployment's default
// policy (every action defaults to AiPolicy 'require_approval' unless a
// company explicitly opts it into auto_execute — see autonomyFor) rather
// than a fixed flag, since the real gate is configurable per company.
// `auditRequired` is always true: every AiActionRequest, whatever its
// outcome, is unconditionally written to AuditLog (see persist()).
export interface ToolDefinition {
  actionType: AutomationActionType;
  name: string;
  description: string;
  requiredParams: string[];
  requiredPermission: { action: ActionName; resource: ResourceName };
  department: string;
  riskLevel: 'low' | 'medium' | 'high';
  approvalRequired: boolean;
  auditRequired: true;
}

interface ToolSpec {
  actionType: AutomationActionType;
  name: string;
  description: string;
  requiredParams: string[];
  department: string;
  riskLevel: 'low' | 'medium' | 'high';
}

const TOOL_SPECS: ToolSpec[] = [
  { actionType: 'create_task', name: 'Create Task', description: 'Creates a task/reminder/follow-up.', requiredParams: ['title'], department: 'Cross-department', riskLevel: 'low' },
  { actionType: 'create_lead', name: 'Create Lead', description: 'Creates a new CRM lead.', requiredParams: ['fullName', 'phone'], department: 'CRM / Sales', riskLevel: 'low' },
  { actionType: 'send_message', name: 'Send Message', description: 'Sends an internal message/notification.', requiredParams: ['subject', 'body'], department: 'Cross-department', riskLevel: 'low' },
  { actionType: 'update_lead_status', name: 'Move Lead Stage', description: 'Moves a lead to a different CRM pipeline stage.', requiredParams: ['leadId', 'stageId'], department: 'CRM / Sales', riskLevel: 'medium' },
  { actionType: 'assign_lead_owner', name: 'Assign Lead Owner', description: 'Reassigns a lead to a different owner.', requiredParams: ['leadId', 'ownerEmployeeUserId'], department: 'CRM / Sales', riskLevel: 'medium' },
  { actionType: 'update_campaign_status', name: 'Update Campaign Status', description: "Changes a marketing campaign's status.", requiredParams: ['campaignId', 'status'], department: 'Marketing', riskLevel: 'medium' },
  { actionType: 'webhook_call', name: 'Call Webhook', description: 'Calls an external webhook/API endpoint using a stored secret.', requiredParams: ['url'], department: 'Automation / Integrations', riskLevel: 'high' },
  { actionType: 'integration_call', name: 'Send via Integration', description: 'Sends a message through a connected external provider (WhatsApp, Email, etc).', requiredParams: ['provider', 'action'], department: 'Automation / Integrations', riskLevel: 'medium' },
  { actionType: 'ai_decide', name: 'Delegate to AI Agent', description: 'Hands a subject off to a specialized AI agent to decide and execute its own next step.', requiredParams: ['agentKey', 'subjectId'], department: 'AI / Automation', riskLevel: 'medium' },
  { actionType: 'require_approval', name: 'Require Approval', description: 'Pauses for human approval (workflow steps only).', requiredParams: [], department: 'Cross-department', riskLevel: 'low' },
  { actionType: 'record_payment', name: 'Record Payment', description: 'Records a payment against a contract schedule line.', requiredParams: ['contractId', 'paymentScheduleLineId', 'amount', 'method'], department: 'Finance', riskLevel: 'high' },
  { actionType: 'cancel_contract', name: 'Cancel Contract', description: 'Cancels a signed contract and releases its reserved unit.', requiredParams: ['contractId'], department: 'Sales / Finance / Legal', riskLevel: 'high' },
];

const TOOL_REGISTRY: ToolDefinition[] = TOOL_SPECS.map((spec) => ({
  ...spec,
  requiredPermission: { action: ACTION_VERB[spec.actionType], resource: ACTION_RESOURCE[spec.actionType] },
  // Mirrors this deployment's real default: every action type starts at
  // AiPolicy 'require_approval' until a company explicitly opts it into
  // auto_execute (see autonomyFor) — so "approval required" is the
  // correct default classification for every tool, not a per-tool guess.
  approvalRequired: true,
  auditRequired: true,
}));

interface AgentDecisionResult {
  chosenActionType?: AutomationActionType;
  params?: Record<string, unknown>;
  confidence: number;
  reasoning: string;
  alternatives: AgentAlternative[];
  /** The real owner of the subject this action is about (e.g. a lead's
   * ownerEmployeeUserId), when the subject has one. Threaded through to
   * requestAction()/canPerformAction() so an 'own'-scoped RBAC grant (the
   * realistic case for an individual contributor acting on their own
   * lead/ticket/etc.) can actually match — without it, only company- or
   * department-wide grants could ever pass the permission check. */
  ownerUserId?: string;
}

export interface AgentDefinition {
  key: string;
  name: string;
  businessFunction: string;
  /** What this agent is trying to accomplish — shown alongside its
   * decisions so a human reviewing the history understands the intent,
   * not just the mechanics. */
  goal: string;
  subjectType: string;
  /** The agent's own boundary: even when the requesting human's RBAC
   * grants and the company's AiPolicy would both permit more, this agent
   * will never choose an action type outside this list — a decision that
   * would fall outside it is escalated instead of proceeding. */
  allowedActionTypes: AutomationActionType[];
  /** Below this confidence (0-100), the agent escalates to a human instead
   * of even attempting the action — independent of and prior to the
   * permission/policy/approval pipeline. */
  escalateBelowConfidence: number;
}

export interface RequestAiActionInput {
  companyId: string;
  /** The human this action is performed on behalf of — every RBAC and
   * AuditLog check runs as this user, never as "the AI" itself. */
  requestedByUserId: string;
  actionType: AutomationActionType;
  params: Record<string, unknown>;
  reasoning?: string;
  /** The real owner of the resource this action targets, when it has one
   * (e.g. a lead's ownerEmployeeUserId). Passed through to
   * AutomationService.canPerformAction() so 'own'-scoped RBAC grants can
   * match; omitted when the subject has no natural single owner. */
  ownerUserId?: string;
}

const APPROVAL_STEP_ID = 'ai-action';

/**
 * The AI Execution Layer. AI in ACTIVE is not limited to analysis or
 * recommendations — this service lets it actually perform CRM, messaging,
 * task, and campaign actions on a human's behalf. It never has its own
 * execution path: every action is dispatched through
 * AutomationService.executeActionDirect(), the exact same
 * executeAction() switch that workflow steps use, so an AI-requested
 * `update_lead_status` and a workflow-triggered `update_lead_status` are
 * indistinguishable to the executor and get identical RBAC enforcement.
 *
 * The pipeline for every single request, no exceptions:
 *   1. Permission  — does `requestedByUserId` hold the RBAC grant this
 *      action type needs? (AutomationService.canPerformAction)
 *   2. Policy      — what has this company allowed the AI to do
 *      autonomously for this action type? (AiPolicy.autonomyLevel,
 *      defaulting to 'require_approval' when unset)
 *   3. Approval    — if policy requires it, the action pauses as a
 *      pending ApprovalRequest until a human with approve:approval
 *      decides it (the same ApprovalRequest entity/table the Automation
 *      Engine's workflow approvals use).
 *   4. Audit       — every request, whatever the outcome, is persisted as
 *      an AiActionRequest and written to AuditLog with an
 *      `executedByAI: true` marker, so the full decision trail (who, what,
 *      why, and what the policy/permission engine decided) survives.
 *
 * Nothing here can auto-execute an action a company hasn't explicitly
 * opted into via AiPolicy, and nothing here can act with more authority
 * than the human it's acting on behalf of already has.
 */
export class AiAgentService {
  private readonly agents: Record<string, AgentDefinition>;

  constructor(
    private readonly repos: AiRepos,
    private readonly rbac: RbacEvaluator,
    private readonly automation: AutomationService,
    private readonly crm: CrmService,
    private readonly crmStages: CrmStageService,
    private readonly leadScoring: LeadScoringService,
    private readonly auditLog: AuditLog,
    private readonly marketing: MarketingService,
    private readonly operations: OperationsService,
    private readonly hr: HrService,
    private readonly finance: FinanceService,
    private readonly integrations: IntegrationService,
    private readonly legal: LegalService,
    private readonly brokers: BrokersService,
    private readonly inventory: InventoryService,
    private readonly analytics: AnalyticsService,
  ) {
    this.agents = {
      sales: {
        key: 'sales',
        name: 'Sales Agent',
        businessFunction: 'Sales',
        goal: 'Advance qualified leads through the funnel and keep unqualified ones from going cold.',
        subjectType: 'lead',
        allowedActionTypes: ['update_lead_status', 'assign_lead_owner', 'create_task', 'send_message', 'integration_call'],
        escalateBelowConfidence: 20,
      },
      marketing: {
        key: 'marketing',
        name: 'Marketing Agent',
        businessFunction: 'Marketing',
        goal: 'Flag underperforming campaigns for review before budget is wasted on them.',
        subjectType: 'campaign',
        allowedActionTypes: ['create_task', 'update_campaign_status'],
        escalateBelowConfidence: 20,
      },
      finance: {
        key: 'finance',
        name: 'Finance Agent',
        businessFunction: 'Finance',
        goal: 'Get overdue payments a timely collections follow-up.',
        subjectType: 'payment_schedule_line',
        allowedActionTypes: ['create_task', 'send_message'],
        escalateBelowConfidence: 20,
      },
      support: {
        key: 'support',
        name: 'Customer Service Agent',
        businessFunction: 'Customer Service / Operations',
        goal: 'Make sure urgent or long-unassigned maintenance tickets get picked up promptly.',
        subjectType: 'maintenance_ticket',
        allowedActionTypes: ['create_task', 'send_message'],
        escalateBelowConfidence: 20,
      },
      hr: {
        key: 'hr',
        name: 'HR Agent',
        businessFunction: 'HR',
        goal: 'Nudge managers on leave requests that have sat pending too long.',
        subjectType: 'leave_request',
        allowedActionTypes: ['create_task', 'send_message'],
        escalateBelowConfidence: 20,
      },
      legal: {
        key: 'legal',
        name: 'Legal Agent',
        businessFunction: 'Legal',
        goal: 'Keep contract-required legal documents from stalling in "pending" or unverified "received" states.',
        subjectType: 'legal_document',
        allowedActionTypes: ['create_task', 'send_message'],
        escalateBelowConfidence: 20,
      },
      broker: {
        key: 'broker',
        name: 'Broker Agent',
        businessFunction: 'Broker / B2B',
        goal: 'Flag broker-submitted leads awaiting the quarantine review too long — never auto-approves one itself, since that decision is a deliberate fraud/duplicate-prevention control.',
        subjectType: 'broker_lead',
        allowedActionTypes: ['create_task', 'send_message'],
        escalateBelowConfidence: 20,
      },
      inventory: {
        key: 'inventory',
        name: 'Project & Inventory Agent',
        businessFunction: 'Projects & Inventory',
        goal: 'Surface units that have sat available with no reservation activity for an unusually long time.',
        subjectType: 'unit',
        allowedActionTypes: ['create_task'],
        escalateBelowConfidence: 20,
      },
      management: {
        key: 'management',
        name: 'Management Intelligence Agent',
        businessFunction: 'Management',
        goal: "Give leadership an early flag when company-wide collections risk (overdue vs. tracked receivables) crosses a concerning threshold — a cross-department read, not a single record.",
        subjectType: 'company',
        allowedActionTypes: ['create_task'],
        escalateBelowConfidence: 20,
      },
    };
  }

  async requestAction(input: RequestAiActionInput): Promise<AiActionRequest> {
    if (!input.actionType) throw new ValidationError('actionType is required');

    // Real runtime input-schema enforcement against the Tool Registry
    // (Phase 7) — not just descriptive metadata: a call missing a
    // required parameter is caught here, before any permission/policy
    // work, rather than surfacing later as an opaque executor error.
    // Persisted (never thrown) so this follows the same contract every
    // other validation failure in this method does: requestAction()
    // always resolves to an audited AiActionRequest, never throws — every
    // caller (decide(), AiWorkflowService, the /api/ai/actions route)
    // relies on that to record/escalate cleanly instead of crashing.
    const missingParams = this.missingRequiredParams(input.actionType, input.params);
    if (missingParams.length > 0) {
      return this.persist(input, 'denied_policy', `tool "${input.actionType}" is missing required parameter(s): ${missingParams.join(', ')}`);
    }

    const permitted = await this.automation.canPerformAction(input.requestedByUserId, input.actionType, input.companyId, input.ownerUserId);
    if (!permitted) {
      return this.persist(input, 'denied_permission');
    }

    const autonomy = await this.autonomyFor(input.companyId, input.actionType);

    if (autonomy === 'suggest_only') {
      return this.persist(input, 'suggested');
    }

    if (autonomy === 'require_approval') {
      const request = await this.persist(input, 'pending_approval');
      const approval: ApprovalRequest = {
        id: randomUUID(),
        companyId: input.companyId,
        runId: request.id,
        stepId: APPROVAL_STEP_ID,
        reason: input.reasoning?.trim() || `AI requests approval to ${input.actionType}`,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      await this.repos.approvals.save(approval);
      return this.repos.actionRequests.save({ ...request, approvalRequestId: approval.id });
    }

    // autonomy === 'auto_execute'
    try {
      const output = await this.automation.executeActionDirect(input.companyId, input.requestedByUserId, {
        type: input.actionType,
        params: input.params,
      });
      const executed = await this.persist(input, 'executed');
      await this.auditLog.record({
        companyId: input.companyId,
        actorUserId: input.requestedByUserId,
        action: 'execute',
        resource: 'ai_action',
        resourceId: executed.id,
        metadata: { actionType: input.actionType, executedByAI: true, autoExecuted: true, output },
      });
      return executed;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return this.persist(input, 'denied_policy', reason);
    }
  }

  async approveAction(approvalId: string, companyId: string, approverUserId: string): Promise<AiActionRequest> {
    const approval = await this.getPendingApproval(approvalId, companyId);
    if (!(await this.rbac.can(approverUserId, 'approve', 'approval', { companyId }))) {
      throw new ForbiddenError('missing approve:approval permission');
    }
    const request = await this.repos.actionRequests.findById(approval.runId);
    if (!request || request.companyId !== companyId) throw new NotFoundError('AI action request not found');

    await this.repos.approvals.save({ ...approval, status: 'approved', decidedByUserId: approverUserId, decidedAt: new Date().toISOString() });

    try {
      const output = await this.automation.executeActionDirect(companyId, request.requestedByUserId, {
        type: request.actionType,
        params: request.params,
      });
      const executed = await this.repos.actionRequests.save({ ...request, status: 'executed' });
      await this.auditLog.record({
        companyId,
        actorUserId: approverUserId,
        action: 'approve',
        resource: 'ai_action',
        resourceId: executed.id,
        metadata: { actionType: request.actionType, executedByAI: true, approvedBy: approverUserId, output },
      });
      return executed;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return this.repos.actionRequests.save({
        ...request,
        status: 'denied_policy',
        reasoning: `${request.reasoning ?? ''}${request.reasoning ? ' — ' : ''}execution failed after approval: ${reason}`.trim(),
      });
    }
  }

  async rejectAction(approvalId: string, companyId: string, approverUserId: string, reason?: string): Promise<AiActionRequest> {
    const approval = await this.getPendingApproval(approvalId, companyId);
    if (!(await this.rbac.can(approverUserId, 'approve', 'approval', { companyId }))) {
      throw new ForbiddenError('missing approve:approval permission');
    }
    const request = await this.repos.actionRequests.findById(approval.runId);
    if (!request || request.companyId !== companyId) throw new NotFoundError('AI action request not found');

    await this.repos.approvals.save({ ...approval, status: 'rejected', decidedByUserId: approverUserId, decidedAt: new Date().toISOString() });
    const denied = await this.repos.actionRequests.save({ ...request, status: 'denied_policy', reasoning: reason?.trim() || request.reasoning });
    await this.auditLog.record({
      companyId,
      actorUserId: approverUserId,
      action: 'approve',
      resource: 'ai_action',
      resourceId: denied.id,
      metadata: { rejected: true },
    });
    return denied;
  }

  /** Backward-compatible convenience wrapper around the Sales agent —
   * kept because the Leads page's "Ask AI" button and existing callers use
   * this exact signature. Delegates to the same orchestration engine every
   * other agent uses (decide()), not a separate/duplicate code path. */
  async suggestNextAction(leadId: string, companyId: string, requestedByUserId: string): Promise<AgentDecision> {
    return this.decide('sales', companyId, leadId, requestedByUserId);
  }

  // ---- Agent Orchestration ----

  listAgents(): Omit<AgentDefinition, never>[] {
    return Object.values(this.agents);
  }

  listTools(agentKey?: string): ToolDefinition[] {
    if (!agentKey) return TOOL_REGISTRY;
    const agent = this.agents[agentKey];
    if (!agent) throw new NotFoundError('unknown agent');
    return TOOL_REGISTRY.filter((t) => agent.allowedActionTypes.includes(t.actionType));
  }

  /**
   * Runs one specialized agent's decision for one subject, end to end:
   *   1. Memory — a still-relevant recent decision for this exact subject
   *      is returned as-is instead of re-deciding (avoids duplicate work
   *      from repeated "Ask AI" clicks).
   *   2. Decide — the agent's own deterministic rule set (grounded in real
   *      data via the relevant service — LeadScoringService, campaign
   *      performance, days-overdue, ticket age, etc. — never an external
   *      LLM call) produces a confidence-scored recommendation plus the
   *      alternatives it considered.
   *   3. Confidence gate — below the agent's escalateBelowConfidence, the
   *      decision is recorded as 'escalated' and nothing is attempted.
   *   4. Boundary gate — a chosen action outside the agent's own declared
   *      allowedActionTypes is also escalated, never attempted, even if
   *      the human/company would otherwise permit it.
   *   5. Execute — only past both gates does this call requestAction(),
   *      the same permission/policy/approval/audit pipeline every other AI
   *      action goes through.
   */
  async decide(agentKey: string, companyId: string, subjectId: string, requestedByUserId: string): Promise<AgentDecision> {
    const agent = this.agents[agentKey];
    if (!agent) throw new NotFoundError(`unknown agent: ${agentKey}`);

    const recent = await this.findRecentDecision(companyId, agentKey, subjectId);
    if (recent) return recent;

    const result = await this.runDecisionRules(agent, companyId, subjectId);

    if (!result.chosenActionType) {
      return this.persistDecision(agent, companyId, subjectId, requestedByUserId, 'no_action', result);
    }
    if (result.confidence < agent.escalateBelowConfidence) {
      return this.persistDecision(agent, companyId, subjectId, requestedByUserId, 'escalated', result);
    }
    if (!agent.allowedActionTypes.includes(result.chosenActionType)) {
      return this.persistDecision(agent, companyId, subjectId, requestedByUserId, 'escalated', {
        ...result,
        reasoning: `${result.reasoning} (chosen action "${result.chosenActionType}" is outside this agent's declared boundary)`,
      });
    }

    const request = await this.requestAction({
      companyId,
      requestedByUserId,
      actionType: result.chosenActionType,
      params: result.params ?? {},
      reasoning: result.reasoning,
      ownerUserId: result.ownerUserId,
    });
    const decision = await this.persistDecision(agent, companyId, subjectId, requestedByUserId, 'proceeded', result, request.id, request.status);
    return decision;
  }

  async listAgentDecisions(companyId: string, agentKey?: string): Promise<AgentDecision[]> {
    return this.repos.agentDecisions.findAll((d) => d.companyId === companyId && (!agentKey || d.agentKey === agentKey));
  }

  async getAgentDecision(id: string, companyId: string): Promise<AgentDecision> {
    const decision = await this.repos.agentDecisions.findById(id);
    if (!decision || decision.companyId !== companyId) throw new NotFoundError('agent decision not found');
    return decision;
  }

  async getAgentStats(companyId: string): Promise<Record<string, { total: number; proceeded: number; escalated: number; noAction: number }>> {
    const decisions = await this.repos.agentDecisions.findAll((d) => d.companyId === companyId);
    const stats: Record<string, { total: number; proceeded: number; escalated: number; noAction: number }> = {};
    for (const key of Object.keys(this.agents)) {
      stats[key] = { total: 0, proceeded: 0, escalated: 0, noAction: 0 };
    }
    for (const d of decisions) {
      const bucket = (stats[d.agentKey] ??= { total: 0, proceeded: 0, escalated: 0, noAction: 0 });
      bucket.total++;
      if (d.status === 'proceeded') bucket.proceeded++;
      else if (d.status === 'escalated') bucket.escalated++;
      else bucket.noAction++;
    }
    return stats;
  }

  /** A decision is still "live" (worth reusing instead of re-deciding)
   * within a cooldown window if it either needs human attention
   * ('escalated') or its resulting AiActionRequest hasn't reached a
   * terminal outcome yet ('suggested'/'pending_approval'). A decision
   * whose request was executed or denied is stale — the situation may
   * have changed, so the next decide() call re-evaluates from scratch. */
  /** A concrete "what happens next" string derived from this decision's
   * actual, already-known outcome — never a generic placeholder. */
  private nextRecommendedStepFor(status: AgentDecisionStatus, resultActionStatus: AiActionStatus | undefined, result: AgentDecisionResult): string {
    if (status === 'no_action') return 'No further action needed at this time.';
    if (status === 'escalated') return 'Needs human review — see the reasoning above before deciding manually.';
    // status === 'proceeded'
    switch (resultActionStatus) {
      case 'executed':
        return 'Action already executed automatically — monitor the outcome and re-run if the situation changes.';
      case 'pending_approval':
        return 'Awaiting a human approval decision in Approvals before this executes.';
      case 'suggested':
        return "This company's AI policy only suggests this action type — review it in AI Activity and act manually if appropriate.";
      case 'denied_permission':
        return 'Blocked: the requesting user lacks the required permission — grant it, or have an authorized user request this action.';
      case 'denied_policy':
        return 'Blocked by policy/validation — see the AI action request for the exact reason.';
      default:
        return result.alternatives[0]?.reasoning ?? 'Review the outcome in AI Activity.';
    }
  }

  private async findRecentDecision(companyId: string, agentKey: string, subjectId: string): Promise<AgentDecision | undefined> {
    const COOLDOWN_MS = 60 * 60 * 1000;
    const now = Date.now();
    const candidates = await this.repos.agentDecisions.findAll(
      (d) => d.companyId === companyId && d.agentKey === agentKey && d.subjectId === subjectId && now - Date.parse(d.createdAt) < COOLDOWN_MS,
    );
    const latest = candidates.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (!latest) return undefined;
    if (latest.status === 'escalated') return latest;
    if (latest.status === 'proceeded' && latest.aiActionRequestId) {
      const request = await this.repos.actionRequests.findById(latest.aiActionRequestId);
      if (request && (request.status === 'pending_approval' || request.status === 'suggested')) return latest;
    }
    return undefined;
  }

  private async persistDecision(
    agent: AgentDefinition,
    companyId: string,
    subjectId: string,
    requestedByUserId: string,
    status: AgentDecisionStatus,
    result: AgentDecisionResult,
    aiActionRequestId?: string,
    resultActionStatus?: AiActionStatus,
  ): Promise<AgentDecision> {
    const tool = result.chosenActionType ? TOOL_REGISTRY.find((t) => t.actionType === result.chosenActionType) : undefined;
    const approvalRequired = result.chosenActionType ? (await this.autonomyFor(companyId, result.chosenActionType)) !== 'auto_execute' : undefined;
    const decision: AgentDecision = {
      id: randomUUID(),
      companyId,
      agentKey: agent.key,
      subjectType: agent.subjectType,
      subjectId,
      chosenActionType: result.chosenActionType,
      params: result.params,
      confidence: result.confidence,
      reasoning: result.reasoning,
      alternatives: result.alternatives,
      status,
      aiActionRequestId,
      resultActionStatus,
      riskLevel: tool?.riskLevel,
      requiredPermission: tool?.requiredPermission,
      approvalRequired,
      nextRecommendedStep: this.nextRecommendedStepFor(status, resultActionStatus, result),
      requestedByUserId,
      createdAt: new Date().toISOString(),
    };
    const saved = await this.repos.agentDecisions.save(decision);
    await this.auditLog.record({
      companyId,
      actorUserId: requestedByUserId,
      action: 'create',
      resource: 'ai_action',
      resourceId: saved.id,
      metadata: { agentKey: agent.key, subjectType: agent.subjectType, subjectId, status, confidence: result.confidence, executedByAI: true },
    });
    return saved;
  }

  private async runDecisionRules(agent: AgentDefinition, companyId: string, subjectId: string): Promise<AgentDecisionResult> {
    switch (agent.key) {
      case 'sales':
        return this.decideSales(companyId, subjectId);
      case 'marketing':
        return this.decideMarketing(companyId, subjectId);
      case 'finance':
        return this.decideFinance(companyId, subjectId);
      case 'support':
        return this.decideSupport(companyId, subjectId);
      case 'hr':
        return this.decideHr(companyId, subjectId);
      case 'legal':
        return this.decideLegal(companyId, subjectId);
      case 'broker':
        return this.decideBroker(companyId, subjectId);
      case 'inventory':
        return this.decideInventory(companyId, subjectId);
      case 'management':
        return this.decideManagement(companyId, subjectId);
      default:
        throw new NotFoundError(`no decision rules registered for agent: ${agent.key}`);
    }
  }

  /** Sales Agent: turns LeadScoringService's deterministic score into a
   * concrete next action. Stage-agnostic by design (works against
   * whatever pipeline the company has configured, including custom
   * admin-added stages), not name-based: a lead already in an isWon/
   * isLost-flagged stage needs no further action; a lead at the last
   * non-terminal stage escalates to a human (no reliable signal for a
   * Won/Lost call); a lead in the company's default (Fresh Leads) stage
   * gets the original cross-module outreach treatment; every other
   * in-between stage gets the same "advance to the next stage or create
   * a follow-up task" rule the old 'contacted' branch used. This
   * generalizes what used to be three separate name-branches (new/
   * contacted/qualified) into one rule that scales to any pipeline
   * length. */
  private async decideSales(companyId: string, leadId: string): Promise<AgentDecisionResult> {
    const lead = await this.crm.getLead(leadId);
    if (!lead || lead.companyId !== companyId) throw new NotFoundError('lead not found');

    const stages = await this.crmStages.listStages(companyId, true);
    const stage = stages.find((s) => s.id === lead.stageId);
    if (!stage) throw new NotFoundError('lead has no valid CRM stage');

    if (stage.isWon || stage.isLost) {
      return { confidence: 100, reasoning: `Lead is already in "${stage.name}"; no further action needed.`, alternatives: [] };
    }

    const nonTerminalStages = stages.filter((s) => !s.isWon && !s.isLost && s.isActive).sort((a, b) => a.order - b.order);
    const currentIndex = nonTerminalStages.findIndex((s) => s.id === stage.id);
    const nextStage = currentIndex >= 0 ? nonTerminalStages[currentIndex + 1] : undefined;

    const score = await this.leadScoring.scoreLead(leadId, companyId);
    const factorSummary = score.factors.map((f) => f.label).join(', ') || 'no positive signals yet';
    const alternatives: AgentAlternative[] = [];

    if (!nextStage) {
      // Deliberately low confidence: whether a lead at the last stage
      // before Won/Lost is ready for that call isn't something the lead
      // score (a pipeline-position/recency/owner/source signal) has any
      // real basis to judge — this always escalates to a human.
      return {
        chosenActionType: 'create_task',
        params: { title: `Review lead ${lead.fullName} — ready to move past "${stage.name}"?`, relatedResource: 'lead', relatedResourceId: lead.id },
        confidence: 15,
        reasoning: `Lead is at the last stage before a Won/Lost decision ("${stage.name}") — recommend a human review; no reliable automatic signal for this transition.`,
        alternatives: [],
        ownerUserId: lead.ownerEmployeeUserId,
      };
    }

    // Thresholds are calibrated against the scorer's actual range: the
    // default (Fresh Leads) stage caps at 35/100 from stage weight alone,
    // every later stage caps at 60/100 — not round numbers.
    const denominator = stage.isDefault ? 35 : 60;
    const confidenceThreshold = stage.isDefault ? 50 : 60;
    const advanceConfidence = Math.min(95, Math.round((score.score / denominator) * 100));

    if (stage.isDefault && advanceConfidence >= confidenceThreshold) {
      // Cross-module reach-out: if the company has a connected WhatsApp or
      // Email integration and hasn't already messaged this lead, reaching
      // out directly through it is the concrete next action — the same
      // "AI selects a permitted next action -> WhatsApp/Email" step the
      // Lead AI Outreach workflow template demonstrates. This never fires
      // twice for the same lead (see hasAlreadyReachedOut), so the
      // *following* decide() call for this still-fresh lead falls through
      // to the ordinary stage-advance branch below.
      const channel = !(await this.hasAlreadyReachedOut(companyId, lead.id)) ? await this.pickOutreachChannel(companyId, lead) : undefined;
      if (channel) {
        alternatives.push({ actionType: 'update_lead_status', confidence: advanceConfidence, reasoning: `Could move directly to "${nextStage.name}" instead of reaching out first.` });
        const greeting = `Hi ${lead.fullName}, thanks for your interest — one of our agents will follow up with you shortly!`;
        return {
          chosenActionType: 'integration_call',
          params:
            channel === 'whatsapp'
              ? { provider: 'whatsapp', action: 'send_message', leadId: lead.id, to: lead.phone, body: greeting }
              : { provider: 'email', action: 'send_message', leadId: lead.id, to: lead.email, subject: 'Thanks for your interest', body: greeting },
          confidence: advanceConfidence,
          reasoning: `Lead score ${score.score}/100 (${factorSummary}) — confident enough to reach out directly via ${channel}.`,
          alternatives,
          ownerUserId: lead.ownerEmployeeUserId,
        };
      }
    }

    if (advanceConfidence >= confidenceThreshold) {
      alternatives.push({ actionType: 'create_task', confidence: 100 - advanceConfidence, reasoning: `Fallback: a manual follow-up task instead of advancing to "${nextStage.name}" automatically.` });
      return {
        chosenActionType: 'update_lead_status',
        params: { leadId, stageId: nextStage.id },
        confidence: advanceConfidence,
        reasoning: `Lead score ${score.score}/100 (${factorSummary}) — confident enough to move to "${nextStage.name}".`,
        alternatives,
        ownerUserId: lead.ownerEmployeeUserId,
      };
    }
    alternatives.push({ actionType: 'update_lead_status', confidence: advanceConfidence, reasoning: `Could move directly to "${nextStage.name}", but the score is not yet strong enough.` });
    return {
      chosenActionType: 'create_task',
      params: { title: `Follow up with ${lead.fullName}`, relatedResource: 'lead', relatedResourceId: lead.id },
      confidence: 100 - advanceConfidence,
      reasoning: `Lead score ${score.score}/100 (${factorSummary}) — not confident enough to auto-advance; recommend manual follow-up.`,
      alternatives,
      ownerUserId: lead.ownerEmployeeUserId,
    };
  }

  /** Picks the channel a new lead should be reached out on, preferring
   * WhatsApp (more immediate) over Email — but only when the company has
   * an active connection for it (status !== 'disconnected'; an 'error'
   * connection is still worth retrying) and the lead actually has the
   * matching contact field. Returns undefined when neither is available,
   * so the caller falls back to its ordinary internal status-only path. */
  private async pickOutreachChannel(companyId: string, lead: Lead): Promise<'whatsapp' | 'email' | undefined> {
    const connections = await this.integrations.listConnections(companyId);
    const isActive = (provider: string) => connections.some((c) => c.provider === provider && c.status !== 'disconnected');
    if (lead.phone && isActive('whatsapp')) return 'whatsapp';
    if (lead.email && isActive('email')) return 'email';
    return undefined;
  }

  /** A lead is only ever reached out to once automatically — checked
   * against the Integration Layer's own delivery log (IntegrationEvent
   * already records the lead id as a safe, non-sensitive identifier for
   * exactly this kind of lookup). Without this, re-running decide() on a
   * lead that's still 'new' (e.g. a second "Ask AI" click before the
   * status has had a chance to change) would message the same customer
   * again. */
  private async hasAlreadyReachedOut(companyId: string, leadId: string): Promise<boolean> {
    const events = await this.integrations.listEvents(companyId);
    return events.some((e) => e.requestSummary?.leadId === leadId);
  }

  /** Marketing Agent: flags a campaign whose attributed leads have real
   * volume but poor conversion — a signal worth a human review before more
   * budget goes toward it. Never auto-cancels a campaign on its own; that
   * risk is called out explicitly in the recorded alternative. */
  private async decideMarketing(companyId: string, campaignId: string): Promise<AgentDecisionResult> {
    const campaign = await this.marketing.getCampaign(campaignId);
    if (!campaign || campaign.companyId !== companyId) throw new NotFoundError('campaign not found');
    if (campaign.status !== 'active') {
      return { confidence: 100, reasoning: `Campaign is ${campaign.status}; no action needed.`, alternatives: [] };
    }
    const perf = await this.marketing.campaignPerformance(campaignId, companyId);
    if (perf.leadCount >= 10 && perf.conversionRate < 10) {
      return {
        chosenActionType: 'create_task',
        params: { title: `Review underperforming campaign "${campaign.name}" (${perf.conversionRate}% conversion)`, relatedResource: 'campaign', relatedResourceId: campaign.id },
        confidence: 75,
        reasoning: `${perf.leadCount} leads attributed with only ${perf.conversionRate}% conversion — recommend a performance review.`,
        alternatives: [{ actionType: 'update_campaign_status', confidence: 30, reasoning: 'Could pause the campaign outright, but that risks losing legitimately slow-building leads — a review task is safer.' }],
      };
    }
    return {
      confidence: 90,
      reasoning: `Campaign performance (${perf.conversionRate}% conversion across ${perf.leadCount} leads) is within normal range; no action needed.`,
      alternatives: [],
    };
  }

  /** Finance Agent: recommends a collections follow-up for an overdue
   * payment line, with confidence rising the longer it's been overdue. */
  private async decideFinance(companyId: string, scheduleLineId: string): Promise<AgentDecisionResult> {
    const line = await this.finance.getScheduleLine(scheduleLineId, companyId);
    if (!line) throw new NotFoundError('payment schedule line not found');
    if (line.status !== 'overdue') {
      return { confidence: 100, reasoning: `Payment line is ${line.status}, not overdue; no action needed.`, alternatives: [] };
    }
    const daysOverdue = Math.max(0, Math.floor((Date.now() - Date.parse(line.dueDate)) / (24 * 60 * 60 * 1000)));
    const outstanding = Math.round((line.amount - line.amountPaid) * 100) / 100;
    const confidence = Math.min(95, 50 + daysOverdue * 2);
    return {
      chosenActionType: 'create_task',
      params: {
        title: `Follow up on overdue payment "${line.label}" (${daysOverdue}d overdue, ${outstanding} outstanding)`,
        relatedResource: 'payment_schedule_line',
        relatedResourceId: line.id,
      },
      confidence,
      reasoning: `Payment overdue by ${daysOverdue} day(s), ${outstanding} outstanding — recommend a collections follow-up.`,
      alternatives: [],
    };
  }

  /** Customer Service Agent: flags an open maintenance ticket that's
   * urgent/high priority or has sat unassigned too long. */
  private async decideSupport(companyId: string, ticketId: string): Promise<AgentDecisionResult> {
    const ticket = await this.operations.getTicket(ticketId);
    if (!ticket || ticket.companyId !== companyId) throw new NotFoundError('maintenance ticket not found');
    if (ticket.status !== 'open') {
      return { confidence: 100, reasoning: `Ticket is ${ticket.status}; no action needed.`, alternatives: [] };
    }
    const ageHours = Math.max(0, (Date.now() - Date.parse(ticket.createdAt)) / (60 * 60 * 1000));
    const urgent = ticket.priority === 'urgent' || ticket.priority === 'high';
    if (!ticket.assignedToUserId && (urgent || ageHours > 24)) {
      return {
        chosenActionType: 'create_task',
        params: { title: `Assign unassigned ${ticket.priority} ticket: ${ticket.title}`, relatedResource: 'maintenance_ticket', relatedResourceId: ticket.id },
        confidence: urgent ? 90 : 70,
        reasoning: `Ticket is ${ticket.priority} priority, unassigned for ${Math.round(ageHours)}h — recommend prompt assignment.`,
        alternatives: [],
      };
    }
    return { confidence: 80, reasoning: 'Ticket is open but already assigned, or not yet urgent enough to flag.', alternatives: [] };
  }

  /** HR Agent: nudges toward a decision reminder once a leave request has
   * sat pending past a reasonable review window. */
  private async decideHr(companyId: string, leaveRequestId: string): Promise<AgentDecisionResult> {
    const leave = await this.hr.getLeaveRequest(leaveRequestId);
    if (!leave || leave.companyId !== companyId) throw new NotFoundError('leave request not found');
    if (leave.status !== 'pending') {
      return { confidence: 100, reasoning: `Leave request is already ${leave.status}; no action needed.`, alternatives: [] };
    }
    const ageHours = Math.max(0, (Date.now() - Date.parse(leave.requestedAt)) / (60 * 60 * 1000));
    if (ageHours > 48) {
      return {
        chosenActionType: 'create_task',
        params: { title: `Leave request pending ${Math.round(ageHours)}h — needs a decision`, relatedResource: 'leave_request', relatedResourceId: leave.id },
        confidence: Math.min(90, 50 + ageHours / 2),
        reasoning: `Leave request has been pending for ${Math.round(ageHours)}h with no decision — recommend a reminder.`,
        alternatives: [],
      };
    }
    return { confidence: 70, reasoning: `Leave request pending for ${Math.round(ageHours)}h — still within a normal review window.`, alternatives: [] };
  }

  /** Legal Agent: a contract-required document stuck in "pending" too
   * long needs chasing; one already "received" but not yet "verified"
   * needs a human to actually check it — the agent never verifies a
   * document itself, since that's a compliance judgment call. Ages off
   * `createdAt` (the schema has no separate "received at" timestamp). */
  private async decideLegal(companyId: string, documentId: string): Promise<AgentDecisionResult> {
    const documents = await this.legal.listForCompany(companyId);
    const doc = documents.find((d) => d.id === documentId);
    if (!doc) throw new NotFoundError('legal document not found');
    if (doc.status === 'verified' || doc.status === 'rejected') {
      return { confidence: 100, reasoning: `Document is already ${doc.status}; no action needed.`, alternatives: [] };
    }
    const ageHours = Math.max(0, (Date.now() - Date.parse(doc.createdAt)) / (60 * 60 * 1000));
    if (doc.status === 'pending' && ageHours > 72) {
      return {
        chosenActionType: 'create_task',
        params: { title: `Chase pending legal document "${doc.name}" (${Math.round(ageHours)}h since requested)`, relatedResource: 'contract', relatedResourceId: doc.contractId },
        confidence: Math.min(90, 50 + ageHours / 4),
        reasoning: `Document "${doc.name}" has been pending for ${Math.round(ageHours)}h — recommend a follow-up to collect it.`,
        alternatives: [],
      };
    }
    if (doc.status === 'received' && ageHours > 48) {
      return {
        chosenActionType: 'create_task',
        params: { title: `Verify received legal document "${doc.name}"`, relatedResource: 'contract', relatedResourceId: doc.contractId },
        confidence: Math.min(85, 45 + ageHours / 6),
        reasoning: `Document "${doc.name}" was received ${Math.round(ageHours)}h ago but hasn't been verified — recommend a review.`,
        alternatives: [],
      };
    }
    return { confidence: 70, reasoning: `Document is ${doc.status}, ${Math.round(ageHours)}h old — still within a normal review window.`, alternatives: [] };
  }

  /** Broker Agent: flags a broker-submitted lead that's sat in the
   * quarantine review queue too long. Deliberately never chooses
   * approveBrokerLead itself — that quarantine gate exists specifically
   * to prevent auto-approved fraud/duplicate leads, so it always stays a
   * human decision; the agent's only job is to make sure it isn't
   * forgotten. */
  private async decideBroker(companyId: string, brokerLeadId: string): Promise<AgentDecisionResult> {
    const leads = await this.brokers.listBrokerLeads(companyId);
    const lead = leads.find((l) => l.id === brokerLeadId);
    if (!lead) throw new NotFoundError('broker lead not found');
    if (lead.approvalStatus !== 'pending_approval') {
      return { confidence: 100, reasoning: `Broker lead is already ${lead.approvalStatus}; no action needed.`, alternatives: [] };
    }
    const ageHours = Math.max(0, (Date.now() - Date.parse(lead.createdAt)) / (60 * 60 * 1000));
    if (ageHours > 24) {
      return {
        chosenActionType: 'create_task',
        params: { title: `Review quarantined broker lead "${lead.fullName}" (${Math.round(ageHours)}h pending)` },
        confidence: Math.min(90, 40 + ageHours),
        reasoning: `Broker-submitted lead has waited ${Math.round(ageHours)}h in the quarantine queue — recommend a review (never auto-approved by AI).`,
        alternatives: [],
      };
    }
    return { confidence: 60, reasoning: `Broker lead pending for ${Math.round(ageHours)}h — still within a normal review window.`, alternatives: [] };
  }

  /** Project & Inventory Agent: flags a unit that's been listed as
   * available for a long time with zero reservation history — a real
   * "stale inventory" signal worth a marketing/pricing review, not
   * something the agent would ever act on by changing price or status
   * itself (outside this agent's declared action boundary). */
  private async decideInventory(companyId: string, unitId: string): Promise<AgentDecisionResult> {
    const unit = await this.inventory.getUnit(unitId);
    if (!unit || unit.companyId !== companyId) throw new NotFoundError('unit not found');
    if (unit.status !== 'available') {
      return { confidence: 100, reasoning: `Unit is ${unit.status}, not available; no action needed.`, alternatives: [] };
    }
    const ageDays = Math.max(0, (Date.now() - Date.parse(unit.createdAt)) / (24 * 60 * 60 * 1000));
    const reservations = await this.inventory.listReservations(companyId);
    const everReserved = reservations.some((r) => r.unitId === unitId);
    if (!everReserved && ageDays > 90) {
      return {
        chosenActionType: 'create_task',
        params: { title: `Review stale listing: unit ${unit.code} has been available ${Math.round(ageDays)}d with no reservation activity` },
        confidence: Math.min(85, 40 + ageDays / 4),
        reasoning: `Unit ${unit.code} has been available for ${Math.round(ageDays)}d with zero reservation history — recommend a pricing/marketing review.`,
        alternatives: [],
      };
    }
    return { confidence: 60, reasoning: `Unit ${unit.code} is available for ${Math.round(ageDays)}d — within a normal range or has reservation history.`, alternatives: [] };
  }

  /** Management Intelligence Agent: a cross-department read rather than a
   * single-record decision — reuses AnalyticsService.collectionsAging
   * (real payment-schedule-line data) to flag when the company's overdue
   * receivables share of total tracked (upcoming + due + overdue) crosses
   * a concerning threshold. subjectId is the companyId itself, since this
   * agent's "subject" is the company, not one record. */
  private async decideManagement(companyId: string, subjectCompanyId: string): Promise<AgentDecisionResult> {
    if (subjectCompanyId !== companyId) throw new NotFoundError('company not found');
    const aging = await this.analytics.collectionsAging(companyId);
    const tracked = aging.upcoming + aging.due + aging.overdue;
    if (tracked <= 0) {
      return { confidence: 90, reasoning: 'No tracked receivables yet; no collections risk to flag.', alternatives: [] };
    }
    const overdueShare = Math.round((aging.overdue / tracked) * 1000) / 10;
    if (overdueShare >= 25) {
      return {
        chosenActionType: 'create_task',
        params: { title: `Collections risk review: ${overdueShare}% of tracked receivables are overdue (${aging.overdue} outstanding)` },
        confidence: Math.min(90, 50 + overdueShare / 2),
        reasoning: `${overdueShare}% of tracked receivables (upcoming+due+overdue = ${tracked}) are currently overdue — recommend a leadership-level collections review.`,
        alternatives: [],
      };
    }
    return { confidence: 80, reasoning: `Overdue receivables are ${overdueShare}% of tracked total — within a normal range.`, alternatives: [] };
  }

  async setPolicy(companyId: string, actionType: AutomationActionType, autonomyLevel: AiAutonomyLevel, updatedByUserId: string): Promise<AiPolicy> {
    const existing = await this.findPolicy(companyId, actionType);
    const policy: AiPolicy = {
      id: existing?.id ?? randomUUID(),
      companyId,
      actionType,
      autonomyLevel,
      updatedByUserId,
      updatedAt: new Date().toISOString(),
    };
    return this.repos.policies.save(policy);
  }

  async listPolicies(companyId: string): Promise<AiPolicy[]> {
    return this.repos.policies.findAll((p) => p.companyId === companyId);
  }

  async listActionRequests(companyId: string): Promise<AiActionRequest[]> {
    return this.repos.actionRequests.findAll((r) => r.companyId === companyId);
  }

  async getActionRequest(id: string, companyId: string): Promise<AiActionRequest> {
    const request = await this.repos.actionRequests.findById(id);
    if (!request || request.companyId !== companyId) throw new NotFoundError('AI action request not found');
    return request;
  }

  /** Real runtime enforcement of each tool's declared input schema
   * (Phase 7) — checks every one of TOOL_REGISTRY's `requiredParams` is
   * present and non-empty in the caller's params. An action type with no
   * registry entry (shouldn't happen — every AutomationActionType has
   * one) is treated as having no required params rather than silently
   * passing every check. */
  private missingRequiredParams(actionType: AutomationActionType, params: Record<string, unknown>): string[] {
    const tool = TOOL_REGISTRY.find((t) => t.actionType === actionType);
    if (!tool) return [];
    return tool.requiredParams.filter((key) => {
      const value = params?.[key];
      return value === undefined || value === null || value === '';
    });
  }

  private async autonomyFor(companyId: string, actionType: AutomationActionType): Promise<AiAutonomyLevel> {
    const policy = await this.findPolicy(companyId, actionType);
    return policy?.autonomyLevel ?? 'require_approval';
  }

  private async findPolicy(companyId: string, actionType: AutomationActionType): Promise<AiPolicy | undefined> {
    const matches = await this.repos.policies.findAll((p) => p.companyId === companyId && p.actionType === actionType);
    return matches[0];
  }

  private async persist(input: RequestAiActionInput, status: AiActionStatus, extraReasoning?: string): Promise<AiActionRequest> {
    const reasoning = extraReasoning
      ? `${input.reasoning ?? ''}${input.reasoning ? ' — ' : ''}${extraReasoning}`.trim()
      : input.reasoning;
    const request: AiActionRequest = {
      id: randomUUID(),
      companyId: input.companyId,
      requestedByUserId: input.requestedByUserId,
      actionType: input.actionType,
      params: input.params,
      reasoning,
      status,
      createdAt: new Date().toISOString(),
    };
    const saved = await this.repos.actionRequests.save(request);
    await this.auditLog.record({
      companyId: input.companyId,
      actorUserId: input.requestedByUserId,
      action: 'create',
      resource: 'ai_action',
      resourceId: saved.id,
      metadata: { actionType: input.actionType, status, executedByAI: true },
    });
    return saved;
  }

  private async getPendingApproval(approvalId: string, companyId: string): Promise<ApprovalRequest> {
    const approval = await this.repos.approvals.findById(approvalId);
    if (!approval || approval.companyId !== companyId || approval.stepId !== APPROVAL_STEP_ID) {
      throw new NotFoundError('approval request not found');
    }
    if (approval.status !== 'pending') throw new AutomationError(`approval request already ${approval.status}`);
    return approval;
  }
}
