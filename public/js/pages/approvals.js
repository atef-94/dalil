import { el, clear, table, toast, errorBanner, loadingState, badge, tabs, paginationControls } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

// Workflow-step approvals and AI-action approvals are both ApprovalRequest
// rows from the exact same Automation Engine table (AiAgentService.requestAction
// creates one with stepId: 'ai-action') — GET /api/automation/approvals
// already returns both kinds together. This page is a single inbox over
// that one list; it only needs to know which of the two decide routes to
// call for a given row.
const AI_STEP_ID = 'ai-action';

const ACTION_TYPE_LABEL_KEYS = {
  create_task: 'automation_action_create_task',
  create_lead: 'automation_action_create_lead',
  send_message: 'automation_action_send_message',
  update_lead_status: 'automation_action_update_lead_status',
  assign_lead_owner: 'automation_action_assign_lead_owner',
  update_campaign_status: 'automation_action_update_campaign_status',
  webhook_call: 'automation_action_webhook_call',
  integration_call: 'automation_action_integration_call',
  ai_decide: 'automation_action_ai_decide',
  require_approval: 'automation_action_require_approval',
};
function actionTypeLabel(locale, actionType) {
  const key = ACTION_TYPE_LABEL_KEYS[actionType];
  return key ? t(locale, key) : actionType.replace(/_/g, ' ');
}

const WORKFLOW_EMPTY_KEYS = {
  pending: 'approvals_empty_workflow_pending',
  approved: 'approvals_empty_workflow_approved',
  rejected: 'approvals_empty_workflow_rejected',
};
const ACTION_EMPTY_KEYS = {
  pending: 'approvals_empty_action_pending',
  approved: 'approvals_empty_action_approved',
  rejected: 'approvals_empty_action_rejected',
};

export async function renderApprovals(container) {
  clear(container);
  const locale = getLocale();
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, t(locale, 'page_title_approvals')),
      el('p', { class: 'page-subtitle' }, t(locale, 'approvals_page_subtitle')),
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

  const DECISION_TOAST_KEYS = { approve: 'approvals_request_approved_toast', reject: 'approvals_request_rejected_toast' };

  async function decide(approval, action) {
    try {
      const base = approval.stepId === AI_STEP_ID ? '/api/ai/actions' : '/api/automation/approvals';
      await api.post(`${base}/${approval.id}/${action}`, {});
      toast(t(locale, DECISION_TOAST_KEYS[action]), 'success');
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
      toast(t(locale, DECISION_TOAST_KEYS[action]), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    clear(tabsSlot);
    tabsSlot.appendChild(tabs(
      [{ key: 'pending', label: t(locale, 'analytics_pending') }, { key: 'approved', label: t(locale, 'analytics_approved') }, { key: 'rejected', label: t(locale, 'approvals_rejected_tab') }],
      statusTab,
      (key) => { statusTab = key; offset = 0; actionOffset = 0; load(); },
    ));
    clear(listSlot);
    listSlot.appendChild(el('h3', { style: 'margin-top:0' }, t(locale, 'approvals_workflow_ai_title')));
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/automation/approvals', { status: statusTab, limit: 20, offset });
      clear(listSlot);
      listSlot.appendChild(el('h3', { style: 'margin-top:0' }, t(locale, 'approvals_workflow_ai_title')));
      listSlot.appendChild(table(
        [
          { label: t(locale, 'units_col_type'), render: (a) => a.stepId === AI_STEP_ID ? badge(t(locale, 'approvals_ai_action_badge'), 'blue') : badge(t(locale, 'approvals_workflow_step_badge'), '') },
          { label: t(locale, 'fin_reason_field'), key: 'reason' },
          { label: t(locale, 'approvals_requested_col'), render: (a) => new Date(a.createdAt).toLocaleString() },
          { label: '', render: (a) => {
            if (a.status !== 'pending') return a.decidedAt ? new Date(a.decidedAt).toLocaleString() : '';
            const approveBtn = el('button', { class: 'primary' }, t(locale, 'brokers_approve_btn'));
            approveBtn.addEventListener('click', () => decide(a, 'approve'));
            const rejectBtn = el('button', {}, t(locale, 'approvals_reject_btn'));
            rejectBtn.addEventListener('click', () => decide(a, 'reject'));
            return el('div', { class: 'form-actions' }, [approveBtn, rejectBtn]);
          } },
        ],
        page.items.slice().reverse(),
        { empty: t(locale, WORKFLOW_EMPTY_KEYS[statusTab] || WORKFLOW_EMPTY_KEYS.pending), emptyIcon: 'approvals' },
      ));
      listSlot.appendChild(paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      clear(listSlot);
      listSlot.appendChild(errorBanner(err.message));
    }

    clear(actionListSlot);
    actionListSlot.appendChild(el('h3', { style: 'margin-top:0' }, t(locale, 'approvals_business_title')));
    actionListSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/approvals', { status: statusTab, limit: 20, offset: actionOffset });
      clear(actionListSlot);
      actionListSlot.appendChild(el('h3', { style: 'margin-top:0' }, t(locale, 'approvals_business_title')));
      actionListSlot.appendChild(table(
        [
          { label: t(locale, 'units_col_type'), render: (a) => badge(actionTypeLabel(locale, a.actionType), 'amber') },
          { label: t(locale, 'fin_reason_field'), key: 'reason' },
          { label: t(locale, 'approvals_requested_col'), render: (a) => new Date(a.createdAt).toLocaleString() },
          { label: '', render: (a) => {
            if (a.status !== 'pending') {
              if (a.resumeFailedReason) return el('span', { style: 'color:var(--danger,#c0392b)' }, `${t(locale, 'approvals_failed_prefix')}${a.resumeFailedReason}`);
              return a.decidedAt ? new Date(a.decidedAt).toLocaleString() : '';
            }
            const approveBtn = el('button', { class: 'primary' }, t(locale, 'brokers_approve_btn'));
            approveBtn.addEventListener('click', () => decideAction(a, 'approve'));
            const rejectBtn = el('button', {}, t(locale, 'approvals_reject_btn'));
            rejectBtn.addEventListener('click', () => decideAction(a, 'reject'));
            return el('div', { class: 'form-actions' }, [approveBtn, rejectBtn]);
          } },
        ],
        page.items.slice().reverse(),
        { empty: t(locale, ACTION_EMPTY_KEYS[statusTab] || ACTION_EMPTY_KEYS.pending), emptyIcon: 'approvals' },
      ));
      actionListSlot.appendChild(paginationControls(page, (next) => { actionOffset = next; load(); }));
    } catch (err) {
      clear(actionListSlot);
      actionListSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
