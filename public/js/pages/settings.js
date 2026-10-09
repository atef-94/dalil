import { el, clear, errorBanner, loadingState } from '../ui.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { session, getLocale } from '../state.js';

export async function renderSettings(container) {
  clear(container);
  const locale = getLocale();
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, t(locale, 'page_title_settings'))));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const companySlot = el('div', { class: 'card' }, [el('h3', { style: 'margin-top:0' }, t(locale, 'settings_company_heading')), loadingState()]);
  container.appendChild(companySlot);

  try {
    const company = await api.get('/api/organization/company');
    clear(companySlot);
    companySlot.appendChild(el('h3', { style: 'margin-top:0' }, t(locale, 'settings_company_heading')));
    companySlot.appendChild(el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'crm_col_name')), el('div', {}, company.name)]),
      el('div', {}, [el('label', {}, t(locale, 'field_company_id')), el('div', {}, el('code', {}, company.companyId))]),
      el('div', {}, [el('label', {}, t(locale, 'settings_created_field')), el('div', {}, new Date(company.createdAt).toLocaleDateString())]),
    ]));
    companySlot.appendChild(el('p', { class: 'page-subtitle', style: 'margin-top:10px' }, t(locale, 'settings_share_company_id_hint')));
  } catch (err) {
    clear(companySlot);
    companySlot.appendChild(errorBanner(err.message));
  }

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'settings_your_account_heading')),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'field_email')), el('div', {}, session.me?.email || '—')]),
      el('div', {}, [el('label', {}, t(locale, 'settings_account_type_field')), el('div', {}, session.me?.userType || '—')]),
      el('div', {}, [el('label', {}, t(locale, 'employees_job_title_field')), el('div', {}, session.me?.employee?.title || '—')]),
    ]),
  ]));

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'settings_more_settings_heading')),
    el('p', { class: 'page-subtitle' }, [
      t(locale, 'settings_more1'),
      el('a', { href: '#/ai' }, t(locale, 'nav_ai')),
      t(locale, 'settings_more2'),
      el('a', { href: '#/automation' }, t(locale, 'nav_automation')),
      t(locale, 'settings_more3'),
      el('a', { href: '#/roles' }, t(locale, 'nav_roles')),
      t(locale, 'settings_more4'),
    ]),
  ]));
}
