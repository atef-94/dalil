import { el, clear, table, toast, errorBanner, statusBadge, loadingState, selectInput } from '../ui.js';
import { api } from '../api.js';

export async function renderMarketing(container) {
  clear(container);
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, 'Marketing — Campaigns')));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const nameInput = el('input', { type: 'text', placeholder: 'e.g. Spring Launch' });
  const channelSelect = selectInput(['digital', 'print', 'event', 'referral', 'other'].map((c) => ({ value: c, label: c })));
  const budgetInput = el('input', { type: 'number', placeholder: '5000' });
  const startInput = el('input', { type: 'date' });
  const createBtn = el('button', { class: 'primary' }, 'Create campaign');

  createBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!nameInput.value.trim() || !startInput.value || !(Number(budgetInput.value) >= 0)) {
      errorSlot.appendChild(errorBanner('Enter a name, start date, and a non-negative budget.'));
      return;
    }
    createBtn.disabled = true;
    try {
      await api.post('/api/marketing/campaigns', {
        name: nameInput.value.trim(),
        channel: channelSelect.value,
        budget: Number(budgetInput.value),
        startDate: startInput.value,
      });
      nameInput.value = '';
      budgetInput.value = '';
      toast('Campaign created.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Create a campaign'),
    el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, 'To attribute a lead to this campaign, use the campaign\'s ID as the lead\'s "Source" when adding it on the Leads page.'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Name'), nameInput]),
      el('div', {}, [el('label', {}, 'Channel'), channelSelect]),
      el('div', {}, [el('label', {}, 'Budget'), budgetInput]),
      el('div', {}, [el('label', {}, 'Start date'), startInput]),
    ]),
    el('div', { class: 'form-actions' }, [createBtn]),
  ]));

  const listSlot = el('div');
  container.appendChild(listSlot);

  const NEXT_STATUS = { planned: 'active', active: 'completed' };

  async function advance(campaign, btn) {
    const next = NEXT_STATUS[campaign.status];
    if (!next) return;
    btn.disabled = true;
    try {
      await api.post(`/api/marketing/campaigns/${campaign.id}/status`, { status: next });
      toast(`Campaign moved to "${next}".`, 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function cancel(campaign, btn) {
    btn.disabled = true;
    try {
      await api.post(`/api/marketing/campaigns/${campaign.id}/status`, { status: 'cancelled' });
      toast('Campaign cancelled.', 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function showPerformance(campaign) {
    try {
      const perf = await api.get(`/api/marketing/campaigns/${campaign.id}/performance`);
      toast(`${perf.campaignName}: ${perf.leadCount} leads, ${perf.qualifiedCount} qualified, ${perf.convertedCount} converted (${perf.conversionRate}%).`, 'info');
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/marketing/campaigns', { limit: 50 });
      clear(listSlot);
      listSlot.appendChild(table(
        [
          { label: 'Name', key: 'name' },
          { label: 'ID (use as lead source)', render: (c) => c.id },
          { label: 'Channel', key: 'channel' },
          { label: 'Budget', render: (c) => Number(c.budget).toLocaleString() },
          { label: 'Status', render: (c) => statusBadge(c.status) },
          { label: '', render: (c) => {
            const actions = [];
            const perfBtn = el('button', {}, 'Performance');
            perfBtn.addEventListener('click', () => showPerformance(c));
            actions.push(perfBtn);
            if (NEXT_STATUS[c.status]) {
              const advanceBtn = el('button', { class: 'primary' }, `→ ${NEXT_STATUS[c.status]}`);
              advanceBtn.addEventListener('click', () => advance(c, advanceBtn));
              actions.push(advanceBtn);
            }
            if (c.status === 'planned' || c.status === 'active') {
              const cancelBtn = el('button', { class: 'danger' }, 'Cancel');
              cancelBtn.addEventListener('click', () => cancel(c, cancelBtn));
              actions.push(cancelBtn);
            }
            return el('div', { class: 'form-actions' }, actions);
          } },
        ],
        page.items,
        { empty: 'No campaigns yet — create one above.' },
      ));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
