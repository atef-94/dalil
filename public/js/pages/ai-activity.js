import { el, clear, table, errorBanner, statusBadge, loadingState, statCard, paginationControls } from '../ui.js';
import { api } from '../api.js';

export async function renderAiActivity(container) {
  clear(container);
  let decisionsOffset = 0;
  let requestsOffset = 0;
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, 'AI Activity'),
      el('p', { class: 'page-subtitle' }, ['Every decision an agent has made and every action it requested, with full reasoning — the explainable trail behind each one. Act on anything pending in ', el('a', { href: '#/approvals' }, 'Approvals'), '.']),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const statsSlot = el('div', { class: 'stat-grid' });
  container.appendChild(statsSlot);

  async function loadStats() {
    clear(statsSlot);
    try {
      const stats = await api.get('/api/ai/agent-stats');
      for (const [agentKey, s] of Object.entries(stats)) {
        statsSlot.appendChild(statCard({ label: agentKey, value: s.total, iconName: 'ai', trend: { text: `${s.proceeded} proceeded · ${s.escalated} escalated` } }));
      }
    } catch (err) {
      statsSlot.appendChild(errorBanner(err.message));
    }
  }

  const decisionsSlot = el('div');
  container.appendChild(decisionsSlot);

  async function loadDecisions() {
    clear(decisionsSlot);
    decisionsSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/ai/decisions', { limit: 20, offset: decisionsOffset });
      clear(decisionsSlot);
      decisionsSlot.appendChild(el('h3', {}, 'Agent decision history'));
      decisionsSlot.appendChild(table(
        [
          { label: 'Agent', key: 'agentKey' },
          { label: 'Subject', render: (d) => `${d.subjectType}:${d.subjectId.slice(0, 8)}…` },
          { label: 'Chosen action', render: (d) => d.chosenActionType || '—' },
          { label: 'Confidence', render: (d) => `${d.confidence}%` },
          { label: 'Reasoning', render: (d) => el('span', { class: 'wrap' }, d.reasoning) },
          { label: 'Status', render: (d) => statusBadge(d.status) },
          { label: 'When', render: (d) => new Date(d.createdAt).toLocaleString() },
        ],
        page.items.slice().reverse(),
        { empty: 'No agent decisions yet — run one from AI Agents.', emptyIcon: 'ai' },
      ));
      decisionsSlot.appendChild(paginationControls(page, (next) => { decisionsOffset = next; loadDecisions(); }));
    } catch (err) {
      clear(decisionsSlot);
      decisionsSlot.appendChild(errorBanner(err.message));
    }
  }

  const requestsSlot = el('div');
  container.appendChild(requestsSlot);

  async function loadRequests() {
    clear(requestsSlot);
    requestsSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/ai/actions', { limit: 20, offset: requestsOffset });
      clear(requestsSlot);
      requestsSlot.appendChild(el('h3', {}, 'AI action requests'));
      requestsSlot.appendChild(table(
        [
          { label: 'Action', key: 'actionType' },
          { label: 'Requested by', key: 'requestedByUserId' },
          { label: 'Reasoning', render: (r) => el('span', { class: 'wrap' }, r.reasoning || '') },
          { label: 'Status', render: (r) => statusBadge(r.status) },
          { label: 'When', render: (r) => new Date(r.createdAt).toLocaleString() },
        ],
        page.items.slice().reverse(),
        { empty: 'No AI action requests yet — try "Ask AI" on a lead in the Leads page.', emptyIcon: 'ai' },
      ));
      requestsSlot.appendChild(paginationControls(page, (next) => { requestsOffset = next; loadRequests(); }));
    } catch (err) {
      clear(requestsSlot);
      requestsSlot.appendChild(errorBanner(err.message));
    }
  }

  await Promise.all([loadStats(), loadDecisions(), loadRequests()]);
}
