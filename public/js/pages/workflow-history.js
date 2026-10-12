import { el, clear, table, toast, errorBanner, statusBadge, loadingState, selectInput, paginationControls } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

const PAGE_SIZE = 20;

export async function renderWorkflowHistory(container) {
  clear(container);
  const locale = getLocale();
  let offset = 0;
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, t(locale, 'page_title_workflow_history')),
      el('p', { class: 'page-subtitle' }, t(locale, 'wf_history_subtitle')),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const workflowFilter = selectInput([{ value: '', label: t(locale, 'wf_history_all_workflows') }]);
  workflowFilter.addEventListener('change', () => { offset = 0; render(); });
  container.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'form-row' }, [el('div', { style: 'max-width:260px' }, [el('label', {}, t(locale, 'wf_history_workflow_label')), workflowFilter])]),
  ]));

  const listSlot = el('div');
  container.appendChild(listSlot);

  let workflows = [];
  let allRuns = [];

  async function retry(run) {
    try {
      await api.post(`/api/automation/runs/${run.id}/retry`, {});
      toast(t(locale, 'automation_toast_run_retried'), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  function render() {
    clear(listSlot);
    const filtered = workflowFilter.value ? allRuns.filter((r) => r.workflowId === workflowFilter.value) : allRuns;
    const pageItems = filtered.slice(offset, offset + PAGE_SIZE);
    listSlot.appendChild(table(
      [
        { label: t(locale, 'wf_history_workflow_label'), render: (r) => workflows.find((w) => w.id === r.workflowId)?.name ?? r.workflowId },
        { label: t(locale, 'automation_col_started'), render: (r) => new Date(r.startedAt).toLocaleString() },
        { label: t(locale, 'automation_label_status'), render: (r) => statusBadge(r.status) },
        { label: t(locale, 'automation_col_initiated_by'), key: 'initiatedBy' },
        { label: t(locale, 'automation_col_error'), render: (r) => r.error || '' },
        { label: '', render: (r) => {
          if (r.status !== 'failed') return '';
          const btn = el('button', {}, t(locale, 'automation_btn_retry'));
          btn.addEventListener('click', () => retry(r));
          return btn;
        } },
      ],
      pageItems,
      { empty: t(locale, 'automation_empty_runs'), emptyIcon: 'history' },
    ));
    // Client-side pagination over the already-fetched, merged cross-workflow
    // run list — there's no single backend endpoint for "every run across
    // every workflow" to paginate server-side against.
    listSlot.appendChild(paginationControls(
      { total: filtered.length, limit: PAGE_SIZE, offset },
      (next) => { offset = next; render(); },
    ));
  }

  async function load() {
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const workflowsPage = await api.get('/api/automation/workflows', { limit: 100 });
      workflows = workflowsPage.items;
      clear(workflowFilter);
      workflowFilter.appendChild(el('option', { value: '' }, t(locale, 'wf_history_all_workflows')));
      workflows.forEach((w) => workflowFilter.appendChild(el('option', { value: w.id }, w.name)));

      const runsByWorkflow = await Promise.all(workflows.map((w) => api.get(`/api/automation/workflows/${w.id}/runs`, { limit: 50 })));
      allRuns = runsByWorkflow.flatMap((p) => p.items).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
      render();
    } catch (err) {
      clear(listSlot);
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
