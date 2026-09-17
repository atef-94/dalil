import { randomUUID } from 'node:crypto';
import type { Contract, DiscountApprovalPolicy, Opportunity } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { SalesError, ValidationError, NotFoundError } from '../../infra/errors.js';
import { KeyedMutex } from '../../infra/keyed-mutex.js';
import type { InventoryService } from '../inventory/inventory.service.js';
import type { PaymentPlansService } from '../payment-plans/payment-plans.service.js';

export interface CreateOpportunityInput {
  companyId: string;
  leadId: string;
  ownerEmployeeUserId: string;
}

export interface SignContractInput {
  companyId: string;
  reservationId: string;
  creditedEmployeeUserId: string;
  paymentPlanTemplateId: string;
  totalPrice: number;
  discountPercent?: number;
  escalationPercentPerYear?: number;
}

export class SalesService {
  // Keyed by reservationId — protects the "does a contract already exist for
  // this reservation" check from concurrent double-signing.
  private readonly signMutex = new KeyedMutex();

  constructor(
    private readonly opportunities: Repository<Opportunity>,
    private readonly contracts: Repository<Contract>,
    private readonly inventory: InventoryService,
    private readonly paymentPlans: PaymentPlansService,
    private readonly discountApprovalPolicies?: Repository<DiscountApprovalPolicy>,
  ) {}

  /** Optional so existing tests/callers that never touch discount policy
   * don't need to pass a repo they don't have. */
  private requirePolicyRepo(): Repository<DiscountApprovalPolicy> {
    if (!this.discountApprovalPolicies) throw new SalesError('discount approval policy is not configured for this deployment', 500);
    return this.discountApprovalPolicies;
  }

  async setDiscountApprovalPolicy(companyId: string, maxDiscountPercentWithoutApproval: number): Promise<DiscountApprovalPolicy> {
    if (!(maxDiscountPercentWithoutApproval >= 0 && maxDiscountPercentWithoutApproval <= 100)) {
      throw new ValidationError('maxDiscountPercentWithoutApproval must be between 0 and 100');
    }
    const policy: DiscountApprovalPolicy = { id: companyId, companyId, maxDiscountPercentWithoutApproval };
    return this.requirePolicyRepo().save(policy);
  }

  async getDiscountApprovalPolicy(companyId: string): Promise<DiscountApprovalPolicy | undefined> {
    return this.requirePolicyRepo().findById(companyId);
  }

  /** No policy configured for a company means no gate at all — a company
   * that never opts in sees the exact discount behavior it always had. */
  async discountRequiresApproval(companyId: string, discountPercent: number | undefined): Promise<boolean> {
    if (!discountPercent) return false;
    const policy = await this.requirePolicyRepo().findById(companyId);
    if (!policy) return false;
    return discountPercent > policy.maxDiscountPercentWithoutApproval;
  }

  async createOpportunity(input: CreateOpportunityInput): Promise<Opportunity> {
    if (!input.leadId?.trim()) throw new ValidationError('leadId is required');
    if (!input.ownerEmployeeUserId?.trim()) throw new ValidationError('ownerEmployeeUserId is required');
    const opportunity: Opportunity = {
      id: randomUUID(),
      companyId: input.companyId,
      leadId: input.leadId,
      ownerEmployeeUserId: input.ownerEmployeeUserId,
      stage: 'open',
      createdAt: new Date().toISOString(),
    };
    return this.opportunities.save(opportunity);
  }

  async listOpportunities(companyId: string): Promise<Opportunity[]> {
    return this.opportunities.findAll((o) => o.companyId === companyId);
  }

  async getOpportunity(id: string): Promise<Opportunity | undefined> {
    return this.opportunities.findById(id);
  }

  async listContracts(companyId: string): Promise<Contract[]> {
    return this.contracts.findAll((c) => c.companyId === companyId);
  }

  async reserveUnitForOpportunity(opportunityId: string, unitId: string, companyId: string) {
    const opportunity = await this.opportunities.findById(opportunityId);
    if (!opportunity || opportunity.companyId !== companyId) throw new NotFoundError('opportunity not found');
    if (opportunity.stage !== 'open') {
      throw new SalesError(`opportunity is not open (current stage: ${opportunity.stage})`);
    }
    const reservation = await this.inventory.reserveUnit(unitId, opportunity.leadId, companyId, opportunityId);
    await this.opportunities.save({ ...opportunity, stage: 'reserved' });
    return reservation;
  }

  private async contractExistsForReservation(reservationId: string): Promise<boolean> {
    const existing = await this.contracts.findAll((c) => c.reservationId === reservationId);
    return existing.length > 0;
  }

  /**
   * The whole body — including the idempotency check — runs inside a
   * per-reservation mutex. A second concurrent call waits for the first to
   * finish, then sees the reservation already has a contract and is
   * rejected. This closes a real race where N concurrent calls could each
   * pass the "does a contract exist" check before any of them had written
   * their Contract row.
   */
  async signContract(input: SignContractInput): Promise<Contract> {
    return this.signMutex.runExclusive(input.reservationId, async () => {
      const reservation = await this.inventory.getReservation(input.reservationId);
      if (!reservation || reservation.companyId !== input.companyId) throw new NotFoundError('reservation not found');

      if (await this.contractExistsForReservation(input.reservationId)) {
        throw new SalesError('this reservation already has a signed contract');
      }

      if (reservation.status !== 'active') {
        throw new SalesError(`reservation is not active (current status: ${reservation.status})`);
      }

      const contract: Contract = {
        id: randomUUID(),
        companyId: input.companyId,
        reservationId: input.reservationId,
        unitId: reservation.unitId,
        clientId: reservation.clientId,
        creditedEmployeeUserId: input.creditedEmployeeUserId,
        paymentPlanTemplateId: input.paymentPlanTemplateId,
        status: 'signed',
        signedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        totalPrice: input.totalPrice,
      };
      await this.contracts.save(contract);

      await this.paymentPlans.generateForContract(
        contract.id,
        input.companyId,
        input.paymentPlanTemplateId,
        input.totalPrice,
        input.discountPercent,
        input.escalationPercentPerYear,
      );

      await this.inventory.markContracted(reservation.unitId);
      await this.inventory.markReservationConverted(reservation.id);

      if (reservation.opportunityId) {
        const opportunity = await this.opportunities.findById(reservation.opportunityId);
        if (opportunity) {
          await this.opportunities.save({ ...opportunity, stage: 'won' });
        }
      }

      return contract;
    });
  }

  async getContract(id: string): Promise<Contract | undefined> {
    return this.contracts.findById(id);
  }

  /** Closes a documented gap: contract lifecycle previously only ever
   * reached 'signed'. Cancelling releases the unit back onto the market and
   * marks the reservation cancelled — it does not touch any already-recorded
   * payments, which stay on file against the cancelled contract. */
  async cancelContract(contractId: string, companyId: string): Promise<Contract> {
    const contract = await this.contracts.findById(contractId);
    if (!contract || contract.companyId !== companyId) throw new NotFoundError('contract not found');
    if (contract.status !== 'signed') {
      throw new SalesError(`only a signed contract can be cancelled (current status: ${contract.status})`);
    }
    const updated: Contract = { ...contract, status: 'cancelled' };
    await this.contracts.save(updated);
    await this.inventory.markAvailable(contract.unitId);
    await this.inventory.markReservationCancelled(contract.reservationId);
    return updated;
  }
}
