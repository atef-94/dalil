import { randomUUID } from 'node:crypto';
import type {
  AiWorkflowGoalType,
  AiWorkflowRun,
  AiWorkflowStepRun,
  AiWorkflowStepStatus,
  Lead,
  Unit,
} from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { AutomationError, NotFoundError, ValidationError } from '../../infra/errors.js';
import { AuditLog } from '../../infra/audit-log.js';
import { AutomationService } from '../automation/automation.service.js';
import { AiAgentService } from './ai-agent.service.js';
import { CrmService } from '../crm/crm.service.js';
import type { CrmStageService } from '../crm/crm-stage.service.js';
import { LeadScoringService } from './lead-scoring.service.js';
import { LeadTimelineService } from '../crm/lead-timeline.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { PaymentPlansService } from '../payment-plans/payment-plans.service.js';
import { LeadDistributionService } from '../crm/lead-distribution.service.js';
import { CommunicationService } from '../communication/communication.service.js';
import { IntegrationService } from '../integrations/integration.service.js';

export interface AiWorkflowRepos {
  runs: Repository<AiWorkflowRun>;
  steps: Repository<AiWorkflowStepRun>;
}

/** How long a real customer has to reply before the sweep escalates
 * instead of waiting forever. Kept short enough to actually observe in a
 * live/manual test session (see main.ts's sweep tick and the test suite's
 * direct resumeAt manipulation), not a realistic production SLA. */
const RESPONSE_WAIT_HOURS = 24;
/** Below this LeadScoringService score, the lead doesn't qualify as
 * "high-value" — the run completes immediately with a clear reason rather
 * than pretending to chase every lead through the full multi-step flow. */
const HIGH_VALUE_SCORE_THRESHOLD = 40;

/**
 * The AI Workflow / Agentic Orchestration Engine — a second, distinct
 * execution model from AutomationService's deterministic WorkflowRun
 * engine. That engine runs a fixed, human-authored step sequence; this one
 * executes a goal-directed *plan* the orchestrator builds and adapts:
 *
 *   EVENT -> analyze -> gather context -> plan -> execute step -> evaluate
 *   result -> replan (search again / try an alternative) or continue ->
 *   ... -> wait for an external event -> resume -> evaluate -> complete or
 *   escalate.
 *
 * Only one goal type is implemented: 'high_value_lead_followup', matching
 * the flagship example from the spec exactly (analyze lead -> retrieve
 * history -> identify requirements -> check units -> match suitable units
 * -> analyze payment plans -> select agent -> create task -> generate
 * message -> send -> wait -> check response -> update CRM -> continue or
 * escalate). Every real data point it reasons over — the lead's own
 * requirement fields, real inventory, real payment-plan templates, the
 * real lead-distribution pool — already exists in the codebase; nothing
 * here is fabricated or hardcoded.
 *
 * Every mutating step (create a task, send a message, move a CRM stage)
 * goes through AiAgentService.requestAction() — the exact same
 * permission -> AiPolicy autonomy -> approval -> audit pipeline every
 * other AI action uses. This engine adds planning/state/replanning on
 * top; it never bypasses that safety pipeline underneath. When a step's
 * action only gets "suggested" or "pending_approval" (the company hasn't
 * opted the action type into auto-execute), the run escalates instead of
 * pretending the action happened — it never continues to a later step
 * that assumes an unexecuted action succeeded.
 */
export class AiWorkflowService {
  constructor(
    private readonly repos: AiWorkflowRepos,
    private readonly automation: AutomationService,
    private readonly aiAgent: AiAgentService,
    private readonly crm: CrmService,
    private readonly crmStages: CrmStageService,
    private readonly leadScoring: LeadScoringService,
    private readonly leadTimeline: LeadTimelineService,
    private readonly inventory: InventoryService,
    private readonly paymentPlans: PaymentPlansService,
    private readonly leadDistribution: LeadDistributionService,
    private readonly communication: CommunicationService,
    private readonly integrations: IntegrationService,
    private readonly auditLog: AuditLog,
  ) {}

  async startWorkflow(goalType: AiWorkflowGoalType, companyId: string, subjectId: string, requestedByUserId: string): Promise<AiWorkflowRun> {
    if (goalType !== 'high_value_lead_followup') {
      throw new ValidationError(`unsupported AI workflow goal type: ${goalType}`);
    }
    // Idempotency: never start a second concurrent run for the same
    // subject — mirrors WorkflowRun's idempotencyKey dedup above.
    const active = await this.repos.runs.findAll(
      (r) => r.companyId === companyId && r.subjectType === 'lead' && r.subjectId === subjectId && (r.status === 'running' || r.status === 'waiting'),
    );
    if (active.length > 0) return active[0]!;

    const now = new Date().toISOString();
    const run: AiWorkflowRun = {
      id: randomUUID(),
      companyId,
      goalType,
      subjectType: 'lead',
      subjectId,
      status: 'running',
      requestedByUserId,
      createdAt: now,
      updatedAt: now,
    };
    await this.repos.runs.save(run);
    await this.auditLog.record({ companyId, actorUserId: requestedByUserId, action: 'create', resource: 'ai_action', resourceId: run.id, metadata: { aiWorkflow: true, goalType, subjectId } });
    return this.runHighValueLeadFollowup(run, requestedByUserId);
  }

  async resumeWorkflow(runId: string, companyId: string, actorUserId: string): Promise<AiWorkflowRun> {
    const run = await this.getRun(runId, companyId);
    if (run.status !== 'waiting') throw new AutomationError(`only a waiting run can be resumed (current status: ${run.status})`, 409);
    return this.continueAfterWait(run, actorUserId);
  }

  /** Called from the same 60s scheduler tick pattern as
   * sweepOverdueAndEmit/sweepSlaBreachesAndEmit (see main.ts) — resumes
   * any run whose wait deadline has passed without a manual resume. */
  async sweepDueWaitingRuns(): Promise<AiWorkflowRun[]> {
    const now = Date.now();
    const due = await this.repos.runs.findAll((r) => r.status === 'waiting' && !!r.resumeAt && Date.parse(r.resumeAt) <= now);
    const results: AiWorkflowRun[] = [];
    for (const run of due) {
      results.push(await this.continueAfterWait(run, run.requestedByUserId));
    }
    return results;
  }

  async getRun(id: string, companyId: string): Promise<AiWorkflowRun> {
    const run = await this.repos.runs.findById(id);
    if (!run || run.companyId !== companyId) throw new NotFoundError('AI workflow run not found');
    return run;
  }

  async listRuns(companyId: string, subjectId?: string): Promise<AiWorkflowRun[]> {
    const all = await this.repos.runs.findAll((r) => r.companyId === companyId && (!subjectId || r.subjectId === subjectId));
    return all.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async getSteps(runId: string, companyId: string): Promise<AiWorkflowStepRun[]> {
    const steps = await this.repos.steps.findAll((s) => s.runId === runId && s.companyId === companyId);
    return steps.sort((a, b) => a.sequence - b.sequence);
  }

  // ---- The one implemented goal: high_value_lead_followup ----

  private async runHighValueLeadFollowup(run: AiWorkflowRun, actorUserId: string): Promise<AiWorkflowRun> {
    let sequence = (await this.getSteps(run.id, run.companyId)).length;

    const lead = await this.crm.getLead(run.subjectId);
    if (!lead || lead.companyId !== run.companyId) {
      return this.escalate(run, ++sequence, 'analyze_lead', 'Lead not found for this company.');
    }

    // Step 1: analyze_lead
    const score = await this.leadScoring.scoreLead(lead.id, run.companyId);
    await this.recordStep(run, ++sequence, 'analyze_lead', 'succeeded', `Lead score ${score.score}/100 (${score.factors.map((f) => f.label).join(', ') || 'no positive signals yet'}).`, { leadId: lead.id }, { score: score.score, factors: score.factors });

    if (score.score < HIGH_VALUE_SCORE_THRESHOLD) {
      return this.complete(run, sequence, `Lead score ${score.score}/100 is below the high-value threshold (${HIGH_VALUE_SCORE_THRESHOLD}) — not pursuing the automated multi-step flow; a human can still follow up manually via the ordinary CRM workspace.`);
    }

    // Step 2: retrieve_history
    const timeline = await this.leadTimeline.getTimeline(lead.id, run.companyId);
    await this.recordStep(run, ++sequence, 'retrieve_history', 'succeeded', `${timeline.entries.length} prior activity/history entr${timeline.entries.length === 1 ? 'y' : 'ies'} on record.`, { leadId: lead.id }, { entryCount: timeline.entries.length });

    // Step 3: identify_requirements
    const hasRequirements = !!(lead.propertyTypeWanted || lead.preferredLocation || lead.minAreaSqm || lead.maxAreaSqm || lead.maxDownPayment);
    if (!hasRequirements) {
      return this.escalate(run, ++sequence, 'identify_requirements', 'Lead has no captured requirements (property type, location, area, or budget) — cannot reliably match units or payment plans automatically; needs a human qualifying call first.');
    }
    await this.recordStep(run, ++sequence, 'identify_requirements', 'succeeded', 'Requirements available for matching.', undefined, {
      propertyTypeWanted: lead.propertyTypeWanted,
      preferredLocation: lead.preferredLocation,
      minAreaSqm: lead.minAreaSqm,
      maxAreaSqm: lead.maxAreaSqm,
      maxDownPayment: lead.maxDownPayment,
      maxInstallment: lead.maxInstallment,
    });

    // Steps 4-5: check_available_units + match_suitable_units, with a real
    // replan step if the strict match comes back empty.
    let candidates = await this.findMatchingUnits(run.companyId, lead, true);
    if (candidates.length === 0) {
      await this.recordStep(run, ++sequence, 'match_suitable_units', 'replanned', 'No units matched the strict requirements — broadening the search (relaxing area range and location).', undefined, { strict: true, matchCount: 0 });
      candidates = await this.findMatchingUnits(run.companyId, lead, false);
    }
    if (candidates.length === 0) {
      return this.escalate(run, ++sequence, 'match_suitable_units', 'No available unit matched this lead\'s requirements, even after broadening the search — inventory may need review, or the lead\'s expectations need realigning.');
    }
    await this.recordStep(run, ++sequence, 'match_suitable_units', 'succeeded', `${candidates.length} candidate unit(s) found.`, undefined, { unitIds: candidates.map((u) => u.id), unitCodes: candidates.map((u) => u.code) });

    // Step 6: analyze_payment_plans — try each candidate unit in order
    // against every active template; a unit with no affordable plan is a
    // second real replan point (falls through to the next candidate).
    const templates = await this.paymentPlans.listTemplates(run.companyId);
    if (templates.length === 0) {
      return this.escalate(run, ++sequence, 'analyze_payment_plans', 'No payment plan templates are configured for this company — cannot propose terms.');
    }
    let chosenUnit: Unit | undefined;
    let chosenTemplateName: string | undefined;
    let chosenMonthlyInstallment: number | undefined;
    for (const unit of candidates) {
      for (const template of templates) {
        const scheduleLines = await this.paymentPlans.previewSchedule(template.id, run.companyId, unit.listPrice);
        const installmentLines = scheduleLines.filter((l) => l.label !== 'Down Payment');
        const avgInstallment = installmentLines.length > 0
          ? installmentLines.reduce((sum, l) => sum + l.amount, 0) / installmentLines.length
          : 0;
        if (!lead.maxInstallment || avgInstallment <= lead.maxInstallment) {
          chosenUnit = unit;
          chosenTemplateName = template.name;
          chosenMonthlyInstallment = Math.round(avgInstallment * 100) / 100;
          break;
        }
      }
      if (chosenUnit) break;
    }
    if (!chosenUnit || !chosenTemplateName) {
      return this.escalate(run, ++sequence, 'analyze_payment_plans', `None of the ${candidates.length} matched unit(s) had a payment plan within this lead's stated budget (max installment ${lead.maxInstallment ?? 'unspecified'}).`);
    }
    await this.recordStep(run, ++sequence, 'analyze_payment_plans', 'succeeded', `Unit ${chosenUnit.code} with plan "${chosenTemplateName}" fits the lead's budget.`, undefined, { unitId: chosenUnit.id, unitCode: chosenUnit.code, templateName: chosenTemplateName, avgInstallment: chosenMonthlyInstallment });

    // Step 7: select_sales_agent — respects an existing owner; only falls
    // back to the distribution pool when the lead genuinely has none.
    let agentUserId = lead.ownerEmployeeUserId;
    let agentSource = 'existing lead owner';
    if (!agentUserId) {
      const pool = await this.leadDistribution.getPool(run.companyId);
      agentUserId = pool?.memberUserIds[0];
      agentSource = 'lead distribution pool';
    }
    if (!agentUserId) {
      return this.escalate(run, ++sequence, 'select_sales_agent', 'No sales agent available — the lead has no owner and no lead distribution pool is configured for this company.');
    }
    await this.recordStep(run, ++sequence, 'select_sales_agent', 'succeeded', `Selected via ${agentSource}.`, undefined, { agentUserId, agentSource });

    // Step 8: create_followup_task — a real tool call through the same
    // permission/autonomy/approval pipeline every other AI action uses.
    const taskTitle = `Follow up: ${lead.fullName} — matched unit ${chosenUnit.code}`;
    const taskResult = await this.runGatedAction(run, actorUserId, 'create_task', {
      title: taskTitle,
      assignedToUserId: agentUserId,
      relatedResource: 'lead',
      relatedResourceId: lead.id,
    }, `Create a follow-up task for ${agentSource === 'existing lead owner' ? 'the lead owner' : 'the newly-selected agent'}.`);
    sequence = taskResult.sequence;
    if (taskResult.blocked) return taskResult.run;

    // Step 9: generate_personalized_message — deterministic templating
    // from real matched data, not an external LLM call (consistent with
    // every other "AI" text this codebase produces, e.g. AgentDecision's
    // reasoning strings).
    const messageBody = `Hi ${lead.fullName}, thanks for your interest! Based on what you're looking for, we think unit ${chosenUnit.code} (${chosenUnit.areaSqm} m²) could be a great fit, with a payment plan around ${chosenMonthlyInstallment?.toLocaleString()} per installment under our "${chosenTemplateName}" plan. Would you like to schedule a viewing?`;
    await this.recordStep(run, ++sequence, 'generate_personalized_message', 'succeeded', 'Message drafted from the matched unit/plan.', undefined, { messageBody });

    // Step 10: send_message — prefers a connected external channel
    // (WhatsApp/Email), falls back to an internal message to the agent so
    // the outreach is never silently skipped.
    const channel = await this.pickOutreachChannel(run.companyId, lead);
    const sendParams = channel === 'whatsapp'
      ? { provider: 'whatsapp', action: 'send_message', leadId: lead.id, to: lead.phone, body: messageBody }
      : channel === 'email'
        ? { provider: 'email', action: 'send_message', leadId: lead.id, to: lead.email, subject: 'Thanks for your interest', body: messageBody }
        : { subject: `Reach out to ${lead.fullName}`, body: messageBody, toUserId: agentUserId, relatedResource: 'lead' as const, relatedResourceId: lead.id };
    const sendResult = await this.runGatedAction(run, actorUserId, channel ? 'integration_call' : 'send_message', sendParams, channel ? `Send the drafted message via the connected ${channel} integration.` : 'No connected outreach channel — logging the message internally for the agent to send manually.');
    sequence = sendResult.sequence;
    if (sendResult.blocked) return sendResult.run;

    // Step 11: wait_for_response
    const resumeAt = new Date(Date.now() + RESPONSE_WAIT_HOURS * 60 * 60 * 1000).toISOString();
    const waiting: AiWorkflowRun = { ...run, status: 'waiting', resumeAt, currentStepName: 'wait_for_response', updatedAt: new Date().toISOString() };
    await this.repos.runs.save(waiting);
    await this.recordStep(waiting, ++sequence, 'wait_for_response', 'succeeded', `Pausing up to ${RESPONSE_WAIT_HOURS}h for a reply before checking in again.`, undefined, { resumeAt });
    return waiting;
  }

  /** Resumes a 'waiting' run: checks whether a real reply was logged
   * against the lead since the outreach was sent, then either advances
   * the CRM stage (a genuine next step) or escalates for manual
   * follow-up — this is the plan's own "check response -> analyze ->
   * update CRM -> determine next action" tail. */
  private async continueAfterWait(run: AiWorkflowRun, actorUserId: string): Promise<AiWorkflowRun> {
    let sequence = (await this.getSteps(run.id, run.companyId)).length;
    const lead = await this.crm.getLead(run.subjectId);
    if (!lead || lead.companyId !== run.companyId) {
      return this.escalate(run, ++sequence, 'check_response', 'Lead no longer exists for this company.');
    }
    const steps = await this.getSteps(run.id, run.companyId);
    const sendStep = steps.find((s) => s.stepName === 'send_message' || s.stepName === 'integration_call');
    const sentAt = sendStep ? Date.parse(sendStep.finishedAt) : Date.parse(run.createdAt);

    // >= rather than > — both timestamps are millisecond-resolution
    // ISO strings, and a fast environment (a quick test run, a quick real
    // reply) can genuinely produce the same millisecond for the outreach
    // step finishing and a reply landing right after; treating that tie as
    // "not a reply" is a real, observed race (not a hypothetical one),
    // wrongly escalating a run that actually got a reply.
    const messages = await this.communication.listForResource('lead', lead.id, run.companyId);
    const reply = messages.find((m) => Date.parse(m.createdAt) >= sentAt && m.fromUserId !== run.requestedByUserId);

    if (reply) {
      await this.recordStep(run, ++sequence, 'check_response', 'succeeded', 'A real reply/activity was logged against this lead since the outreach was sent.', undefined, { replied: true, messageId: reply.id });
      const stages = await this.crmStages.listStages(run.companyId, true);
      const stage = stages.find((s) => s.id === lead.stageId);
      const nonTerminal = stages.filter((s) => !s.isWon && !s.isLost && s.isActive).sort((a, b) => a.order - b.order);
      const currentIndex = stage ? nonTerminal.findIndex((s) => s.id === stage.id) : -1;
      const nextStage = currentIndex >= 0 ? nonTerminal[currentIndex + 1] : undefined;
      if (!nextStage) {
        return this.escalate(run, ++sequence, 'update_crm', 'Lead replied, but is already at the last stage before a Won/Lost decision — needs a human call, not an automatic stage move.');
      }
      const updateResult = await this.runGatedAction(run, actorUserId, 'update_lead_status', { leadId: lead.id, stageId: nextStage.id }, `Lead engaged — advancing from "${stage?.name ?? 'current stage'}" to "${nextStage.name}".`);
      sequence = updateResult.sequence;
      if (updateResult.blocked) return updateResult.run;
      return this.complete(run, sequence, `Lead replied and was moved to "${nextStage.name}".`);
    }

    await this.recordStep(run, ++sequence, 'check_response', 'succeeded', `No reply logged within ${RESPONSE_WAIT_HOURS}h of the outreach.`, undefined, { replied: false });
    const followUpResult = await this.runGatedAction(run, actorUserId, 'create_task', {
      title: `No response from ${lead.fullName} after outreach — manual follow-up needed`,
      assignedToUserId: lead.ownerEmployeeUserId,
      relatedResource: 'lead',
      relatedResourceId: lead.id,
    }, 'Recommend a manual follow-up since the automated outreach got no response.');
    sequence = followUpResult.sequence;
    return this.escalate(run, sequence, 'determine_next_action', 'No response within the wait window — a manual follow-up task was created for the lead owner.');
  }

  // ---- Shared plumbing ----

  /** Executes one mutating tool call through AiAgentService's full
   * permission/AiPolicy-autonomy/approval/audit pipeline. If the company's
   * policy only "suggests" the action or routes it to a pending approval
   * (rather than auto-executing), the run stops here — it never continues
   * on the assumption that an unexecuted action already happened. */
  private async runGatedAction(
    run: AiWorkflowRun,
    actorUserId: string,
    actionType: Parameters<AiAgentService['requestAction']>[0]['actionType'],
    params: Record<string, unknown>,
    reasoning: string,
  ): Promise<{ sequence: number; blocked: boolean; run: AiWorkflowRun }> {
    let sequence = (await this.getSteps(run.id, run.companyId)).length;
    const request = await this.aiAgent.requestAction({ companyId: run.companyId, requestedByUserId: actorUserId, actionType, params, reasoning });

    if (request.status === 'executed') {
      await this.recordStep(run, ++sequence, actionType, 'succeeded', reasoning, params, { aiActionRequestId: request.id, status: request.status });
      return { sequence, blocked: false, run };
    }
    if (request.status === 'denied_permission') {
      const escalated = await this.escalate(run, ++sequence, actionType, `Blocked: the requesting user does not have permission to ${actionType}.`);
      return { sequence, blocked: true, run: escalated };
    }
    // 'suggested' or 'pending_approval' — the company hasn't opted this
    // action type into auto-execute; a human needs to act on it.
    const escalated = await this.escalate(run, ++sequence, actionType, `Action "${actionType}" is only ${request.status === 'suggested' ? 'suggested, not auto-executed' : 'pending human approval'} under this company's AI policy (see AI Action ${request.id}) — pausing here instead of assuming it happened.`);
    return { sequence, blocked: true, run: escalated };
  }

  private async findMatchingUnits(companyId: string, lead: Lead, strict: boolean): Promise<Unit[]> {
    const units = await this.inventory.listUnits(companyId);
    const available = units.filter((u) => u.status === 'available');
    return available.filter((u) => {
      if (strict && lead.propertyTypeWanted && u.unitType.toLowerCase() !== lead.propertyTypeWanted.toLowerCase()) return false;
      if (lead.minAreaSqm && u.areaSqm < (strict ? lead.minAreaSqm : lead.minAreaSqm * 0.85)) return false;
      if (lead.maxAreaSqm && u.areaSqm > (strict ? lead.maxAreaSqm : lead.maxAreaSqm * 1.15)) return false;
      if (strict && lead.maxDownPayment) {
        // Rough affordability heuristic assuming a ~10% typical down
        // payment — a real per-template check happens later in
        // analyze_payment_plans; this is just a coarse pre-filter.
        if (u.listPrice * 0.1 > lead.maxDownPayment * 1.5) return false;
      }
      return true;
    }).slice(0, 5);
  }

  private async pickOutreachChannel(companyId: string, lead: Lead): Promise<'whatsapp' | 'email' | undefined> {
    const connections = await this.integrations.listConnections(companyId);
    const isActive = (provider: string) => connections.some((c) => c.provider === provider && c.status !== 'disconnected');
    if (lead.phone && isActive('whatsapp')) return 'whatsapp';
    if (lead.email && isActive('email')) return 'email';
    return undefined;
  }

  private async recordStep(
    run: AiWorkflowRun,
    sequence: number,
    stepName: string,
    status: AiWorkflowStepStatus,
    reasoning: string,
    input: Record<string, unknown> | undefined,
    output: Record<string, unknown> | undefined,
    error?: string,
  ): Promise<AiWorkflowStepRun> {
    const now = new Date().toISOString();
    const step: AiWorkflowStepRun = {
      id: randomUUID(),
      companyId: run.companyId,
      runId: run.id,
      sequence,
      stepName,
      status,
      reasoning,
      input,
      output,
      error,
      startedAt: now,
      finishedAt: now,
    };
    await this.repos.steps.save(step);
    await this.repos.runs.save({ ...run, currentStepName: stepName, updatedAt: now });
    return step;
  }

  private async escalate(run: AiWorkflowRun, sequence: number, stepName: string, reason: string): Promise<AiWorkflowRun> {
    await this.recordStep(run, sequence, stepName, 'failed', reason, undefined, undefined, reason);
    const now = new Date().toISOString();
    const escalated: AiWorkflowRun = { ...run, status: 'escalated', currentStepName: stepName, outcomeSummary: reason, updatedAt: now, finishedAt: now };
    await this.repos.runs.save(escalated);
    await this.auditLog.record({ companyId: run.companyId, actorUserId: run.requestedByUserId, action: 'edit', resource: 'ai_action', resourceId: run.id, metadata: { aiWorkflow: true, escalated: true, reason } });
    return escalated;
  }

  private async complete(run: AiWorkflowRun, sequence: number, reason: string): Promise<AiWorkflowRun> {
    await this.recordStep(run, sequence, 'complete', 'succeeded', reason, undefined, undefined);
    const now = new Date().toISOString();
    const completed: AiWorkflowRun = { ...run, status: 'completed', currentStepName: 'complete', outcomeSummary: reason, updatedAt: now, finishedAt: now };
    await this.repos.runs.save(completed);
    await this.auditLog.record({ companyId: run.companyId, actorUserId: run.requestedByUserId, action: 'edit', resource: 'ai_action', resourceId: run.id, metadata: { aiWorkflow: true, completed: true, reason } });
    return completed;
  }
}
