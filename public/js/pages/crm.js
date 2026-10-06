import { el, clear, table, toast, errorBanner, statusBadge, badge, paginationControls, formModal, loadingState, searchInput, contentModal, tabs, statCard, emptyState, selectInput, icon, popover, field, collapsible } from '../ui.js';
import { api } from '../api.js';
import { can, getLocale, session } from '../state.js';
import { t } from '../i18n.js';
import { setAiContext, clearAiContext } from './ai-panel.js';
import { openImportWizard } from '../import-wizard.js';
import { renderOpportunities } from './opportunities.js';
import { renderQuotations } from './quotations.js';
import { renderCommunication } from './communication.js';
import { renderContracts } from './contracts.js';
import { renderReservations } from './reservations.js';
import { renderCustomers } from './customers.js';

/**
 * Sales/CRM restructuring: Leads, Offers, and Tasks live inside this one CRM
 * workspace instead of as separate top-level sidebar sections (see app.js's
 * NAV). "Activities" (also named in the restructuring spec) isn't a
 * separate tab: it's a lead's own timeline/composer, already in the lead
 * detail panel below.
 *
 * Payment Plans, Quotations, and Communication used to be their own
 * top-level tabs alongside Offers; they're now merged into a single
 * "Offers" tab as internal sub-sections (see renderOffersHub below), each
 * still reusing the exact same page component/API/RBAC gate as before —
 * nothing here is duplicated or rebuilt, only re-nested one level deeper.
 *
 * Payment Plan redesign: "خطط الدفع" (Payment Plan Templates) and "عروض
 * الأسعار" (Quotations) used to be two separate sub-tabs even though they'd
 * become the same underlying concept (a Quotation is now a full Payment
 * Plan: unit info + down payment/term/frequency + either equal installments
 * or installments-plus-scheduled-payments, with reusable templates as an
 * optional admin-only convenience folded into the same page — see
 * quotations.js's collapsible "Manage Reusable Templates" section). They're
 * merged into one 'sub:payment-plan' entry here. The other sub-tab that
 * used to read "Offers" (this one rendering the Opportunities deal
 * pipeline, a genuinely different concept — deal-stage tracking, not
 * pricing) is relabeled to nav_deal_pipeline so it's no longer confused
 * with pricing, per the user's explicit confirmation of this exact
 * consolidation.
 *
 * Reservations/Contracts/Customers: these were previously believed to be
 * redundant with the Dashboard's per-stage pipeline cards (a stage card
 * shows how many leads currently sit in e.g. a "Reservations" stage) and
 * were left unwired — but a stage card is a lead-stage COUNT, not a
 * Reservation/Contract/Customer MANAGEMENT view (expiry countdown/status
 * filter for reservations, cancel/amend/payment-schedule for contracts,
 * 360° profile for customers). That left three fully-built, fully-tested
 * pages (reservations.js/contracts.js/customers.js) with real backend
 * routes and no way to reach them at all — a genuine gap, not a deliberate
 * design choice. Restored here as three more sub-sections, following the
 * exact same reuse-the-existing-page pattern as Payment Plans/Quotations/
 * Communication above — nothing rebuilt, only re-nested.
 */
function offersSubSections(locale) {
  return [
    { key: 'sub:payment-plan', label: t(locale, 'nav_payment_plans'), resource: 'quotation', render: renderQuotations },
    { key: 'sub:customers', label: t(locale, 'nav_customers'), resource: 'portal_access', render: renderCustomers },
    { key: 'sub:communications', label: t(locale, 'nav_communication'), resource: 'message', render: renderCommunication },
  ];
}

const TIMELINE_ICONS = {
  lead_created: '✦', stage_changed: '↳', owner_changed: '⇄', lead_updated: '✎', message: '✉',
  task_created: '☐', task_completed: '☑', opportunity_created: '★', reservation_created: '⌂',
  contract_signed: '✔', contract_cancelled: '✖',
};

function timelineTypeLabels(locale) {
  return {
    lead_created: t(locale, 'crm_timeline_type_lead_created'),
    stage_changed: t(locale, 'crm_timeline_type_stage_changed'),
    owner_changed: t(locale, 'crm_timeline_type_owner_changed'),
    lead_updated: t(locale, 'crm_timeline_type_lead_updated'),
    message: t(locale, 'crm_timeline_type_message'),
    task_created: t(locale, 'crm_timeline_type_task_created'),
    task_completed: t(locale, 'crm_timeline_type_task_completed'),
    opportunity_created: t(locale, 'crm_timeline_type_opportunity_created'),
    reservation_created: t(locale, 'crm_timeline_type_reservation_created'),
    contract_signed: t(locale, 'crm_timeline_type_contract_signed'),
    contract_cancelled: t(locale, 'crm_timeline_type_contract_cancelled'),
  };
}

// Purely cosmetic: rotates KPI stat-card icon chips through the accent
// palette instead of every card reading the same color — see statCard's
// `tone` option in ui.js. Order/values/labels are untouched.
const STAT_TONES = ['blue', 'purple', 'teal', 'green', 'amber', 'pink'];

const PRIORITY_LABEL_KEYS = { low: 'crm_priority_low', medium: 'crm_priority_medium', high: 'crm_priority_high', urgent: 'crm_priority_urgent' };
function priorityLabel(locale, p) {
  return PRIORITY_LABEL_KEYS[p] ? t(locale, PRIORITY_LABEL_KEYS[p]) : p;
}

function priorityOptions(locale) {
  return [
    { value: '', label: '—' },
    { value: 'low', label: t(locale, 'crm_priority_low') },
    { value: 'medium', label: t(locale, 'crm_priority_medium') },
    { value: 'high', label: t(locale, 'crm_priority_high') },
    { value: 'urgent', label: t(locale, 'crm_priority_urgent') },
  ];
}

const LEAD_SOURCE_LABEL_KEYS = {
  facebook: 'crm_lead_source_facebook',
  google: 'crm_lead_source_google',
  referral: 'crm_lead_source_referral',
  whatsapp: 'crm_lead_source_whatsapp',
  instagram: 'crm_lead_source_instagram',
  tiktok: 'crm_lead_source_tiktok',
  other: 'crm_lead_source_other',
};
function leadSourceLabel(locale, source) {
  return LEAD_SOURCE_LABEL_KEYS[source] ? t(locale, LEAD_SOURCE_LABEL_KEYS[source]) : source;
}
function leadSourceOptions(locale) {
  return [{ value: '', label: '—' }, ...Object.keys(LEAD_SOURCE_LABEL_KEYS).map((value) => ({ value, label: leadSourceLabel(locale, value) }))];
}

const LEAD_INTEREST_LABEL_KEYS = {
  project: 'crm_lead_interest_project',
  unit: 'crm_lead_interest_unit',
  product: 'crm_lead_interest_product',
  service: 'crm_lead_interest_service',
  other: 'crm_lead_interest_other',
};
function leadInterestLabel(locale, type) {
  return LEAD_INTEREST_LABEL_KEYS[type] ? t(locale, LEAD_INTEREST_LABEL_KEYS[type]) : type;
}
function leadInterestOptions(locale) {
  return [{ value: '', label: '—' }, ...Object.keys(LEAD_INTEREST_LABEL_KEYS).map((value) => ({ value, label: leadInterestLabel(locale, value) }))];
}

export async function renderCrm(container) {
  clear(container);
  const locale = getLocale();

  let stages = [];        // active stages, ordered
  let employees = [];     // for the Add-Lead "Assigned Sales User" picker — empty for roles without view:employee
  let activeTab = 'dashboard';
  let offset = 0;
  let q = '';
  let leadFilters = { priority: '', source: '', ownerEmployeeUserId: '' };

  const toolbarSlot = el('div', { class: 'page-actions stacked' });
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, t(locale, 'crm_title')),
      el('p', { class: 'page-subtitle' }, t(locale, 'crm_subtitle')),
    ]),
    toolbarSlot,
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const tabsSlot = el('div');
  const bodySlot = el('div');
  container.appendChild(tabsSlot);
  container.appendChild(bodySlot);

  function reportError(err) {
    clear(errorSlot);
    errorSlot.appendChild(errorBanner(err.message));
  }

  // ---- Stage tabs + toolbar ----

  // Sales Agents don't have view:employee — the list route 403s for them,
  // so the picker just degrades to "no picker" and lead creation falls
  // back to today's automatic-owner-assignment behavior.
  async function loadEmployees() {
    if (!can('employee', 'view')) { employees = []; return; }
    try {
      const page = await api.get('/api/organization/employees', { limit: 200 });
      employees = page.items;
    } catch {
      employees = [];
    }
  }

  async function loadStages() {
    stages = await api.get('/api/crm/stages');
  }

  function renderToolbar() {
    clear(toolbarSlot);
    if (can('lead', 'create')) {
      const addLeadBtn = el('button', { class: 'primary' }, t(locale, 'crm_add_lead'));
      addLeadBtn.addEventListener('click', openAddLeadModal);
      toolbarSlot.appendChild(addLeadBtn);

      const importBtn = el('button', {}, t(locale, 'crm_import_leads'));
      importBtn.addEventListener('click', () => {
        openImportWizard({
          title: t(locale, 'crm_import_leads'),
          uploadPath: '/api/crm/leads/import/upload',
          onImported: () => { renderBody(); },
        });
      });
      toolbarSlot.appendChild(importBtn);
    }
    if (can('crm_stage', 'create')) {
      const addStageBtn = el('button', {}, t(locale, 'crm_add_stage'));
      addStageBtn.addEventListener('click', openAddStageModal);
      toolbarSlot.appendChild(addStageBtn);
    }
  }

  // Offers, Payment Plans, Quotations, and Communication are one top-level
  // "Offers" tab now, with the individual sections as an internal sub-tab
  // bar (see renderOffersHub) — the Offers tab itself only appears if at
  // least one of its sub-sections is visible to this user; each
  // sub-section still respects its own RBAC gate inside the hub. Tasks
  // reuses the existing TaskService API but had no dedicated list view
  // before.
  const offersSubTabs = offersSubSections(locale).filter((s) => can(s.resource, 'view'));
  let offersActiveSubTab = offersSubTabs[0]?.key;
  const moduleTabs = [
    ...(offersSubTabs.length > 0 ? [{ key: 'module:offers', label: t(locale, 'nav_offers'), render: renderOffersHub }] : []),
    { key: 'module:tasks', label: t(locale, 'nav_tasks'), resource: 'task', render: renderTasksTab },
  ].filter((m) => !m.resource || can(m.resource, 'view'));

  /** The "Offers" tab's own internal sub-tab bar: Offers / Payment Plans /
   * Quotations / Communication, each rendering the exact same page
   * component it always did — only the outer navigation changed. */
  async function renderOffersHub(target) {
    clear(target);
    const subTabsSlot = el('div');
    const subBodySlot = el('div');
    target.appendChild(subTabsSlot);
    target.appendChild(subBodySlot);

    function renderSubTabsBar() {
      clear(subTabsSlot);
      const items = offersSubTabs.map((s) => ({ key: s.key, label: s.label }));
      subTabsSlot.appendChild(tabs(items, offersActiveSubTab, (key) => {
        offersActiveSubTab = key;
        renderSubBody();
      }));
    }

    async function renderSubBody() {
      clear(subBodySlot);
      subBodySlot.appendChild(loadingState());
      try {
        const sub = offersSubTabs.find((s) => s.key === offersActiveSubTab);
        clear(subBodySlot);
        await sub.render(subBodySlot);
      } catch (err) {
        clear(subBodySlot);
        subBodySlot.appendChild(errorBanner(err.message));
      }
    }

    renderSubTabsBar();
    await renderSubBody();
  }

  // Dashboard is the first tab in the horizontal bar and is itself a hub
  // now, same pattern as Offers: Overview (the real-time stat cards) plus
  // Deal Pipeline / Reservations / Contracts as internal sub-tabs. Per-stage
  // lead lists still aren't separate tabs: a pipeline stat card inside
  // Overview is the way into that stage's lead list (see
  // renderDashboardOverview's statCard onClick below).
  // Built inline (not as a module-level helper like offersSubSections)
  // because renderDashboardOverview is a local closure function, not a
  // module-level import — a module-level helper can't see it.
  const dashboardSubTabs = [
    { key: 'sub:overview', label: t(locale, 'crm_pipeline_realtime'), resource: null, render: renderDashboardOverview },
    { key: 'sub:deal-pipeline', label: t(locale, 'nav_deal_pipeline'), resource: 'opportunity', render: renderOpportunities },
    { key: 'sub:reservations', label: t(locale, 'nav_reservations'), resource: 'unit', render: renderReservations },
    { key: 'sub:contracts', label: t(locale, 'nav_contracts'), resource: 'contract', render: renderContracts },
  ].filter((s) => !s.resource || can(s.resource, 'view'));
  let dashboardActiveSubTab = dashboardSubTabs[0]?.key;

  async function renderDashboardHub(target) {
    clear(target);
    const subTabsSlot = el('div');
    const subBodySlot = el('div');
    target.appendChild(subTabsSlot);
    target.appendChild(subBodySlot);

    function renderSubTabsBar() {
      clear(subTabsSlot);
      const items = dashboardSubTabs.map((s) => ({ key: s.key, label: s.label }));
      subTabsSlot.appendChild(tabs(items, dashboardActiveSubTab, (key) => {
        dashboardActiveSubTab = key;
        renderSubBody();
      }));
    }

    async function renderSubBody() {
      clear(subBodySlot);
      subBodySlot.appendChild(loadingState());
      try {
        const sub = dashboardSubTabs.find((s) => s.key === dashboardActiveSubTab);
        clear(subBodySlot);
        await sub.render(subBodySlot);
      } catch (err) {
        clear(subBodySlot);
        subBodySlot.appendChild(errorBanner(err.message));
      }
    }

    renderSubTabsBar();
    await renderSubBody();
  }
  function renderTabsBar() {
    clear(tabsSlot);
    const items = [
      { key: 'dashboard', label: t(locale, 'nav_dashboard') },
      ...moduleTabs.map((m) => ({ key: m.key, label: m.label })),
    ];
    tabsSlot.appendChild(tabs(items, activeTab, (key) => {
      activeTab = key;
      offset = 0;
      q = '';
      leadFilters = { priority: '', source: '', ownerEmployeeUserId: '' };
      renderBody();
    }));
  }

  /** Leaves whatever's currently shown (a module tab or a stage's lead
   * list) and returns to the Dashboard tab — reached via a stage-list's
   * own "Back to Pipeline" link. */
  function goToDashboard() {
    activeTab = 'dashboard';
    offset = 0;
    q = '';
    leadFilters = { priority: '', source: '', ownerEmployeeUserId: '' };
    renderTabsBar();
    renderBody();
  }

  async function renderBody() {
    clear(bodySlot);
    bodySlot.appendChild(loadingState());
    try {
      const moduleTab = moduleTabs.find((m) => m.key === activeTab);
      if (activeTab === 'dashboard') {
        clear(bodySlot);
        await renderDashboardHub(bodySlot);
      } else if (moduleTab) {
        clear(bodySlot);
        await moduleTab.render(bodySlot);
      } else {
        await renderStageList(activeTab);
      }
    } catch (err) {
      clear(bodySlot);
      bodySlot.appendChild(errorBanner(err.message));
    }
  }

  // ---- CRM Dashboard tab: Overview sub-tab (stat cards) ----

  async function renderDashboardOverview(target) {
    const [funnel, conversion, speed, costPerLead] = await Promise.all([
      api.get('/api/analytics/sales-funnel'),
      api.get('/api/analytics/funnel-conversion-rates'),
      api.get('/api/analytics/speed-to-first-contact'),
      api.get('/api/analytics/cost-per-qualified-lead'),
    ]);
    // A live snapshot — not stored counts — computed here from the same
    // leads list the per-stage view uses, so "new today"/"follow-ups"
    // always reflect real current data rather than a cached number.
    const sample = await api.get('/api/crm/leads', { limit: 200 });
    const stageById = new Map(funnel.stages.map((s) => [s.stageId, s]));
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const now = Date.now();
    const newToday = sample.items.filter((l) => Date.parse(l.createdAt) >= startOfToday.getTime()).length;
    const followUpsOverdue = sample.items.filter((l) => {
      const stage = stageById.get(l.stageId);
      if (!l.firstContactSlaDueAt || stage?.isWon || stage?.isLost) return false;
      return Date.parse(l.firstContactSlaDueAt) < now;
    }).length;
    const followUpsToday = sample.items.filter((l) => {
      const stage = stageById.get(l.stageId);
      if (!l.firstContactSlaDueAt || stage?.isWon || stage?.isLost) return false;
      const due = Date.parse(l.firstContactSlaDueAt);
      return due >= startOfToday.getTime() && due < startOfToday.getTime() + 24 * 60 * 60 * 1000;
    }).length;

    clear(target);
    target.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, t(locale, 'crm_pipeline_realtime')),
      el('div', { class: 'stat-grid' }, funnel.stages.map((s, i) => statCard({
        label: s.stageName,
        value: s.count,
        iconName: 'leads',
        tone: STAT_TONES[i % STAT_TONES.length],
        // Each pipeline card IS the way into that stage's lead list now —
        // the horizontal stage-tab row this used to require was removed
        // because it only duplicated these same cards.
        onClick: () => { activeTab = s.stageId; offset = 0; q = ''; leadFilters = { priority: '', source: '', ownerEmployeeUserId: '' }; renderBody(); },
      }))),
    ]));
    target.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, t(locale, 'crm_today_followups')),
      el('div', { class: 'stat-grid' }, [
        statCard({ label: t(locale, 'crm_new_today'), value: newToday, iconName: 'plus', tone: 'green' }),
        statCard({ label: t(locale, 'crm_followups_due_today'), value: followUpsToday, iconName: 'bell', tone: 'amber' }),
        statCard({ label: t(locale, 'crm_followups_overdue'), value: followUpsOverdue, iconName: 'warning', tone: 'pink' }),
        statCard({ label: t(locale, 'crm_total_leads'), value: funnel.totalLeads, iconName: 'leads', tone: 'blue' }),
      ]),
    ]));
    target.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, t(locale, 'crm_conversion')),
      el('div', { class: 'stat-grid' }, [
        statCard({ label: t(locale, 'crm_overall_win_rate'), value: `${conversion.overallWinRatePercent}%`, iconName: 'analytics', tone: 'green' }),
        statCard({ label: t(locale, 'crm_lost_rate'), value: `${conversion.lostRatePercent}%`, iconName: 'warning', tone: 'pink' }),
        statCard({ label: t(locale, 'crm_avg_speed'), value: speed.averageHours !== null ? `${speed.averageHours}h` : '—', iconName: 'history', tone: 'purple' }),
        statCard({ label: t(locale, 'crm_cost_per_qualified_lead'), value: costPerLead.costPerQualifiedLead !== null ? Number(costPerLead.costPerQualifiedLead).toLocaleString() : '—', iconName: 'commissions', tone: 'teal' }),
      ]),
      conversion.stageConversion.length > 0 ? el('div', { class: 'stat-grid', style: 'margin-top:10px' },
        conversion.stageConversion.map((s, i) => statCard({ label: `${s.fromStageName} → ${s.toStageName}`, value: `${s.conversionPercent}%`, iconName: 'analytics', tone: STAT_TONES[i % STAT_TONES.length] })),
      ) : null,
    ]));
  }

  // ---- Per-stage lead list ----

  function activeLeadFilterCount() {
    return Object.values(leadFilters).filter(Boolean).length;
  }

  /** The Filters popover: Priority / Source / Assigned Sales User — plain
   * equality filters over fields already on Lead (see the additive
   * priority/source/ownerEmployeeUserId query params on GET
   * /api/crm/leads). The Assigned Sales User option only appears when the
   * employee list loaded (same view:employee degradation as the Add Lead
   * modal's picker). Stage/status filtering is already the per-stage tab
   * navigation itself, so it isn't duplicated here; name/phone/email
   * search stays the separate existing search box. */
  function buildLeadFiltersPanel(close, onApply) {
    const prioritySelect = selectInput([{ value: '', label: t(locale, 'crm_card_filter_all') }, ...priorityOptions(locale).filter((o) => o.value)]);
    prioritySelect.value = leadFilters.priority;
    const sourceSelect = selectInput(leadSourceOptions(locale));
    sourceSelect.value = leadFilters.source;
    const ownerSelect = selectInput([
      { value: '', label: t(locale, 'crm_card_filter_all') },
      ...employees.filter((e) => e.ownerUserId).map((e) => ({ value: e.ownerUserId, label: e.fullName })),
    ]);
    ownerSelect.value = leadFilters.ownerEmployeeUserId;

    const applyBtn = el('button', { class: 'primary' }, t(locale, 'crm_card_apply_filters'));
    applyBtn.addEventListener('click', () => {
      leadFilters = { priority: prioritySelect.value, source: sourceSelect.value, ownerEmployeeUserId: ownerSelect.value };
      close();
      onApply();
    });
    const clearBtn = el('button', {}, t(locale, 'crm_card_clear_filters'));
    clearBtn.addEventListener('click', () => {
      leadFilters = { priority: '', source: '', ownerEmployeeUserId: '' };
      close();
      onApply();
    });

    return [el('div', { class: 'lead-filters-panel' }, [
      field(t(locale, 'crm_col_priority'), prioritySelect),
      field(t(locale, 'crm_lead_field_source'), sourceSelect),
      employees.length > 0 ? field(t(locale, 'crm_lead_field_assigned_sales_user'), ownerSelect) : null,
      el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:4px' }, [clearBtn, applyBtn]),
    ])];
  }

  // Down-payment %/term derived straight from a Quotation's own persisted
  // scheduleSnapshot/inputs (the same fields quotation.service.ts itself
  // reads for its "downPayment" figure) — never from a template that could
  // since have been edited/archived, and never fabricated when the data
  // needed isn't there.
  function summarizePaymentPlan(q) {
    const totalPrice = q.inputs?.totalPrice;
    const downLine = q.scheduleSnapshot?.find((l) => l.kind === 'down_payment' || l.label === 'Down Payment');
    const lastLine = q.scheduleSnapshot?.[q.scheduleSnapshot.length - 1];
    const start = q.inputs?.startDate ? Date.parse(q.inputs.startDate) : NaN;
    const end = lastLine ? Date.parse(lastLine.dueDate) : NaN;
    const percent = totalPrice && downLine ? Math.round((downLine.amount / totalPrice) * 100) : null;
    const months = Number.isFinite(start) && Number.isFinite(end) && end > start ? Math.round((end - start) / (1000 * 60 * 60 * 24 * 30.44)) : null;
    if (percent === null || months === null) return null;
    return months >= 12
      ? `${percent}% — ${Math.round(months / 12)} ${t(locale, 'crm_card_years_suffix')}`
      : `${percent}% — ${months} ${t(locale, 'crm_card_months_suffix')}`;
  }

  // Reuses the exact same GET /api/quotations?leadId= endpoint the Lead
  // detail's Offers section already calls — nothing new on the backend.
  // Only called for the leads on the currently-visible page (bounded by
  // pagination, not per-card-on-every-render), and a missing
  // view:quotation grant degrades to no chips rather than an error.
  async function fetchPaymentPlanChips(leadId) {
    try {
      const page = await api.get('/api/quotations', { leadId, limit: 5 });
      return page.items.map(summarizePaymentPlan).filter(Boolean);
    } catch {
      return [];
    }
  }

  function formatCardDate(iso) {
    return new Date(iso).toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en-US', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  /** One client card — see the CRM Client List UI Redesign spec: Identity /
   * Status-Priority / Source-Location / Target-Budget / Payment Plans,
   * then a quick-actions row, then Created/Next Follow-up. Every action
   * reuses the exact existing handler (openLeadDetail/openMoveStageModal/
   * askAi) — this only changes how a lead is laid out, not what clicking
   * an action does. */
  function leadCard(lead, reload) {
    const stage = stages.find((s) => s.id === lead.stageId);
    const owner = employees.find((e) => e.ownerUserId === lead.ownerEmployeeUserId);
    const phoneDigits = lead.phone.replace(/[^0-9+]/g, '');
    const waDigits = phoneDigits.replace(/^\+/, '');

    // A. Identity
    const callLink = el('a', { class: 'icon-btn', href: `tel:${phoneDigits}` }, [icon('phone', 'sm'), t(locale, 'crm_card_call')]);
    const waLink = el('a', { class: 'icon-btn whatsapp-btn', href: `https://wa.me/${waDigits}`, target: '_blank', rel: 'noopener' }, [icon('whatsapp', 'sm'), t(locale, 'crm_channel_whatsapp')]);
    const identity = el('div', {}, [
      el('div', { class: 'lead-card-section-label' }, t(locale, 'crm_card_name_phone_label')),
      el('div', { class: 'lead-card-name' }, lead.fullName),
      el('div', { class: 'lead-card-phone' }, lead.phone),
      el('div', { class: 'lead-card-contact-row' }, [callLink, waLink]),
      owner ? el('div', { class: 'muted-line', style: 'font-size:11.5px;margin-top:6px' }, `${t(locale, 'crm_card_assigned_prefix')} ${owner.fullName}`) : null,
    ]);

    // B. Status / Priority
    const statusBlock = el('div', {}, [
      el('div', { class: 'lead-card-section-label' }, t(locale, 'crm_card_status_priority_label')),
      el('div', { class: 'lead-card-badges' }, [
        statusBadge(stage?.name || lead.stageId),
        lead.priority ? badge(priorityLabel(locale, lead.priority), lead.priority === 'urgent' || lead.priority === 'high' ? 'red' : '') : null,
      ]),
    ]);

    // C. Source / Location
    const sourceBlock = el('div', {}, [
      el('div', { class: 'lead-card-section-label' }, t(locale, 'crm_card_source_location_label')),
      el('div', { class: 'lead-card-kv' }, [
        el('div', {}, lead.source ? leadSourceLabel(locale, lead.source) : el('span', { class: 'muted-line' }, '—')),
        el('div', { class: 'muted-line' }, lead.preferredLocation ? `${t(locale, 'crm_card_location_prefix')} ${lead.preferredLocation}` : t(locale, 'crm_card_no_location')),
      ]),
    ]);

    // D. Target / Budget
    const targetLabel = lead.propertyTypeWanted || lead.interestedInLabel || (lead.interestedInType ? leadInterestLabel(locale, lead.interestedInType) : '');
    const budgetLabel = (lead.budgetMin || lead.budgetMax)
      ? [lead.budgetMin, lead.budgetMax].filter((v) => v != null).map((v) => Number(v).toLocaleString()).join(' – ') + ' EGP'
      : '';
    const targetBlock = el('div', {}, [
      el('div', { class: 'lead-card-section-label' }, t(locale, 'crm_card_target_budget_label')),
      el('div', { class: 'lead-card-kv' }, [
        el('div', {}, targetLabel ? `${t(locale, 'crm_card_target_prefix')} ${targetLabel}` : t(locale, 'crm_card_no_target')),
        el('div', { class: 'muted-line' }, budgetLabel ? `${t(locale, 'crm_card_budget_prefix')} ${budgetLabel}` : t(locale, 'crm_card_no_budget')),
      ]),
    ]);

    // E. Payment Plans — loaded async (see fetchPaymentPlanChips) so the
    // card renders immediately and the chip row fills in a beat later.
    const chipsSlot = el('div', { class: 'lead-card-chips' }, [el('span', { class: 'lead-card-chip empty' }, '…')]);
    const plansBlock = el('div', {}, [
      el('div', { class: 'lead-card-section-label' }, t(locale, 'crm_card_payment_plans')),
      chipsSlot,
    ]);
    if (can('quotation', 'view')) {
      fetchPaymentPlanChips(lead.id).then((chips) => {
        clear(chipsSlot);
        if (chips.length === 0) {
          chipsSlot.appendChild(el('span', { class: 'lead-card-chip empty' }, t(locale, 'crm_card_no_payment_plans')));
        } else {
          chips.forEach((c) => chipsSlot.appendChild(el('span', { class: 'lead-card-chip' }, c)));
        }
      });
    } else {
      clear(chipsSlot);
      chipsSlot.appendChild(el('span', { class: 'lead-card-chip empty' }, t(locale, 'crm_card_no_payment_plans')));
    }

    const grid = el('div', { class: 'lead-card-grid' }, [identity, statusBlock, sourceBlock, targetBlock, plansBlock]);

    // Quick actions — same handlers the old row actions used.
    const detailBtn = el('button', {}, [icon('folder', 'sm'), ' ', t(locale, 'crm_action_open_file')]);
    detailBtn.addEventListener('click', () => openLeadDetail(lead, reload));
    const moveBtn = el('button', {}, [icon('history', 'sm'), ' ', t(locale, 'crm_action_move_stage')]);
    moveBtn.addEventListener('click', () => openMoveStageModal(lead, reload));
    const aiBtn = el('button', { class: 'primary' }, [icon('ai', 'sm'), ' ', t(locale, 'crm_action_ask_ai')]);
    aiBtn.addEventListener('click', () => askAi(lead, reload));
    const actionsRow = el('div', { class: 'lead-card-actions' }, [aiBtn, detailBtn, moveBtn]);

    // Dates — Created always exists; Next Follow-up only for a lead with a
    // real pending first-contact SLA deadline that isn't already Won/Lost.
    const dateItems = [
      el('span', { class: 'lead-card-date-item' }, [icon('calendar'), `${t(locale, 'crm_lead_created_at_prefix')} ${formatCardDate(lead.createdAt)}`]),
    ];
    if (lead.firstContactSlaDueAt && !stage?.isWon && !stage?.isLost) {
      const overdue = Date.parse(lead.firstContactSlaDueAt) < Date.now();
      dateItems.push(el('span', { class: `lead-card-date-item${overdue ? ' overdue' : ''}` }, [icon('calendar'), `${t(locale, 'crm_card_next_followup')}: ${formatCardDate(lead.firstContactSlaDueAt)}`]));
    }
    const datesRow = el('div', { class: 'lead-card-dates' }, dateItems);

    const footer = el('div', { class: 'lead-card-footer' }, [actionsRow, datesRow]);
    if (lead.tags?.length) {
      return el('div', { class: 'lead-card' }, [grid, el('div', { style: 'margin-top:10px' }, lead.tags.map((tag) => badge(tag))), footer]);
    }
    return el('div', { class: 'lead-card' }, [grid, footer]);
  }

  async function renderStageList(stageId) {
    const stage = stages.find((s) => s.id === stageId);
    const search = searchInput(t(locale, 'crm_search_leads_placeholder'), (value) => { q = value; offset = 0; loadList(); });
    const filterBarSlot = el('div');
    const listSlot = el('div');
    clear(bodySlot);
    const backArrow = locale === 'ar' ? '→' : '←';
    const backLink = el('button', { class: 'ghost', style: 'padding:4px 0;margin-bottom:8px' }, `${backArrow} ${t(locale, 'crm_back_to_pipeline')}`);
    backLink.addEventListener('click', goToDashboard);
    bodySlot.appendChild(backLink);
    bodySlot.appendChild(el('h2', { style: 'margin:0 0 12px' }, stage?.name ?? ''));
    bodySlot.appendChild(filterBarSlot);
    bodySlot.appendChild(listSlot);

    function renderFilterBar() {
      clear(filterBarSlot);
      const filterTrigger = el('button', {}, [
        icon('filter', 'sm'), ' ', t(locale, 'crm_card_filters_btn'),
        activeLeadFilterCount() > 0 ? el('span', { class: 'lead-filter-badge-count', style: 'margin-inline-start:6px' }, String(activeLeadFilterCount())) : null,
      ]);
      const filterPopover = popover(filterTrigger, (close) => buildLeadFiltersPanel(close, () => { offset = 0; renderFilterBar(); loadList(); }));
      filterBarSlot.appendChild(el('div', { class: 'lead-filters-bar' }, [search, filterPopover]));
    }

    async function loadList() {
      clear(listSlot);
      listSlot.appendChild(loadingState());
      try {
        const page = await api.get('/api/crm/leads', { stageId, limit: 20, offset, q, ...leadFilters });
        clear(listSlot);
        if (page.items.length === 0) {
          listSlot.appendChild(emptyState({ icon: 'leads', title: stage?.isDefault ? t(locale, 'crm_no_fresh_leads') : `${t(locale, 'crm_no_leads_in_stage')} "${stage?.name}"` }));
        } else {
          listSlot.appendChild(el('div', { class: 'lead-card-list' }, page.items.map((l) => leadCard(l, loadList))));
        }
        listSlot.appendChild(paginationControls(page, (next) => { offset = next; loadList(); }));
      } catch (err) {
        clear(listSlot);
        listSlot.appendChild(errorBanner(err.message));
      }
    }

    renderFilterBar();
    await loadList();
  }

  // ---- Tasks tab (reuses the existing TaskService/API — no new backend) ----

  async function renderTasksTab(target) {
    clear(target);
    target.appendChild(loadingState());

    async function load() {
      clear(target);
      target.appendChild(loadingState());
      try {
        const page = await api.get('/api/tasks/my', { limit: 50 });
        clear(target);
        target.appendChild(table(
          [
            { label: t(locale, 'crm_label_title'), key: 'title' },
            { label: t(locale, 'units_col_status'), render: (row) => statusBadge(row.status) },
            { label: t(locale, 'crm_task_col_due'), render: (row) => (row.dueAt ? new Date(row.dueAt).toLocaleString() : '—') },
            { label: '', render: (row) => {
              if (row.status !== 'open') return '';
              const actions = el('div', { style: 'display:flex;gap:6px' });
              const completeBtn = el('button', {}, t(locale, 'crm_task_complete_btn'));
              completeBtn.addEventListener('click', async () => {
                try { await api.post(`/api/tasks/${row.id}/complete`, {}); toast(t(locale, 'crm_task_completed_toast'), 'success'); await load(); }
                catch (err) { toast(err.message, 'error'); }
              });
              const cancelBtn = el('button', {}, t(locale, 'common_cancel'));
              cancelBtn.addEventListener('click', async () => {
                try { await api.post(`/api/tasks/${row.id}/cancel`, {}); toast(t(locale, 'crm_task_cancelled_toast'), 'success'); await load(); }
                catch (err) { toast(err.message, 'error'); }
              });
              actions.append(completeBtn, cancelBtn);
              return actions;
            } },
          ],
          page.items,
          { empty: t(locale, 'crm_task_empty') },
        ));
      } catch (err) {
        clear(target);
        target.appendChild(errorBanner(err.message));
      }
    }

    await load();
  }

  // ---- Add Lead ----

  // Pre-submit duplicate warning: lets the rep review/open the existing
  // lead instead of just hitting a rejected create request. Resolves
  // 'view' | 'create' | 'cancel'.
  function confirmDuplicateWarning(duplicate) {
    return new Promise((resolve) => {
      const body = el('div', {}, [
        el('p', {}, `${t(locale, 'crm_lead_duplicate_warning_body')} "${duplicate.fullName}" (${duplicate.phone}).`),
      ]);
      const cancelBtn = el('button', {}, t(locale, 'common_cancel'));
      const viewBtn = el('button', {}, t(locale, 'crm_lead_duplicate_view_existing'));
      const createBtn = el('button', { class: 'primary' }, t(locale, 'crm_lead_duplicate_create_anyway'));
      body.appendChild(el('div', { class: 'form-actions', style: 'justify-content:flex-end' }, [cancelBtn, viewBtn, createBtn]));
      const { close } = contentModal(t(locale, 'crm_lead_duplicate_warning_title'), body);
      cancelBtn.addEventListener('click', () => { close(); resolve('cancel'); });
      viewBtn.addEventListener('click', () => { close(); resolve('view'); });
      createBtn.addEventListener('click', () => { close(); resolve('create'); });
    });
  }

  async function openAddLeadModal() {
    const defaultStage = stages.find((s) => s.id === activeTab) || stages.find((s) => s.isDefault);
    const fields = [
      { key: 'fullName', label: t(locale, 'crm_lead_field_full_name') },
      { key: 'phone', label: t(locale, 'crm_lead_field_mobile') },
      { key: 'source', label: t(locale, 'crm_lead_field_source'), type: 'select', options: leadSourceOptions(locale) },
    ];
    // Sales Agents can't see the employee list (no view:employee) — the
    // picker just doesn't appear for them, and creation falls back to the
    // existing automatic-owner-assignment behavior (Lead Distribution pool
    // or "creator owns it").
    if (employees.length > 0) {
      fields.push({
        key: 'ownerEmployeeUserId',
        label: t(locale, 'crm_lead_field_assigned_sales_user'),
        type: 'select',
        options: [
          { value: '', label: t(locale, 'crm_lead_assigned_sales_user_auto') },
          ...employees.filter((e) => e.ownerUserId).map((e) => ({ value: e.ownerUserId, label: e.fullName })),
        ],
      });
    }
    fields.push(
      { key: 'interestedInType', label: t(locale, 'crm_lead_field_interested_in_type'), type: 'select', options: leadInterestOptions(locale) },
      { key: 'interestedInLabel', label: t(locale, 'crm_lead_field_interested_in_label') },
      { key: 'budgetMin', label: t(locale, 'crm_lead_field_budget_min'), type: 'number' },
      { key: 'budgetMax', label: t(locale, 'crm_lead_field_budget_max'), type: 'number' },
      { key: 'preferredLocation', label: t(locale, 'crm_lead_field_location') },
      { key: 'stageId', label: t(locale, 'crm_lead_field_status'), type: 'select', options: stages.map((s) => ({ value: s.id, label: s.name })), value: defaultStage?.id },
      { key: 'notes', label: t(locale, 'crm_lead_field_notes_optional'), type: 'textarea' },
    );

    const result = await formModal({
      title: t(locale, 'crm_lead_modal_title'),
      fields,
      submitLabel: t(locale, 'crm_lead_submit_add'),
    });
    if (!result) return;
    if (!result.fullName.trim() || !result.phone.trim()) {
      reportError(new Error(t(locale, 'crm_lead_validation_required')));
      return;
    }

    async function createLead() {
      try {
        const lead = await api.post('/api/crm/leads', {
          fullName: result.fullName.trim(),
          phone: result.phone.trim(),
          source: result.source || undefined,
          ownerEmployeeUserId: result.ownerEmployeeUserId || undefined,
          stageId: result.stageId || undefined,
          interestedInType: result.interestedInType || undefined,
          interestedInLabel: result.interestedInLabel.trim() || undefined,
          budgetMin: result.budgetMin ? Number(result.budgetMin) : undefined,
          budgetMax: result.budgetMax ? Number(result.budgetMax) : undefined,
          preferredLocation: result.preferredLocation.trim() || undefined,
        });
        if (result.notes.trim()) {
          await api.post('/api/communication/messages', {
            subject: 'Note', body: result.notes.trim(), channel: 'note', relatedResource: 'lead', relatedResourceId: lead.id,
          }).catch(() => {}); // the lead itself is already saved — a failed note shouldn't look like a failed lead creation
        }
        toast(`${t(locale, 'crm_lead_added_toast_prefix')} "${stages.find((s) => s.id === lead.stageId)?.name || t(locale, 'crm_lead_added_fallback_stage')}".`, 'success');
        await refreshAll();
      } catch (err) {
        reportError(err);
      }
    }

    try {
      const { duplicate } = await api.get('/api/crm/leads/check-duplicate', { phone: result.phone.trim() });
      if (duplicate) {
        const choice = await confirmDuplicateWarning(duplicate);
        if (choice === 'view') { openLeadDetail(duplicate, refreshAll); return; }
        if (choice !== 'create') return; // cancelled — leave it to the rep to re-open Add Lead if they want to retry
      }
    } catch {
      // The duplicate pre-check is just a UX nicety — if it fails, fall
      // through to create; CrmService.createLead enforces the same
      // phone-uniqueness rule server-side regardless.
    }
    await createLead();
  }

  // ---- Move stage ----

  async function openMoveStageModal(lead, reload) {
    const result = await formModal({
      title: `${t(locale, 'crm_move_word')} "${lead.fullName}"`,
      fields: [
        { key: 'stageId', label: t(locale, 'crm_move_new_stage_field'), type: 'select', options: stages.map((s) => ({ value: s.id, label: s.name })), value: lead.stageId },
        { key: 'lostReason', label: t(locale, 'crm_move_lost_reason_field') },
        { key: 'note', label: t(locale, 'crm_move_note_field'), type: 'textarea' },
      ],
      submitLabel: t(locale, 'crm_move_word'),
    });
    if (!result) return;
    try {
      await api.patch(`/api/crm/leads/${lead.id}/stage`, { stageId: result.stageId, lostReason: result.lostReason.trim() || undefined, note: result.note?.trim() || undefined });
      const target = stages.find((s) => s.id === result.stageId);
      toast(`${t(locale, 'crm_move_toast_prefix')} "${target?.name}".`, 'success');
      await refreshAll();
      reload?.();
    } catch (err) {
      reportError(err);
    }
  }

  // ---- Ask AI ----

  async function askAi(lead, reload) {
    try {
      const decision = await api.post(`/api/crm/leads/${lead.id}/suggest-next-action`, {});
      const prefix = `[${decision.confidence}${t(locale, 'crm_ai_confidence_suffix')}] `;
      if (decision.status === 'no_action') {
        toast(`${prefix}${t(locale, 'crm_ai_prefix')} ${decision.reasoning}`, 'info');
      } else if (decision.status === 'escalated') {
        toast(`${prefix}${t(locale, 'crm_ai_escalated_prefix')} ${decision.reasoning}`, 'info');
      } else if (decision.resultActionStatus === 'executed') {
        toast(`${prefix}${t(locale, 'crm_ai_executed_prefix')} ${decision.reasoning}`, 'success');
        await refreshAll();
        reload?.();
      } else if (decision.resultActionStatus === 'pending_approval') {
        toast(`${prefix}${t(locale, 'crm_ai_suggests_prefix')} ${decision.reasoning} — ${t(locale, 'crm_ai_awaiting_approval')}`, 'info');
      } else {
        toast(`${prefix}${t(locale, 'crm_ai_suggests_prefix')} ${decision.reasoning}`, 'info');
      }
    } catch (err) {
      reportError(err);
    }
  }

  // ---- Lead detail: timeline/history, comments, requirements, tags/priority, reassign, portal ----

  function formatDuration(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }

  /**
   * The Lead Timeline / History card: a real, server-filtered/paginated
   * view over everything ACTIVE actually recorded for this lead (see
   * GET /api/crm/leads/:id/timeline) — never a client-side-only slice
   * that could hide older history. Reuses the exact same
   * selectInput/searchInput/paginationControls primitives every other
   * list page already uses.
   */
  async function buildTimelineSection(leadId) {
    // Event-type/date-range/search filtering stays a real backend capability
    // (GET .../timeline still accepts type/q/from/to below) — only the
    // filter CONTROLS are no longer rendered, per the approved redesign.
    const state = { type: '', q: '', from: '', to: '', offset: 0, limit: 20 };
    const listSlot = el('div', {});
    const paginationSlot = el('div', { style: 'margin-top:10px' });

    const typeLabels = timelineTypeLabels(locale);

    function renderEntry(e) {
      const isAi = e.actorType === 'ai_agent';
      const d = e.detail || {};
      const rows = [
        el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, [
          el('strong', {}, typeLabels[e.type] || e.type),
          isAi ? badge(t(locale, 'crm_timeline_ai_agent_badge'), 'blue') : null,
          el('span', { class: 'muted', style: 'font-size:12px' }, new Date(e.at).toLocaleString()),
        ]),
        el('div', {}, e.summary),
        el('div', { class: 'muted', style: 'font-size:12px' }, e.actorName),
      ];
      if (typeof d.fromStageId !== 'undefined' || typeof d.toStatus === 'string') {
        const fromName = stages.find((s) => s.id === d.fromStageId)?.name || t(locale, 'crm_timeline_new_lead_fallback');
        rows.push(el('div', { style: 'font-size:13px' }, `${fromName} → ${d.toStatus || '—'}`));
        if (typeof d.timeInPreviousStageMs === 'number') {
          rows.push(el('div', { class: 'muted', style: 'font-size:12px' }, `${t(locale, 'crm_timeline_time_in_stage_prefix')} ${formatDuration(d.timeInPreviousStageMs)}`));
        }
        if (d.lostReason) rows.push(el('div', { style: 'font-size:13px' }, `${t(locale, 'crm_timeline_reason_prefix')} ${d.lostReason}`));
        if (d.note) rows.push(el('div', { style: 'font-size:13px' }, `${t(locale, 'crm_timeline_comment_prefix')} ${d.note}`));
      }
      if (Array.isArray(d.fieldsChanged)) {
        const fmtVal = (v) => (v === undefined || v === null || v === '' ? '—' : v);
        for (const field of d.fieldsChanged) {
          rows.push(el('div', { style: 'font-size:13px' }, `${field}: ${fmtVal(d.previousValues?.[field])} → ${fmtVal(d.newValues?.[field])}`));
        }
      }
      if (e.type === 'owner_changed') {
        rows.push(el('div', { style: 'font-size:13px' }, `${d.previousOwnerUserId || '—'} → ${d.newOwnerUserId || '—'}`));
      }
      if (e.type === 'message' && d.body) {
        rows.push(el('div', { style: 'font-size:13px;white-space:pre-wrap' }, `"${d.body}"`));
      }
      return el('div', { style: 'display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border,#e5e5e5)' }, [
        el('span', {}, TIMELINE_ICONS[e.type] || '•'),
        el('div', { style: 'flex:1' }, rows),
      ]);
    }

    async function load() {
      clear(listSlot);
      listSlot.appendChild(loadingState());
      try {
        const page = await api.get(`/api/crm/leads/${leadId}/timeline`, {
          type: state.type || undefined,
          q: state.q || undefined,
          from: state.from || undefined,
          to: state.to || undefined,
          limit: state.limit,
          offset: state.offset,
        });
        clear(listSlot);
        if (page.items.length === 0) {
          listSlot.appendChild(el('p', { class: 'muted' }, t(locale, 'crm_timeline_no_matches')));
        } else {
          listSlot.appendChild(el('div', {}, page.items.map(renderEntry)));
        }
        clear(paginationSlot);
        paginationSlot.appendChild(paginationControls(page, (offset) => { state.offset = offset; load(); }));
      } catch (err) {
        clear(listSlot);
        listSlot.appendChild(errorBanner(err.message));
      }
    }

    const card = el('div', {}, [
      listSlot,
      paginationSlot,
    ]);
    await load();
    return card;
  }

  async function openLeadDetail(lead, reload) {
    const body = el('div', {});
    body.appendChild(loadingState());
    contentModal(lead.fullName, body, { wide: true });
    setAiContext({ leadId: lead.id, label: lead.fullName });
    // The AI Assistant should only answer "about this lead" while its
    // detail modal is actually open — closing it (× button, Escape, or
    // clicking the overlay) drops the context. We can't hook the modal's
    // own dismiss paths directly, so this observes its removal instead.
    const modalWatcher = new MutationObserver(() => {
      if (!document.body.contains(body)) { clearAiContext(); modalWatcher.disconnect(); }
    });
    modalWatcher.observe(document.body, { childList: true });

    async function refreshDetail() {
      clear(body);
      let fresh, score;
      try {
        fresh = await api.get(`/api/crm/leads/${lead.id}`);
        score = await api.get(`/api/crm/leads/${lead.id}/score`).catch(() => null);
      } catch (err) {
        clear(body);
        body.appendChild(errorBanner(err.message));
        return;
      }
      lead = fresh;
      // The real, provider-confirmed delivery status of the most recent
      // outbound WhatsApp/email message to this lead — never assumes an
      // "API call succeeded" event means the message was actually
      // delivered. Missing permission/no message sent yet both degrade to
      // no badge rather than blocking the rest of the detail view.
      const deliveryStatus = await api.get(`/api/integrations/communication/delivery/by-resource/${lead.id}`).catch(() => null);

      const stage = stages.find((s) => s.id === lead.stageId);
      const owner = employees.find((e) => e.ownerUserId === lead.ownerEmployeeUserId);
      const DELIVERY_COLORS = { delivered: 'green', read: 'green', sent: 'blue', queued: 'amber', failed: 'red', rejected: 'red', unknown: '' };

      // ---- Status badges (stage/priority/delivery/score) — kept visible,
      // just compact, above the identity/contact block. ----
      const badgesRow = el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px' }, [
        statusBadge(stage?.name || lead.stageId),
        lead.priority ? badge(priorityLabel(locale, lead.priority), lead.priority === 'urgent' || lead.priority === 'high' ? 'red' : '') : null,
        deliveryStatus && deliveryStatus.status !== 'unknown' ? badge(`${t(locale, 'crm_delivery_status_prefix')} ${deliveryStatus.status}`, DELIVERY_COLORS[deliveryStatus.status] || '') : null,
        score ? el('span', { class: 'muted' }, `${t(locale, 'crm_lead_score_prefix')} ${score.score}/100`) : null,
      ]);
      body.appendChild(badgesRow);

      // ---- Phone + direct Call/WhatsApp — same tel:/wa.me pattern as the
      // lead-card list, using the lead's own (normalized) phone number. ----
      body.appendChild(el('div', { class: 'muted', style: 'margin-bottom:10px;direction:ltr;text-align:start' }, lead.phone));
      const phoneDigits = lead.phone.replace(/[^0-9+]/g, '');
      const waDigits = phoneDigits.replace(/^\+/, '');
      const callLink = el('a', { class: 'icon-btn', href: `tel:${phoneDigits}` }, [icon('phone', 'sm'), t(locale, 'crm_detail_call_btn')]);
      const waLink = el('a', { class: 'icon-btn whatsapp-btn', href: `https://wa.me/${waDigits}`, target: '_blank', rel: 'noopener' }, [icon('whatsapp', 'sm'), t(locale, 'crm_detail_whatsapp_btn')]);
      body.appendChild(el('div', { class: 'lead-card-contact-row', style: 'margin-bottom:18px' }, [callLink, waLink]));

      // ---- Byline: owner + created date/time, now a small secondary line
      // (not the header's primary face — see the requirements grid below,
      // which real data shows the sales team actually needs first). ----
      const interestedValue = lead.interestedInLabel || (lead.interestedInType ? leadInterestLabel(locale, lead.interestedInType) : '') || t(locale, 'crm_detail_no_value');
      const ownerValue = owner?.fullName || t(locale, 'crm_detail_no_value');
      const createdDate = new Date(lead.createdAt);
      const localeTag = locale === 'ar' ? 'ar-EG' : 'en-US';
      const timeValue = createdDate.toLocaleTimeString(localeTag, { hour: '2-digit', minute: '2-digit' });
      const dateValue = createdDate.toLocaleDateString(localeTag, { day: '2-digit', month: 'long', year: 'numeric' });
      body.appendChild(el('div', { class: 'lead-detail-byline' }, [
        el('span', {}, `${t(locale, 'crm_detail_owner_label')}: ${ownerValue}`),
        el('span', { class: 'sep' }, '•'),
        el('span', {}, `${dateValue}، ${timeValue}`),
      ]));

      // ---- Requirements: the real client-requirement fields (same data
      // as the "Edit interest" form below), now the primary face of the
      // header — no fabricated fields, only what's actually on the Lead. ----
      const budgetLabel = (lead.budgetMin || lead.budgetMax)
        ? [lead.budgetMin, lead.budgetMax].filter((v) => v != null).map((v) => Number(v).toLocaleString()).join(' – ')
        : '';
      function reqPair(label, value) {
        return el('div', {}, [
          el('div', { class: 'req-label' }, label),
          el('div', { class: 'req-value' }, value || t(locale, 'crm_detail_no_value')),
        ]);
      }
      body.appendChild(el('div', { class: 'lead-detail-reqs' }, [
        reqPair(t(locale, 'crm_req_property_type_field'), lead.propertyTypeWanted),
        reqPair(t(locale, 'crm_req_budget_range_field'), budgetLabel),
        reqPair(t(locale, 'crm_req_location_field'), lead.preferredLocation),
        reqPair(t(locale, 'crm_detail_interested_label'), interestedValue),
      ]));

      // ---- Quick actions: the 4 primary actions up front, the rest
      // (tags/priority, portal access, AI) as a secondary row — nothing
      // removed, just reorganized so the most-used actions read first. ----
      const primaryActionsRow = el('div', { class: 'lead-detail-actions' });
      const assignBtn = el('button', {}, t(locale, 'crm_action_assign_owner'));
      assignBtn.addEventListener('click', () => reassignOwner(lead, refreshDetail));
      const moveBtn = el('button', {}, t(locale, 'crm_action_move_stage'));
      moveBtn.addEventListener('click', async () => { await openMoveStageModal(lead, null); await refreshDetail(); reload?.(); });
      const interestBtn = el('button', {}, t(locale, 'crm_action_edit_interest'));
      interestBtn.addEventListener('click', () => editDetails(lead, refreshDetail));
      const noteBtn = el('button', {}, t(locale, 'crm_action_add_note'));
      noteBtn.addEventListener('click', () => quickAddNote(lead, refreshDetail));
      primaryActionsRow.append(assignBtn, moveBtn, interestBtn, noteBtn);
      body.appendChild(primaryActionsRow);

      const secondaryActionsRow = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px' });
      const tagsBtn = el('button', { class: 'ghost' }, t(locale, 'crm_action_edit_tags'));
      tagsBtn.addEventListener('click', () => editTagsAndPriority(lead, refreshDetail));
      secondaryActionsRow.appendChild(tagsBtn);

      const portalBtn = el('button', { class: 'ghost' }, t(locale, 'crm_action_grant_portal'));
      portalBtn.addEventListener('click', () => grantPortalAccess(lead));
      secondaryActionsRow.appendChild(portalBtn);

      const aiBtn = el('button', { class: 'ghost' }, t(locale, 'crm_action_ask_ai'));
      aiBtn.addEventListener('click', async () => { await askAi(lead, null); await refreshDetail(); reload?.(); });
      secondaryActionsRow.appendChild(aiBtn);
      body.appendChild(secondaryActionsRow);

      if (lead.tags?.length) {
        body.appendChild(el('div', { style: 'margin-bottom:14px' }, lead.tags.map((tag) => badge(tag))));
      }

      // ---- Offers: unit code -> auto-filled unit/payment data -> a real
      // Offer PDF the sales team can print or send over WhatsApp. Reuses
      // the Quotation/Offer engine (quotation.service.ts) — the same
      // deep-snapshot payment schedule, PDF, and WhatsApp document send
      // every other Offer surface uses; nothing here is a second path.
      // Built here but appended after the accordions below (see
      // offerCard), matching the new layout's card order. ----
      let offerCard = null;
      if (can('quotation', 'create')) {
        const unitCodeInput = el('input', { type: 'text', placeholder: t(locale, 'crm_offer_unit_code_placeholder') });
        const lookupBtn = el('button', {}, t(locale, 'crm_offer_lookup_btn'));
        const offerUnitInfo = el('div', { class: 'muted', style: 'margin-top:6px' });
        const offerTemplateSelect = selectInput([]);
        const offerDiscountInput = el('input', { type: 'number', placeholder: '0', value: '0' });
        const createOfferBtn = el('button', { class: 'primary' }, t(locale, 'crm_offer_create_btn'));
        createOfferBtn.disabled = true;
        let foundUnit = null;

        api.get('/api/payment-plan-templates', { limit: 100 }).then((page) => {
          clear(offerTemplateSelect);
          page.items.forEach((tpl) => offerTemplateSelect.appendChild(el('option', { value: tpl.id }, tpl.name)));
        }).catch(() => {});

        lookupBtn.addEventListener('click', async () => {
          clear(offerUnitInfo);
          foundUnit = null;
          createOfferBtn.disabled = true;
          if (!unitCodeInput.value.trim()) return;
          lookupBtn.disabled = true;
          try {
            const result = await api.get(`/api/quotations/units/by-code/${encodeURIComponent(unitCodeInput.value.trim())}`);
            foundUnit = result.unit;
            offerUnitInfo.appendChild(el('div', {}, [
              el('strong', {}, `${result.project?.name || ''} — ${result.unit.unitType}`),
              el('div', {}, `${result.unit.areaSqm} m² · ${Number(result.unit.listPrice).toLocaleString()}${result.unit.floorLabel ? ` · ${t(locale, 'units_manage_floor_field')} ${result.unit.floorLabel}` : ''}${result.unit.buildingLabel ? ` · ${t(locale, 'units_manage_building_field')} ${result.unit.buildingLabel}` : ''}`),
            ]));
            createOfferBtn.disabled = false;
          } catch (err) {
            offerUnitInfo.appendChild(errorBanner(err.message));
          } finally {
            lookupBtn.disabled = false;
          }
        });

        const offersListSlot = el('div', { style: 'margin-top:10px' });

        // Revoking the blob: URL synchronously right after a[download].click()
        // races the browser's own (async) read of it — on some browsers
        // this silently saves a zero-byte/empty file instead of the real
        // one. Delaying the revoke keeps the real filename intact.
        function downloadBase64(filename, contentType, base64) {
          const byteChars = atob(base64);
          const bytes = new Uint8Array(byteChars.length);
          for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
          const blob = new Blob([bytes], { type: contentType });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        }

        async function downloadOfferPdf(quotation) {
          try {
            const result = await api.get(`/api/quotations/${quotation.id}/pdf`);
            downloadBase64(result.filename, result.contentType, result.base64);
          } catch (err) {
            toast(err.message, 'error');
          }
        }

        async function sendOfferWhatsApp(quotation) {
          const values = await formModal({
            title: `${t(locale, 'crm_offer_send_whatsapp_title_prefix')} ${quotation.referenceNumber} ${t(locale, 'crm_offer_send_whatsapp_title_suffix')}`,
            fields: [
              { key: 'to', label: t(locale, 'crm_offer_whatsapp_number_field'), type: 'text', value: lead.phone || '' },
              { key: 'message', label: t(locale, 'crm_offer_message_field'), type: 'textarea', value: `${t(locale, 'crm_offer_whatsapp_greeting')} ${lead.fullName}${t(locale, 'crm_offer_whatsapp_message_suffix')}` },
            ],
            submitLabel: t(locale, 'crm_send_btn'),
          });
          if (!values || !values.to?.trim()) return;
          try {
            await api.post(`/api/quotations/${quotation.id}/send-whatsapp`, { to: values.to.trim(), message: values.message });
            toast(t(locale, 'crm_offer_sent_whatsapp_toast'), 'success');
            await refreshDetail();
          } catch (err) {
            toast(err.message, 'error');
          }
        }

        async function loadOffers() {
          clear(offersListSlot);
          try {
            const page = await api.get('/api/quotations', { leadId: lead.id, limit: 20 });
            offersListSlot.appendChild(table(
              [
                { label: t(locale, 'crm_offer_col_reference'), key: 'referenceNumber' },
                { label: t(locale, 'units_col_status'), render: (q) => statusBadge(q.status) },
                { label: t(locale, 'crm_offer_col_created'), render: (q) => new Date(q.createdAt).toLocaleString() },
                { label: '', render: (q) => {
                  const printBtn = el('button', {}, t(locale, 'crm_offer_print_btn'));
                  printBtn.addEventListener('click', () => downloadOfferPdf(q));
                  const waBtn = el('button', {}, t(locale, 'catalog_share_whatsapp'));
                  waBtn.addEventListener('click', () => sendOfferWhatsApp(q));
                  return el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, [printBtn, waBtn]);
                } },
              ],
              page.items,
              { empty: t(locale, 'crm_offer_empty') },
            ));
          } catch (err) {
            offersListSlot.appendChild(errorBanner(err.message));
          }
        }

        createOfferBtn.addEventListener('click', async () => {
          if (!foundUnit || !offerTemplateSelect.value) {
            toast(t(locale, 'crm_offer_lookup_first_toast'), 'error');
            return;
          }
          createOfferBtn.disabled = true;
          try {
            const quotation = await api.post('/api/quotations', {
              unitId: foundUnit.id,
              paymentPlanTemplateId: offerTemplateSelect.value,
              discountPercent: Number(offerDiscountInput.value) || 0,
              leadId: lead.id,
            });
            toast(`${t(locale, 'crm_offer_created_prefix')} ${quotation.referenceNumber} ${t(locale, 'crm_offer_created_suffix')}`, 'success');
            unitCodeInput.value = '';
            clear(offerUnitInfo);
            foundUnit = null;
            await loadOffers();
          } catch (err) {
            toast(err.message, 'error');
          } finally {
            createOfferBtn.disabled = false;
          }
        });

        // Named "Price Offer" (not "Offers") deliberately — the CRM
        // workspace already has a top-level "Offers" tab for the deal
        // pipeline (Opportunities); this is a different thing (a unit +
        // payment-plan + PDF quote for this specific lead), so it needs a
        // different label to not read as the same feature.
        offerCard = el('div', { class: 'card' }, [
          el('h4', { style: 'margin-top:0' }, t(locale, 'crm_offer_card_title')),
          el('div', { class: 'form-row' }, [
            el('div', {}, [el('label', {}, t(locale, 'units_manage_unit_code_field')), unitCodeInput]),
            el('div', { style: 'align-self:flex-end' }, lookupBtn),
            el('div', {}, [el('label', {}, t(locale, 'crm_offer_payment_plan_field')), offerTemplateSelect]),
            el('div', {}, [el('label', {}, t(locale, 'crm_offer_discount_field')), offerDiscountInput]),
          ]),
          offerUnitInfo,
          el('div', { class: 'form-actions' }, [createOfferBtn]),
          offersListSlot,
        ]);
        await loadOffers();
      }

      // ---- Log activity: comment / call / WhatsApp note ----
      const channelSelect = el('select', {}, [
        el('option', { value: 'note' }, t(locale, 'crm_channel_note')),
        el('option', { value: 'call' }, t(locale, 'crm_channel_call')),
        el('option', { value: 'whatsapp' }, t(locale, 'crm_channel_whatsapp')),
        el('option', { value: 'email' }, t(locale, 'field_email')),
        el('option', { value: 'internal' }, t(locale, 'crm_channel_internal')),
      ]);
      const activityInput = el('textarea', { rows: 2, placeholder: t(locale, 'crm_activity_placeholder') });
      const logBtn = el('button', { class: 'primary' }, t(locale, 'crm_activity_log_btn'));
      logBtn.addEventListener('click', async () => {
        if (!activityInput.value.trim()) return;
        logBtn.disabled = true;
        try {
          // Note: these subject values are stored data (the message's subject
          // line), not UI chrome — left in English to match the rest of the
          // stored record; only the on-screen select options above are localized.
          await api.post('/api/communication/messages', {
            subject: channelSelect.value === 'call' ? 'Call logged' : 'Note',
            body: activityInput.value.trim(),
            channel: channelSelect.value,
            relatedResource: 'lead',
            relatedResourceId: lead.id,
          });
          activityInput.value = '';
          toast(t(locale, 'crm_activity_logged_toast'), 'success');
          await refreshDetail();
        } catch (err) {
          reportError(err);
        } finally {
          logBtn.disabled = false;
        }
      });
      body.appendChild(collapsible(t(locale, 'crm_activity_log_btn'), el('div', {}, [
        el('div', { class: 'form-row' }, [
          el('div', { style: 'max-width:160px' }, [el('label', {}, t(locale, 'crm_activity_channel_field')), channelSelect]),
          el('div', { style: 'flex:2' }, [el('label', {}, t(locale, 'crm_activity_details_field')), activityInput]),
        ]),
        el('div', { class: 'form-actions' }, [logBtn]),
      ]), { defaultOpen: false }));

      // ---- Schedule a follow-up (a Task tied to this lead) ----
      const followUpInput = el('input', { type: 'text', placeholder: t(locale, 'crm_followup_title_placeholder') });
      const followUpDate = el('input', { type: 'datetime-local' });
      const scheduleBtn = el('button', {}, t(locale, 'crm_followup_schedule_btn'));
      scheduleBtn.addEventListener('click', async () => {
        if (!followUpInput.value.trim()) return;
        try {
          await api.post('/api/tasks', {
            title: followUpInput.value.trim(),
            relatedResource: 'lead',
            relatedResourceId: lead.id,
            dueAt: followUpDate.value ? new Date(followUpDate.value).toISOString() : undefined,
            // Without this, the follow-up never appears in anyone's "My
            // Tasks" list (GET /api/tasks/my filters strictly on
            // assignedToUserId) — it would be created but effectively
            // uncompletable from the Tasks tab. No assignee picker exists
            // in this composer, so default to the scheduler themselves.
            assignedToUserId: session.me?.id,
          });
          followUpInput.value = '';
          toast(t(locale, 'crm_followup_scheduled_toast'), 'success');
          await refreshDetail();
        } catch (err) {
          reportError(err);
        }
      });
      body.appendChild(collapsible(t(locale, 'crm_followup_card_title'), el('div', {}, [
        el('div', { class: 'form-row' }, [
          el('div', {}, [el('label', {}, t(locale, 'crm_label_title')), followUpInput]),
          el('div', {}, [el('label', {}, t(locale, 'crm_followup_when_field')), followUpDate]),
        ]),
        el('div', { class: 'form-actions' }, [scheduleBtn]),
      ]), { defaultOpen: false }));

      // Offer & Payment card, then Timeline/History last of all — matching
      // the approved redesign: the complete, permanent record of this
      // lead's journey (stage/owner/data changes, comments/calls/WhatsApp/
      // email, follow-ups, offers, reservations, contracts, AI actions),
      // server-filtered/paginated so nothing older is ever silently
      // dropped just because it's not on the first page, now placed at the
      // true end of the page instead of nested among the accordions above. ----
      if (offerCard) body.appendChild(offerCard);
      body.appendChild(el('div', { class: 'end-of-page-timeline' }, [
        el('h4', { style: 'margin-top:0' }, t(locale, 'crm_timeline_card_title')),
        await buildTimelineSection(lead.id),
      ]));
    }

    await refreshDetail();
  }

  async function reassignOwner(lead, reload) {
    const result = await formModal({
      title: `${t(locale, 'crm_reassign_word')} "${lead.fullName}"`,
      fields: [{ key: 'ownerEmployeeUserId', label: t(locale, 'crm_reassign_owner_field'), value: lead.ownerEmployeeUserId }],
      submitLabel: t(locale, 'crm_reassign_word'),
    });
    if (!result || !result.ownerEmployeeUserId.trim()) return;
    try {
      await api.patch(`/api/crm/leads/${lead.id}/owner`, { ownerEmployeeUserId: result.ownerEmployeeUserId.trim() });
      toast(t(locale, 'crm_reassign_toast'), 'success');
      await reload?.();
    } catch (err) {
      reportError(err);
    }
  }

  async function quickAddNote(lead, reload) {
    const result = await formModal({
      title: t(locale, 'crm_quick_note_modal_title'),
      fields: [{ key: 'body', label: t(locale, 'crm_quick_note_field'), type: 'textarea', value: '' }],
      submitLabel: t(locale, 'crm_save_btn'),
    });
    if (!result || !result.body.trim()) return;
    try {
      await api.post('/api/communication/messages', {
        subject: 'Note',
        body: result.body.trim(),
        channel: 'note',
        relatedResource: 'lead',
        relatedResourceId: lead.id,
      });
      toast(t(locale, 'crm_activity_logged_toast'), 'success');
      await reload?.();
    } catch (err) {
      reportError(err);
    }
  }

  async function editTagsAndPriority(lead, reload) {
    const result = await formModal({
      title: `${t(locale, 'crm_tags_modal_title_prefix')} ${lead.fullName}`,
      fields: [
        { key: 'priority', label: t(locale, 'crm_col_priority'), type: 'select', options: priorityOptions(locale), value: lead.priority || '' },
        { key: 'tags', label: t(locale, 'crm_tags_field_plain'), value: (lead.tags || []).join(', ') },
      ],
      submitLabel: t(locale, 'crm_save_btn'),
    });
    if (!result) return;
    try {
      await api.patch(`/api/crm/leads/${lead.id}/tags`, {
        priority: result.priority || undefined,
        tags: result.tags.split(',').map((t) => t.trim()).filter(Boolean),
      });
      toast(t(locale, 'crm_saved_toast'), 'success');
      await reload?.();
    } catch (err) {
      reportError(err);
    }
  }

  async function editDetails(lead, reload) {
    const result = await formModal({
      title: `${t(locale, 'crm_requirements_modal_title_prefix')} ${lead.fullName}`,
      fields: [
        { key: 'fullName', label: t(locale, 'crm_lead_field_full_name'), value: lead.fullName },
        { key: 'phone', label: t(locale, 'crm_lead_field_mobile'), value: lead.phone },
        { key: 'source', label: t(locale, 'crm_lead_field_source'), type: 'select', options: leadSourceOptions(locale), value: lead.source },
        { key: 'interestedInType', label: t(locale, 'crm_lead_field_interested_in_type'), type: 'select', options: leadInterestOptions(locale), value: lead.interestedInType },
        { key: 'interestedInLabel', label: t(locale, 'crm_lead_field_interested_in_label'), value: lead.interestedInLabel },
        { key: 'budgetMin', label: t(locale, 'crm_lead_field_budget_min'), type: 'number', value: lead.budgetMin },
        { key: 'budgetMax', label: t(locale, 'crm_lead_field_budget_max'), type: 'number', value: lead.budgetMax },
        { key: 'propertyTypeWanted', label: t(locale, 'crm_req_property_type_field'), placeholder: t(locale, 'crm_req_property_type_placeholder'), value: lead.propertyTypeWanted },
        { key: 'purchaseGoal', label: t(locale, 'crm_req_purchase_goal_field'), placeholder: t(locale, 'crm_req_purchase_goal_placeholder'), value: lead.purchaseGoal },
        { key: 'preferredLocation', label: t(locale, 'crm_req_location_field'), placeholder: t(locale, 'crm_req_location_placeholder'), value: lead.preferredLocation },
        { key: 'minAreaSqm', label: t(locale, 'crm_req_min_area_field'), type: 'number', value: lead.minAreaSqm },
        { key: 'maxAreaSqm', label: t(locale, 'crm_req_max_area_field'), type: 'number', value: lead.maxAreaSqm },
        { key: 'expectedDeliveryTimeline', label: t(locale, 'crm_req_delivery_timeline_field'), placeholder: t(locale, 'crm_req_delivery_timeline_placeholder'), value: lead.expectedDeliveryTimeline },
        { key: 'maxDownPayment', label: t(locale, 'crm_req_max_down_payment_field'), type: 'number', value: lead.maxDownPayment },
        { key: 'maxInstallment', label: t(locale, 'crm_req_max_installment_field'), type: 'number', value: lead.maxInstallment },
        { key: 'preferredTenorMonths', label: t(locale, 'crm_req_tenor_field'), type: 'number', value: lead.preferredTenorMonths },
        { key: 'preferredTransferMethod', label: t(locale, 'crm_req_transfer_method_field'), placeholder: t(locale, 'crm_req_transfer_method_placeholder'), value: lead.preferredTransferMethod },
      ],
      submitLabel: t(locale, 'crm_requirements_submit'),
    });
    if (!result) return;
    if (!result.fullName.trim() || !result.phone.trim()) {
      reportError(new Error(t(locale, 'crm_lead_validation_required')));
      return;
    }
    const numeric = (v) => (v.trim() === '' ? undefined : Number(v));
    try {
      await api.patch(`/api/crm/leads/${lead.id}/details`, {
        fullName: result.fullName.trim(),
        phone: result.phone.trim(),
        source: result.source || undefined,
        interestedInType: result.interestedInType || undefined,
        interestedInLabel: result.interestedInLabel.trim() || undefined,
        budgetMin: numeric(result.budgetMin),
        budgetMax: numeric(result.budgetMax),
        propertyTypeWanted: result.propertyTypeWanted.trim() || undefined,
        purchaseGoal: result.purchaseGoal.trim() || undefined,
        preferredLocation: result.preferredLocation.trim() || undefined,
        minAreaSqm: numeric(result.minAreaSqm),
        maxAreaSqm: numeric(result.maxAreaSqm),
        expectedDeliveryTimeline: result.expectedDeliveryTimeline.trim() || undefined,
        maxDownPayment: numeric(result.maxDownPayment),
        maxInstallment: numeric(result.maxInstallment),
        preferredTenorMonths: numeric(result.preferredTenorMonths),
        preferredTransferMethod: result.preferredTransferMethod.trim() || undefined,
      });
      toast(t(locale, 'crm_requirements_saved_toast'), 'success');
      await reload?.();
    } catch (err) {
      reportError(err);
    }
  }

  async function grantPortalAccess(lead) {
    const result = await formModal({
      title: `${t(locale, 'crm_portal_modal_title_prefix')} ${lead.fullName}`,
      fields: [
        // The placeholder fallback is a generic example email address — left
        // as-is (not translated) since an email format reads the same in any locale.
        { key: 'email', label: t(locale, 'crm_portal_email_field'), placeholder: lead.email || 'client@example.com' },
        { key: 'password', label: t(locale, 'crm_portal_password_field'), placeholder: t(locale, 'crm_portal_password_placeholder') },
      ],
      submitLabel: t(locale, 'crm_portal_submit'),
    });
    if (!result || !result.email.trim() || !result.password.trim()) return;
    try {
      await api.post('/api/portal/grant-access', { leadId: lead.id, email: result.email.trim(), password: result.password });
      toast(t(locale, 'crm_portal_granted_toast'), 'success');
    } catch (err) {
      reportError(err);
    }
  }

  // ---- Add CRM Section (admin) ----

  async function openAddStageModal() {
    const result = await formModal({
      title: t(locale, 'crm_stage_modal_title'),
      fields: [
        { key: 'name', label: t(locale, 'crm_col_name'), placeholder: t(locale, 'crm_stage_name_placeholder') },
        { key: 'description', label: t(locale, 'crm_stage_description_field') },
        { key: 'icon', label: t(locale, 'crm_stage_icon_field') },
        { key: 'color', label: t(locale, 'crm_stage_color_field') },
        { key: 'order', label: t(locale, 'crm_stage_order_field'), type: 'number' },
        { key: 'isWon', label: t(locale, 'crm_stage_terminal_won_field'), type: 'select', options: [{ value: '', label: t(locale, 'crm_no') }, { value: 'yes', label: t(locale, 'crm_yes') }] },
        { key: 'isLost', label: t(locale, 'crm_stage_terminal_lost_field'), type: 'select', options: [{ value: '', label: t(locale, 'crm_no') }, { value: 'yes', label: t(locale, 'crm_yes') }] },
        { key: 'allowAutomationMove', label: t(locale, 'crm_stage_allow_automation_field'), type: 'select', options: [{ value: 'yes', label: t(locale, 'crm_yes') }, { value: '', label: t(locale, 'crm_no') }], value: 'yes' },
      ],
      submitLabel: t(locale, 'crm_stage_submit'),
    });
    if (!result || !result.name.trim()) return;
    try {
      await api.post('/api/crm/stages', {
        name: result.name.trim(),
        description: result.description.trim() || undefined,
        icon: result.icon.trim() || undefined,
        color: result.color.trim() || undefined,
        order: result.order.trim() === '' ? undefined : Number(result.order),
        isWon: result.isWon === 'yes',
        isLost: result.isLost === 'yes',
        allowAutomationMove: result.allowAutomationMove === 'yes',
      });
      toast(t(locale, 'crm_stage_added_toast'), 'success');
      await refreshAll();
    } catch (err) {
      reportError(err);
    }
  }

  // ---- Boot ----

  async function refreshAll() {
    await loadStages();
    renderToolbar();
    renderTabsBar();
    if (activeTab !== 'dashboard' && !stages.some((s) => s.id === activeTab) && !moduleTabs.some((m) => m.key === activeTab)) activeTab = 'dashboard';
    await renderBody();
  }

  try {
    await loadEmployees();
    await refreshAll();
  } catch (err) {
    clear(bodySlot);
    bodySlot.appendChild(errorBanner(err.message));
  }
}
