import { el, clear, icon } from '../ui.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { can, getLocale } from '../state.js';

// The persistent AI Assistant dock — mounted once by app.js, outside the
// router's content area, so it survives every route change. It has no AI
// code of its own: every action here calls the exact same AI Execution
// Layer / Automation Engine endpoints the CRM and AI pages already use
// (POST .../suggest-next-action, GET /api/crm/stages, PATCH
// .../leads/:id/stage, GET /api/analytics/lead-scores), so permissions,
// policy, and audit are enforced identically no matter where the action
// was triggered from.

let context = null; // { leadId, label } | null — set by crm.js when a lead detail is open
let refreshContextUi = () => {};

export function setAiContext(next) {
  context = next;
  refreshContextUi();
}

export function clearAiContext() {
  setAiContext(null);
}

function addMessage(messagesEl, text, { role = 'assistant', error = false } = {}) {
  const node = el('div', { class: `ai-dock-msg ${role}${error ? ' error' : ''}` }, text);
  messagesEl.appendChild(node);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return node;
}

async function showTodaysHotLeads(messagesEl) {
  const locale = getLocale();
  addMessage(messagesEl, t(locale, 'ai_panel_looking_hot_leads'), { role: 'assistant' });
  try {
    const scores = await api.get('/api/analytics/lead-scores');
    const top = [...scores].sort((a, b) => b.score - a.score).slice(0, 5);
    if (top.length === 0) {
      addMessage(messagesEl, t(locale, 'ai_panel_no_active_leads'));
      return;
    }
    const lines = top.map((s, i) => `${i + 1}. ${t(locale, 'ai_panel_lead_word')} ${s.leadId.slice(0, 8)}… — ${t(locale, 'ai_panel_score_word')} ${s.score}/100`);
    addMessage(messagesEl, `${t(locale, 'ai_panel_hottest_leads_prefix')}\n${lines.join('\n')}`);
  } catch (err) {
    addMessage(messagesEl, err.message, { error: true });
  }
}

async function suggestNextActionForContext(messagesEl) {
  const locale = getLocale();
  if (!context) {
    addMessage(messagesEl, t(locale, 'ai_panel_open_lead_suggest'));
    return;
  }
  addMessage(messagesEl, `${t(locale, 'ai_panel_thinking_prefix')} ${context.label}${t(locale, 'ai_panel_thinking_suffix')}`);
  try {
    const decision = await api.post(`/api/crm/leads/${context.leadId}/suggest-next-action`, {});
    const prefix = `[${decision.confidence}${t(locale, 'crm_ai_confidence_suffix')}] `;
    if (decision.status === 'no_action') {
      addMessage(messagesEl, `${prefix}${decision.reasoning}`);
    } else if (decision.status === 'escalated') {
      addMessage(messagesEl, `${prefix}${t(locale, 'ai_panel_escalating_prefix')}${decision.reasoning}`);
    } else if (decision.resultActionStatus === 'executed') {
      addMessage(messagesEl, `${prefix}${t(locale, 'ai_panel_done_prefix')}${decision.reasoning}`);
    } else if (decision.resultActionStatus === 'pending_approval') {
      addMessage(messagesEl, `${prefix}${decision.reasoning}${t(locale, 'ai_panel_needs_approval_suffix')}`);
    } else {
      addMessage(messagesEl, `${prefix}${decision.reasoning}`);
    }
  } catch (err) {
    addMessage(messagesEl, err.message, { error: true });
  }
}

async function moveContextToStage(messagesEl, stageQuery) {
  const locale = getLocale();
  if (!context) {
    addMessage(messagesEl, t(locale, 'ai_panel_open_lead_move'));
    return;
  }
  try {
    const stages = await api.get('/api/crm/stages');
    const needle = stageQuery.trim().toLowerCase();
    const stage = stages.find((s) => s.name.toLowerCase() === needle || s.key.toLowerCase() === needle || s.name.toLowerCase().includes(needle));
    if (!stage) {
      addMessage(messagesEl, `${t(locale, 'ai_panel_stage_not_found_prefix')}${stageQuery}${t(locale, 'ai_panel_stage_not_found_suffix')}`, { error: true });
      return;
    }
    if (stage.isLost) {
      addMessage(messagesEl, `"${stage.name}${t(locale, 'ai_panel_stage_lost_suffix')}`);
      return;
    }
    await api.patch(`/api/crm/leads/${context.leadId}/stage`, { stageId: stage.id });
    addMessage(messagesEl, `${t(locale, 'ai_panel_moved_prefix')} ${context.label} ${t(locale, 'ai_panel_moved_mid')}${stage.name}".`);
  } catch (err) {
    addMessage(messagesEl, err.message, { error: true });
  }
}

async function summarizeContext(messagesEl) {
  const locale = getLocale();
  if (!context) {
    addMessage(messagesEl, t(locale, 'ai_panel_open_lead_summarize'));
    return;
  }
  try {
    const [timeline, score] = await Promise.all([
      api.get(`/api/crm/leads/${context.leadId}/timeline`),
      api.get(`/api/crm/leads/${context.leadId}/score`).catch(() => null),
    ]);
    const lead = timeline.lead;
    const lines = [
      `${lead.fullName} — ${lead.phone}${lead.email ? `, ${lead.email}` : ''}`,
      score ? `${t(locale, 'ai_panel_priority_score_prefix')} ${score.score}/100 (${score.factors.map((f) => f.label).join(', ') || t(locale, 'ai_panel_no_positive_signals')})` : null,
      `${timeline.entries.length} ${timeline.entries.length === 1 ? t(locale, 'ai_panel_activity_count_singular') : t(locale, 'ai_panel_activity_count_plural')}`,
    ].filter(Boolean);
    const last = timeline.entries[timeline.entries.length - 1];
    if (last) lines.push(`${t(locale, 'ai_panel_most_recent_prefix')} ${last.summary} (${new Date(last.at).toLocaleString()})`);
    addMessage(messagesEl, lines.join('\n'));
  } catch (err) {
    addMessage(messagesEl, err.message, { error: true });
  }
}

async function handleCommand(messagesEl, raw) {
  const text = raw.trim();
  if (!text) return;
  addMessage(messagesEl, text, { role: 'user' });
  const lower = text.toLowerCase();

  const moveMatch = lower.match(/^move (?:this lead )?to (.+)$/) || lower.match(/^move .* to (.+)$/);
  if (moveMatch) {
    await moveContextToStage(messagesEl, moveMatch[1]);
    return;
  }
  if (lower.includes('hot lead') || (lower.includes('today') && lower.includes('lead'))) {
    await showTodaysHotLeads(messagesEl);
    return;
  }
  if (lower.includes('summar')) {
    await summarizeContext(messagesEl);
    return;
  }
  if (lower.includes('next action') || lower.includes('suggest')) {
    await suggestNextActionForContext(messagesEl);
    return;
  }
  addMessage(
    messagesEl,
    t(getLocale(), 'ai_panel_fallback_help'),
  );
}

export function mountAiAssistant() {
  if (!can('ai_action', 'view') && !can('ai_action', 'create')) return; // no AI grant at all — nothing to mount

  const toggle = el('button', { class: 'ai-dock-toggle', 'aria-label': t(getLocale(), 'ai_panel_title') }, icon('ai'));
  let panel = null;
  let messagesEl = null;
  let contextEl = null;

  function renderContext() {
    if (!contextEl) return;
    const locale = getLocale();
    clear(contextEl);
    contextEl.textContent = context ? `${t(locale, 'ai_panel_context_prefix')} ${context.label}` : t(locale, 'ai_panel_no_lead_open');
  }
  refreshContextUi = renderContext;

  function openPanel() {
    if (panel) return;
    const locale = getLocale();
    messagesEl = el('div', { class: 'ai-dock-messages' });
    contextEl = el('div', { class: 'ai-dock-context' }, '');
    renderContext();

    const closeBtn = el('button', { class: 'icon-btn ghost', 'aria-label': t(locale, 'common_close') }, icon('close'));
    closeBtn.addEventListener('click', closePanel);

    const quickActions = el('div', { class: 'ai-dock-quick-actions' }, [
      quickActionButton(t(locale, 'ai_panel_quick_suggest'), () => suggestNextActionForContext(messagesEl)),
      quickActionButton(t(locale, 'ai_panel_quick_summarize'), () => summarizeContext(messagesEl)),
      quickActionButton(t(locale, 'ai_panel_quick_hot_leads'), () => showTodaysHotLeads(messagesEl)),
    ]);

    const input = el('input', { type: 'text', placeholder: t(locale, 'ai_panel_input_placeholder') });
    const sendBtn = el('button', { class: 'primary' }, t(locale, 'crm_send_btn'));
    async function send() {
      const value = input.value;
      input.value = '';
      await handleCommand(messagesEl, value);
    }
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

    panel = el('div', { class: 'ai-dock' }, [
      el('div', { class: 'ai-dock-header' }, [
        el('strong', {}, [icon('ai'), t(locale, 'ai_panel_title')]),
        closeBtn,
      ]),
      contextEl,
      quickActions,
      messagesEl,
      el('div', { class: 'ai-dock-input-row' }, [input, sendBtn]),
    ]);
    document.body.appendChild(panel);
    addMessage(messagesEl, t(locale, 'ai_panel_greeting'));
    input.focus();
  }

  function closePanel() {
    panel?.remove();
    panel = null;
    messagesEl = null;
    contextEl = null;
  }

  function quickActionButton(label, onClick) {
    const btn = el('button', {}, label);
    btn.addEventListener('click', () => { if (messagesEl) onClick(); });
    return btn;
  }

  toggle.addEventListener('click', () => { panel ? closePanel() : openPanel(); });
  document.body.appendChild(toggle);
}
