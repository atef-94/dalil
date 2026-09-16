import { el, clear } from '../ui.js';
import { api } from '../api.js';
import { session } from '../state.js';

export async function renderDashboard(container) {
  clear(container);
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, 'Dashboard')));

  const grid = el('div', { class: 'stat-grid' });
  container.appendChild(grid);

  function stat(label, value) {
    grid.appendChild(el('div', { class: 'stat-card' }, [
      el('div', { class: 'value' }, String(value)),
      el('div', { class: 'label' }, label),
    ]));
  }

  const results = await Promise.allSettled([
    api.get('/api/crm/leads', { limit: 1 }),
    api.get('/api/sales/opportunities', { limit: 1 }),
    api.get('/api/inventory/units', { limit: 1 }),
    api.get('/api/organization/employees', { limit: 1 }),
  ]);
  const [leads, opportunities, units, employees] = results.map((r) => (r.status === 'fulfilled' ? r.value.total : '—'));

  stat('Leads', leads);
  stat('Opportunities', opportunities);
  stat('Units', units);
  stat('Employees', employees);

  const info = el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Your workspace'),
    el('p', {}, [el('strong', {}, 'Company ID: '), session.me?.companyId || '—']),
    el('p', {}, [el('strong', {}, 'Signed in as: '), session.me?.email || '—', ` (${session.me?.userType || ''})`]),
    el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, 'Share the Company ID above with teammates so they can log in to this same workspace, or invite them from Employees → create employee, then assign a role from Roles & Permissions.'),
  ]);
  container.appendChild(info);
}
