import { el, clear, table, toast, errorBanner, statusBadge, loadingState, selectInput } from '../ui.js';
import { api } from '../api.js';

export async function renderWorkflowHistory(container) {
  clear(container);
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, 'Workflow Execution History'),
      el('p', { class: 'page-subtitle' }, 'Every run across every workflow, most recent first. Open a workflow\'s own page in Automation for its builder.'),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const workflowFilter = selectInput([{ value: '', label: 'All workflows' }]);
  workflowFilter.addEventListener('change', render);
  container.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'form-row' }, [el('div', { style: 'max-width:260px' }, [el('label', {}, 'Workflow'), workflowFilter])]),
  ]));

  const listSlot = el('div');
  container.appendChild(listSlot);

  let workflows = [];
  let allRuns = [];

  async function retry(run) {
    try {
      await api.post(`/api/automation/runs/${run.id}/retry`, {});
      toast('Run retried.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  function render() {
    clear(listSlot);
    const filtered = workflowFilter.value ? allRuns.filter((r) => r.workflowId === workflowFilter.value) : allRuns;
    listSlot.appendChild(table(
      [
        { label: 'Workflow', render: (r) => workflows.find((w) => w.id === r.workflowId)?.name ?? r.workflowId },
        { label: 'Started', render: (r) => new Date(r.startedAt).toLocaleString() },
        { label: 'Status', render: (r) => statusBadge(r.status) },
        { label: 'Initiated by', key: 'initiatedBy' },
        { label: 'Error', render: (r) => r.error || '' },
        { label: '', render: (r) => {
          if (r.status !== 'failed') return '';
          const btn = el('button', {}, 'Retry');
          btn.addEventListener('click', () => retry(r));
          return btn;
        } },
      ],
      filtered,
      { empty: 'No runs yet.', emptyIcon: 'history' },
    ));
  }

  async function load() {
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const workflowsPage = await api.get('/api/automation/workflows', { limit: 100 });
      workflows = workflowsPage.items;
      clear(workflowFilter);
      workflowFilter.appendChild(el('option', { value: '' }, 'All workflows'));
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
