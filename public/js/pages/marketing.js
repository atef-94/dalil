import { el, clear, table, toast, errorBanner, statusBadge, loadingState, selectInput, paginationControls, searchInput } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

export async function renderMarketing(container) {
  clear(container);
  const locale = getLocale();
  let offset = 0;
  let q = '';
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, t(locale, 'page_title_marketing'))));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const nameInput = el('input', { type: 'text', placeholder: t(locale, 'marketing_name_placeholder') });
  const channelSelect = selectInput(['digital', 'print', 'event', 'referral', 'other'].map((c) => ({ value: c, label: c })));
  const budgetInput = el('input', { type: 'number', placeholder: '5000' });
  const startInput = el('input', { type: 'date' });
  const createBtn = el('button', { class: 'primary' }, t(locale, 'marketing_create_campaign_btn'));

  createBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!nameInput.value.trim() || !startInput.value || !(Number(budgetInput.value) >= 0)) {
      errorSlot.appendChild(errorBanner(t(locale, 'marketing_err_required')));
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
      toast(t(locale, 'marketing_created_toast'), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'marketing_create_campaign_title')),
    el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, t(locale, 'marketing_hint_lead_source')),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'crm_col_name')), nameInput]),
      el('div', {}, [el('label', {}, t(locale, 'crm_activity_channel_field')), channelSelect]),
      el('div', {}, [el('label', {}, t(locale, 'marketing_budget_field')), budgetInput]),
      el('div', {}, [el('label', {}, t(locale, 'common_field_start_date')), startInput]),
    ]),
    el('div', { class: 'form-actions' }, [createBtn]),
  ]));

  const search = searchInput(t(locale, 'marketing_search_placeholder'), (value) => { q = value; offset = 0; load(); });
  container.appendChild(el('div', { class: 'form-row', style: 'max-width:320px' }, [search]));

  const listSlot = el('div');
  container.appendChild(listSlot);

  const NEXT_STATUS = { planned: 'active', active: 'completed' };

  async function advance(campaign, btn) {
    const next = NEXT_STATUS[campaign.status];
    if (!next) return;
    btn.disabled = true;
    try {
      await api.post(`/api/marketing/campaigns/${campaign.id}/status`, { status: next });
      toast(`${t(locale, 'marketing_moved_toast_prefix')}${next}${t(locale, 'marketing_moved_toast_suffix')}`, 'success');
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
      toast(t(locale, 'marketing_cancelled_toast'), 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function showPerformance(campaign) {
    try {
      const perf = await api.get(`/api/marketing/campaigns/${campaign.id}/performance`);
      toast(`${perf.campaignName}: ${perf.leadCount} ${t(locale, 'marketing_perf_leads_label')}, ${perf.qualifiedCount} ${t(locale, 'marketing_perf_qualified_label')}, ${perf.convertedCount} ${t(locale, 'marketing_perf_converted_label')} (${perf.conversionRate}%).`, 'info');
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/marketing/campaigns', { limit: 20, offset, q });
      clear(listSlot);
      listSlot.appendChild(table(
        [
          { label: t(locale, 'crm_col_name'), key: 'name' },
          { label: t(locale, 'marketing_col_id_source'), render: (c) => c.id },
          { label: t(locale, 'crm_activity_channel_field'), key: 'channel' },
          { label: t(locale, 'marketing_budget_field'), render: (c) => Number(c.budget).toLocaleString() },
          { label: t(locale, 'common_col_status'), render: (c) => statusBadge(c.status) },
          { label: '', render: (c) => {
            const actions = [];
            const perfBtn = el('button', {}, t(locale, 'marketing_performance_btn'));
            perfBtn.addEventListener('click', () => showPerformance(c));
            actions.push(perfBtn);
            if (NEXT_STATUS[c.status]) {
              const advanceBtn = el('button', { class: 'primary' }, `→ ${NEXT_STATUS[c.status]}`);
              advanceBtn.addEventListener('click', () => advance(c, advanceBtn));
              actions.push(advanceBtn);
            }
            if (c.status === 'planned' || c.status === 'active') {
              const cancelBtn = el('button', { class: 'danger' }, t(locale, 'common_cancel'));
              cancelBtn.addEventListener('click', () => cancel(c, cancelBtn));
              actions.push(cancelBtn);
            }
            return el('div', { class: 'form-actions' }, actions);
          } },
        ],
        page.items,
        { empty: t(locale, 'marketing_empty_campaigns') },
      ));
      listSlot.appendChild(paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
