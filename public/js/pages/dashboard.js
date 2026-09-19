import { el, clear, icon, statCard, errorBanner, statusBadge } from '../ui.js';
import { api } from '../api.js';
import { session, can, getLocale } from '../state.js';
import { t } from '../i18n.js';

export async function renderDashboard(container) {
  clear(container);
  const locale = getLocale();
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, t(locale, 'dashboard_title'))));

  const grid = el('div', { class: 'stat-grid' });
  container.appendChild(grid);

  const results = await Promise.allSettled([
    api.get('/api/crm/leads', { limit: 1 }),
    api.get('/api/sales/opportunities', { limit: 1 }),
    api.get('/api/inventory/units', { limit: 1 }),
    api.get('/api/organization/employees', { limit: 1 }),
  ]);
  const [leads, opportunities, units, employees] = results.map((r) => (r.status === 'fulfilled' ? r.value.total : '—'));

  grid.append(
    statCard({ label: t(locale, 'dashboard_stat_leads'), value: leads, iconName: 'leads' }),
    statCard({ label: t(locale, 'dashboard_stat_offers'), value: opportunities, iconName: 'opportunities' }),
    statCard({ label: t(locale, 'dashboard_stat_units'), value: units, iconName: 'units' }),
    statCard({ label: t(locale, 'dashboard_stat_employees'), value: employees, iconName: 'employees' }),
  );

  // ---- AI-native: recent agent activity + anything waiting on a human ----
  if (can('ai_action', 'view')) {
    const aiPanel = el('div', { class: 'ai-panel' });
    container.appendChild(aiPanel);
    try {
      const [decisionsPage, approvalsPage] = await Promise.all([
        api.get('/api/ai/decisions', { limit: 5 }),
        can('approval', 'view') ? api.get('/api/automation/approvals', { status: 'pending', limit: 5 }) : Promise.resolve({ items: [] }),
      ]);
      const recentDecisions = decisionsPage.items.slice().reverse().slice(0, 4);
      aiPanel.appendChild(el('div', { class: 'ai-panel-header' }, [icon('ai'), t(locale, 'dashboard_ai_activity')]));
      if (approvalsPage.items.length > 0) {
        aiPanel.appendChild(el('p', {}, [
          el('strong', {}, `${approvalsPage.items.length} ${t(locale, 'dashboard_ai_pending_approval')}`),
          ' — ',
          el('a', { href: '#/approvals' }, t(locale, 'dashboard_ai_see_approvals')),
          '.',
        ]));
      }
      if (recentDecisions.length === 0) {
        aiPanel.appendChild(el('p', { style: 'color:var(--text-muted);font-size:13px' }, t(locale, 'dashboard_ai_no_decisions')));
      } else {
        for (const d of recentDecisions) {
          aiPanel.appendChild(el('div', { style: 'display:flex;align-items:baseline;gap:8px;padding:6px 0;border-top:1px solid var(--brand-100);font-size:13px' }, [
            statusBadge(d.status),
            el('span', {}, `${d.agentKey}: ${d.reasoning}`),
          ]));
        }
        aiPanel.appendChild(el('div', { style: 'margin-top:8px' }, [el('a', { href: '#/ai-activity' }, t(locale, 'dashboard_ai_see_all'))]));
      }
    } catch (err) {
      clear(aiPanel);
      aiPanel.appendChild(errorBanner(err.message));
    }
  }

  const info = el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'dashboard_workspace_title')),
    el('p', {}, [el('strong', {}, `${t(locale, 'dashboard_company_id')} `), session.me?.companyId || '—']),
    el('p', {}, [el('strong', {}, `${t(locale, 'dashboard_signed_in_as')} `), session.me?.email || '—', ` (${session.me?.userType || ''})`]),
    el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, t(locale, 'dashboard_invite_hint')),
  ]);
  container.appendChild(info);
}
