import { el, clear, toast, errorBanner, selectInput, icon, table, badge } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

// require_approval and ai_decide are workflow-only meta-actions (the
// former pauses a run for a human decision, the latter hands a subject to
// a specialized agent) — neither is something the AI itself "performs" as
// a chosen action, so both are left out of the policy list here.
const AI_ACTION_TYPES = ['create_task', 'create_lead', 'send_message', 'update_lead_status', 'assign_lead_owner', 'update_campaign_status', 'webhook_call', 'integration_call'];
const AUTONOMY_LEVELS = [
  { value: 'suggest_only', label: 'Suggest only — never executes' },
  { value: 'require_approval', label: 'Require approval (default)' },
  { value: 'auto_execute', label: 'Auto-execute' },
];

export async function renderAi(container) {
  clear(container);
  const locale = getLocale();
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, t(locale, 'page_title_ai')),
      el('p', { class: 'page-subtitle' }, 'Every action here — whether suggested, auto-executed, or paused for approval — passes through the same permission, policy, approval, and audit systems as the Automation Engine. AI never bypasses them.'),
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
        el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `Tools: ${tools.map((t) => t.name).join(', ') || '—'}`),
        el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `Escalates below ${agent.escalateBelowConfidence}% confidence`),
      ]));
    }
    agentsSlot.appendChild(cards);

    // ---- Run a decision on demand ----
    const agentSelect = selectInput(agents.map((a) => ({ value: a.key, label: a.name })));
    const subjectInput = el('input', { type: 'text', placeholder: `${agents[0]?.subjectType || 'subject'} id` });
    const runBtn = el('button', { class: 'primary' }, 'Run decision');

    agentSelect.addEventListener('change', () => {
      const agent = agents.find((a) => a.key === agentSelect.value);
      subjectInput.placeholder = `${agent?.subjectType || 'subject'} id`;
    });

    runBtn.addEventListener('click', async () => {
      if (!subjectInput.value.trim()) return;
      runBtn.disabled = true;
      try {
        const decision = await api.post(`/api/ai/agents/${agentSelect.value}/decide`, { subjectId: subjectInput.value.trim() });
        toast(`[${decision.status}, ${decision.confidence}% confidence] ${decision.reasoning}`, decision.status === 'escalated' ? 'info' : 'success');
      } catch (err) {
        errorSlot.appendChild(errorBanner(err.message));
      } finally {
        runBtn.disabled = false;
      }
    });

    agentsSlot.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, 'Run a decision on demand'),
      el('div', { class: 'form-row', style: 'align-items:flex-end' }, [
        el('div', {}, [el('label', {}, 'Agent'), agentSelect]),
        el('div', {}, [el('label', {}, 'Subject id'), subjectInput]),
        runBtn,
      ]),
      el('p', { class: 'page-subtitle', style: 'margin-top:8px' }, ['See the outcome in ', el('a', { href: '#/ai-activity' }, 'AI Activity'), '.']),
    ]));
  }

  // ---- Policies ----
  const policiesSlot = el('div', { class: 'card' });
  container.appendChild(policiesSlot);

  async function loadPolicies() {
    clear(policiesSlot);
    policiesSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Autonomy policy per action type'));
    policiesSlot.appendChild(el('p', { class: 'page-subtitle' }, 'An action type with no policy set defaults to "require approval" — the AI can never auto-execute an action a company hasn\'t explicitly opted into.'));
    let current = [];
    try {
      current = await api.get('/api/ai/policies');
    } catch (err) {
      policiesSlot.appendChild(errorBanner(err.message));
      return;
    }
    const rows = AI_ACTION_TYPES.map((actionType) => {
      const existing = current.find((p) => p.actionType === actionType);
      const select = selectInput(AUTONOMY_LEVELS);
      select.value = existing?.autonomyLevel || 'require_approval';
      // Guardrails: only ever escalate an 'auto_execute' policy to require
      // approval (a violation forces the require_approval branch server-
      // side) — never loosen a stricter setting. Left blank = no limit.
      const maxAmountInput = el('input', { type: 'number', min: '0', placeholder: 'no limit', value: existing?.maxFinancialAmount ?? '' });
      const channelsInput = el('input', { type: 'text', placeholder: 'e.g. whatsapp,email (any if blank)', value: (existing?.allowedChannels || []).join(',') });
      const hoursStartInput = el('input', { type: 'time', value: existing?.workingHoursStart ?? '' });
      const hoursEndInput = el('input', { type: 'time', value: existing?.workingHoursEnd ?? '' });
      const saveBtn = el('button', { class: 'primary' }, 'Save');
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
          toast(`Policy for "${actionType}" saved.`, 'success');
        } catch (err) {
          errorSlot.appendChild(errorBanner(err.message));
        } finally {
          saveBtn.disabled = false;
        }
      });
      return el('div', { class: 'form-row', style: 'align-items:flex-end;flex-wrap:wrap' }, [
        el('div', {}, [el('label', {}, actionType), select]),
        el('div', {}, [el('label', {}, 'Max amount'), maxAmountInput]),
        el('div', {}, [el('label', {}, 'Allowed channels'), channelsInput]),
        el('div', {}, [el('label', {}, 'Hours from'), hoursStartInput]),
        el('div', {}, [el('label', {}, 'Hours to'), hoursEndInput]),
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
    memorySlot.appendChild(el('h3', { style: 'margin-top:0' }, 'AI Memory'));
    memorySlot.appendChild(el('p', { class: 'page-subtitle' }, 'What the AI layer has stored and can recall — every entry is data the AI reads, never an instruction it obeys. Invalidate anything wrong or stale.'));

    const categorySelect = selectInput([
      { value: '', label: 'All categories' },
      ...['working', 'short_term', 'long_term', 'customer', 'lead', 'agent', 'company', 'workflow'].map((c) => ({ value: c, label: c })),
    ]);
    categorySelect.value = filter.category || '';
    const queryInput = el('input', { type: 'text', placeholder: 'search text', value: filter.query || '' });
    const searchBtn = el('button', { class: 'primary' }, 'Search');
    const filterRow = el('div', { class: 'form-row', style: 'align-items:flex-end' }, [
      el('div', {}, [el('label', {}, 'Category'), categorySelect]),
      el('div', {}, [el('label', {}, 'Search'), queryInput]),
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
      resultsSlot.appendChild(el('p', { class: 'page-subtitle' }, 'No memory entries match.'));
      return;
    }
    for (const m of memories) {
      const invalidateBtn = el('button', {}, m.invalidatedAt ? 'Invalidated' : 'Invalidate');
      invalidateBtn.disabled = !!m.invalidatedAt;
      invalidateBtn.addEventListener('click', async () => {
        invalidateBtn.disabled = true;
        try {
          await api.post(`/api/ai/memory/${m.id}/invalidate`, {});
          toast('Memory entry invalidated.', 'success');
          invalidateBtn.textContent = 'Invalidated';
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
        el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `confidence ${m.confidence}% · source ${m.source?.type} · ${new Date(m.createdAt).toLocaleString()}`),
      ]));
    }
  }

  // ---- LLM settings ----
  const llmSlot = el('div', { class: 'card' });
  container.appendChild(llmSlot);

  async function loadLlm() {
    clear(llmSlot);
    llmSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'LLM Providers'));
    llmSlot.appendChild(el('p', { class: 'page-subtitle' }, 'No external AI API is configured until a provider is added here. Every AI decision above stays fully deterministic (rule-based, reading real ACTIVE data) either way — a configured LLM is a future reasoning layer, not a requirement.'));

    let configs = [];
    try {
      configs = await api.get('/api/ai/llm/config');
    } catch (err) {
      llmSlot.appendChild(errorBanner(err.message));
      return;
    }

    if (configs.length === 0) {
      llmSlot.appendChild(el('p', { class: 'page-subtitle' }, 'No LLM provider configured.'));
    } else {
      for (const c of configs) {
        const deactivateBtn = el('button', {}, c.isActive ? 'Deactivate' : 'Inactive');
        deactivateBtn.disabled = !c.isActive;
        deactivateBtn.addEventListener('click', async () => {
          deactivateBtn.disabled = true;
          try {
            await api.post(`/api/ai/llm/config/${c.id}/deactivate`, {});
            toast('Provider deactivated.', 'success');
            loadLlm();
          } catch (err) {
            errorSlot.appendChild(errorBanner(err.message));
            deactivateBtn.disabled = false;
          }
        });
        llmSlot.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)' }, [
          el('div', {}, [
            el('strong', {}, c.displayName),
            el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `${c.provider} · ${c.model} · ${c.isActive ? 'active' : 'inactive'}${c.dailyTokenBudget ? ` · budget ${c.dailyTokenBudget} tokens/day` : ''}`),
          ]),
          deactivateBtn,
        ]));
      }
    }

    const providerSelect = selectInput([
      { value: 'openai_compatible', label: 'OpenAI-compatible' },
      { value: 'anthropic_compatible', label: 'Anthropic-compatible' },
    ]);
    const nameInput = el('input', { type: 'text', placeholder: 'Display name' });
    const modelInput = el('input', { type: 'text', placeholder: 'Model (e.g. gpt-4o-mini)' });
    const baseUrlInput = el('input', { type: 'text', placeholder: 'Base URL (e.g. https://api.openai.com/v1)' });
    const apiKeyInput = el('input', { type: 'password', placeholder: 'API key (stored encrypted, never shown again)' });
    const budgetInput = el('input', { type: 'number', min: '0', placeholder: 'Daily token budget (optional)' });
    const addBtn = el('button', { class: 'primary' }, 'Add provider');
    addBtn.addEventListener('click', async () => {
      if (!nameInput.value.trim() || !modelInput.value.trim() || !baseUrlInput.value.trim() || !apiKeyInput.value.trim()) {
        toast('Display name, model, base URL, and API key are required.', 'error');
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
        toast('LLM provider saved.', 'success');
        loadLlm();
      } catch (err) {
        errorSlot.appendChild(errorBanner(err.message));
      } finally {
        addBtn.disabled = false;
      }
    });
    llmSlot.appendChild(el('div', { class: 'form-row', style: 'align-items:flex-end;flex-wrap:wrap;margin-top:12px' }, [
      el('div', {}, [el('label', {}, 'Provider'), providerSelect]),
      el('div', {}, [el('label', {}, 'Name'), nameInput]),
      el('div', {}, [el('label', {}, 'Model'), modelInput]),
      el('div', {}, [el('label', {}, 'Base URL'), baseUrlInput]),
      el('div', {}, [el('label', {}, 'API key'), apiKeyInput]),
      el('div', {}, [el('label', {}, 'Daily budget'), budgetInput]),
      addBtn,
    ]));

    let usage = [];
    try {
      usage = (await api.get('/api/ai/llm/usage')).items || [];
    } catch { /* non-fatal */ }
    if (usage.length > 0) {
      llmSlot.appendChild(el('h4', {}, 'Recent usage'));
      llmSlot.appendChild(table(
        [
          { key: 'model', label: 'Model' },
          { key: 'purpose', label: 'Purpose' },
          { key: 'totalTokens', label: 'Tokens' },
          { key: 'cost', label: 'Cost', render: (u) => (u.costEstimateUsd !== undefined ? `$${u.costEstimateUsd.toFixed(4)}` : '—') },
          { key: 'latency', label: 'Latency', render: (u) => `${u.latencyMs}ms` },
          { key: 'result', label: 'Result', render: (u) => badge(u.success ? 'ok' : (u.errorMessage || 'failed'), u.success ? 'green' : 'red') },
          { key: 'when', label: 'When', render: (u) => new Date(u.createdAt).toLocaleString() },
        ],
        usage.slice(0, 20),
      ));
    }
  }

  await Promise.all([loadAgents(), loadPolicies(), loadMemory(), loadLlm()]);
}
