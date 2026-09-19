import { el, clear, table, errorBanner, loadingState, badge, statusBadge, paginationControls, searchInput, contentModal } from '../ui.js';
import { api } from '../api.js';

async function openCustomer360(customer) {
  const body = el('div', {});
  body.appendChild(loadingState());
  const { close } = contentModal(`${customer.fullName} — Customer 360`, body, { wide: true });

  try {
    const profile = await api.get(`/api/customers/${customer.id}/360`);
    clear(body);

    body.appendChild(el('div', { class: 'stat-grid' }, [
      el('div', { class: 'stat-card' }, [el('div', {}, 'Offers'), el('h3', {}, String(profile.opportunities.length))]),
      el('div', { class: 'stat-card' }, [el('div', {}, 'Contracts'), el('h3', {}, String(profile.contracts.length))]),
      el('div', { class: 'stat-card' }, [el('div', {}, 'Open tasks'), el('h3', {}, String(profile.tasks.filter((t) => t.status === 'open').length))]),
    ]));

    body.appendChild(el('h3', {}, 'Offers'));
    body.appendChild(table(
      [
        { label: 'Stage', render: (o) => statusBadge(o.stage) },
        { label: 'Created', render: (o) => new Date(o.createdAt).toLocaleDateString() },
      ],
      profile.opportunities,
      { empty: 'No offers yet.' },
    ));

    body.appendChild(el('h3', {}, 'Contracts & payment schedules'));
    if (profile.contracts.length === 0) {
      body.appendChild(el('p', { class: 'muted' }, 'No contracts yet.'));
    }
    for (const contract of profile.contracts) {
      const scheduleEntry = profile.scheduleByContract.find((s) => s.contractId === contract.id);
      body.appendChild(el('div', { class: 'card', style: 'margin-bottom:12px' }, [
        el('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, [
          el('strong', {}, `Contract ${contract.id.slice(0, 8)}…`),
          statusBadge(contract.status),
        ]),
        table(
          [
            { label: 'Installment', key: 'label' },
            { label: 'Due', render: (l) => new Date(l.dueDate).toLocaleDateString() },
            { label: 'Amount', render: (l) => l.amount.toLocaleString() },
            { label: 'Paid', render: (l) => l.amountPaid.toLocaleString() },
            { label: 'Status', render: (l) => statusBadge(l.status) },
          ],
          scheduleEntry?.lines ?? [],
          { empty: 'No schedule generated yet.' },
        ),
      ]));
    }

    body.appendChild(el('h3', {}, 'Legal documents'));
    body.appendChild(table(
      [
        { label: 'Name', key: 'name' },
        { label: 'Type', key: 'type' },
        { label: 'Status', render: (d) => statusBadge(d.status) },
      ],
      profile.legalDocuments,
      { empty: 'No legal documents yet.' },
    ));

    body.appendChild(el('h3', {}, 'Tasks'));
    body.appendChild(table(
      [
        { label: 'Title', key: 'title' },
        { label: 'Due', render: (t) => t.dueAt ? new Date(t.dueAt).toLocaleDateString() : '—' },
        { label: 'Status', render: (t) => statusBadge(t.status) },
      ],
      profile.tasks,
      { empty: 'No tasks yet.' },
    ));

    body.appendChild(el('h3', {}, 'Communication history'));
    body.appendChild(table(
      [
        { label: 'Subject', key: 'subject' },
        { label: 'Channel', render: (m) => badge(m.channel, '') },
        { label: 'When', render: (m) => new Date(m.createdAt).toLocaleString() },
      ],
      profile.messages,
      { empty: 'No messages yet.' },
    ));
  } catch (err) {
    clear(body);
    body.appendChild(errorBanner(err.message));
  }
}

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
          { label: '', render: (c) => {
            const btn = el('button', {}, 'View 360');
            btn.addEventListener('click', () => openCustomer360(c));
            return btn;
          } },
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
