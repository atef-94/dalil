import { el, clear, table, errorBanner, loadingState, badge } from '../ui.js';
import { api } from '../api.js';

export async function renderCustomers(container) {
  clear(container);
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, 'Customers'),
      el('p', { class: 'page-subtitle' }, 'Every lead that has been granted Customer Portal access. Grant access from a lead\'s detail on the Leads page.'),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const listSlot = el('div');
  container.appendChild(listSlot);

  async function load() {
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/customers', { limit: 100 });
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
    } catch (err) {
      clear(listSlot);
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
