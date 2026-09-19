import { randomUUID } from 'node:crypto';
import type { CrmStage } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { ConflictError, NotFoundError, ValidationError } from '../../infra/errors.js';

export interface CreateStageInput {
  companyId: string;
  key?: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  order?: number;
  isDefault?: boolean;
  isWon?: boolean;
  isLost?: boolean;
  allowManualMove?: boolean;
  allowAutomationMove?: boolean;
}

export type UpdateStageInput = Partial<Omit<CreateStageInput, 'companyId' | 'key'>>;

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || randomUUID().slice(0, 8)
  );
}

/**
 * The default pipeline every company gets on first boot — matches the
 * stage list the CRM restructuring was built around (Fresh Leads through
 * Won/Lost/Unqualified/Recycle). Seeded once per company, then fully
 * editable: an admin can rename, reorder, deactivate, or add their own
 * stages on top without touching this list again. `key` is a stable slug
 * for these defaults only — nothing in business logic branches on it,
 * only on the isDefault/isWon/isLost/order flags, so a renamed or
 * custom-added stage behaves correctly with zero code changes.
 */
const DEFAULT_STAGES: Array<Omit<CreateStageInput, 'companyId'>> = [
  { key: 'fresh', name: 'Fresh Leads', order: 0, isDefault: true },
  { key: 'contacted', name: 'Contacted', order: 1 },
  { key: 'follow_up', name: 'Follow Up', order: 2 },
  { key: 'qualified', name: 'Qualified', order: 3 },
  { key: 'meeting', name: 'Meeting / Appointment', order: 4 },
  { key: 'negotiation', name: 'Negotiation', order: 5 },
  { key: 'proposal', name: 'Proposal / Offer', order: 6 },
  { key: 'booking', name: 'Booking', order: 7 },
  { key: 'won', name: 'Won', order: 8, isWon: true, allowAutomationMove: false },
  { key: 'unqualified', name: 'Unqualified', order: 9, isLost: true },
  { key: 'recycle', name: 'Recycle / Later', order: 10 },
  { key: 'lost', name: 'Lost', order: 11, isLost: true },
];

export class CrmStageService {
  constructor(private readonly stages: Repository<CrmStage>) {}

  /** Idempotent — a company that already has stages is left untouched.
   * Called from seed.ts alongside the rest of demo/tenant bootstrap. */
  async seedDefaultStages(companyId: string): Promise<CrmStage[]> {
    const existing = await this.stages.findAll((s) => s.companyId === companyId);
    if (existing.length > 0) return existing.sort((a, b) => a.order - b.order);

    const now = new Date().toISOString();
    const created: CrmStage[] = [];
    for (const def of DEFAULT_STAGES) {
      created.push(
        await this.stages.save({
          id: randomUUID(),
          companyId,
          key: def.key!,
          name: def.name,
          description: def.description,
          icon: def.icon,
          color: def.color,
          order: def.order ?? created.length,
          isActive: true,
          isDefault: def.isDefault ?? false,
          isWon: def.isWon ?? false,
          isLost: def.isLost ?? false,
          allowManualMove: def.allowManualMove ?? true,
          allowAutomationMove: def.allowAutomationMove ?? true,
          createdAt: now,
          updatedAt: now,
        }),
      );
    }
    return created;
  }

  async listStages(companyId: string, includeInactive = false): Promise<CrmStage[]> {
    const all = await this.stages.findAll((s) => s.companyId === companyId && (includeInactive || s.isActive));
    return all.sort((a, b) => a.order - b.order);
  }

  async getStage(id: string, companyId: string): Promise<CrmStage> {
    const stage = await this.stages.findById(id);
    if (!stage || stage.companyId !== companyId) throw new NotFoundError('CRM stage not found');
    return stage;
  }

  /** Exactly one isDefault stage per company — this is what "a new Lead
   * lands in Fresh Leads" means structurally. Throws if none is
   * configured, since createLead has nowhere sane to put a new lead. */
  async getDefaultStage(companyId: string): Promise<CrmStage> {
    const all = await this.stages.findAll((s) => s.companyId === companyId && s.isActive && s.isDefault);
    const stage = all[0];
    if (!stage) throw new ConflictError('no default CRM stage configured for this company');
    return stage;
  }

  async createStage(input: CreateStageInput): Promise<CrmStage> {
    if (!input.name?.trim()) throw new ValidationError('name is required');
    const existing = await this.stages.findAll((s) => s.companyId === input.companyId);
    const key = input.key?.trim() || slugify(input.name);
    if (existing.some((s) => s.key === key)) {
      throw new ConflictError(`a CRM stage with key "${key}" already exists`);
    }
    if (input.isWon && input.isLost) throw new ValidationError('a stage cannot be both isWon and isLost');

    const now = new Date().toISOString();
    const stage: CrmStage = {
      id: randomUUID(),
      companyId: input.companyId,
      key,
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      icon: input.icon?.trim() || undefined,
      color: input.color?.trim() || undefined,
      order: input.order ?? (existing.length > 0 ? Math.max(...existing.map((s) => s.order)) + 1 : 0),
      isActive: true,
      isDefault: false, // setting a new default goes through setDefaultStage(), never directly
      isWon: input.isWon ?? false,
      isLost: input.isLost ?? false,
      allowManualMove: input.allowManualMove ?? true,
      allowAutomationMove: input.allowAutomationMove ?? true,
      createdAt: now,
      updatedAt: now,
    };
    return this.stages.save(stage);
  }

  async updateStage(id: string, companyId: string, patch: UpdateStageInput): Promise<CrmStage> {
    const stage = await this.getStage(id, companyId);
    if (patch.name !== undefined && !patch.name.trim()) throw new ValidationError('name cannot be blank');
    const isWon = patch.isWon ?? stage.isWon;
    const isLost = patch.isLost ?? stage.isLost;
    if (isWon && isLost) throw new ValidationError('a stage cannot be both isWon and isLost');

    return this.stages.save({
      ...stage,
      name: patch.name?.trim() ?? stage.name,
      description: patch.description !== undefined ? patch.description.trim() || undefined : stage.description,
      icon: patch.icon !== undefined ? patch.icon.trim() || undefined : stage.icon,
      color: patch.color !== undefined ? patch.color.trim() || undefined : stage.color,
      order: patch.order ?? stage.order,
      isWon,
      isLost,
      allowManualMove: patch.allowManualMove ?? stage.allowManualMove,
      allowAutomationMove: patch.allowAutomationMove ?? stage.allowAutomationMove,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Reassigns `order` for every stage listed, in the order given —
   * lets the admin drag-and-drop reorder the pipeline in one call. */
  async reorderStages(companyId: string, orderedStageIds: string[]): Promise<CrmStage[]> {
    const all = await this.listStages(companyId, true);
    const byId = new Map(all.map((s) => [s.id, s]));
    if (orderedStageIds.some((id) => !byId.has(id))) {
      throw new ValidationError('reorder list contains a stage id that does not belong to this company');
    }
    const now = new Date().toISOString();
    const saved: CrmStage[] = [];
    for (let i = 0; i < orderedStageIds.length; i++) {
      const stage = byId.get(orderedStageIds[i]!)!;
      saved.push(await this.stages.save({ ...stage, order: i, updatedAt: now }));
    }
    return saved.sort((a, b) => a.order - b.order);
  }

  /** Moves the isDefault flag to a different stage (exactly one company-
   * wide) rather than letting two stages claim to be the Fresh-Leads
   * entry point at once. */
  async setDefaultStage(id: string, companyId: string): Promise<CrmStage> {
    const target = await this.getStage(id, companyId);
    if (!target.isActive) throw new ValidationError('cannot set an archived stage as the default');
    const all = await this.stages.findAll((s) => s.companyId === companyId && s.isDefault && s.id !== id);
    const now = new Date().toISOString();
    for (const other of all) {
      await this.stages.save({ ...other, isDefault: false, updatedAt: now });
    }
    return this.stages.save({ ...target, isDefault: true, updatedAt: now });
  }

  /** Soft-delete only — matches PaymentPlanTemplate's archival convention.
   * Never actually removes the row, since existing leads may still
   * reference it. Refuses to archive the current default stage (would
   * leave new leads with nowhere to land) or a stage still holding
   * leads (caller must move them first) unless `force` is passed. */
  async archiveStage(id: string, companyId: string): Promise<CrmStage> {
    const stage = await this.getStage(id, companyId);
    if (stage.isDefault) throw new ConflictError('cannot archive the default stage — set a different default first');
    return this.stages.save({ ...stage, isActive: false, updatedAt: new Date().toISOString() });
  }
}
