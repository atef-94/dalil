import { el, clear, table, toast, errorBanner, statusBadge, paginationControls, formModal, loadingState, searchInput, contentModal } from '../ui.js';
import { api } from '../api.js';

const TIMELINE_ICONS = {
  lead_created: '✦', status_changed: '↳', owner_changed: '⇄', message: '✉',
  task: '☑', opportunity_created: '★', contract_signed: '✔', contract_cancelled: '✖',
};

const NEXT_STATUS = { new: 'contacted', contacted: 'qualified', qualified: 'opportunity' };

export async function renderLeads(container) {
  clear(container);
  let offset = 0;
  let q = '';
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, 'Leads')));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const nameInput = el('input', { type: 'text', placeholder: 'Full name' });
  const phoneInput = el('input', { type: 'text', placeholder: '010-000-0000' });
  const emailInput = el('input', { type: 'email', placeholder: 'optional' });
  const sourceInput = el('input', { type: 'text', placeholder: 'e.g. walk-in, website (optional)' });
  const createBtn = el('button', { class: 'primary' }, 'Add lead');

  createBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!nameInput.value.trim() || !phoneInput.value.trim()) {
      errorSlot.appendChild(errorBanner('Full name and phone are required.'));
      return;
    }
    createBtn.disabled = true;
    try {
      await api.post('/api/crm/leads', {
        fullName: nameInput.value.trim(),
        phone: phoneInput.value.trim(),
        email: emailInput.value.trim() || undefined,
        sourceId: sourceInput.value.trim() || undefined,
      });
      nameInput.value = ''; phoneInput.value = ''; emailInput.value = ''; sourceInput.value = '';
      toast('Lead added.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Add a lead'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Full name'), nameInput]),
      el('div', {}, [el('label', {}, 'Phone'), phoneInput]),
      el('div', {}, [el('label', {}, 'Email'), emailInput]),
      el('div', {}, [el('label', {}, 'Source'), sourceInput]),
    ]),
    el('div', { class: 'form-actions' }, [createBtn]),
  ]));

  const search = searchInput('Search by name, phone, or email…', (value) => { q = value; offset = 0; load(); });
  container.appendChild(el('div', { class: 'form-row', style: 'max-width:320px' }, [search]));

  const listSlot = el('div');
  container.appendChild(listSlot);

  async function advance(lead, btn) {
    const next = NEXT_STATUS[lead.status];
    if (!next) return;
    try {
      await api.patch(`/api/crm/leads/${lead.id}/status`, { status: next });
      toast(`Lead moved to "${next}".`, 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function markLost(lead) {
    const result = await formModal({
      title: `Mark "${lead.fullName}" as lost`,
      fields: [{ key: 'reason', label: 'Reason', type: 'textarea', placeholder: 'e.g. went with a competitor' }],
      submitLabel: 'Mark lost',
    });
    if (!result || !result.reason.trim()) return;
    const reason = result.reason.trim();
    try {
      await api.patch(`/api/crm/leads/${lead.id}/status`, { status: 'lost', lostReason: reason });
      toast('Lead marked lost.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function askAi(lead) {
    try {
      const decision = await api.post(`/api/crm/leads/${lead.id}/suggest-next-action`, {});
      const confidencePrefix = `[${decision.confidence}% confidence] `;
      if (decision.status === 'no_action') {
        toast(`${confidencePrefix}AI: ${decision.reasoning}`, 'info');
      } else if (decision.status === 'escalated') {
        toast(`${confidencePrefix}AI escalated to a human: ${decision.reasoning}`, 'info');
      } else if (decision.resultActionStatus === 'executed') {
        toast(`${confidencePrefix}AI executed: ${decision.reasoning}`, 'success');
        await load();
      } else if (decision.resultActionStatus === 'pending_approval') {
        toast(`${confidencePrefix}AI suggests: ${decision.reasoning} — awaiting approval on the AI page.`, 'info');
      } else {
        toast(`${confidencePrefix}AI suggests: ${decision.reasoning}`, 'info');
      }
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function editDetails(lead) {
    const result = await formModal({
      title: `Requirements for ${lead.fullName}`,
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
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function openTimeline(lead) {
    const body = el('div', {});
    body.appendChild(loadingState());
    contentModal(`${lead.fullName} — Timeline`, body);
    try {
      const timeline = await api.get(`/api/crm/leads/${lead.id}/timeline`);
      clear(body);
      if (timeline.entries.length === 0) {
        body.appendChild(el('p', { class: 'muted' }, 'No activity recorded yet.'));
      }
      body.appendChild(el('div', { class: 'timeline' }, timeline.entries.map((e) => el('div', { class: 'timeline-entry', style: 'display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border,#e5e5e5)' }, [
        el('span', {}, TIMELINE_ICONS[e.type] || '•'),
        el('div', {}, [
          el('div', {}, e.summary),
          el('div', { class: 'muted', style: 'font-size:12px' }, new Date(e.at).toLocaleString()),
        ]),
      ]))));
    } catch (err) {
      clear(body);
      body.appendChild(errorBanner(err.message));
    }
  }

  async function grantPortalAccess(lead) {
    const result = await formModal({
      title: `Grant customer portal access to ${lead.fullName}`,
      fields: [
        { key: 'email', label: 'Login email', type: 'text', placeholder: lead.email || 'client@example.com' },
        { key: 'password', label: 'Temporary password', type: 'text', placeholder: 'At least 8 characters' },
      ],
      submitLabel: 'Grant access',
    });
    if (!result || !result.email.trim() || !result.password.trim()) return;
    try {
      await api.post('/api/portal/grant-access', { leadId: lead.id, email: result.email.trim(), password: result.password });
      toast('Portal access granted — share the login details with the client.', 'success');
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/crm/leads', { limit: 20, offset, q });
      clear(listSlot);
      listSlot.append(table(
        [
          { label: 'Name', key: 'fullName' },
          { label: 'Phone', key: 'phone' },
          { label: 'Status', render: (l) => statusBadge(l.status) },
          { label: '', render: (l) => {
            const actions = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
            const detailsBtn = el('button', {}, 'Requirements');
            detailsBtn.addEventListener('click', () => editDetails(l));
            actions.appendChild(detailsBtn);
            const timelineBtn = el('button', {}, 'Timeline');
            timelineBtn.addEventListener('click', () => openTimeline(l));
            actions.appendChild(timelineBtn);
            if (NEXT_STATUS[l.status]) {
              const btn = el('button', {}, `→ ${NEXT_STATUS[l.status]}`);
              btn.addEventListener('click', () => { btn.disabled = true; advance(l, btn); });
              actions.appendChild(btn);
            }
            if (l.status !== 'lost' && l.status !== 'opportunity') {
              const lostBtn = el('button', {}, 'Mark lost');
              lostBtn.addEventListener('click', () => markLost(l));
              actions.appendChild(lostBtn);
            }
            if (l.status !== 'lost' && l.status !== 'opportunity') {
              const aiBtn = el('button', {}, 'Ask AI');
              aiBtn.addEventListener('click', () => askAi(l));
              actions.appendChild(aiBtn);
            }
            if (l.status !== 'lost') {
              // Portal access is tied to the lead record itself, not to
              // whether a Sales Opportunity happens to exist for it yet
              // (those are independent state machines) — so this is
              // available for any active lead, not just ones already
              // converted.
              const portalBtn = el('button', {}, 'Grant portal access');
              portalBtn.addEventListener('click', () => grantPortalAccess(l));
              actions.appendChild(portalBtn);
            }
            return actions;
          } },
        ],
        page.items,
        { empty: 'No leads yet — add one above.' },
      ), paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
