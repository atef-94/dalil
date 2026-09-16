import { randomUUID } from 'node:crypto';
import type { Contract, Opportunity } from '../../domain/types.js';
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
  ) {}

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

  async reserveUnitForOpportunity(opportunityId: string, unitId: string) {
    const opportunity = await this.opportunities.findById(opportunityId);
    if (!opportunity) throw new NotFoundError('opportunity not found');
    if (opportunity.stage !== 'open') {
      throw new SalesError(`opportunity is not open (current stage: ${opportunity.stage})`);
    }
    const reservation = await this.inventory.reserveUnit(unitId, opportunity.leadId, opportunityId);
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
      if (await this.contractExistsForReservation(input.reservationId)) {
        throw new SalesError('this reservation already has a signed contract');
      }

      const reservation = await this.inventory.getReservation(input.reservationId);
      if (!reservation) throw new NotFoundError('reservation not found');
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
}
