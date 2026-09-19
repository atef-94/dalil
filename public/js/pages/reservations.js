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
      el('p', { class: 'page-subtitle' }, 'Every unit currently held for a client while its contract is being finalized, and its expiry.'),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const statusFilter = selectInput([
    { value: '', label: 'All statuses' },
    { value: 'active', label: 'Active' },
    { value: 'converted', label: 'Converted to contract' },
    { value: 'cancelled', label: 'Cancelled' },
  ]);
  statusFilter.addEventListener('change', () => { offset = 0; load(); });
  container.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'form-row' }, [el('div', { style: 'max-width:220px' }, [el('label', {}, 'Status'), statusFilter])]),
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
          { label: 'Unit', render: (r) => unitById.get(r.unitId)?.code ?? r.unitId },
          { label: 'Client', render: (r) => leadById.get(r.clientId)?.fullName ?? r.clientId },
          { label: 'Status', render: (r) => statusBadge(r.status) },
          { label: 'Created', render: (r) => new Date(r.createdAt).toLocaleString() },
          { label: 'Expires', render: (r) => {
            if (r.status !== 'active') return '—';
            const msLeft = Date.parse(r.expiresAt) - Date.now();
            const label = msLeft <= 0 ? 'expired' : `in ${Math.round(msLeft / 60000)} min`;
            return el('span', { style: msLeft <= 0 ? 'color:var(--danger)' : '' }, label);
          } },
        ],
        reservationsPage.items,
        { empty: 'No reservations yet — reserve a unit from an Offer or from Inventory.', emptyIcon: 'reservations' },
      ));
      listSlot.appendChild(paginationControls(reservationsPage, (next) => { offset = next; load(); }));
    } catch (err) {
      clear(listSlot);
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
