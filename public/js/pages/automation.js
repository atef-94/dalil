import { el, clear, table, toast, errorBanner, statusBadge, loadingState, selectInput, confirmModal, paginationControls } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

function triggerTypeOptions(locale) {
  return [
    { value: 'event', label: t(locale, 'automation_trigger_type_event') },
    { value: 'scheduled', label: t(locale, 'automation_trigger_type_scheduled') },
    { value: 'webhook', label: t(locale, 'automation_trigger_type_webhook') },
  ];
}
const EVENT_TYPES = [
  'lead.created', 'lead.status_changed', 'lead.stage_changed', 'opportunity.created', 'contract.signed', 'contract.cancelled',
  'payment.recorded', 'payment.overdue_swept', 'maintenance_ticket.created', 'maintenance_ticket.status_changed',
  'leave_request.created', 'leave_request.decided', 'purchase_order.created', 'purchase_order.status_changed',
  'legal_document.status_changed', 'campaign.status_changed', 'broker_lead.submitted', 'employee.created',
];
function actionTypeOptions(locale) {
  return [
    { value: 'create_task', label: t(locale, 'automation_action_create_task') },
    { value: 'create_lead', label: t(locale, 'automation_action_create_lead') },
    { value: 'send_message', label: t(locale, 'automation_action_send_message') },
    { value: 'update_lead_status', label: t(locale, 'automation_action_update_lead_status') },
    { value: 'assign_lead_owner', label: t(locale, 'automation_action_assign_lead_owner') },
    { value: 'update_campaign_status', label: t(locale, 'automation_action_update_campaign_status') },
    { value: 'webhook_call', label: t(locale, 'automation_action_webhook_call') },
    { value: 'integration_call', label: t(locale, 'automation_action_integration_call') },
    { value: 'ai_decide', label: t(locale, 'automation_action_ai_decide') },
    { value: 'require_approval', label: t(locale, 'automation_action_require_approval') },
  ];
}
const CONDITION_OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'];

// Which params each action type asks for, keyed to the fields the backend
// executor actually reads (see automation.service.ts executeAction). Every
// value input also accepts {{dot.path}} templating against the trigger
// payload, same as the backend.
function actionParamFields(locale) {
  return {
    create_task: [
      { key: 'title', label: t(locale, 'automation_field_title'), placeholder: t(locale, 'automation_placeholder_task_title') },
      { key: 'description', label: t(locale, 'automation_field_description_optional') },
      { key: 'assignedToUserId', label: t(locale, 'automation_field_assigned_to_user_id') },
    ],
    create_lead: [
      { key: 'fullName', label: t(locale, 'automation_field_full_name') },
      { key: 'phone', label: t(locale, 'automation_field_phone') },
      { key: 'email', label: t(locale, 'automation_field_email_optional') },
      { key: 'sourceId', label: t(locale, 'automation_field_source_id_optional') },
    ],
    send_message: [
      { key: 'subject', label: t(locale, 'automation_field_subject') },
      { key: 'body', label: t(locale, 'automation_field_body') },
      { key: 'toUserId', label: t(locale, 'automation_field_to_user_id_optional') },
    ],
    update_lead_status: [
      { key: 'leadId', label: t(locale, 'automation_field_lead_id'), placeholder: t(locale, 'automation_placeholder_lead_id') },
      { key: 'stageId', label: t(locale, 'automation_field_target_stage_id'), placeholder: t(locale, 'automation_placeholder_stage_id') },
      { key: 'lostReason', label: t(locale, 'automation_field_lost_reason') },
    ],
    assign_lead_owner: [
      { key: 'leadId', label: t(locale, 'automation_field_lead_id') },
      { key: 'ownerEmployeeUserId', label: t(locale, 'automation_field_new_owner_user_id') },
    ],
    update_campaign_status: [
      { key: 'campaignId', label: t(locale, 'automation_field_campaign_id') },
      { key: 'status', label: t(locale, 'automation_field_new_status'), placeholder: 'planned / active / completed / cancelled' },
    ],
    webhook_call: [
      { key: 'url', label: t(locale, 'automation_field_url') },
      { key: 'method', label: t(locale, 'automation_field_method_optional'), placeholder: 'POST' },
      { key: 'secretKey', label: t(locale, 'automation_field_secret_key_optional'), placeholder: t(locale, 'automation_placeholder_secret_hint') },
    ],
    integration_call: [
      { key: 'provider', label: t(locale, 'automation_field_provider'), placeholder: 'whatsapp / email / meta_ads / google_calendar / payment_stripe / custom_api' },
      { key: 'action', label: t(locale, 'automation_field_action'), placeholder: t(locale, 'automation_placeholder_integration_action') },
      { key: 'to', label: t(locale, 'automation_field_to_optional'), placeholder: t(locale, 'automation_placeholder_to_hint') },
      { key: 'body', label: t(locale, 'automation_field_message_body_optional') },
    ],
    ai_decide: [
      { key: 'agentKey', label: t(locale, 'automation_field_agent'), placeholder: 'sales / marketing / finance / support / hr — see the AI page' },
      { key: 'subjectId', label: t(locale, 'automation_field_subject_id'), placeholder: t(locale, 'automation_placeholder_subject_id') },
    ],
    require_approval: [
      { key: 'reason', label: t(locale, 'automation_field_approval_reason') },
    ],
  };
}

function triggerFields(triggerType, values = {}, locale) {
  const wrap = el('div', { class: 'form-row' });
  if (triggerType === 'event') {
    const eventSelect = selectInput(EVENT_TYPES.map((e) => ({ value: e, label: e })));
    if (values.eventType) eventSelect.value = values.eventType;
    wrap.appendChild(el('div', {}, [el('label', {}, t(locale, 'automation_trigger_type_event')), eventSelect]));
    wrap.dataset.get = () => ({ type: 'event', eventType: eventSelect.value });
    wrap._get = () => ({ type: 'event', eventType: eventSelect.value });
  } else if (triggerType === 'scheduled') {
    const intervalInput = el('input', { type: 'number', min: '1', value: values.intervalMinutes || 60 });
    wrap.appendChild(el('div', {}, [el('label', {}, t(locale, 'automation_label_interval_minutes')), intervalInput]));
    wrap._get = () => ({ type: 'scheduled', intervalMinutes: Number(intervalInput.value) });
  } else {
    const slugInput = el('input', { type: 'text', placeholder: t(locale, 'automation_placeholder_webhook_slug'), value: values.webhookSlug || '' });
    wrap.appendChild(el('div', {}, [el('label', {}, t(locale, 'automation_label_webhook_slug')), slugInput]));
    wrap._get = () => ({ type: 'webhook', webhookSlug: slugInput.value.trim() });
  }
  return wrap;
}

function stepEditor(step = {}, locale) {
  const nameInput = el('input', { type: 'text', placeholder: t(locale, 'automation_field_step_name'), value: step.name || '' });
  const actionSelect = selectInput(actionTypeOptions(locale), {});
  if (step.action?.type) actionSelect.value = step.action.type;
  const onFailureSelect = selectInput([{ value: 'stop', label: t(locale, 'automation_option_stop_on_failure') }, { value: 'continue', label: t(locale, 'automation_option_continue_on_failure') }]);
  if (step.onFailure) onFailureSelect.value = step.onFailure;
  const retriesInput = el('input', { type: 'number', min: '0', value: step.maxRetries ?? 0 });

  const paramsSlot = el('div', { class: 'form-row' });
  const conditionsSlot = el('div', {});
  const conditionRows = [];

  function renderParams() {
    clear(paramsSlot);
    const fields = actionParamFields(locale)[actionSelect.value] || [];
    const inputs = {};
    for (const f of fields) {
      const input = el('input', { type: 'text', placeholder: f.placeholder || '', value: step.action?.params?.[f.key] || '' });
      inputs[f.key] = input;
      paramsSlot.appendChild(el('div', {}, [el('label', {}, f.label), input]));
    }
    paramsSlot._get = () => {
      const params = {};
      for (const [key, input] of Object.entries(inputs)) {
        if (input.value.trim()) params[key] = input.value.trim();
      }
      return params;
    };
  }
  actionSelect.addEventListener('change', renderParams);
  renderParams();

  function addConditionRow(initial = {}) {
    const fieldInput = el('input', { type: 'text', placeholder: t(locale, 'automation_placeholder_condition_field'), value: initial.field || '' });
    const opSelect = selectInput(CONDITION_OPERATORS.map((o) => ({ value: o, label: o })));
    if (initial.operator) opSelect.value = initial.operator;
    const valueInput = el('input', { type: 'text', placeholder: t(locale, 'automation_placeholder_condition_value'), value: initial.value ?? '' });
    const removeBtn = el('button', {}, '×');
    const row = el('div', { class: 'form-row', style: 'align-items:flex-end' }, [
      el('div', {}, [el('label', {}, t(locale, 'automation_label_if_field')), fieldInput]),
      el('div', {}, [el('label', {}, t(locale, 'automation_label_operator')), opSelect]),
      el('div', {}, [el('label', {}, t(locale, 'automation_label_value')), valueInput]),
      removeBtn,
    ]);
    removeBtn.addEventListener('click', () => {
      row.remove();
      const idx = conditionRows.indexOf(entry);
      if (idx >= 0) conditionRows.splice(idx, 1);
    });
    const entry = { row, get: () => ({ field: fieldInput.value.trim(), operator: opSelect.value, value: valueInput.value.trim() || undefined }) };
    conditionRows.push(entry);
    conditionsSlot.appendChild(row);
  }
  (step.conditions || []).forEach((c) => addConditionRow(c));
  const addConditionBtn = el('button', {}, t(locale, 'automation_add_condition_btn'));
  addConditionBtn.addEventListener('click', () => addConditionRow());

  const removeStepBtn = el('button', {}, t(locale, 'automation_remove_step_btn'));
  const card = el('div', { class: 'card', style: 'margin-bottom:10px' }, [
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'automation_field_step_name')), nameInput]),
      el('div', {}, [el('label', {}, t(locale, 'automation_field_action')), actionSelect]),
      el('div', {}, [el('label', {}, t(locale, 'automation_label_on_failure')), onFailureSelect]),
      el('div', {}, [el('label', {}, t(locale, 'automation_label_max_retries')), retriesInput]),
    ]),
    el('div', {}, [el('label', {}, t(locale, 'automation_label_conditions')), conditionsSlot, addConditionBtn]),
    el('div', {}, [el('label', {}, t(locale, 'automation_label_action_parameters')), paramsSlot]),
    el('div', { class: 'form-actions' }, [removeStepBtn]),
  ]);
  removeStepBtn.addEventListener('click', () => card.remove());

  card._get = () => ({
    name: nameInput.value.trim(),
    action: { type: actionSelect.value, params: paramsSlot._get() },
    conditions: conditionRows.map((c) => c.get()).filter((c) => c.field),
    onFailure: onFailureSelect.value,
    maxRetries: Number(retriesInput.value) || 0,
  });
  return card;
}

export async function renderAutomation(container) {
  clear(container);
  const locale = getLocale();
  let workflowsOffset = 0;
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, t(locale, 'page_title_automation')),
      el('p', { class: 'page-subtitle' }, [t(locale, 'automation_subtitle_pre'), el('a', { href: '#/approvals' }, t(locale, 'nav_approvals')), t(locale, 'automation_subtitle_mid'), el('a', { href: '#/workflow-history' }, t(locale, 'nav_workflow_history')), t(locale, 'automation_subtitle_post')]),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  // ---- Execution monitoring summary ----
  const statsSlot = el('div', { class: 'card' });
  container.appendChild(statsSlot);
  async function loadStats() {
    clear(statsSlot);
    try {
      const stats = await api.get('/api/automation/stats');
      const tile = (label, value) => el('div', { style: 'text-align:center' }, [
        el('div', { style: 'font-size:22px;font-weight:600' }, String(value)),
        el('div', { class: 'muted' }, label),
      ]);
      statsSlot.appendChild(el('div', { style: 'display:flex;gap:24px;flex-wrap:wrap' }, [
        tile(t(locale, 'automation_stat_active_workflows'), stats.activeWorkflows),
        tile(t(locale, 'automation_stat_total_runs'), stats.totalRuns),
        tile(t(locale, 'automation_stat_running'), stats.runningRuns),
        tile(t(locale, 'automation_stat_waiting_approval'), stats.waitingApprovalRuns),
        tile(t(locale, 'automation_stat_completed'), stats.completedRuns),
        tile(t(locale, 'automation_stat_failed'), stats.failedRuns),
        tile(t(locale, 'automation_stat_pending_approvals'), stats.pendingApprovals),
      ]));
    } catch (err) {
      statsSlot.appendChild(errorBanner(err.message));
    }
  }

  // ---- New workflow builder ----
  const nameInput = el('input', { type: 'text', placeholder: t(locale, 'automation_placeholder_workflow_name') });
  const descInput = el('input', { type: 'text', placeholder: t(locale, 'automation_field_description_optional') });
  const triggerTypeSelect = selectInput(triggerTypeOptions(locale));
  const triggerFieldsSlot = el('div');
  function renderTriggerFields() {
    clear(triggerFieldsSlot);
    const fields = triggerFields(triggerTypeSelect.value, {}, locale);
    triggerFieldsSlot.appendChild(fields);
    triggerFieldsSlot._get = fields._get;
  }
  triggerTypeSelect.addEventListener('change', renderTriggerFields);
  renderTriggerFields();

  const stepsSlot = el('div');
  const stepCards = [];
  function addStep(step) {
    const card = stepEditor(step, locale);
    stepCards.push(card);
    stepsSlot.appendChild(card);
  }
  addStep();
  const addStepBtn = el('button', {}, t(locale, 'automation_btn_add_step'));
  addStepBtn.addEventListener('click', () => addStep());

  const createBtn = el('button', { class: 'primary' }, t(locale, 'automation_btn_create_workflow'));
  createBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!nameInput.value.trim()) {
      errorSlot.appendChild(errorBanner(t(locale, 'automation_err_name_required')));
      return;
    }
    const steps = stepCards.filter((c) => c.isConnected).map((c) => c._get());
    if (steps.length === 0) {
      errorSlot.appendChild(errorBanner(t(locale, 'automation_err_step_required')));
      return;
    }
    createBtn.disabled = true;
    try {
      await api.post('/api/automation/workflows', {
        name: nameInput.value.trim(),
        description: descInput.value.trim() || undefined,
        trigger: triggerFieldsSlot._get(),
        steps,
      });
      toast(t(locale, 'automation_toast_workflow_created'), 'success');
      nameInput.value = ''; descInput.value = '';
      stepCards.length = 0;
      clear(stepsSlot);
      addStep();
      await Promise.all([loadWorkflows(), loadStats()]);
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'automation_heading_build_workflow')),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'automation_label_name')), nameInput]),
      el('div', {}, [el('label', {}, t(locale, 'automation_label_description')), descInput]),
      el('div', {}, [el('label', {}, t(locale, 'automation_label_trigger_type')), triggerTypeSelect]),
    ]),
    triggerFieldsSlot,
    el('h4', {}, t(locale, 'automation_heading_steps')),
    stepsSlot,
    addStepBtn,
    el('div', { class: 'form-actions' }, [createBtn]),
  ]));

  // ---- Templates ----
  const templatesSlot = el('div', { class: 'card' }, [el('h3', { style: 'margin-top:0' }, t(locale, 'automation_heading_templates')), loadingState()]);
  container.appendChild(templatesSlot);
  try {
    const templates = await api.get('/api/automation/templates');
    clear(templatesSlot);
    templatesSlot.appendChild(el('h3', { style: 'margin-top:0' }, t(locale, 'automation_heading_templates')));
    templates.forEach((tpl) => {
      const useBtn = el('button', {}, t(locale, 'automation_btn_use_template'));
      useBtn.addEventListener('click', () => {
        nameInput.value = tpl.name;
        descInput.value = tpl.description;
        triggerTypeSelect.value = tpl.trigger.type;
        renderTriggerFields();
        stepCards.length = 0;
        clear(stepsSlot);
        tpl.steps.forEach((s) => addStep(s));
        window.scrollTo({ top: 0, behavior: 'smooth' });
        toast(`${t(locale, 'automation_toast_template_loaded_prefix')} "${tpl.name}" ${t(locale, 'automation_toast_template_loaded_suffix')}`, 'info');
      });
      templatesSlot.appendChild(el('div', { class: 'form-row', style: 'align-items:center' }, [
        el('div', {}, [el('strong', {}, tpl.name), el('div', { class: 'muted' }, tpl.description)]),
        useBtn,
      ]));
    });
  } catch (err) {
    clear(templatesSlot);
    templatesSlot.appendChild(errorBanner(err.message));
  }

  // ---- Workflow list ----
  const workflowsSlot = el('div');
  container.appendChild(workflowsSlot);

  async function setStatus(workflow, status) {
    try {
      await api.post(`/api/automation/workflows/${workflow.id}/status`, { status });
      toast(`${t(locale, 'automation_toast_workflow_status_prefix')} ${status}.`, 'success');
      await Promise.all([loadWorkflows(), loadStats()]);
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function showRuns(workflow) {
    const runsPage = await api.get(`/api/automation/workflows/${workflow.id}/runs`, { limit: 20 });
    const modalBody = el('div', { class: 'modal-overlay' });
    const retry = async (run, btn) => {
      btn.disabled = true;
      try {
        await api.post(`/api/automation/runs/${run.id}/retry`, {});
        toast(t(locale, 'automation_toast_run_retried'), 'success');
        modalBody.remove();
        await showRuns(workflow);
      } catch (err) {
        btn.disabled = false;
        errorSlot.appendChild(errorBanner(err.message));
      }
    };
    const card = el('div', { class: 'modal-card' }, [
      el('h3', { class: 'modal-title' }, `${t(locale, 'automation_run_history_title')} — ${workflow.name}`),
      table(
        [
          { label: t(locale, 'automation_col_started'), render: (r) => new Date(r.startedAt).toLocaleString() },
          { label: t(locale, 'automation_label_status'), render: (r) => statusBadge(r.status) },
          { label: t(locale, 'automation_col_initiated_by'), key: 'initiatedBy' },
          { label: t(locale, 'automation_col_error'), render: (r) => r.error || '' },
          { label: '', render: (r) => {
            if (r.status !== 'failed') return '';
            const retryBtn = el('button', {}, t(locale, 'automation_btn_retry'));
            retryBtn.addEventListener('click', () => retry(r, retryBtn));
            return retryBtn;
          } },
        ],
        runsPage.items.slice().reverse(),
        { empty: t(locale, 'automation_empty_runs') },
      ),
      el('div', { class: 'form-actions', style: 'justify-content:flex-end' }, [
        (() => { const b = el('button', { class: 'primary' }, t(locale, 'common_close')); b.addEventListener('click', () => modalBody.remove()); return b; })(),
      ]),
    ]);
    modalBody.appendChild(card);
    modalBody.addEventListener('click', (e) => { if (e.target === modalBody) modalBody.remove(); });
    document.body.appendChild(modalBody);
  }

  async function loadWorkflows() {
    clear(workflowsSlot);
    workflowsSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/automation/workflows', { limit: 20, offset: workflowsOffset });
      clear(workflowsSlot);
      workflowsSlot.appendChild(el('h3', {}, t(locale, 'automation_heading_workflows')));
      workflowsSlot.appendChild(table(
        [
          { label: t(locale, 'automation_label_name'), key: 'name' },
          { label: t(locale, 'automation_col_trigger'), render: (w) => w.trigger.type === 'event' ? `${t(locale, 'automation_trigger_prefix_event')} ${w.trigger.eventType}` : w.trigger.type === 'scheduled' ? `${t(locale, 'automation_trigger_prefix_every')} ${w.trigger.intervalMinutes}${t(locale, 'automation_trigger_suffix_minutes')}` : `${t(locale, 'automation_trigger_prefix_webhook')} ${w.trigger.webhookSlug}` },
          { label: t(locale, 'automation_heading_steps'), render: (w) => String(w.steps.length) },
          { label: t(locale, 'automation_label_status'), render: (w) => statusBadge(w.status) },
          { label: '', render: (w) => {
            const actions = el('div', { style: 'display:flex;gap:6px' });
            const runsBtn = el('button', {}, t(locale, 'automation_btn_runs'));
            runsBtn.addEventListener('click', () => showRuns(w));
            actions.appendChild(runsBtn);
            if (w.status === 'active') {
              const pauseBtn = el('button', {}, t(locale, 'automation_btn_pause'));
              pauseBtn.addEventListener('click', () => setStatus(w, 'paused'));
              actions.appendChild(pauseBtn);
            } else if (w.status === 'paused') {
              const resumeBtn = el('button', {}, t(locale, 'automation_btn_resume'));
              resumeBtn.addEventListener('click', () => setStatus(w, 'active'));
              actions.appendChild(resumeBtn);
            }
            if (w.status !== 'archived') {
              const archiveBtn = el('button', {}, t(locale, 'automation_btn_archive'));
              archiveBtn.addEventListener('click', async () => {
                if (await confirmModal(`${t(locale, 'automation_confirm_archive_prefix')} "${w.name}"? ${t(locale, 'automation_confirm_archive_suffix')}`, { danger: true })) setStatus(w, 'archived');
              });
              actions.appendChild(archiveBtn);
            }
            return actions;
          } },
        ],
        page.items,
        { empty: t(locale, 'automation_empty_workflows') },
      ));
      workflowsSlot.appendChild(paginationControls(page, (next) => { workflowsOffset = next; loadWorkflows(); }));
    } catch (err) {
      clear(workflowsSlot);
      workflowsSlot.appendChild(errorBanner(err.message));
    }
  }

  // ---- Secrets ----
  const secretsSlot = el('div', { class: 'card' });
  container.appendChild(secretsSlot);

  async function loadSecrets() {
    clear(secretsSlot);
    secretsSlot.appendChild(el('h3', { style: 'margin-top:0' }, t(locale, 'automation_heading_secrets')));
    const keyInput = el('input', { type: 'text', placeholder: t(locale, 'automation_placeholder_secret_key_example') });
    const valueInput = el('input', { type: 'password', placeholder: t(locale, 'automation_label_value') });
    const saveBtn = el('button', { class: 'primary' }, t(locale, 'automation_btn_save_secret'));
    saveBtn.addEventListener('click', async () => {
      if (!keyInput.value.trim() || !valueInput.value.trim()) return;
      try {
        await api.post('/api/automation/secrets', { key: keyInput.value.trim(), value: valueInput.value });
        keyInput.value = ''; valueInput.value = '';
        toast(t(locale, 'automation_toast_secret_saved'), 'success');
        await loadSecrets();
      } catch (err) {
        errorSlot.appendChild(errorBanner(err.message));
      }
    });
    secretsSlot.appendChild(el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'automation_label_key')), keyInput]),
      el('div', {}, [el('label', {}, t(locale, 'automation_label_value')), valueInput]),
      el('div', { class: 'form-actions' }, [saveBtn]),
    ]));
    try {
      const list = await api.get('/api/automation/secrets');
      secretsSlot.appendChild(table(
        [
          { label: t(locale, 'automation_label_key'), key: 'key' },
          { label: t(locale, 'automation_col_created'), render: (s) => new Date(s.createdAt).toLocaleString() },
          { label: '', render: (s) => {
            const delBtn = el('button', { class: 'danger' }, t(locale, 'automation_btn_delete'));
            delBtn.addEventListener('click', async () => {
              if (!(await confirmModal(`${t(locale, 'automation_confirm_delete_secret_prefix')} "${s.key}"? ${t(locale, 'automation_confirm_delete_secret_suffix')}`, { danger: true }))) return;
              try {
                await api.delete(`/api/automation/secrets/${s.id}`);
                toast(t(locale, 'automation_toast_secret_deleted'), 'success');
                await loadSecrets();
              } catch (err) {
                errorSlot.appendChild(errorBanner(err.message));
              }
            });
            return delBtn;
          } },
        ],
        list,
        { empty: t(locale, 'automation_empty_secrets') },
      ));
    } catch (err) {
      secretsSlot.appendChild(errorBanner(err.message));
    }
  }

  await Promise.all([loadStats(), loadWorkflows(), loadSecrets()]);
}
