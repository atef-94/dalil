import { el, clear, table, toast, errorBanner, statusBadge, loadingState, selectInput, formModal } from '../ui.js';
import { api } from '../api.js';

const NEXT_STATUS = { open: 'in_progress', in_progress: 'resolved', resolved: 'closed' };

export async function renderOperations(container) {
  clear(container);
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, 'Operations — Maintenance')));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const unitSelect = selectInput([]);
  const titleInput = el('input', { type: 'text', placeholder: 'e.g. AC not cooling' });
  const prioritySelect = selectInput(['low', 'medium', 'high', 'urgent'].map((p) => ({ value: p, label: p })));
  const descriptionInput = el('input', { type: 'text', placeholder: 'Description (optional)' });
  const createBtn = el('button', { class: 'primary' }, 'Open ticket');

  createBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!unitSelect.value || !titleInput.value.trim()) {
      errorSlot.appendChild(errorBanner('Choose a unit and enter a title.'));
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
      toast('Maintenance ticket opened.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Open a maintenance ticket'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Unit'), unitSelect]),
      el('div', {}, [el('label', {}, 'Title'), titleInput]),
      el('div', {}, [el('label', {}, 'Priority'), prioritySelect]),
      el('div', {}, [el('label', {}, 'Description'), descriptionInput]),
    ]),
    el('div', { class: 'form-actions' }, [createBtn]),
  ]));

  const listSlot = el('div');
  container.appendChild(listSlot);

  async function advance(ticket, btn) {
    const next = NEXT_STATUS[ticket.status];
    if (!next) return;
    btn.disabled = true;
    try {
      await api.post(`/api/operations/tickets/${ticket.id}/status`, { status: next });
      toast(`Ticket moved to "${next}".`, 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function assign(ticket, btn) {
    const values = await formModal({
      title: `Assign ${ticket.title}`,
      fields: [{ key: 'assignedToUserId', label: 'Assignee user ID', type: 'text', placeholder: 'user id' }],
      submitLabel: 'Assign',
    });
    if (!values || !values.assignedToUserId.trim()) return;
    btn.disabled = true;
    try {
      await api.post(`/api/operations/tickets/${ticket.id}/assign`, { assignedToUserId: values.assignedToUserId.trim() });
      toast('Ticket assigned.', 'success');
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
      const page = await api.get('/api/operations/tickets', { limit: 50 });
      clear(listSlot);
      listSlot.appendChild(table(
        [
          { label: 'Title', key: 'title' },
          { label: 'Unit', render: (t) => unitSelect.querySelector(`option[value="${t.unitId}"]`)?.textContent || t.unitId },
          { label: 'Priority', render: (t) => statusBadge(t.priority) },
          { label: 'Status', render: (t) => statusBadge(t.status) },
          { label: 'Assignee', render: (t) => t.assignedToUserId || '—' },
          { label: '', render: (t) => {
            if (t.status === 'closed') return '';
            const advanceBtn = el('button', { class: 'primary' }, `→ ${NEXT_STATUS[t.status]}`);
            advanceBtn.addEventListener('click', () => advance(t, advanceBtn));
            const assignBtn = el('button', {}, 'Assign');
            assignBtn.addEventListener('click', () => assign(t, assignBtn));
            return el('div', { class: 'form-actions' }, [advanceBtn, assignBtn]);
          } },
        ],
        page.items,
        { empty: 'No maintenance tickets yet — open one above.' },
      ));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
