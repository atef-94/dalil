import { randomUUID } from 'node:crypto';
import type {
  Consultant,
  ConsultantRole,
  DeliveryInfo,
  Developer,
  Facility,
  Launch,
  MasterPlanPosition,
  Project,
  ProjectFavorite,
  ProjectPhase,
  ProjectUnitSpec,
  Reservation,
  SalesPhoneNumber,
  Unit,
  UnitHold,
  UnitStatus,
} from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { InventoryError, ValidationError, NotFoundError } from '../../infra/errors.js';
import { KeyedMutex } from '../../infra/keyed-mutex.js';

export interface CreateUnitInput {
  companyId: string;
  projectId: string;
  phaseId?: string;
  code: string;
  unitType: string;
  areaSqm: number;
  listPrice: number;
  floorLabel?: string;
  bedrooms?: number;
  designType?: string;
  view?: string[];
  gardenAreaSqm?: number;
  buildingLabel?: string;
  finishingType?: string;
  delivery?: DeliveryInfo;
  pricePerMeterOverride?: number;
  floorPlanImageUrl?: string;
  masterPlanPosition?: MasterPlanPosition;
  sourceImportId?: string;
  sourceSheet?: string;
  sourceRow?: number;
  /** An initial status other than the default 'available' — used only when
   * an availability import creates a unit that a source file already shows
   * as e.g. sold/reserved (an existing inventory snapshot, not a fresh
   * listing). Set directly at creation, bypassing the hold/reservation
   * machinery entirely since there is no real internal hold/reservation to
   * create for a unit whose non-available status came from an external
   * source, not this system's own CRM flow. */
  initialStatus?: UnitStatus;
  sourceStatus?: string;
}

/** Fields updateUnitDetails() is allowed to touch — deliberately the same
 * "commercial/descriptive, never status" boundary as before, just widened
 * to the new real-estate attributes. Status (and its own provenance,
 * sourceStatus) is intentionally excluded — see updateUnitAvailabilityFromImport. */
export type UpdateUnitDetailsInput = Partial<
  Pick<
    CreateUnitInput,
    | 'unitType'
    | 'areaSqm'
    | 'listPrice'
    | 'phaseId'
    | 'floorLabel'
    | 'bedrooms'
    | 'designType'
    | 'view'
    | 'gardenAreaSqm'
    | 'buildingLabel'
    | 'finishingType'
    | 'delivery'
    | 'pricePerMeterOverride'
    | 'floorPlanImageUrl'
    | 'masterPlanPosition'
    | 'sourceImportId'
    | 'sourceSheet'
    | 'sourceRow'
  >
>;

export interface CreateProjectInput {
  companyId: string;
  name: string;
  location?: string;
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
  currency?: string;
  pricePerMeter?: number;
  pricePerMeterSource?: 'developer' | 'computed';
  finishingType?: string;
  delivery?: DeliveryInfo;
  projectAreaSqm?: number;
  projectAreaUnit?: string;
  typeOfUnits?: string[];
  facilityIds?: string[];
  engineeringConsultantId?: string;
  projectManagementId?: string;
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
  imageUrls?: string[];
  masterPlanImageUrl?: string;
  coverImageUrl?: string;
}

/** Every field is optional and only ever overwrites what's explicitly
 * passed — updateProjectDetails() never blanks out an existing value just
 * because a caller (e.g. an import row) didn't happen to mention it. */
export type UpdateProjectDetailsInput = Partial<Omit<CreateProjectInput, 'companyId' | 'name'>> & { name?: string };

export interface CreateProjectUnitSpecInput {
  companyId: string;
  projectId: string;
  phaseId?: string;
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
  finishingType?: string;
  delivery?: DeliveryInfo;
  paymentPlanTemplateIds?: string[];
  cashDiscountPercent?: number;
  maintenanceFeePercent?: number;
  sourceImportId?: string;
  sourceSheet?: string;
  sourceRow?: number;
}

/** Non-destructive, same convention as UpdateProjectDetailsInput — an
 * omitted field keeps its current value. */
export type UpdateProjectUnitSpecInput = Partial<Omit<CreateProjectUnitSpecInput, 'companyId' | 'projectId' | 'unitType'>>;

export interface UnitSearchFilters {
  projectId?: string;
  phaseId?: string;
  unitType?: string;
  status?: UnitStatus | 'any';
  minPrice?: number;
  maxPrice?: number;
  minAreaSqm?: number;
  maxAreaSqm?: number;
  minGardenAreaSqm?: number;
  maxGardenAreaSqm?: number;
  bedrooms?: number;
  minBedrooms?: number;
  maxBedrooms?: number;
  finishingType?: string;
  view?: string;
  floorLabel?: string;
  designType?: string;
  /** Resolved through the unit's Project — matches Project.destination. */
  destination?: string;
  /** Resolved through the unit's Project — matches Project.developerId. */
  developerId?: string;
  /** Free-text match over code/unitType/buildingLabel. */
  q?: string;
  limit?: number;
}

export interface ProjectSearchFilters {
  destination?: string;
  developerId?: string;
  minPriceFrom?: number;
  maxPriceTo?: number;
  /** Matches against Project.typeOfUnits (any element). */
  unitType?: string;
  /** Matches if any of the project's catalog unit specs (or, absent
   * those, its physical units) carries this bedroom count. */
  bedrooms?: number;
  sort?: 'newest' | 'price_asc' | 'price_desc';
  q?: string;
  limit?: number;
}

const HOLD_TTL_MS = 15 * 60 * 1000;

/** listPrice/areaSqm rounded to 2 decimals when no explicit override is
 * stored — never persisted, so it can never go stale relative to a later
 * price/area edit. Returns undefined when areaSqm is 0/unset (nothing
 * sane to divide by). */
export function computePricePerMeter(unit: Pick<Unit, 'listPrice' | 'areaSqm' | 'pricePerMeterOverride'>): number | undefined {
  if (unit.pricePerMeterOverride !== undefined) return unit.pricePerMeterOverride;
  if (!unit.areaSqm) return undefined;
  return Math.round((unit.listPrice / unit.areaSqm) * 100) / 100;
}

export class InventoryService {
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly units: Repository<Unit>,
    private readonly holds: Repository<UnitHold>,
    private readonly reservations: Repository<Reservation>,
    private readonly projects: Repository<Project>,
    private readonly developers?: Repository<Developer>,
    private readonly phases?: Repository<ProjectPhase>,
    private readonly launches?: Repository<Launch>,
    private readonly facilities?: Repository<Facility>,
    private readonly consultants?: Repository<Consultant>,
    private readonly salesPhones?: Repository<SalesPhoneNumber>,
    private readonly projectUnitSpecs?: Repository<ProjectUnitSpec>,
    private readonly favorites?: Repository<ProjectFavorite>,
  ) {}

  /**
   * projectId on Unit stays a free-form string for backward compatibility
   * with data created before Project existed as a real entity — creating a
   * unit never requires a matching Project record. Real Projects are an
   * additive, independently manageable entity; the frontend now sources the
   * project picker from here instead of free text.
   */
  async createProject(input: CreateProjectInput): Promise<Project> {
    if (!input.name?.trim()) throw new ValidationError('name is required');
    const project: Project = {
      id: randomUUID(),
      companyId: input.companyId,
      name: input.name.trim(),
      location: input.location?.trim() || undefined,
      ...this.sanitizeProjectDetailFields(input),
      createdAt: new Date().toISOString(),
    };
    return this.projects.save(project);
  }

  private sanitizeProjectDetailFields(input: UpdateProjectDetailsInput): Partial<Project> {
    const out: Partial<Project> = {};
    if (input.destination !== undefined) out.destination = input.destination?.trim() || undefined;
    if (input.developerId !== undefined) out.developerId = input.developerId || undefined;
    if (input.locationLat !== undefined) out.locationLat = input.locationLat;
    if (input.locationLng !== undefined) out.locationLng = input.locationLng;
    if (input.locationMapUrl !== undefined) out.locationMapUrl = input.locationMapUrl?.trim() || undefined;
    if (input.address !== undefined) out.address = input.address?.trim() || undefined;
    if (input.landAreaFromSqm !== undefined) out.landAreaFromSqm = this.nonNegative(input.landAreaFromSqm, 'landAreaFromSqm');
    if (input.landAreaToSqm !== undefined) out.landAreaToSqm = this.nonNegative(input.landAreaToSqm, 'landAreaToSqm');
    if (input.buaFromSqm !== undefined) out.buaFromSqm = this.nonNegative(input.buaFromSqm, 'buaFromSqm');
    if (input.buaToSqm !== undefined) out.buaToSqm = this.nonNegative(input.buaToSqm, 'buaToSqm');
    if (input.gardenAreaFromSqm !== undefined) out.gardenAreaFromSqm = this.nonNegative(input.gardenAreaFromSqm, 'gardenAreaFromSqm');
    if (input.gardenAreaToSqm !== undefined) out.gardenAreaToSqm = this.nonNegative(input.gardenAreaToSqm, 'gardenAreaToSqm');
    if (input.priceFrom !== undefined) out.priceFrom = this.nonNegative(input.priceFrom, 'priceFrom');
    if (input.priceTo !== undefined) out.priceTo = this.nonNegative(input.priceTo, 'priceTo');
    if (input.currency !== undefined) out.currency = input.currency?.trim().toUpperCase() || undefined;
    if (input.pricePerMeter !== undefined) out.pricePerMeter = this.nonNegative(input.pricePerMeter, 'pricePerMeter');
    if (input.pricePerMeterSource !== undefined) out.pricePerMeterSource = input.pricePerMeterSource;
    if (input.finishingType !== undefined) out.finishingType = input.finishingType?.trim() || undefined;
    if (input.delivery !== undefined) out.delivery = input.delivery;
    if (input.projectAreaSqm !== undefined) out.projectAreaSqm = this.nonNegative(input.projectAreaSqm, 'projectAreaSqm');
    if (input.projectAreaUnit !== undefined) out.projectAreaUnit = input.projectAreaUnit?.trim() || undefined;
    if (input.typeOfUnits !== undefined) out.typeOfUnits = input.typeOfUnits;
    if (input.facilityIds !== undefined) out.facilityIds = input.facilityIds;
    if (input.engineeringConsultantId !== undefined) out.engineeringConsultantId = input.engineeringConsultantId || undefined;
    if (input.projectManagementId !== undefined) out.projectManagementId = input.projectManagementId || undefined;
    if (input.ministerialDecisionNumber !== undefined) out.ministerialDecisionNumber = input.ministerialDecisionNumber?.trim() || undefined;
    if (input.ministerialDecisionDate !== undefined) out.ministerialDecisionDate = input.ministerialDecisionDate;
    if (input.ministerialDecisionAuthority !== undefined) out.ministerialDecisionAuthority = input.ministerialDecisionAuthority?.trim() || undefined;
    if (input.ministerialDecisionDocumentUrl !== undefined) out.ministerialDecisionDocumentUrl = input.ministerialDecisionDocumentUrl?.trim() || undefined;
    if (input.cashDiscountPercent !== undefined) out.cashDiscountPercent = this.percentInRange(input.cashDiscountPercent, 'cashDiscountPercent');
    if (input.cashDiscountAmount !== undefined) out.cashDiscountAmount = this.nonNegative(input.cashDiscountAmount, 'cashDiscountAmount');
    if (input.cashDiscountValidUntil !== undefined) out.cashDiscountValidUntil = input.cashDiscountValidUntil;
    if (input.cashDiscountSource !== undefined) out.cashDiscountSource = input.cashDiscountSource?.trim() || undefined;
    if (input.cashDiscountEffectiveDate !== undefined) out.cashDiscountEffectiveDate = input.cashDiscountEffectiveDate;
    if (input.maintenanceFeePercent !== undefined) out.maintenanceFeePercent = this.percentInRange(input.maintenanceFeePercent, 'maintenanceFeePercent');
    if (input.maintenanceFeeAmount !== undefined) out.maintenanceFeeAmount = this.nonNegative(input.maintenanceFeeAmount, 'maintenanceFeeAmount');
    if (input.imageUrls !== undefined) out.imageUrls = input.imageUrls.length ? input.imageUrls : undefined;
    if (input.masterPlanImageUrl !== undefined) out.masterPlanImageUrl = input.masterPlanImageUrl?.trim() || undefined;
    if (input.coverImageUrl !== undefined) out.coverImageUrl = input.coverImageUrl?.trim() || undefined;
    return out;
  }

  private nonNegative(value: number, field: string): number {
    if (!(value >= 0)) throw new ValidationError(`${field} must be >= 0`);
    return value;
  }

  private percentInRange(value: number, field: string): number {
    if (!(value >= 0 && value <= 100)) throw new ValidationError(`${field} must be between 0 and 100`);
    return value;
  }

  async listProjects(companyId: string): Promise<Project[]> {
    return this.projects.findAll((p) => p.companyId === companyId);
  }

  async getProject(id: string): Promise<Project | undefined> {
    return this.projects.findById(id);
  }

  /** Real, server-side project search — destination/developer/price-range/
   * unit-type filters, the same shape the AI's search_projects tool and the
   * frontend's project list both call so there's one source of truth. */
  async searchProjects(companyId: string, filters: ProjectSearchFilters = {}): Promise<Project[]> {
    const q = filters.q?.trim().toLowerCase();
    const limit = Math.min(200, Math.max(1, filters.limit ?? 50));
    let rows = await this.projects.findAll((p) => {
      if (p.companyId !== companyId) return false;
      if (filters.destination && p.destination?.toLowerCase() !== filters.destination.toLowerCase()) return false;
      if (filters.developerId && p.developerId !== filters.developerId) return false;
      if (filters.minPriceFrom !== undefined && (p.priceFrom === undefined || p.priceFrom < filters.minPriceFrom)) return false;
      if (filters.maxPriceTo !== undefined && (p.priceTo === undefined || p.priceTo > filters.maxPriceTo)) return false;
      if (filters.unitType && !(p.typeOfUnits ?? []).some((t) => t.toLowerCase() === filters.unitType!.toLowerCase())) return false;
      if (q && !(p.name.toLowerCase().includes(q) || p.destination?.toLowerCase().includes(q) || p.location?.toLowerCase().includes(q))) return false;
      return true;
    });
    if (filters.bedrooms !== undefined) {
      const matches = await Promise.all(rows.map((p) => this.projectHasBedrooms(p.id, filters.bedrooms!)));
      rows = rows.filter((_p, i) => matches[i]);
    }
    rows = this.sortProjects(rows, filters.sort);
    return rows.slice(0, limit);
  }

  /** Whether any of a project's catalog unit specs — or, when none exist,
   * its physical units — carries this bedroom count. Used only by the
   * "rooms" filter in searchProjects; not a general-purpose lookup. */
  private async projectHasBedrooms(projectId: string, bedrooms: number): Promise<boolean> {
    const specs = this.projectUnitSpecs ? await this.projectUnitSpecs.findAll((s) => s.projectId === projectId) : [];
    if (specs.length) return specs.some((s) => s.bedrooms === bedrooms);
    const units = await this.units.findAll((u) => u.projectId === projectId);
    return units.some((u) => u.bedrooms === bedrooms);
  }

  private sortProjects(rows: Project[], sort?: ProjectSearchFilters['sort']): Project[] {
    if (sort === 'price_asc') return [...rows].sort((a, b) => (a.priceFrom ?? Infinity) - (b.priceFrom ?? Infinity));
    if (sort === 'price_desc') return [...rows].sort((a, b) => (b.priceTo ?? -Infinity) - (a.priceTo ?? -Infinity));
    if (sort === 'newest') return [...rows].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return rows;
  }

  /** Non-destructive: only fields explicitly present in `updates` are
   * changed; anything omitted keeps its current value. This is what both
   * the manual PATCH route and the Import Engine call, so an import row
   * that only carries a subset of project columns never blanks the rest. */
  async updateProjectDetails(id: string, companyId: string, updates: UpdateProjectDetailsInput): Promise<Project> {
    const project = await this.projects.findById(id);
    if (!project || project.companyId !== companyId) throw new NotFoundError('project not found');
    const patch = this.sanitizeProjectDetailFields(updates);
    return this.projects.save({
      ...project,
      ...patch,
      name: updates.name?.trim() || project.name,
      location: updates.location !== undefined ? updates.location?.trim() || undefined : project.location,
    });
  }

  /** Idempotent: favoriting an already-favorited project is a no-op, not a
   * duplicate row — the catalog browser's heart toggle can call this freely. */
  async addProjectFavorite(companyId: string, userId: string, projectId: string): Promise<void> {
    if (!this.favorites) return;
    const project = await this.projects.findById(projectId);
    if (!project || project.companyId !== companyId) throw new NotFoundError('project not found');
    const existing = await this.favorites.findAll((f) => f.companyId === companyId && f.userId === userId && f.projectId === projectId);
    if (existing.length) return;
    await this.favorites.save({ id: randomUUID(), companyId, userId, projectId, createdAt: new Date().toISOString() });
  }

  async removeProjectFavorite(companyId: string, userId: string, projectId: string): Promise<void> {
    if (!this.favorites) return;
    const existing = await this.favorites.findAll((f) => f.companyId === companyId && f.userId === userId && f.projectId === projectId);
    await Promise.all(existing.map((f) => this.favorites!.deleteById(f.id)));
  }

  async listFavoriteProjectIds(companyId: string, userId: string): Promise<string[]> {
    if (!this.favorites) return [];
    const rows = await this.favorites.findAll((f) => f.companyId === companyId && f.userId === userId);
    return rows.map((f) => f.projectId);
  }

  async createUnit(input: CreateUnitInput): Promise<Unit> {
    if (!input.code?.trim()) throw new ValidationError('code is required');
    if (!input.projectId?.trim()) throw new ValidationError('projectId is required');
    if (!input.unitType?.trim()) throw new ValidationError('unitType is required');
    if (!(input.areaSqm > 0)) throw new ValidationError('areaSqm must be positive');
    if (!(input.listPrice > 0)) throw new ValidationError('listPrice must be positive');
    if (input.bedrooms !== undefined && !(input.bedrooms >= 0)) throw new ValidationError('bedrooms must be >= 0');
    if (input.gardenAreaSqm !== undefined && !(input.gardenAreaSqm >= 0)) throw new ValidationError('gardenAreaSqm must be >= 0');
    const masterPlanPosition = this.sanitizeMasterPlanPosition(input.masterPlanPosition);

    // Scoped per-project, not company-wide: two different projects (e.g. two
    // different developers imported from two different availability sheets)
    // commonly reuse the same short unit code, and that must not collide.
    const existing = await this.units.findAll(
      (u) => u.companyId === input.companyId && u.projectId === input.projectId.trim() && u.code.toLowerCase() === input.code.trim().toLowerCase(),
    );
    if (existing.length > 0) {
      throw new InventoryError(`unit code ${input.code} already exists in this project`, 409);
    }

    const unit: Unit = {
      id: randomUUID(),
      companyId: input.companyId,
      projectId: input.projectId.trim(),
      phaseId: input.phaseId || undefined,
      code: input.code.trim(),
      unitType: input.unitType.trim(),
      areaSqm: input.areaSqm,
      listPrice: input.listPrice,
      status: input.initialStatus ?? 'available',
      sourceStatus: input.sourceStatus,
      floorLabel: input.floorLabel?.trim() || undefined,
      bedrooms: input.bedrooms,
      designType: input.designType?.trim() || undefined,
      view: input.view?.length ? input.view : undefined,
      gardenAreaSqm: input.gardenAreaSqm,
      buildingLabel: input.buildingLabel?.trim() || undefined,
      finishingType: input.finishingType?.trim() || undefined,
      delivery: input.delivery,
      pricePerMeterOverride: input.pricePerMeterOverride,
      floorPlanImageUrl: input.floorPlanImageUrl?.trim() || undefined,
      masterPlanPosition,
      sourceImportId: input.sourceImportId,
      sourceSheet: input.sourceSheet,
      sourceRow: input.sourceRow,
      createdAt: new Date().toISOString(),
    };
    return this.units.save(unit);
  }

  /** Every coordinate is a percentage (0-100) of the master-plan image's
   * width/height — see MasterPlanPosition's own doc comment for why. */
  private sanitizeMasterPlanPosition(pos: MasterPlanPosition | undefined): MasterPlanPosition | undefined {
    if (pos === undefined) return undefined;
    for (const [field, value] of Object.entries(pos) as [keyof MasterPlanPosition, number][]) {
      if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100)) {
        throw new ValidationError(`masterPlanPosition.${field} must be a number between 0 and 100`);
      }
    }
    return pos;
  }

  async listUnits(companyId: string, projectId?: string): Promise<Unit[]> {
    return this.units.findAll((u) => u.companyId === companyId && (!projectId || u.projectId === projectId));
  }

  /** Real, server-side unit search covering every filterable inventory
   * attribute — the AI's search_units tool and the /api/inventory/units
   * list route both call this instead of keeping two separate filter
   * chains, so a human's search and the AI's search can never quietly
   * diverge. destination/developerId filter through the unit's Project. */
  async searchUnits(companyId: string, filters: UnitSearchFilters = {}): Promise<Unit[]> {
    let projectIdsForCompanyFilter: Set<string> | undefined;
    if (filters.destination || filters.developerId) {
      const projects = await this.projects.findAll((p) => {
        if (p.companyId !== companyId) return false;
        if (filters.destination && p.destination?.toLowerCase() !== filters.destination.toLowerCase()) return false;
        if (filters.developerId && p.developerId !== filters.developerId) return false;
        return true;
      });
      projectIdsForCompanyFilter = new Set(projects.map((p) => p.id));
    }

    const status = filters.status ?? 'available';
    const q = filters.q?.trim().toLowerCase();
    const limit = Math.min(200, Math.max(1, filters.limit ?? 50));

    const matches = await this.units.findAll((u) => {
      if (u.companyId !== companyId) return false;
      if (filters.projectId && u.projectId !== filters.projectId) return false;
      if (filters.phaseId && u.phaseId !== filters.phaseId) return false;
      if (projectIdsForCompanyFilter && !projectIdsForCompanyFilter.has(u.projectId)) return false;
      if (status !== 'any' && u.status !== status) return false;
      if (filters.unitType && !u.unitType.toLowerCase().includes(filters.unitType.toLowerCase())) return false;
      if (filters.minPrice !== undefined && u.listPrice < filters.minPrice) return false;
      if (filters.maxPrice !== undefined && u.listPrice > filters.maxPrice) return false;
      if (filters.minAreaSqm !== undefined && u.areaSqm < filters.minAreaSqm) return false;
      if (filters.maxAreaSqm !== undefined && u.areaSqm > filters.maxAreaSqm) return false;
      if (filters.minGardenAreaSqm !== undefined && (u.gardenAreaSqm ?? 0) < filters.minGardenAreaSqm) return false;
      if (filters.maxGardenAreaSqm !== undefined && (u.gardenAreaSqm ?? 0) > filters.maxGardenAreaSqm) return false;
      if (filters.bedrooms !== undefined && u.bedrooms !== filters.bedrooms) return false;
      if (filters.minBedrooms !== undefined && (u.bedrooms ?? -1) < filters.minBedrooms) return false;
      if (filters.maxBedrooms !== undefined && (u.bedrooms ?? Infinity) > filters.maxBedrooms) return false;
      if (filters.finishingType && u.finishingType?.toLowerCase() !== filters.finishingType.toLowerCase()) return false;
      if (filters.view && !(u.view ?? []).some((v) => v.toLowerCase() === filters.view!.toLowerCase())) return false;
      if (filters.floorLabel && u.floorLabel?.toLowerCase() !== filters.floorLabel.toLowerCase()) return false;
      if (filters.designType && u.designType?.toLowerCase() !== filters.designType.toLowerCase()) return false;
      if (q && !(u.code.toLowerCase().includes(q) || u.unitType.toLowerCase().includes(q) || u.buildingLabel?.toLowerCase().includes(q))) return false;
      return true;
    });
    return matches.sort((a, b) => a.listPrice - b.listPrice).slice(0, limit);
  }

  /** Updates commercial/descriptive fields on an existing unit — used by
   * Inventory Import to correct/refresh a price list without ever touching
   * `status`. Refuses to touch a unit that's reserved, contracted, or
   * otherwise off the market: a real financial relationship (a hold,
   * reservation, or signed contract) already depends on that unit's
   * current data, and a bulk import is the wrong place to silently change
   * it out from under that relationship. Only 'available' units are safe
   * to bulk-update this way. Non-destructive: an omitted field keeps its
   * current value. */
  async updateUnitDetails(unitId: string, companyId: string, updates: UpdateUnitDetailsInput): Promise<Unit> {
    const unit = await this.units.findById(unitId);
    if (!unit || unit.companyId !== companyId) throw new NotFoundError('unit not found');
    if (unit.status !== 'available') {
      throw new InventoryError(`cannot update unit "${unit.code}" — it is currently ${unit.status}, not available`, 409);
    }
    if (updates.areaSqm !== undefined && !(updates.areaSqm > 0)) throw new ValidationError('areaSqm must be positive');
    if (updates.listPrice !== undefined && !(updates.listPrice > 0)) throw new ValidationError('listPrice must be positive');
    if (updates.bedrooms !== undefined && !(updates.bedrooms >= 0)) throw new ValidationError('bedrooms must be >= 0');
    if (updates.gardenAreaSqm !== undefined && !(updates.gardenAreaSqm >= 0)) throw new ValidationError('gardenAreaSqm must be >= 0');
    const masterPlanPosition = updates.masterPlanPosition !== undefined ? this.sanitizeMasterPlanPosition(updates.masterPlanPosition) : unit.masterPlanPosition;
    return this.units.save({
      ...unit,
      unitType: updates.unitType?.trim() || unit.unitType,
      areaSqm: updates.areaSqm ?? unit.areaSqm,
      listPrice: updates.listPrice ?? unit.listPrice,
      phaseId: updates.phaseId !== undefined ? updates.phaseId || undefined : unit.phaseId,
      floorLabel: updates.floorLabel !== undefined ? updates.floorLabel?.trim() || undefined : unit.floorLabel,
      bedrooms: updates.bedrooms ?? unit.bedrooms,
      designType: updates.designType !== undefined ? updates.designType?.trim() || undefined : unit.designType,
      view: updates.view !== undefined ? (updates.view.length ? updates.view : undefined) : unit.view,
      gardenAreaSqm: updates.gardenAreaSqm ?? unit.gardenAreaSqm,
      buildingLabel: updates.buildingLabel !== undefined ? updates.buildingLabel?.trim() || undefined : unit.buildingLabel,
      finishingType: updates.finishingType !== undefined ? updates.finishingType?.trim() || undefined : unit.finishingType,
      floorPlanImageUrl: updates.floorPlanImageUrl !== undefined ? updates.floorPlanImageUrl?.trim() || undefined : unit.floorPlanImageUrl,
      masterPlanPosition,
      delivery: updates.delivery ?? unit.delivery,
      pricePerMeterOverride: updates.pricePerMeterOverride ?? unit.pricePerMeterOverride,
      sourceImportId: updates.sourceImportId ?? unit.sourceImportId,
      sourceSheet: updates.sourceSheet ?? unit.sourceSheet,
      sourceRow: updates.sourceRow ?? unit.sourceRow,
    });
  }

  async getUnit(id: string): Promise<Unit | undefined> {
    return this.units.findById(id);
  }

  /** Availability-import-driven status sync — distinct from
   * updateUnitDetails() (which explicitly never touches status) and from
   * holdUnit/reserveUnit/markContracted (which represent a real internal
   * sales action taken through this system's own CRM flow). A live-
   * availability re-import needs to reflect a developer's own external
   * status changes (Available -> Hold -> Reserved -> Sold) without ever
   * overwriting a status this system's own CRM flow set: if a real active
   * UnitHold or Reservation currently exists for this unit, the import is
   * refused — same "protected, never silently touched" precedent as
   * updateUnitDetails already applies to any non-'available' unit. Only
   * when no internal hold/reservation is backing the current status (i.e.
   * it was itself set by a prior import, or the unit is already
   * 'available') is a re-import allowed to move it again. */
  async updateUnitAvailabilityFromImport(
    unitId: string,
    companyId: string,
    status: UnitStatus,
    sourceStatus: string,
    provenance?: { sourceImportId?: string; sourceSheet?: string; sourceRow?: number },
  ): Promise<Unit> {
    return this.mutex.runExclusive(unitId, async () => {
      const unit = await this.units.findById(unitId);
      if (!unit || unit.companyId !== companyId) throw new NotFoundError('unit not found');
      if (unit.status !== status && unit.status !== 'available') {
        const [activeHolds, activeReservations] = await Promise.all([
          this.holds.findAll((h) => h.unitId === unitId && h.active),
          this.reservations.findAll((r) => r.unitId === unitId && r.status === 'active'),
        ]);
        if (activeHolds.length > 0 || activeReservations.length > 0) {
          throw new InventoryError(`cannot update availability for unit "${unit.code}" — it has an active internal hold/reservation`, 409);
        }
      }
      return this.units.save({
        ...unit,
        status,
        sourceStatus,
        sourceImportId: provenance?.sourceImportId ?? unit.sourceImportId,
        sourceSheet: provenance?.sourceSheet ?? unit.sourceSheet,
        sourceRow: provenance?.sourceRow ?? unit.sourceRow,
      });
    });
  }

  /** The entity/repo has existed since Reservations were introduced (via
   * holdUnit/reserveUnit), but nothing could ever list them back — a real
   * gap for a "which units are reserved, by whom, expiring when" view. */
  async listReservations(companyId: string, status?: Reservation['status']): Promise<Reservation[]> {
    return this.reservations.findAll((r) => r.companyId === companyId && (!status || r.status === status));
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

  async holdUnit(unitId: string, byUserId: string, companyId: string): Promise<UnitHold> {
    return this.mutex.runExclusive(unitId, async () => {
      await this.sweepExpiredHolds(unitId);
      const unit = await this.units.findById(unitId);
      if (!unit || unit.companyId !== companyId) throw new NotFoundError('unit not found');
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
  async reserveUnit(unitId: string, clientId: string, companyId: string, opportunityId?: string): Promise<Reservation> {
    return this.mutex.runExclusive(unitId, async () => {
      await this.sweepExpiredHolds(unitId);
      const unit = await this.units.findById(unitId);
      if (!unit || unit.companyId !== companyId) throw new NotFoundError('unit not found');
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

  /** Mutex-protected on unitId — without this, a concurrent
   * sweepExpiredReservationsDetailed() call racing this same unit could read
   * a stale pre-contract status and overwrite 'contracted' back to
   * 'available' after this write commits, reopening a sold unit for a
   * second reservation. Both this method and the sweep now serialize on the
   * same per-unit key, so whichever runs first is always fully visible to
   * the other. */
  async markContracted(unitId: string): Promise<Unit> {
    return this.mutex.runExclusive(unitId, async () => {
      const unit = await this.units.findById(unitId);
      if (!unit) throw new NotFoundError('unit not found');
      return this.units.save({ ...unit, status: 'contracted' });
    });
  }

  /** Releases a unit back onto the market — used when the contract that
   * had contracted it is cancelled. Mutex-protected on unitId for the same
   * reason as markContracted — see its comment. */
  async markAvailable(unitId: string): Promise<Unit> {
    return this.mutex.runExclusive(unitId, async () => {
      const unit = await this.units.findById(unitId);
      if (!unit) throw new NotFoundError('unit not found');
      return this.units.save({ ...unit, status: 'available' });
    });
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

  /** Never touches a reservation that already converted or was cancelled.
   * Safe to call repeatedly — same shape as FinanceService.sweepOverdue. */
  async sweepExpiredReservations(now = new Date(), companyId?: string): Promise<number> {
    const swept = await this.sweepExpiredReservationsDetailed(now, companyId);
    return swept.length;
  }

  /** Same sweep as sweepExpiredReservations(), but returns the reservations
   * it actually expired — used by app.ts/main.ts to emit one
   * `reservation.expired` domain event per reservation so the Automation
   * Engine can react (e.g. notify the assigned agent). Releases the unit
   * back to 'available' only when it's still 'reserved' — a unit that has
   * since been contracted (or otherwise moved on) is never downgraded. The
   * unit read-check-write runs inside the same per-unit KeyedMutex
   * markContracted()/markAvailable()/holdUnit()/reserveUnit() use, so a
   * signContract() landing concurrently on the same unit can never have its
   * 'contracted' write silently reverted by a sweep that read a stale
   * pre-contract status (the double-sell race this closes).
   *
   * `companyId` is optional and, when omitted, sweeps every tenant — correct
   * for main.ts's periodic background tick, the only caller meant to act
   * across the whole deployment. The manual HTTP route
   * (/api/inventory/sweep-expired-reservations) MUST pass the requesting
   * user's own companyId, or any tenant could trigger a mutation touching
   * every other tenant's reservations. */
  async sweepExpiredReservationsDetailed(now = new Date(), companyId?: string): Promise<Reservation[]> {
    const candidates = await this.reservations.findAll(
      (r) => (!companyId || r.companyId === companyId) && r.status === 'active' && Date.parse(r.expiresAt) < now.getTime(),
    );
    const swept: Reservation[] = [];
    for (const reservation of candidates) {
      swept.push(await this.reservations.save({ ...reservation, status: 'cancelled' }));
      await this.mutex.runExclusive(reservation.unitId, async () => {
        const unit = await this.units.findById(reservation.unitId);
        if (unit && unit.status === 'reserved') {
          await this.units.save({ ...unit, status: 'available' });
        }
      });
    }
    return swept;
  }

  // ---- Developer / Project master data ----
  // All gated on the existing 'project' RBAC resource (create/edit/view) at
  // the route layer, same as Project itself — these are project master
  // data, not a separate permission surface.

  private requireRepo<T extends { id: string }>(repo: Repository<T> | undefined, name: string): Repository<T> {
    if (!repo) throw new InventoryError(`${name} repository is not configured for this deployment`, 500);
    return repo;
  }

  async createDeveloper(input: { companyId: string; name: string; description?: string; website?: string; logoUrl?: string }): Promise<Developer> {
    if (!input.name?.trim()) throw new ValidationError('name is required');
    const developer: Developer = {
      id: randomUUID(),
      companyId: input.companyId,
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      website: input.website?.trim() || undefined,
      logoUrl: input.logoUrl?.trim() || undefined,
      createdAt: new Date().toISOString(),
    };
    return this.requireRepo(this.developers, 'Developer').save(developer);
  }

  async listDevelopers(companyId: string): Promise<Developer[]> {
    return this.requireRepo(this.developers, 'Developer').findAll((d) => d.companyId === companyId);
  }

  async getDeveloper(id: string): Promise<Developer | undefined> {
    return this.requireRepo(this.developers, 'Developer').findById(id);
  }

  /** Finds-or-creates a Developer by case-insensitive name — used by the
   * Import Engine when a spreadsheet lists a developer as free text rather
   * than an id. */
  async resolveOrCreateDeveloper(companyId: string, name: string): Promise<Developer> {
    const trimmed = name.trim();
    const existing = (await this.listDevelopers(companyId)).find((d) => d.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing;
    return this.createDeveloper({ companyId, name: trimmed });
  }

  /** A developer's real portfolio — every Project referencing this
   * developer, not a duplicated text list stored per-unit. */
  async getDeveloperPortfolio(developerId: string, companyId: string): Promise<Project[]> {
    return this.projects.findAll((p) => p.companyId === companyId && p.developerId === developerId);
  }

  async createProjectPhase(input: { companyId: string; projectId: string; name: string; order?: number }): Promise<ProjectPhase> {
    if (!input.name?.trim()) throw new ValidationError('name is required');
    if (!input.projectId?.trim()) throw new ValidationError('projectId is required');
    const phase: ProjectPhase = {
      id: randomUUID(),
      companyId: input.companyId,
      projectId: input.projectId,
      name: input.name.trim(),
      order: input.order ?? 0,
      createdAt: new Date().toISOString(),
    };
    return this.requireRepo(this.phases, 'ProjectPhase').save(phase);
  }

  async listProjectPhases(companyId: string, projectId?: string): Promise<ProjectPhase[]> {
    const rows = await this.requireRepo(this.phases, 'ProjectPhase').findAll((p) => p.companyId === companyId && (!projectId || p.projectId === projectId));
    return rows.sort((a, b) => a.order - b.order);
  }

  async createLaunch(input: {
    companyId: string;
    projectId: string;
    phaseId?: string;
    name: string;
    launchDate?: string;
    inventoryReleased?: number;
    pricingNotes?: string;
    paymentPlanTemplateIds?: string[];
    source?: string;
    notes?: string;
  }): Promise<Launch> {
    if (!input.name?.trim()) throw new ValidationError('name is required');
    if (!input.projectId?.trim()) throw new ValidationError('projectId is required');
    const launch: Launch = {
      id: randomUUID(),
      companyId: input.companyId,
      projectId: input.projectId,
      phaseId: input.phaseId || undefined,
      name: input.name.trim(),
      launchDate: input.launchDate,
      inventoryReleased: input.inventoryReleased,
      pricingNotes: input.pricingNotes?.trim() || undefined,
      paymentPlanTemplateIds: input.paymentPlanTemplateIds,
      source: input.source?.trim() || undefined,
      notes: input.notes?.trim() || undefined,
      createdAt: new Date().toISOString(),
    };
    return this.requireRepo(this.launches, 'Launch').save(launch);
  }

  async listLaunches(companyId: string, projectId?: string): Promise<Launch[]> {
    return this.requireRepo(this.launches, 'Launch').findAll((l) => l.companyId === companyId && (!projectId || l.projectId === projectId));
  }

  async createFacility(input: { companyId: string; name: string; category?: string }): Promise<Facility> {
    if (!input.name?.trim()) throw new ValidationError('name is required');
    const facility: Facility = {
      id: randomUUID(),
      companyId: input.companyId,
      name: input.name.trim(),
      category: input.category?.trim() || undefined,
      createdAt: new Date().toISOString(),
    };
    return this.requireRepo(this.facilities, 'Facility').save(facility);
  }

  async listFacilities(companyId: string): Promise<Facility[]> {
    return this.requireRepo(this.facilities, 'Facility').findAll((f) => f.companyId === companyId);
  }

  /** Resolves Project.facilityIds into real Facility rows — the normalized
   * structure the spec asks for instead of one long text field. */
  async getProjectFacilities(projectId: string, companyId: string): Promise<Facility[]> {
    const project = await this.projects.findById(projectId);
    if (!project || project.companyId !== companyId) throw new NotFoundError('project not found');
    if (!project.facilityIds?.length) return [];
    const all = await this.listFacilities(companyId);
    const byId = new Map(all.map((f) => [f.id, f]));
    return project.facilityIds.map((id) => byId.get(id)).filter((f): f is Facility => !!f);
  }

  /** Finds-or-creates a Facility by case-insensitive name — used by the
   * Import Engine when a spreadsheet lists facility names as free text
   * rather than ids. */
  async resolveOrCreateFacility(companyId: string, name: string): Promise<Facility> {
    const trimmed = name.trim();
    const existing = (await this.listFacilities(companyId)).find((f) => f.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing;
    return this.createFacility({ companyId, name: trimmed });
  }

  async createConsultant(input: { companyId: string; name: string; role: ConsultantRole; contactInfo?: string }): Promise<Consultant> {
    if (!input.name?.trim()) throw new ValidationError('name is required');
    const consultant: Consultant = {
      id: randomUUID(),
      companyId: input.companyId,
      name: input.name.trim(),
      role: input.role,
      contactInfo: input.contactInfo?.trim() || undefined,
      createdAt: new Date().toISOString(),
    };
    return this.requireRepo(this.consultants, 'Consultant').save(consultant);
  }

  async listConsultants(companyId: string, role?: ConsultantRole): Promise<Consultant[]> {
    return this.requireRepo(this.consultants, 'Consultant').findAll((c) => c.companyId === companyId && (!role || c.role === role));
  }

  async resolveOrCreateConsultant(companyId: string, name: string, role: ConsultantRole): Promise<Consultant> {
    const trimmed = name.trim();
    const existing = (await this.listConsultants(companyId, role)).find((c) => c.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing;
    return this.createConsultant({ companyId, name: trimmed, role });
  }

  async createSalesPhoneNumber(input: { companyId: string; projectId: string; phoneNumber: string; countryCode?: string; type?: string; source?: string }): Promise<SalesPhoneNumber> {
    if (!input.phoneNumber?.trim()) throw new ValidationError('phoneNumber is required');
    if (!input.projectId?.trim()) throw new ValidationError('projectId is required');
    const phone: SalesPhoneNumber = {
      id: randomUUID(),
      companyId: input.companyId,
      projectId: input.projectId,
      phoneNumber: input.phoneNumber.trim(),
      countryCode: input.countryCode?.trim() || undefined,
      type: input.type?.trim() || undefined,
      source: input.source?.trim() || undefined,
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    return this.requireRepo(this.salesPhones, 'SalesPhoneNumber').save(phone);
  }

  async listSalesPhoneNumbers(companyId: string, projectId?: string): Promise<SalesPhoneNumber[]> {
    return this.requireRepo(this.salesPhones, 'SalesPhoneNumber').findAll((s) => s.companyId === companyId && (!projectId || s.projectId === projectId) && s.isActive);
  }

  async deactivateSalesPhoneNumber(id: string, companyId: string): Promise<SalesPhoneNumber> {
    const repo = this.requireRepo(this.salesPhones, 'SalesPhoneNumber');
    const phone = await repo.findById(id);
    if (!phone || phone.companyId !== companyId) throw new NotFoundError('sales phone number not found');
    return repo.save({ ...phone, isActive: false });
  }

  /** A single rich read for a project detail view / the AI's
   * get_project_details tool — real joins across the project's own master
   * data, never fabricated. */
  async getProjectFullDetails(id: string, companyId: string): Promise<{
    project: Project;
    developer?: Developer;
    phases: ProjectPhase[];
    launches: Launch[];
    facilities: Facility[];
    engineeringConsultant?: Consultant;
    projectManagement?: Consultant;
    salesPhoneNumbers: SalesPhoneNumber[];
  }> {
    const project = await this.projects.findById(id);
    if (!project || project.companyId !== companyId) throw new NotFoundError('project not found');
    const [developer, phases, launches, facilities, engineeringConsultant, projectManagement, salesPhoneNumbers] = await Promise.all([
      project.developerId ? this.getDeveloper(project.developerId) : undefined,
      this.listProjectPhases(companyId, id),
      this.listLaunches(companyId, id),
      this.getProjectFacilities(id, companyId),
      project.engineeringConsultantId ? this.requireRepo(this.consultants, 'Consultant').findById(project.engineeringConsultantId) : undefined,
      project.projectManagementId ? this.requireRepo(this.consultants, 'Consultant').findById(project.projectManagementId) : undefined,
      this.listSalesPhoneNumbers(companyId, id),
    ]);
    return { project, developer, phases, launches, facilities, engineeringConsultant, projectManagement, salesPhoneNumbers };
  }

  // ---- Project Unit Specs (catalog / product ranges) ----
  // "What a project markets" (a range of BUA/price for a unit type +
  // bedroom count), as opposed to "what physically exists" (a real, coded
  // Unit). Gated on the existing 'project' RBAC resource, same as every
  // other project-master-data entity above.

  private sanitizeProjectUnitSpecFields(input: UpdateProjectUnitSpecInput): Partial<ProjectUnitSpec> {
    const out: Partial<ProjectUnitSpec> = {};
    if (input.phaseId !== undefined) out.phaseId = input.phaseId || undefined;
    if (input.bedrooms !== undefined) out.bedrooms = input.bedrooms;
    if (input.landAreaFromSqm !== undefined) out.landAreaFromSqm = this.nonNegative(input.landAreaFromSqm, 'landAreaFromSqm');
    if (input.landAreaToSqm !== undefined) out.landAreaToSqm = this.nonNegative(input.landAreaToSqm, 'landAreaToSqm');
    if (input.buaFromSqm !== undefined) out.buaFromSqm = this.nonNegative(input.buaFromSqm, 'buaFromSqm');
    if (input.buaToSqm !== undefined) out.buaToSqm = this.nonNegative(input.buaToSqm, 'buaToSqm');
    if (input.gardenAreaFromSqm !== undefined) out.gardenAreaFromSqm = this.nonNegative(input.gardenAreaFromSqm, 'gardenAreaFromSqm');
    if (input.gardenAreaToSqm !== undefined) out.gardenAreaToSqm = this.nonNegative(input.gardenAreaToSqm, 'gardenAreaToSqm');
    if (input.priceFrom !== undefined) out.priceFrom = this.nonNegative(input.priceFrom, 'priceFrom');
    if (input.priceTo !== undefined) out.priceTo = this.nonNegative(input.priceTo, 'priceTo');
    if (input.pricePerMeter !== undefined) out.pricePerMeter = this.nonNegative(input.pricePerMeter, 'pricePerMeter');
    if (input.finishingType !== undefined) out.finishingType = input.finishingType?.trim() || undefined;
    if (input.delivery !== undefined) out.delivery = input.delivery;
    if (input.paymentPlanTemplateIds !== undefined) out.paymentPlanTemplateIds = input.paymentPlanTemplateIds;
    if (input.cashDiscountPercent !== undefined) out.cashDiscountPercent = this.percentInRange(input.cashDiscountPercent, 'cashDiscountPercent');
    if (input.maintenanceFeePercent !== undefined) out.maintenanceFeePercent = this.percentInRange(input.maintenanceFeePercent, 'maintenanceFeePercent');
    if (input.sourceImportId !== undefined) out.sourceImportId = input.sourceImportId;
    if (input.sourceSheet !== undefined) out.sourceSheet = input.sourceSheet;
    if (input.sourceRow !== undefined) out.sourceRow = input.sourceRow;
    return out;
  }

  async createProjectUnitSpec(input: CreateProjectUnitSpecInput): Promise<ProjectUnitSpec> {
    if (!input.projectId?.trim()) throw new ValidationError('projectId is required');
    if (!input.unitType?.trim()) throw new ValidationError('unitType is required');
    if (input.bedrooms !== undefined && !(input.bedrooms >= 0)) throw new ValidationError('bedrooms must be >= 0');
    const now = new Date().toISOString();
    const spec: ProjectUnitSpec = {
      id: randomUUID(),
      companyId: input.companyId,
      projectId: input.projectId.trim(),
      unitType: input.unitType.trim(),
      ...this.sanitizeProjectUnitSpecFields(input),
      createdAt: now,
      updatedAt: now,
    };
    return this.requireRepo(this.projectUnitSpecs, 'ProjectUnitSpec').save(spec);
  }

  async listProjectUnitSpecs(companyId: string, projectId?: string): Promise<ProjectUnitSpec[]> {
    return this.requireRepo(this.projectUnitSpecs, 'ProjectUnitSpec').findAll(
      (s) => s.companyId === companyId && (!projectId || s.projectId === projectId),
    );
  }

  async getProjectUnitSpec(id: string): Promise<ProjectUnitSpec | undefined> {
    return this.requireRepo(this.projectUnitSpecs, 'ProjectUnitSpec').findById(id);
  }

  /** Non-destructive, same convention as updateProjectDetails — an omitted
   * field keeps its current value. */
  async updateProjectUnitSpec(id: string, companyId: string, updates: UpdateProjectUnitSpecInput): Promise<ProjectUnitSpec> {
    const repo = this.requireRepo(this.projectUnitSpecs, 'ProjectUnitSpec');
    const spec = await repo.findById(id);
    if (!spec || spec.companyId !== companyId) throw new NotFoundError('project unit spec not found');
    return repo.save({
      ...spec,
      ...this.sanitizeProjectUnitSpecFields(updates),
      updatedAt: new Date().toISOString(),
    });
  }

  /** Finds-or-creates/updates a ProjectUnitSpec by its natural key
   * (project + phase + unitType + bedrooms) — the Import Engine's entry
   * point for a catalog row, mirroring the resolveOrCreateX pattern used
   * for Developer/Facility/Consultant above. A second row for the same
   * natural key updates the existing spec's ranges non-destructively
   * rather than creating a duplicate. */
  async resolveProjectUnitSpec(input: CreateProjectUnitSpecInput): Promise<ProjectUnitSpec> {
    const existing = await this.listProjectUnitSpecs(input.companyId, input.projectId);
    const match = existing.find(
      (s) =>
        (s.phaseId || undefined) === (input.phaseId || undefined) &&
        s.unitType.toLowerCase() === input.unitType.trim().toLowerCase() &&
        (s.bedrooms ?? null) === (input.bedrooms ?? null),
    );
    if (!match) return this.createProjectUnitSpec(input);
    return this.updateProjectUnitSpec(match.id, input.companyId, input);
  }
}
