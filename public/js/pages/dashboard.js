import { el, clear, icon, statCard, errorBanner, statusBadge } from '../ui.js';
import { api } from '../api.js';
import { session, can } from '../state.js';

export async function renderDashboard(container) {
  clear(container);
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, 'Dashboard')));

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
    statCard({ label: 'Leads', value: leads, iconName: 'leads' }),
    statCard({ label: 'Offers', value: opportunities, iconName: 'opportunities' }),
    statCard({ label: 'Units', value: units, iconName: 'units' }),
    statCard({ label: 'Employees', value: employees, iconName: 'employees' }),
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
      aiPanel.appendChild(el('div', { class: 'ai-panel-header' }, [icon('ai'), 'AI activity']));
      if (approvalsPage.items.length > 0) {
        aiPanel.appendChild(el('p', {}, [
          el('strong', {}, `${approvalsPage.items.length} item(s) waiting on your approval`),
          ' — see ',
          el('a', { href: '#/approvals' }, 'Approvals'),
          '.',
        ]));
      }
      if (recentDecisions.length === 0) {
        aiPanel.appendChild(el('p', { style: 'color:var(--text-muted);font-size:13px' }, 'No AI agent decisions yet — try "Ask AI" on a lead in the CRM, or run one from AI Agents.'));
      } else {
        for (const d of recentDecisions) {
          aiPanel.appendChild(el('div', { style: 'display:flex;align-items:baseline;gap:8px;padding:6px 0;border-top:1px solid var(--brand-100);font-size:13px' }, [
            statusBadge(d.status),
            el('span', {}, `${d.agentKey}: ${d.reasoning}`),
          ]));
        }
        aiPanel.appendChild(el('div', { style: 'margin-top:8px' }, [el('a', { href: '#/ai-activity' }, 'See full AI activity →')]));
      }
    } catch (err) {
      clear(aiPanel);
      aiPanel.appendChild(errorBanner(err.message));
    }
  }

  const info = el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Your workspace'),
    el('p', {}, [el('strong', {}, 'Company ID: '), session.me?.companyId || '—']),
    el('p', {}, [el('strong', {}, 'Signed in as: '), session.me?.email || '—', ` (${session.me?.userType || ''})`]),
    el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, 'Share the Company ID above with teammates so they can log in to this same workspace, or invite them from Employees → create employee, then assign a role from Roles & Permissions.'),
  ]);
  container.appendChild(info);
}
