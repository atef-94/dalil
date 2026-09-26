import type { DeliveryInfo, Project, ProjectUnitSpec, Unit, UnitStatus } from '../../domain/types.js';
import type { ImportFieldDef } from '../../infra/field-mapping.js';
import { parseBedrooms, parseCurrencyNumber, parseDeliveryInfo, parsePercent, normalizeFinishing, normalizeAvailabilityStatus, splitList } from '../../infra/import-normalize.js';
import type { CreateProjectUnitSpecInput, InventoryService, UpdateProjectDetailsInput, UpdateUnitDetailsInput } from './inventory.service.js';

/**
 * The Inventory Import field dictionary — covers both Unit-level columns
 * (one value per row) and Project-level columns (a developer export
 * typically repeats the same project info on every row belonging to that
 * project; a project's fields are refreshed from whichever row supplies
 * them, non-destructively — see InventoryImportService.importRows).
 *
 * Field keys that already mapped onto real Unit columns before this pass
 * (projectName/unitCode/unitType/areaSqm/listPrice and their From/To
 * fallbacks) are unchanged, so no previously-working mapping/import breaks.
 * "Unit Gross Area" is deliberately an alias of the existing `areaSqm`
 * field rather than a new one — same concept (BUA), reused per the "don't
 * duplicate a semantically equivalent field" instruction.
 */
export const INVENTORY_IMPORT_FIELDS: ImportFieldDef[] = [
  // Unit identity (existing) — alias lists deliberately wide: the single
  // biggest cause of an import falling back to manual mapping is a
  // required column's header just not being in this list yet. Every
  // addition here was checked with scripts/check-import-aliases.mjs
  // against a battery of realistic headers to confirm it introduces no
  // new ambiguity (two fields both claiming the same header, which
  // suggestMapping correctly refuses to guess and leaves unmapped).
  {
    key: 'projectName',
    label: 'Project',
    aliases: ['project name', 'project id', 'compound', 'compound name', 'development', 'development name', 'اسم المشروع', 'المشروع', 'الكمبوند', 'اسم الكمبوند', 'كمبوند'],
    required: true,
  },
  {
    key: 'unitCode',
    label: 'Unit Code',
    aliases: ['unit', 'unit number', 'unit no', 'unit id', 'unit ref', 'reference no', 'apartment number', 'apt no', 'رقم الوحدة', 'كود الوحدة', 'رقم العقار', 'رقم الشقة'],
    required: true,
    // A missing Unit Code column is still auto-importable when
    // autoGenerateUnitCode is on (evaluateRows() generates one) — the only
    // required field with a real fallback, so it's the only one allowed
    // to waive the "every required field must be mapped" gate on the
    // Import Wizard's auto-skip-mapping check.
    autoFallbackOptionKey: 'autoGenerateUnitCode',
  },
  {
    key: 'unitType',
    label: 'Unit Type',
    aliases: ['type', 'property type', 'unit category', 'نوع الوحدة', 'نوع العقار'],
    required: true,
  },
  {
    key: 'areaSqm',
    label: 'Area (sqm)',
    aliases: [
      'area', 'size', 'area sqm', 'area m2', 'total area', 'sqm', 'sq m', 'sq.m', 'bua', 'built up area', 'built-up area', 'unit gross area', 'gross area',
      'مساحة الوحدة', 'مساحة المباني', 'المساحة', 'مساحة الوحده',
    ],
    required: true,
  },
  {
    key: 'listPrice',
    label: 'List Price',
    aliases: ['price', 'total price', 'total unit price', 'unit price', 'selling price', 'unit value', 'price egp', 'السعر', 'إجمالي السعر', 'السعر الإجمالي', 'قيمة الوحدة'],
    required: true,
  },
  { key: 'areaSqmFrom', label: 'Area (sqm) — From', aliases: ['area from', 'bua from', 'size from'] },
  { key: 'areaSqmTo', label: 'Area (sqm) — To', aliases: ['area to', 'bua to', 'size to'] },
  { key: 'listPriceFrom', label: 'List Price — From', aliases: ['price from', 'total price from'] },
  { key: 'listPriceTo', label: 'List Price — To', aliases: ['price to', 'total price to'] },

  // Unit-level (new)
  { key: 'floorLabel', label: 'Floor', aliases: ['floor number', 'الدور'] },
  { key: 'bedrooms', label: 'No of Bedrooms', aliases: ['bedrooms', 'beds', 'br', 'no of beds', 'عدد الغرف', 'غرف النوم'] },
  { key: 'designType', label: 'Design Type', aliases: ['design', 'model type', 'نوع التصميم'] },
  { key: 'view', label: 'View', aliases: ['unit view', 'الاطلالة', 'إطلالة'] },
  { key: 'unitGardenAreaSqm', label: 'Garden Area', aliases: ['garden', 'garden area sqm', 'حديقة', 'مساحة الحديقة'] },
  { key: 'buildingLabel', label: 'Building', aliases: ['block', 'المبنى', 'البلوك'] },
  { key: 'finishingType', label: 'Finishing Type', aliases: ['finishing', 'finish', 'تشطيب', 'نوع التشطيب'] },
  { key: 'deliveryDate', label: 'Delivery Date', aliases: ['delivery', 'handover', 'handover date', 'تاريخ التسليم', 'التسليم'] },
  { key: 'pricePerMeter', label: 'Price Per Meter', aliases: ['price/m2', 'price per sqm', 'price per meter', 'سعر المتر'] },
  { key: 'phaseName', label: 'Phase', aliases: ['project phase', 'المرحلة'] },
  {
    key: 'availabilityStatus',
    label: 'Status',
    aliases: ['availability status', 'availability', 'unit status', 'الحالة', 'حالة الوحدة', 'حالة التوفر'],
  },

  // Project-level (new) — repeated per row for that row's project; applied
  // to the Project, never stored per-unit.
  { key: 'destination', label: 'Destination', aliases: ['market', 'الوجهة'] },
  { key: 'developerName', label: 'Developer', aliases: ['developer name', 'المطور'] },
  { key: 'locationMapUrl', label: 'Location On Map', aliases: ['map url', 'google maps', 'موقع', 'الموقع على الخريطة'] },
  { key: 'projectAddress', label: 'Address', aliases: ['location description', 'العنوان'] },
  { key: 'projectLandFrom', label: 'Land From', aliases: ['land area from', 'أرض من'] },
  { key: 'projectLandTo', label: 'Land To', aliases: ['land area to', 'أرض إلى'] },
  { key: 'projectBuaFrom', label: 'Project BUA From', aliases: ['bua range from', 'مساحة مبنية من'] },
  { key: 'projectBuaTo', label: 'Project BUA To', aliases: ['bua range to', 'مساحة مبنية إلى'] },
  { key: 'projectGardenFrom', label: 'Project Garden Area From', aliases: ['garden range from'] },
  { key: 'projectGardenTo', label: 'Project Garden Area To', aliases: ['garden range to'] },
  // Labels are "Project Price From/To" (not the shorter "Price From/To")
  // deliberately — that shorter form collides with listPriceFrom/To's own
  // "price from"/"price to" alias, which would otherwise silently steal a
  // project-level price-range column into the unit-level field.
  { key: 'projectPriceFrom', label: 'Project Price From', aliases: ['project price from', 'السعر من'] },
  { key: 'projectPriceTo', label: 'Project Price To', aliases: ['project price to', 'السعر إلى'] },
  { key: 'projectFinishingType', label: 'Project Finishing Type', aliases: ['default finishing'] },
  { key: 'projectAreaSqm', label: 'Project Area', aliases: ['project total area', 'مساحة المشروع'] },
  { key: 'typeOfUnits', label: 'Type of Units', aliases: ['unit types', 'أنواع الوحدات'] },
  { key: 'facilities', label: 'Facilities', aliases: ['amenities', 'المرافق', 'الخدمات'] },
  { key: 'engineeringConsultant', label: 'Engineering Consultant', aliases: ['consultant', 'الاستشاري الهندسي'] },
  { key: 'projectManagementCompany', label: 'Project Management', aliases: ['pm company', 'إدارة المشروع'] },
  { key: 'ministerialDecisionNumber', label: 'قرار وزاري', aliases: ['ministerial decision', 'decision number'] },
  { key: 'salesDirectPhone', label: 'Sales Direct Phone Number', aliases: ['direct phone', 'sales phone', 'رقم هاتف المبيعات المباشر', 'رقم المبيعات'] },
  { key: 'cashDiscount', label: 'Cash Discount', aliases: ['discount', 'خصم الكاش', 'الخصم النقدي'] },
  { key: 'maintenanceFeePercent', label: 'Maintenance Fees %', aliases: ['maintenance', 'رسوم الصيانة'] },
  { key: 'paymentPlan', label: 'Payment Plan', aliases: ['payment plans', 'خطة السداد'] },
];

/**
 * Two derived subsets of the one shared INVENTORY_IMPORT_FIELDS list, used
 * only for sheet classification (see classifySheet in field-mapping.ts) —
 * the mapping engine itself always uses the one full dictionary above
 * regardless of which sheet kind is detected, so a column never resolves
 * differently depending on classification. "Catalog" fields identify a
 * project/market range row (no physical unit identity); "availability"
 * fields identify a physical, individually-coded unit row. A few fields
 * (unitType, bedrooms, finishingType, pricePerMeter) are genuinely shared
 * vocabulary and appear in both subsets.
 */
const CATALOG_FIELD_KEYS = new Set([
  'projectName', 'developerName', 'phaseName', 'unitType', 'bedrooms', 'destination',
  'projectLandFrom', 'projectLandTo', 'projectBuaFrom', 'projectBuaTo',
  'projectGardenFrom', 'projectGardenTo', 'projectPriceFrom', 'projectPriceTo',
  'pricePerMeter', 'projectFinishingType', 'finishingType', 'deliveryDate',
  'cashDiscount', 'maintenanceFeePercent', 'paymentPlan',
]);
const AVAILABILITY_FIELD_KEYS = new Set([
  'projectName', 'unitCode', 'floorLabel', 'buildingLabel', 'unitType', 'bedrooms',
  'areaSqm', 'areaSqmFrom', 'areaSqmTo', 'listPrice', 'listPriceFrom', 'listPriceTo',
  'availabilityStatus', 'designType', 'view', 'unitGardenAreaSqm', 'pricePerMeter', 'phaseName',
]);
/** The field(s) that give a row real identity in each mode — see
 * classifySheet's own doc comment for why an anchor match is required
 * before a dictionary "claims" a sheet. */
export const CATALOG_ANCHOR_KEYS = ['projectName', 'developerName'];
export const AVAILABILITY_ANCHOR_KEYS = ['unitCode'];

export const CATALOG_IMPORT_FIELDS: ImportFieldDef[] = INVENTORY_IMPORT_FIELDS.filter((f) => CATALOG_FIELD_KEYS.has(f.key));
export const AVAILABILITY_IMPORT_FIELDS: ImportFieldDef[] = INVENTORY_IMPORT_FIELDS.filter((f) => AVAILABILITY_FIELD_KEYS.has(f.key));

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
    const n = parseCurrencyNumber(v);
    return n !== undefined && n > 0 ? n : undefined;
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

/** Parsed unit-level fields beyond the original 5 core ones — every field
 * optional since a row may not carry all of them. */
export interface ResolvedUnitExtra {
  phaseName?: string;
  floorLabel?: string;
  bedrooms?: number;
  designType?: string;
  view?: string[];
  gardenAreaSqm?: number;
  buildingLabel?: string;
  finishingType?: string;
  delivery?: DeliveryInfo;
  pricePerMeterOverride?: number;
  /** Set only when the row's status column value normalized successfully —
   * see normalizeAvailabilityStatus. Absent when there was no status
   * column value, or when it was present but unrecognized (in which case
   * evaluateRows adds an informational issue instead of guessing). */
  status?: UnitStatus;
  sourceStatus?: string;
}

/** Parsed project-level fields a row may carry — applied to the row's
 * resolved Project (never per-unit), non-destructively. */
export interface ResolvedProjectExtra {
  destination?: string;
  developerName?: string;
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
  finishingType?: string;
  projectAreaSqm?: number;
  typeOfUnits?: string[];
  facilityNames?: string[];
  engineeringConsultantName?: string;
  projectManagementName?: string;
  ministerialDecisionNumber?: string;
  salesDirectPhone?: string;
  cashDiscountPercent?: number;
  maintenanceFeePercent?: number;
  pricePerMeter?: number;
}

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
    unitExtra: ResolvedUnitExtra;
    projectExtra: ResolvedProjectExtra;
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

// ---- Project Catalog import (ProjectUnitSpec rows, not physical Units) ----
// A parallel, much simpler evaluate/preview/import trio for catalog rows —
// there is no unit-code identity, no conflict/protection state, and no
// dedup-vs-create branching to compute up front (resolveProjectUnitSpec
// already finds-or-updates by natural key), so this deliberately does not
// mirror every step of the Unit path above.

/** Parsed catalog-row fields — reuses the exact same raw column keys the
 * Unit-level importer's own project-level columns already parse
 * (projectBuaFrom/To etc.), just applied to a ProjectUnitSpec's own range
 * instead of patching the Project's single project-wide range. */
export interface ResolvedProjectUnitSpecExtra {
  phaseName?: string;
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
  cashDiscountPercent?: number;
  maintenanceFeePercent?: number;
}

export interface ProjectUnitSpecImportRowPreview {
  row: number;
  status: 'valid' | 'invalid';
  issues: string[];
  raw: Record<string, string>;
  resolved?: {
    projectId: string;
    projectName: string;
    unitType: string;
    bedrooms?: number;
    extra: ResolvedProjectUnitSpecExtra;
  };
}

export interface ProjectUnitSpecImportPreview {
  rows: ProjectUnitSpecImportRowPreview[];
  totalRows: number;
  validCount: number;
  invalidCount: number;
}

export interface ProjectUnitSpecImportRowResult {
  row: number;
  status: 'created' | 'updated' | 'skipped' | 'error';
  specId?: string;
  reason?: string;
}

export interface ProjectUnitSpecImportResult {
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
  results: ProjectUnitSpecImportRowResult[];
}

/**
 * Validates and resolves Inventory Import rows and drives the actual
 * write — one row, one InventoryService.createUnit() or
 * updateUnitDetails() call for the unit, plus a non-destructive
 * InventoryService.updateProjectDetails() call for whatever project-level
 * columns that row also carries, so imported units/projects still only
 * ever get written through those real, validated code paths. A row
 * matching an existing unit code is a create only when no such unit
 * exists yet; when one does, it's an update if the unit is still
 * 'available' and a protected conflict otherwise — a sold/reserved/
 * contracted unit's data (and the real financial relationship depending
 * on it) is never touched by an import, matching updateUnitDetails()'s own
 * guarantee.
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

  private parseUnitExtra(raw: Record<string, string>): ResolvedUnitExtra {
    return {
      phaseName: raw.phaseName?.trim() || undefined,
      floorLabel: raw.floorLabel?.trim() || undefined,
      bedrooms: parseBedrooms(raw.bedrooms),
      designType: raw.designType?.trim() || undefined,
      view: splitList(raw.view).length ? splitList(raw.view) : undefined,
      gardenAreaSqm: parseCurrencyNumber(raw.unitGardenAreaSqm),
      buildingLabel: raw.buildingLabel?.trim() || undefined,
      finishingType: normalizeFinishing(raw.finishingType),
      delivery: parseDeliveryInfo(raw.deliveryDate),
      pricePerMeterOverride: parseCurrencyNumber(raw.pricePerMeter),
    };
  }

  private parseProjectExtra(raw: Record<string, string>): ResolvedProjectExtra {
    return {
      destination: raw.destination?.trim() || undefined,
      developerName: raw.developerName?.trim() || undefined,
      locationMapUrl: raw.locationMapUrl?.trim() || undefined,
      address: raw.projectAddress?.trim() || undefined,
      landAreaFromSqm: parseCurrencyNumber(raw.projectLandFrom),
      landAreaToSqm: parseCurrencyNumber(raw.projectLandTo),
      buaFromSqm: parseCurrencyNumber(raw.projectBuaFrom),
      buaToSqm: parseCurrencyNumber(raw.projectBuaTo),
      gardenAreaFromSqm: parseCurrencyNumber(raw.projectGardenFrom),
      gardenAreaToSqm: parseCurrencyNumber(raw.projectGardenTo),
      priceFrom: parseCurrencyNumber(raw.projectPriceFrom),
      priceTo: parseCurrencyNumber(raw.projectPriceTo),
      finishingType: normalizeFinishing(raw.projectFinishingType),
      projectAreaSqm: parseCurrencyNumber(raw.projectAreaSqm),
      typeOfUnits: splitList(raw.typeOfUnits).length ? splitList(raw.typeOfUnits) : undefined,
      facilityNames: splitList(raw.facilities).length ? splitList(raw.facilities) : undefined,
      engineeringConsultantName: raw.engineeringConsultant?.trim() || undefined,
      projectManagementName: raw.projectManagementCompany?.trim() || undefined,
      ministerialDecisionNumber: raw.ministerialDecisionNumber?.trim() || undefined,
      salesDirectPhone: raw.salesDirectPhone?.trim() || undefined,
      cashDiscountPercent: parsePercent(raw.cashDiscount),
      maintenanceFeePercent: parsePercent(raw.maintenanceFeePercent),
      pricePerMeter: parseCurrencyNumber(raw.pricePerMeter),
    };
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
      const unitExtra = this.parseUnitExtra(raw);
      const projectExtra = this.parseProjectExtra(raw);

      const statusResult = normalizeAvailabilityStatus(raw.availabilityStatus);
      if (statusResult && 'unknown' in statusResult) {
        issues.push(`"Status" value "${statusResult.unknown}" is not recognized — informational only, left unchanged`);
      } else if (statusResult) {
        unitExtra.status = statusResult.status;
        unitExtra.sourceStatus = statusResult.sourceStatus;
      }

      if (!projectName) issues.push('"Project" is required');
      if (!unitCode && !options.autoGenerateUnitCode) issues.push('"Unit Code" is required');
      if (!unitType) issues.push('"Unit Type" is required');
      if (!Number.isFinite(areaSqm) || areaSqm <= 0) issues.push('"Area (sqm)" must be a positive number');
      if (!Number.isFinite(listPrice) || listPrice <= 0) issues.push('"List Price" must be a positive number');
      if (unitExtra.gardenAreaSqm !== undefined && unitExtra.gardenAreaSqm < 0) issues.push('"Garden Area" must be >= 0');
      if (unitExtra.bedrooms !== undefined && unitExtra.bedrooms < 0) issues.push('"No of Bedrooms" must be >= 0');
      if (projectExtra.cashDiscountPercent !== undefined && (projectExtra.cashDiscountPercent < 0 || projectExtra.cashDiscountPercent > 100)) {
        issues.push('"Cash Discount" must be between 0 and 100');
      }
      if (projectExtra.maintenanceFeePercent !== undefined && (projectExtra.maintenanceFeePercent < 0 || projectExtra.maintenanceFeePercent > 100)) {
        issues.push('"Maintenance Fees %" must be between 0 and 100');
      }
      if (raw.paymentPlan?.trim()) {
        issues.push('"Payment Plan" text was provided but is informational only — create a structured Payment Plan Template separately (see Payment Plans)');
      }

      if (issues.some((i) => !i.includes('informational only'))) {
        results.push({ row, status: 'invalid', issues, raw });
        continue;
      }

      const infoNotes = issues; // the only issues left at this point are informational
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
          unitExtra,
          projectExtra,
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

  /** Resolves a row's project-level extras into a real, non-destructive
   * updateProjectDetails() patch — resolving/creating Developer/Facility/
   * Consultant rows by name along the way. Applied once per valid row that
   * carries project-level data; harmless when repeated across many rows
   * for the same project since every write is non-destructive merge. */
  private async applyProjectExtra(companyId: string, projectId: string, extra: ResolvedProjectExtra): Promise<void> {
    const patch: UpdateProjectDetailsInput = {};
    if (extra.destination) patch.destination = extra.destination;
    if (extra.locationMapUrl) patch.locationMapUrl = extra.locationMapUrl;
    if (extra.address) patch.address = extra.address;
    if (extra.landAreaFromSqm !== undefined) patch.landAreaFromSqm = extra.landAreaFromSqm;
    if (extra.landAreaToSqm !== undefined) patch.landAreaToSqm = extra.landAreaToSqm;
    if (extra.buaFromSqm !== undefined) patch.buaFromSqm = extra.buaFromSqm;
    if (extra.buaToSqm !== undefined) patch.buaToSqm = extra.buaToSqm;
    if (extra.gardenAreaFromSqm !== undefined) patch.gardenAreaFromSqm = extra.gardenAreaFromSqm;
    if (extra.gardenAreaToSqm !== undefined) patch.gardenAreaToSqm = extra.gardenAreaToSqm;
    if (extra.priceFrom !== undefined) patch.priceFrom = extra.priceFrom;
    if (extra.priceTo !== undefined) patch.priceTo = extra.priceTo;
    if (extra.finishingType) patch.finishingType = extra.finishingType;
    if (extra.projectAreaSqm !== undefined) patch.projectAreaSqm = extra.projectAreaSqm;
    if (extra.typeOfUnits) patch.typeOfUnits = extra.typeOfUnits;
    if (extra.ministerialDecisionNumber) patch.ministerialDecisionNumber = extra.ministerialDecisionNumber;
    if (extra.cashDiscountPercent !== undefined) patch.cashDiscountPercent = extra.cashDiscountPercent;
    if (extra.maintenanceFeePercent !== undefined) patch.maintenanceFeePercent = extra.maintenanceFeePercent;
    // Explicit developer-supplied price/m2 is preserved as the 'developer'
    // source and never overwritten by a later computed value.
    if (extra.pricePerMeter !== undefined) {
      patch.pricePerMeter = extra.pricePerMeter;
      patch.pricePerMeterSource = 'developer';
    }

    if (extra.developerName) {
      patch.developerId = (await this.inventory.resolveOrCreateDeveloper(companyId, extra.developerName)).id;
    }
    if (extra.engineeringConsultantName) {
      patch.engineeringConsultantId = (await this.inventory.resolveOrCreateConsultant(companyId, extra.engineeringConsultantName, 'engineering')).id;
    }
    if (extra.projectManagementName) {
      patch.projectManagementId = (await this.inventory.resolveOrCreateConsultant(companyId, extra.projectManagementName, 'project_management')).id;
    }
    if (extra.facilityNames?.length) {
      const project = await this.inventory.getProject(projectId);
      const existingIds = new Set(project?.facilityIds ?? []);
      for (const name of extra.facilityNames) {
        const facility = await this.inventory.resolveOrCreateFacility(companyId, name);
        existingIds.add(facility.id);
      }
      patch.facilityIds = Array.from(existingIds);
    }

    if (Object.keys(patch).length > 0) {
      await this.inventory.updateProjectDetails(projectId, companyId, patch);
    }

    if (extra.salesDirectPhone) {
      const existingPhones = await this.inventory.listSalesPhoneNumbers(companyId, projectId);
      if (!existingPhones.some((p) => p.phoneNumber === extra.salesDirectPhone)) {
        await this.inventory.createSalesPhoneNumber({ companyId, projectId, phoneNumber: extra.salesDirectPhone, source: 'import' });
      }
    }
  }

  private async resolveUnitExtraIds(companyId: string, projectId: string, extra: ResolvedUnitExtra): Promise<{ phaseId?: string }> {
    if (!extra.phaseName) return {};
    const existing = await this.inventory.listProjectPhases(companyId, projectId);
    const match = existing.find((p) => p.name.toLowerCase() === extra.phaseName!.toLowerCase());
    if (match) return { phaseId: match.id };
    const created = await this.inventory.createProjectPhase({ companyId, projectId, name: extra.phaseName, order: existing.length });
    return { phaseId: created.id };
  }

  async importRows(
    companyId: string,
    mappedRows: Record<string, string>[],
    onWritten: (unit: Unit, action: InventoryImportRowAction) => Promise<void>,
    options?: InventoryImportOptions,
    provenance?: { sourceImportId?: string; sourceSheet?: string },
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

        await this.applyProjectExtra(companyId, projectId, resolved.projectExtra);
        const { phaseId } = await this.resolveUnitExtraIds(companyId, projectId, resolved.unitExtra);
        const rowProvenance = { sourceImportId: provenance?.sourceImportId, sourceSheet: provenance?.sourceSheet, sourceRow: row.row };

        let unit: Unit;
        if (resolved.action === 'create') {
          unit = await this.inventory.createUnit({
            companyId,
            projectId,
            phaseId,
            code: resolved.unitCode,
            unitType: resolved.unitType,
            areaSqm: resolved.areaSqm,
            listPrice: resolved.listPrice,
            floorLabel: resolved.unitExtra.floorLabel,
            bedrooms: resolved.unitExtra.bedrooms,
            designType: resolved.unitExtra.designType,
            view: resolved.unitExtra.view,
            gardenAreaSqm: resolved.unitExtra.gardenAreaSqm,
            buildingLabel: resolved.unitExtra.buildingLabel,
            finishingType: resolved.unitExtra.finishingType,
            delivery: resolved.unitExtra.delivery,
            pricePerMeterOverride: resolved.unitExtra.pricePerMeterOverride,
            initialStatus: resolved.unitExtra.status,
            sourceStatus: resolved.unitExtra.sourceStatus,
            ...rowProvenance,
          });
        } else {
          const updates: UpdateUnitDetailsInput = {
            unitType: resolved.unitType,
            areaSqm: resolved.areaSqm,
            listPrice: resolved.listPrice,
            ...rowProvenance,
          };
          if (phaseId) updates.phaseId = phaseId;
          if (resolved.unitExtra.floorLabel) updates.floorLabel = resolved.unitExtra.floorLabel;
          if (resolved.unitExtra.bedrooms !== undefined) updates.bedrooms = resolved.unitExtra.bedrooms;
          if (resolved.unitExtra.designType) updates.designType = resolved.unitExtra.designType;
          if (resolved.unitExtra.view) updates.view = resolved.unitExtra.view;
          if (resolved.unitExtra.gardenAreaSqm !== undefined) updates.gardenAreaSqm = resolved.unitExtra.gardenAreaSqm;
          if (resolved.unitExtra.buildingLabel) updates.buildingLabel = resolved.unitExtra.buildingLabel;
          if (resolved.unitExtra.finishingType) updates.finishingType = resolved.unitExtra.finishingType;
          if (resolved.unitExtra.delivery) updates.delivery = resolved.unitExtra.delivery;
          if (resolved.unitExtra.pricePerMeterOverride !== undefined) updates.pricePerMeterOverride = resolved.unitExtra.pricePerMeterOverride;
          unit = await this.inventory.updateUnitDetails(resolved.existingUnitId!, companyId, updates);
          // A recognized status differing from the unit's current one is a
          // separate, narrower write (see updateUnitAvailabilityFromImport)
          // — it goes through its own active-hold/reservation protection
          // rather than updateUnitDetails's blanket "must already be
          // available" gate, since the whole point is syncing a status
          // change (e.g. available -> sold) the source file just reported.
          if (resolved.unitExtra.status && resolved.unitExtra.status !== unit.status) {
            unit = await this.inventory.updateUnitAvailabilityFromImport(
              unit.id,
              companyId,
              resolved.unitExtra.status,
              resolved.unitExtra.sourceStatus!,
              rowProvenance,
            );
          }
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

  private parseProjectUnitSpecExtra(raw: Record<string, string>): ResolvedProjectUnitSpecExtra {
    return {
      phaseName: raw.phaseName?.trim() || undefined,
      landAreaFromSqm: parseCurrencyNumber(raw.projectLandFrom),
      landAreaToSqm: parseCurrencyNumber(raw.projectLandTo),
      buaFromSqm: parseCurrencyNumber(raw.projectBuaFrom),
      buaToSqm: parseCurrencyNumber(raw.projectBuaTo),
      gardenAreaFromSqm: parseCurrencyNumber(raw.projectGardenFrom),
      gardenAreaToSqm: parseCurrencyNumber(raw.projectGardenTo),
      priceFrom: parseCurrencyNumber(raw.projectPriceFrom),
      priceTo: parseCurrencyNumber(raw.projectPriceTo),
      pricePerMeter: parseCurrencyNumber(raw.pricePerMeter),
      finishingType: normalizeFinishing(raw.projectFinishingType || raw.finishingType),
      delivery: parseDeliveryInfo(raw.deliveryDate),
      cashDiscountPercent: parsePercent(raw.cashDiscount),
      maintenanceFeePercent: parsePercent(raw.maintenanceFeePercent),
    };
  }

  private async evaluateProjectUnitSpecRows(
    companyId: string,
    mappedRows: Record<string, string>[],
    options: InventoryImportOptions = {},
  ): Promise<ProjectUnitSpecImportRowPreview[]> {
    const projectCache = new Map<string, Project | null>();
    const results: ProjectUnitSpecImportRowPreview[] = [];

    for (let idx = 0; idx < mappedRows.length; idx++) {
      const row = idx + 1;
      const raw = mappedRows[idx]!;
      const issues: string[] = [];

      const projectName = raw.projectName?.trim();
      const unitType = raw.unitType?.trim();
      const bedrooms = parseBedrooms(raw.bedrooms);
      const extra = this.parseProjectUnitSpecExtra(raw);

      if (!projectName) issues.push('"Project" is required');
      if (!unitType) issues.push('"Unit Type" is required');
      if (extra.cashDiscountPercent !== undefined && (extra.cashDiscountPercent < 0 || extra.cashDiscountPercent > 100)) {
        issues.push('"Cash Discount" must be between 0 and 100');
      }
      if (extra.maintenanceFeePercent !== undefined && (extra.maintenanceFeePercent < 0 || extra.maintenanceFeePercent > 100)) {
        issues.push('"Maintenance Fees %" must be between 0 and 100');
      }
      for (const [label, value] of [
        ['Land Area', extra.landAreaFromSqm], ['Land Area', extra.landAreaToSqm],
        ['Project BUA', extra.buaFromSqm], ['Project BUA', extra.buaToSqm],
        ['Garden Area', extra.gardenAreaFromSqm], ['Garden Area', extra.gardenAreaToSqm],
        ['Price', extra.priceFrom], ['Price', extra.priceTo],
      ] as [string, number | undefined][]) {
        if (value !== undefined && value < 0) issues.push(`"${label}" must be >= 0`);
      }

      if (issues.length > 0) {
        results.push({ row, status: 'invalid', issues, raw });
        continue;
      }

      const project = await this.resolveProject(companyId, projectName!, projectCache);
      if (!project && !options.autoCreateMissingProjects) {
        results.push({ row, status: 'invalid', issues: [`project "${projectName}" not found — create it first, then re-import`], raw });
        continue;
      }

      results.push({
        row,
        status: 'valid',
        issues: [],
        raw,
        resolved: {
          projectId: project ? project.id : PENDING_PROJECT_PREFIX + projectName!.toLowerCase(),
          projectName: project ? project.name : projectName!,
          unitType: unitType!,
          bedrooms,
          extra,
        },
      });
    }

    return results;
  }

  async buildProjectUnitSpecPreview(
    companyId: string,
    mappedRows: Record<string, string>[],
    options?: InventoryImportOptions,
  ): Promise<ProjectUnitSpecImportPreview> {
    const rows = await this.evaluateProjectUnitSpecRows(companyId, mappedRows, options);
    return {
      rows,
      totalRows: rows.length,
      validCount: rows.filter((r) => r.status === 'valid').length,
      invalidCount: rows.filter((r) => r.status === 'invalid').length,
    };
  }

  /** Writes each valid catalog row via InventoryService.resolveProjectUnitSpec
   * — find-or-update by natural key (project + phase + unitType +
   * bedrooms), so re-importing the same catalog file never creates
   * duplicate specs, it just refreshes the existing one's ranges. Never
   * creates a Unit: a catalog row has no physical identity (see this
   * module's own top-of-file comment). */
  async importProjectUnitSpecRows(
    companyId: string,
    mappedRows: Record<string, string>[],
    options?: InventoryImportOptions,
    provenance?: { sourceImportId?: string; sourceSheet?: string },
  ): Promise<ProjectUnitSpecImportResult> {
    const evaluated = await this.evaluateProjectUnitSpecRows(companyId, mappedRows, options);
    const createdProjects = new Map<string, Project>();
    const results: ProjectUnitSpecImportRowResult[] = [];

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

        const { phaseId } = resolved.extra.phaseName
          ? await this.resolveUnitExtraIds(companyId, projectId, { phaseName: resolved.extra.phaseName })
          : {};

        const specInput: CreateProjectUnitSpecInput = {
          companyId,
          projectId,
          phaseId,
          unitType: resolved.unitType,
          bedrooms: resolved.bedrooms,
          landAreaFromSqm: resolved.extra.landAreaFromSqm,
          landAreaToSqm: resolved.extra.landAreaToSqm,
          buaFromSqm: resolved.extra.buaFromSqm,
          buaToSqm: resolved.extra.buaToSqm,
          gardenAreaFromSqm: resolved.extra.gardenAreaFromSqm,
          gardenAreaToSqm: resolved.extra.gardenAreaToSqm,
          priceFrom: resolved.extra.priceFrom,
          priceTo: resolved.extra.priceTo,
          pricePerMeter: resolved.extra.pricePerMeter,
          finishingType: resolved.extra.finishingType,
          delivery: resolved.extra.delivery,
          cashDiscountPercent: resolved.extra.cashDiscountPercent,
          maintenanceFeePercent: resolved.extra.maintenanceFeePercent,
          sourceImportId: provenance?.sourceImportId,
          sourceSheet: provenance?.sourceSheet,
          sourceRow: row.row,
        };
        const existingBefore = await this.inventory.listProjectUnitSpecs(companyId, projectId);
        const spec = await this.inventory.resolveProjectUnitSpec(specInput);
        const wasExisting = existingBefore.some((s) => s.id === spec.id);
        results.push({ row: row.row, status: wasExisting ? 'updated' : 'created', specId: spec.id });
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
