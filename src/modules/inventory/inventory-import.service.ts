import type { Project, Unit } from '../../domain/types.js';
import type { ImportFieldDef } from '../../infra/field-mapping.js';
import type { InventoryService } from './inventory.service.js';

/**
 * The explicit Inventory Import field dictionary. Only maps to real Unit
 * fields (code/unitType/areaSqm/listPrice) — the domain model has no
 * separate "floor"/"building"/"delivery date" fields today, so this
 * import never invents columns the rest of the system can't use.
 *
 * The *From/*To pairs exist for developer price-list exports that publish
 * a range (e.g. "BUA From"/"BUA To", "Price From"/"Price To") instead of
 * one concrete number per unit — never required on their own, and only
 * ever used as a fallback when the plain areaSqm/listPrice column isn't
 * present (see resolveRangeValue below).
 */
export const INVENTORY_IMPORT_FIELDS: ImportFieldDef[] = [
  { key: 'projectName', label: 'Project', aliases: ['project name'], required: true },
  { key: 'unitCode', label: 'Unit Code', aliases: ['unit', 'unit number', 'unit no'], required: true },
  { key: 'unitType', label: 'Unit Type', aliases: ['type'], required: true },
  { key: 'areaSqm', label: 'Area (sqm)', aliases: ['area', 'size', 'area sqm'], required: true },
  { key: 'listPrice', label: 'List Price', aliases: ['price', 'total price'], required: true },
  { key: 'areaSqmFrom', label: 'Area (sqm) — From', aliases: ['area from', 'bua from', 'size from'] },
  { key: 'areaSqmTo', label: 'Area (sqm) — To', aliases: ['area to', 'bua to', 'size to'] },
  { key: 'listPriceFrom', label: 'List Price — From', aliases: ['price from', 'total price from'] },
  { key: 'listPriceTo', label: 'List Price — To', aliases: ['price to', 'total price to'] },
];

export type InventoryRangeStrategy = 'avg' | 'from' | 'to';

export interface InventoryImportOptions {
  /** When a row has no single areaSqm/listPrice value but does have a
   * From/To pair, how to collapse it to one number. Defaults to 'avg'. */
  rangeStrategy?: InventoryRangeStrategy;
  /** When true, a row with no Unit Code column value gets one generated
   * from the project + unit type + a running sequence, unique within the
   * project. Off by default — never invents an identifier silently. */
  autoGenerateUnitCode?: boolean;
  /** When true, a Project name that doesn't match any existing project is
   * created instead of rejecting the row. Off by default. */
  autoCreateMissingProjects?: boolean;
}

function resolveRangeValue(main: string | undefined, from: string | undefined, to: string | undefined, strategy: InventoryRangeStrategy): number {
  const parse = (v: string | undefined): number | undefined => {
    const n = Number((v ?? '').replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const mainValue = parse(main);
  if (mainValue !== undefined) return mainValue;
  const fromValue = parse(from);
  const toValue = parse(to);
  if (strategy === 'from') return fromValue ?? toValue ?? NaN;
  if (strategy === 'to') return toValue ?? fromValue ?? NaN;
  if (fromValue !== undefined && toValue !== undefined) return (fromValue + toValue) / 2;
  return fromValue ?? toValue ?? NaN;
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '') || 'unit';
}

/** Prefix used on a Project id that doesn't exist yet — resolved to a real
 * created Project only inside importRows (never during preview, which is
 * read-only), and only when autoCreateMissingProjects is set. */
const PENDING_PROJECT_PREFIX = 'pending-project:';

export type InventoryImportRowStatus = 'valid' | 'conflict' | 'invalid';
export type InventoryImportRowAction = 'create' | 'update';

export interface InventoryImportRowPreview {
  row: number;
  status: InventoryImportRowStatus;
  issues: string[];
  raw: Record<string, string>;
  resolved?: {
    action: InventoryImportRowAction;
    projectId: string;
    projectName: string;
    unitCode: string;
    unitType: string;
    areaSqm: number;
    listPrice: number;
    existingUnitId?: string;
  };
}

export interface InventoryImportPreview {
  rows: InventoryImportRowPreview[];
  totalRows: number;
  validCount: number;
  conflictCount: number;
  invalidCount: number;
}

export interface InventoryImportRowResult {
  row: number;
  status: 'created' | 'updated' | 'skipped' | 'error';
  unitId?: string;
  reason?: string;
}

export interface InventoryImportResult {
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
  results: InventoryImportRowResult[];
}

/**
 * Validates and resolves Inventory Import rows and drives the actual
 * write — one row, one InventoryService.createUnit() or
 * updateUnitDetails() call, so imported units still only ever get written
 * through those two real code paths. A row matching an existing unit code
 * is a create only when no such unit exists yet; when one does, it's an
 * update if the unit is still 'available' and a protected conflict
 * otherwise — a sold/reserved/contracted unit's data (and the real
 * financial relationship depending on it) is never touched by an import,
 * matching updateUnitDetails()'s own guarantee.
 */
export class InventoryImportService {
  constructor(private readonly inventory: InventoryService) {}

  private async resolveProject(companyId: string, projectName: string, cache: Map<string, Project | null>): Promise<Project | undefined> {
    if (cache.has(projectName)) return cache.get(projectName) ?? undefined;
    const projects = await this.inventory.listProjects(companyId);
    const project = projects.find((p) => p.name.trim().toLowerCase() === projectName.trim().toLowerCase());
    cache.set(projectName, project ?? null);
    return project;
  }

  private async evaluateRows(companyId: string, mappedRows: Record<string, string>[], options: InventoryImportOptions = {}): Promise<InventoryImportRowPreview[]> {
    const rangeStrategy = options.rangeStrategy ?? 'avg';
    const existingUnits = await this.inventory.listUnits(companyId);
    const unitByProjectAndCode = new Map<string, Unit>();
    const usedCodesByProjectKey = new Map<string, Set<string>>();
    for (const u of existingUnits) {
      unitByProjectAndCode.set(`${u.projectId}:${u.code.toLowerCase()}`, u);
      if (!usedCodesByProjectKey.has(u.projectId)) usedCodesByProjectKey.set(u.projectId, new Set());
      usedCodesByProjectKey.get(u.projectId)!.add(u.code.toLowerCase());
    }

    const projectCache = new Map<string, Project | null>();
    const seenInBatch = new Set<string>(); // `${projectId}:${code}` claimed earlier in this same file
    const results: InventoryImportRowPreview[] = [];

    for (let idx = 0; idx < mappedRows.length; idx++) {
      const row = idx + 1;
      const raw = mappedRows[idx]!;
      const issues: string[] = [];

      const projectName = raw.projectName?.trim();
      let unitCode = raw.unitCode?.trim();
      const unitType = raw.unitType?.trim();
      const areaSqm = resolveRangeValue(raw.areaSqm, raw.areaSqmFrom, raw.areaSqmTo, rangeStrategy);
      const listPrice = resolveRangeValue(raw.listPrice, raw.listPriceFrom, raw.listPriceTo, rangeStrategy);

      if (!projectName) issues.push('"Project" is required');
      if (!unitCode && !options.autoGenerateUnitCode) issues.push('"Unit Code" is required');
      if (!unitType) issues.push('"Unit Type" is required');
      if (!Number.isFinite(areaSqm) || areaSqm <= 0) issues.push('"Area (sqm)" must be a positive number');
      if (!Number.isFinite(listPrice) || listPrice <= 0) issues.push('"List Price" must be a positive number');

      if (issues.length > 0) {
        results.push({ row, status: 'invalid', issues, raw });
        continue;
      }

      const infoNotes: string[] = [];
      const project = await this.resolveProject(companyId, projectName!, projectCache);
      let projectKey: string;
      let resolvedProjectName: string;
      if (project) {
        projectKey = project.id;
        resolvedProjectName = project.name;
      } else if (options.autoCreateMissingProjects) {
        projectKey = PENDING_PROJECT_PREFIX + projectName!.toLowerCase();
        resolvedProjectName = projectName!;
        infoNotes.push(`will create new project "${projectName}"`);
      } else {
        results.push({ row, status: 'invalid', issues: [`project "${projectName}" not found — create it first, then re-import`], raw });
        continue;
      }

      if (!unitCode && options.autoGenerateUnitCode) {
        if (!usedCodesByProjectKey.has(projectKey)) usedCodesByProjectKey.set(projectKey, new Set());
        const used = usedCodesByProjectKey.get(projectKey)!;
        const base = `${slugify(resolvedProjectName)}-${slugify(unitType || 'unit')}`;
        let n = 1;
        let candidate = `${base}-${n}`;
        while (used.has(candidate.toLowerCase())) {
          n += 1;
          candidate = `${base}-${n}`;
        }
        unitCode = candidate;
        used.add(candidate.toLowerCase());
        infoNotes.push(`unit code auto-generated: "${candidate}"`);
      }

      const key = `${projectKey}:${unitCode!.toLowerCase()}`;
      if (seenInBatch.has(key)) {
        results.push({ row, status: 'conflict', issues: ['another row in this same file already targets this unit'], raw });
        continue;
      }

      const existing = project ? unitByProjectAndCode.get(key) : undefined;
      if (existing && existing.status !== 'available') {
        results.push({
          row,
          status: 'conflict',
          issues: [`unit "${unitCode}" is currently ${existing.status} — protected from import (never auto-changed by a bulk import)`],
          raw,
        });
        continue;
      }

      seenInBatch.add(key);
      results.push({
        row,
        status: 'valid',
        issues: infoNotes,
        raw,
        resolved: {
          action: existing ? 'update' : 'create',
          projectId: projectKey,
          projectName: resolvedProjectName,
          unitCode: unitCode!,
          unitType: unitType!,
          areaSqm,
          listPrice,
          existingUnitId: existing?.id,
        },
      });
    }

    return results;
  }

  async buildPreview(companyId: string, mappedRows: Record<string, string>[], options?: InventoryImportOptions): Promise<InventoryImportPreview> {
    const rows = await this.evaluateRows(companyId, mappedRows, options);
    return {
      rows,
      totalRows: rows.length,
      validCount: rows.filter((r) => r.status === 'valid').length,
      conflictCount: rows.filter((r) => r.status === 'conflict').length,
      invalidCount: rows.filter((r) => r.status === 'invalid').length,
    };
  }

  async importRows(
    companyId: string,
    mappedRows: Record<string, string>[],
    onWritten: (unit: Unit, action: InventoryImportRowAction) => Promise<void>,
    options?: InventoryImportOptions,
  ): Promise<InventoryImportResult> {
    const evaluated = await this.evaluateRows(companyId, mappedRows, options);
    const createdProjects = new Map<string, Project>(); // pending-project key -> the real Project just created for it
    const results: InventoryImportRowResult[] = [];
    for (const row of evaluated) {
      if (row.status !== 'valid') {
        results.push({ row: row.row, status: 'skipped', reason: row.issues.join('; ') });
        continue;
      }
      const resolved = row.resolved!;
      try {
        let projectId = resolved.projectId;
        if (projectId.startsWith(PENDING_PROJECT_PREFIX)) {
          let created = createdProjects.get(projectId);
          if (!created) {
            created = await this.inventory.createProject({ companyId, name: resolved.projectName });
            createdProjects.set(projectId, created);
          }
          projectId = created.id;
        }

        let unit: Unit;
        if (resolved.action === 'create') {
          unit = await this.inventory.createUnit({
            companyId,
            projectId,
            code: resolved.unitCode,
            unitType: resolved.unitType,
            areaSqm: resolved.areaSqm,
            listPrice: resolved.listPrice,
          });
        } else {
          unit = await this.inventory.updateUnitDetails(resolved.existingUnitId!, companyId, {
            unitType: resolved.unitType,
            areaSqm: resolved.areaSqm,
            listPrice: resolved.listPrice,
          });
        }
        await onWritten(unit, resolved.action);
        results.push({ row: row.row, status: resolved.action === 'create' ? 'created' : 'updated', unitId: unit.id });
      } catch (err) {
        results.push({ row: row.row, status: 'error', reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return {
      total: results.length,
      succeeded: results.filter((r) => r.status === 'created' || r.status === 'updated').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      failed: results.filter((r) => r.status === 'error').length,
      results,
    };
  }
}
