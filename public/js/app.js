import { el, clear, icon, errorBanner, emptyState, deniedState } from './ui.js';
import { isAuthenticated, clearToken } from './api.js';
import { loadSession, session, getLocale, setLocale, can } from './state.js';
import { registerRoute, startRouter } from './router.js';
import { t } from './i18n.js';
import { renderLogin } from './pages/login.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderEmployees } from './pages/employees.js';
import { renderRoles } from './pages/roles.js';
import { renderLeads } from './pages/leads.js';
import { renderCustomers } from './pages/customers.js';
import { renderOpportunities } from './pages/opportunities.js';
import { renderContracts } from './pages/contracts.js';
import { renderReservations } from './pages/reservations.js';
import { renderUnits } from './pages/units.js';
import { renderTemplates } from './pages/templates.js';
import { renderFinance } from './pages/finance.js';
import { renderBrokers } from './pages/brokers.js';
import { renderAudit } from './pages/audit.js';
import { renderHr } from './pages/hr.js';
import { renderOperations } from './pages/operations.js';
import { renderLegal } from './pages/legal.js';
import { renderPurchasing } from './pages/purchasing.js';
import { renderMarketing } from './pages/marketing.js';
import { renderCommunication } from './pages/communication.js';
import { renderAnalytics } from './pages/analytics.js';
import { renderPortal } from './pages/portal.js';
import { renderAutomation } from './pages/automation.js';
import { renderWorkflowHistory } from './pages/workflow-history.js';
import { renderApprovals } from './pages/approvals.js';
import { renderAi } from './pages/ai.js';
import { renderAiActivity } from './pages/ai-activity.js';
import { renderIntegrations } from './pages/integrations.js';
import { renderBranches } from './pages/branches.js';
import { renderSettings } from './pages/settings.js';

// Each item's `resource`/`action` is checked against the live permission
// manifest (state.js `can()`, backed by GET /api/me/manifest) before it's
// shown — a user never sees a nav entry for something their RBAC grants
// don't allow, even though the backend already rejects the request either
// way. `resource: null` means "always visible to any signed-in staff
// member" (Dashboard, Settings — every route inside gates its own actions).
const NAV = [
  { section: 'section_overview', items: [
    { path: '/dashboard', labelKey: 'nav_dashboard', render: renderDashboard, icon: 'dashboard', resource: null },
  ] },
  { section: 'section_sales', items: [
    { path: '/leads', labelKey: 'nav_leads', render: renderLeads, icon: 'leads', resource: 'lead', action: 'view' },
    { path: '/customers', labelKey: 'nav_customers', render: renderCustomers, icon: 'customers', resource: 'portal_access', action: 'view' },
    { path: '/opportunities', labelKey: 'nav_opportunities', render: renderOpportunities, icon: 'opportunities', resource: 'opportunity', action: 'view' },
    { path: '/contracts', labelKey: 'nav_contracts', render: renderContracts, icon: 'contracts', resource: 'contract', action: 'view' },
    { path: '/reservations', labelKey: 'nav_reservations', render: renderReservations, icon: 'reservations', resource: 'unit', action: 'view' },
    { path: '/units', labelKey: 'nav_units', render: renderUnits, icon: 'units', resource: 'unit', action: 'view' },
    { path: '/templates', labelKey: 'nav_templates', render: renderTemplates, icon: 'templates', resource: 'payment_plan_template', action: 'view' },
    { path: '/finance', labelKey: 'nav_finance', render: renderFinance, icon: 'finance', resource: 'payment_schedule', action: 'view' },
    { path: '/brokers', labelKey: 'nav_brokers', render: renderBrokers, icon: 'brokers', resource: 'broker_company', action: 'view' },
  ] },
  { section: 'section_growth', items: [
    { path: '/marketing', labelKey: 'nav_marketing', render: renderMarketing, icon: 'marketing', resource: 'campaign', action: 'view' },
    { path: '/communication', labelKey: 'nav_communication', render: renderCommunication, icon: 'communication', resource: 'message', action: 'view' },
    { path: '/analytics', labelKey: 'nav_analytics', render: renderAnalytics, icon: 'analytics', resource: 'analytics', action: 'view' },
  ] },
  { section: 'section_ops', items: [
    { path: '/operations', labelKey: 'nav_operations', render: renderOperations, icon: 'operations', resource: 'maintenance_ticket', action: 'view' },
    { path: '/legal', labelKey: 'nav_legal', render: renderLegal, icon: 'legal', resource: 'legal_document', action: 'view' },
    { path: '/purchasing', labelKey: 'nav_purchasing', render: renderPurchasing, icon: 'purchasing', resource: 'purchase_order', action: 'view' },
  ] },
  { section: 'section_automation', items: [
    { path: '/automation', labelKey: 'nav_automation', render: renderAutomation, icon: 'automation', resource: 'workflow', action: 'view' },
    { path: '/workflow-history', labelKey: 'nav_workflow_history', render: renderWorkflowHistory, icon: 'history', resource: 'workflow_run', action: 'view' },
    { path: '/approvals', labelKey: 'nav_approvals', render: renderApprovals, icon: 'approvals', resource: 'approval', action: 'view' },
    { path: '/ai', labelKey: 'nav_ai', render: renderAi, icon: 'ai', resource: 'ai_action', action: 'view' },
    { path: '/ai-activity', labelKey: 'nav_ai_activity', render: renderAiActivity, icon: 'bell', resource: 'ai_action', action: 'view' },
    { path: '/integrations', labelKey: 'nav_integrations', render: renderIntegrations, icon: 'integrations', resource: 'integration_connection', action: 'view' },
  ] },
  { section: 'section_admin', items: [
    { path: '/employees', labelKey: 'nav_employees', render: renderEmployees, icon: 'employees', resource: 'employee', action: 'view' },
    { path: '/hr', labelKey: 'nav_hr', render: renderHr, icon: 'hr', resource: 'leave_request', action: 'view' },
    { path: '/branches', labelKey: 'nav_branches', render: renderBranches, icon: 'branches', resource: 'branch', action: 'view' },
    { path: '/roles', labelKey: 'nav_roles', render: renderRoles, icon: 'roles', resource: 'role', action: 'view' },
    { path: '/audit', labelKey: 'nav_audit', render: renderAudit, icon: 'audit', resource: 'audit_log', action: 'view' },
    { path: '/settings', labelKey: 'nav_settings', render: renderSettings, icon: 'settings', resource: null },
  ] },
];

function flatNav() {
  return NAV.flatMap((s) => s.items);
}

function visibleNav() {
  return NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.resource === null || can(item.resource, item.action)),
  })).filter((section) => section.items.length > 0);
}

const root = document.getElementById('app');

function applyLocale(locale) {
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
}

async function showApp() {
  clear(root);
  const locale = getLocale();
  applyLocale(locale);

  const isCustomer = session.me?.userType === 'customer_user';
  const sections = isCustomer ? [] : visibleNav();

  const navLinks = {};
  const sidebarNav = el('nav', {});
  for (const section of sections) {
    sidebarNav.appendChild(el('div', { class: 'nav-section' }, [
      el('div', { class: 'nav-section-label' }, t(locale, section.section)),
      ...section.items.map((item) => {
        const a = el('a', { href: `#${item.path}` }, [icon(item.icon), el('span', {}, t(locale, item.labelKey))]);
        navLinks[item.path] = a;
        return a;
      }),
    ]));
  }

  const localeToggle = el('select', { id: 'locale-toggle' }, [
    el('option', { value: 'en', selected: locale === 'en' ? '' : undefined }, 'English'),
    el('option', { value: 'ar', selected: locale === 'ar' ? '' : undefined }, 'العربية'),
  ]);
  localeToggle.value = locale;
  localeToggle.addEventListener('change', () => {
    setLocale(localeToggle.value);
    showApp();
  });

  const logoutBtn = el('button', { class: 'ghost' }, t(locale, 'logout'));
  logoutBtn.addEventListener('click', () => {
    clearToken();
    showAuth();
  });

  const content = el('div', { id: 'content' });
  const topbarTitle = el('div', { id: 'topbar-title' }, '');

  const backdrop = el('div', { id: 'sidebar-backdrop' });
  const sidebarToggle = el('button', { id: 'sidebar-toggle', class: 'icon-btn ghost', 'aria-label': 'Toggle navigation' }, icon('menu'));
  const sidebarEl = el('aside', { id: 'sidebar' }, [
    el('div', { class: 'brand' }, [el('div', { class: 'mark' }, 'A'), t(locale, 'appName')]),
    el('div', { class: 'company-name' }, session.me?.employee?.title ? `${session.me.email} · ${session.me.employee.title}` : session.me?.email || ''),
    sidebarNav,
  ]);
  function closeSidebar() { sidebarEl.classList.remove('open'); backdrop.classList.remove('open'); }
  sidebarToggle.addEventListener('click', () => { sidebarEl.classList.toggle('open'); backdrop.classList.toggle('open'); });
  backdrop.addEventListener('click', closeSidebar);

  const shell = el('div', { id: 'app-shell' }, [
    backdrop,
    sidebarEl,
    el('div', { id: 'main' }, [
      el('div', { id: 'topbar' }, [
        el('div', { class: 'topbar-left' }, [sidebarToggle, topbarTitle]),
        el('div', { class: 'topbar-right' }, [localeToggle, logoutBtn]),
      ]),
      content,
    ]),
  ]);
  root.appendChild(shell);

  if (isCustomer) {
    // The customer portal is a single scoped view — no multi-page nav, no
    // access to any staff route or data outside this account's own
    // contracts (enforced server-side by /api/portal/*, not just hidden here).
    await renderPortal(content);
    return;
  }

  flatNav().forEach((item) => registerRoute(item.path, item.render));

  async function onRouteChange(path) {
    closeSidebar();
    const match = flatNav().find((item) => item.path === path);
    Object.entries(navLinks).forEach(([p, a]) => a.classList.toggle('active', p === path));
    if (!match) {
      clear(content);
      content.appendChild(emptyState({ icon: 'search', title: 'Page not found' }));
      return;
    }
    topbarTitle.textContent = t(locale, match.labelKey);
    try {
      await match.render(content);
    } catch (err) {
      clear(content);
      if (err.status === 403) {
        content.appendChild(deniedState(err.message));
      } else {
        content.appendChild(errorBanner(err.message || 'Something went wrong loading this page.'));
      }
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
