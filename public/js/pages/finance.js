import { el, clear, table, toast, errorBanner, statusBadge, selectInput } from '../ui.js';
import { api } from '../api.js';

export async function renderFinance(container) {
  clear(container);
  container.appendChild(el('div', { class: 'page-header' }, [
    el('h1', {}, 'Finance & Collections'),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const sweepBtn = el('button', {}, 'Sweep overdue payments now');
  sweepBtn.addEventListener('click', async () => {
    try {
      const result = await api.post('/api/finance/sweep-overdue', {});
      toast(`${result.swept} schedule line(s) marked overdue.`, 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
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
  const loadBalanceBtn = el('button', {}, 'Load balance & schedule');

  const recordAmount = el('input', { type: 'number', placeholder: 'Amount' });
  const recordMethod = selectInput(['cash', 'transfer', 'card', 'cheque'].map((m) => ({ value: m, label: m })));
  const recordLineSelect = selectInput([]);
  const recordBtn = el('button', { class: 'primary' }, 'Record payment');

  recordBtn.addEventListener('click', async () => {
    if (!contractSelect.value || !recordLineSelect.value) return;
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
    }
  });

  async function loadContractDetail() {
    clear(balanceOutput);
    clear(scheduleSlot);
    clear(recordLineSelect);
    if (!contractSelect.value) return;
    try {
      const [balance, lines] = await Promise.all([
        api.get(`/api/finance/contracts/${contractSelect.value}/balance`),
        api.get(`/api/contracts/${contractSelect.value}/payment-schedule`),
      ]);
      balanceOutput.appendChild(el('div', { class: 'stat-grid' }, [
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(balance.totalDue).toLocaleString()), el('div', { class: 'label' }, 'Total due')]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(balance.totalPaid).toLocaleString()), el('div', { class: 'label' }, 'Total paid')]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(balance.outstanding).toLocaleString()), el('div', { class: 'label' }, 'Outstanding')]),
      ]));
      lines.forEach((l) => {
        if (l.status !== 'paid') {
          recordLineSelect.appendChild(el('option', { value: l.id }, `${l.label} — ${Number(l.amount - l.amountPaid).toLocaleString()} remaining`));
        }
      });
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
