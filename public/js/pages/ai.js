import { el, clear, toast, errorBanner, selectInput, icon } from '../ui.js';
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
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, 'AI Agents'),
      el('p', { class: 'page-subtitle' }, 'Every action here — whether suggested, auto-executed, or paused for approval — passes through the same permission, policy, approval, and audit systems as the Automation Engine. AI never bypasses them.'),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  // ---- Agents roster ----
  const agentsSlot = el('div');
  container.appendChild(agentsSlot);

  async function loadAgents() {
    clear(agentsSlot);
    let agents = [];
    try {
      agents = await api.get('/api/ai/agents');
    } catch (err) {
      agentsSlot.appendChild(errorBanner(err.message));
      return;
    }

    const cards = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-bottom:16px' });
    for (const agent of agents) {
      let tools = [];
      try { tools = await api.get('/api/ai/tools', { agent: agent.key }); } catch { /* non-fatal */ }
      cards.appendChild(el('div', { class: 'card' }, [
        el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:6px' }, [icon('ai'), el('strong', {}, agent.name)]),
        el('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:8px' }, agent.businessFunction),
        el('p', { style: 'font-size:13px' }, agent.goal),
        el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `Tools: ${tools.map((t) => t.name).join(', ') || '—'}`),
        el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `Escalates below ${agent.escalateBelowConfidence}% confidence`),
      ]));
    }
    agentsSlot.appendChild(cards);

    // ---- Run a decision on demand ----
    const agentSelect = selectInput(agents.map((a) => ({ value: a.key, label: a.name })));
    const subjectInput = el('input', { type: 'text', placeholder: `${agents[0]?.subjectType || 'subject'} id` });
    const runBtn = el('button', { class: 'primary' }, 'Run decision');

    agentSelect.addEventListener('change', () => {
      const agent = agents.find((a) => a.key === agentSelect.value);
      subjectInput.placeholder = `${agent?.subjectType || 'subject'} id`;
    });

    runBtn.addEventListener('click', async () => {
      if (!subjectInput.value.trim()) return;
      runBtn.disabled = true;
      try {
        const decision = await api.post(`/api/ai/agents/${agentSelect.value}/decide`, { subjectId: subjectInput.value.trim() });
        toast(`[${decision.status}, ${decision.confidence}% confidence] ${decision.reasoning}`, decision.status === 'escalated' ? 'info' : 'success');
      } catch (err) {
        errorSlot.appendChild(errorBanner(err.message));
      } finally {
        runBtn.disabled = false;
      }
    });

    agentsSlot.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, 'Run a decision on demand'),
      el('div', { class: 'form-row', style: 'align-items:flex-end' }, [
        el('div', {}, [el('label', {}, 'Agent'), agentSelect]),
        el('div', {}, [el('label', {}, 'Subject id'), subjectInput]),
        runBtn,
      ]),
      el('p', { class: 'page-subtitle', style: 'margin-top:8px' }, ['See the outcome in ', el('a', { href: '#/ai-activity' }, 'AI Activity'), '.']),
    ]));
  }

  // ---- Policies ----
  const policiesSlot = el('div', { class: 'card' });
  container.appendChild(policiesSlot);

  async function loadPolicies() {
    clear(policiesSlot);
    policiesSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Autonomy policy per action type'));
    policiesSlot.appendChild(el('p', { class: 'page-subtitle' }, 'An action type with no policy set defaults to "require approval" — the AI can never auto-execute an action a company hasn\'t explicitly opted into.'));
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

  await Promise.all([loadAgents(), loadPolicies()]);
}
