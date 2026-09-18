import { el, clear, table, toast, errorBanner, statusBadge, selectInput, confirmModal } from '../ui.js';
import { api } from '../api.js';
import { can } from '../state.js';
import { openImportWizard } from '../import-wizard.js';

export async function renderFinance(container) {
  clear(container);
  const headerActions = el('div');
  container.appendChild(el('div', { class: 'page-header' }, [
    el('h1', {}, 'Finance & Collections'),
    headerActions,
  ]));
  if (can('payment_schedule', 'edit')) {
    const importBtn = el('button', {}, 'Import Payments');
    importBtn.addEventListener('click', () => {
      openImportWizard({
        title: 'Import Payments',
        uploadPath: '/api/finance/payments/import/upload',
        onImported: () => { load(); },
      });
    });
    headerActions.appendChild(importBtn);
  }
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const sweepBtn = el('button', {}, 'Sweep overdue payments now');
  sweepBtn.addEventListener('click', async () => {
    clear(errorSlot);
    sweepBtn.disabled = true;
    try {
      const result = await api.post('/api/finance/sweep-overdue', {});
      toast(`${result.swept} schedule line(s) marked overdue.`, 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      sweepBtn.disabled = false;
    }
  });
  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Overdue sweep'),
    el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, 'Runs automatically every 60 seconds on the server; trigger it on demand here.'),
    sweepBtn,
  ]));

  const contractSelect = selectInput([]);
  const balanceOutput = el('div');
  const scheduleSlot = el('div');
  const contractActionsSlot = el('div');
  const loadBalanceBtn = el('button', {}, 'Load balance & schedule');

  async function cancelSelectedContract() {
    if (!contractSelect.value) return;
    if (!(await confirmModal('Cancel this contract? The unit is released back onto the market and the reservation is cancelled. Already-recorded payments stay on file.', { confirmLabel: 'Cancel contract', danger: true }))) return;
    try {
      await api.post(`/api/sales/contracts/${contractSelect.value}/cancel`, {});
      toast('Contract cancelled.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  const recordAmount = el('input', { type: 'number', placeholder: 'Amount' });
  const recordMethod = selectInput(['cash', 'transfer', 'card', 'cheque'].map((m) => ({ value: m, label: m })));
  const recordLineSelect = selectInput([]);
  const recordBtn = el('button', { class: 'primary' }, 'Record payment');

  recordBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!contractSelect.value || !recordLineSelect.value) {
      errorSlot.appendChild(errorBanner('Choose a contract and a schedule line first.'));
      return;
    }
    if (!(Number(recordAmount.value) > 0)) {
      errorSlot.appendChild(errorBanner('Enter a payment amount greater than zero.'));
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
      toast('Payment recorded.', 'success');
      recordAmount.value = '';
      await loadContractDetail();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      recordBtn.disabled = false;
    }
  });

  const refundLineSelect = selectInput([]);
  const refundAmount = el('input', { type: 'number', placeholder: 'Amount' });
  const refundReason = el('input', { type: 'text', placeholder: 'Why is this being refunded?' });
  const refundBtn = el('button', { class: 'danger' }, 'Request refund');

  refundBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!contractSelect.value || !refundLineSelect.value) {
      errorSlot.appendChild(errorBanner('Choose a contract and a paid schedule line first.'));
      return;
    }
    if (!(Number(refundAmount.value) > 0)) {
      errorSlot.appendChild(errorBanner('Enter a refund amount greater than zero.'));
      return;
    }
    if (!refundReason.value.trim()) {
      errorSlot.appendChild(errorBanner('A reason is required for every refund request.'));
      return;
    }
    if (!(await confirmModal('Refunds always require approval before any money moves. Submit this refund request?'))) return;
    refundBtn.disabled = true;
    try {
      await api.post('/api/finance/refunds', {
        contractId: contractSelect.value,
        paymentScheduleLineId: refundLineSelect.value,
        amount: Number(refundAmount.value),
        reason: refundReason.value.trim(),
      });
      toast('Refund request submitted — pending approval. See the Approvals page for its status.', 'success');
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
        const cancelBtn = el('button', { class: 'danger' }, 'Cancel contract');
        cancelBtn.addEventListener('click', cancelSelectedContract);
        contractActionsSlot.appendChild(cancelBtn);
      } else {
        contractActionsSlot.appendChild(statusBadge(contract.status));
      }
      balanceOutput.appendChild(el('div', { class: 'stat-grid' }, [
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(balance.totalDue).toLocaleString()), el('div', { class: 'label' }, 'Total due')]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(balance.totalPaid).toLocaleString()), el('div', { class: 'label' }, 'Total paid')]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(balance.outstanding).toLocaleString()), el('div', { class: 'label' }, 'Outstanding')]),
      ]));
      lines.forEach((l) => {
        if (l.status !== 'paid') {
          recordLineSelect.appendChild(el('option', { value: l.id }, `${l.label} — ${Number(l.amount - l.amountPaid).toLocaleString()} remaining`));
        }
        if (l.amountPaid > 0) {
          refundLineSelect.appendChild(el('option', { value: l.id }, `${l.label} — ${Number(l.amountPaid).toLocaleString()} paid`));
        }
      });
      if (refundLineSelect.options.length === 0) {
        refundLineSelect.appendChild(el('option', { value: '' }, 'No paid lines to refund yet'));
      }
      scheduleSlot.appendChild(table(
        [
          { label: 'Line', key: 'label' },
          { label: 'Due date', render: (l) => new Date(l.dueDate).toLocaleDateString() },
          { label: 'Amount', render: (l) => Number(l.amount).toLocaleString() },
          { label: 'Paid', render: (l) => Number(l.amountPaid).toLocaleString() },
          { label: 'Status', render: (l) => statusBadge(l.status) },
        ],
        lines,
        { empty: 'No schedule lines for this contract.' },
      ));
    } catch (err) {
      balanceOutput.appendChild(errorBanner(err.message));
    }
  }
  contractSelect.addEventListener('change', loadContractDetail);
  loadBalanceBtn.addEventListener('click', loadContractDetail);

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Contract balance & schedule'),
    el('div', { class: 'form-row' }, [el('div', {}, [el('label', {}, 'Contract'), contractSelect]), el('div', { style: 'align-self:flex-end' }, loadBalanceBtn)]),
    contractActionsSlot,
    balanceOutput,
    scheduleSlot,
  ]));

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Record a payment'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Schedule line'), recordLineSelect]),
      el('div', {}, [el('label', {}, 'Amount'), recordAmount]),
      el('div', {}, [el('label', {}, 'Method'), recordMethod]),
    ]),
    el('div', { class: 'form-actions' }, [recordBtn]),
  ]));

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Request a refund'),
    el('p', { class: 'page-subtitle' }, 'Reverses money already collected on a paid line. Always requires approval before it takes effect — see the Approvals page to track it.'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Paid schedule line'), refundLineSelect]),
      el('div', {}, [el('label', {}, 'Amount'), refundAmount]),
      el('div', {}, [el('label', {}, 'Reason'), refundReason]),
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
