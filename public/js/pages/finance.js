import { el, clear, table, toast, errorBanner, statusBadge, selectInput, confirmModal } from '../ui.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { can, getLocale } from '../state.js';
import { openImportWizard } from '../import-wizard.js';

export async function renderFinance(container) {
  clear(container);
  const locale = getLocale();
  const headerActions = el('div');
  container.appendChild(el('div', { class: 'page-header' }, [
    el('h1', {}, t(locale, 'page_title_finance')),
    headerActions,
  ]));
  if (can('payment_schedule', 'edit')) {
    const importBtn = el('button', {}, t(locale, 'finance_import_payments_btn'));
    importBtn.addEventListener('click', () => {
      openImportWizard({
        title: t(locale, 'finance_import_payments_btn'),
        uploadPath: '/api/finance/payments/import/upload',
        onImported: () => { load(); },
      });
    });
    headerActions.appendChild(importBtn);
  }
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const sweepBtn = el('button', {}, t(locale, 'finance_sweep_btn'));
  sweepBtn.addEventListener('click', async () => {
    clear(errorSlot);
    sweepBtn.disabled = true;
    try {
      const result = await api.post('/api/finance/sweep-overdue', {});
      toast(`${result.swept}${t(locale, 'finance_toast_swept_suffix')}`, 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      sweepBtn.disabled = false;
    }
  });
  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'finance_overdue_sweep_heading')),
    el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, t(locale, 'finance_overdue_sweep_hint')),
    sweepBtn,
  ]));

  const contractSelect = selectInput([]);
  const balanceOutput = el('div');
  const scheduleSlot = el('div');
  const contractActionsSlot = el('div');
  const loadBalanceBtn = el('button', {}, t(locale, 'finance_load_balance_btn'));

  async function cancelSelectedContract() {
    if (!contractSelect.value) return;
    if (!(await confirmModal(t(locale, 'contracts_confirm_cancel_message'), { confirmLabel: t(locale, 'contracts_cancel_contract_confirm_label'), danger: true }))) return;
    try {
      await api.post(`/api/sales/contracts/${contractSelect.value}/cancel`, {});
      toast(t(locale, 'contracts_toast_cancelled'), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  const recordAmount = el('input', { type: 'number', placeholder: t(locale, 'sales_col_amount') });
  const recordMethod = selectInput(['cash', 'transfer', 'card', 'cheque'].map((m) => ({ value: m, label: m })));
  const recordLineSelect = selectInput([]);
  const recordBtn = el('button', { class: 'primary' }, t(locale, 'finance_record_payment_btn'));

  recordBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!contractSelect.value || !recordLineSelect.value) {
      errorSlot.appendChild(errorBanner(t(locale, 'finance_err_choose_contract_line')));
      return;
    }
    if (!(Number(recordAmount.value) > 0)) {
      errorSlot.appendChild(errorBanner(t(locale, 'finance_err_payment_amount_positive')));
      return;
    }
    recordBtn.disabled = true;
    try {
      await api.post('/api/finance/payments', {
        contractId: contractSelect.value,
        paymentScheduleLineId: recordLineSelect.value,
        amount: Number(recordAmount.value),
        method: recordMethod.value,
      });
      toast(t(locale, 'finance_toast_payment_recorded'), 'success');
      recordAmount.value = '';
      await loadContractDetail();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      recordBtn.disabled = false;
    }
  });

  const refundLineSelect = selectInput([]);
  const refundAmount = el('input', { type: 'number', placeholder: t(locale, 'sales_col_amount') });
  const refundReason = el('input', { type: 'text', placeholder: t(locale, 'finance_refund_reason_placeholder') });
  const refundBtn = el('button', { class: 'danger' }, t(locale, 'finance_request_refund_btn'));

  refundBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!contractSelect.value || !refundLineSelect.value) {
      errorSlot.appendChild(errorBanner(t(locale, 'finance_err_choose_contract_paid_line')));
      return;
    }
    if (!(Number(refundAmount.value) > 0)) {
      errorSlot.appendChild(errorBanner(t(locale, 'finance_err_refund_amount_positive')));
      return;
    }
    if (!refundReason.value.trim()) {
      errorSlot.appendChild(errorBanner(t(locale, 'finance_err_reason_required')));
      return;
    }
    if (!(await confirmModal(t(locale, 'finance_confirm_refund_message')))) return;
    refundBtn.disabled = true;
    try {
      await api.post('/api/finance/refunds', {
        contractId: contractSelect.value,
        paymentScheduleLineId: refundLineSelect.value,
        amount: Number(refundAmount.value),
        reason: refundReason.value.trim(),
      });
      toast(t(locale, 'finance_toast_refund_submitted'), 'success');
      refundAmount.value = '';
      refundReason.value = '';
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      refundBtn.disabled = false;
    }
  });

  async function loadContractDetail() {
    clear(balanceOutput);
    clear(scheduleSlot);
    clear(contractActionsSlot);
    clear(recordLineSelect);
    clear(refundLineSelect);
    if (!contractSelect.value) return;
    try {
      const [contract, balance, lines] = await Promise.all([
        api.get(`/api/sales/contracts/${contractSelect.value}`),
        api.get(`/api/finance/contracts/${contractSelect.value}/balance`),
        api.get(`/api/contracts/${contractSelect.value}/payment-schedule`),
      ]);
      if (contract.status === 'signed') {
        const cancelBtn = el('button', { class: 'danger' }, t(locale, 'contracts_cancel_contract_confirm_label'));
        cancelBtn.addEventListener('click', cancelSelectedContract);
        contractActionsSlot.appendChild(cancelBtn);
      } else {
        contractActionsSlot.appendChild(statusBadge(contract.status));
      }
      balanceOutput.appendChild(el('div', { class: 'stat-grid' }, [
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(balance.totalDue).toLocaleString()), el('div', { class: 'label' }, t(locale, 'finance_stat_total_due'))]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(balance.totalPaid).toLocaleString()), el('div', { class: 'label' }, t(locale, 'finance_stat_total_paid'))]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(balance.outstanding).toLocaleString()), el('div', { class: 'label' }, t(locale, 'finance_stat_outstanding'))]),
      ]));
      lines.forEach((l) => {
        if (l.status !== 'paid') {
          recordLineSelect.appendChild(el('option', { value: l.id }, `${l.label} — ${Number(l.amount - l.amountPaid).toLocaleString()}${t(locale, 'finance_remaining_suffix')}`));
        }
        if (l.amountPaid > 0) {
          refundLineSelect.appendChild(el('option', { value: l.id }, `${l.label} — ${Number(l.amountPaid).toLocaleString()}${t(locale, 'finance_paid_suffix')}`));
        }
      });
      if (refundLineSelect.options.length === 0) {
        refundLineSelect.appendChild(el('option', { value: '' }, t(locale, 'finance_no_paid_lines_option')));
      }
      scheduleSlot.appendChild(table(
        [
          { label: t(locale, 'contracts_col_line'), key: 'label' },
          { label: t(locale, 'sales_col_due_date'), render: (l) => new Date(l.dueDate).toLocaleDateString() },
          { label: t(locale, 'sales_col_amount'), render: (l) => Number(l.amount).toLocaleString() },
          { label: t(locale, 'contracts_col_paid'), render: (l) => Number(l.amountPaid).toLocaleString() },
          { label: t(locale, 'units_col_status'), render: (l) => statusBadge(l.status) },
        ],
        lines,
        { empty: t(locale, 'finance_schedule_empty') },
      ));
    } catch (err) {
      balanceOutput.appendChild(errorBanner(err.message));
    }
  }
  contractSelect.addEventListener('change', loadContractDetail);
  loadBalanceBtn.addEventListener('click', loadContractDetail);

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'finance_balance_schedule_heading')),
    el('div', { class: 'form-row' }, [el('div', {}, [el('label', {}, t(locale, 'finance_contract_field')), contractSelect]), el('div', { style: 'align-self:flex-end' }, loadBalanceBtn)]),
    contractActionsSlot,
    balanceOutput,
    scheduleSlot,
  ]));

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'finance_record_payment_heading')),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'finance_schedule_line_field')), recordLineSelect]),
      el('div', {}, [el('label', {}, t(locale, 'sales_col_amount')), recordAmount]),
      el('div', {}, [el('label', {}, t(locale, 'fin_method_field')), recordMethod]),
    ]),
    el('div', { class: 'form-actions' }, [recordBtn]),
  ]));

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'finance_refund_heading')),
    el('p', { class: 'page-subtitle' }, t(locale, 'finance_refund_subtitle')),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'finance_paid_schedule_line_field')), refundLineSelect]),
      el('div', {}, [el('label', {}, t(locale, 'sales_col_amount')), refundAmount]),
      el('div', {}, [el('label', {}, t(locale, 'fin_reason_field')), refundReason]),
    ]),
    el('div', { class: 'form-actions' }, [refundBtn]),
  ]));

  async function load() {
    try {
      const page = await api.get('/api/sales/contracts', { limit: 100 });
      clear(contractSelect);
      page.items.forEach((c) => contractSelect.appendChild(el('option', { value: c.id }, `${c.id.slice(0, 8)}… (${c.status})`)));
      if (page.items.length > 0) await loadContractDetail();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
