import { randomUUID } from 'node:crypto';
import type { DocumentExtractedField, DocumentExtractionRun, DocumentExtractionStatus, DocumentFieldConfidence, DocumentKind } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError, ValidationError } from '../../infra/errors.js';
import { extractPdfPlainText } from '../../infra/pdf-parser.js';
import type { InventoryImportService, InventoryImportOptions, InventoryImportResult } from '../inventory/inventory-import.service.js';

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'bmp', 'tiff', 'webp']);

/** Fields that map onto InventoryImportService's own field dictionary
 * (INVENTORY_IMPORT_FIELDS) — the only ones confirmExtraction() can ever
 * actually import, since these are the ones the Unit domain model has real
 * columns for. Required: the import fails outright if any is missing/
 * uncorrected. Optional: included in the row when present and not
 * low-confidence-uncorrected, silently left out otherwise — their absence
 * never blocks the import. Everything else extracted below (customer/
 * broker/contract info, payment plan summary) is still captured and shown
 * to a reviewer, just never auto-mapped into a Unit at all. */
const REQUIRED_IMPORTABLE_KEYS = ['projectName', 'unitCode', 'unitType', 'areaSqm', 'listPrice'] as const;
const OPTIONAL_IMPORTABLE_KEYS = [
  'buildingLabel',
  'floorLabel',
  'finishingType',
  'deliveryDate',
  'bedrooms',
  'designType',
  'view',
  'unitGardenAreaSqm',
  'pricePerMeter',
  'phaseName',
] as const;

interface FieldSpec {
  key: string;
  labels: string[];
  kind: 'text' | 'number';
}

const FIELD_SPECS: FieldSpec[] = [
  { key: 'projectName', labels: ['project', 'project name', 'compound'], kind: 'text' },
  { key: 'unitCode', labels: ['unit no', 'unit number', 'unit code', 'unit'], kind: 'text' },
  { key: 'unitType', labels: ['unit type', 'type'], kind: 'text' },
  { key: 'buildingLabel', labels: ['building', 'block'], kind: 'text' },
  { key: 'floorLabel', labels: ['floor'], kind: 'text' },
  { key: 'areaSqm', labels: ['area (sqm)', 'area sqm', 'bua', 'area', 'size', 'unit gross area'], kind: 'number' },
  { key: 'listPrice', labels: ['total price', 'unit price', 'price'], kind: 'number' },
  { key: 'deliveryDate', labels: ['delivery date', 'handover date'], kind: 'text' },
  { key: 'finishingType', labels: ['finishing', 'finish', 'finishing type'], kind: 'text' },
  { key: 'bedrooms', labels: ['no of bedrooms', 'bedrooms', 'beds', 'br'], kind: 'number' },
  { key: 'designType', labels: ['design type', 'design', 'model type'], kind: 'text' },
  { key: 'view', labels: ['view', 'unit view'], kind: 'text' },
  { key: 'unitGardenAreaSqm', labels: ['garden area', 'garden'], kind: 'number' },
  { key: 'pricePerMeter', labels: ['price per meter', 'price/m2', 'price per sqm'], kind: 'number' },
  { key: 'phaseName', labels: ['phase', 'project phase'], kind: 'text' },
  { key: 'paymentPlanSummary', labels: ['payment plan', 'installments'], kind: 'text' },
  { key: 'customerName', labels: ['customer name', 'client name', 'buyer'], kind: 'text' },
  { key: 'customerPhone', labels: ['customer phone', 'phone', 'mobile'], kind: 'text' },
  { key: 'customerEmail', labels: ['email'], kind: 'text' },
  { key: 'brokerName', labels: ['broker', 'sales agent', 'agent'], kind: 'text' },
  { key: 'contractNumber', labels: ['contract no', 'contract number'], kind: 'text' },
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseNumeric(raw: string): number | undefined {
  const cleaned = raw.replace(/[,\s]/g, '').replace(/[a-zA-Z%$£€]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

interface ExtractedCandidate {
  fieldKey: string;
  rawValue: string;
  confidence: DocumentFieldConfidence;
}

/**
 * Real, labeled key-value extraction from a text-bearing PDF's plain text —
 * not a tabular importer (that's the existing Lead/Payment/Inventory
 * Import). Each candidate is confidence-scored by how it was found:
 *   - 'high': an explicit "Label: value" match on one line, and (for
 *     numeric fields) the value actually parses as a positive number.
 *   - 'medium': the label matched on its own line with the value on the
 *     next non-empty line, or a numeric field's inline match didn't parse
 *     cleanly (kept for review, not discarded).
 * Nothing here ever invents a value for a field it found no match for —
 * an unmatched field is simply absent from the run's fields, never a
 * guessed 'low'-confidence placeholder.
 */
function extractCandidates(text: string): ExtractedCandidate[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const candidates: ExtractedCandidate[] = [];

  for (const spec of FIELD_SPECS) {
    let found = false;
    for (const label of spec.labels) {
      const inlinePattern = new RegExp(`^${escapeRegex(label)}\\s*[:\\-]\\s*(.+)$`, 'i');
      for (const line of lines) {
        const match = inlinePattern.exec(line);
        if (!match) continue;
        const value = match[1]!.trim();
        if (!value) continue;
        if (spec.kind === 'number') {
          const n = parseNumeric(value);
          candidates.push({ fieldKey: spec.key, rawValue: value, confidence: n !== undefined ? 'high' : 'medium' });
        } else {
          candidates.push({ fieldKey: spec.key, rawValue: value, confidence: 'high' });
        }
        found = true;
        break;
      }
      if (found) break;
    }
    if (found) continue;

    // Two-line fallback: the label alone on one line, its value on the
    // very next non-empty line.
    for (const label of spec.labels) {
      const labelOnlyPattern = new RegExp(`^${escapeRegex(label)}$`, 'i');
      const idx = lines.findIndex((l) => labelOnlyPattern.test(l));
      if (idx >= 0 && idx + 1 < lines.length) {
        const value = lines[idx + 1]!;
        candidates.push({ fieldKey: spec.key, rawValue: value, confidence: 'medium' });
        found = true;
        break;
      }
    }
  }
  return candidates;
}

export class DocumentIntelligenceService {
  constructor(
    private readonly runs: Repository<DocumentExtractionRun>,
    private readonly fields: Repository<DocumentExtractedField>,
    private readonly inventoryImport: InventoryImportService,
  ) {}

  classify(fileName: string, hasTextLayer: boolean | undefined): DocumentKind {
    const ext = (fileName.split('.').pop() ?? '').toLowerCase();
    if (ext === 'pdf') return hasTextLayer === false ? 'pdf_scanned' : 'pdf_text';
    if (IMAGE_EXTENSIONS.has(ext)) return 'image';
    return 'unsupported';
  }

  async extractFromPdf(companyId: string, createdByUserId: string, fileName: string, buffer: Buffer): Promise<{ run: DocumentExtractionRun; fields: DocumentExtractedField[] }> {
    const parsed = await extractPdfPlainText(buffer);
    const kind = this.classify(fileName, parsed.hasTextLayer);

    if (kind !== 'pdf_text') {
      const run = await this.runs.save({
        id: randomUUID(),
        companyId,
        fileName,
        documentKind: kind,
        status: 'blocked' as DocumentExtractionStatus,
        blockedReason:
          kind === 'pdf_scanned'
            ? 'no text layer found — this looks like a scanned/image PDF. OCR is not available in this deployment; a text-based PDF or a manually transcribed import is required.'
            : 'unrecognized file type for document extraction.',
        createdByUserId,
        createdAt: new Date().toISOString(),
      });
      return { run, fields: [] };
    }

    const candidates = extractCandidates(parsed.text);
    const run = await this.runs.save({
      id: randomUUID(),
      companyId,
      fileName,
      documentKind: kind,
      status: 'extracted' as DocumentExtractionStatus,
      createdByUserId,
      createdAt: new Date().toISOString(),
    });
    const savedFields: DocumentExtractedField[] = [];
    for (const c of candidates) {
      savedFields.push(
        await this.fields.save({
          id: randomUUID(),
          extractionRunId: run.id,
          companyId,
          fieldKey: c.fieldKey,
          rawValue: c.rawValue,
          confidence: c.confidence,
        }),
      );
    }
    return { run, fields: savedFields };
  }

  async getRun(id: string, companyId: string): Promise<DocumentExtractionRun> {
    const run = await this.runs.findById(id);
    if (!run || run.companyId !== companyId) throw new NotFoundError('document extraction run not found');
    return run;
  }

  async listRuns(companyId: string): Promise<DocumentExtractionRun[]> {
    return this.runs.findAll((r) => r.companyId === companyId);
  }

  async listFields(runId: string, companyId: string): Promise<DocumentExtractedField[]> {
    await this.getRun(runId, companyId);
    return this.fields.findAll((f) => f.extractionRunId === runId && f.companyId === companyId);
  }

  /** A human reviewer overriding or confirming one extracted value — never
   * bulk-applied, one field at a time, so each correction is an explicit
   * human act. */
  async correctField(fieldId: string, companyId: string, correctedValue: string): Promise<DocumentExtractedField> {
    const field = await this.fields.findById(fieldId);
    if (!field || field.companyId !== companyId) throw new NotFoundError('extracted field not found');
    return this.fields.save({ ...field, correctedValue });
  }

  async markReviewed(runId: string, companyId: string, reviewedByUserId: string): Promise<DocumentExtractionRun> {
    const run = await this.getRun(runId, companyId);
    return this.runs.save({ ...run, status: 'reviewed', reviewedByUserId, reviewedAt: new Date().toISOString() });
  }

  async rejectExtraction(runId: string, companyId: string, actorUserId: string): Promise<DocumentExtractionRun> {
    const run = await this.getRun(runId, companyId);
    return this.runs.save({ ...run, status: 'rejected', reviewedByUserId: actorUserId, reviewedAt: new Date().toISOString() });
  }

  /**
   * The only path from an extraction run into a real Unit — reuses
   * InventoryImportService's own tested validate/create/update logic
   * (buildPreview + importRows) rather than duplicating it, so an imported
   * Unit gets exactly the same conflict handling and field validation any
   * CSV/Excel import row would. Refuses outright if a required field
   * (projectName/unitCode/unitType/areaSqm/listPrice) has no value at all,
   * or only a 'low'-confidence one with no human correction — "never
   * silently import uncertain data" is enforced here, not left to the
   * caller's judgment.
   */
  async confirmExtraction(
    runId: string,
    companyId: string,
    actorUserId: string,
    onWritten: (unit: import('../../domain/types.js').Unit, action: 'create' | 'update') => Promise<void>,
    options?: InventoryImportOptions,
  ): Promise<InventoryImportResult> {
    const run = await this.getRun(runId, companyId);
    if (run.status === 'imported') throw new ValidationError('this extraction run has already been imported');
    if (run.status !== 'extracted' && run.status !== 'reviewed') {
      throw new ValidationError(`cannot import a run with status "${run.status}"`);
    }

    const fields = await this.fields.findAll((f) => f.extractionRunId === runId && f.companyId === companyId);
    const byKey = new Map(fields.map((f) => [f.fieldKey, f]));

    const resolveField = (key: string): string | undefined => {
      const field = byKey.get(key);
      return field?.correctedValue ?? (field && field.confidence !== 'low' ? field.rawValue : undefined);
    };

    const missing: string[] = [];
    const row: Record<string, string> = {};
    for (const key of REQUIRED_IMPORTABLE_KEYS) {
      const value = resolveField(key);
      if (!value) {
        missing.push(key);
        continue;
      }
      row[key] = value;
    }
    for (const key of OPTIONAL_IMPORTABLE_KEYS) {
      const value = resolveField(key);
      if (value) row[key] = value;
    }
    if (missing.length > 0) {
      throw new ValidationError(
        `cannot import: required field(s) missing or only low-confidence with no correction: ${missing.join(', ')}. Review and correct these fields first.`,
      );
    }

    const result = await this.inventoryImport.importRows(companyId, [row], onWritten, options);
    const first = result.results[0];
    // Only a real created/updated Unit counts as "imported" — a row
    // InventoryImportService itself rejected (invalid/conflicting data)
    // leaves the run exactly as it was, so the reviewer sees the failure
    // reason and can correct the field(s) and retry, rather than the run
    // being silently marked done with nothing actually written.
    if (first?.status === 'created' || first?.status === 'updated') {
      await this.runs.save({
        ...run,
        status: 'imported',
        reviewedByUserId: run.reviewedByUserId ?? actorUserId,
        reviewedAt: run.reviewedAt ?? new Date().toISOString(),
        importedUnitId: first.unitId,
      });
    }
    return result;
  }
}
