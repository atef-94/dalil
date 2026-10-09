import { el, clear, field, selectInput, contentModal, toast, errorBanner, statusBadge, table } from './ui.js';
import { api } from './api.js';
import { getLocale } from './state.js';
import { t } from './i18n.js';

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
  const locale = getLocale();
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
    // A multi-sheet import's suggestedMapping is built from the UNION of
    // every sheet's own headers — a required field can show up as "mapped"
    // there because sheet A has that column, even though sheet B doesn't
    // and would silently fail every one of its own rows at the preview
    // step with no warning beforehand. sheetGaps (set by the backend only
    // when that happened) always forces the manual Mapping screen instead,
    // where sheetGapsNote() explains exactly which sheet/field is short.
    if (session.sheetGaps && session.sheetGaps.length > 0) return false;
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
    const uploadBtn = el('button', { class: 'primary' }, t(locale, 'import_upload_btn'));
    const errSlot = el('div');
    const optionControls = uploadOptions.map((opt) => optionCheckbox(opt, uploadOptionValues));

    uploadBtn.addEventListener('click', async () => {
      clear(errSlot);
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        errSlot.appendChild(errorBanner(t(locale, 'import_choose_file_error')));
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
      el('p', { class: 'page-subtitle' }, t(locale, 'import_upload_hint')),
      field(t(locale, 'import_file_field'), fileInput),
      ...optionControls,
      errSlot,
      el('div', { class: 'form-actions' }, [uploadBtn]),
    ]));
  }

  const SHEET_KIND_LABEL_KEYS = {
    catalog: 'import_sheet_kind_catalog',
    availability: 'import_sheet_kind_availability',
    summary: 'import_sheet_kind_summary',
    unknown: null,
  };

  function sheetKindNote() {
    const key = session && session.detectedSheetKind ? SHEET_KIND_LABEL_KEYS[session.detectedSheetKind] : null;
    return key ? el('p', { class: 'page-subtitle', style: 'font-style:italic' }, t(locale, key)) : null;
  }

  /** Surfaces formula-error cells (e.g. "#REF!") the backend found while
   * parsing an .xlsx file — these cells were read as blank rather than as
   * real data, so a row with one can silently import with a missing field
   * unless the user is told exactly which row/column had the problem. */
  function formulaErrorsNote() {
    const errors = session && session.formulaErrors;
    if (!errors || errors.length === 0) return null;
    return el('div', { class: 'error-banner', style: 'flex-direction:column;align-items:stretch;gap:6px' }, [
      el('strong', {}, `${errors.length}${t(locale, 'import_formula_errors_heading_suffix')}`),
      el('ul', { style: 'margin:0;padding-inline-start:20px;max-height:140px;overflow-y:auto;font-size:12.5px' },
        errors.map((e) => el('li', {}, e))),
    ]);
  }

  /** Surfaces sheetGaps (see isFullyAutoMappable's comment) on the Mapping
   * step — the one place the user can still act on it, by manually mapping
   * one of that sheet's own columns onto the missing field (each raw
   * column's dropdown below is independent, so e.g. a "Beds B" column can
   * be pointed at Unit Type even though it's also the source for
   * Bedrooms). Without this note the short sheet's rows would otherwise
   * just show up "invalid" on the next (Preview) step with no indication
   * of why, easy to miss in a large combined-sheet row list. */
  function sheetGapsNote() {
    const gaps = session && session.sheetGaps;
    if (!gaps || gaps.length === 0) return null;
    const fieldLabel = (key) => (session.fields || []).find((f) => f.key === key)?.label || key;
    return el('div', { class: 'error-banner', style: 'flex-direction:column;align-items:stretch;gap:6px' }, [
      el('strong', {}, t(locale, 'import_sheet_gaps_heading')),
      el('ul', { style: 'margin:0;padding-inline-start:20px;font-size:12.5px' },
        gaps.map((g) => el('li', {},
          `"${g.sheetName}" — ${g.missingRequiredFieldKeys.map(fieldLabel).join(', ')}`,
        ))),
    ]);
  }

  function sampleValuesFor(column) {
    const values = (session.sampleRows || []).map((r) => r[column]).filter((v) => v);
    return values.length > 0 ? values.slice(0, 2).join(', ') : '(blank)';
  }

  function renderMappingStep() {
    clear(body);
    const fieldOptions = [{ value: '', label: t(locale, 'import_do_not_import_option') }, ...session.fields.map((f) => ({ value: f.key, label: f.label + (f.required ? t(locale, 'import_required_suffix') : '') }))];

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
        el('div', {}, [el('label', {}, t(locale, 'import_maps_to_field')), select]),
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

    const backBtn = el('button', {}, t(locale, 'import_back_btn'));
    const nextBtn = el('button', { class: 'primary' }, t(locale, 'import_preview_import_btn'));
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
      el('p', { class: 'page-subtitle' }, `${session.totalRows}${t(locale, 'import_rows_detected_middle')}${session.fileName}${t(locale, 'import_mapping_confirm_suffix')}`),
      sheetKindNote(),
      sheetGapsNote(),
      formulaErrorsNote(),
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

    const backBtn = el('button', {}, wasAutoMapped ? t(locale, 'import_edit_mapping_btn') : t(locale, 'import_back_to_mapping_btn'));
    const confirmBtn = el('button', { class: 'primary' }, `${t(locale, 'import_import_rows_prefix')}${validRows.length}${t(locale, 'import_import_rows_suffix')}`);
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
        ? el('p', { class: 'page-subtitle' }, `${session.totalRows}${t(locale, 'import_rows_detected_middle')}${session.fileName}${t(locale, 'import_preview_automapped_suffix')}`)
        : el('p', { class: 'page-subtitle' }, `${session.totalRows}${t(locale, 'import_rows_detected_middle')}${session.fileName}${t(locale, 'import_preview_plain_suffix')}`),
      sheetKindNote(),
      formulaErrorsNote(),
      el('div', { class: 'stat-grid' }, [
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, String(preview.totalRows)), el('div', { class: 'label' }, t(locale, 'import_stat_total_rows'))]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, String(validRows.length)), el('div', { class: 'label' }, t(locale, 'import_stat_ready'))]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, String(problemRows.length)), el('div', { class: 'label' }, t(locale, 'import_stat_will_skip'))]),
      ]),
      table(
        [
          { label: t(locale, 'import_col_row'), render: (r) => String(r.row) },
          { label: t(locale, 'units_col_status'), render: (r) => statusBadge(r.status) },
          { label: t(locale, 'import_col_details'), render: (r) => (r.issues && r.issues.length > 0 ? r.issues.join('; ') : '—') },
        ],
        rows,
        { empty: t(locale, 'import_no_rows_empty') },
      ),
      errSlot,
      el('div', { class: 'form-actions' }, [backBtn, confirmBtn]),
    ]));
  }

  function renderSummaryStep(result) {
    clear(body);
    toast(`${t(locale, 'import_toast_complete_prefix')}${result.succeeded}${t(locale, 'import_toast_imported_mid')}${result.skipped}${t(locale, 'import_toast_skipped_mid')}${result.failed}${t(locale, 'import_toast_failed_suffix')}`, result.failed > 0 ? 'error' : 'success');
    const doneBtn = el('button', { class: 'primary' }, t(locale, 'import_done_btn'));
    doneBtn.addEventListener('click', () => modal.close());
    body.appendChild(el('div', {}, [
      el('div', { class: 'stat-grid' }, [
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, String(result.succeeded)), el('div', { class: 'label' }, t(locale, 'import_stat_imported'))]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, String(result.skipped)), el('div', { class: 'label' }, t(locale, 'import_stat_skipped_label'))]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, String(result.failed)), el('div', { class: 'label' }, t(locale, 'import_stat_failed'))]),
      ]),
      table(
        [
          { label: t(locale, 'import_col_row'), render: (r) => String(r.row) },
          { label: t(locale, 'units_col_status'), render: (r) => statusBadge(r.status) },
          { label: t(locale, 'import_col_detail'), render: (r) => r.reason || r.leadId || r.paymentId || r.unitId || r.specId || '—' },
        ],
        result.results || [],
        { empty: t(locale, 'import_nothing_to_show_empty') },
      ),
      el('div', { class: 'form-actions' }, [doneBtn]),
    ]));
    if (onImported) onImported(result);
  }

  renderUploadStep();
  return modal;
}
