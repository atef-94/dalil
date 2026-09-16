import { randomUUID } from 'node:crypto';
import type { Reservation, Unit, UnitHold } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { InventoryError, ValidationError, NotFoundError } from '../../infra/errors.js';
import { KeyedMutex } from '../../infra/keyed-mutex.js';

export interface CreateUnitInput {
  companyId: string;
  projectId: string;
  code: string;
  unitType: string;
  areaSqm: number;
  listPrice: number;
}

const HOLD_TTL_MS = 15 * 60 * 1000;

export class InventoryService {
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly units: Repository<Unit>,
    private readonly holds: Repository<UnitHold>,
    private readonly reservations: Repository<Reservation>,
  ) {}

  async createUnit(input: CreateUnitInput): Promise<Unit> {
    if (!input.code?.trim()) throw new ValidationError('code is required');
    if (!input.projectId?.trim()) throw new ValidationError('projectId is required');
    if (!input.unitType?.trim()) throw new ValidationError('unitType is required');
    if (!(input.areaSqm > 0)) throw new ValidationError('areaSqm must be positive');
    if (!(input.listPrice > 0)) throw new ValidationError('listPrice must be positive');

    const existing = await this.units.findAll((u) => u.companyId === input.companyId && u.code === input.code.trim());
    if (existing.length > 0) {
      throw new InventoryError(`unit code ${input.code} already exists`, 409);
    }

    const unit: Unit = {
      id: randomUUID(),
      companyId: input.companyId,
      projectId: input.projectId.trim(),
      code: input.code.trim(),
      unitType: input.unitType.trim(),
      areaSqm: input.areaSqm,
      listPrice: input.listPrice,
      status: 'available',
      createdAt: new Date().toISOString(),
    };
    return this.units.save(unit);
  }

  async listUnits(companyId: string, projectId?: string): Promise<Unit[]> {
    return this.units.findAll((u) => u.companyId === companyId && (!projectId || u.projectId === projectId));
  }

  async getUnit(id: string): Promise<Unit | undefined> {
    return this.units.findById(id);
  }

  private async sweepExpiredHolds(unitId: string): Promise<void> {
    const active = await this.holds.findAll((h) => h.unitId === unitId && h.active);
    const now = Date.now();
    for (const hold of active) {
      if (Date.parse(hold.expiresAt) <= now) {
        await this.holds.save({ ...hold, active: false });
        const unit = await this.units.findById(unitId);
        if (unit && unit.status === 'held') {
          await this.units.save({ ...unit, status: 'available' });
        }
      }
    }
  }

  async holdUnit(unitId: string, byUserId: string): Promise<UnitHold> {
    return this.mutex.runExclusive(unitId, async () => {
      await this.sweepExpiredHolds(unitId);
      const unit = await this.units.findById(unitId);
      if (!unit) throw new NotFoundError('unit not found');
      if (unit.status !== 'available') {
        throw new InventoryError(`unit is not available (current status: ${unit.status})`);
      }

      const hold: UnitHold = {
        id: randomUUID(),
        companyId: unit.companyId,
        unitId,
        heldByUserId: byUserId,
        expiresAt: new Date(Date.now() + HOLD_TTL_MS).toISOString(),
        active: true,
      };
      await this.holds.save(hold);
      await this.units.save({ ...unit, status: 'held' });
      return hold;
    });
  }

  /**
   * Mutex-protected + live-race-tested: only one of N concurrent reserve
   * calls against the same unit can ever win.
   */
  async reserveUnit(unitId: string, clientId: string, opportunityId?: string): Promise<Reservation> {
    return this.mutex.runExclusive(unitId, async () => {
      await this.sweepExpiredHolds(unitId);
      const unit = await this.units.findById(unitId);
      if (!unit) throw new NotFoundError('unit not found');
      if (unit.status !== 'available' && unit.status !== 'held') {
        throw new InventoryError(`unit is not reservable (current status: ${unit.status})`);
      }

      const reservation: Reservation = {
        id: randomUUID(),
        companyId: unit.companyId,
        unitId,
        clientId,
        opportunityId,
        status: 'active',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + HOLD_TTL_MS).toISOString(),
      };
      await this.reservations.save(reservation);
      await this.units.save({ ...unit, status: 'reserved' });
      return reservation;
    });
  }

  async markContracted(unitId: string): Promise<Unit> {
    const unit = await this.units.findById(unitId);
    if (!unit) throw new NotFoundError('unit not found');
    return this.units.save({ ...unit, status: 'contracted' });
  }

  /** Releases a unit back onto the market — used when the contract that
   * had contracted it is cancelled. */
  async markAvailable(unitId: string): Promise<Unit> {
    const unit = await this.units.findById(unitId);
    if (!unit) throw new NotFoundError('unit not found');
    return this.units.save({ ...unit, status: 'available' });
  }

  async getReservation(id: string): Promise<Reservation | undefined> {
    return this.reservations.findById(id);
  }

  async markReservationConverted(id: string): Promise<Reservation> {
    const reservation = await this.reservations.findById(id);
    if (!reservation) throw new NotFoundError('reservation not found');
    return this.reservations.save({ ...reservation, status: 'converted' });
  }

  async markReservationCancelled(id: string): Promise<Reservation> {
    const reservation = await this.reservations.findById(id);
    if (!reservation) throw new NotFoundError('reservation not found');
    return this.reservations.save({ ...reservation, status: 'cancelled' });
  }
}
