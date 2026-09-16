import { el, clear, table, toast, errorBanner, statusBadge, loadingState, selectInput } from '../ui.js';
import { api } from '../api.js';

// require_approval is a workflow-only meta-action (it pauses a run for a
// human decision) — it isn't something the AI itself "performs", so it's
// left out of the policy list here.
const AI_ACTION_TYPES = ['create_task', 'create_lead', 'send_message', 'update_lead_status', 'assign_lead_owner', 'update_campaign_status', 'webhook_call'];
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

  await Promise.all([loadPolicies(), loadRequests()]);
}
