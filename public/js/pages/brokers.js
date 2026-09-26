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

  const nameInput = el('input', { type: 'text', placeholder: t(locale, 'brokers_company_name_placeholder') });
  const registerBtn = el('button', { class: 'primary' }, t(locale, 'brokers_register_company_btn'));
  registerBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!nameInput.value.trim()) {
      errorSlot.appendChild(errorBanner(t(locale, 'brokers_err_company_name_required')));
      return;
    }
    registerBtn.disabled = true;
    try {
      await api.post('/api/brokers/companies', { name: nameInput.value.trim() });
      nameInput.value = '';
      toast(t(locale, 'brokers_toast_company_registered'), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      registerBtn.disabled = false;
    }
  });
  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'brokers_register_company_heading')),
    el('div', { class: 'form-row' }, [el('div', {}, [el('label', {}, t(locale, 'crm_col_name')), nameInput])]),
    el('div', { class: 'form-actions' }, [registerBtn]),
  ]));

  const companiesSlot = el('div', { class: 'card' });
  const leadsTableSlot = el('div');
  const leadsSearch = searchInput(t(locale, 'crm_search_leads_placeholder'), (value) => { leadsQuery = value; leadsOffset = 0; load(); });
  const leadsSlot = el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'brokers_leads_heading')),
    el('div', { class: 'form-row', style: 'max-width:320px;margin-bottom:10px' }, [leadsSearch]),
    leadsTableSlot,
  ]);
  const commissionsSlot = el('div', { class: 'card' });

  const rateBrokerSelect = selectInput([{ value: '', label: t(locale, 'brokers_company_wide_default_option') }]);
  const rateInput = el('input', { type: 'number', placeholder: t(locale, 'brokers_rate_placeholder'), step: '0.01', min: '0', max: '100' });
  const setRateBtn = el('button', {}, t(locale, 'brokers_set_rate_btn'));
  setRateBtn.addEventListener('click', async () => {
    clear(errorSlot);
    const rate = Number(rateInput.value);
    if (!(rate >= 0 && rate <= 100)) {
      errorSlot.appendChild(errorBanner(t(locale, 'brokers_err_rate_range')));
      return;
    }
    setRateBtn.disabled = true;
    try {
      await api.post('/api/brokers/commission-rules', { ratePercent: rate, brokerCompanyId: rateBrokerSelect.value || undefined });
      rateInput.value = '';
      toast(t(locale, 'brokers_toast_rate_saved'), 'success');
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
      toast(t(locale, 'brokers_toast_commission_approved'), 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  const commissionBrokerSelect = selectInput([]);
  const commissionContractSelect = selectInput([]);
  const commissionAmountInput = el('input', { type: 'number', placeholder: t(locale, 'brokers_contract_amount_field') });
  const recordCommissionBtn = el('button', {}, t(locale, 'brokers_record_commission_btn'));
  recordCommissionBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!commissionBrokerSelect.value || !commissionContractSelect.value) {
      errorSlot.appendChild(errorBanner(t(locale, 'brokers_err_choose_company_contract')));
      return;
    }
    if (!(Number(commissionAmountInput.value) > 0)) {
      errorSlot.appendChild(errorBanner(t(locale, 'brokers_err_amount_positive')));
      return;
    }
    recordCommissionBtn.disabled = true;
    try {
      await api.post(`/api/brokers/companies/${commissionBrokerSelect.value}/commissions`, {
        contractId: commissionContractSelect.value,
        contractAmount: Number(commissionAmountInput.value),
      });
      commissionAmountInput.value = '';
      toast(t(locale, 'brokers_toast_commission_recorded'), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      recordCommissionBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'brokers_commission_rates_heading')),
    el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, t(locale, 'brokers_rate_override_hint')),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'brokers_applies_to_field')), rateBrokerSelect]),
      el('div', {}, [el('label', {}, t(locale, 'brokers_rate_percent_field')), rateInput]),
    ]),
    el('div', { class: 'form-actions' }, [setRateBtn]),
  ]));

  container.append(companiesSlot, leadsSlot, commissionsSlot);

  async function approveCompany(bc, btn) {
    try {
      await api.post(`/api/brokers/companies/${bc.id}/approve`, {});
      toast(t(locale, 'brokers_toast_company_approved'), 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function suspendCompany(bc, btn) {
    if (!(await confirmModal(`${t(locale, 'brokers_suspend_word')} ${bc.name}${t(locale, 'brokers_confirm_suspend_suffix')}`, { confirmLabel: t(locale, 'brokers_suspend_word'), danger: true }))) return;
    btn.disabled = true;
    try {
      await api.post(`/api/brokers/companies/${bc.id}/suspend`, {});
      toast(t(locale, 'brokers_toast_company_suspended'), 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function approveLead(bl, btn) {
    try {
      await api.post(`/api/brokers/leads/${bl.id}/approve`, {});
      toast(t(locale, 'brokers_toast_lead_approved'), 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    let approvedCompanies = [];

    clear(companiesSlot);
    companiesSlot.appendChild(el('h3', { style: 'margin-top:0' }, t(locale, 'brokers_companies_heading')));
    const companiesLoading = loadingState();
    companiesSlot.appendChild(companiesLoading);
    try {
      const page = await api.get('/api/brokers/companies', { limit: 50 });
      companiesLoading.remove();
      approvedCompanies = page.items.filter((bc) => bc.status === 'approved');
      const previousRateSelection = rateBrokerSelect.value;
      clear(rateBrokerSelect);
      rateBrokerSelect.appendChild(el('option', { value: '' }, t(locale, 'brokers_company_wide_default_option')));
      approvedCompanies.forEach((bc) => rateBrokerSelect.appendChild(el('option', { value: bc.id }, bc.name)));
      rateBrokerSelect.value = previousRateSelection;
      companiesSlot.appendChild(table(
        [
          { label: t(locale, 'crm_col_name'), key: 'name' },
          { label: t(locale, 'units_col_status'), render: (bc) => statusBadge(bc.status) },
          { label: '', render: (bc) => {
            if (bc.status === 'pending') {
              const btn = el('button', {}, t(locale, 'brokers_approve_btn'));
              btn.addEventListener('click', () => { btn.disabled = true; approveCompany(bc, btn); });
              return btn;
            }
            if (bc.status === 'approved') {
              const btn = el('button', { class: 'danger' }, t(locale, 'brokers_suspend_word'));
              btn.addEventListener('click', () => suspendCompany(bc, btn));
              return btn;
            }
            return '';
          } },
        ],
        page.items,
        { empty: t(locale, 'brokers_empty_companies') },
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
          { label: t(locale, 'crm_col_name'), key: 'fullName' },
          { label: t(locale, 'crm_col_phone'), key: 'phone' },
          { label: t(locale, 'units_col_status'), render: (bl) => statusBadge(bl.approvalStatus) },
          { label: '', render: (bl) => {
            if (bl.approvalStatus !== 'pending_approval') return '';
            const btn = el('button', { class: 'primary' }, t(locale, 'brokers_approve_btn'));
            btn.addEventListener('click', () => { btn.disabled = true; approveLead(bl, btn); });
            return btn;
          } },
        ],
        page.items,
        { empty: t(locale, 'brokers_empty_leads') },
      ));
      leadsTableSlot.appendChild(paginationControls(page, (next) => { leadsOffset = next; load(); }));
    } catch (err) {
      leadsLoading.remove();
      leadsTableSlot.appendChild(errorBanner(err.message));
    }

    clear(commissionsSlot);
    commissionsSlot.appendChild(el('h3', { style: 'margin-top:0' }, t(locale, 'brokers_commissions_heading')));

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
      el('div', {}, [el('label', {}, t(locale, 'brokers_broker_company_field')), commissionBrokerSelect]),
      el('div', {}, [el('label', {}, t(locale, 'brokers_signed_contract_field')), commissionContractSelect]),
      el('div', {}, [el('label', {}, t(locale, 'brokers_contract_amount_field')), commissionAmountInput]),
    ]));
    commissionsSlot.appendChild(el('div', { class: 'form-actions' }, [recordCommissionBtn]));

    const commissionsLoading = loadingState();
    commissionsSlot.appendChild(commissionsLoading);
    try {
      const page = await api.get('/api/brokers/commissions', { limit: 20, offset: commissionsOffset });
      commissionsLoading.remove();
      commissionsSlot.appendChild(table(
        [
          { label: t(locale, 'brokers_broker_company_field'), key: 'brokerCompanyId' },
          { label: t(locale, 'brokers_col_contract'), render: (c) => c.contractId.slice(0, 8) + '…' },
          { label: t(locale, 'sales_col_amount'), render: (c) => Number(c.amount).toLocaleString() },
          { label: t(locale, 'units_col_status'), render: (c) => statusBadge(c.status) },
          { label: '', render: (c) => {
            if (c.status !== 'pending') return '';
            const btn = el('button', { class: 'primary' }, t(locale, 'brokers_approve_btn'));
            btn.addEventListener('click', () => approveCommission(c, btn));
            return btn;
          } },
        ],
        page.items,
        { empty: t(locale, 'brokers_empty_commissions') },
      ));
      commissionsSlot.appendChild(paginationControls(page, (next) => { commissionsOffset = next; load(); }));
    } catch (err) {
      commissionsLoading.remove();
      commissionsSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
