import { randomUUID } from 'node:crypto';
import type { Employee, LeaveRequest, LeaveType } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { HrError, NotFoundError, ValidationError } from '../../infra/errors.js';

export interface RequestLeaveInput {
  companyId: string;
  employeeId: string;
  type: LeaveType;
  startDate: string;
  endDate: string;
  reason?: string;
}

export class HrService {
  constructor(
    private readonly leaveRequests: Repository<LeaveRequest>,
    private readonly employees: Repository<Employee>,
  ) {}

  async requestLeave(input: RequestLeaveInput): Promise<LeaveRequest> {
    const employee = await this.employees.findById(input.employeeId);
    if (!employee || employee.companyId !== input.companyId) throw new NotFoundError('employee not found');

    const start = Date.parse(input.startDate);
    const end = Date.parse(input.endDate);
    if (Number.isNaN(start) || Number.isNaN(end)) throw new ValidationError('startDate and endDate must be valid dates');
    if (end < start) throw new ValidationError('endDate must not be before startDate');

    const leaveRequest: LeaveRequest = {
      id: randomUUID(),
      companyId: input.companyId,
      employeeId: input.employeeId,
      type: input.type,
      startDate: input.startDate,
      endDate: input.endDate,
      reason: input.reason?.trim() || undefined,
      status: 'pending',
      requestedAt: new Date().toISOString(),
    };
    return this.leaveRequests.save(leaveRequest);
  }

  async listForCompany(companyId: string): Promise<LeaveRequest[]> {
    return this.leaveRequests.findAll((l) => l.companyId === companyId);
  }

  async listForEmployee(employeeId: string, companyId: string): Promise<LeaveRequest[]> {
    return this.leaveRequests.findAll((l) => l.employeeId === employeeId && l.companyId === companyId);
  }

  async getLeaveRequest(id: string): Promise<LeaveRequest | undefined> {
    return this.leaveRequests.findById(id);
  }

  private async decide(id: string, companyId: string, decidedByUserId: string, status: 'approved' | 'rejected'): Promise<LeaveRequest> {
    const leaveRequest = await this.leaveRequests.findById(id);
    if (!leaveRequest || leaveRequest.companyId !== companyId) throw new NotFoundError('leave request not found');
    if (leaveRequest.status !== 'pending') {
      throw new HrError(`leave request is not pending (current status: ${leaveRequest.status})`);
    }
    const updated: LeaveRequest = { ...leaveRequest, status, decidedByUserId, decidedAt: new Date().toISOString() };
    return this.leaveRequests.save(updated);
  }

  async approveLeave(id: string, companyId: string, decidedByUserId: string): Promise<LeaveRequest> {
    return this.decide(id, companyId, decidedByUserId, 'approved');
  }

  async rejectLeave(id: string, companyId: string, decidedByUserId: string): Promise<LeaveRequest> {
    return this.decide(id, companyId, decidedByUserId, 'rejected');
  }

  async cancelLeave(id: string, companyId: string, requestingEmployeeId: string): Promise<LeaveRequest> {
    const leaveRequest = await this.leaveRequests.findById(id);
    if (!leaveRequest || leaveRequest.companyId !== companyId) throw new NotFoundError('leave request not found');
    if (leaveRequest.employeeId !== requestingEmployeeId) {
      throw new HrError('only the requesting employee can cancel their own leave request', 403);
    }
    if (leaveRequest.status !== 'pending') {
      throw new HrError(`only a pending leave request can be cancelled (current status: ${leaveRequest.status})`);
    }
    const updated: LeaveRequest = { ...leaveRequest, status: 'cancelled' };
    return this.leaveRequests.save(updated);
  }
}
