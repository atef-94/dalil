import { el, clear, table, errorBanner, statusBadge, loadingState, paginationControls, contentModal, toast, selectInput } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

// Only one goal type exists today — see AiWorkflowService. Listed here (not
// hardcoded into the start form) so a second goal type added later shows up
// with zero frontend changes.
function goalTypeOptions(locale) {
  return [{ value: 'high_value_lead_followup', label: t(locale, 'ai_workflows_goal_high_value_lead_followup') }];
}

function formatWhen(iso) {
  return iso ? new Date(iso).toLocaleString() : '—';
}

async function openRunDetail(locale, run, onChanged) {
  const body = el('div');
  const { close } = contentModal(`${t(locale, 'ai_workflows_run_title_prefix')}${run.goalType}`, body, { wide: true });

  const summary = el('div', { class: 'card', style: 'margin-bottom:12px' }, [
    el('div', {}, [el('strong', {}, t(locale, 'ai_workflows_field_status')), statusBadge(run.status)]),
    el('div', {}, [el('strong', {}, t(locale, 'ai_workflows_field_subject')), `${run.subjectType}:${run.subjectId}`]),
    el('div', {}, [el('strong', {}, t(locale, 'ai_workflows_field_current_step')), run.currentStepName || '—']),
    run.resumeAt ? el('div', {}, [el('strong', {}, t(locale, 'ai_workflows_field_resumes_at')), formatWhen(run.resumeAt)]) : null,
    run.outcomeSummary ? el('div', { style: 'margin-top:8px' }, [el('strong', {}, t(locale, 'ai_workflows_field_outcome')), el('span', { class: 'wrap' }, run.outcomeSummary)]) : null,
  ].filter(Boolean));
  body.appendChild(summary);

  if (run.status === 'waiting') {
    const resumeBtn = el('button', { class: 'primary' }, t(locale, 'ai_workflows_resume_btn'));
    resumeBtn.addEventListener('click', async () => {
      resumeBtn.disabled = true;
      try {
        const updated = await api.post(`/api/ai/workflows/${run.id}/resume`, {});
        toast(`${t(locale, 'ai_workflows_resumed_prefix')}${updated.status}${t(locale, 'ai_workflows_resumed_suffix')}`, 'success');
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

  body.appendChild(el('h3', {}, t(locale, 'ai_workflows_execution_trace_heading')));
  const stepsSlot = el('div');
  stepsSlot.appendChild(loadingState());
  body.appendChild(stepsSlot);

  try {
    const steps = await api.get(`/api/ai/workflows/${run.id}/steps`);
    clear(stepsSlot);
    stepsSlot.appendChild(table(
      [
        { label: '#', key: 'sequence' },
        { label: t(locale, 'ai_workflows_col_step'), key: 'stepName' },
        { label: t(locale, 'automation_label_status'), render: (s) => statusBadge(s.status) },
        { label: t(locale, 'ai_col_reasoning'), render: (s) => el('span', { class: 'wrap' }, s.reasoning || '') },
        { label: t(locale, 'ai_col_when'), render: (s) => formatWhen(s.finishedAt) },
      ],
      steps,
      { empty: t(locale, 'ai_workflows_no_steps'), emptyIcon: 'ai' },
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
      el('p', { class: 'page-subtitle' }, t(locale, 'ai_workflows_subtitle')),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  // ---- Start a new workflow ----
  const goalSelect = selectInput(goalTypeOptions(locale));
  const subjectInput = el('input', { type: 'text', placeholder: t(locale, 'ai_workflows_subject_placeholder') });
  const startBtn = el('button', { class: 'primary' }, t(locale, 'ai_workflows_start_btn'));
  startBtn.addEventListener('click', async () => {
    if (!subjectInput.value.trim()) return;
    startBtn.disabled = true;
    try {
      const run = await api.post('/api/ai/workflows', { goalType: goalSelect.value, subjectId: subjectInput.value.trim() });
      toast(`${t(locale, 'ai_workflows_started_prefix')}${run.status}${t(locale, 'ai_workflows_started_suffix')}`, run.status === 'escalated' ? 'info' : 'success');
      subjectInput.value = '';
      await loadRuns();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      startBtn.disabled = false;
    }
  });
  container.appendChild(el('div', { class: 'card', style: 'margin-bottom:16px' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'ai_workflows_start_heading')),
    el('div', { class: 'form-row', style: 'align-items:flex-end' }, [
      el('div', {}, [el('label', {}, t(locale, 'ai_workflows_goal_label')), goalSelect]),
      el('div', {}, [el('label', {}, t(locale, 'ai_workflows_subject_lead_label')), subjectInput]),
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
          { label: t(locale, 'ai_workflows_goal_label'), key: 'goalType' },
          { label: t(locale, 'ai_workflows_col_subject'), render: (r) => `${r.subjectType}:${r.subjectId.slice(0, 8)}…` },
          { label: t(locale, 'automation_label_status'), render: (r) => statusBadge(r.status) },
          { label: t(locale, 'ai_workflows_col_current_step'), render: (r) => r.currentStepName || '—' },
          { label: t(locale, 'automation_col_started'), render: (r) => formatWhen(r.createdAt) },
          { label: t(locale, 'ai_workflows_col_updated'), render: (r) => formatWhen(r.updatedAt) },
          {
            label: '',
            render: (r) => {
              const btn = el('button', {}, t(locale, 'ai_workflows_view_btn'));
              btn.addEventListener('click', () => openRunDetail(locale, r, loadRuns));
              return btn;
            },
          },
        ],
        page.items,
        { empty: t(locale, 'ai_workflows_empty_runs'), emptyIcon: 'ai' },
      ));
      runsSlot.appendChild(paginationControls(page, (next) => { offset = next; loadRuns(); }));
    } catch (err) {
      clear(runsSlot);
      runsSlot.appendChild(errorBanner(err.message));
    }
  }

  await loadRuns();
}
