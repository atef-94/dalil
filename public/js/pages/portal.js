import { el, clear, table, errorBanner, statusBadge, loadingState } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

export async function renderPortal(container) {
  clear(container);
  const locale = getLocale();
  const body = el('div');
  body.appendChild(loadingState());
  container.appendChild(body);

  try {
    const [me, contractsPage] = await Promise.all([
      api.get('/api/portal/me'),
      api.get('/api/portal/contracts', { limit: 50 }),
    ]);

    clear(body);
    body.appendChild(el('div', { class: 'page-header' }, el('h1', {}, `${t(locale, 'portal_welcome_prefix')} ${me.fullName}`)));

    if (contractsPage.items.length === 0) {
      body.appendChild(el('div', { class: 'empty-state' }, t(locale, 'portal_no_contracts')));
      container.appendChild(body);
      return;
    }

    for (const contract of contractsPage.items) {
      const card = el('div', { class: 'card' }, [
        el('h3', { style: 'margin-top:0' }, [`${t(locale, 'portal_contract_prefix')} ${contract.id.slice(0, 8)}… `, statusBadge(contract.status)]),
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
          el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, totalDue.toLocaleString()), el('div', { class: 'label' }, t(locale, 'portal_total_due_label'))]),
          el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, totalPaid.toLocaleString()), el('div', { class: 'label' }, t(locale, 'portal_total_paid_label'))]),
          el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, (totalDue - totalPaid).toLocaleString()), el('div', { class: 'label' }, t(locale, 'portal_outstanding_label'))]),
        ]));
        scheduleSlot.appendChild(table(
          [
            { label: t(locale, 'portal_col_installment'), key: 'label' },
            { label: t(locale, 'sales_col_due_date'), render: (l) => new Date(l.dueDate).toLocaleDateString() },
            { label: t(locale, 'sales_col_amount'), render: (l) => Number(l.amount).toLocaleString() },
            { label: t(locale, 'contracts_col_paid'), render: (l) => Number(l.amountPaid).toLocaleString() },
            { label: t(locale, 'common_col_status'), render: (l) => statusBadge(l.status) },
          ],
          schedule,
          { empty: t(locale, 'portal_schedule_empty') },
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
