import { el, clear, table, errorBanner, paginationControls } from '../ui.js';
import { api } from '../api.js';

export async function renderAudit(container) {
  clear(container);
  let offset = 0;
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, 'Audit Log')));
  const listSlot = el('div');
  container.appendChild(listSlot);

  async function load() {
    clear(listSlot);
    try {
      const page = await api.get('/api/audit-log', { limit: 25, offset });
      listSlot.append(table(
        [
          { label: 'When', render: (e) => new Date(e.createdAt).toLocaleString() },
          { label: 'Actor', key: 'actorUserId' },
          { label: 'Action', key: 'action' },
          { label: 'Resource', render: (e) => `${e.resource} (${e.resourceId.slice(0, 8)}…)` },
        ],
        page.items,
        { empty: 'No audit entries yet.' },
      ), paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
