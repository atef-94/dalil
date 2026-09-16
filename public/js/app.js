import { el, clear } from './ui.js';
import { isAuthenticated, clearToken } from './api.js';
import { loadSession, session, getLocale, setLocale } from './state.js';
import { registerRoute, startRouter } from './router.js';
import { t } from './i18n.js';
import { renderLogin } from './pages/login.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderEmployees } from './pages/employees.js';
import { renderRoles } from './pages/roles.js';
import { renderLeads } from './pages/leads.js';
import { renderOpportunities } from './pages/opportunities.js';
import { renderUnits } from './pages/units.js';
import { renderTemplates } from './pages/templates.js';
import { renderFinance } from './pages/finance.js';
import { renderBrokers } from './pages/brokers.js';
import { renderAudit } from './pages/audit.js';

const NAV = [
  { path: '/dashboard', labelKey: 'nav_dashboard', render: renderDashboard },
  { path: '/leads', labelKey: 'nav_leads', render: renderLeads },
  { path: '/opportunities', labelKey: 'nav_opportunities', render: renderOpportunities },
  { path: '/units', labelKey: 'nav_units', render: renderUnits },
  { path: '/templates', labelKey: 'nav_templates', render: renderTemplates },
  { path: '/finance', labelKey: 'nav_finance', render: renderFinance },
  { path: '/brokers', labelKey: 'nav_brokers', render: renderBrokers },
  { path: '/employees', labelKey: 'nav_employees', render: renderEmployees },
  { path: '/roles', labelKey: 'nav_roles', render: renderRoles },
  { path: '/audit', labelKey: 'nav_audit', render: renderAudit },
];

const root = document.getElementById('app');

function applyLocale(locale) {
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
}

async function showApp() {
  clear(root);
  const locale = getLocale();
  applyLocale(locale);

  const navLinks = {};
  const nav = el('nav', {}, NAV.map((item) => {
    const a = el('a', { href: `#${item.path}` }, t(locale, item.labelKey));
    navLinks[item.path] = a;
    return a;
  }));

  const localeToggle = el('select', { id: 'locale-toggle' }, [
    el('option', { value: 'en', selected: locale === 'en' ? '' : undefined }, 'English'),
    el('option', { value: 'ar', selected: locale === 'ar' ? '' : undefined }, 'العربية'),
  ]);
  localeToggle.value = locale;
  localeToggle.addEventListener('change', () => {
    setLocale(localeToggle.value);
    showApp();
  });

  const logoutBtn = el('button', {}, t(locale, 'logout'));
  logoutBtn.addEventListener('click', () => {
    clearToken();
    showAuth();
  });

  const content = el('div', { id: 'content' });

  const shell = el('div', { id: 'app-shell' }, [
    el('aside', { id: 'sidebar' }, [
      el('div', { class: 'brand' }, t(locale, 'appName')),
      el('div', { class: 'company-name' }, session.me?.employee?.title ? `${session.me.email} · ${session.me.employee.title}` : session.me?.email || ''),
      nav,
    ]),
    el('div', { id: 'main' }, [
      el('div', { id: 'topbar' }, [localeToggle, logoutBtn]),
      content,
    ]),
  ]);
  root.appendChild(shell);

  NAV.forEach((item) => registerRoute(item.path, item.render));

  async function onRouteChange(path) {
    const match = NAV.find((item) => item.path === path);
    Object.entries(navLinks).forEach(([p, a]) => a.classList.toggle('active', p === path));
    if (!match) {
      clear(content);
      content.appendChild(el('div', { class: 'empty-state' }, 'Page not found.'));
      return;
    }
    try {
      await match.render(content);
    } catch (err) {
      clear(content);
      content.appendChild(el('div', { class: 'error-banner' }, err.message || 'Something went wrong loading this page.'));
    }
  }

  startRouter(onRouteChange);
}

function showAuth() {
  clear(root);
  renderLogin(root, {
    onSuccess: async () => {
      await bootstrap();
    },
  });
}

async function bootstrap() {
  if (!isAuthenticated()) {
    showAuth();
    return;
  }
  try {
    await loadSession();
  } catch {
    clearToken();
    showAuth();
    return;
  }
  await showApp();
}

bootstrap();
