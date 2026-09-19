import { el, clear, icon, errorBanner, emptyState, deniedState } from './ui.js';
import { isAuthenticated, clearToken } from './api.js';
import { loadSession, session, getLocale, setLocale, can } from './state.js';
import { registerRoute, startRouter, navigate } from './router.js';
import { t } from './i18n.js';
import { renderLogin } from './pages/login.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderEmployees } from './pages/employees.js';
import { renderRoles } from './pages/roles.js';
import { renderCrm } from './pages/crm.js';
import { mountAiAssistant, clearAiContext } from './pages/ai-panel.js';
import { renderUnits } from './pages/units.js';
import { renderFinance } from './pages/finance.js';
import { renderBrokers } from './pages/brokers.js';
import { renderSalesCommissions } from './pages/sales-commissions.js';
import { renderAudit } from './pages/audit.js';
import { renderHr } from './pages/hr.js';
import { renderOperations } from './pages/operations.js';
import { renderLegal } from './pages/legal.js';
import { renderPurchasing } from './pages/purchasing.js';
import { renderMarketing } from './pages/marketing.js';
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
import { renderForecasting } from './pages/forecasting.js';
import { renderScenarioSimulation } from './pages/scenario-simulation.js';

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
  // Leads, Follow-ups, Customers, Offers, Payment Plans, Quotations,
  // Reservations, Contracts, Communications, and Tasks are the Sales/CRM
  // lifecycle — per the sidebar restructuring, they live as tabs inside the
  // single CRM workspace (see crm.js's moduleTabs) instead of as separate
  // top-level sections. Nothing was rebuilt: every one of those pages still
  // exists exactly as before and is simply mounted into CRM's tab body.
  { section: 'section_sales', items: [
    { path: '/crm', labelKey: 'nav_crm', render: renderCrm, icon: 'leads', resource: 'lead', action: 'view' },
  ] },
  { section: 'section_inventory', items: [
    { path: '/units', labelKey: 'nav_units', render: renderUnits, icon: 'units', resource: 'unit', action: 'view' },
  ] },
  { section: 'section_finance', items: [
    { path: '/finance', labelKey: 'nav_finance', render: renderFinance, icon: 'finance', resource: 'payment_schedule', action: 'view' },
    { path: '/brokers', labelKey: 'nav_brokers', render: renderBrokers, icon: 'brokers', resource: 'broker_company', action: 'view' },
    { path: '/sales-commissions', labelKey: 'nav_sales_commissions', render: renderSalesCommissions, icon: 'commissions', resource: 'sales_commission', action: 'view' },
  ] },
  { section: 'section_growth', items: [
    { path: '/marketing', labelKey: 'nav_marketing', render: renderMarketing, icon: 'marketing', resource: 'campaign', action: 'view' },
    { path: '/analytics', labelKey: 'nav_analytics', render: renderAnalytics, icon: 'analytics', resource: 'analytics', action: 'view' },
    { path: '/forecasting', labelKey: 'nav_forecasting', render: renderForecasting, icon: 'forecasting', resource: 'forecast', action: 'view' },
    { path: '/scenario-simulation', labelKey: 'nav_scenario_simulation', render: renderScenarioSimulation, icon: 'scenario', resource: 'forecast', action: 'view' },
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

  // Mounted once, outside the router's content area, so it's visible on
  // every route — not just the CRM workspace.
  mountAiAssistant();

  flatNav().forEach((item) => registerRoute(item.path, item.render));

  // Two rounds of sidebar changes keep old links working instead of
  // 404ing: "Opportunities" was renamed to "Offers" (module/RBAC/routes
  // unchanged, only the name), and the whole Sales/CRM lifecycle — Offers
  // included — then moved from standalone top-level pages into tabs
  // inside the single CRM workspace. Every one of these now lands on CRM
  // itself; the specific module remains one click away as a CRM tab.
  const LEGACY_PATH_REDIRECTS = {
    '/opportunities': '/crm',
    '/offers': '/crm',
    '/customers': '/crm',
    '/contracts': '/crm',
    '/reservations': '/crm',
    '/templates': '/crm',
    '/quotations': '/crm',
    '/communication': '/crm',
  };

  async function onRouteChange(path) {
    if (LEGACY_PATH_REDIRECTS[path]) {
      navigate(LEGACY_PATH_REDIRECTS[path]);
      return;
    }
    closeSidebar();
    if (path !== '/crm') clearAiContext(); // stale lead context shouldn't follow you to another page
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
