import { el, clear, errorBanner, loadingState } from '../ui.js';
import { api } from '../api.js';
import { session } from '../state.js';

export async function renderSettings(container) {
  clear(container);
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, 'Settings')));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const companySlot = el('div', { class: 'card' }, [el('h3', { style: 'margin-top:0' }, 'Company'), loadingState()]);
  container.appendChild(companySlot);

  try {
    const company = await api.get('/api/organization/company');
    clear(companySlot);
    companySlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Company'));
    companySlot.appendChild(el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Name'), el('div', {}, company.name)]),
      el('div', {}, [el('label', {}, 'Company ID'), el('div', {}, el('code', {}, company.companyId))]),
      el('div', {}, [el('label', {}, 'Created'), el('div', {}, new Date(company.createdAt).toLocaleDateString())]),
    ]));
    companySlot.appendChild(el('p', { class: 'page-subtitle', style: 'margin-top:10px' }, 'Share the Company ID with teammates so they can sign in to this same workspace.'));
  } catch (err) {
    clear(companySlot);
    companySlot.appendChild(errorBanner(err.message));
  }

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Your account'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Email'), el('div', {}, session.me?.email || '—')]),
      el('div', {}, [el('label', {}, 'Account type'), el('div', {}, session.me?.userType || '—')]),
      el('div', {}, [el('label', {}, 'Title'), el('div', {}, session.me?.employee?.title || '—')]),
    ]),
  ]));

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'More settings'),
    el('p', { class: 'page-subtitle' }, [
      'AI autonomy policies (which actions may auto-execute vs. require approval) live on the ',
      el('a', { href: '#/ai' }, 'AI Agents'),
      ' page. Encrypted credentials for webhook calls live under Secrets on the ',
      el('a', { href: '#/automation' }, 'Automation'),
      ' page. Roles and permission grants live on ',
      el('a', { href: '#/roles' }, 'Roles & Permissions'),
      '.',
    ]),
  ]));
}
