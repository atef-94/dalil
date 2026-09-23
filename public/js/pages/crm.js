import { el, clear, table, toast, errorBanner, statusBadge, badge, paginationControls, formModal, loadingState, searchInput, contentModal, tabs, statCard, emptyState, selectInput } from '../ui.js';
import { api } from '../api.js';
import { can, getLocale } from '../state.js';
import { t } from '../i18n.js';
import { setAiContext, clearAiContext } from './ai-panel.js';
import { openImportWizard } from '../import-wizard.js';
import { renderCustomers } from './customers.js';
import { renderOpportunities } from './opportunities.js';
import { renderTemplates } from './templates.js';
import { renderQuotations } from './quotations.js';
import { renderReservations } from './reservations.js';
import { renderContracts } from './contracts.js';
import { renderCommunication } from './communication.js';

/**
 * Sales/CRM restructuring: Leads, Follow-ups, Customers, Offers, Payment
 * Plans, Quotations, Reservations, Contracts, Communications, and Tasks all
 * live inside this one CRM workspace instead of as separate top-level
 * sidebar sections (see app.js's NAV) — each tab below reuses the exact
 * same page component/API/RBAC gate that used to be a standalone route, so
 * nothing is duplicated or rebuilt, only re-navigated to. "Activities" and
 * "Pipeline" (also named in the restructuring spec) aren't separate tabs:
 * Activities is a lead's own timeline/composer (already in the lead detail
 * panel below), and Pipeline is the Dashboard tab's real-time stage
 * breakdown — building distinct tabs for those would just duplicate what's
 * already here under another name.
 */
function reusedModuleTabs(locale) {
  return [
    { key: 'module:customers', label: t(locale, 'nav_customers'), resource: 'portal_access', render: renderCustomers },
    { key: 'module:offers', label: t(locale, 'nav_offers'), resource: 'opportunity', render: renderOpportunities },
    { key: 'module:payment-plans', label: t(locale, 'nav_templates'), resource: 'payment_plan_template', render: renderTemplates },
    { key: 'module:quotations', label: t(locale, 'nav_quotations'), resource: 'quotation', render: renderQuotations },
    { key: 'module:reservations', label: t(locale, 'nav_reservations'), resource: 'unit', render: renderReservations },
    { key: 'module:contracts', label: t(locale, 'nav_contracts'), resource: 'contract', render: renderContracts },
    { key: 'module:communications', label: t(locale, 'nav_communication'), resource: 'message', render: renderCommunication },
  ];
}

const TIMELINE_ICONS = {
  lead_created: '✦', status_changed: '↳', owner_changed: '⇄', message: '✉',
  task: '☑', opportunity_created: '★', contract_signed: '✔', contract_cancelled: '✖',
};

const PRIORITY_OPTIONS = [
  { value: '', label: '—' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

export async function renderCrm(container) {
  clear(container);
  const locale = getLocale();

  let stages = [];        // active stages, ordered
  let activeTab = 'dashboard';
  let offset = 0;
  let q = '';

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

  // Follow-ups and Tasks reuse existing APIs (leads' own SLA due date;
  // TaskService via /api/tasks/my) but had no dedicated list view before —
  // everything else in moduleTabs reuses a page that already existed as
  // its own top-level route.
  const moduleTabs = [
    ...reusedModuleTabs(locale),
    { key: 'module:followups', label: t(locale, 'nav_followups'), resource: 'lead', render: renderFollowUps },
    { key: 'module:tasks', label: t(locale, 'nav_tasks'), resource: 'task', render: renderTasksTab },
  ].filter((m) => can(m.resource, 'view'));

  // Only the reused-module tabs (Customers, Offers, Payment Plans, ...) live
  // in the horizontal tab bar. Dashboard and per-stage entries used to sit
  // here too, but they duplicated the real-time pipeline stage cards the
  // Dashboard already renders — a stage card is now the way into that
  // stage's lead list (see renderDashboard's statCard onClick below), and
  // the Dashboard itself is the workspace's default/home view rather than a
  // selectable tab.
  function renderTabsBar() {
    clear(tabsSlot);
    if (moduleTabs.length === 0) return;
    const items = moduleTabs.map((m) => ({ key: m.key, label: m.label }));
    tabsSlot.appendChild(tabs(items, activeTab, (key) => {
      activeTab = key;
      offset = 0;
      q = '';
      renderBody();
    }));
  }

  /** Leaves whatever's currently shown (a module tab or a stage's lead
   * list) and returns to the Dashboard's pipeline view — the tab bar has
   * no "active" entry for this, by design (see renderTabsBar above), so
   * this is reached via a stage-list's own "Back to Pipeline" link or by
   * re-opening CRM from the sidebar. */
  function goToDashboard() {
    activeTab = 'dashboard';
    offset = 0;
    q = '';
    renderTabsBar();
    renderBody();
  }

  async function renderBody() {
    clear(bodySlot);
    bodySlot.appendChild(loadingState());
    try {
      const moduleTab = moduleTabs.find((m) => m.key === activeTab);
      if (activeTab === 'dashboard') {
        await renderDashboard();
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

  // ---- CRM Dashboard tab ----

  async function renderDashboard() {
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

    clear(bodySlot);
    bodySlot.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, t(locale, 'crm_pipeline_realtime')),
      el('div', { class: 'stat-grid' }, funnel.stages.map((s) => statCard({
        label: s.stageName,
        value: s.count,
        // Each pipeline card IS the way into that stage's lead list now —
        // the horizontal stage-tab row this used to require was removed
        // because it only duplicated these same cards.
        onClick: () => { activeTab = s.stageId; offset = 0; q = ''; renderBody(); },
      }))),
    ]));
    bodySlot.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, t(locale, 'crm_today_followups')),
      el('div', { class: 'stat-grid' }, [
        statCard({ label: t(locale, 'crm_new_today'), value: newToday }),
        statCard({ label: t(locale, 'crm_followups_due_today'), value: followUpsToday }),
        statCard({ label: t(locale, 'crm_followups_overdue'), value: followUpsOverdue }),
        statCard({ label: t(locale, 'crm_total_leads'), value: funnel.totalLeads }),
      ]),
    ]));
    bodySlot.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, t(locale, 'crm_conversion')),
      el('div', { class: 'stat-grid' }, [
        statCard({ label: t(locale, 'crm_overall_win_rate'), value: `${conversion.overallWinRatePercent}%` }),
        statCard({ label: t(locale, 'crm_lost_rate'), value: `${conversion.lostRatePercent}%` }),
        statCard({ label: t(locale, 'crm_avg_speed'), value: speed.averageHours !== null ? `${speed.averageHours}h` : '—' }),
        statCard({ label: t(locale, 'crm_cost_per_qualified_lead'), value: costPerLead.costPerQualifiedLead !== null ? Number(costPerLead.costPerQualifiedLead).toLocaleString() : '—' }),
      ]),
      conversion.stageConversion.length > 0 ? el('div', { class: 'stat-grid', style: 'margin-top:10px' },
        conversion.stageConversion.map((s) => statCard({ label: `${s.fromStageName} → ${s.toStageName}`, value: `${s.conversionPercent}%` })),
      ) : null,
    ]));
  }

  // ---- Per-stage lead list ----

  async function renderStageList(stageId) {
    const stage = stages.find((s) => s.id === stageId);
    const search = searchInput(t(locale, 'crm_search_leads_placeholder'), (value) => { q = value; offset = 0; loadList(); });
    const listSlot = el('div');
    clear(bodySlot);
    const backLink = el('button', { class: 'ghost', style: 'padding:4px 0;margin-bottom:8px' }, `← ${t(locale, 'crm_back_to_pipeline')}`);
    backLink.addEventListener('click', goToDashboard);
    bodySlot.appendChild(backLink);
    bodySlot.appendChild(el('h2', { style: 'margin:0 0 12px' }, stage?.name ?? ''));
    bodySlot.appendChild(el('div', { class: 'form-row', style: 'max-width:320px;margin-bottom:10px' }, [search]));
    bodySlot.appendChild(listSlot);

    async function loadList() {
      clear(listSlot);
      listSlot.appendChild(loadingState());
      try {
        const page = await api.get('/api/crm/leads', { stageId, limit: 20, offset, q });
        clear(listSlot);
        listSlot.append(
          table(
            [
              { label: t(locale, 'crm_col_name'), key: 'fullName' },
              { label: t(locale, 'crm_col_phone'), key: 'phone' },
              { label: t(locale, 'crm_col_priority'), render: (l) => (l.priority ? badge(l.priority, l.priority === 'urgent' || l.priority === 'high' ? 'red' : '') : '—') },
              { label: t(locale, 'crm_col_owner'), render: (l) => (l.ownerEmployeeUserId ? l.ownerEmployeeUserId.slice(0, 8) + '…' : '—') },
              { label: '', render: (l) => rowActions(l, loadList) },
            ],
            page.items,
            { empty: stage?.isDefault ? t(locale, 'crm_no_fresh_leads') : `${t(locale, 'crm_no_leads_in_stage')} "${stage?.name}"` },
          ),
          paginationControls(page, (next) => { offset = next; loadList(); }),
        );
      } catch (err) {
        clear(listSlot);
        listSlot.appendChild(errorBanner(err.message));
      }
    }

    await loadList();
  }

  function rowActions(lead, reload) {
    const actions = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });

    const detailBtn = el('button', {}, t(locale, 'crm_action_open'));
    detailBtn.addEventListener('click', () => openLeadDetail(lead, reload));
    actions.appendChild(detailBtn);

    const moveBtn = el('button', {}, t(locale, 'crm_action_move_stage'));
    moveBtn.addEventListener('click', () => openMoveStageModal(lead, reload));
    actions.appendChild(moveBtn);

    const aiBtn = el('button', {}, t(locale, 'crm_action_ask_ai'));
    aiBtn.addEventListener('click', () => askAi(lead, reload));
    actions.appendChild(aiBtn);

    return actions;
  }

  // ---- Follow-ups tab (real leads whose first-contact SLA is due/overdue) ----

  async function renderFollowUps(target) {
    clear(target);
    target.appendChild(loadingState());
    try {
      const [leadsPage, stagesNow] = await Promise.all([
        api.get('/api/crm/leads', { limit: 200 }),
        api.get('/api/crm/stages'),
      ]);
      const stageById = new Map(stagesNow.map((s) => [s.id, s]));
      const now = Date.now();
      const due = leadsPage.items
        .filter((l) => {
          const stage = stageById.get(l.stageId);
          if (!l.firstContactSlaDueAt || stage?.isWon || stage?.isLost) return false;
          return true;
        })
        .map((l) => ({ ...l, dueMs: Date.parse(l.firstContactSlaDueAt) }))
        .sort((a, b) => a.dueMs - b.dueMs);

      clear(target);
      target.appendChild(el('p', { class: 'page-subtitle' }, 'Every active lead with a first-contact follow-up due, overdue first.'));
      target.appendChild(table(
        [
          { label: 'Name', key: 'fullName' },
          { label: 'Phone', key: 'phone' },
          { label: 'Stage', render: (l) => stageById.get(l.stageId)?.name ?? '—' },
          { label: 'Follow-up due', render: (l) => (l.dueMs < now ? badge(new Date(l.dueMs).toLocaleString(), 'red') : new Date(l.dueMs).toLocaleString()) },
          { label: '', render: (l) => rowActions(l, () => renderFollowUps(target)) },
        ],
        due,
        { empty: 'No follow-ups due — every active lead has been contacted on time.' },
      ));
    } catch (err) {
      clear(target);
      target.appendChild(errorBanner(err.message));
    }
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
            { label: 'Title', key: 'title' },
            { label: 'Status', render: (t) => statusBadge(t.status) },
            { label: 'Due', render: (t) => (t.dueAt ? new Date(t.dueAt).toLocaleString() : '—') },
            { label: '', render: (t) => {
              if (t.status !== 'open') return '';
              const actions = el('div', { style: 'display:flex;gap:6px' });
              const completeBtn = el('button', {}, 'Complete');
              completeBtn.addEventListener('click', async () => {
                try { await api.post(`/api/tasks/${t.id}/complete`, {}); toast('Task completed.', 'success'); await load(); }
                catch (err) { toast(err.message, 'error'); }
              });
              const cancelBtn = el('button', {}, 'Cancel');
              cancelBtn.addEventListener('click', async () => {
                try { await api.post(`/api/tasks/${t.id}/cancel`, {}); toast('Task cancelled.', 'success'); await load(); }
                catch (err) { toast(err.message, 'error'); }
              });
              actions.append(completeBtn, cancelBtn);
              return actions;
            } },
          ],
          page.items,
          { empty: 'No tasks assigned to you yet — schedule a follow-up from a lead to create one.' },
        ));
      } catch (err) {
        clear(target);
        target.appendChild(errorBanner(err.message));
      }
    }

    await load();
  }

  // ---- Add Lead ----

  async function openAddLeadModal() {
    const defaultStage = stages.find((s) => s.id === activeTab) || stages.find((s) => s.isDefault);
    const result = await formModal({
      title: 'Add New Lead',
      fields: [
        { key: 'fullName', label: 'Full name' },
        { key: 'phone', label: 'Mobile' },
        { key: 'email', label: 'Email (optional)' },
        { key: 'nationalId', label: 'National ID (optional — strongest duplicate check)' },
        { key: 'sourceId', label: 'Source / Campaign (optional)' },
        { key: 'stageId', label: 'Initial stage', type: 'select', options: stages.map((s) => ({ value: s.id, label: s.name })), value: defaultStage?.id },
        { key: 'priority', label: 'Priority', type: 'select', options: PRIORITY_OPTIONS },
        { key: 'tags', label: 'Tags (comma-separated, optional)' },
        { key: 'notes', label: 'Initial note (optional)', type: 'textarea' },
      ],
      submitLabel: 'Add lead',
    });
    if (!result) return;
    if (!result.fullName.trim() || !result.phone.trim()) {
      reportError(new Error('Full name and phone are required.'));
      return;
    }
    try {
      const lead = await api.post('/api/crm/leads', {
        fullName: result.fullName.trim(),
        phone: result.phone.trim(),
        email: result.email.trim() || undefined,
        nationalId: result.nationalId.trim() || undefined,
        sourceId: result.sourceId.trim() || undefined,
        stageId: result.stageId || undefined,
        priority: result.priority || undefined,
        tags: result.tags.trim() ? result.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
      });
      if (result.notes.trim()) {
        await api.post('/api/communication/messages', {
          subject: 'Note', body: result.notes.trim(), channel: 'note', relatedResource: 'lead', relatedResourceId: lead.id,
        }).catch(() => {}); // the lead itself is already saved — a failed note shouldn't look like a failed lead creation
      }
      toast(`Lead added — landed in "${stages.find((s) => s.id === lead.stageId)?.name || 'its stage'}".`, 'success');
      await refreshAll();
    } catch (err) {
      reportError(err);
    }
  }

  // ---- Move stage ----

  async function openMoveStageModal(lead, reload) {
    const result = await formModal({
      title: `Move "${lead.fullName}"`,
      fields: [
        { key: 'stageId', label: 'New stage', type: 'select', options: stages.map((s) => ({ value: s.id, label: s.name })), value: lead.stageId },
        { key: 'lostReason', label: 'Lost reason (required only when the new stage is Lost-flagged)' },
      ],
      submitLabel: 'Move',
    });
    if (!result) return;
    try {
      await api.patch(`/api/crm/leads/${lead.id}/stage`, { stageId: result.stageId, lostReason: result.lostReason.trim() || undefined });
      const target = stages.find((s) => s.id === result.stageId);
      toast(`Moved to "${target?.name}".`, 'success');
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
      const prefix = `[${decision.confidence}% confidence] `;
      if (decision.status === 'no_action') {
        toast(`${prefix}AI: ${decision.reasoning}`, 'info');
      } else if (decision.status === 'escalated') {
        toast(`${prefix}AI escalated to a human: ${decision.reasoning}`, 'info');
      } else if (decision.resultActionStatus === 'executed') {
        toast(`${prefix}AI executed: ${decision.reasoning}`, 'success');
        await refreshAll();
        reload?.();
      } else if (decision.resultActionStatus === 'pending_approval') {
        toast(`${prefix}AI suggests: ${decision.reasoning} — awaiting approval on the Approvals page.`, 'info');
      } else {
        toast(`${prefix}AI suggests: ${decision.reasoning}`, 'info');
      }
    } catch (err) {
      reportError(err);
    }
  }

  // ---- Lead detail: activity timeline, comments, requirements, tags/priority, reassign, portal ----

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
      let fresh, timeline, score;
      try {
        [fresh, timeline] = await Promise.all([
          api.get(`/api/crm/leads/${lead.id}`),
          api.get(`/api/crm/leads/${lead.id}/timeline`),
        ]);
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
      const DELIVERY_COLORS = { delivered: 'green', read: 'green', sent: 'blue', queued: 'amber', failed: 'red', rejected: 'red', unknown: '' };
      const header = el('div', { style: 'display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-bottom:14px' }, [
        statusBadge(stage?.name || lead.stageId),
        lead.priority ? badge(lead.priority, lead.priority === 'urgent' || lead.priority === 'high' ? 'red' : '') : null,
        deliveryStatus && deliveryStatus.status !== 'unknown' ? badge(`Delivery: ${deliveryStatus.status}`, DELIVERY_COLORS[deliveryStatus.status] || '') : null,
        score ? el('span', { class: 'muted' }, `Score: ${score.score}/100`) : null,
        el('span', { class: 'muted' }, lead.phone),
        lead.email ? el('span', { class: 'muted' }, lead.email) : null,
      ]);
      body.appendChild(header);

      const actionsRow = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px' });
      const moveBtn = el('button', {}, 'Move stage');
      moveBtn.addEventListener('click', async () => { await openMoveStageModal(lead, null); await refreshDetail(); reload?.(); });
      actionsRow.appendChild(moveBtn);

      const reassignBtn = el('button', {}, 'Reassign owner');
      reassignBtn.addEventListener('click', () => reassignOwner(lead, refreshDetail));
      actionsRow.appendChild(reassignBtn);

      const tagsBtn = el('button', {}, 'Edit tags / priority');
      tagsBtn.addEventListener('click', () => editTagsAndPriority(lead, refreshDetail));
      actionsRow.appendChild(tagsBtn);

      const reqBtn = el('button', {}, 'Requirements');
      reqBtn.addEventListener('click', () => editDetails(lead, refreshDetail));
      actionsRow.appendChild(reqBtn);

      const portalBtn = el('button', {}, 'Grant portal access');
      portalBtn.addEventListener('click', () => grantPortalAccess(lead));
      actionsRow.appendChild(portalBtn);

      const aiBtn = el('button', {}, 'Ask AI');
      aiBtn.addEventListener('click', async () => { await askAi(lead, null); await refreshDetail(); reload?.(); });
      actionsRow.appendChild(aiBtn);
      body.appendChild(actionsRow);

      if (lead.tags?.length) {
        body.appendChild(el('div', { style: 'margin-bottom:14px' }, lead.tags.map((tag) => badge(tag))));
      }

      // ---- Offers: unit code -> auto-filled unit/payment data -> a real
      // Offer PDF the sales team can print or send over WhatsApp. Reuses
      // the Quotation/Offer engine (quotation.service.ts) — the same
      // deep-snapshot payment schedule, PDF, and WhatsApp document send
      // every other Offer surface uses; nothing here is a second path. ----
      if (can('quotation', 'create')) {
        const unitCodeInput = el('input', { type: 'text', placeholder: 'Unit code, e.g. A-1203' });
        const lookupBtn = el('button', {}, 'Look up');
        const offerUnitInfo = el('div', { class: 'muted', style: 'margin-top:6px' });
        const offerTemplateSelect = selectInput([]);
        const offerDiscountInput = el('input', { type: 'number', placeholder: '0', value: '0' });
        const createOfferBtn = el('button', { class: 'primary' }, 'Create Offer');
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
              el('div', {}, `${result.unit.areaSqm} m² · ${Number(result.unit.listPrice).toLocaleString()}${result.unit.floorLabel ? ` · Floor ${result.unit.floorLabel}` : ''}${result.unit.buildingLabel ? ` · Building ${result.unit.buildingLabel}` : ''}`),
            ]));
            createOfferBtn.disabled = false;
          } catch (err) {
            offerUnitInfo.appendChild(errorBanner(err.message));
          } finally {
            lookupBtn.disabled = false;
          }
        });

        const offersListSlot = el('div', { style: 'margin-top:10px' });

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
          URL.revokeObjectURL(url);
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
            title: `Send Offer ${quotation.referenceNumber} via WhatsApp`,
            fields: [
              { key: 'to', label: 'WhatsApp number (intl format, e.g. 201234567890)', type: 'text', value: lead.phone || '' },
              { key: 'message', label: 'Message', type: 'textarea', value: `Hi ${lead.fullName}, here is your offer.` },
            ],
            submitLabel: 'Send',
          });
          if (!values || !values.to?.trim()) return;
          try {
            await api.post(`/api/quotations/${quotation.id}/send-whatsapp`, { to: values.to.trim(), message: values.message });
            toast('Offer sent via WhatsApp.', 'success');
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
                { label: 'Reference', key: 'referenceNumber' },
                { label: 'Status', render: (q) => statusBadge(q.status) },
                { label: 'Created', render: (q) => new Date(q.createdAt).toLocaleString() },
                { label: '', render: (q) => {
                  const printBtn = el('button', {}, 'Print');
                  printBtn.addEventListener('click', () => downloadOfferPdf(q));
                  const waBtn = el('button', {}, 'Send via WhatsApp');
                  waBtn.addEventListener('click', () => sendOfferWhatsApp(q));
                  return el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, [printBtn, waBtn]);
                } },
              ],
              page.items,
              { empty: 'No offers created yet for this lead.' },
            ));
          } catch (err) {
            offersListSlot.appendChild(errorBanner(err.message));
          }
        }

        createOfferBtn.addEventListener('click', async () => {
          if (!foundUnit || !offerTemplateSelect.value) {
            toast('Look up a unit and choose a payment plan first.', 'error');
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
            toast(`Offer ${quotation.referenceNumber} created.`, 'success');
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

        body.appendChild(el('div', { class: 'card' }, [
          el('h4', { style: 'margin-top:0' }, 'Offers'),
          el('div', { class: 'form-row' }, [
            el('div', {}, [el('label', {}, 'Unit code'), unitCodeInput]),
            el('div', { style: 'align-self:flex-end' }, lookupBtn),
            el('div', {}, [el('label', {}, 'Payment plan'), offerTemplateSelect]),
            el('div', {}, [el('label', {}, 'Discount %'), offerDiscountInput]),
          ]),
          offerUnitInfo,
          el('div', { class: 'form-actions' }, [createOfferBtn]),
          offersListSlot,
        ]));
        await loadOffers();
      }

      // ---- Log activity: comment / call / WhatsApp note ----
      const channelSelect = el('select', {}, [
        el('option', { value: 'note' }, 'Note'),
        el('option', { value: 'call' }, 'Call log'),
        el('option', { value: 'whatsapp' }, 'WhatsApp'),
        el('option', { value: 'email' }, 'Email'),
        el('option', { value: 'internal' }, 'Internal message'),
      ]);
      const activityInput = el('textarea', { rows: 2, placeholder: 'Log a call, WhatsApp exchange, or note…' });
      const logBtn = el('button', { class: 'primary' }, 'Log activity');
      logBtn.addEventListener('click', async () => {
        if (!activityInput.value.trim()) return;
        logBtn.disabled = true;
        try {
          await api.post('/api/communication/messages', {
            subject: channelSelect.value === 'call' ? 'Call logged' : 'Note',
            body: activityInput.value.trim(),
            channel: channelSelect.value,
            relatedResource: 'lead',
            relatedResourceId: lead.id,
          });
          activityInput.value = '';
          toast('Activity logged.', 'success');
          await refreshDetail();
        } catch (err) {
          reportError(err);
        } finally {
          logBtn.disabled = false;
        }
      });
      body.appendChild(el('div', { class: 'card' }, [
        el('h4', { style: 'margin-top:0' }, 'Log activity'),
        el('div', { class: 'form-row' }, [
          el('div', { style: 'max-width:160px' }, [el('label', {}, 'Channel'), channelSelect]),
          el('div', { style: 'flex:2' }, [el('label', {}, 'Details'), activityInput]),
        ]),
        el('div', { class: 'form-actions' }, [logBtn]),
      ]));

      // ---- Schedule a follow-up (a Task tied to this lead) ----
      const followUpInput = el('input', { type: 'text', placeholder: 'e.g. Call back about pricing' });
      const followUpDate = el('input', { type: 'datetime-local' });
      const scheduleBtn = el('button', {}, 'Schedule follow-up');
      scheduleBtn.addEventListener('click', async () => {
        if (!followUpInput.value.trim()) return;
        try {
          await api.post('/api/tasks', {
            title: followUpInput.value.trim(),
            relatedResource: 'lead',
            relatedResourceId: lead.id,
            dueAt: followUpDate.value ? new Date(followUpDate.value).toISOString() : undefined,
          });
          followUpInput.value = '';
          toast('Follow-up scheduled.', 'success');
          await refreshDetail();
        } catch (err) {
          reportError(err);
        }
      });
      body.appendChild(el('div', { class: 'card' }, [
        el('h4', { style: 'margin-top:0' }, 'Schedule a follow-up'),
        el('div', { class: 'form-row' }, [
          el('div', {}, [el('label', {}, 'Title'), followUpInput]),
          el('div', {}, [el('label', {}, 'When'), followUpDate]),
        ]),
        el('div', { class: 'form-actions' }, [scheduleBtn]),
      ]));

      // ---- Activity timeline ----
      const timelineCard = el('div', { class: 'card' }, [el('h4', { style: 'margin-top:0' }, 'Activity timeline')]);
      if (timeline.entries.length === 0) {
        timelineCard.appendChild(el('p', { class: 'muted' }, 'No activity recorded yet.'));
      } else {
        timelineCard.appendChild(el('div', {}, [...timeline.entries].reverse().map((e) => el('div', {
          style: 'display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border,#e5e5e5)',
        }, [
          el('span', {}, TIMELINE_ICONS[e.type] || '•'),
          el('div', {}, [
            el('div', {}, e.summary),
            el('div', { class: 'muted', style: 'font-size:12px' }, new Date(e.at).toLocaleString()),
          ]),
        ]))));
      }
      body.appendChild(timelineCard);
    }

    await refreshDetail();
  }

  async function reassignOwner(lead, reload) {
    const result = await formModal({
      title: `Reassign "${lead.fullName}"`,
      fields: [{ key: 'ownerEmployeeUserId', label: 'New owner (user id)', value: lead.ownerEmployeeUserId }],
      submitLabel: 'Reassign',
    });
    if (!result || !result.ownerEmployeeUserId.trim()) return;
    try {
      await api.patch(`/api/crm/leads/${lead.id}/owner`, { ownerEmployeeUserId: result.ownerEmployeeUserId.trim() });
      toast('Lead reassigned.', 'success');
      await reload?.();
    } catch (err) {
      reportError(err);
    }
  }

  async function editTagsAndPriority(lead, reload) {
    const result = await formModal({
      title: `Tags & priority — ${lead.fullName}`,
      fields: [
        { key: 'priority', label: 'Priority', type: 'select', options: PRIORITY_OPTIONS, value: lead.priority || '' },
        { key: 'tags', label: 'Tags (comma-separated)', value: (lead.tags || []).join(', ') },
      ],
      submitLabel: 'Save',
    });
    if (!result) return;
    try {
      await api.patch(`/api/crm/leads/${lead.id}/tags`, {
        priority: result.priority || undefined,
        tags: result.tags.split(',').map((t) => t.trim()).filter(Boolean),
      });
      toast('Saved.', 'success');
      await reload?.();
    } catch (err) {
      reportError(err);
    }
  }

  async function editDetails(lead, reload) {
    const result = await formModal({
      title: `Requirements — ${lead.fullName}`,
      fields: [
        { key: 'propertyTypeWanted', label: 'Property type wanted', placeholder: 'e.g. apartment, villa', value: lead.propertyTypeWanted },
        { key: 'purchaseGoal', label: 'Purchase goal', placeholder: 'e.g. investment, end use', value: lead.purchaseGoal },
        { key: 'preferredLocation', label: 'Preferred location', placeholder: 'e.g. New Cairo', value: lead.preferredLocation },
        { key: 'minAreaSqm', label: 'Min area (sqm)', type: 'number', value: lead.minAreaSqm },
        { key: 'maxAreaSqm', label: 'Max area (sqm)', type: 'number', value: lead.maxAreaSqm },
        { key: 'expectedDeliveryTimeline', label: 'Expected delivery timeline', placeholder: 'e.g. ready to move, off-plan ok', value: lead.expectedDeliveryTimeline },
        { key: 'maxDownPayment', label: 'Max down payment', type: 'number', value: lead.maxDownPayment },
        { key: 'maxInstallment', label: 'Max monthly installment', type: 'number', value: lead.maxInstallment },
        { key: 'preferredTenorMonths', label: 'Preferred tenor (months)', type: 'number', value: lead.preferredTenorMonths },
        { key: 'preferredTransferMethod', label: 'Preferred transfer method', placeholder: 'e.g. cash, bank transfer', value: lead.preferredTransferMethod },
      ],
      submitLabel: 'Save requirements',
    });
    if (!result) return;
    const numeric = (v) => (v.trim() === '' ? undefined : Number(v));
    try {
      await api.patch(`/api/crm/leads/${lead.id}/details`, {
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
      toast('Requirements saved.', 'success');
      await reload?.();
    } catch (err) {
      reportError(err);
    }
  }

  async function grantPortalAccess(lead) {
    const result = await formModal({
      title: `Grant customer portal access to ${lead.fullName}`,
      fields: [
        { key: 'email', label: 'Login email', placeholder: lead.email || 'client@example.com' },
        { key: 'password', label: 'Temporary password', placeholder: 'At least 8 characters' },
      ],
      submitLabel: 'Grant access',
    });
    if (!result || !result.email.trim() || !result.password.trim()) return;
    try {
      await api.post('/api/portal/grant-access', { leadId: lead.id, email: result.email.trim(), password: result.password });
      toast('Portal access granted — share the login details with the client.', 'success');
    } catch (err) {
      reportError(err);
    }
  }

  // ---- Add CRM Section (admin) ----

  async function openAddStageModal() {
    const result = await formModal({
      title: 'Add CRM Section',
      fields: [
        { key: 'name', label: 'Name', placeholder: 'e.g. Site Visit Scheduled' },
        { key: 'description', label: 'Description (optional)' },
        { key: 'icon', label: 'Icon (optional, free text)' },
        { key: 'color', label: 'Color (optional, e.g. #22c55e)' },
        { key: 'order', label: 'Pipeline position (lower sorts first)', type: 'number' },
        { key: 'isWon', label: 'Terminal — Won', type: 'select', options: [{ value: '', label: 'No' }, { value: 'yes', label: 'Yes' }] },
        { key: 'isLost', label: 'Terminal — Lost', type: 'select', options: [{ value: '', label: 'No' }, { value: 'yes', label: 'Yes' }] },
        { key: 'allowAutomationMove', label: 'Automations may move leads into this stage', type: 'select', options: [{ value: 'yes', label: 'Yes' }, { value: '', label: 'No' }], value: 'yes' },
      ],
      submitLabel: 'Add section',
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
      toast('CRM section added — it now appears as a pipeline card, no code changes needed.', 'success');
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
    await refreshAll();
  } catch (err) {
    clear(bodySlot);
    bodySlot.appendChild(errorBanner(err.message));
  }
}
