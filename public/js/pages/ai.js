import { el, clear, toast, errorBanner, selectInput, icon, table, badge } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

// require_approval and ai_decide are workflow-only meta-actions (the
// former pauses a run for a human decision, the latter hands a subject to
// a specialized agent) — neither is something the AI itself "performs" as
// a chosen action, so both are left out of the policy list here.
const AI_ACTION_TYPES = ['create_task', 'create_lead', 'send_message', 'update_lead_status', 'assign_lead_owner', 'update_campaign_status', 'webhook_call', 'integration_call'];
// Action types reuse the exact same labels as the Automation Engine (they
// are the same enum), so no separate ai_* i18n keys are needed for them.
const ACTION_TYPE_LABEL_KEYS = {
  create_task: 'automation_action_create_task',
  create_lead: 'automation_action_create_lead',
  send_message: 'automation_action_send_message',
  update_lead_status: 'automation_action_update_lead_status',
  assign_lead_owner: 'automation_action_assign_lead_owner',
  update_campaign_status: 'automation_action_update_campaign_status',
  webhook_call: 'automation_action_webhook_call',
  integration_call: 'automation_action_integration_call',
};
function autonomyLevelOptions(locale) {
  return [
    { value: 'suggest_only', label: t(locale, 'ai_autonomy_suggest_only') },
    { value: 'require_approval', label: t(locale, 'ai_autonomy_require_approval') },
    { value: 'auto_execute', label: t(locale, 'ai_autonomy_auto_execute') },
  ];
}

export async function renderAi(container) {
  clear(container);
  const locale = getLocale();
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, t(locale, 'page_title_ai')),
      el('p', { class: 'page-subtitle' }, t(locale, 'ai_page_subtitle')),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  // ---- Agents roster ----
  const agentsSlot = el('div');
  container.appendChild(agentsSlot);

  async function loadAgents() {
    clear(agentsSlot);
    let agents = [];
    try {
      agents = await api.get('/api/ai/agents');
    } catch (err) {
      agentsSlot.appendChild(errorBanner(err.message));
      return;
    }

    const cards = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-bottom:16px' });
    for (const agent of agents) {
      let tools = [];
      try { tools = await api.get('/api/ai/tools', { agent: agent.key }); } catch { /* non-fatal */ }
      cards.appendChild(el('div', { class: 'card' }, [
        el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:6px' }, [icon('ai'), el('strong', {}, agent.name)]),
        el('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:8px' }, agent.businessFunction),
        el('p', { style: 'font-size:13px' }, agent.goal),
        el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `${t(locale, 'ai_agents_tools_label')} ${tools.map((tl) => tl.name).join(', ') || '—'}`),
        el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `${t(locale, 'ai_agents_escalates_prefix')} ${agent.escalateBelowConfidence}${t(locale, 'crm_ai_confidence_suffix')}`),
      ]));
    }
    agentsSlot.appendChild(cards);

    // ---- Run a decision on demand ----
    const agentSelect = selectInput(agents.map((a) => ({ value: a.key, label: a.name })));
    const subjectInput = el('input', { type: 'text', placeholder: `${agents[0]?.subjectType || t(locale, 'ai_agents_subject_fallback')} ${t(locale, 'ai_agents_subject_id_placeholder_suffix')}` });
    const runBtn = el('button', { class: 'primary' }, t(locale, 'ai_agents_run_decision_btn'));

    agentSelect.addEventListener('change', () => {
      const agent = agents.find((a) => a.key === agentSelect.value);
      subjectInput.placeholder = `${agent?.subjectType || t(locale, 'ai_agents_subject_fallback')} ${t(locale, 'ai_agents_subject_id_placeholder_suffix')}`;
    });

    runBtn.addEventListener('click', async () => {
      if (!subjectInput.value.trim()) return;
      runBtn.disabled = true;
      try {
        const decision = await api.post(`/api/ai/agents/${agentSelect.value}/decide`, { subjectId: subjectInput.value.trim() });
        toast(`[${decision.status}, ${decision.confidence}${t(locale, 'crm_ai_confidence_suffix')}] ${decision.reasoning}`, decision.status === 'escalated' ? 'info' : 'success');
      } catch (err) {
        errorSlot.appendChild(errorBanner(err.message));
      } finally {
        runBtn.disabled = false;
      }
    });

    agentsSlot.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, t(locale, 'ai_agents_run_decision_heading')),
      el('div', { class: 'form-row', style: 'align-items:flex-end' }, [
        el('div', {}, [el('label', {}, t(locale, 'automation_field_agent')), agentSelect]),
        el('div', {}, [el('label', {}, t(locale, 'automation_field_subject_id')), subjectInput]),
        runBtn,
      ]),
      el('p', { class: 'page-subtitle', style: 'margin-top:8px' }, [t(locale, 'ai_agents_see_outcome_prefix'), el('a', { href: '#/ai-activity' }, t(locale, 'nav_ai_activity')), t(locale, 'ai_agents_see_outcome_suffix')]),
    ]));
  }

  // ---- Policies ----
  const policiesSlot = el('div', { class: 'card' });
  container.appendChild(policiesSlot);

  async function loadPolicies() {
    clear(policiesSlot);
    policiesSlot.appendChild(el('h3', { style: 'margin-top:0' }, t(locale, 'ai_policies_heading')));
    policiesSlot.appendChild(el('p', { class: 'page-subtitle' }, t(locale, 'ai_policies_subtitle')));
    let current = [];
    try {
      current = await api.get('/api/ai/policies');
    } catch (err) {
      policiesSlot.appendChild(errorBanner(err.message));
      return;
    }
    const rows = AI_ACTION_TYPES.map((actionType) => {
      const existing = current.find((p) => p.actionType === actionType);
      const select = selectInput(autonomyLevelOptions(locale));
      select.value = existing?.autonomyLevel || 'require_approval';
      // Guardrails: only ever escalate an 'auto_execute' policy to require
      // approval (a violation forces the require_approval branch server-
      // side) — never loosen a stricter setting. Left blank = no limit.
      const maxAmountInput = el('input', { type: 'number', min: '0', placeholder: t(locale, 'ai_policies_no_limit_placeholder'), value: existing?.maxFinancialAmount ?? '' });
      const channelsInput = el('input', { type: 'text', placeholder: t(locale, 'ai_policies_channels_placeholder'), value: (existing?.allowedChannels || []).join(',') });
      const hoursStartInput = el('input', { type: 'time', value: existing?.workingHoursStart ?? '' });
      const hoursEndInput = el('input', { type: 'time', value: existing?.workingHoursEnd ?? '' });
      const saveBtn = el('button', { class: 'primary' }, t(locale, 'crm_save_btn'));
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
          await api.post('/api/ai/policies', {
            actionType,
            autonomyLevel: select.value,
            maxFinancialAmount: maxAmountInput.value.trim() ? Number(maxAmountInput.value) : undefined,
            allowedChannels: channelsInput.value.trim() ? channelsInput.value.split(',').map((c) => c.trim()).filter(Boolean) : undefined,
            workingHoursStart: hoursStartInput.value || undefined,
            workingHoursEnd: hoursEndInput.value || undefined,
          });
          toast(`${t(locale, 'ai_policies_saved_prefix')}${actionType}${t(locale, 'ai_policies_saved_suffix')}`, 'success');
        } catch (err) {
          errorSlot.appendChild(errorBanner(err.message));
        } finally {
          saveBtn.disabled = false;
        }
      });
      return el('div', { class: 'form-row', style: 'align-items:flex-end;flex-wrap:wrap' }, [
        el('div', {}, [el('label', {}, t(locale, ACTION_TYPE_LABEL_KEYS[actionType] || actionType)), select]),
        el('div', {}, [el('label', {}, t(locale, 'ai_policies_max_amount_label')), maxAmountInput]),
        el('div', {}, [el('label', {}, t(locale, 'ai_policies_channels_label')), channelsInput]),
        el('div', {}, [el('label', {}, t(locale, 'ai_policies_hours_from_label')), hoursStartInput]),
        el('div', {}, [el('label', {}, t(locale, 'ai_policies_hours_to_label')), hoursEndInput]),
        saveBtn,
      ]);
    });
    rows.forEach((r) => policiesSlot.appendChild(r));
  }

  // ---- AI Memory inspector ----
  const memorySlot = el('div', { class: 'card' });
  container.appendChild(memorySlot);

  async function loadMemory(filter = {}) {
    clear(memorySlot);
    memorySlot.appendChild(el('h3', { style: 'margin-top:0' }, t(locale, 'ai_memory_heading')));
    memorySlot.appendChild(el('p', { class: 'page-subtitle' }, t(locale, 'ai_memory_subtitle')));

    const categorySelect = selectInput([
      { value: '', label: t(locale, 'ai_memory_all_categories') },
      ...['working', 'short_term', 'long_term', 'customer', 'lead', 'agent', 'company', 'workflow'].map((c) => ({ value: c, label: c })),
    ]);
    categorySelect.value = filter.category || '';
    const queryInput = el('input', { type: 'text', placeholder: t(locale, 'ai_memory_search_placeholder'), value: filter.query || '' });
    const searchBtn = el('button', { class: 'primary' }, t(locale, 'ai_memory_search_btn'));
    const filterRow = el('div', { class: 'form-row', style: 'align-items:flex-end' }, [
      el('div', {}, [el('label', {}, t(locale, 'ai_memory_category_label')), categorySelect]),
      el('div', {}, [el('label', {}, t(locale, 'ai_memory_search_btn')), queryInput]),
      searchBtn,
    ]);
    memorySlot.appendChild(filterRow);
    searchBtn.addEventListener('click', () => loadMemory({ category: categorySelect.value, query: queryInput.value }));

    const resultsSlot = el('div', { style: 'margin-top:12px' });
    memorySlot.appendChild(resultsSlot);

    let memories = [];
    try {
      memories = await api.get('/api/ai/memory', { category: filter.category || undefined, query: filter.query || undefined });
    } catch (err) {
      resultsSlot.appendChild(errorBanner(err.message));
      return;
    }
    if (memories.length === 0) {
      resultsSlot.appendChild(el('p', { class: 'page-subtitle' }, t(locale, 'ai_memory_no_matches')));
      return;
    }
    for (const m of memories) {
      const invalidateBtn = el('button', {}, m.invalidatedAt ? t(locale, 'ai_memory_invalidated_btn') : t(locale, 'ai_memory_invalidate_btn'));
      invalidateBtn.disabled = !!m.invalidatedAt;
      invalidateBtn.addEventListener('click', async () => {
        invalidateBtn.disabled = true;
        try {
          await api.post(`/api/ai/memory/${m.id}/invalidate`, {});
          toast(t(locale, 'ai_memory_invalidated_toast'), 'success');
          invalidateBtn.textContent = t(locale, 'ai_memory_invalidated_btn');
        } catch (err) {
          errorSlot.appendChild(errorBanner(err.message));
          invalidateBtn.disabled = false;
        }
      });
      resultsSlot.appendChild(el('div', { class: 'card', style: 'margin-bottom:8px' }, [
        el('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:8px' }, [
          el('div', {}, [
            badge(m.category, 'blue'),
            m.subjectType ? el('span', { style: 'margin-left:8px;font-size:12px;color:var(--text-muted)' }, `${m.subjectType}:${m.subjectId}`) : '',
          ]),
          invalidateBtn,
        ]),
        el('p', { style: 'margin:8px 0' }, m.content),
        el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `${t(locale, 'ai_memory_confidence_label')} ${m.confidence}% · ${t(locale, 'ai_memory_source_label')} ${m.source?.type} · ${new Date(m.createdAt).toLocaleString()}`),
      ]));
    }
  }

  // ---- LLM settings ----
  const llmSlot = el('div', { class: 'card' });
  container.appendChild(llmSlot);

  async function loadLlm() {
    clear(llmSlot);
    llmSlot.appendChild(el('h3', { style: 'margin-top:0' }, t(locale, 'ai_llm_heading')));
    llmSlot.appendChild(el('p', { class: 'page-subtitle' }, t(locale, 'ai_llm_subtitle')));

    let configs = [];
    try {
      configs = await api.get('/api/ai/llm/config');
    } catch (err) {
      llmSlot.appendChild(errorBanner(err.message));
      return;
    }

    if (configs.length === 0) {
      llmSlot.appendChild(el('p', { class: 'page-subtitle' }, t(locale, 'ai_llm_none_configured')));
    } else {
      for (const c of configs) {
        const deactivateBtn = el('button', {}, c.isActive ? t(locale, 'ai_llm_deactivate_btn') : t(locale, 'ai_llm_inactive_btn'));
        deactivateBtn.disabled = !c.isActive;
        deactivateBtn.addEventListener('click', async () => {
          deactivateBtn.disabled = true;
          try {
            await api.post(`/api/ai/llm/config/${c.id}/deactivate`, {});
            toast(t(locale, 'ai_llm_deactivated_toast'), 'success');
            loadLlm();
          } catch (err) {
            errorSlot.appendChild(errorBanner(err.message));
            deactivateBtn.disabled = false;
          }
        });
        llmSlot.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)' }, [
          el('div', {}, [
            el('strong', {}, c.displayName),
            el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `${c.provider} · ${c.model} · ${c.isActive ? t(locale, 'ai_llm_active_word') : t(locale, 'ai_llm_inactive_word')}${c.dailyTokenBudget ? `${t(locale, 'ai_llm_budget_prefix')}${c.dailyTokenBudget}${t(locale, 'ai_llm_budget_suffix')}` : ''}`),
          ]),
          deactivateBtn,
        ]));
      }
    }

    const providerSelect = selectInput([
      { value: 'openai_compatible', label: t(locale, 'ai_llm_provider_openai_option') },
      { value: 'anthropic_compatible', label: t(locale, 'ai_llm_provider_anthropic_option') },
    ]);
    const nameInput = el('input', { type: 'text', placeholder: t(locale, 'ai_llm_display_name_placeholder') });
    const modelInput = el('input', { type: 'text', placeholder: t(locale, 'ai_llm_model_placeholder') });
    const baseUrlInput = el('input', { type: 'text', placeholder: t(locale, 'ai_llm_base_url_placeholder') });
    const apiKeyInput = el('input', { type: 'password', placeholder: t(locale, 'ai_llm_api_key_placeholder') });
    const budgetInput = el('input', { type: 'number', min: '0', placeholder: t(locale, 'ai_llm_daily_budget_placeholder') });
    const addBtn = el('button', { class: 'primary' }, t(locale, 'ai_llm_add_provider_btn'));
    addBtn.addEventListener('click', async () => {
      if (!nameInput.value.trim() || !modelInput.value.trim() || !baseUrlInput.value.trim() || !apiKeyInput.value.trim()) {
        toast(t(locale, 'ai_llm_required_error'), 'error');
        return;
      }
      addBtn.disabled = true;
      try {
        await api.post('/api/ai/llm/config', {
          provider: providerSelect.value,
          displayName: nameInput.value.trim(),
          model: modelInput.value.trim(),
          baseUrl: baseUrlInput.value.trim(),
          apiKey: apiKeyInput.value.trim(),
          dailyTokenBudget: budgetInput.value.trim() ? Number(budgetInput.value) : undefined,
        });
        toast(t(locale, 'ai_llm_saved_toast'), 'success');
        loadLlm();
      } catch (err) {
        errorSlot.appendChild(errorBanner(err.message));
      } finally {
        addBtn.disabled = false;
      }
    });
    llmSlot.appendChild(el('div', { class: 'form-row', style: 'align-items:flex-end;flex-wrap:wrap;margin-top:12px' }, [
      el('div', {}, [el('label', {}, t(locale, 'automation_field_provider')), providerSelect]),
      el('div', {}, [el('label', {}, t(locale, 'automation_label_name')), nameInput]),
      el('div', {}, [el('label', {}, t(locale, 'ai_llm_model_label')), modelInput]),
      el('div', {}, [el('label', {}, t(locale, 'ai_llm_base_url_label')), baseUrlInput]),
      el('div', {}, [el('label', {}, t(locale, 'ai_llm_api_key_label')), apiKeyInput]),
      el('div', {}, [el('label', {}, t(locale, 'ai_llm_daily_budget_label')), budgetInput]),
      addBtn,
    ]));

    let usage = [];
    try {
      usage = (await api.get('/api/ai/llm/usage')).items || [];
    } catch { /* non-fatal */ }
    if (usage.length > 0) {
      llmSlot.appendChild(el('h4', {}, t(locale, 'ai_llm_recent_usage_heading')));
      llmSlot.appendChild(table(
        [
          { key: 'model', label: t(locale, 'ai_llm_model_label') },
          { key: 'purpose', label: t(locale, 'ai_llm_col_purpose') },
          { key: 'totalTokens', label: t(locale, 'ai_llm_col_tokens') },
          { key: 'cost', label: t(locale, 'ai_llm_col_cost'), render: (u) => (u.costEstimateUsd !== undefined ? `$${u.costEstimateUsd.toFixed(4)}` : '—') },
          { key: 'latency', label: t(locale, 'ai_llm_col_latency'), render: (u) => `${u.latencyMs}ms` },
          { key: 'result', label: t(locale, 'ai_llm_col_result'), render: (u) => badge(u.success ? t(locale, 'ai_llm_result_ok') : (u.errorMessage || t(locale, 'ai_llm_result_failed')), u.success ? 'green' : 'red') },
          { key: 'when', label: t(locale, 'ai_col_when'), render: (u) => new Date(u.createdAt).toLocaleString() },
        ],
        usage.slice(0, 20),
      ));
    }
  }

  await Promise.all([loadAgents(), loadPolicies(), loadMemory(), loadLlm()]);
}
