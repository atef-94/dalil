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
  | 'portal_access';

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
  sourceId?: string;
  status: LeadStatus;
  lostReason?: string;
  ownerEmployeeUserId?: string;
  createdAt: string;
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

export type MessageRelatedResource = 'lead' | 'contract' | 'opportunity' | 'maintenance_ticket';
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
