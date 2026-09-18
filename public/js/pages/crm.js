import { el, clear, table, toast, errorBanner, statusBadge, badge, paginationControls, formModal, loadingState, searchInput, contentModal, tabs, statCard, emptyState } from '../ui.js';
import { api } from '../api.js';
import { can } from '../state.js';
import { setAiContext, clearAiContext } from './ai-panel.js';
import { openImportWizard } from '../import-wizard.js';

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

  let stages = [];        // active stages, ordered
  let activeTab = 'dashboard';
  let offset = 0;
  let q = '';

  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, 'CRM'),
      el('p', { class: 'page-subtitle' }, 'One Lead record moves through these stages — it is never duplicated. Stages are fully configurable from "+ Add CRM Section" below.'),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const toolbarSlot = el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-bottom:10px' });
  const tabsSlot = el('div');
  const bodySlot = el('div');
  container.appendChild(toolbarSlot);
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
      const addLeadBtn = el('button', { class: 'primary' }, '+ Add New Lead');
      addLeadBtn.addEventListener('click', openAddLeadModal);
      toolbarSlot.appendChild(addLeadBtn);

      const importBtn = el('button', {}, 'Import Leads');
      importBtn.addEventListener('click', () => {
        openImportWizard({
          title: 'Import Leads',
          uploadPath: '/api/crm/leads/import/upload',
          onImported: () => { renderBody(); },
        });
      });
      toolbarSlot.appendChild(importBtn);
    }
    if (can('crm_stage', 'create')) {
      const addStageBtn = el('button', {}, '+ Add CRM Section');
      addStageBtn.addEventListener('click', openAddStageModal);
      toolbarSlot.appendChild(addStageBtn);
    }
  }

  function renderTabsBar() {
    clear(tabsSlot);
    const items = [{ key: 'dashboard', label: 'CRM Dashboard' }, ...stages.map((s) => ({ key: s.id, label: s.isDefault ? `${s.name} (Fresh)` : s.name }))];
    tabsSlot.appendChild(tabs(items, activeTab, (key) => {
      activeTab = key;
      offset = 0;
      q = '';
      renderBody();
    }));
  }

  async function renderBody() {
    clear(bodySlot);
    bodySlot.appendChild(loadingState());
    try {
      if (activeTab === 'dashboard') {
        await renderDashboard();
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
    // leads list the stage tabs use, so "new today"/"follow-ups" always
    // reflect real current data rather than a cached number.
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
      el('h3', { style: 'margin-top:0' }, 'Pipeline — real-time'),
      el('div', { class: 'stat-grid' }, funnel.stages.map((s) => statCard({ label: s.stageName, value: s.count }))),
    ]));
    bodySlot.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, 'Today & follow-ups'),
      el('div', { class: 'stat-grid' }, [
        statCard({ label: 'New today', value: newToday }),
        statCard({ label: 'Follow-ups due today', value: followUpsToday }),
        statCard({ label: 'Follow-ups overdue', value: followUpsOverdue }),
        statCard({ label: 'Total leads', value: funnel.totalLeads }),
      ]),
    ]));
    bodySlot.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, 'Conversion'),
      el('div', { class: 'stat-grid' }, [
        statCard({ label: 'Overall win rate', value: `${conversion.overallWinRatePercent}%` }),
        statCard({ label: 'Lost rate', value: `${conversion.lostRatePercent}%` }),
        statCard({ label: 'Avg. speed to first contact', value: speed.averageHours !== null ? `${speed.averageHours}h` : '—' }),
        statCard({ label: 'Cost per qualified lead', value: costPerLead.costPerQualifiedLead !== null ? Number(costPerLead.costPerQualifiedLead).toLocaleString() : '—' }),
      ]),
      conversion.stageConversion.length > 0 ? el('div', { class: 'stat-grid', style: 'margin-top:10px' },
        conversion.stageConversion.map((s) => statCard({ label: `${s.fromStageName} → ${s.toStageName}`, value: `${s.conversionPercent}%` })),
      ) : null,
    ]));
  }

  // ---- Per-stage lead list ----

  async function renderStageList(stageId) {
    const stage = stages.find((s) => s.id === stageId);
    const search = searchInput('Search by name, phone, or email…', (value) => { q = value; offset = 0; loadList(); });
    const listSlot = el('div');
    clear(bodySlot);
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
              { label: 'Name', key: 'fullName' },
              { label: 'Phone', key: 'phone' },
              { label: 'Priority', render: (l) => (l.priority ? badge(l.priority, l.priority === 'urgent' || l.priority === 'high' ? 'red' : '') : '—') },
              { label: 'Owner', render: (l) => (l.ownerEmployeeUserId ? l.ownerEmployeeUserId.slice(0, 8) + '…' : '—') },
              { label: '', render: (l) => rowActions(l, loadList) },
            ],
            page.items,
            { empty: stage?.isDefault ? 'No fresh leads yet — add one above.' : `No leads in "${stage?.name}" yet.` },
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

    const detailBtn = el('button', {}, 'Open');
    detailBtn.addEventListener('click', () => openLeadDetail(lead, reload));
    actions.appendChild(detailBtn);

    const moveBtn = el('button', {}, 'Move stage');
    moveBtn.addEventListener('click', () => openMoveStageModal(lead, reload));
    actions.appendChild(moveBtn);

    const aiBtn = el('button', {}, 'Ask AI');
    aiBtn.addEventListener('click', () => askAi(lead, reload));
    actions.appendChild(aiBtn);

    return actions;
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

      const stage = stages.find((s) => s.id === lead.stageId);
      const header = el('div', { style: 'display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-bottom:14px' }, [
        statusBadge(stage?.name || lead.stageId),
        lead.priority ? badge(lead.priority, lead.priority === 'urgent' || lead.priority === 'high' ? 'red' : '') : null,
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
      toast('CRM section added — it now appears in the tab bar, no code changes needed.', 'success');
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
    if (activeTab !== 'dashboard' && !stages.some((s) => s.id === activeTab)) activeTab = 'dashboard';
    await renderBody();
  }

  try {
    await refreshAll();
  } catch (err) {
    clear(bodySlot);
    bodySlot.appendChild(errorBanner(err.message));
  }
}
