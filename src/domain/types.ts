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
  | 'forecast'
  | 'crm_stage'
  | 'quotation'
  | 'signature_envelope'
  | 'ai_memory'
  | 'ai_llm_config';

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
  /** Interest/payment-free period before the first installment is due —
   * distinct from termMonths (the installment schedule's own length). */
  gracePeriodMonths?: number;
  /** % of total price due at handover, on top of the regular installment
   * schedule — schedule-generator.ts adds this as its own schedule line
   * when set. */
  deliveryPaymentPercent?: number;
  /** How many months of installments continue after delivery (a "payment
   * after delivery" plan) — 0/undefined means the plan fully settles
   * before or at delivery. */
  paymentAfterDeliveryMonths?: number;
  /** The cash-discount percentage that applied when this template version
   * was created — a snapshot, not a live value: updateTemplate() bumps
   * `version` rather than mutating in place, so an old quotation/contract
   * that cites `sourceTemplateVersion` keeps the discount that was real at
   * the time, never a silently-changed one. */
  cashDiscountPercent?: number;
  maintenanceFeePercent?: number;
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

// ---- Quotations ----
// Wraps the existing PaymentPlansService calculation engine
// (schedule-generator.ts's generateSchedule) for pre-sale, no-commitment
// "what would this deal look like" documents — never a second calculation
// engine. Generating or re-generating a quotation never writes to
// Unit/Reservation/Contract/Finance; it only ever reads a Unit's listPrice
// and an existing PaymentPlanTemplate.

export type QuotationStatus = 'draft' | 'generated' | 'sent' | 'accepted' | 'expired' | 'cancelled';

export interface Quotation {
  id: string;
  companyId: string;
  /** Human-facing, unique-per-company identifier (e.g. "Q-20260101-0007")
   * — never reused, even after cancellation. */
  referenceNumber: string;
  /** Monotonically increasing per (companyId, unitId, leadId) — a new
   * quotation for the same unit/client is always a new version, never an
   * overwrite of a prior one. */
  version: number;
  unitId: string;
  projectId: string;
  leadId?: string;
  paymentPlanTemplateId: string;
  /** The template's own `version` at the moment this quotation/offer was
   * generated — captured alongside scheduleSnapshot below purely for
   * traceability (which exact template shape produced this schedule),
   * matching PaymentScheduleLine.sourceTemplateVersion's same purpose on a
   * signed contract's real schedule. */
  sourceTemplateVersion: number;
  status: QuotationStatus;
  /** The exact inputs the schedule was computed from. */
  inputs: {
    totalPrice: number;
    discountPercent: number;
    escalationPercentPerYear: number;
    startDate: string;
  };
  /** The generated schedule lines, computed once at generate() time and
   * never recomputed — a real deep snapshot, not a replay. Reading a
   * quotation/offer (preview, PDF, Excel, "view saved") always renders
   * this stored array directly, so it stays byte-for-byte reproducible
   * even if the unit's price or the payment plan template are edited or
   * deleted after the fact — the same immutability guarantee
   * PaymentScheduleLine gives a signed contract's real schedule. */
  scheduleSnapshot: Array<{
    sequence: number;
    label: string;
    dueDate: string;
    amount: number;
    status: PaymentScheduleLineStatus;
  }>;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Inventory ----
// A real-estate Inventory Intelligence layer, not a single flat Unit table:
// Developer -> Project -> ProjectPhase -> Launch -> Unit, with Facility/
// Consultant/SalesPhoneNumber as their own company-scoped entities a
// Project references by id (never duplicated per-unit). Every new entity
// here is gated on the existing 'project' RBAC resource (create/edit/view)
// rather than adding six near-identical new resources — they're all
// project master data, and CEO already has full CRUD on 'project' via the
// existing ALL_RESOURCES grant loop in seed.ts.

export interface Developer {
  id: string;
  companyId: string;
  name: string;
  description?: string;
  website?: string;
  logoUrl?: string;
  createdAt: string;
}

export interface ProjectPhase {
  id: string;
  companyId: string;
  projectId: string;
  name: string;
  /** Pipeline/display position — phases are shown and imported in this
   * order, not creation order. */
  order: number;
  createdAt: string;
}

export interface Launch {
  id: string;
  companyId: string;
  projectId: string;
  phaseId?: string;
  name: string;
  launchDate?: string;
  /** Number of units released in this launch — informational, never used
   * to derive real unit counts (those come from real Unit rows). */
  inventoryReleased?: number;
  pricingNotes?: string;
  paymentPlanTemplateIds?: string[];
  source?: string;
  notes?: string;
  createdAt: string;
}

export interface Facility {
  id: string;
  companyId: string;
  name: string;
  category?: string;
  createdAt: string;
}

export type ConsultantRole = 'engineering' | 'project_management' | 'other';

export interface Consultant {
  id: string;
  companyId: string;
  name: string;
  role: ConsultantRole;
  contactInfo?: string;
  createdAt: string;
}

export interface SalesPhoneNumber {
  id: string;
  companyId: string;
  projectId: string;
  phoneNumber: string;
  countryCode?: string;
  type?: string;
  source?: string;
  isActive: boolean;
  createdAt: string;
}

/** Structured delivery info shared by Project (a default) and Unit (an
 * optional override) — every part is optional so a caller shows exactly
 * the granularity a developer actually supplied (a quarter, a year, a
 * phase label) rather than forcing an approximate estimate into a false-
 * precision exact date. */
export interface DeliveryInfo {
  exactDate?: string;
  quarter?: 1 | 2 | 3 | 4;
  year?: number;
  phaseLabel?: string;
}

export interface Project {
  id: string;
  companyId: string;
  name: string;
  location?: string;
  /** Geographic market/destination (e.g. "New Cairo", "North Coast") — a
   * free string, deliberately not a hard-coded enum of Egyptian
   * destinations, so any company/market can use it. */
  destination?: string;
  developerId?: string;
  locationLat?: number;
  locationLng?: number;
  locationMapUrl?: string;
  address?: string;
  landAreaFromSqm?: number;
  landAreaToSqm?: number;
  buaFromSqm?: number;
  buaToSqm?: number;
  gardenAreaFromSqm?: number;
  gardenAreaToSqm?: number;
  priceFrom?: number;
  priceTo?: number;
  /** ISO 4217 code, e.g. "EGP"/"USD" — never assumed to always be EGP. */
  currency?: string;
  pricePerMeter?: number;
  /** Whether pricePerMeter was explicitly supplied by the developer or
   * derived here from priceFrom/buaFrom — a computed value never silently
   * overwrites an explicitly-supplied one (see InventoryService). */
  pricePerMeterSource?: 'developer' | 'computed';
  /** Project-level default finishing — a free/configurable string, not a
   * hard-coded enum; a Unit may override it with its own finishingType. */
  finishingType?: string;
  delivery?: DeliveryInfo;
  projectAreaSqm?: number;
  projectAreaUnit?: string;
  /** The unit categories marketed within this project (e.g. ["Apartment",
   * "Twin House"]) — informational/marketing, not a hard FK; a Unit's own
   * `unitType` stays the source of truth for what's actually in inventory. */
  typeOfUnits?: string[];
  facilityIds?: string[];
  engineeringConsultantId?: string;
  projectManagementId?: string;
  /** قرار وزاري (Ministerial Decision) — English field names internally,
   * with Arabic/English UI labels applied at the presentation layer. */
  ministerialDecisionNumber?: string;
  ministerialDecisionDate?: string;
  ministerialDecisionAuthority?: string;
  ministerialDecisionDocumentUrl?: string;
  cashDiscountPercent?: number;
  cashDiscountAmount?: number;
  cashDiscountValidUntil?: string;
  cashDiscountSource?: string;
  cashDiscountEffectiveDate?: string;
  maintenanceFeePercent?: number;
  maintenanceFeeAmount?: number;
  /** Gallery of already-hosted image URLs (rendering/exterior/amenity
   * photos) shown on the Offer PDF's cover — same "paste a URL" convention
   * as ministerialDecisionDocumentUrl/locationMapUrl; this system has no
   * object-storage upload pipeline, so images live wherever the developer
   * already hosts them (a CDN, Drive, etc). */
  imageUrls?: string[];
  /** The project's master-plan image URL — a Unit highlights itself on
   * this image via its own masterPlanPosition. */
  masterPlanImageUrl?: string;
  /** The single image shown on a project card in the catalog browser —
   * same "paste a URL" convention as imageUrls; falls back to
   * imageUrls[0] at the presentation layer when unset, never required. */
  coverImageUrl?: string;
  createdAt: string;
}

/** A staff user's personal bookmark on a Project — purely a UI convenience
 * (quick access from the catalog browser's "favorites" filter), scoped to
 * the user who set it, not a shared/team concept. Gated on the same
 * view:project permission as browsing itself; no dedicated RBAC resource. */
export interface ProjectFavorite {
  id: string;
  companyId: string;
  userId: string;
  projectId: string;
  createdAt: string;
}

export type UnitStatus = 'available' | 'held' | 'reserved' | 'contracted' | 'cancelled';

/** A unit's highlighted rectangle on its project's masterPlanImageUrl, as
 * percentages (0-100) of the image's width/height — resolution-independent
 * so the same coordinates highlight correctly regardless of how the master
 * plan image itself is later re-exported/resized. */
export interface MasterPlanPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Unit {
  id: string;
  companyId: string;
  projectId: string;
  phaseId?: string;
  code: string;
  /** The unit's category (Apartment/Villa/Chalet/...) — a free/configurable
   * string, never a hard-coded enum, so a company can add its own types
   * without a code change. */
  unitType: string;
  areaSqm: number;
  listPrice: number;
  status: UnitStatus;
  /** The raw status text a source file last used (e.g. "Available", "HOLD",
   * "Booked") before normalization to `status` — kept for audit only; never
   * read by business logic, which always uses the normalized `status`. */
  sourceStatus?: string;
  floorLabel?: string;
  bedrooms?: number;
  /** Layout/model type (e.g. "Type A", "Garden", "Corner") — configurable
   * free string. */
  designType?: string;
  /** Multiple views are allowed (e.g. ["Garden", "Pool"]). */
  view?: string[];
  gardenAreaSqm?: number;
  buildingLabel?: string;
  /** Overrides Project.finishingType when this specific unit differs. */
  finishingType?: string;
  /** Overrides Project.delivery when this specific unit differs. */
  delivery?: DeliveryInfo;
  /** An explicit, developer-supplied price-per-meter — otherwise this is
   * computed on read as listPrice/areaSqm, never stored (and so never
   * goes stale relative to listPrice/areaSqm edits). */
  pricePerMeterOverride?: number;
  /** An already-hosted image URL of this unit's own floor plan — shown on
   * the Offer PDF alongside the master-plan highlight. Same "paste a URL"
   * convention as Project.imageUrls (see its own comment). */
  floorPlanImageUrl?: string;
  /** Where this unit highlights on its project's masterPlanImageUrl. */
  masterPlanPosition?: MasterPlanPosition;
  /** Import provenance — which import created/last updated this unit, and
   * where in the source file. Optional: manually-created units have none. */
  sourceImportId?: string;
  sourceSheet?: string;
  sourceRow?: number;
  createdAt: string;
}

/**
 * A "Unit Specification / Product Range" — what a project catalog/market
 * sheet describes (e.g. "Apartment, 2 Bedrooms, BUA 120-135, Price 8M-10M")
 * as opposed to a real, individually-coded `Unit`. Deliberately its own
 * entity rather than a Unit with fuzzy/range fields: a catalog row has no
 * stable physical identity (no unit code, no single floor/building), so
 * importing one must never fabricate a fake Unit row. Scoped one level
 * finer than Project's own single land/BUA/garden/price range (which can
 * only hold one range project-wide) — a project commonly markets several
 * distinct unit-type/bedroom combinations, each with its own range, at the
 * same time. Gated on the existing 'project' RBAC resource, matching every
 * other project-master-data entity in this file (see the module comment
 * above Developer). */
export interface ProjectUnitSpec {
  id: string;
  companyId: string;
  projectId: string;
  phaseId?: string;
  /** Free string, matching Unit.unitType's convention — never a hard enum. */
  unitType: string;
  bedrooms?: number;
  landAreaFromSqm?: number;
  landAreaToSqm?: number;
  buaFromSqm?: number;
  buaToSqm?: number;
  gardenAreaFromSqm?: number;
  gardenAreaToSqm?: number;
  priceFrom?: number;
  priceTo?: number;
  pricePerMeter?: number;
  /** Overrides Project.finishingType for this specific spec, same override
   * convention as Unit.finishingType. */
  finishingType?: string;
  delivery?: DeliveryInfo;
  paymentPlanTemplateIds?: string[];
  cashDiscountPercent?: number;
  maintenanceFeePercent?: number;
  /** Import provenance — which import produced/last touched this spec, and
   * where in the source file. Optional: manually-created specs have none. */
  sourceImportId?: string;
  sourceSheet?: string;
  sourceRow?: number;
  createdAt: string;
  updatedAt: string;
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

/** @deprecated superseded by CrmStage (Lead.stageId) — kept only so old
 * stored rows and any code still reading it don't lose data. Never written
 * by new code. */
export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'opportunity' | 'lost';

/**
 * A company-configurable pipeline stage a Lead can sit in — replaces the
 * old hardcoded LeadStatus union as the single source of truth for a
 * lead's classification. Seeded with a default set (Fresh Leads,
 * Contacted, Follow Up, Qualified, Meeting, Negotiation, Proposal,
 * Booking, Won, Lost, Unqualified, Recycle — see
 * CrmStageService.seedDefaultStages) but an admin can add/edit/reorder/
 * deactivate their own without any code change: every place that used to
 * branch on a literal status string now reads isDefault/isWon/isLost/
 * order instead.
 */
export interface CrmStage {
  id: string;
  companyId: string;
  /** Stable slug for the seeded defaults (e.g. 'fresh', 'won') — purely
   * informational for custom admin-created stages, never branched on by
   * business logic (which uses the flags below instead). */
  key: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  /** Pipeline position — lower sorts first. Drives tab ordering and the
   * "advance to the next stage" logic in decideSales/lead-scoring. */
  order: number;
  isActive: boolean;
  /** The stage a newly created Lead lands in unless a distribution rule
   * says otherwise (exactly one per company; enforced by
   * CrmStageService). This is what "Fresh Leads" means structurally. */
  isDefault: boolean;
  /** Terminal-success flag (e.g. "Won"). */
  isWon: boolean;
  /** Terminal-failure flag (e.g. "Lost") — moving a lead into any
   * isLost-flagged stage requires a lostReason. */
  isLost: boolean;
  allowManualMove: boolean;
  allowAutomationMove: boolean;
  createdAt: string;
  updatedAt: string;
}

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
  /** The lead's real classification — see CrmStage. Always set (defaults
   * to the company's isDefault stage on creation). */
  stageId: string;
  /** @deprecated superseded by stageId. Left in place, never written by
   * new code, so historical rows keep their original value. */
  status?: LeadStatus;
  lostReason?: string;
  tags?: string[];
  priority?: 'low' | 'medium' | 'high' | 'urgent';
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
  /** The negotiated contract value BEFORE discount, set once at signing
   * (SalesService.signContract already receives this as input — this just
   * persists it instead of discarding it). Optional only so pre-existing
   * test fixtures built before this field existed keep type-checking;
   * every contract signed through the real flow always has one. */
  totalPrice?: number;
  /** Discount applied at signing (or the most recent amendment), 0-100.
   * Needed alongside totalPrice to recover the actual net/collectible
   * contract value (totalPrice * (1 - discountPercent/100)) — the figure
   * the Sales Commission Engine and Forecasting must use, not the raw
   * pre-discount totalPrice, since a discount reduces real deal value. */
  discountPercent?: number;
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
  /** The broker-deal-registration protection window: while a BrokerLead is
   * still `pending_approval` and this hasn't passed, no other broker
   * company may submit the same prospect (matched by phone/email/
   * nationalId) — see BrokersService.submitBrokerLead. Always set at
   * submission (60 days out, matching CRM's own lead-ownership protection
   * convention). Expiry only lifts the exclusivity; it never invalidates
   * the submission itself, so an internal user can still approve or reject
   * it after the window closes. */
  protectionExpiresAt: string;
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
  /** Who actually initiated this: a human user (the default, and the only
   * value every pre-existing entry implicitly has) or the AI Agent acting
   * autonomously via AutomationService.executeActionDirect(). Optional so
   * every audit call site written before this existed stays valid. */
  actorType?: 'user' | 'ai_agent';
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

export type MessageRelatedResource = 'lead' | 'contract' | 'opportunity' | 'maintenance_ticket' | 'campaign' | 'payment_schedule_line' | 'leave_request' | 'quotation';
export type MessageChannel = 'internal' | 'email' | 'whatsapp' | 'sms' | 'call' | 'note';
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
  /** Set when this message/comment/log was created by the AI Agent
   * executing a chosen action rather than a human typing it in — see
   * AuditLogEntry.actorType for the same distinction on audit rows. */
  actorType?: 'user' | 'ai_agent';
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
  /** Who actually completed/cancelled it — distinct from createdByUserId,
   * since a follow-up is very often completed by someone other than
   * whoever scheduled it. Set alongside completedAt. */
  completedByUserId?: string;
  /** See Message.actorType — set when the AI Agent created this task. */
  actorType?: 'user' | 'ai_agent';
}

// ---- File Import Pipeline ----
// Shared by Lead Import, Inventory Import, and Payment Import — one staged
// upload -> parse -> map -> preview -> confirm pipeline, not three separate
// import systems. Each specific importer (see modules/imports) owns its own
// field dictionary, duplicate/conflict detection, and write path (e.g.
// CrmService.createLead) — this type only carries the shared parsing/mapping
// state common to all of them.

export type ImportTargetType = 'lead' | 'inventory_unit' | 'payment';
export type ImportFileType = 'csv' | 'xlsx' | 'pdf';
export type ImportSessionStatus = 'uploaded' | 'mapped' | 'confirmed' | 'failed';

export interface ImportSession {
  id: string;
  companyId: string;
  createdByUserId: string;
  targetType: ImportTargetType;
  fileName: string;
  fileType: ImportFileType;
  status: ImportSessionStatus;
  /** Column headers as detected in the source file, in original order. */
  detectedColumns: string[];
  /** detectedColumn -> target field key, guessed by fuzzy header matching.
   * Never applied silently — the frontend always shows this for the user to
   * confirm or correct before anything is imported (see field-mapping.ts). */
  suggestedMapping: Record<string, string | null>;
  /** Set once the user confirms (or edits) the mapping via the preview step. */
  confirmedMapping?: Record<string, string | null>;
  /** Parsed data rows keyed by detectedColumns header — the raw, unmapped
   * values exactly as read from the file. */
  rawRows: Record<string, string>[];
  /** Populated for PDF imports whose table reconstruction is a best-effort
   * heuristic — see pdf-parser.ts's assessTableConfidence. When false the
   * frontend must show a clear error rather than let the user import
   * fabricated/misaligned data. */
  reliable: boolean;
  /** Set alongside confirmedMapping — importer-specific resolution options
   * (e.g. Inventory Import's rangeStrategy/autoGenerateUnitCode/
   * autoCreateMissingProjects) the preview step was built with, replayed
   * unchanged at confirm time so the two steps never resolve a row
   * differently. */
  importOptions?: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
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
  | 'lead.stage_changed'
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
  | 'payment.refunded'
  | 'reservation.expired'
  | 'contract.signature_sent'
  | 'contract.signature_completed';

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
  | 'cancel_contract'
  | 'search_units'
  | 'score_lead'
  | 'compare_payment_plans'
  | 'get_delivery_status'
  | 'recall_memory'
  | 'search_projects'
  | 'get_project_details'
  | 'get_project_payment_plans'
  | 'get_developer_portfolio'
  | 'get_project_facilities'
  | 'get_project_location';

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
  /** Extra guardrails evaluated on top of autonomyLevel (see
   * AiAgentService.evaluatePolicyLimits) — every one of these, when
   * configured, can only ever push an action from auto_execute down to
   * require_approval; none of them can loosen a stricter autonomyLevel.
   * A limit that isn't set is simply not checked. */
  /** For an action whose params carry a numeric `amount` (currently
   * record_payment) — an amount over this always requires approval,
   * regardless of autonomyLevel. */
  maxFinancialAmount?: number;
  /** For integration_call — restricts which provider the AI may use for
   * this action type (e.g. ['email'] to block AI-initiated WhatsApp
   * while still allowing email). A provider not in this list requires
   * approval. Unset means no channel restriction. */
  allowedChannels?: string[];
  /** For integration_call — "HH:mm" company-local 24h clock. Outside this
   * window (inclusive), the action requires approval. Both must be set
   * together; either alone is ignored. */
  workingHoursStart?: string;
  workingHoursEnd?: string;
  updatedByUserId: string;
  updatedAt: string;
}

export type AiActionStatus = 'suggested' | 'pending_approval' | 'executed' | 'denied_permission' | 'denied_policy';

/** Whether the actual resulting state was re-read and confirmed to match
 * what the action claimed to do — not just that executeActionDirect()
 * returned without throwing. 'verified': the target entity was re-read and
 * matches the expected outcome. 'failed': it was re-read and does NOT
 * match (executeActionDirect() succeeded, but the real state disagrees —
 * a genuine PARTIAL_SUCCESS/FAILED signal, not a crash). 'not_applicable':
 * this tool has no defined post-execution check (e.g. a webhook call with
 * no fixed response schema) — never a silent stand-in for "verified". */
export type AiActionVerificationStatus = 'verified' | 'failed' | 'not_applicable';

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
  /** Populated only once status reaches 'executed' — see
   * AiActionVerificationStatus. Undefined for every other status (a
   * suggested/pending/denied action was never executed, so there is
   * nothing yet to verify). */
  verificationStatus?: AiActionVerificationStatus;
  verificationDetail?: string;
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
  /** Read from the Tool Registry entry for chosenActionType (see
   * ai-agent.service.ts's TOOL_REGISTRY) — the same real blast-radius
   * classification used for every other AI action, not a second,
   * decision-specific guess. Undefined when no action was chosen. */
  riskLevel?: 'low' | 'medium' | 'high';
  /** The RBAC grant chosenActionType actually requires, read from the same
   * ACTION_RESOURCE/ACTION_VERB maps AutomationService enforces at
   * execution time. Undefined when no action was chosen. */
  requiredPermission?: { action: ActionName; resource: ResourceName };
  /** Whether this company's AiPolicy for chosenActionType requires a human
   * approval step (i.e. autonomy is not 'auto_execute') at the moment this
   * decision was made. Undefined when no action was chosen. */
  approvalRequired?: boolean;
  /** A concrete, deterministic description of what happens next — derived
   * from this decision's actual outcome (proceeded/escalated/no_action and,
   * for 'proceeded', the resulting AiActionRequest's status), never a
   * fabricated or generic string. */
  nextRecommendedStep: string;
  requestedByUserId: string;
  createdAt: string;
}

// ---- AI Memory Layer ----

/** Which "kind" of memory this is — not a storage mechanism distinction
 * (they're all the same table), but what a caller/UI groups by. 'working'
 * and 'short_term' are meant to be short-lived (set a near expiresAt);
 * 'long_term'/'company'/'agent' are meant to persist; 'lead'/'customer'/
 * 'workflow' are subject-scoped (set subjectType/subjectId). */
export type AiMemoryCategory = 'working' | 'short_term' | 'long_term' | 'customer' | 'lead' | 'agent' | 'company' | 'workflow';

export type AiMemorySourceType = 'agent_decision' | 'user_note' | 'workflow_run' | 'communication' | 'system';

/**
 * A single stored fact/observation the AI layer can recall later —
 * distinct from the ad-hoc "re-read a recent AgentDecision"/"check
 * IntegrationEvent log" cooldown checks already scattered through
 * ai-agent.service.ts (findRecentDecision, hasAlreadyReachedOut): those
 * are narrow, single-purpose lookups against other entities' own tables,
 * not a general-purpose memory store. This is that general store —
 * explicit content, explicit provenance, explicit confidence, explicit
 * retention — not a place to dump every event automatically ("do not
 * store everything" is a caller discipline this type's `source` and
 * `confidence` fields exist to support, not something storage alone can
 * enforce).
 *
 * `content` is always DATA, never an instruction — nothing in this
 * codebase ever parses/evaluates a memory's content as a command, and
 * that must remain true if/when an LLM layer is added (see
 * AiMemoryService's class doc comment).
 */
export interface AiMemory {
  id: string;
  companyId: string;
  category: AiMemoryCategory;
  /** What real entity this memory is about, when it's about one specific
   * thing (a lead, a customer, the company itself). Omitted for a
   * category like 'agent' that isn't tied to a single subject. */
  subjectType?: string;
  subjectId?: string;
  /** A short label for search/filtering — not required, but makes recall
   * by topic possible without a full-text scan. */
  key?: string;
  content: string;
  tags?: string[];
  /** Where this memory came from — mandatory, never optional, because an
   * un-sourced memory is unverifiable and a real trust/audit problem
   * (see the "provenance" requirement this satisfies). */
  source: { type: AiMemorySourceType; id?: string };
  /** 0-100: how sure the source is of this fact — an agent decision might
   * record 60, a directly-observed system fact (e.g. "this lead has no
   * assigned owner") might record 100. Purely informational today (no
   * caller currently filters on it), but real and stored so a future
   * caller — or a future LLM layer weighing memories — can. */
  confidence: number;
  sensitivity: SensitivityTier;
  createdByUserId?: string;
  createdAt: string;
  /** Retention: a memory past this timestamp is excluded from recall()
   * and eligible for the sweep tick — real expiry, not just a UI filter. */
  expiresAt?: string;
  /** A human/system explicitly marked this memory wrong/stale — excluded
   * from recall() but never physically deleted, so the correction itself
   * stays auditable (who invalidated what, and when). */
  invalidatedAt?: string;
  invalidatedByUserId?: string;
}

// ---- LLM Provider Abstraction ----
// A real, testable adapter boundary — no external AI API is configured for
// this deployment (see lead-scoring.service.ts's own doc comment: every
// existing "AI agent" decision is deterministic, rule-based logic reading
// real service data). This section is the scaffolding a real provider
// plugs into: config schema, an encrypted-secret-backed API key reference
// (never the raw key itself, reusing AutomationService's existing
// encrypted Secret store — the same one Integration connectors use),
// per-call usage/cost tracking, and a company-settable daily token budget.
// LlmOrchestratorService (modules/ai/llm-orchestrator.service.ts) is the
// only thing that ever calls a configured provider, and it never fabricates
// a response: with no AiModelConfig set for a company, every call fails
// honestly rather than returning invented text.

/** Not a hard-coded single vendor: any provider that speaks one of these two
 * common wire protocols can be plugged in via baseUrl (self-hosted included). */
export type LlmProviderKind = 'openai_compatible' | 'anthropic_compatible';

export interface AiModelConfig {
  id: string;
  companyId: string;
  provider: LlmProviderKind;
  displayName: string;
  model: string;
  baseUrl: string;
  /** A key into AutomationService's existing encrypted Secret store — never
   * the raw API key. Convention: `llm:{id}:api_key`. */
  secretKey: string;
  maxOutputTokens: number;
  temperature?: number;
  timeoutMs: number;
  maxRetries: number;
  /** Company-wide daily prompt+completion token budget for this config —
   * undefined means unbounded. Real enforcement (LlmOrchestratorService
   * rejects a call once today's recorded usage meets/exceeds it), not a UI
   * decoration. */
  dailyTokenBudget?: number;
  costPerInputTokenUsd?: number;
  costPerOutputTokenUsd?: number;
  isActive: boolean;
  createdByUserId: string;
  updatedAt: string;
}

export type LlmUsagePurpose = 'agent_reasoning' | 'tool_selection' | 'other';

/** One row per LLM call attempt, success or failure — an append-only cost
 * and reliability ledger, never mutated in place. */
export interface AiLlmUsage {
  id: string;
  companyId: string;
  modelConfigId: string;
  provider: LlmProviderKind;
  model: string;
  requestId: string;
  purpose: LlmUsagePurpose;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costEstimateUsd?: number;
  latencyMs: number;
  success: boolean;
  errorMessage?: string;
  createdAt: string;
}

// ---- Document Intelligence (bounded) ----
// Field extraction from unstructured real-estate documents (a unit spec
// sheet, reservation form, contract summary) — distinct from the existing
// tabular CSV/Excel importers (Lead/Payment/Inventory Import), which stay
// the right tool for grid-shaped exports. Scope is deliberately bounded:
// real extraction only for PDFs with a genuine text layer; scanned PDFs
// and images are honestly marked 'ocr_required' (no OCR engine is wired
// into this deployment) rather than faked. See
// DocumentIntelligenceService (modules/documents/document-intelligence.service.ts).

export type DocumentKind = 'pdf_text' | 'pdf_scanned' | 'image' | 'unsupported';
export type DocumentExtractionStatus = 'extracted' | 'blocked' | 'reviewed' | 'imported' | 'rejected';
export type DocumentFieldConfidence = 'high' | 'medium' | 'low';

export interface DocumentExtractionRun {
  id: string;
  companyId: string;
  fileName: string;
  documentKind: DocumentKind;
  status: DocumentExtractionStatus;
  /** Set whenever status is 'blocked' — always a real, specific reason
   * (e.g. "no text layer — this looks like a scanned/image PDF; OCR is not
   * available in this deployment"), never silently empty. */
  blockedReason?: string;
  createdByUserId: string;
  createdAt: string;
  reviewedByUserId?: string;
  reviewedAt?: string;
  importedUnitId?: string;
}

/** One row per candidate field a run extracted — never silently imported:
 * low-confidence fields require explicit human review/correction before
 * confirmExtraction() can use them (see the service's class doc comment). */
export interface DocumentExtractedField {
  id: string;
  extractionRunId: string;
  companyId: string;
  fieldKey: string;
  rawValue: string;
  confidence: DocumentFieldConfidence;
  /** A reviewer's correction — when set, this is what confirmExtraction()
   * uses instead of rawValue; rawValue is kept for audit either way. */
  correctedValue?: string;
}

// ---- Integration Layer ----

export type IntegrationProvider =
  | 'whatsapp'
  | 'email'
  | 'meta_ads'
  | 'google_calendar'
  | 'payment_stripe'
  | 'e_signature'
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

/** Real provider-acknowledged delivery lifecycle for one outbound WhatsApp/
 * email message — distinct from IntegrationEvent, which only logs "our
 * send() call to the provider's API succeeded or failed", not what
 * happened to the message afterward. An IntegrationEvent with status
 * 'success' means the provider *accepted the request*; it never means
 * the message was delivered or read. Append-only, one row per real
 * status transition (never mutated in place), so the full lifecycle
 * (queued -> sent -> delivered -> read, or -> failed/rejected) survives
 * as an actual timeline, not just a "current status" field a later event
 * could silently overwrite. */
export type CommunicationDeliveryStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'rejected' | 'unknown';

export interface CommunicationDeliveryEvent {
  id: string;
  companyId: string;
  connectionId: string;
  provider: 'whatsapp' | 'email';
  /** The id the provider itself assigned to this message when we sent it
   * (WhatsApp's `wamid.*`, an email provider's message-id header) — the
   * only reliable key a later delivery webhook can correlate against,
   * since our own internal ids are never sent to the provider. */
  providerMessageId: string;
  relatedResource?: MessageRelatedResource;
  relatedResourceId?: string;
  status: CommunicationDeliveryStatus;
  failureReason?: string;
  /** The verified webhook payload that produced this row, kept for audit/
   * debugging — never trusted for anything beyond that, and never re-run
   * as an instruction (see CommunicationDeliveryService.handleWebhook). */
  rawEvent?: Record<string, unknown>;
  createdAt: string;
}

// ---- E-Signature (contract lifecycle) ----
// A Contract's internal `status: 'signed'` (SalesService.signContract) means
// the deal's commercial terms are locked in — that stays exactly as it is,
// unchanged by this. A SignatureEnvelope is the separate, additional record
// of whether the *customer actually digitally signed the document*, tracked
// independently so the two "signed" concepts (commercial agreement vs. a
// real signature event) are never conflated — the same "never treat a
// message/webhook as proof of a different kind of truth" principle Finance's
// Payment/Receipt split already follows. Never gates the existing contract
// flow: sending one is an additive, optional step a signed contract can go
// through, not a new required stage in Contract's own state machine.

export type SignatureEnvelopeStatus = 'sent' | 'signed' | 'declined' | 'expired';

export interface SignatureEnvelope {
  id: string;
  companyId: string;
  contractId: string;
  connectionId: string;
  provider: IntegrationProvider; // always 'e_signature' today; kept generic like IntegrationEvent
  externalEnvelopeId: string;
  signerEmail: string;
  status: SignatureEnvelopeStatus;
  requestedByUserId: string;
  sentAt: string;
  /** Set only once a webhook callback verified with this envelope's own
   * signing secret confirms the outcome — never set from an unverified
   * request, and never inferred from the outbound send() call succeeding. */
  decidedAt?: string;
}

// ---- AI Workflow / Agentic Orchestration Engine ----
// A second, distinct execution model from WorkflowRun/WorkflowStepRun
// above: that engine runs a fixed, human-authored sequence of steps
// (deterministic automation). An AiWorkflowRun instead executes a *plan*
// the orchestrator builds for a stated goal, evaluates each step's real
// result, and can replan — searching again, trying an alternative, or
// escalating — when the world doesn't match what the plan assumed. Every
// mutation a step performs still goes through
// AutomationService.executeActionDirect, so it carries the exact same
// RBAC/AiPolicy-autonomy/ApprovalRequest/audit pipeline as any other AI
// action or workflow step — this engine adds planning/state on top, it
// never bypasses the safety pipeline underneath.
export type AiWorkflowGoalType = 'high_value_lead_followup';

export type AiWorkflowStatus =
  | 'running' // actively executing steps
  | 'waiting' // paused for an external event (e.g. a customer reply) until resumeAt
  | 'completed' // reached a terminal, successful outcome
  | 'escalated' // handed to a human — no reliable automatic next step
  | 'failed'; // a step errored in a way replanning couldn't recover from

export interface AiWorkflowRun {
  id: string;
  companyId: string;
  goalType: AiWorkflowGoalType;
  subjectType: string;
  subjectId: string;
  status: AiWorkflowStatus;
  requestedByUserId: string;
  /** Name of the step currently executing or last completed — lets a
   * resumed/replanned run pick up context without re-reading every step. */
  currentStepName?: string;
  /** Set only when status === 'waiting'; the scheduled sweep (same 60s
   * tick pattern as sweepOverdueAndEmit/sweepSlaBreachesAndEmit) resumes
   * any run whose resumeAt has passed. */
  resumeAt?: string;
  /** Human-readable summary of the final outcome (why it completed,
   * escalated, or failed) — shown in the execution trace UI. */
  outcomeSummary?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export type AiWorkflowStepStatus = 'succeeded' | 'failed' | 'skipped' | 'replanned';

/** One executed step in an AiWorkflowRun's real trace — every planning
 * decision, tool call, and evaluation the orchestrator made, in order,
 * with its real input/output. This is the "full execution trace" an
 * observability view renders (Trigger -> Decision -> Agent -> Tool ->
 * Result -> Next step -> Final outcome). */
export interface AiWorkflowStepRun {
  id: string;
  companyId: string;
  runId: string;
  sequence: number;
  stepName: string;
  status: AiWorkflowStepStatus;
  /** What this step reasoned/decided before acting, when applicable. */
  reasoning?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  startedAt: string;
  finishedAt: string;
}
