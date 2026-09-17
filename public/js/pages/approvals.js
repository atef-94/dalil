import { el, clear, table, toast, errorBanner, loadingState, badge, tabs } from '../ui.js';
import { api } from '../api.js';

// Workflow-step approvals and AI-action approvals are both ApprovalRequest
// rows from the exact same Automation Engine table (AiAgentService.requestAction
// creates one with stepId: 'ai-action') — GET /api/automation/approvals
// already returns both kinds together. This page is a single inbox over
// that one list; it only needs to know which of the two decide routes to
// call for a given row.
const AI_STEP_ID = 'ai-action';

export async function renderApprovals(container) {
  clear(container);
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, 'Approvals'),
      el('p', { class: 'page-subtitle' }, 'Every workflow step and AI action currently waiting on a human decision, in one inbox.'),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const tabsSlot = el('div');
  const listSlot = el('div');
  container.appendChild(tabsSlot);
  container.appendChild(listSlot);

  let statusTab = 'pending';

  async function decide(approval, action) {
    try {
      const base = approval.stepId === AI_STEP_ID ? '/api/ai/actions' : '/api/automation/approvals';
      await api.post(`${base}/${approval.id}/${action}`, {});
      toast(`Request ${action}d.`, 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    clear(tabsSlot);
    tabsSlot.appendChild(tabs(
      [{ key: 'pending', label: 'Pending' }, { key: 'approved', label: 'Approved' }, { key: 'rejected', label: 'Rejected' }],
      statusTab,
      (key) => { statusTab = key; load(); },
    ));
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/automation/approvals', { status: statusTab, limit: 100 });
      clear(listSlot);
      listSlot.appendChild(table(
        [
          { label: 'Type', render: (a) => a.stepId === AI_STEP_ID ? badge('AI action', 'blue') : badge('Workflow step', '') },
          { label: 'Reason', key: 'reason' },
          { label: 'Requested', render: (a) => new Date(a.createdAt).toLocaleString() },
          { label: '', render: (a) => {
            if (a.status !== 'pending') return a.decidedAt ? new Date(a.decidedAt).toLocaleString() : '';
            const approveBtn = el('button', { class: 'primary' }, 'Approve');
            approveBtn.addEventListener('click', () => decide(a, 'approve'));
            const rejectBtn = el('button', {}, 'Reject');
            rejectBtn.addEventListener('click', () => decide(a, 'reject'));
            return el('div', { class: 'form-actions' }, [approveBtn, rejectBtn]);
          } },
        ],
        page.items.slice().reverse(),
        { empty: `No ${statusTab} approvals.`, emptyIcon: 'approvals' },
      ));
    } catch (err) {
      clear(listSlot);
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
