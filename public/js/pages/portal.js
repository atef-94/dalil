import { el, clear, table, errorBanner, statusBadge, loadingState } from '../ui.js';
import { api } from '../api.js';

export async function renderPortal(container) {
  clear(container);
  const body = el('div');
  body.appendChild(loadingState());
  container.appendChild(body);

  try {
    const [me, contractsPage] = await Promise.all([
      api.get('/api/portal/me'),
      api.get('/api/portal/contracts', { limit: 50 }),
    ]);

    clear(body);
    body.appendChild(el('div', { class: 'page-header' }, el('h1', {}, `Welcome, ${me.fullName}`)));

    if (contractsPage.items.length === 0) {
      body.appendChild(el('div', { class: 'empty-state' }, 'You have no contracts on file yet.'));
      container.appendChild(body);
      return;
    }

    for (const contract of contractsPage.items) {
      const card = el('div', { class: 'card' }, [
        el('h3', { style: 'margin-top:0' }, [`Contract ${contract.id.slice(0, 8)}… `, statusBadge(contract.status)]),
      ]);
      const scheduleSlot = el('div');
      scheduleSlot.appendChild(loadingState());
      card.appendChild(scheduleSlot);
      body.appendChild(card);

      try {
        const schedule = await api.get(`/api/portal/contracts/${contract.id}/schedule`);
        clear(scheduleSlot);
        const totalDue = schedule.reduce((sum, l) => sum + l.amount, 0);
        const totalPaid = schedule.reduce((sum, l) => sum + l.amountPaid, 0);
        scheduleSlot.appendChild(el('div', { class: 'stat-grid' }, [
          el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, totalDue.toLocaleString()), el('div', { class: 'label' }, 'Total due')]),
          el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, totalPaid.toLocaleString()), el('div', { class: 'label' }, 'Total paid')]),
          el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, (totalDue - totalPaid).toLocaleString()), el('div', { class: 'label' }, 'Outstanding')]),
        ]));
        scheduleSlot.appendChild(table(
          [
            { label: 'Installment', key: 'label' },
            { label: 'Due date', render: (l) => new Date(l.dueDate).toLocaleDateString() },
            { label: 'Amount', render: (l) => Number(l.amount).toLocaleString() },
            { label: 'Paid', render: (l) => Number(l.amountPaid).toLocaleString() },
            { label: 'Status', render: (l) => statusBadge(l.status) },
          ],
          schedule,
          { empty: 'No payment schedule yet for this contract.' },
        ));
      } catch (err) {
        clear(scheduleSlot);
        scheduleSlot.appendChild(errorBanner(err.message));
      }
    }
  } catch (err) {
    clear(body);
    body.appendChild(errorBanner(err.message));
  }
}
