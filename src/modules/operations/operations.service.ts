import { randomUUID } from 'node:crypto';
import type { MaintenancePriority, MaintenanceStatus, MaintenanceTicket, Unit } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError, OperationsError, ValidationError } from '../../infra/errors.js';

export interface CreateTicketInput {
  companyId: string;
  unitId: string;
  title: string;
  description?: string;
  priority: MaintenancePriority;
  reportedByUserId: string;
}

const TERMINAL_STATUSES: MaintenanceStatus[] = ['resolved', 'closed'];
const VALID_TRANSITIONS: Record<MaintenanceStatus, MaintenanceStatus[]> = {
  open: ['in_progress', 'closed'],
  in_progress: ['resolved', 'open'],
  resolved: ['closed', 'in_progress'],
  closed: [],
};

export class OperationsService {
  constructor(
    private readonly tickets: Repository<MaintenanceTicket>,
    private readonly units: Repository<Unit>,
  ) {}

  async createTicket(input: CreateTicketInput): Promise<MaintenanceTicket> {
    if (!input.title?.trim()) throw new ValidationError('title is required');
    const unit = await this.units.findById(input.unitId);
    if (!unit || unit.companyId !== input.companyId) throw new NotFoundError('unit not found');

    const ticket: MaintenanceTicket = {
      id: randomUUID(),
      companyId: input.companyId,
      unitId: input.unitId,
      title: input.title.trim(),
      description: input.description?.trim() || undefined,
      priority: input.priority,
      status: 'open',
      reportedByUserId: input.reportedByUserId,
      createdAt: new Date().toISOString(),
    };
    return this.tickets.save(ticket);
  }

  async listForCompany(companyId: string): Promise<MaintenanceTicket[]> {
    return this.tickets.findAll((t) => t.companyId === companyId);
  }

  async listForUnit(unitId: string, companyId: string): Promise<MaintenanceTicket[]> {
    return this.tickets.findAll((t) => t.unitId === unitId && t.companyId === companyId);
  }

  async getTicket(id: string): Promise<MaintenanceTicket | undefined> {
    return this.tickets.findById(id);
  }

  async assignTicket(id: string, companyId: string, assignedToUserId: string): Promise<MaintenanceTicket> {
    const ticket = await this.tickets.findById(id);
    if (!ticket || ticket.companyId !== companyId) throw new NotFoundError('ticket not found');
    if (TERMINAL_STATUSES.includes(ticket.status)) {
      throw new OperationsError(`cannot assign a ${ticket.status} ticket`);
    }
    return this.tickets.save({ ...ticket, assignedToUserId });
  }

  async updateStatus(id: string, companyId: string, status: MaintenanceStatus): Promise<MaintenanceTicket> {
    const ticket = await this.tickets.findById(id);
    if (!ticket || ticket.companyId !== companyId) throw new NotFoundError('ticket not found');
    if (!VALID_TRANSITIONS[ticket.status].includes(status)) {
      throw new OperationsError(`cannot move a ${ticket.status} ticket to ${status}`);
    }
    const updated: MaintenanceTicket = { ...ticket, status, resolvedAt: status === 'resolved' ? new Date().toISOString() : ticket.resolvedAt };
    return this.tickets.save(updated);
  }
}
