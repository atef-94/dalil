import { el, clear, field, selectInput, contentModal, toast, errorBanner, statusBadge, table } from './ui.js';
import { api } from './api.js';

/**
 * A generic upload -> map -> preview -> confirm -> summary wizard, shared
 * by every file-import entry point (Lead Import, Payment Import, and any
 * future one) — the backend already generalizes this pipeline via
 * ImportSessionService, so the frontend shouldn't build three separate
 * wizards either. Each specific preview response shapes its per-row
 * `status` slightly differently (Lead: valid/duplicate/invalid, Payment:
 * valid/conflict/invalid), so this only ever branches on `status ===
 * 'valid'` vs. everything else, never on the specific non-valid name.
 *
 * `uploadPath` is the upload endpoint (e.g.
 * '/api/crm/leads/import/upload'); preview/confirm are derived by
 * replacing the trailing '/upload' with '/:sessionId/preview' or
 * '/:sessionId/confirm'.
 *
 * `uploadOptions` (checkboxes shown on the Upload step, sent as extra
 * multipart form fields — for choices that affect how the *file itself* is
 * read, e.g. "this file has merged cells") and `mappingOptions` (checkbox
 * or select controls shown on the Mapping step, sent as a JSON `options`
 * object alongside the mapping — for choices that affect how a mapped
 * *row* is resolved, e.g. "derive area from a From/To range") are both
 * optional and importer-specific: only Inventory Import supplies them
 * today, but any future importer can reuse the same generic controls
 * instead of building its own wizard, per this file's whole point.
 */
export function openImportWizard({ title, uploadPath, onImported, uploadOptions = [], mappingOptions = [] }) {
  const basePath = uploadPath.replace(/\/upload$/, '');
  const body = el('div', { class: 'import-wizard' });
  const modal = contentModal(title, body, { wide: true });

  let session = null;
  let mapping = {};
  let wasAutoMapped = false;
  const uploadOptionValues = {};
  uploadOptions.forEach((opt) => { uploadOptionValues[opt.key] = opt.default ?? false; });
  const mappingOptionValues = {};
  mappingOptions.forEach((opt) => { mappingOptionValues[opt.key] = opt.default; });

  function optionCheckbox(opt, values) {
    const checkbox = el('input', { type: 'checkbox' });
    checkbox.checked = !!values[opt.key];
    checkbox.addEventListener('change', () => { values[opt.key] = checkbox.checked; });
    return el('label', { style: 'display:flex;align-items:center;gap:8px;font-weight:normal;margin-top:8px' }, [checkbox, opt.label]);
  }

  /**
   * True when every required field either already has a column mapped to
   * it in the suggested mapping, or is missing one but has an
   * `autoFallbackOptionKey` that's currently enabled (e.g. Unit Code with
   * "Auto-generate a unit code" checked) — meaning the row can still be
   * imported without a human picking that column by hand. A required
   * field with no fallback (Project, Unit Type, Area, List Price) always
   * needs a real mapped column.
   */
  function isFullyAutoMappable() {
    if (!session || !session.suggestedMapping) return false;
    const mappedKeys = new Set(Object.values(session.suggestedMapping).filter(Boolean));
    return (session.fields || []).every((f) => {
      if (!f.required) return true;
      if (mappedKeys.has(f.key)) return true;
      return !!(f.autoFallbackOptionKey && mappingOptionValues[f.autoFallbackOptionKey]);
    });
  }

  function renderUploadStep() {
    clear(body);
    const fileInput = el('input', { type: 'file', accept: '.csv,.xlsx,.xls,.pdf' });
    const uploadBtn = el('button', { class: 'primary' }, 'Upload & continue');
    const errSlot = el('div');
    const optionControls = uploadOptions.map((opt) => optionCheckbox(opt, uploadOptionValues));

    uploadBtn.addEventListener('click', async () => {
      clear(errSlot);
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        errSlot.appendChild(errorBanner('Choose a file first.'));
        return;
      }
      uploadBtn.disabled = true;
      try {
        const form = new FormData();
        form.set('file', file, file.name);
        for (const opt of uploadOptions) form.set(opt.key, String(!!uploadOptionValues[opt.key]));
        session = await api.upload(uploadPath, form);
        mapping = { ...session.suggestedMapping };
        // If this wizard has a 'mode' mapping option (Inventory Import) and
        // the backend's own sheet classification recognized the file as a
        // Project Catalog, default the mode picker to match instead of
        // always defaulting to Live Availability — the user can still
        // override it on the mapping step.
        if (session.detectedSheetKind === 'catalog' && Object.prototype.hasOwnProperty.call(mappingOptionValues, 'mode')) {
          mappingOptionValues.mode = 'catalog';
        }
        if (isFullyAutoMappable()) {
          wasAutoMapped = true;
          try {
            const preview = await api.post(`${basePath}/${session.sessionId}/preview`, { mapping, options: mappingOptionValues });
            renderPreviewStep(preview);
            return;
          } catch (err) {
            // Unexpected — fall back to the manual screen rather than
            // stranding the user on a broken auto-import attempt.
            wasAutoMapped = false;
          }
        }
        renderMappingStep();
      } catch (err) {
        errSlot.appendChild(errorBanner(err.message));
      } finally {
        uploadBtn.disabled = false;
      }
    });

    body.appendChild(el('div', {}, [
      el('p', { class: 'page-subtitle' }, 'Upload a .csv, .xlsx/.xls, or .pdf file. When every required column is recognized automatically, you\'ll go straight to a preview — otherwise you\'ll be asked to confirm the column mapping first. Either way, nothing is imported until you confirm.'),
      field('File', fileInput),
      ...optionControls,
      errSlot,
      el('div', { class: 'form-actions' }, [uploadBtn]),
    ]));
  }

  const SHEET_KIND_LABELS = {
    catalog: 'This looks like a Project Catalog file (market/product ranges, no unit codes).',
    availability: 'This looks like a Live Availability file (real, individually-coded units).',
    summary: 'This looks like a summary/fact-sheet, not a row-by-row data table — importing it is unlikely to produce useful results.',
    unknown: null,
  };

  function sheetKindNote() {
    const label = session && session.detectedSheetKind ? SHEET_KIND_LABELS[session.detectedSheetKind] : null;
    return label ? el('p', { class: 'page-subtitle', style: 'font-style:italic' }, label) : null;
  }

  function sampleValuesFor(column) {
    const values = (session.sampleRows || []).map((r) => r[column]).filter((v) => v);
    return values.length > 0 ? values.slice(0, 2).join(', ') : '(blank)';
  }

  function renderMappingStep() {
    clear(body);
    const fieldOptions = [{ value: '', label: '— Do not import —' }, ...session.fields.map((f) => ({ value: f.key, label: f.label + (f.required ? ' (required)' : '') }))];

    const mappingRows = session.detectedColumns.map((column) => {
      const select = selectInput(fieldOptions, {});
      select.value = mapping[column] || '';
      select.addEventListener('change', () => {
        mapping[column] = select.value || null;
      });
      return el('div', { class: 'form-row' }, [
        el('div', {}, [
          el('label', {}, `"${column}"`),
          el('div', { style: 'font-size:12px;color:var(--text-muted)' }, sampleValuesFor(column)),
        ]),
        el('div', {}, [el('label', {}, 'Maps to'), select]),
      ]);
    });

    const optionControls = mappingOptions.map((opt) => {
      if (opt.type === 'select') {
        const select = selectInput(opt.options, {});
        select.value = mappingOptionValues[opt.key];
        select.addEventListener('change', () => { mappingOptionValues[opt.key] = select.value; });
        return field(opt.label, select);
      }
      return optionCheckbox(opt, mappingOptionValues);
    });

    const backBtn = el('button', {}, 'Back');
    const nextBtn = el('button', { class: 'primary' }, 'Preview import');
    const errSlot = el('div');

    backBtn.addEventListener('click', renderUploadStep);
    nextBtn.addEventListener('click', async () => {
      clear(errSlot);
      nextBtn.disabled = true;
      try {
        const preview = await api.post(`${basePath}/${session.sessionId}/preview`, { mapping, options: mappingOptionValues });
        renderPreviewStep(preview);
      } catch (err) {
        errSlot.appendChild(errorBanner(err.message));
      } finally {
        nextBtn.disabled = false;
      }
    });

    body.appendChild(el('div', {}, [
      el('p', { class: 'page-subtitle' }, `${session.totalRows} row(s) detected in "${session.fileName}". Confirm or correct which column maps to which field — unmapped columns are ignored.`),
      sheetKindNote(),
      ...mappingRows,
      ...optionControls,
      errSlot,
      el('div', { class: 'form-actions' }, [backBtn, nextBtn]),
    ]));
  }

  function renderPreviewStep(preview) {
    clear(body);
    const rows = preview.rows || [];
    const validRows = rows.filter((r) => r.status === 'valid');
    const problemRows = rows.filter((r) => r.status !== 'valid');

    const backBtn = el('button', {}, wasAutoMapped ? 'Edit column mapping' : 'Back to mapping');
    const confirmBtn = el('button', { class: 'primary' }, `Import ${validRows.length} row(s)`);
    confirmBtn.disabled = validRows.length === 0;
    const errSlot = el('div');

    backBtn.addEventListener('click', () => {
      wasAutoMapped = false;
      renderMappingStep();
    });
    confirmBtn.addEventListener('click', async () => {
      clear(errSlot);
      confirmBtn.disabled = true;
      try {
        const result = await api.post(`${basePath}/${session.sessionId}/confirm`, {});
        renderSummaryStep(result);
      } catch (err) {
        errSlot.appendChild(errorBanner(err.message));
        confirmBtn.disabled = false;
      }
    });

    body.appendChild(el('div', {}, [
      wasAutoMapped
        ? el('p', { class: 'page-subtitle' }, `${session.totalRows} row(s) detected in "${session.fileName}". Every required column was recognized automatically — review the results below, or edit the column mapping if something looks wrong.`)
        : el('p', { class: 'page-subtitle' }, `${session.totalRows} row(s) detected in "${session.fileName}".`),
      sheetKindNote(),
      el('div', { class: 'stat-grid' }, [
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, String(preview.totalRows)), el('div', { class: 'label' }, 'Total rows')]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, String(validRows.length)), el('div', { class: 'label' }, 'Ready to import')]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, String(problemRows.length)), el('div', { class: 'label' }, 'Will be skipped')]),
      ]),
      table(
        [
          { label: 'Row', render: (r) => String(r.row) },
          { label: 'Status', render: (r) => statusBadge(r.status) },
          { label: 'Details', render: (r) => (r.issues && r.issues.length > 0 ? r.issues.join('; ') : '—') },
        ],
        rows,
        { empty: 'No rows found.' },
      ),
      errSlot,
      el('div', { class: 'form-actions' }, [backBtn, confirmBtn]),
    ]));
  }

  function renderSummaryStep(result) {
    clear(body);
    toast(`Import complete: ${result.succeeded} imported, ${result.skipped} skipped, ${result.failed} failed.`, result.failed > 0 ? 'error' : 'success');
    const doneBtn = el('button', { class: 'primary' }, 'Done');
    doneBtn.addEventListener('click', () => modal.close());
    body.appendChild(el('div', {}, [
      el('div', { class: 'stat-grid' }, [
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, String(result.succeeded)), el('div', { class: 'label' }, 'Imported')]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, String(result.skipped)), el('div', { class: 'label' }, 'Skipped')]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, String(result.failed)), el('div', { class: 'label' }, 'Failed')]),
      ]),
      table(
        [
          { label: 'Row', render: (r) => String(r.row) },
          { label: 'Status', render: (r) => statusBadge(r.status) },
          { label: 'Detail', render: (r) => r.reason || r.leadId || r.paymentId || r.unitId || r.specId || '—' },
        ],
        result.results || [],
        { empty: 'Nothing to show.' },
      ),
      el('div', { class: 'form-actions' }, [doneBtn]),
    ]));
    if (onImported) onImported(result);
  }

  renderUploadStep();
  return modal;
}
