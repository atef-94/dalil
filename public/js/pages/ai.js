import { el, clear, table, toast, errorBanner, statusBadge, loadingState, selectInput } from '../ui.js';
import { api } from '../api.js';

// require_approval and ai_decide are workflow-only meta-actions (the
// former pauses a run for a human decision, the latter hands a subject to
// a specialized agent) — neither is something the AI itself "performs" as
// a chosen action, so both are left out of the policy list here.
const AI_ACTION_TYPES = ['create_task', 'create_lead', 'send_message', 'update_lead_status', 'assign_lead_owner', 'update_campaign_status', 'webhook_call', 'integration_call'];
const AUTONOMY_LEVELS = [
  { value: 'suggest_only', label: 'Suggest only — never executes' },
  { value: 'require_approval', label: 'Require approval (default)' },
  { value: 'auto_execute', label: 'Auto-execute' },
];

export async function renderAi(container) {
  clear(container);
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, 'AI Execution Layer')));
  container.appendChild(el('p', { class: 'muted' },
    'Every action here — whether suggested, auto-executed, or paused for approval — passes through the same permission, policy, approval, and audit systems as the Automation Engine. AI never bypasses them.'));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  // ---- Policies ----
  const policiesSlot = el('div', { class: 'card' });
  container.appendChild(policiesSlot);

  async function loadPolicies() {
    clear(policiesSlot);
    policiesSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Autonomy policy per action type'));
    policiesSlot.appendChild(el('p', { class: 'muted' }, 'An action type with no policy set defaults to "require approval" — the AI can never auto-execute an action a company hasn\'t explicitly opted into.'));
    let current = [];
    try {
      current = await api.get('/api/ai/policies');
    } catch (err) {
      policiesSlot.appendChild(errorBanner(err.message));
      return;
    }
    const rows = AI_ACTION_TYPES.map((actionType) => {
      const existing = current.find((p) => p.actionType === actionType);
      const select = selectInput(AUTONOMY_LEVELS);
      select.value = existing?.autonomyLevel || 'require_approval';
      const saveBtn = el('button', { class: 'primary' }, 'Save');
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
          await api.post('/api/ai/policies', { actionType, autonomyLevel: select.value });
          toast(`Policy for "${actionType}" saved.`, 'success');
        } catch (err) {
          errorSlot.appendChild(errorBanner(err.message));
        } finally {
          saveBtn.disabled = false;
        }
      });
      return el('div', { class: 'form-row', style: 'align-items:flex-end' }, [
        el('div', {}, [el('label', {}, actionType), select]),
        saveBtn,
      ]);
    });
    rows.forEach((r) => policiesSlot.appendChild(r));
  }

  // ---- Agents ----
  const agentsSlot = el('div', { class: 'card' });
  container.appendChild(agentsSlot);

  async function loadAgents() {
    clear(agentsSlot);
    agentsSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Specialized Agents'));
    let agents = [];
    try {
      agents = await api.get('/api/ai/agents');
    } catch (err) {
      agentsSlot.appendChild(errorBanner(err.message));
      return;
    }

    const agentSelect = selectInput(agents.map((a) => ({ value: a.key, label: a.name })));
    const subjectInput = el('input', { type: 'text', placeholder: `${agents[0]?.subjectType || 'subject'} id` });
    const runBtn = el('button', { class: 'primary' }, 'Run decision');
    const toolsSlot = el('div', { class: 'muted' });

    async function renderTools() {
      const agent = agents.find((a) => a.key === agentSelect.value);
      subjectInput.placeholder = `${agent?.subjectType || 'subject'} id`;
      try {
        const tools = await api.get('/api/ai/tools', { agent: agentSelect.value });
        clear(toolsSlot);
        toolsSlot.appendChild(el('span', {}, `Goal: ${agent?.goal || ''} — Tools: ${tools.map((t) => t.name).join(', ')}`));
      } catch {
        clear(toolsSlot);
      }
    }
    agentSelect.addEventListener('change', renderTools);
    await renderTools();

    runBtn.addEventListener('click', async () => {
      if (!subjectInput.value.trim()) return;
      runBtn.disabled = true;
      try {
        const decision = await api.post(`/api/ai/agents/${agentSelect.value}/decide`, { subjectId: subjectInput.value.trim() });
        toast(`[${decision.status}, ${decision.confidence}% confidence] ${decision.reasoning}`, decision.status === 'escalated' ? 'info' : 'success');
        await loadDecisions();
      } catch (err) {
        errorSlot.appendChild(errorBanner(err.message));
      } finally {
        runBtn.disabled = false;
      }
    });

    agentsSlot.appendChild(el('div', { class: 'form-row', style: 'align-items:flex-end' }, [
      el('div', {}, [el('label', {}, 'Agent'), agentSelect]),
      el('div', {}, [el('label', {}, 'Subject id'), subjectInput]),
      runBtn,
    ]));
    agentsSlot.appendChild(toolsSlot);
  }

  // ---- Agent decision history ----
  const decisionsSlot = el('div');
  container.appendChild(decisionsSlot);

  async function loadDecisions() {
    clear(decisionsSlot);
    decisionsSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/ai/decisions', { limit: 50 });
      clear(decisionsSlot);
      decisionsSlot.appendChild(el('h3', {}, 'Agent decision history'));
      decisionsSlot.appendChild(table(
        [
          { label: 'Agent', key: 'agentKey' },
          { label: 'Subject', render: (d) => `${d.subjectType}:${d.subjectId}` },
          { label: 'Chosen action', render: (d) => d.chosenActionType || '—' },
          { label: 'Confidence', render: (d) => `${d.confidence}%` },
          { label: 'Reasoning', render: (d) => d.reasoning },
          { label: 'Status', render: (d) => statusBadge(d.status) },
          { label: 'When', render: (d) => new Date(d.createdAt).toLocaleString() },
        ],
        page.items.slice().reverse(),
        { empty: 'No agent decisions yet — run one above.' },
      ));
    } catch (err) {
      clear(decisionsSlot);
      decisionsSlot.appendChild(errorBanner(err.message));
    }
  }

  async function decide(request, action) {
    try {
      await api.post(`/api/ai/actions/${request.approvalRequestId}/${action}`, {});
      toast(`AI action ${action}d.`, 'success');
      await Promise.all([loadRequests(), loadPolicies()]);
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  // ---- Action request log ----
  const requestsSlot = el('div');
  container.appendChild(requestsSlot);

  async function loadRequests() {
    clear(requestsSlot);
    requestsSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/ai/actions', { limit: 50 });
      clear(requestsSlot);
      requestsSlot.appendChild(el('h3', {}, 'AI action requests'));
      requestsSlot.appendChild(table(
        [
          { label: 'Action', key: 'actionType' },
          { label: 'Requested by', key: 'requestedByUserId' },
          { label: 'Reasoning', render: (r) => r.reasoning || '' },
          { label: 'Status', render: (r) => statusBadge(r.status) },
          { label: 'When', render: (r) => new Date(r.createdAt).toLocaleString() },
          { label: '', render: (r) => {
            if (r.status !== 'pending_approval' || !r.approvalRequestId) return '';
            const approveBtn = el('button', { class: 'primary' }, 'Approve');
            approveBtn.addEventListener('click', () => decide(r, 'approve'));
            const rejectBtn = el('button', {}, 'Reject');
            rejectBtn.addEventListener('click', () => decide(r, 'reject'));
            return el('div', { class: 'form-actions' }, [approveBtn, rejectBtn]);
          } },
        ],
        page.items.slice().reverse(),
        { empty: 'No AI action requests yet — try "Ask AI" on a lead in the Leads page.' },
      ));
    } catch (err) {
      clear(requestsSlot);
      requestsSlot.appendChild(errorBanner(err.message));
    }
  }

  await Promise.all([loadPolicies(), loadAgents(), loadDecisions(), loadRequests()]);
}
