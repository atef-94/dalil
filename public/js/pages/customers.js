import { el, clear, table, errorBanner, loadingState, badge, paginationControls, searchInput } from '../ui.js';
import { api } from '../api.js';

export async function renderCustomers(container) {
  clear(container);
  let offset = 0;
  let q = '';
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, 'Customers'),
      el('p', { class: 'page-subtitle' }, 'Every lead that has been granted Customer Portal access. Grant access from a lead\'s detail on the Leads page.'),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const search = searchInput('Search by name, phone, or email…', (value) => { q = value; offset = 0; load(); });
  container.appendChild(el('div', { class: 'form-row', style: 'max-width:320px' }, [search]));

  const listSlot = el('div');
  container.appendChild(listSlot);

  async function load() {
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/customers', { limit: 20, offset, q });
      clear(listSlot);
      listSlot.appendChild(table(
        [
          { label: 'Name', key: 'fullName' },
          { label: 'Phone', key: 'phone' },
          { label: 'Email', render: (c) => c.email || '—' },
          { label: 'Portal access', render: () => badge('active', 'green') },
          { label: 'Since', render: (c) => new Date(c.createdAt).toLocaleDateString() },
        ],
        page.items,
        { empty: 'No customers yet — grant portal access to a lead from the Leads page.', emptyIcon: 'customers' },
      ));
      listSlot.appendChild(paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      clear(listSlot);
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
