import { el, clear, table, toast, errorBanner, statusBadge, loadingState, selectInput, formModal, paginationControls, searchInput } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

const NEXT_STATUS = { open: 'in_progress', in_progress: 'resolved', resolved: 'closed' };

export async function renderOperations(container) {
  clear(container);
  const locale = getLocale();
  let offset = 0;
  let q = '';
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, t(locale, 'page_title_operations'))));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const unitSelect = selectInput([]);
  const titleInput = el('input', { type: 'text', placeholder: t(locale, 'operations_ticket_title_placeholder') });
  // Raw enum-as-label select, deliberately left untranslated — same treatment
  // as the identical pattern in scenario-simulation.js/finance.js.
  const prioritySelect = selectInput(['low', 'medium', 'high', 'urgent'].map((p) => ({ value: p, label: p })));
  const descriptionInput = el('input', { type: 'text', placeholder: t(locale, 'crm_stage_description_field') });
  const createBtn = el('button', { class: 'primary' }, t(locale, 'operations_open_ticket_btn'));

  createBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!unitSelect.value || !titleInput.value.trim()) {
      errorSlot.appendChild(errorBanner(t(locale, 'operations_ticket_required_error')));
      return;
    }
    createBtn.disabled = true;
    try {
      await api.post('/api/operations/tickets', {
        unitId: unitSelect.value,
        title: titleInput.value.trim(),
        description: descriptionInput.value.trim() || undefined,
        priority: prioritySelect.value,
      });
      titleInput.value = '';
      descriptionInput.value = '';
      toast(t(locale, 'operations_ticket_opened_toast'), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'operations_open_ticket_title')),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'sales_col_unit')), unitSelect]),
      el('div', {}, [el('label', {}, t(locale, 'crm_label_title')), titleInput]),
      el('div', {}, [el('label', {}, t(locale, 'crm_col_priority')), prioritySelect]),
      el('div', {}, [el('label', {}, t(locale, 'automation_label_description')), descriptionInput]),
    ]),
    el('div', { class: 'form-actions' }, [createBtn]),
  ]));

  const search = searchInput(t(locale, 'operations_search_placeholder'), (value) => { q = value; offset = 0; load(); });
  container.appendChild(el('div', { class: 'form-row', style: 'max-width:320px' }, [search]));

  const listSlot = el('div');
  container.appendChild(listSlot);

  async function advance(ticket, btn) {
    const next = NEXT_STATUS[ticket.status];
    if (!next) return;
    btn.disabled = true;
    try {
      await api.post(`/api/operations/tickets/${ticket.id}/status`, { status: next });
      toast(`${t(locale, 'operations_ticket_moved_prefix')}${next}${t(locale, 'operations_ticket_moved_suffix')}`, 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function assign(ticket, btn) {
    const values = await formModal({
      title: `${t(locale, 'operations_assign_prefix')}${ticket.title}`,
      fields: [{ key: 'assignedToUserId', label: t(locale, 'operations_assignee_user_id_field'), type: 'text', placeholder: t(locale, 'operations_assignee_user_id_placeholder') }],
      submitLabel: t(locale, 'roles_assign_btn'),
    });
    if (!values || !values.assignedToUserId.trim()) return;
    btn.disabled = true;
    try {
      await api.post(`/api/operations/tickets/${ticket.id}/assign`, { assignedToUserId: values.assignedToUserId.trim() });
      toast(t(locale, 'operations_ticket_assigned_toast'), 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    try {
      const unitsPage = await api.get('/api/inventory/units', { limit: 100 });
      clear(unitSelect);
      unitsPage.items.forEach((u) => unitSelect.appendChild(el('option', { value: u.id }, u.code)));
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }

    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/operations/tickets', { limit: 20, offset, q });
      clear(listSlot);
      listSlot.appendChild(table(
        [
          { label: t(locale, 'crm_label_title'), key: 'title' },
          { label: t(locale, 'sales_col_unit'), render: (ticket) => unitSelect.querySelector(`option[value="${ticket.unitId}"]`)?.textContent || ticket.unitId },
          { label: t(locale, 'crm_col_priority'), render: (ticket) => statusBadge(ticket.priority) },
          { label: t(locale, 'units_col_status'), render: (ticket) => statusBadge(ticket.status) },
          { label: t(locale, 'operations_assignee_col'), render: (ticket) => ticket.assignedToUserId || '—' },
          { label: '', render: (ticket) => {
            if (ticket.status === 'closed') return '';
            const advanceBtn = el('button', { class: 'primary' }, `→ ${NEXT_STATUS[ticket.status]}`);
            advanceBtn.addEventListener('click', () => advance(ticket, advanceBtn));
            const assignBtn = el('button', {}, t(locale, 'roles_assign_btn'));
            assignBtn.addEventListener('click', () => assign(ticket, assignBtn));
            return el('div', { class: 'form-actions' }, [advanceBtn, assignBtn]);
          } },
        ],
        page.items,
        { empty: t(locale, 'operations_tickets_empty') },
      ));
      listSlot.appendChild(paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
