import { el, clear, table, toast, errorBanner, statusBadge, loadingState, selectInput, paginationControls, searchInput } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

export async function renderLegal(container) {
  clear(container);
  const locale = getLocale();
  let offset = 0;
  let q = '';
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, t(locale, 'page_title_legal'))));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const contractSelect = selectInput([]);
  const typeSelect = selectInput(['title_deed', 'power_of_attorney', 'nda', 'id_verification', 'other'].map((t) => ({ value: t, label: t })));
  const nameInput = el('input', { type: 'text', placeholder: t(locale, 'legal_name_placeholder') });
  const notesInput = el('input', { type: 'text', placeholder: t(locale, 'legal_notes_placeholder') });
  const addBtn = el('button', { class: 'primary' }, t(locale, 'legal_add_document_btn'));

  addBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!contractSelect.value || !nameInput.value.trim()) {
      errorSlot.appendChild(errorBanner(t(locale, 'legal_err_required')));
      return;
    }
    addBtn.disabled = true;
    try {
      await api.post('/api/legal/documents', {
        contractId: contractSelect.value,
        type: typeSelect.value,
        name: nameInput.value.trim(),
        notes: notesInput.value.trim() || undefined,
      });
      nameInput.value = '';
      notesInput.value = '';
      toast(t(locale, 'legal_added_toast'), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      addBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'legal_add_document_title')),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'finance_contract_field')), contractSelect]),
      el('div', {}, [el('label', {}, t(locale, 'units_col_type')), typeSelect]),
      el('div', {}, [el('label', {}, t(locale, 'crm_col_name')), nameInput]),
      el('div', {}, [el('label', {}, t(locale, 'units_project_notes_field')), notesInput]),
    ]),
    el('div', { class: 'form-actions' }, [addBtn]),
  ]));

  const search = searchInput(t(locale, 'legal_search_placeholder'), (value) => { q = value; offset = 0; load(); });
  container.appendChild(el('div', { class: 'form-row', style: 'max-width:320px' }, [search]));

  const listSlot = el('div');
  container.appendChild(listSlot);

  async function transition(doc, action, btn) {
    btn.disabled = true;
    try {
      await api.post(`/api/legal/documents/${doc.id}/${action}`, {});
      toast(action === 'received' ? t(locale, 'legal_marked_received_toast') : action === 'verify' ? t(locale, 'legal_marked_verified_toast') : t(locale, 'legal_marked_rejected_toast'), 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    try {
      const contractsPage = await api.get('/api/sales/contracts', { limit: 100 });
      clear(contractSelect);
      contractsPage.items.forEach((c) => contractSelect.appendChild(el('option', { value: c.id }, `${c.id.slice(0, 8)}… (${c.status})`)));
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }

    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/legal/documents', { limit: 20, offset, q });
      clear(listSlot);
      listSlot.appendChild(table(
        [
          { label: t(locale, 'crm_col_name'), key: 'name' },
          { label: t(locale, 'units_col_type'), key: 'type' },
          { label: t(locale, 'finance_contract_field'), render: (d) => d.contractId.slice(0, 8) + '…' },
          { label: t(locale, 'common_col_status'), render: (d) => statusBadge(d.status) },
          { label: '', render: (d) => {
            if (d.status === 'pending') {
              const btn = el('button', {}, t(locale, 'legal_mark_received_btn'));
              btn.addEventListener('click', () => transition(d, 'received', btn));
              return btn;
            }
            if (d.status === 'received') {
              const verifyBtn = el('button', { class: 'primary' }, t(locale, 'legal_verify_btn'));
              verifyBtn.addEventListener('click', () => transition(d, 'verify', verifyBtn));
              const rejectBtn = el('button', { class: 'danger' }, t(locale, 'approvals_reject_btn'));
              rejectBtn.addEventListener('click', () => transition(d, 'reject', rejectBtn));
              return el('div', { class: 'form-actions' }, [verifyBtn, rejectBtn]);
            }
            return '';
          } },
        ],
        page.items,
        { empty: t(locale, 'legal_empty_documents') },
      ));
      listSlot.appendChild(paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
