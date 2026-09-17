import { el, clear, table, toast, errorBanner, loadingState, badge, tabs, paginationControls } from '../ui.js';
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
      el('p', { class: 'page-subtitle' }, 'Every workflow step, AI action, and gated business action currently waiting on a human decision, in one inbox.'),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const tabsSlot = el('div');
  const listSlot = el('div');
  const actionListSlot = el('div', { style: 'margin-top:20px' });
  container.appendChild(tabsSlot);
  container.appendChild(listSlot);
  container.appendChild(actionListSlot);

  let statusTab = 'pending';
  let offset = 0;
  let actionOffset = 0;

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

  // The Universal Approval Engine's ActionApproval rows are a separate
  // resource (GET /api/approvals) from the Automation Engine's own
  // workflow-bound ApprovalRequest above — this is the one real gate
  // wired to it so far (a contract discount above the configured
  // threshold). Shown as its own table on the same page/status tab
  // rather than a separate page, so nothing waiting on an approver is
  // split across two places.
  async function decideAction(approval, action) {
    try {
      await api.post(`/api/approvals/${approval.id}/${action}`, action === 'reject' ? {} : undefined);
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
      (key) => { statusTab = key; offset = 0; actionOffset = 0; load(); },
    ));
    clear(listSlot);
    listSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Workflow & AI approvals'));
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/automation/approvals', { status: statusTab, limit: 20, offset });
      clear(listSlot);
      listSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Workflow & AI approvals'));
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
        { empty: `No ${statusTab} workflow/AI approvals.`, emptyIcon: 'approvals' },
      ));
      listSlot.appendChild(paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      clear(listSlot);
      listSlot.appendChild(errorBanner(err.message));
    }

    clear(actionListSlot);
    actionListSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Business action approvals'));
    actionListSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/approvals', { status: statusTab, limit: 20, offset: actionOffset });
      clear(actionListSlot);
      actionListSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Business action approvals'));
      actionListSlot.appendChild(table(
        [
          { label: 'Type', render: (a) => badge(a.actionType.replace(/_/g, ' '), 'amber') },
          { label: 'Reason', key: 'reason' },
          { label: 'Requested', render: (a) => new Date(a.createdAt).toLocaleString() },
          { label: '', render: (a) => {
            if (a.status !== 'pending') {
              if (a.resumeFailedReason) return el('span', { style: 'color:var(--danger,#c0392b)' }, `Failed: ${a.resumeFailedReason}`);
              return a.decidedAt ? new Date(a.decidedAt).toLocaleString() : '';
            }
            const approveBtn = el('button', { class: 'primary' }, 'Approve');
            approveBtn.addEventListener('click', () => decideAction(a, 'approve'));
            const rejectBtn = el('button', {}, 'Reject');
            rejectBtn.addEventListener('click', () => decideAction(a, 'reject'));
            return el('div', { class: 'form-actions' }, [approveBtn, rejectBtn]);
          } },
        ],
        page.items.slice().reverse(),
        { empty: `No ${statusTab} business action approvals.`, emptyIcon: 'approvals' },
      ));
      actionListSlot.appendChild(paginationControls(page, (next) => { actionOffset = next; load(); }));
    } catch (err) {
      clear(actionListSlot);
      actionListSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
