import { el, clear, table, errorBanner, statusBadge, loadingState, selectInput, paginationControls } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

export async function renderReservations(container) {
  clear(container);
  const locale = getLocale();
  let offset = 0;
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, t(locale, 'page_title_reservations')),
      el('p', { class: 'page-subtitle' }, t(locale, 'reservations_page_subtitle')),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const statusFilter = selectInput([
    { value: '', label: t(locale, 'reservations_status_all_option') },
    { value: 'active', label: t(locale, 'reservations_status_active_option') },
    { value: 'converted', label: t(locale, 'reservations_status_converted_option') },
    { value: 'cancelled', label: t(locale, 'reservations_status_cancelled_option') },
  ]);
  statusFilter.addEventListener('change', () => { offset = 0; load(); });
  container.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'form-row' }, [el('div', { style: 'max-width:220px' }, [el('label', {}, t(locale, 'units_col_status')), statusFilter])]),
  ]));

  const listSlot = el('div');
  container.appendChild(listSlot);

  async function load() {
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const [reservationsPage, leadsPage, unitsPage] = await Promise.all([
        api.get('/api/inventory/reservations', { limit: 20, offset, status: statusFilter.value || undefined }),
        api.get('/api/crm/leads', { limit: 200 }),
        api.get('/api/inventory/units', { limit: 200 }),
      ]);
      const leadById = new Map(leadsPage.items.map((l) => [l.id, l]));
      const unitById = new Map(unitsPage.items.map((u) => [u.id, u]));
      clear(listSlot);
      listSlot.appendChild(table(
        [
          { label: t(locale, 'sales_col_unit'), render: (r) => unitById.get(r.unitId)?.code ?? r.unitId },
          { label: t(locale, 'sales_col_client'), render: (r) => leadById.get(r.clientId)?.fullName ?? r.clientId },
          { label: t(locale, 'units_col_status'), render: (r) => statusBadge(r.status) },
          { label: t(locale, 'automation_col_created'), render: (r) => new Date(r.createdAt).toLocaleString() },
          { label: t(locale, 'reservations_col_expires'), render: (r) => {
            if (r.status !== 'active') return '—';
            const msLeft = Date.parse(r.expiresAt) - Date.now();
            const label = msLeft <= 0 ? t(locale, 'reservations_expired_label') : `${t(locale, 'reservations_expires_in_prefix')} ${Math.round(msLeft / 60000)} ${t(locale, 'reservations_minutes_suffix')}`;
            return el('span', { style: msLeft <= 0 ? 'color:var(--danger)' : '' }, label);
          } },
        ],
        reservationsPage.items,
        { empty: t(locale, 'reservations_empty'), emptyIcon: 'reservations' },
      ));
      listSlot.appendChild(paginationControls(reservationsPage, (next) => { offset = next; load(); }));
    } catch (err) {
      clear(listSlot);
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
