import { randomUUID } from 'node:crypto';
import type { AiActionRequest, AiActionStatus, AiAutonomyLevel, AiPolicy, ApprovalRequest, AutomationActionType } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { AuditLog } from '../../infra/audit-log.js';
import { AutomationError, ForbiddenError, NotFoundError, ValidationError } from '../../infra/errors.js';
import { RbacEvaluator } from '../permissions/rbac.evaluator.js';
import { AutomationService } from '../automation/automation.service.js';
import { CrmService } from '../crm/crm.service.js';
import { LeadScoringService } from './lead-scoring.service.js';

export interface AiRepos {
  actionRequests: Repository<AiActionRequest>;
  policies: Repository<AiPolicy>;
  approvals: Repository<ApprovalRequest>;
}

export interface RequestAiActionInput {
  companyId: string;
  /** The human this action is performed on behalf of — every RBAC and
   * AuditLog check runs as this user, never as "the AI" itself. */
  requestedByUserId: string;
  actionType: AutomationActionType;
  params: Record<string, unknown>;
  reasoning?: string;
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
  constructor(
    private readonly repos: AiRepos,
    private readonly rbac: RbacEvaluator,
    private readonly automation: AutomationService,
    private readonly crm: CrmService,
    private readonly leadScoring: LeadScoringService,
    private readonly auditLog: AuditLog,
  ) {}

  async requestAction(input: RequestAiActionInput): Promise<AiActionRequest> {
    if (!input.actionType) throw new ValidationError('actionType is required');

    const permitted = await this.automation.canPerformAction(input.requestedByUserId, input.actionType, input.companyId);
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

  /**
   * Deterministic "next best action" for a lead — reuses the existing
   * rule-based LeadScoringService (no external LLM/ML dependency in this
   * deployment) to turn its score into a concrete, explainable suggested
   * action, then routes it through the exact same permission/policy/
   * approval/audit pipeline as any other AI action. Whether it actually
   * executes depends entirely on the company's AiPolicy for that action
   * type — this method only ever *proposes*, per requestAction()'s rules.
   */
  async suggestNextAction(leadId: string, companyId: string, requestedByUserId: string): Promise<AiActionRequest> {
    const lead = await this.crm.getLead(leadId);
    if (!lead || lead.companyId !== companyId) throw new NotFoundError('lead not found');
    if (lead.status === 'lost' || lead.status === 'opportunity') {
      throw new AutomationError(`no next action to suggest for a lead already ${lead.status}`);
    }
    const score = await this.leadScoring.scoreLead(leadId, companyId);
    const factorSummary = score.factors.map((f) => f.label).join(', ') || 'no positive signals yet';

    let actionType: AutomationActionType;
    let params: Record<string, unknown>;
    let reasoning: string;

    // Thresholds are calibrated against LeadScoringService's actual range
    // per status (status weight alone caps 'new' at 10/100 and 'contacted'
    // at 35/100 — the rest comes from recency/owner/source bonuses), not
    // round numbers: 25 is reachable but requires real positive signals
    // beyond just being new, and 45 likewise for 'contacted'.
    if (lead.status === 'new' && score.score >= 25) {
      actionType = 'update_lead_status';
      params = { leadId, status: 'contacted' };
      reasoning = `Lead score is ${score.score}/100 (${factorSummary}) — high enough to warrant first contact.`;
    } else if (lead.status === 'contacted' && score.score >= 45) {
      actionType = 'update_lead_status';
      params = { leadId, status: 'qualified' };
      reasoning = `Lead score is ${score.score}/100 (${factorSummary}) — strong engagement signals suggest this lead is ready to qualify.`;
    } else {
      actionType = 'create_task';
      params = { title: `Follow up with ${lead.fullName}`, relatedResource: 'lead', relatedResourceId: lead.id };
      reasoning = `Lead score is ${score.score}/100 (${factorSummary}) — not yet ready to advance automatically; a manual follow-up is recommended.`;
    }

    return this.requestAction({ companyId, requestedByUserId, actionType, params, reasoning });
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
