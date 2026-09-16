import { el, clear, table, toast, errorBanner, statusBadge, loadingState, selectInput } from '../ui.js';
import { api } from '../api.js';

export async function renderLegal(container) {
  clear(container);
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, 'Legal — Contract Documents')));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const contractSelect = selectInput([]);
  const typeSelect = selectInput(['title_deed', 'power_of_attorney', 'nda', 'id_verification', 'other'].map((t) => ({ value: t, label: t })));
  const nameInput = el('input', { type: 'text', placeholder: 'e.g. Title Deed.pdf' });
  const notesInput = el('input', { type: 'text', placeholder: 'Notes (optional)' });
  const addBtn = el('button', { class: 'primary' }, 'Add document');

  addBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!contractSelect.value || !nameInput.value.trim()) {
      errorSlot.appendChild(errorBanner('Choose a contract and a document name.'));
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
      toast('Document added.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      addBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Add a contract document'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Contract'), contractSelect]),
      el('div', {}, [el('label', {}, 'Type'), typeSelect]),
      el('div', {}, [el('label', {}, 'Name'), nameInput]),
      el('div', {}, [el('label', {}, 'Notes'), notesInput]),
    ]),
    el('div', { class: 'form-actions' }, [addBtn]),
  ]));

  const listSlot = el('div');
  container.appendChild(listSlot);

  async function transition(doc, action, btn) {
    btn.disabled = true;
    try {
      await api.post(`/api/legal/documents/${doc.id}/${action}`, {});
      toast(`Document marked ${action === 'received' ? 'received' : action === 'verify' ? 'verified' : 'rejected'}.`, 'success');
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
      const page = await api.get('/api/legal/documents', { limit: 50 });
      clear(listSlot);
      listSlot.appendChild(table(
        [
          { label: 'Name', key: 'name' },
          { label: 'Type', key: 'type' },
          { label: 'Contract', render: (d) => d.contractId.slice(0, 8) + '…' },
          { label: 'Status', render: (d) => statusBadge(d.status) },
          { label: '', render: (d) => {
            if (d.status === 'pending') {
              const btn = el('button', {}, 'Mark received');
              btn.addEventListener('click', () => transition(d, 'received', btn));
              return btn;
            }
            if (d.status === 'received') {
              const verifyBtn = el('button', { class: 'primary' }, 'Verify');
              verifyBtn.addEventListener('click', () => transition(d, 'verify', verifyBtn));
              const rejectBtn = el('button', { class: 'danger' }, 'Reject');
              rejectBtn.addEventListener('click', () => transition(d, 'reject', rejectBtn));
              return el('div', { class: 'form-actions' }, [verifyBtn, rejectBtn]);
            }
            return '';
          } },
        ],
        page.items,
        { empty: 'No contract documents yet — add one above.' },
      ));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
