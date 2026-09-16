import { el, clear, table, toast, errorBanner, statusBadge, loadingState } from '../ui.js';
import { api } from '../api.js';

export async function renderBrokers(container) {
  clear(container);
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, 'Brokers')));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const nameInput = el('input', { type: 'text', placeholder: 'Acme Brokerage' });
  const registerBtn = el('button', { class: 'primary' }, 'Register broker company');
  registerBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!nameInput.value.trim()) {
      errorSlot.appendChild(errorBanner('Enter a broker company name.'));
      return;
    }
    registerBtn.disabled = true;
    try {
      await api.post('/api/brokers/companies', { name: nameInput.value.trim() });
      nameInput.value = '';
      toast('Broker company registered (pending approval).', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      registerBtn.disabled = false;
    }
  });
  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Register a broker company'),
    el('div', { class: 'form-row' }, [el('div', {}, [el('label', {}, 'Name'), nameInput])]),
    el('div', { class: 'form-actions' }, [registerBtn]),
  ]));

  const companiesSlot = el('div', { class: 'card' });
  const leadsSlot = el('div', { class: 'card' });
  container.append(companiesSlot, leadsSlot);

  async function approveCompany(bc, btn) {
    try {
      await api.post(`/api/brokers/companies/${bc.id}/approve`, {});
      toast('Broker company approved.', 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function approveLead(bl, btn) {
    try {
      await api.post(`/api/brokers/leads/${bl.id}/approve`, {});
      toast('Broker lead approved and added to the shared CRM.', 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    clear(companiesSlot);
    companiesSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Broker companies'));
    const companiesLoading = loadingState();
    companiesSlot.appendChild(companiesLoading);
    try {
      const page = await api.get('/api/brokers/companies', { limit: 50 });
      companiesLoading.remove();
      companiesSlot.appendChild(table(
        [
          { label: 'Name', key: 'name' },
          { label: 'Status', render: (bc) => statusBadge(bc.status) },
          { label: '', render: (bc) => {
            if (bc.status !== 'pending') return '';
            const btn = el('button', {}, 'Approve');
            btn.addEventListener('click', () => { btn.disabled = true; approveCompany(bc, btn); });
            return btn;
          } },
        ],
        page.items,
        { empty: 'No broker companies yet.' },
      ));
    } catch (err) {
      companiesLoading.remove();
      companiesSlot.appendChild(errorBanner(err.message));
    }

    clear(leadsSlot);
    leadsSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Broker-submitted leads (quarantine queue)'));
    const leadsLoading = loadingState();
    leadsSlot.appendChild(leadsLoading);
    try {
      const page = await api.get('/api/brokers/leads', { limit: 50 });
      leadsLoading.remove();
      leadsSlot.appendChild(table(
        [
          { label: 'Name', key: 'fullName' },
          { label: 'Phone', key: 'phone' },
          { label: 'Status', render: (bl) => statusBadge(bl.approvalStatus) },
          { label: '', render: (bl) => {
            if (bl.approvalStatus !== 'pending_approval') return '';
            const btn = el('button', { class: 'primary' }, 'Approve');
            btn.addEventListener('click', () => { btn.disabled = true; approveLead(bl, btn); });
            return btn;
          } },
        ],
        page.items,
        { empty: 'No broker-submitted leads yet — they land here only after a broker_user account submits one.' },
      ));
    } catch (err) {
      leadsLoading.remove();
      leadsSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
