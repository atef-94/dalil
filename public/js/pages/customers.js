import { el, clear, table, errorBanner, loadingState, badge, statusBadge, paginationControls, searchInput, contentModal } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

async function openCustomer360(customer, locale) {
  const body = el('div', {});
  body.appendChild(loadingState());
  const { close } = contentModal(`${customer.fullName} — ${t(locale, 'customers_360_suffix')}`, body, { wide: true });

  try {
    const profile = await api.get(`/api/customers/${customer.id}/360`);
    clear(body);

    body.appendChild(el('div', { class: 'stat-grid' }, [
      el('div', { class: 'stat-card' }, [el('div', {}, t(locale, 'nav_offers')), el('h3', {}, String(profile.opportunities.length))]),
      el('div', { class: 'stat-card' }, [el('div', {}, t(locale, 'nav_contracts')), el('h3', {}, String(profile.contracts.length))]),
      el('div', { class: 'stat-card' }, [el('div', {}, t(locale, 'customers_open_tasks')), el('h3', {}, String(profile.tasks.filter((t) => t.status === 'open').length))]),
    ]));

    body.appendChild(el('h3', {}, t(locale, 'nav_offers')));
    body.appendChild(table(
      [
        { label: t(locale, 'opportunities_col_stage'), render: (o) => statusBadge(o.stage) },
        { label: t(locale, 'crm_offer_col_created'), render: (o) => new Date(o.createdAt).toLocaleDateString() },
      ],
      profile.opportunities,
      { empty: t(locale, 'customers_offers_empty') },
    ));

    body.appendChild(el('h3', {}, t(locale, 'customers_contracts_schedules_title')));
    if (profile.contracts.length === 0) {
      body.appendChild(el('p', { class: 'muted' }, t(locale, 'customers_contracts_empty')));
    }
    for (const contract of profile.contracts) {
      const scheduleEntry = profile.scheduleByContract.find((s) => s.contractId === contract.id);
      body.appendChild(el('div', { class: 'card', style: 'margin-bottom:12px' }, [
        el('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, [
          el('strong', {}, `${t(locale, 'brokers_col_contract')} ${contract.id.slice(0, 8)}…`),
          statusBadge(contract.status),
        ]),
        table(
          [
            { label: t(locale, 'customers_installment'), key: 'label' },
            { label: t(locale, 'crm_task_col_due'), render: (l) => new Date(l.dueDate).toLocaleDateString() },
            { label: t(locale, 'sales_col_amount'), render: (l) => l.amount.toLocaleString() },
            { label: t(locale, 'contracts_col_paid'), render: (l) => l.amountPaid.toLocaleString() },
            { label: t(locale, 'units_col_status'), render: (l) => statusBadge(l.status) },
          ],
          scheduleEntry?.lines ?? [],
          { empty: t(locale, 'customers_schedule_empty') },
        ),
      ]));
    }

    body.appendChild(el('h3', {}, t(locale, 'customers_legal_documents_title')));
    body.appendChild(table(
      [
        { label: t(locale, 'crm_col_name'), key: 'name' },
        { label: t(locale, 'units_col_type'), key: 'type' },
        { label: t(locale, 'units_col_status'), render: (d) => statusBadge(d.status) },
      ],
      profile.legalDocuments,
      { empty: t(locale, 'customers_legal_empty') },
    ));

    body.appendChild(el('h3', {}, t(locale, 'nav_tasks')));
    body.appendChild(table(
      [
        { label: t(locale, 'crm_label_title'), key: 'title' },
        { label: t(locale, 'crm_task_col_due'), render: (t) => t.dueAt ? new Date(t.dueAt).toLocaleDateString() : '—' },
        { label: t(locale, 'units_col_status'), render: (t) => statusBadge(t.status) },
      ],
      profile.tasks,
      { empty: t(locale, 'customers_tasks_empty') },
    ));

    body.appendChild(el('h3', {}, t(locale, 'customers_comm_history_title')));
    body.appendChild(table(
      [
        { label: t(locale, 'automation_field_subject'), key: 'subject' },
        { label: t(locale, 'crm_activity_channel_field'), render: (m) => badge(m.channel, '') },
        { label: t(locale, 'ai_col_when'), render: (m) => new Date(m.createdAt).toLocaleString() },
      ],
      profile.messages,
      { empty: t(locale, 'customers_messages_empty') },
    ));
  } catch (err) {
    clear(body);
    body.appendChild(errorBanner(err.message));
  }
}

export async function renderCustomers(container) {
  clear(container);
  const locale = getLocale();
  let offset = 0;
  let q = '';
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, t(locale, 'page_title_customers')),
      el('p', { class: 'page-subtitle' }, t(locale, 'customers_page_subtitle')),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const search = searchInput(t(locale, 'crm_search_leads_placeholder'), (value) => { q = value; offset = 0; load(); });
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
          { label: t(locale, 'crm_col_name'), key: 'fullName' },
          { label: t(locale, 'crm_col_phone'), key: 'phone' },
          { label: t(locale, 'field_email'), render: (c) => c.email || '—' },
          { label: t(locale, 'customers_portal_access_col'), render: () => badge(t(locale, 'customers_portal_active'), 'green') },
          { label: t(locale, 'customers_since'), render: (c) => new Date(c.createdAt).toLocaleDateString() },
          { label: '', render: (c) => {
            const btn = el('button', {}, t(locale, 'customers_view_360_btn'));
            btn.addEventListener('click', () => openCustomer360(c, locale));
            return btn;
          } },
        ],
        page.items,
        { empty: t(locale, 'customers_list_empty'), emptyIcon: 'customers' },
      ));
      listSlot.appendChild(paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      clear(listSlot);
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
