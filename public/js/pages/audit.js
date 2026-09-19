import { el, clear, table, errorBanner, paginationControls, loadingState } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

export async function renderAudit(container) {
  clear(container);
  const locale = getLocale();
  let offset = 0;
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, t(locale, 'page_title_audit'))));
  const listSlot = el('div');
  container.appendChild(listSlot);

  async function load() {
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/audit-log', { limit: 25, offset });
      clear(listSlot);
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
