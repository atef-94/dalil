import { el, clear, table, toast, errorBanner, statusBadge, loadingState, selectInput, confirmModal } from '../ui.js';
import { api } from '../api.js';

const TRIGGER_TYPES = [{ value: 'event', label: 'Event' }, { value: 'scheduled', label: 'Scheduled' }, { value: 'webhook', label: 'Webhook' }];
const EVENT_TYPES = [
  'lead.created', 'lead.status_changed', 'opportunity.created', 'contract.signed', 'contract.cancelled',
  'payment.recorded', 'payment.overdue_swept', 'maintenance_ticket.created', 'maintenance_ticket.status_changed',
  'leave_request.created', 'leave_request.decided', 'purchase_order.created', 'purchase_order.status_changed',
  'legal_document.status_changed', 'campaign.status_changed', 'broker_lead.submitted', 'employee.created',
];
const ACTION_TYPES = [
  { value: 'create_task', label: 'Create task' },
  { value: 'create_lead', label: 'Create lead' },
  { value: 'send_message', label: 'Send message' },
  { value: 'update_lead_status', label: 'Update lead status' },
  { value: 'assign_lead_owner', label: 'Assign lead owner' },
  { value: 'update_campaign_status', label: 'Update campaign status' },
  { value: 'webhook_call', label: 'Call webhook' },
  { value: 'integration_call', label: 'Send via integration (WhatsApp/Email/etc)' },
  { value: 'ai_decide', label: 'Hand off to AI agent' },
  { value: 'require_approval', label: 'Require approval' },
];
const CONDITION_OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'];

// Which params each action type asks for, keyed to the fields the backend
// executor actually reads (see automation.service.ts executeAction). Every
// value input also accepts {{dot.path}} templating against the trigger
// payload, same as the backend.
const ACTION_PARAM_FIELDS = {
  create_task: [
    { key: 'title', label: 'Title', placeholder: 'e.g. Follow up with {{fullName}}' },
    { key: 'description', label: 'Description (optional)' },
    { key: 'assignedToUserId', label: 'Assign to user id (optional)' },
  ],
  create_lead: [
    { key: 'fullName', label: 'Full name' },
    { key: 'phone', label: 'Phone' },
    { key: 'email', label: 'Email (optional)' },
    { key: 'sourceId', label: 'Source id (optional)' },
  ],
  send_message: [
    { key: 'subject', label: 'Subject' },
    { key: 'body', label: 'Body' },
    { key: 'toUserId', label: 'To user id (optional)' },
  ],
  update_lead_status: [
    { key: 'leadId', label: 'Lead id', placeholder: '{{lead.id}} or a literal id' },
    { key: 'status', label: 'New status', placeholder: 'new / contacted / qualified / opportunity / lost' },
  ],
  assign_lead_owner: [
    { key: 'leadId', label: 'Lead id' },
    { key: 'ownerEmployeeUserId', label: 'New owner user id' },
  ],
  update_campaign_status: [
    { key: 'campaignId', label: 'Campaign id' },
    { key: 'status', label: 'New status', placeholder: 'planned / active / completed / cancelled' },
  ],
  webhook_call: [
    { key: 'url', label: 'URL' },
    { key: 'method', label: 'Method (optional)', placeholder: 'POST' },
    { key: 'secretKey', label: 'Secret key (optional)', placeholder: 'a key stored under Secrets below' },
  ],
  integration_call: [
    { key: 'provider', label: 'Provider', placeholder: 'whatsapp / email / meta_ads / google_calendar / payment_stripe / custom_api' },
    { key: 'action', label: 'Action', placeholder: 'e.g. send_message — see the Integrations page for each provider’s actions' },
    { key: 'to', label: 'To (optional)', placeholder: 'phone number or email, depending on the provider' },
    { key: 'body', label: 'Message body (optional)' },
  ],
  ai_decide: [
    { key: 'agentKey', label: 'Agent', placeholder: 'sales / marketing / finance / support / hr — see the AI page' },
    { key: 'subjectId', label: 'Subject id', placeholder: 'e.g. {{id}} for the triggering lead' },
  ],
  require_approval: [
    { key: 'reason', label: 'Reason shown to the approver' },
  ],
};

function triggerFields(triggerType, values = {}) {
  const wrap = el('div', { class: 'form-row' });
  if (triggerType === 'event') {
    const eventSelect = selectInput(EVENT_TYPES.map((e) => ({ value: e, label: e })));
    if (values.eventType) eventSelect.value = values.eventType;
    wrap.appendChild(el('div', {}, [el('label', {}, 'Event'), eventSelect]));
    wrap.dataset.get = () => ({ type: 'event', eventType: eventSelect.value });
    wrap._get = () => ({ type: 'event', eventType: eventSelect.value });
  } else if (triggerType === 'scheduled') {
    const intervalInput = el('input', { type: 'number', min: '1', value: values.intervalMinutes || 60 });
    wrap.appendChild(el('div', {}, [el('label', {}, 'Every N minutes'), intervalInput]));
    wrap._get = () => ({ type: 'scheduled', intervalMinutes: Number(intervalInput.value) });
  } else {
    const slugInput = el('input', { type: 'text', placeholder: 'unique-slug', value: values.webhookSlug || '' });
    wrap.appendChild(el('div', {}, [el('label', {}, 'Webhook slug'), slugInput]));
    wrap._get = () => ({ type: 'webhook', webhookSlug: slugInput.value.trim() });
  }
  return wrap;
}

function stepEditor(step = {}) {
  const nameInput = el('input', { type: 'text', placeholder: 'Step name', value: step.name || '' });
  const actionSelect = selectInput(ACTION_TYPES, {});
  if (step.action?.type) actionSelect.value = step.action.type;
  const onFailureSelect = selectInput([{ value: 'stop', label: 'Stop on failure' }, { value: 'continue', label: 'Continue on failure' }]);
  if (step.onFailure) onFailureSelect.value = step.onFailure;
  const retriesInput = el('input', { type: 'number', min: '0', value: step.maxRetries ?? 0 });

  const paramsSlot = el('div', { class: 'form-row' });
  const conditionsSlot = el('div', {});
  const conditionRows = [];

  function renderParams() {
    clear(paramsSlot);
    const fields = ACTION_PARAM_FIELDS[actionSelect.value] || [];
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
    const fieldInput = el('input', { type: 'text', placeholder: 'e.g. status', value: initial.field || '' });
    const opSelect = selectInput(CONDITION_OPERATORS.map((o) => ({ value: o, label: o })));
    if (initial.operator) opSelect.value = initial.operator;
    const valueInput = el('input', { type: 'text', placeholder: 'value (optional for "exists")', value: initial.value ?? '' });
    const removeBtn = el('button', {}, '×');
    const row = el('div', { class: 'form-row', style: 'align-items:flex-end' }, [
      el('div', {}, [el('label', {}, 'If field'), fieldInput]),
      el('div', {}, [el('label', {}, 'Operator'), opSelect]),
      el('div', {}, [el('label', {}, 'Value'), valueInput]),
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
  const addConditionBtn = el('button', {}, '+ Add condition');
  addConditionBtn.addEventListener('click', () => addConditionRow());

  const removeStepBtn = el('button', {}, 'Remove step');
  const card = el('div', { class: 'card', style: 'margin-bottom:10px' }, [
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Step name'), nameInput]),
      el('div', {}, [el('label', {}, 'Action'), actionSelect]),
      el('div', {}, [el('label', {}, 'On failure'), onFailureSelect]),
      el('div', {}, [el('label', {}, 'Max retries'), retriesInput]),
    ]),
    el('div', {}, [el('label', {}, 'Conditions (all must match, or leave empty to always run)'), conditionsSlot, addConditionBtn]),
    el('div', {}, [el('label', {}, 'Action parameters'), paramsSlot]),
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
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, 'Automation Engine'),
      el('p', { class: 'page-subtitle' }, ['Pending approvals moved to ', el('a', { href: '#/approvals' }, 'Approvals'), '; run history across every workflow lives on ', el('a', { href: '#/workflow-history' }, 'Workflow History'), '.']),
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
        tile('Active workflows', stats.activeWorkflows),
        tile('Total runs', stats.totalRuns),
        tile('Running', stats.runningRuns),
        tile('Waiting approval', stats.waitingApprovalRuns),
        tile('Completed', stats.completedRuns),
        tile('Failed', stats.failedRuns),
        tile('Pending approvals', stats.pendingApprovals),
      ]));
    } catch (err) {
      statsSlot.appendChild(errorBanner(err.message));
    }
  }

  // ---- New workflow builder ----
  const nameInput = el('input', { type: 'text', placeholder: 'Workflow name' });
  const descInput = el('input', { type: 'text', placeholder: 'Description (optional)' });
  const triggerTypeSelect = selectInput(TRIGGER_TYPES);
  const triggerFieldsSlot = el('div');
  function renderTriggerFields() {
    clear(triggerFieldsSlot);
    const fields = triggerFields(triggerTypeSelect.value);
    triggerFieldsSlot.appendChild(fields);
    triggerFieldsSlot._get = fields._get;
  }
  triggerTypeSelect.addEventListener('change', renderTriggerFields);
  renderTriggerFields();

  const stepsSlot = el('div');
  const stepCards = [];
  function addStep(step) {
    const card = stepEditor(step);
    stepCards.push(card);
    stepsSlot.appendChild(card);
  }
  addStep();
  const addStepBtn = el('button', {}, '+ Add step');
  addStepBtn.addEventListener('click', () => addStep());

  const createBtn = el('button', { class: 'primary' }, 'Create workflow');
  createBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!nameInput.value.trim()) {
      errorSlot.appendChild(errorBanner('A workflow name is required.'));
      return;
    }
    const steps = stepCards.filter((c) => c.isConnected).map((c) => c._get());
    if (steps.length === 0) {
      errorSlot.appendChild(errorBanner('At least one step is required.'));
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
      toast('Workflow created.', 'success');
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
    el('h3', { style: 'margin-top:0' }, 'Build a workflow'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Name'), nameInput]),
      el('div', {}, [el('label', {}, 'Description'), descInput]),
      el('div', {}, [el('label', {}, 'Trigger type'), triggerTypeSelect]),
    ]),
    triggerFieldsSlot,
    el('h4', {}, 'Steps'),
    stepsSlot,
    addStepBtn,
    el('div', { class: 'form-actions' }, [createBtn]),
  ]));

  // ---- Templates ----
  const templatesSlot = el('div', { class: 'card' }, [el('h3', { style: 'margin-top:0' }, 'Templates'), loadingState()]);
  container.appendChild(templatesSlot);
  try {
    const templates = await api.get('/api/automation/templates');
    clear(templatesSlot);
    templatesSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Templates'));
    templates.forEach((t) => {
      const useBtn = el('button', {}, 'Use template');
      useBtn.addEventListener('click', () => {
        nameInput.value = t.name;
        descInput.value = t.description;
        triggerTypeSelect.value = t.trigger.type;
        renderTriggerFields();
        stepCards.length = 0;
        clear(stepsSlot);
        t.steps.forEach((s) => addStep(s));
        window.scrollTo({ top: 0, behavior: 'smooth' });
        toast(`Loaded template "${t.name}" into the builder above.`, 'info');
      });
      templatesSlot.appendChild(el('div', { class: 'form-row', style: 'align-items:center' }, [
        el('div', {}, [el('strong', {}, t.name), el('div', { class: 'muted' }, t.description)]),
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
      toast(`Workflow ${status}.`, 'success');
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
        toast('Run retried.', 'success');
        modalBody.remove();
        await showRuns(workflow);
      } catch (err) {
        btn.disabled = false;
        errorSlot.appendChild(errorBanner(err.message));
      }
    };
    const card = el('div', { class: 'modal-card' }, [
      el('h3', { class: 'modal-title' }, `Run history — ${workflow.name}`),
      table(
        [
          { label: 'Started', render: (r) => new Date(r.startedAt).toLocaleString() },
          { label: 'Status', render: (r) => statusBadge(r.status) },
          { label: 'Initiated by', key: 'initiatedBy' },
          { label: 'Error', render: (r) => r.error || '' },
          { label: '', render: (r) => {
            if (r.status !== 'failed') return '';
            const retryBtn = el('button', {}, 'Retry');
            retryBtn.addEventListener('click', () => retry(r, retryBtn));
            return retryBtn;
          } },
        ],
        runsPage.items.slice().reverse(),
        { empty: 'No runs yet.' },
      ),
      el('div', { class: 'form-actions', style: 'justify-content:flex-end' }, [
        (() => { const b = el('button', { class: 'primary' }, 'Close'); b.addEventListener('click', () => modalBody.remove()); return b; })(),
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
      const page = await api.get('/api/automation/workflows', { limit: 50 });
      clear(workflowsSlot);
      workflowsSlot.appendChild(el('h3', {}, 'Workflows'));
      workflowsSlot.appendChild(table(
        [
          { label: 'Name', key: 'name' },
          { label: 'Trigger', render: (w) => w.trigger.type === 'event' ? `event: ${w.trigger.eventType}` : w.trigger.type === 'scheduled' ? `every ${w.trigger.intervalMinutes}m` : `webhook: ${w.trigger.webhookSlug}` },
          { label: 'Steps', render: (w) => String(w.steps.length) },
          { label: 'Status', render: (w) => statusBadge(w.status) },
          { label: '', render: (w) => {
            const actions = el('div', { style: 'display:flex;gap:6px' });
            const runsBtn = el('button', {}, 'Runs');
            runsBtn.addEventListener('click', () => showRuns(w));
            actions.appendChild(runsBtn);
            if (w.status === 'active') {
              const pauseBtn = el('button', {}, 'Pause');
              pauseBtn.addEventListener('click', () => setStatus(w, 'paused'));
              actions.appendChild(pauseBtn);
            } else if (w.status === 'paused') {
              const resumeBtn = el('button', {}, 'Resume');
              resumeBtn.addEventListener('click', () => setStatus(w, 'active'));
              actions.appendChild(resumeBtn);
            }
            if (w.status !== 'archived') {
              const archiveBtn = el('button', {}, 'Archive');
              archiveBtn.addEventListener('click', async () => {
                if (await confirmModal(`Archive workflow "${w.name}"? It will stop reacting to new triggers.`, { danger: true })) setStatus(w, 'archived');
              });
              actions.appendChild(archiveBtn);
            }
            return actions;
          } },
        ],
        page.items,
        { empty: 'No workflows yet — build one above, or use a template.' },
      ));
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
    secretsSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Secrets (encrypted at rest, for webhook_call actions)'));
    const keyInput = el('input', { type: 'text', placeholder: 'key, e.g. zapier_token' });
    const valueInput = el('input', { type: 'password', placeholder: 'value' });
    const saveBtn = el('button', { class: 'primary' }, 'Save secret');
    saveBtn.addEventListener('click', async () => {
      if (!keyInput.value.trim() || !valueInput.value.trim()) return;
      try {
        await api.post('/api/automation/secrets', { key: keyInput.value.trim(), value: valueInput.value });
        keyInput.value = ''; valueInput.value = '';
        toast('Secret saved.', 'success');
        await loadSecrets();
      } catch (err) {
        errorSlot.appendChild(errorBanner(err.message));
      }
    });
    secretsSlot.appendChild(el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Key'), keyInput]),
      el('div', {}, [el('label', {}, 'Value'), valueInput]),
      el('div', { class: 'form-actions' }, [saveBtn]),
    ]));
    try {
      const list = await api.get('/api/automation/secrets');
      secretsSlot.appendChild(table(
        [
          { label: 'Key', key: 'key' },
          { label: 'Created', render: (s) => new Date(s.createdAt).toLocaleString() },
          { label: '', render: (s) => {
            const delBtn = el('button', { class: 'danger' }, 'Delete');
            delBtn.addEventListener('click', async () => {
              if (!(await confirmModal(`Delete secret "${s.key}"? Any workflow referencing it will fail.`, { danger: true }))) return;
              try {
                await api.delete(`/api/automation/secrets/${s.id}`);
                toast('Secret deleted.', 'success');
                await loadSecrets();
              } catch (err) {
                errorSlot.appendChild(errorBanner(err.message));
              }
            });
            return delBtn;
          } },
        ],
        list,
        { empty: 'No secrets stored yet — values are encrypted and never shown again after saving.' },
      ));
    } catch (err) {
      secretsSlot.appendChild(errorBanner(err.message));
    }
  }

  await Promise.all([loadStats(), loadWorkflows(), loadSecrets()]);
}
