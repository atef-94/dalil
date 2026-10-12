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
          { label: t(locale, 'audit_col_when'), render: (e) => new Date(e.createdAt).toLocaleString() },
          { label: t(locale, 'audit_col_actor'), key: 'actorUserId' },
          { label: t(locale, 'audit_col_action'), key: 'action' },
          { label: t(locale, 'audit_col_resource'), render: (e) => `${e.resource} (${e.resourceId.slice(0, 8)}…)` },
        ],
        page.items,
        { empty: t(locale, 'audit_empty') },
      ), paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
