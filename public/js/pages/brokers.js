import { el, clear, table, toast, errorBanner, statusBadge, loadingState, confirmModal, selectInput, paginationControls, searchInput } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

export async function renderBrokers(container) {
  clear(container);
  const locale = getLocale();
  let leadsOffset = 0;
  let leadsQuery = '';
  let commissionsOffset = 0;
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, t(locale, 'page_title_brokers'))));
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
  const leadsTableSlot = el('div');
  const leadsSearch = searchInput('Search by name, phone, or email…', (value) => { leadsQuery = value; leadsOffset = 0; load(); });
  const leadsSlot = el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Broker-submitted leads (quarantine queue)'),
    el('div', { class: 'form-row', style: 'max-width:320px;margin-bottom:10px' }, [leadsSearch]),
    leadsTableSlot,
  ]);
  const commissionsSlot = el('div', { class: 'card' });

  const rateBrokerSelect = selectInput([{ value: '', label: 'Company-wide default' }]);
  const rateInput = el('input', { type: 'number', placeholder: 'e.g. 2.5', step: '0.01', min: '0', max: '100' });
  const setRateBtn = el('button', {}, 'Set commission rate');
  setRateBtn.addEventListener('click', async () => {
    clear(errorSlot);
    const rate = Number(rateInput.value);
    if (!(rate >= 0 && rate <= 100)) {
      errorSlot.appendChild(errorBanner('Enter a rate percentage between 0 and 100.'));
      return;
    }
    setRateBtn.disabled = true;
    try {
      await api.post('/api/brokers/commission-rules', { ratePercent: rate, brokerCompanyId: rateBrokerSelect.value || undefined });
      rateInput.value = '';
      toast('Commission rate saved.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      setRateBtn.disabled = false;
    }
  });

  async function approveCommission(c, btn) {
    btn.disabled = true;
    try {
      await api.post(`/api/brokers/commissions/${c.id}/approve`, {});
      toast('Commission approved.', 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  const commissionBrokerSelect = selectInput([]);
  const commissionContractSelect = selectInput([]);
  const commissionAmountInput = el('input', { type: 'number', placeholder: 'Contract amount' });
  const recordCommissionBtn = el('button', {}, 'Record commission');
  recordCommissionBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!commissionBrokerSelect.value || !commissionContractSelect.value) {
      errorSlot.appendChild(errorBanner('Choose a broker company and a contract.'));
      return;
    }
    if (!(Number(commissionAmountInput.value) > 0)) {
      errorSlot.appendChild(errorBanner('Enter a contract amount greater than zero.'));
      return;
    }
    recordCommissionBtn.disabled = true;
    try {
      await api.post(`/api/brokers/companies/${commissionBrokerSelect.value}/commissions`, {
        contractId: commissionContractSelect.value,
        contractAmount: Number(commissionAmountInput.value),
      });
      commissionAmountInput.value = '';
      toast('Commission recorded.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      recordCommissionBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Commission rates'),
    el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, 'A broker-specific rate overrides the company-wide default.'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Applies to'), rateBrokerSelect]),
      el('div', {}, [el('label', {}, 'Rate (%)'), rateInput]),
    ]),
    el('div', { class: 'form-actions' }, [setRateBtn]),
  ]));

  container.append(companiesSlot, leadsSlot, commissionsSlot);

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

  async function suspendCompany(bc, btn) {
    if (!(await confirmModal(`Suspend ${bc.name}? They will no longer be able to submit leads.`, { confirmLabel: 'Suspend', danger: true }))) return;
    btn.disabled = true;
    try {
      await api.post(`/api/brokers/companies/${bc.id}/suspend`, {});
      toast('Broker company suspended.', 'success');
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
    let approvedCompanies = [];

    clear(companiesSlot);
    companiesSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Broker companies'));
    const companiesLoading = loadingState();
    companiesSlot.appendChild(companiesLoading);
    try {
      const page = await api.get('/api/brokers/companies', { limit: 50 });
      companiesLoading.remove();
      approvedCompanies = page.items.filter((bc) => bc.status === 'approved');
      const previousRateSelection = rateBrokerSelect.value;
      clear(rateBrokerSelect);
      rateBrokerSelect.appendChild(el('option', { value: '' }, 'Company-wide default'));
      approvedCompanies.forEach((bc) => rateBrokerSelect.appendChild(el('option', { value: bc.id }, bc.name)));
      rateBrokerSelect.value = previousRateSelection;
      companiesSlot.appendChild(table(
        [
          { label: 'Name', key: 'name' },
          { label: 'Status', render: (bc) => statusBadge(bc.status) },
          { label: '', render: (bc) => {
            if (bc.status === 'pending') {
              const btn = el('button', {}, 'Approve');
              btn.addEventListener('click', () => { btn.disabled = true; approveCompany(bc, btn); });
              return btn;
            }
            if (bc.status === 'approved') {
              const btn = el('button', { class: 'danger' }, 'Suspend');
              btn.addEventListener('click', () => suspendCompany(bc, btn));
              return btn;
            }
            return '';
          } },
        ],
        page.items,
        { empty: 'No broker companies yet.' },
      ));
    } catch (err) {
      companiesLoading.remove();
      companiesSlot.appendChild(errorBanner(err.message));
    }

    clear(leadsTableSlot);
    const leadsLoading = loadingState();
    leadsTableSlot.appendChild(leadsLoading);
    try {
      const page = await api.get('/api/brokers/leads', { limit: 20, offset: leadsOffset, q: leadsQuery });
      leadsLoading.remove();
      leadsTableSlot.appendChild(table(
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
      leadsTableSlot.appendChild(paginationControls(page, (next) => { leadsOffset = next; load(); }));
    } catch (err) {
      leadsLoading.remove();
      leadsTableSlot.appendChild(errorBanner(err.message));
    }

    clear(commissionsSlot);
    commissionsSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Commissions'));

    const previousCommissionBrokerSelection = commissionBrokerSelect.value;
    clear(commissionBrokerSelect);
    approvedCompanies.forEach((bc) => commissionBrokerSelect.appendChild(el('option', { value: bc.id }, bc.name)));
    commissionBrokerSelect.value = previousCommissionBrokerSelection;

    try {
      const previousCommissionContractSelection = commissionContractSelect.value;
      clear(commissionContractSelect);
      const contractsPage = await api.get('/api/sales/contracts', { limit: 100 });
      contractsPage.items
        .filter((c) => c.status === 'signed')
        .forEach((c) => commissionContractSelect.appendChild(el('option', { value: c.id }, `${c.id.slice(0, 8)}…`)));
      commissionContractSelect.value = previousCommissionContractSelection;
    } catch {
      // Non-fatal: the record-commission form just has no contracts to pick from yet.
    }

    commissionsSlot.appendChild(el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Broker company'), commissionBrokerSelect]),
      el('div', {}, [el('label', {}, 'Signed contract'), commissionContractSelect]),
      el('div', {}, [el('label', {}, 'Contract amount'), commissionAmountInput]),
    ]));
    commissionsSlot.appendChild(el('div', { class: 'form-actions' }, [recordCommissionBtn]));

    const commissionsLoading = loadingState();
    commissionsSlot.appendChild(commissionsLoading);
    try {
      const page = await api.get('/api/brokers/commissions', { limit: 20, offset: commissionsOffset });
      commissionsLoading.remove();
      commissionsSlot.appendChild(table(
        [
          { label: 'Broker company', key: 'brokerCompanyId' },
          { label: 'Contract', render: (c) => c.contractId.slice(0, 8) + '…' },
          { label: 'Amount', render: (c) => Number(c.amount).toLocaleString() },
          { label: 'Status', render: (c) => statusBadge(c.status) },
          { label: '', render: (c) => {
            if (c.status !== 'pending') return '';
            const btn = el('button', { class: 'primary' }, 'Approve');
            btn.addEventListener('click', () => approveCommission(c, btn));
            return btn;
          } },
        ],
        page.items,
        { empty: 'No commissions recorded yet — record one above against a signed contract.' },
      ));
      commissionsSlot.appendChild(paginationControls(page, (next) => { commissionsOffset = next; load(); }));
    } catch (err) {
      commissionsLoading.remove();
      commissionsSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
