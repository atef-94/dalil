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
 */
export function openImportWizard({ title, uploadPath, onImported }) {
  const basePath = uploadPath.replace(/\/upload$/, '');
  const body = el('div', { class: 'import-wizard' });
  const modal = contentModal(title, body, { wide: true });

  let session = null;
  let mapping = {};

  function renderUploadStep() {
    clear(body);
    const fileInput = el('input', { type: 'file', accept: '.csv,.xlsx,.xls,.pdf' });
    const uploadBtn = el('button', { class: 'primary' }, 'Upload & continue');
    const errSlot = el('div');

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
        session = await api.upload(uploadPath, form);
        mapping = { ...session.suggestedMapping };
        renderMappingStep();
      } catch (err) {
        errSlot.appendChild(errorBanner(err.message));
      } finally {
        uploadBtn.disabled = false;
      }
    });

    body.appendChild(el('div', {}, [
      el('p', { class: 'page-subtitle' }, 'Upload a .csv, .xlsx/.xls, or .pdf file. You will review and correct the column mapping and see exactly what would be imported before anything happens.'),
      field('File', fileInput),
      errSlot,
      el('div', { class: 'form-actions' }, [uploadBtn]),
    ]));
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

    const backBtn = el('button', {}, 'Back');
    const nextBtn = el('button', { class: 'primary' }, 'Preview import');
    const errSlot = el('div');

    backBtn.addEventListener('click', renderUploadStep);
    nextBtn.addEventListener('click', async () => {
      clear(errSlot);
      nextBtn.disabled = true;
      try {
        const preview = await api.post(`${basePath}/${session.sessionId}/preview`, { mapping });
        renderPreviewStep(preview);
      } catch (err) {
        errSlot.appendChild(errorBanner(err.message));
      } finally {
        nextBtn.disabled = false;
      }
    });

    body.appendChild(el('div', {}, [
      el('p', { class: 'page-subtitle' }, `${session.totalRows} row(s) detected in "${session.fileName}". Confirm or correct which column maps to which field — unmapped columns are ignored.`),
      ...mappingRows,
      errSlot,
      el('div', { class: 'form-actions' }, [backBtn, nextBtn]),
    ]));
  }

  function renderPreviewStep(preview) {
    clear(body);
    const rows = preview.rows || [];
    const validRows = rows.filter((r) => r.status === 'valid');
    const problemRows = rows.filter((r) => r.status !== 'valid');

    const backBtn = el('button', {}, 'Back to mapping');
    const confirmBtn = el('button', { class: 'primary' }, `Import ${validRows.length} row(s)`);
    confirmBtn.disabled = validRows.length === 0;
    const errSlot = el('div');

    backBtn.addEventListener('click', renderMappingStep);
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
          { label: 'Detail', render: (r) => r.reason || r.leadId || r.paymentId || r.unitId || '—' },
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
