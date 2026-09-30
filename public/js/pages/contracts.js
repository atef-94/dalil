import { el, clear, table, toast, errorBanner, statusBadge, loadingState, confirmModal, formModal, paginationControls } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

export async function renderContracts(container) {
  clear(container);
  const locale = getLocale();
  let offset = 0;
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, t(locale, 'page_title_contracts')),
      el('p', { class: 'page-subtitle' }, t(locale, 'contracts_page_subtitle')),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const thresholdInput = el('input', { type: 'number', placeholder: t(locale, 'contracts_threshold_placeholder'), step: '0.1', min: '0', max: '100' });
  const savePolicyBtn = el('button', {}, t(locale, 'contracts_save_policy_btn'));
  savePolicyBtn.addEventListener('click', async () => {
    clear(errorSlot);
    const threshold = Number(thresholdInput.value);
    if (!(threshold >= 0 && threshold <= 100)) {
      errorSlot.appendChild(errorBanner(t(locale, 'contracts_err_threshold_range')));
      return;
    }
    savePolicyBtn.disabled = true;
    try {
      await api.post('/api/sales/discount-policy', { maxDiscountPercentWithoutApproval: threshold });
      toast(t(locale, 'contracts_toast_policy_saved'), 'success');
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      savePolicyBtn.disabled = false;
    }
  });
  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'contracts_policy_heading')),
    el('p', { class: 'page-subtitle' }, t(locale, 'contracts_policy_hint')),
    el('div', { class: 'form-row' }, [el('div', {}, [el('label', {}, t(locale, 'contracts_max_discount_field')), thresholdInput])]),
    el('div', { class: 'form-actions' }, [savePolicyBtn]),
  ]));
  (async () => {
    try {
      const policy = await api.get('/api/sales/discount-policy');
      thresholdInput.value = policy.maxDiscountPercentWithoutApproval;
    } catch {
      // No policy configured yet — leave the field blank, matching "no gate at all".
    }
  })();

  const listSlot = el('div');
  container.appendChild(listSlot);

  async function viewSchedule(contract) {
    try {
      const lines = await api.get(`/api/contracts/${contract.id}/payment-schedule`);
      const modal = el('div', { class: 'modal-overlay' });
      const card = el('div', { class: 'modal-card', style: 'width:560px' }, [
        el('h3', { class: 'modal-title' }, `${t(locale, 'contracts_schedule_title_prefix')} ${contract.id.slice(0, 8)}…`),
        table(
          [
            { label: t(locale, 'contracts_col_line'), key: 'label' },
            { label: t(locale, 'sales_col_due_date'), render: (l) => new Date(l.dueDate).toLocaleDateString() },
            { label: t(locale, 'sales_col_amount'), render: (l) => Number(l.amount).toLocaleString() },
            { label: t(locale, 'contracts_col_paid'), render: (l) => Number(l.amountPaid).toLocaleString() },
            { label: t(locale, 'units_col_status'), render: (l) => statusBadge(l.status) },
          ],
          lines,
          { empty: t(locale, 'contracts_schedule_empty') },
        ),
        el('div', { class: 'form-actions', style: 'justify-content:flex-end' }, [
          (() => { const b = el('button', { class: 'primary' }, t(locale, 'common_close')); b.addEventListener('click', () => modal.remove()); return b; })(),
        ]),
      ]);
      modal.appendChild(card);
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
      document.body.appendChild(modal);
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function cancelContract(contract) {
    if (!(await confirmModal(t(locale, 'contracts_confirm_cancel_message'), { confirmLabel: t(locale, 'contracts_cancel_contract_confirm_label'), danger: true }))) return;
    try {
      await api.post(`/api/sales/contracts/${contract.id}/cancel`, {});
      toast(t(locale, 'contracts_toast_cancelled'), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  // Every amendment requires approval — no threshold escape, unlike the
  // discount-override gate on signing — so this always returns 202 with
  // a pending ActionApproval, never a directly-applied change.
  async function amendContract(contract) {
    const result = await formModal({
      title: `${t(locale, 'contracts_amend_title_prefix')} ${contract.id.slice(0, 8)}…`,
      fields: [
        { key: 'newTotalPrice', label: t(locale, 'contracts_new_total_price_field'), type: 'number', value: String(contract.totalPrice ?? '') },
        { key: 'discountPercent', label: t(locale, 'sales_discount_percent_optional_field'), type: 'number' },
        { key: 'reason', label: t(locale, 'contracts_amend_reason_field'), type: 'textarea' },
      ],
      submitLabel: t(locale, 'contracts_submit_for_approval_btn'),
    });
    if (!result || !result.newTotalPrice || !result.reason) return;
    try {
      await api.post(`/api/sales/contracts/${contract.id}/amend`, {
        newTotalPrice: Number(result.newTotalPrice),
        discountPercent: result.discountPercent ? Number(result.discountPercent) : undefined,
        reason: result.reason,
      });
      toast(t(locale, 'contracts_toast_amendment_submitted'), 'success');
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const [contractsPage, leadsPage, unitsPage] = await Promise.all([
        api.get('/api/sales/contracts', { limit: 20, offset }),
        api.get('/api/crm/leads', { limit: 200 }),
        api.get('/api/inventory/units', { limit: 200 }),
      ]);
      const leadById = new Map(leadsPage.items.map((l) => [l.id, l]));
      const unitById = new Map(unitsPage.items.map((u) => [u.id, u]));
      clear(listSlot);
      listSlot.appendChild(table(
        [
          { label: t(locale, 'sales_col_client'), render: (c) => leadById.get(c.clientId)?.fullName ?? c.clientId },
          { label: t(locale, 'sales_col_unit'), render: (c) => unitById.get(c.unitId)?.code ?? c.unitId },
          { label: t(locale, 'units_col_status'), render: (c) => statusBadge(c.status) },
          { label: t(locale, 'automation_col_created'), render: (c) => new Date(c.createdAt).toLocaleDateString() },
          { label: '', render: (c) => {
            const wrap = el('div', { style: 'display:flex;gap:6px' });
            const scheduleBtn = el('button', {}, t(locale, 'contracts_schedule_btn'));
            scheduleBtn.addEventListener('click', () => viewSchedule(c));
            wrap.appendChild(scheduleBtn);
            if (c.status === 'signed') {
              const amendBtn = el('button', {}, t(locale, 'contracts_amend_btn'));
              amendBtn.addEventListener('click', () => amendContract(c));
              wrap.appendChild(amendBtn);
              const cancelBtn = el('button', { class: 'danger' }, t(locale, 'common_cancel'));
              cancelBtn.addEventListener('click', () => cancelContract(c));
              wrap.appendChild(cancelBtn);
            }
            return wrap;
          } },
        ],
        contractsPage.items,
        { empty: t(locale, 'contracts_empty'), emptyIcon: 'contracts' },
      ));
      listSlot.appendChild(paginationControls(contractsPage, (next) => { offset = next; load(); }));
    } catch (err) {
      clear(listSlot);
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
