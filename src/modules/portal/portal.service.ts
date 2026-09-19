import { randomUUID } from 'node:crypto';
import type { Contract, Customer, Lead, LegalDocument, Message, Opportunity, PaymentScheduleLine, Task } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError, ValidationError } from '../../infra/errors.js';
import type { AuthService } from '../auth/auth.service.js';

export interface GrantPortalAccessInput {
  companyId: string;
  leadId: string;
  email: string;
  password: string;
}

export interface Customer360 {
  customer: Customer;
  lead?: Lead;
  opportunities: Opportunity[];
  contracts: Contract[];
  scheduleByContract: { contractId: string; lines: PaymentScheduleLine[] }[];
  legalDocuments: LegalDocument[];
  messages: Message[];
  tasks: Task[];
}

/**
 * The customer-facing side of the system: a customer_user account scoped
 * to exactly one Customer record, which in turn is tied to the Lead that
 * became them (Contract.clientId is already a Lead id — see sales.service —
 * so "this customer's contracts" resolves via that same clientId, not a
 * separate join table).
 */
export class PortalService {
  constructor(
    private readonly customers: Repository<Customer>,
    private readonly leads: Repository<Lead>,
    private readonly contracts: Repository<Contract>,
    private readonly scheduleLines: Repository<PaymentScheduleLine>,
    private readonly auth: AuthService,
    private readonly opportunities: Repository<Opportunity>,
    private readonly legalDocuments: Repository<LegalDocument>,
    private readonly messages: Repository<Message>,
    private readonly tasks: Repository<Task>,
  ) {}

  async grantPortalAccess(input: GrantPortalAccessInput): Promise<{ customer: Customer }> {
    const lead = await this.leads.findById(input.leadId);
    if (!lead || lead.companyId !== input.companyId) throw new NotFoundError('lead not found');

    const existing = await this.customers.findAll((c) => c.companyId === input.companyId && c.leadId === input.leadId);
    if (existing.length > 0) throw new ValidationError('this lead already has portal access');

    const customer: Customer = {
      id: randomUUID(),
      companyId: input.companyId,
      leadId: lead.id,
      fullName: lead.fullName,
      phone: lead.phone,
      email: lead.email,
      createdAt: new Date().toISOString(),
    };
    await this.customers.save(customer);

    await this.auth.register({
      companyId: input.companyId,
      email: input.email,
      password: input.password,
      userType: 'customer_user',
      locale: 'en',
      customerId: customer.id,
    });

    return { customer };
  }

  async getCustomer(customerId: string, companyId: string): Promise<Customer | undefined> {
    const customer = await this.customers.findById(customerId);
    if (!customer || customer.companyId !== companyId) return undefined;
    return customer;
  }

  /** Staff-facing counterpart to grantPortalAccess/getCustomer — nothing
   * previously listed the customers a company has granted portal access
   * to, only the portal's own scoped GET /api/portal/me for that customer. */
  async listCustomers(companyId: string): Promise<Customer[]> {
    return this.customers.findAll((c) => c.companyId === companyId);
  }

  async myContracts(customerId: string, companyId: string): Promise<Contract[]> {
    const customer = await this.customers.findById(customerId);
    if (!customer || customer.companyId !== companyId) throw new NotFoundError('customer not found');
    return this.contracts.findAll((c) => c.companyId === companyId && c.clientId === customer.leadId);
  }

  async myContractSchedule(customerId: string, companyId: string, contractId: string): Promise<PaymentScheduleLine[]> {
    const contracts = await this.myContracts(customerId, companyId);
    if (!contracts.some((c) => c.id === contractId)) throw new NotFoundError('contract not found');
    const lines = await this.scheduleLines.findAll((l) => l.companyId === companyId && l.contractId === contractId);
    return lines.sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * Staff-facing Customer 360: one connected view of everything ACTIVE
   * already knows about a customer, joined from the modules that already
   * own each piece — no new data model, no duplicated storage. The join
   * key throughout is `customer.leadId` (the same key `myContracts` uses),
   * since a Customer record is just a portal-access wrapper around the
   * Lead that became them.
   */
  async getCustomer360(customerId: string, companyId: string): Promise<Customer360> {
    const customer = await this.getCustomer(customerId, companyId);
    if (!customer) throw new NotFoundError('customer not found');

    const lead = await this.leads.findById(customer.leadId);
    const opportunities = await this.opportunities.findAll((o) => o.companyId === companyId && o.leadId === customer.leadId);
    const contracts = await this.contracts.findAll((c) => c.companyId === companyId && c.clientId === customer.leadId);

    const scheduleByContract = await Promise.all(
      contracts.map(async (c) => ({
        contractId: c.id,
        lines: (await this.scheduleLines.findAll((l) => l.companyId === companyId && l.contractId === c.id)).sort((a, b) => a.sequence - b.sequence),
      })),
    );
    const legalDocumentsByContract = await Promise.all(
      contracts.map((c) => this.legalDocuments.findAll((d) => d.companyId === companyId && d.contractId === c.id)),
    );

    const messages = await this.messages.findAll((m) => m.companyId === companyId && m.relatedResource === 'lead' && m.relatedResourceId === customer.leadId);
    const tasks = await this.tasks.findAll((t) => t.companyId === companyId && t.relatedResource === 'lead' && t.relatedResourceId === customer.leadId);

    return {
      customer,
      lead: lead && lead.companyId === companyId ? lead : undefined,
      opportunities,
      contracts,
      scheduleByContract,
      legalDocuments: legalDocumentsByContract.flat(),
      messages,
      tasks,
    };
  }
}
