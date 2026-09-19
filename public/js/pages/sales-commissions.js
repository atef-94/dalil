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
      el('p', { class: 'page-subtitle' }, 'Base and manager-override commission lines, recorded automatically when a contract is signed.'),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const tierSelect = selectInput([{ value: 'base', label: 'Base (credited employee)' }, { value: 'override', label: 'Override (their manager)' }]);
  const employeeInput = el('input', { type: 'text', placeholder: 'Employee user ID (optional — blank = company-wide default)' });
  const rateInput = el('input', { type: 'number', placeholder: 'e.g. 2', step: '0.01', min: '0', max: '100' });
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
      await api.post('/api/sales-commissions/rules', { tier: tierSelect.value, ratePercent: rate, employeeUserId: employeeInput.value.trim() || undefined });
      rateInput.value = ''; employeeInput.value = '';
      toast('Commission rate saved.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      setRateBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Commission rates'),
    el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, 'An employee-specific rate overrides the company-wide default for that tier. "Override" pays the credited employee\'s direct manager.'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Tier'), tierSelect]),
      el('div', {}, [el('label', {}, 'Employee (optional)'), employeeInput]),
      el('div', {}, [el('label', {}, 'Rate (%)'), rateInput]),
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
      toast('Commission approved.', 'success');
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
      toast('Commission marked as paid.', 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function clawback(c) {
    const result = await formModal({
      title: `Claw back commission ${c.id.slice(0, 8)}…`,
      fields: [{ key: 'reason', label: 'Reason', type: 'textarea', placeholder: 'e.g. contract was cancelled' }],
      submitLabel: 'Claw back',
    });
    if (!result || !result.reason.trim()) return;
    if (!(await confirmModal(`Claw back ${Number(c.amount).toLocaleString()} from this commission? This cannot be undone.`, { confirmLabel: 'Claw back', danger: true }))) return;
    try {
      await api.post(`/api/sales-commissions/${c.id}/clawback`, { reason: result.reason.trim() });
      toast('Commission clawed back.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    clear(rulesSlot);
    rulesSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Configured rates'));
    const rulesLoading = loadingState();
    rulesSlot.appendChild(rulesLoading);
    try {
      const rules = await api.get('/api/sales-commissions/rules');
      rulesLoading.remove();
      rulesSlot.appendChild(table(
        [
          { label: 'Tier', render: (r) => statusBadge(r.tier) },
          { label: 'Applies to', render: (r) => r.employeeUserId || 'Company-wide default' },
          { label: 'Rate', render: (r) => `${r.ratePercent}%` },
        ],
        rules,
        { empty: 'No commission rates configured yet — set one above.' },
      ));
    } catch (err) {
      rulesLoading.remove();
      rulesSlot.appendChild(errorBanner(err.message));
    }

    clear(commissionsSlot);
    commissionsSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Commission lines'));
    const loading = loadingState();
    commissionsSlot.appendChild(loading);
    try {
      const page = await api.get('/api/sales-commissions', { limit: 20, offset });
      loading.remove();
      commissionsSlot.appendChild(table(
        [
          { label: 'Employee', render: (c) => c.employeeUserId.slice(0, 8) + '…' },
          { label: 'Tier', render: (c) => statusBadge(c.tier) },
          { label: 'Contract', render: (c) => c.contractId.slice(0, 8) + '…' },
          { label: 'Rate', render: (c) => `${c.ratePercent}%` },
          { label: 'Amount', render: (c) => Number(c.amount).toLocaleString() },
          { label: 'Status', render: (c) => statusBadge(c.status) },
          { label: '', render: (c) => {
            const actions = el('div', { style: 'display:flex;gap:6px' });
            if (c.status === 'pending') {
              const btn = el('button', { class: 'primary' }, 'Approve');
              btn.addEventListener('click', () => approve(c, btn));
              actions.appendChild(btn);
            }
            if (c.status === 'approved') {
              const payBtn = el('button', {}, 'Mark paid');
              payBtn.addEventListener('click', () => pay(c, payBtn));
              actions.appendChild(payBtn);
            }
            if (c.status === 'approved' || c.status === 'paid') {
              const clawbackBtn = el('button', { class: 'danger' }, 'Claw back');
              clawbackBtn.addEventListener('click', () => clawback(c));
              actions.appendChild(clawbackBtn);
            }
            return actions;
          } },
        ],
        page.items,
        { empty: 'No commissions recorded yet — they appear automatically once a contract is signed and a rate is configured.' },
      ));
      commissionsSlot.appendChild(paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      loading.remove();
      commissionsSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
