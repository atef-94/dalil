import type { Project, Unit } from '../../domain/types.js';
import type { ImportFieldDef } from '../../infra/field-mapping.js';
import type { InventoryService } from './inventory.service.js';

/**
 * The explicit Inventory Import field dictionary. Only maps to real Unit
 * fields (code/unitType/areaSqm/listPrice) — the domain model has no
 * separate "floor"/"building"/"delivery date" fields today, so this
 * import never invents columns the rest of the system can't use.
 */
export const INVENTORY_IMPORT_FIELDS: ImportFieldDef[] = [
  { key: 'projectName', label: 'Project', aliases: ['project name'], required: true },
  { key: 'unitCode', label: 'Unit Code', aliases: ['unit', 'unit number', 'unit no'], required: true },
  { key: 'unitType', label: 'Unit Type', aliases: ['type'], required: true },
  { key: 'areaSqm', label: 'Area (sqm)', aliases: ['area', 'size', 'area sqm'], required: true },
  { key: 'listPrice', label: 'List Price', aliases: ['price', 'total price'], required: true },
];

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

  private async evaluateRows(companyId: string, mappedRows: Record<string, string>[]): Promise<InventoryImportRowPreview[]> {
    const existingUnits = await this.inventory.listUnits(companyId);
    const unitByProjectAndCode = new Map<string, Unit>();
    for (const u of existingUnits) unitByProjectAndCode.set(`${u.projectId}:${u.code.toLowerCase()}`, u);

    const projectCache = new Map<string, Project | null>();
    const seenInBatch = new Set<string>(); // `${projectId}:${code}` claimed earlier in this same file
    const results: InventoryImportRowPreview[] = [];

    for (let idx = 0; idx < mappedRows.length; idx++) {
      const row = idx + 1;
      const raw = mappedRows[idx]!;
      const issues: string[] = [];

      const projectName = raw.projectName?.trim();
      const unitCode = raw.unitCode?.trim();
      const unitType = raw.unitType?.trim();
      const areaSqm = Number((raw.areaSqm ?? '').replace(/,/g, ''));
      const listPrice = Number((raw.listPrice ?? '').replace(/,/g, ''));

      if (!projectName) issues.push('"Project" is required');
      if (!unitCode) issues.push('"Unit Code" is required');
      if (!unitType) issues.push('"Unit Type" is required');
      if (!Number.isFinite(areaSqm) || areaSqm <= 0) issues.push('"Area (sqm)" must be a positive number');
      if (!Number.isFinite(listPrice) || listPrice <= 0) issues.push('"List Price" must be a positive number');

      if (issues.length > 0) {
        results.push({ row, status: 'invalid', issues, raw });
        continue;
      }

      const project = await this.resolveProject(companyId, projectName!, projectCache);
      if (!project) {
        results.push({ row, status: 'invalid', issues: [`project "${projectName}" not found — create it first, then re-import`], raw });
        continue;
      }

      const key = `${project.id}:${unitCode!.toLowerCase()}`;
      if (seenInBatch.has(key)) {
        results.push({ row, status: 'conflict', issues: ['another row in this same file already targets this unit'], raw });
        continue;
      }

      const existing = unitByProjectAndCode.get(key);
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
        issues: [],
        raw,
        resolved: {
          action: existing ? 'update' : 'create',
          projectId: project.id,
          projectName: project.name,
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

  async buildPreview(companyId: string, mappedRows: Record<string, string>[]): Promise<InventoryImportPreview> {
    const rows = await this.evaluateRows(companyId, mappedRows);
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
  ): Promise<InventoryImportResult> {
    const evaluated = await this.evaluateRows(companyId, mappedRows);
    const results: InventoryImportRowResult[] = [];
    for (const row of evaluated) {
      if (row.status !== 'valid') {
        results.push({ row: row.row, status: 'skipped', reason: row.issues.join('; ') });
        continue;
      }
      const resolved = row.resolved!;
      try {
        let unit: Unit;
        if (resolved.action === 'create') {
          unit = await this.inventory.createUnit({
            companyId,
            projectId: resolved.projectId,
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
