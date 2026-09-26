import { el, clear, table, toast, errorBanner, statusBadge, loadingState, selectInput, paginationControls, confirmModal, formModal } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

export async function renderSalesCommissions(container) {
  clear(container);
  const locale = getLocale();
  let offset = 0;
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, t(locale, 'page_title_sales_commissions')),
      el('p', { class: 'page-subtitle' }, t(locale, 'comm_page_subtitle')),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const tierSelect = selectInput([{ value: 'base', label: t(locale, 'comm_tier_base_option') }, { value: 'override', label: t(locale, 'comm_tier_override_option') }]);
  const employeeInput = el('input', { type: 'text', placeholder: t(locale, 'comm_employee_id_placeholder') });
  const rateInput = el('input', { type: 'number', placeholder: t(locale, 'comm_rate_placeholder'), step: '0.01', min: '0', max: '100' });
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
      await api.post('/api/sales-commissions/rules', { tier: tierSelect.value, ratePercent: rate, employeeUserId: employeeInput.value.trim() || undefined });
      rateInput.value = ''; employeeInput.value = '';
      toast(t(locale, 'brokers_toast_rate_saved'), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      setRateBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'brokers_commission_rates_heading')),
    el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, t(locale, 'comm_rate_override_hint')),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'comm_tier_field')), tierSelect]),
      el('div', {}, [el('label', {}, t(locale, 'comm_employee_field')), employeeInput]),
      el('div', {}, [el('label', {}, t(locale, 'brokers_rate_percent_field')), rateInput]),
    ]),
    el('div', { class: 'form-actions' }, [setRateBtn]),
  ]));

  const rulesSlot = el('div', { class: 'card' });
  const commissionsSlot = el('div', { class: 'card' });
  container.append(rulesSlot, commissionsSlot);

  async function approve(c, btn) {
    btn.disabled = true;
    try {
      await api.post(`/api/sales-commissions/${c.id}/approve`, {});
      toast(t(locale, 'brokers_toast_commission_approved'), 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function pay(c, btn) {
    btn.disabled = true;
    try {
      await api.post(`/api/sales-commissions/${c.id}/pay`, {});
      toast(t(locale, 'comm_toast_marked_paid'), 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function clawback(c) {
    const result = await formModal({
      title: `${t(locale, 'comm_clawback_title_prefix')} ${c.id.slice(0, 8)}…`,
      fields: [{ key: 'reason', label: t(locale, 'fin_reason_field'), type: 'textarea', placeholder: t(locale, 'comm_clawback_reason_placeholder') }],
      submitLabel: t(locale, 'comm_clawback_btn'),
    });
    if (!result || !result.reason.trim()) return;
    if (!(await confirmModal(`${t(locale, 'comm_clawback_btn')} ${Number(c.amount).toLocaleString()}${t(locale, 'comm_clawback_confirm_suffix')}`, { confirmLabel: t(locale, 'comm_clawback_btn'), danger: true }))) return;
    try {
      await api.post(`/api/sales-commissions/${c.id}/clawback`, { reason: result.reason.trim() });
      toast(t(locale, 'comm_toast_clawed_back'), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    clear(rulesSlot);
    rulesSlot.appendChild(el('h3', { style: 'margin-top:0' }, t(locale, 'comm_configured_rates_heading')));
    const rulesLoading = loadingState();
    rulesSlot.appendChild(rulesLoading);
    try {
      const rules = await api.get('/api/sales-commissions/rules');
      rulesLoading.remove();
      rulesSlot.appendChild(table(
        [
          { label: t(locale, 'comm_tier_field'), render: (r) => statusBadge(r.tier) },
          { label: t(locale, 'brokers_applies_to_field'), render: (r) => r.employeeUserId || t(locale, 'brokers_company_wide_default_option') },
          { label: t(locale, 'comm_rate_col'), render: (r) => `${r.ratePercent}%` },
        ],
        rules,
        { empty: t(locale, 'comm_rules_empty') },
      ));
    } catch (err) {
      rulesLoading.remove();
      rulesSlot.appendChild(errorBanner(err.message));
    }

    clear(commissionsSlot);
    commissionsSlot.appendChild(el('h3', { style: 'margin-top:0' }, t(locale, 'comm_lines_heading')));
    const loading = loadingState();
    commissionsSlot.appendChild(loading);
    try {
      const page = await api.get('/api/sales-commissions', { limit: 20, offset });
      loading.remove();
      commissionsSlot.appendChild(table(
        [
          { label: t(locale, 'comm_employee_col'), render: (c) => c.employeeUserId.slice(0, 8) + '…' },
          { label: t(locale, 'comm_tier_field'), render: (c) => statusBadge(c.tier) },
          { label: t(locale, 'brokers_col_contract'), render: (c) => c.contractId.slice(0, 8) + '…' },
          { label: t(locale, 'comm_rate_col'), render: (c) => `${c.ratePercent}%` },
          { label: t(locale, 'sales_col_amount'), render: (c) => Number(c.amount).toLocaleString() },
          { label: t(locale, 'units_col_status'), render: (c) => statusBadge(c.status) },
          { label: '', render: (c) => {
            const actions = el('div', { style: 'display:flex;gap:6px' });
            if (c.status === 'pending') {
              const btn = el('button', { class: 'primary' }, t(locale, 'brokers_approve_btn'));
              btn.addEventListener('click', () => approve(c, btn));
              actions.appendChild(btn);
            }
            if (c.status === 'approved') {
              const payBtn = el('button', {}, t(locale, 'comm_mark_paid_btn'));
              payBtn.addEventListener('click', () => pay(c, payBtn));
              actions.appendChild(payBtn);
            }
            if (c.status === 'approved' || c.status === 'paid') {
              const clawbackBtn = el('button', { class: 'danger' }, t(locale, 'comm_clawback_btn'));
              clawbackBtn.addEventListener('click', () => clawback(c));
              actions.appendChild(clawbackBtn);
            }
            return actions;
          } },
        ],
        page.items,
        { empty: t(locale, 'comm_commissions_empty') },
      ));
      commissionsSlot.appendChild(paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      loading.remove();
      commissionsSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
