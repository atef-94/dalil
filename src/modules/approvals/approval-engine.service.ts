import { randomUUID } from 'node:crypto';
import type { ActionApproval, ApprovableActionType } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../infra/errors.js';
import type { RbacEvaluator } from '../permissions/rbac.evaluator.js';

export interface RequestApprovalInput {
  companyId: string;
  actionType: ApprovableActionType;
  requestedByUserId: string;
  reason: string;
  context: Record<string, unknown>;
}

/**
 * The Universal Approval Engine: a gate any route can put in front of any
 * action, independent of the Automation Engine's own ApprovalRequest
 * (which only ever exists inside a workflow run and needs a full
 * workflow to be built first). This is deliberately action-type-agnostic
 * — it knows nothing about contracts, discounts, or refunds. It only
 * stores the context a caller hands it and hands it back unchanged on
 * approval; app.ts owns deciding what "resuming" a given actionType
 * actually does (see recordActionApprovalDecision).
 */
export class ApprovalEngineService {
  constructor(
    private readonly approvals: Repository<ActionApproval>,
    private readonly rbac: RbacEvaluator,
  ) {}

  async requestApproval(input: RequestApprovalInput): Promise<ActionApproval> {
    if (!input.reason?.trim()) throw new ValidationError('reason is required');
    const approval: ActionApproval = {
      id: randomUUID(),
      companyId: input.companyId,
      actionType: input.actionType,
      requestedByUserId: input.requestedByUserId,
      reason: input.reason.trim(),
      context: input.context,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    return this.approvals.save(approval);
  }

  async listApprovals(companyId: string, status?: ActionApproval['status']): Promise<ActionApproval[]> {
    return this.approvals.findAll((a) => a.companyId === companyId && (!status || a.status === status));
  }

  async getApproval(id: string, companyId: string): Promise<ActionApproval | undefined> {
    const approval = await this.approvals.findById(id);
    return approval && approval.companyId === companyId ? approval : undefined;
  }

  private async getPending(id: string, companyId: string): Promise<ActionApproval> {
    const approval = await this.getApproval(id, companyId);
    if (!approval) throw new NotFoundError('approval request not found');
    if (approval.status !== 'pending') throw new ValidationError(`approval request already ${approval.status}`);
    return approval;
  }

  /** Same permission this engine's automation-workflow counterpart uses
   * (approve:approval) — one permission governs both flavors of
   * approval, since deciding is deciding regardless of what triggered
   * the request. */
  private async requireApprovePermission(approverUserId: string, companyId: string): Promise<void> {
    if (!(await this.rbac.can(approverUserId, 'approve', 'approval', { companyId }))) {
      throw new ForbiddenError('missing approve:approval permission');
    }
  }

  async approve(id: string, companyId: string, approverUserId: string): Promise<ActionApproval> {
    const approval = await this.getPending(id, companyId);
    await this.requireApprovePermission(approverUserId, companyId);
    return this.approvals.save({ ...approval, status: 'approved', decidedByUserId: approverUserId, decidedAt: new Date().toISOString() });
  }

  async reject(id: string, companyId: string, approverUserId: string, reason?: string): Promise<ActionApproval> {
    const approval = await this.getPending(id, companyId);
    await this.requireApprovePermission(approverUserId, companyId);
    return this.approvals.save({
      ...approval,
      status: 'rejected',
      decidedByUserId: approverUserId,
      decidedAt: new Date().toISOString(),
      rejectionReason: reason?.trim() || 'rejected by approver',
    });
  }

  /** Records that resuming an approved action failed — the decision
   * itself isn't reversed, this just keeps the failure visible instead
   * of silently discarding it. */
  async recordResumeFailure(id: string, companyId: string, reason: string): Promise<ActionApproval> {
    const approval = await this.getApproval(id, companyId);
    if (!approval) throw new NotFoundError('approval request not found');
    return this.approvals.save({ ...approval, resumeFailedReason: reason });
  }
}
