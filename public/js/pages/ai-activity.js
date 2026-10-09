import { el, clear, table, errorBanner, statusBadge, loadingState, statCard, paginationControls, badge } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

export async function renderAiActivity(container) {
  clear(container);
  const locale = getLocale();
  let decisionsOffset = 0;
  let requestsOffset = 0;
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, t(locale, 'page_title_ai_activity')),
      el('p', { class: 'page-subtitle' }, [t(locale, 'ai_activity_subtitle_prefix'), el('a', { href: '#/approvals' }, t(locale, 'nav_approvals')), t(locale, 'ai_activity_subtitle_suffix')]),
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
        statsSlot.appendChild(statCard({ label: agentKey, value: s.total, iconName: 'ai', trend: { text: `${s.proceeded} ${t(locale, 'ai_activity_proceeded_word')} · ${s.escalated} ${t(locale, 'ai_activity_escalated_word')}` } }));
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
      decisionsSlot.appendChild(el('h3', {}, t(locale, 'ai_activity_decision_history_heading')));
      decisionsSlot.appendChild(table(
        [
          { label: t(locale, 'automation_field_agent'), key: 'agentKey' },
          { label: t(locale, 'ai_workflows_col_subject'), render: (d) => `${d.subjectType}:${d.subjectId.slice(0, 8)}…` },
          { label: t(locale, 'ai_activity_col_chosen_action'), render: (d) => d.chosenActionType || '—' },
          { label: t(locale, 'ai_activity_col_risk'), render: (d) => d.riskLevel ? badge(d.riskLevel, d.riskLevel === 'high' ? 'red' : d.riskLevel === 'medium' ? 'amber' : 'green') : '—' },
          { label: t(locale, 'ai_activity_col_approval_req'), render: (d) => d.approvalRequired === undefined ? '—' : (d.approvalRequired ? t(locale, 'crm_yes') : t(locale, 'crm_no')) },
          { label: t(locale, 'ai_activity_col_confidence'), render: (d) => `${d.confidence}%` },
          { label: t(locale, 'ai_col_reasoning'), render: (d) => el('span', { class: 'wrap' }, d.reasoning) },
          { label: t(locale, 'ai_activity_col_next_step'), render: (d) => el('span', { class: 'wrap' }, d.nextRecommendedStep || '—') },
          { label: t(locale, 'automation_label_status'), render: (d) => statusBadge(d.status) },
          { label: t(locale, 'ai_col_when'), render: (d) => new Date(d.createdAt).toLocaleString() },
        ],
        page.items.slice().reverse(),
        { empty: t(locale, 'ai_activity_empty_decisions'), emptyIcon: 'ai' },
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
      requestsSlot.appendChild(el('h3', {}, t(locale, 'ai_activity_requests_heading')));
      requestsSlot.appendChild(table(
        [
          { label: t(locale, 'automation_field_action'), key: 'actionType' },
          { label: t(locale, 'ai_activity_col_requested_by'), key: 'requestedByUserId' },
          { label: t(locale, 'ai_col_reasoning'), render: (r) => el('span', { class: 'wrap' }, r.reasoning || '') },
          { label: t(locale, 'automation_label_status'), render: (r) => statusBadge(r.status) },
          // Never assumes success just because the tool call didn't
          // throw — this reflects a real re-read of the affected entity
          // (see ai-agent.service.ts's verifyExecution). Blank until the
          // request reaches 'executed' (nothing to verify before then).
          { label: t(locale, 'ai_activity_col_verified'), render: (r) => (r.status === 'executed' ? statusBadge(r.verificationStatus || 'not_applicable') : '') },
          { label: t(locale, 'ai_col_when'), render: (r) => new Date(r.createdAt).toLocaleString() },
        ],
        page.items.slice().reverse(),
        { empty: t(locale, 'ai_activity_empty_requests'), emptyIcon: 'ai' },
      ));
      requestsSlot.appendChild(paginationControls(page, (next) => { requestsOffset = next; loadRequests(); }));
    } catch (err) {
      clear(requestsSlot);
      requestsSlot.appendChild(errorBanner(err.message));
    }
  }

  await Promise.all([loadStats(), loadDecisions(), loadRequests()]);
}
