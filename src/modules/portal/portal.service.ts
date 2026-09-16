import { randomUUID } from 'node:crypto';
import type { Contract, Customer, Lead, PaymentScheduleLine } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError, ValidationError } from '../../infra/errors.js';
import type { AuthService } from '../auth/auth.service.js';

export interface GrantPortalAccessInput {
  companyId: string;
  leadId: string;
  email: string;
  password: string;
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
}
