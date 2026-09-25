import { el, clear, table, errorBanner, statusBadge, loadingState, paginationControls, contentModal, toast, selectInput } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

// Only one goal type exists today — see AiWorkflowService. Listed here (not
// hardcoded into the start form) so a second goal type added later shows up
// with zero frontend changes.
const GOAL_TYPES = [{ value: 'high_value_lead_followup', label: 'High-Value Lead Follow-up' }];

function formatWhen(iso) {
  return iso ? new Date(iso).toLocaleString() : '—';
}

async function openRunDetail(run, onChanged) {
  const body = el('div');
  const { close } = contentModal(`AI Workflow Run — ${run.goalType}`, body, { wide: true });

  const summary = el('div', { class: 'card', style: 'margin-bottom:12px' }, [
    el('div', {}, [el('strong', {}, 'Status: '), statusBadge(run.status)]),
    el('div', {}, [el('strong', {}, 'Subject: '), `${run.subjectType}:${run.subjectId}`]),
    el('div', {}, [el('strong', {}, 'Current step: '), run.currentStepName || '—']),
    run.resumeAt ? el('div', {}, [el('strong', {}, 'Resumes at: '), formatWhen(run.resumeAt)]) : null,
    run.outcomeSummary ? el('div', { style: 'margin-top:8px' }, [el('strong', {}, 'Outcome: '), el('span', { class: 'wrap' }, run.outcomeSummary)]) : null,
  ].filter(Boolean));
  body.appendChild(summary);

  if (run.status === 'waiting') {
    const resumeBtn = el('button', { class: 'primary' }, 'Resume now');
    resumeBtn.addEventListener('click', async () => {
      resumeBtn.disabled = true;
      try {
        const updated = await api.post(`/api/ai/workflows/${run.id}/resume`, {});
        toast(`Run resumed — now ${updated.status}.`, 'success');
        close();
        onChanged();
      } catch (err) {
        body.appendChild(errorBanner(err.message));
      } finally {
        resumeBtn.disabled = false;
      }
    });
    body.appendChild(el('div', { style: 'margin-bottom:12px' }, [resumeBtn]));
  }

  body.appendChild(el('h3', {}, 'Execution trace'));
  const stepsSlot = el('div');
  stepsSlot.appendChild(loadingState());
  body.appendChild(stepsSlot);

  try {
    const steps = await api.get(`/api/ai/workflows/${run.id}/steps`);
    clear(stepsSlot);
    stepsSlot.appendChild(table(
      [
        { label: '#', key: 'sequence' },
        { label: 'Step', key: 'stepName' },
        { label: 'Status', render: (s) => statusBadge(s.status) },
        { label: 'Reasoning', render: (s) => el('span', { class: 'wrap' }, s.reasoning || '') },
        { label: 'When', render: (s) => formatWhen(s.finishedAt) },
      ],
      steps,
      { empty: 'No steps recorded yet.', emptyIcon: 'ai' },
    ));
  } catch (err) {
    clear(stepsSlot);
    stepsSlot.appendChild(errorBanner(err.message));
  }
}

export async function renderAiWorkflows(container) {
  clear(container);
  const locale = getLocale();
  let offset = 0;

  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, t(locale, 'page_title_ai_workflows')),
      el('p', { class: 'page-subtitle' }, 'Multi-step, replanning AI workflows — each run plans, executes, evaluates, and either continues, waits for a real reply, completes, or escalates to a human. Every mutating step passes through the same permission/policy/approval pipeline as the rest of the AI Execution Layer.'),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  // ---- Start a new workflow ----
  const goalSelect = selectInput(GOAL_TYPES);
  const subjectInput = el('input', { type: 'text', placeholder: 'lead id' });
  const startBtn = el('button', { class: 'primary' }, 'Start workflow');
  startBtn.addEventListener('click', async () => {
    if (!subjectInput.value.trim()) return;
    startBtn.disabled = true;
    try {
      const run = await api.post('/api/ai/workflows', { goalType: goalSelect.value, subjectId: subjectInput.value.trim() });
      toast(`Workflow started — status: ${run.status}.`, run.status === 'escalated' ? 'info' : 'success');
      subjectInput.value = '';
      await loadRuns();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      startBtn.disabled = false;
    }
  });
  container.appendChild(el('div', { class: 'card', style: 'margin-bottom:16px' }, [
    el('h3', { style: 'margin-top:0' }, 'Start a workflow'),
    el('div', { class: 'form-row', style: 'align-items:flex-end' }, [
      el('div', {}, [el('label', {}, 'Goal'), goalSelect]),
      el('div', {}, [el('label', {}, 'Subject (lead) id'), subjectInput]),
      startBtn,
    ]),
  ]));

  const runsSlot = el('div');
  container.appendChild(runsSlot);

  async function loadRuns() {
    clear(runsSlot);
    runsSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/ai/workflows', { limit: 20, offset });
      clear(runsSlot);
      runsSlot.appendChild(table(
        [
          { label: 'Goal', key: 'goalType' },
          { label: 'Subject', render: (r) => `${r.subjectType}:${r.subjectId.slice(0, 8)}…` },
          { label: 'Status', render: (r) => statusBadge(r.status) },
          { label: 'Current step', render: (r) => r.currentStepName || '—' },
          { label: 'Started', render: (r) => formatWhen(r.createdAt) },
          { label: 'Updated', render: (r) => formatWhen(r.updatedAt) },
          {
            label: '',
            render: (r) => {
              const btn = el('button', {}, 'View');
              btn.addEventListener('click', () => openRunDetail(r, loadRuns));
              return btn;
            },
          },
        ],
        page.items,
        { empty: 'No AI workflow runs yet — start one above.', emptyIcon: 'ai' },
      ));
      runsSlot.appendChild(paginationControls(page, (next) => { offset = next; loadRuns(); }));
    } catch (err) {
      clear(runsSlot);
      runsSlot.appendChild(errorBanner(err.message));
    }
  }

  await loadRuns();
}
