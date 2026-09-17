// Domain entity types for the ACTIVE Operating System backend.
// Narrower than prisma/schema.prisma by design: this file only defines what the
// in-memory repositories actually operate on today.

export interface Company {
  id: string;
  companyId: string; // self-referencing: companyId === id
  name: string;
  createdAt: string;
}

export interface Branch {
  id: string;
  companyId: string;
  name: string;
  address?: string;
  createdAt: string;
}

export interface Department {
  id: string;
  companyId: string;
  name: string;
  branchId?: string;
  createdAt: string;
}

export type EmployeeStatus = 'active' | 'terminated';

export interface Employee {
  id: string;
  companyId: string;
  fullName: string;
  email: string;
  title: string;
  departmentId?: string;
  branchId?: string;
  teamId?: string;
  managerEmployeeId?: string;
  status: EmployeeStatus;
  createdAt: string;
  terminatedAt?: string;
  /** Tags used by skill-based Lead Distribution to match this employee
   * against a lead's requiredSkill (e.g. ["luxury", "arabic"]). */
  skills?: string[];
  /** Accumulates one point every time a lead assigned to this employee
   * breaches its first-contact SLA and gets auto-reassigned or
   * re-flagged. Never decremented automatically — a manager resets it. */
  slaPenaltyPoints?: number;
}

export type UserType =
  | 'employee_user'
  | 'broker_user'
  | 'customer_user';

export interface User {
  id: string;
  companyId: string;
  email: string;
  passwordHash: string;
  userType: UserType;
  employeeId?: string;
  brokerEmployeeId?: string;
  brokerCompanyId?: string; // set when userType === 'broker_user'
  customerId?: string;
  locale: 'en' | 'ar';
  failedLoginCount: number;
  lockedUntil?: string;
  createdAt: string;
}

export type ResourceName =
  | 'employee'
  | 'lead'
  | 'opportunity'
  | 'unit'
  | 'payment_plan_template'
  | 'payment_schedule'
  | 'contract'
  | 'broker_company'
  | 'audit_log'
  | 'role'
  | 'branch'
  | 'department'
  | 'project'
  | 'leave_request'
  | 'maintenance_ticket'
  | 'legal_document'
  | 'vendor'
  | 'purchase_order'
  | 'campaign'
  | 'message'
  | 'analytics'
  | 'portal_access'
  | 'workflow'
  | 'workflow_run'
  | 'approval'
  | 'secret'
  | 'task'
  | 'ai_action'
  | 'integration_connection'
  | 'sales_commission'
  | 'forecast';

export type ActionName =
  | 'view'
  | 'create'
  | 'edit'
  | 'delete'
  | 'approve'
  | 'export'
  | 'assign'
  | 'transfer'
  | 'unmask';

export type ScopeName =
  | 'own'
  | 'team'
  | 'department'
  | 'branch'
  | 'company'
  | 'broker_own';

export type SensitivityTier = 'standard' | 'financial' | 'personal' | 'restricted';

export interface Role {
  id: string;
  companyId: string;
  name: string;
  isSystem: boolean;
}

export interface PermissionGrant {
  id: string;
  roleId: string;
  action: ActionName;
  resource: ResourceName;
  scope: ScopeName;
  sensitivity: SensitivityTier;
}

export interface UserRole {
  id: string;
  userId: string;
  roleId: string;
  expiresAt?: string;
}

export interface PermissionOverride {
  id: string;
  userId: string;
  action: ActionName;
  resource: ResourceName;
  effect: 'grant' | 'revoke';
  expiresAt?: string;
}

// ---- Payment Plans ----

export type PaymentFrequency =
  | 'monthly'
  | 'quarterly'
  | 'semiannual'
  | 'annual'
  | 'custom';

export interface PaymentPlanFeeLine {
  label: string;
  amount: number;
  dueMonthOffset: number;
}

export interface PaymentPlanTemplate {
  id: string;
  companyId: string;
  projectId?: string;
  name: string;
  version: number;
  downPaymentType: 'percentage' | 'fixed';
  downPaymentValue: number;
  frequency: PaymentFrequency;
  customMonthInterval?: number;
  termMonths: number;
  fees: PaymentPlanFeeLine[];
  createdAt: string;
  archived: boolean;
}

export type PaymentScheduleLineStatus = 'upcoming' | 'due' | 'overdue' | 'paid';

export interface PaymentScheduleLine {
  id: string;
  companyId: string;
  contractId: string;
  sourceTemplateId: string;
  sourceTemplateVersion: number;
  sequence: number;
  label: string;
  dueDate: string;
  amount: number;
  amountPaid: number;
  status: PaymentScheduleLineStatus;
}

// ---- Inventory ----

export interface Project {
  id: string;
  companyId: string;
  name: string;
  location?: string;
  createdAt: string;
}

export type UnitStatus = 'available' | 'held' | 'reserved' | 'contracted' | 'cancelled';

export interface Unit {
  id: string;
  companyId: string;
  projectId: string;
  code: string;
  unitType: string;
  areaSqm: number;
  listPrice: number;
  status: UnitStatus;
  createdAt: string;
}

export interface UnitHold {
  id: string;
  companyId: string;
  unitId: string;
  heldByUserId: string;
  expiresAt: string;
  active: boolean;
}

export type ReservationStatus = 'active' | 'converted' | 'cancelled';

export interface Reservation {
  id: string;
  companyId: string;
  unitId: string;
  clientId: string; // Lead.id
  opportunityId?: string;
  status: ReservationStatus;
  createdAt: string;
  expiresAt: string;
}

// ---- CRM ----

export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'opportunity' | 'lost';

export interface Lead {
  id: string;
  companyId: string;
  fullName: string;
  phone: string;
  email?: string;
  /** National ID / civil ID — the strongest identity signal for duplicate
   * detection, since a phone or email can be swapped out but this can't. */
  nationalId?: string;
  sourceId?: string;
  status: LeadStatus;
  lostReason?: string;
  ownerEmployeeUserId?: string;
  /** Set once at creation and never changed afterward, even when
   * ownerEmployeeUserId is later reassigned — see
   * CrmService.resolveCommissionOwner (the 60-day lead-ownership
   * protection law). */
  originalOwnerEmployeeUserId?: string;
  createdAt: string;
  /** A skill tag (e.g. "luxury") the Lead Distribution pool can match
   * against Employee.skills for skill-based routing. Optional — leads
   * created without one always route by plain round-robin. */
  requiredSkill?: string;
  /** Set when a distribution pool assigns (or auto-reassigns) this lead —
   * the deadline by which its owner must move it past 'new' before the
   * SLA sweep treats it as breached. Absent when no pool is configured. */
  firstContactSlaDueAt?: string;
  /** Timestamp of the most recent SLA breach sweep that touched this
   * lead, if any — purely informational (the sweep itself is idempotent
   * per cycle via firstContactSlaDueAt, not via this field). */
  slaBreachedAt?: string;
  /** How many times the SLA sweep has auto-reassigned or re-flagged this
   * lead for missing first contact. */
  reassignmentCount?: number;

  // ---- Custom fields ----
  // Real-estate/financial qualifying details captured progressively as
  // the agent learns more about the client — all optional, all free-form
  // where the value genuinely varies by market (no fixed enum invented
  // for e.g. "property type" or "transfer method").
  propertyTypeWanted?: string;
  purchaseGoal?: string;
  preferredLocation?: string;
  minAreaSqm?: number;
  maxAreaSqm?: number;
  expectedDeliveryTimeline?: string;
  maxDownPayment?: number;
  maxInstallment?: number;
  preferredTenorMonths?: number;
  preferredTransferMethod?: string;
}

export type LeadDistributionMode = 'round_robin' | 'skill_based';

/**
 * One per company: the pool of employee-users new leads are auto-assigned
 * across, plus the SLA window their owner has to make first contact
 * before the sweep (sweepSlaBreachesAndEmit, on the same 60s tick as the
 * payment-overdue sweep) auto-reassigns them and penalizes the original
 * owner. `memberUserIds` holds employee_user User ids — the same id shape
 * Lead.ownerEmployeeUserId already uses — in a fixed order that both
 * round-robin and skill-based fall back to for fair rotation.
 */
export interface LeadDistributionPool {
  id: string; // === companyId; one pool per company
  companyId: string;
  mode: LeadDistributionMode;
  memberUserIds: string[];
  slaMinutes: number;
  lastAssignedIndex: number; // index into memberUserIds; -1 before first assignment
  createdAt: string;
  updatedAt: string;
}

// ---- Sales ----

export type OpportunityStage = 'open' | 'reserved' | 'won' | 'lost';

export interface Opportunity {
  id: string;
  companyId: string;
  leadId: string;
  ownerEmployeeUserId: string;
  stage: OpportunityStage;
  createdAt: string;
}

export type ContractStatus =
  | 'draft'
  | 'pending_approval'
  | 'signed'
  | 'cancelled'
  | 'terminated';

export interface Contract {
  id: string;
  companyId: string;
  reservationId: string;
  unitId: string;
  clientId: string;
  creditedEmployeeUserId: string;
  paymentPlanTemplateId: string;
  status: ContractStatus;
  signedAt?: string;
  createdAt: string;
  /** The negotiated contract value, set once at signing (SalesService.signContract
   * already receives this as input — this just persists it instead of
   * discarding it). Optional only so pre-existing test fixtures built before
   * this field existed keep type-checking; every contract signed through the
   * real flow always has one. Used by the Sales Commission Engine and by
   * Forecasting/Scenario Simulation. */
  totalPrice?: number;
}

// ---- Finance ----

export type PaymentMethod = 'cash' | 'transfer' | 'card' | 'cheque';

export interface Payment {
  id: string;
  companyId: string;
  contractId: string;
  paymentScheduleLineId: string;
  amount: number;
  method: PaymentMethod;
  recordedByUserId: string;
  createdAt: string;
}

export interface Receipt {
  id: string;
  companyId: string;
  paymentId: string;
  receiptNumber: string;
  issuedAt: string;
}

/** A real reversal of money already collected on a payment schedule line —
 * always requires approval via the Universal Approval Engine (see the
 * 'refund' ActionApproval type), since it undoes a recorded receipt. */
export interface Refund {
  id: string;
  companyId: string;
  contractId: string;
  paymentScheduleLineId: string;
  amount: number;
  reason: string;
  recordedByUserId: string;
  createdAt: string;
}

// ---- Brokers ----

export type BrokerCompanyStatus = 'pending' | 'approved' | 'suspended' | 'rejected';

export interface BrokerCompany {
  id: string;
  companyId: string; // the internal company this broker sells for
  name: string;
  status: BrokerCompanyStatus;
  createdAt: string;
}

export type BrokerLeadApprovalStatus =
  | 'pending_approval'
  | 'approved'
  | 'rejected_duplicate'
  | 'rejected_other';

export interface BrokerLead {
  id: string;
  companyId: string;
  brokerCompanyId: string;
  submittedByUserId: string;
  fullName: string;
  phone: string;
  email?: string;
  nationalId?: string;
  approvalStatus: BrokerLeadApprovalStatus;
  leadId?: string; // nullable until approved
  createdAt: string;
}

export interface CommissionRule {
  id: string;
  companyId: string;
  brokerCompanyId?: string; // if unset, this is the company-wide default
  ratePercent: number;
}

export type CommissionStatus = 'pending' | 'approved' | 'paid';

export interface Commission {
  id: string;
  companyId: string;
  brokerCompanyId: string;
  contractId: string;
  amount: number;
  status: CommissionStatus;
  createdAt: string;
}

// ---- Internal Sales Commission Engine ----
// Parallel to the broker Commission above but for internal employees —
// kept as its own model rather than overloading Commission/CommissionRule
// with an optional brokerCompanyId-or-employeeUserId discriminant, since
// broker and internal-employee commissions are genuinely different payee
// concepts with different resolution rules (tiered by org hierarchy here,
// not by broker company).

/** 'base' is paid to the contract's credited employee (the same one the
 * 60-day lead-ownership law resolves — see CrmService.resolveCommissionOwner);
 * 'override' is paid to that employee's direct manager, only when an
 * override rule is configured and a manager actually exists. */
export type SalesCommissionTier = 'base' | 'override';

export interface SalesCommissionRule {
  id: string;
  companyId: string;
  tier: SalesCommissionTier;
  employeeUserId?: string; // if unset, this is the company-wide default for this tier
  ratePercent: number;
}

export type SalesCommissionStatus = 'pending' | 'approved' | 'paid' | 'clawed_back';

export interface SalesCommission {
  id: string;
  companyId: string;
  contractId: string;
  employeeUserId: string; // who earns this line
  tier: SalesCommissionTier;
  ratePercent: number;
  amount: number;
  status: SalesCommissionStatus;
  createdAt: string;
  clawedBackReason?: string;
}

// ---- Audit ----

export interface AuditLogEntry {
  id: string;
  companyId: string;
  actorUserId: string;
  action: string;
  resource: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ---- HR ----

export type LeaveType = 'annual' | 'sick' | 'unpaid' | 'other';
export type LeaveRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface LeaveRequest {
  id: string;
  companyId: string;
  employeeId: string;
  type: LeaveType;
  startDate: string;
  endDate: string;
  reason?: string;
  status: LeaveRequestStatus;
  requestedAt: string;
  decidedByUserId?: string;
  decidedAt?: string;
}

// ---- Operations ----

export type MaintenancePriority = 'low' | 'medium' | 'high' | 'urgent';
export type MaintenanceStatus = 'open' | 'in_progress' | 'resolved' | 'closed';

export interface MaintenanceTicket {
  id: string;
  companyId: string;
  unitId: string;
  title: string;
  description?: string;
  priority: MaintenancePriority;
  status: MaintenanceStatus;
  reportedByUserId: string;
  assignedToUserId?: string;
  createdAt: string;
  resolvedAt?: string;
}

// ---- Legal ----

export type LegalDocumentType = 'title_deed' | 'power_of_attorney' | 'nda' | 'id_verification' | 'other';
export type LegalDocumentStatus = 'pending' | 'received' | 'verified' | 'rejected';

export interface LegalDocument {
  id: string;
  companyId: string;
  contractId: string;
  type: LegalDocumentType;
  name: string;
  status: LegalDocumentStatus;
  notes?: string;
  uploadedByUserId: string;
  createdAt: string;
  verifiedAt?: string;
}

// ---- Purchasing ----

export type VendorStatus = 'active' | 'inactive';

export interface Vendor {
  id: string;
  companyId: string;
  name: string;
  category: string;
  contactPhone?: string;
  contactEmail?: string;
  status: VendorStatus;
  createdAt: string;
}

export type PurchaseOrderStatus = 'draft' | 'approved' | 'fulfilled' | 'cancelled';

export interface PurchaseOrder {
  id: string;
  companyId: string;
  vendorId: string;
  projectId?: string;
  description: string;
  amount: number;
  status: PurchaseOrderStatus;
  createdByUserId: string;
  createdAt: string;
  approvedAt?: string;
  fulfilledAt?: string;
}

// ---- Marketing ----

export type CampaignChannel = 'digital' | 'print' | 'event' | 'referral' | 'other';
export type CampaignStatus = 'planned' | 'active' | 'completed' | 'cancelled';

export interface Campaign {
  id: string;
  companyId: string;
  name: string;
  channel: CampaignChannel;
  budget: number;
  startDate: string;
  endDate?: string;
  status: CampaignStatus;
  createdAt: string;
}

// ---- Communication ----

export type MessageRelatedResource = 'lead' | 'contract' | 'opportunity' | 'maintenance_ticket' | 'campaign' | 'payment_schedule_line' | 'leave_request';
export type MessageChannel = 'internal' | 'email' | 'whatsapp' | 'sms';
export type MessageStatus = 'sent' | 'read';

export interface Message {
  id: string;
  companyId: string;
  relatedResource?: MessageRelatedResource;
  relatedResourceId?: string;
  fromUserId: string;
  toUserId?: string;
  subject: string;
  body: string;
  channel: MessageChannel;
  status: MessageStatus;
  createdAt: string;
  readAt?: string;
}

// ---- Customer Portal ----

export interface Customer {
  id: string;
  companyId: string;
  leadId: string;
  fullName: string;
  phone: string;
  email?: string;
  createdAt: string;
}

// ---- Tasks (reminders / follow-ups) ----

export type TaskStatus = 'open' | 'done' | 'cancelled';

export interface Task {
  id: string;
  companyId: string;
  title: string;
  description?: string;
  dueAt?: string;
  assignedToUserId?: string;
  relatedResource?: MessageRelatedResource;
  relatedResourceId?: string;
  status: TaskStatus;
  createdByUserId: string;
  createdAt: string;
  completedAt?: string;
}

// ---- Automation Engine ----

export type TriggerType = 'event' | 'scheduled' | 'webhook';

/**
 * The catalogue of domain events the engine can react to. Emitted from
 * app.ts route handlers right after the underlying service call succeeds
 * (never from inside the services themselves, to keep every existing
 * service's public API and tests untouched) — see EventBus.
 */
export type DomainEventType =
  | 'lead.created'
  | 'lead.status_changed'
  | 'lead.sla_breached'
  | 'opportunity.created'
  | 'contract.signed'
  | 'contract.cancelled'
  | 'payment.recorded'
  | 'payment.overdue_swept'
  | 'maintenance_ticket.created'
  | 'maintenance_ticket.status_changed'
  | 'leave_request.created'
  | 'leave_request.decided'
  | 'purchase_order.created'
  | 'purchase_order.status_changed'
  | 'legal_document.status_changed'
  | 'campaign.status_changed'
  | 'broker_lead.submitted'
  | 'employee.created'
  | 'sales_commission.recorded'
  | 'sales_commission.status_changed'
  | 'action_approval.requested'
  | 'action_approval.decided'
  | 'contract.amended'
  | 'payment.refunded';

export type ConditionOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists';

export interface WorkflowCondition {
  field: string; // dot-path into the trigger payload, e.g. "lead.status"
  operator: ConditionOperator;
  value?: unknown;
}

export type AutomationActionType =
  | 'create_task'
  | 'send_message'
  | 'create_lead'
  | 'update_lead_status'
  | 'assign_lead_owner'
  | 'update_campaign_status'
  | 'webhook_call'
  | 'integration_call'
  | 'ai_decide'
  | 'require_approval'
  | 'record_payment'
  | 'cancel_contract';

export interface WorkflowActionConfig {
  type: AutomationActionType;
  /** Action-specific parameters. String values may reference the trigger
   * payload with `{{path.to.field}}` templating, resolved at execution
   * time — see automation.service.ts `resolveTemplate`. */
  params: Record<string, unknown>;
}

export interface WorkflowStepDefinition {
  id: string;
  name: string;
  /** All conditions must pass (AND) for this step's action to run;
   * otherwise the step is skipped and the run moves to the next step —
   * this is how branching is expressed (define multiple steps, each
   * gated on a different condition, off the same trigger). */
  conditions?: WorkflowCondition[];
  action: WorkflowActionConfig;
  onFailure?: 'stop' | 'continue';
  maxRetries?: number;
}

export interface WorkflowTriggerConfig {
  type: TriggerType;
  eventType?: DomainEventType; // required when type === 'event'
  intervalMinutes?: number; // required when type === 'scheduled'
  webhookSlug?: string; // required when type === 'webhook'
}

export type WorkflowStatus = 'active' | 'paused' | 'archived';

export interface WorkflowDefinition {
  id: string;
  companyId: string;
  name: string;
  description?: string;
  trigger: WorkflowTriggerConfig;
  steps: WorkflowStepDefinition[];
  status: WorkflowStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  lastScheduledRunAt?: string;
}

export type WorkflowRunStatus = 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
export type WorkflowRunInitiator = 'system' | 'user' | 'ai';

export interface WorkflowRun {
  id: string;
  companyId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  triggerEventType?: string;
  triggerPayload: Record<string, unknown>;
  /** Deduplicates re-delivery of the same trigger (a retried event, a
   * repeated webhook call, a scheduler tick that overlaps a prior one) —
   * a run is only ever created once per (workflowId, idempotencyKey). */
  idempotencyKey: string;
  currentStepIndex: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  initiatedBy: WorkflowRunInitiator;
  initiatedByUserId?: string;
}

export type StepRunStatus = 'succeeded' | 'failed' | 'skipped' | 'waiting_approval';

export interface WorkflowStepRun {
  id: string;
  companyId: string;
  runId: string;
  stepId: string;
  status: StepRunStatus;
  attempts: number;
  output?: Record<string, unknown>;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalRequest {
  id: string;
  companyId: string;
  runId: string;
  stepId: string;
  reason: string;
  status: ApprovalStatus;
  decidedByUserId?: string;
  decidedAt?: string;
  createdAt: string;
}

// ---- Universal Approval Engine ----
// ApprovalRequest above only ever exists as part of an Automation Workflow
// run (it requires a runId/stepId) — there's no way for an ordinary route
// to gate a single action behind a manager's approval without wrapping it
// in a full workflow. ActionApproval is that missing generic mechanism:
// any route can create one, store enough context to finish the gated
// action later, and resume it once approved — see
// app.ts recordActionApprovalDecision + the discount-override gate on
// contract signing for the first real, wired example.
export type ApprovableActionType = 'discount_override' | 'contract_amendment' | 'refund';

export interface ActionApproval {
  id: string;
  companyId: string;
  actionType: ApprovableActionType;
  requestedByUserId: string;
  reason: string;
  /** Exactly what's needed to finish the gated action once approved —
   * shape depends on actionType (see app.ts's dispatch for each type). */
  context: Record<string, unknown>;
  status: ApprovalStatus;
  decidedByUserId?: string;
  decidedAt?: string;
  rejectionReason?: string;
  /** Set if the action itself failed when resumed after approval (e.g. the
   * reservation was no longer active by the time someone approved it) —
   * the approval decision still stands; this just records that acting on
   * it didn't succeed, instead of silently losing that information. */
  resumeFailedReason?: string;
  createdAt: string;
}

/** Per-company policy: a contract's discountPercent above this threshold
 * can't be signed directly — it creates an ActionApproval instead. Absent
 * entirely (no row for a company) means no gate at all, so a company
 * that never configures one sees zero behavior change. */
export interface DiscountApprovalPolicy {
  id: string; // === companyId, one policy per company
  companyId: string;
  maxDiscountPercentWithoutApproval: number;
}

/** Encrypted-at-rest credential store for outbound webhook_call actions
 * (bearer tokens, API keys, etc.) — see infra/secret-store.ts. Never
 * returned in plaintext by any list/get route. */
export interface Secret {
  id: string;
  companyId: string;
  key: string; // unique per company, e.g. "zapier_webhook_token"
  encryptedValue: string;
  iv: string;
  authTag: string;
  createdByUserId: string;
  createdAt: string;
}

// ---- AI Execution Layer ----

/** How far the AI Agent may go for a given action type, per company.
 * Missing an entry for an action type defaults to 'require_approval' —
 * the engine never auto-executes an AI action the company hasn't
 * explicitly opted into. */
export type AiAutonomyLevel = 'suggest_only' | 'require_approval' | 'auto_execute';

export interface AiPolicy {
  id: string;
  companyId: string;
  actionType: AutomationActionType;
  autonomyLevel: AiAutonomyLevel;
  updatedByUserId: string;
  updatedAt: string;
}

export type AiActionStatus = 'suggested' | 'pending_approval' | 'executed' | 'denied_permission' | 'denied_policy';

/** The full audit trail of every action the AI Agent has proposed, for
 * every human it acted on behalf of, whatever the outcome. */
export interface AiActionRequest {
  id: string;
  companyId: string;
  requestedByUserId: string;
  actionType: AutomationActionType;
  params: Record<string, unknown>;
  reasoning?: string;
  status: AiActionStatus;
  runId?: string;
  approvalRequestId?: string;
  createdAt: string;
}

// ---- AI Agent Orchestration Layer ----

/** A candidate action a specialized agent considered but did not choose —
 * kept alongside the chosen action so a decision is explainable, not just
 * a bare result. */
export interface AgentAlternative {
  actionType: AutomationActionType;
  confidence: number;
  reasoning: string;
}

export type AgentDecisionStatus =
  | 'proceeded' // confidence cleared the agent's threshold and the action was within its boundary — routed into requestAction()
  | 'escalated' // confidence too low, or the chosen action fell outside the agent's declared boundary — needs a human to decide
  | 'no_action'; // the agent confidently determined nothing needs to happen for this subject right now

/** One specialized agent's decision about one subject (a lead, a campaign,
 * an overdue payment line, a maintenance ticket, a leave request) — the
 * durable record behind "agent execution history" and "explainable
 * decisions". Recent decisions for the same subject double as the agent's
 * memory: a fresh "Ask AI" click within the cooldown window returns the
 * still-relevant prior decision instead of re-deciding and duplicating
 * work. */
export interface AgentDecision {
  id: string;
  companyId: string;
  agentKey: string;
  subjectType: string;
  subjectId: string;
  chosenActionType?: AutomationActionType;
  params?: Record<string, unknown>;
  confidence: number;
  reasoning: string;
  alternatives: AgentAlternative[];
  status: AgentDecisionStatus;
  aiActionRequestId?: string;
  /** A snapshot of the resulting AiActionRequest's status at decision time
   * (when status === 'proceeded') — lets a caller show the outcome without
   * a second round trip. */
  resultActionStatus?: AiActionStatus;
  requestedByUserId: string;
  createdAt: string;
}

// ---- Integration Layer ----

export type IntegrationProvider =
  | 'whatsapp'
  | 'email'
  | 'meta_ads'
  | 'google_calendar'
  | 'payment_stripe'
  | 'custom_api';

export type IntegrationConnectionStatus = 'connected' | 'disconnected' | 'error';

/**
 * One company's connection to an external provider. Credentials never live
 * here — `credentialKeys` names the entries in the existing encrypted
 * Secret store (the same AES-256-GCM store the Automation Engine's
 * webhook_call action uses) that hold the actual tokens/API keys.
 * Non-secret provider config (a WhatsApp phone number id, an email
 * from-address, a Stripe account id) lives in `config` directly since it
 * isn't sensitive.
 */
export interface IntegrationConnection {
  id: string;
  companyId: string;
  provider: IntegrationProvider;
  displayName: string;
  config: Record<string, unknown>;
  credentialKeys: string[];
  status: IntegrationConnectionStatus;
  lastError?: string;
  lastUsedAt?: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export type IntegrationEventStatus = 'success' | 'failed' | 'rate_limited';

/** The delivery log for every outbound call the Integration Layer makes —
 * real logging/failure-handling visibility, not just a console line. */
export interface IntegrationEvent {
  id: string;
  companyId: string;
  connectionId: string;
  provider: IntegrationProvider;
  action: string;
  status: IntegrationEventStatus;
  requestSummary: Record<string, unknown>;
  attempts: number;
  error?: string;
  createdAt: string;
}
