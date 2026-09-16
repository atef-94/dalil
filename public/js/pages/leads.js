import { el, clear, table, toast, errorBanner, statusBadge, paginationControls, formModal, loadingState } from '../ui.js';
import { api } from '../api.js';

const NEXT_STATUS = { new: 'contacted', contacted: 'qualified', qualified: 'opportunity' };

export async function renderLeads(container) {
  clear(container);
  let offset = 0;
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, 'Leads')));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const nameInput = el('input', { type: 'text', placeholder: 'Full name' });
  const phoneInput = el('input', { type: 'text', placeholder: '010-000-0000' });
  const emailInput = el('input', { type: 'email', placeholder: 'optional' });
  const sourceInput = el('input', { type: 'text', placeholder: 'e.g. walk-in, website (optional)' });
  const createBtn = el('button', { class: 'primary' }, 'Add lead');

  createBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!nameInput.value.trim() || !phoneInput.value.trim()) {
      errorSlot.appendChild(errorBanner('Full name and phone are required.'));
      return;
    }
    createBtn.disabled = true;
    try {
      await api.post('/api/crm/leads', {
        fullName: nameInput.value.trim(),
        phone: phoneInput.value.trim(),
        email: emailInput.value.trim() || undefined,
        sourceId: sourceInput.value.trim() || undefined,
      });
      nameInput.value = ''; phoneInput.value = ''; emailInput.value = ''; sourceInput.value = '';
      toast('Lead added.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Add a lead'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Full name'), nameInput]),
      el('div', {}, [el('label', {}, 'Phone'), phoneInput]),
      el('div', {}, [el('label', {}, 'Email'), emailInput]),
      el('div', {}, [el('label', {}, 'Source'), sourceInput]),
    ]),
    el('div', { class: 'form-actions' }, [createBtn]),
  ]));

  const listSlot = el('div');
  container.appendChild(listSlot);

  async function advance(lead, btn) {
    const next = NEXT_STATUS[lead.status];
    if (!next) return;
    try {
      await api.patch(`/api/crm/leads/${lead.id}/status`, { status: next });
      toast(`Lead moved to "${next}".`, 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function markLost(lead) {
    const result = await formModal({
      title: `Mark "${lead.fullName}" as lost`,
      fields: [{ key: 'reason', label: 'Reason', type: 'textarea', placeholder: 'e.g. went with a competitor' }],
      submitLabel: 'Mark lost',
    });
    if (!result || !result.reason.trim()) return;
    const reason = result.reason.trim();
    try {
      await api.patch(`/api/crm/leads/${lead.id}/status`, { status: 'lost', lostReason: reason });
      toast('Lead marked lost.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/crm/leads', { limit: 20, offset });
      clear(listSlot);
      listSlot.append(table(
        [
          { label: 'Name', key: 'fullName' },
          { label: 'Phone', key: 'phone' },
          { label: 'Status', render: (l) => statusBadge(l.status) },
          { label: '', render: (l) => {
            const actions = el('div', { style: 'display:flex;gap:6px' });
            if (NEXT_STATUS[l.status]) {
              const btn = el('button', {}, `→ ${NEXT_STATUS[l.status]}`);
              btn.addEventListener('click', () => { btn.disabled = true; advance(l, btn); });
              actions.appendChild(btn);
            }
            if (l.status !== 'lost' && l.status !== 'opportunity') {
              const lostBtn = el('button', {}, 'Mark lost');
              lostBtn.addEventListener('click', () => markLost(l));
              actions.appendChild(lostBtn);
            }
            return actions;
          } },
        ],
        page.items,
        { empty: 'No leads yet — add one above.' },
      ), paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
