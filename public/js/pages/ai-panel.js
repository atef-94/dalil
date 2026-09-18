import { el, clear, icon } from '../ui.js';
import { api } from '../api.js';
import { can } from '../state.js';

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
  addMessage(messagesEl, 'Looking at today\'s scored leads…', { role: 'assistant' });
  try {
    const scores = await api.get('/api/analytics/lead-scores');
    const top = [...scores].sort((a, b) => b.score - a.score).slice(0, 5);
    if (top.length === 0) {
      addMessage(messagesEl, 'No active leads to score right now.');
      return;
    }
    const lines = top.map((s, i) => `${i + 1}. Lead ${s.leadId.slice(0, 8)}… — score ${s.score}/100`);
    addMessage(messagesEl, `Hottest leads right now:\n${lines.join('\n')}`);
  } catch (err) {
    addMessage(messagesEl, err.message, { error: true });
  }
}

async function suggestNextActionForContext(messagesEl) {
  if (!context) {
    addMessage(messagesEl, 'Open a lead in the CRM first, then ask me to suggest a next action for it.');
    return;
  }
  addMessage(messagesEl, `Thinking about ${context.label}…`);
  try {
    const decision = await api.post(`/api/crm/leads/${context.leadId}/suggest-next-action`, {});
    const prefix = `[${decision.confidence}% confidence] `;
    if (decision.status === 'no_action') {
      addMessage(messagesEl, `${prefix}${decision.reasoning}`);
    } else if (decision.status === 'escalated') {
      addMessage(messagesEl, `${prefix}I'm escalating this to a human — ${decision.reasoning}`);
    } else if (decision.resultActionStatus === 'executed') {
      addMessage(messagesEl, `${prefix}Done — ${decision.reasoning}`);
    } else if (decision.resultActionStatus === 'pending_approval') {
      addMessage(messagesEl, `${prefix}${decision.reasoning} — this needs a human approval first (see the Approvals page).`);
    } else {
      addMessage(messagesEl, `${prefix}${decision.reasoning}`);
    }
  } catch (err) {
    addMessage(messagesEl, err.message, { error: true });
  }
}

async function moveContextToStage(messagesEl, stageQuery) {
  if (!context) {
    addMessage(messagesEl, 'Open a lead in the CRM first, then ask me to move it to a stage.');
    return;
  }
  try {
    const stages = await api.get('/api/crm/stages');
    const needle = stageQuery.trim().toLowerCase();
    const stage = stages.find((s) => s.name.toLowerCase() === needle || s.key.toLowerCase() === needle || s.name.toLowerCase().includes(needle));
    if (!stage) {
      addMessage(messagesEl, `I couldn't find a CRM stage matching "${stageQuery}". Check the stage names on the CRM page.`, { error: true });
      return;
    }
    if (stage.isLost) {
      addMessage(messagesEl, `"${stage.name}" requires a lost reason — please use the "Mark lost" action on the lead's row in the CRM instead so you can record why.`);
      return;
    }
    await api.patch(`/api/crm/leads/${context.leadId}/stage`, { stageId: stage.id });
    addMessage(messagesEl, `Moved ${context.label} to "${stage.name}".`);
  } catch (err) {
    addMessage(messagesEl, err.message, { error: true });
  }
}

async function summarizeContext(messagesEl) {
  if (!context) {
    addMessage(messagesEl, 'Open a lead in the CRM first, then ask me to summarize it.');
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
      score ? `Priority score: ${score.score}/100 (${score.factors.map((f) => f.label).join(', ') || 'no positive signals yet'})` : null,
      `${timeline.entries.length} recorded activity ${timeline.entries.length === 1 ? 'entry' : 'entries'}`,
    ].filter(Boolean);
    const last = timeline.entries[timeline.entries.length - 1];
    if (last) lines.push(`Most recent: ${last.summary} (${new Date(last.at).toLocaleString()})`);
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
    'I can: summarize the open lead, suggest its next action, move it to a stage ("move to Contacted"), or show today\'s hot leads. Every action still goes through the same permissions and approval rules as the CRM and AI pages.',
  );
}

export function mountAiAssistant() {
  if (!can('ai_action', 'view') && !can('ai_action', 'create')) return; // no AI grant at all — nothing to mount

  const toggle = el('button', { class: 'ai-dock-toggle', 'aria-label': 'AI Assistant' }, icon('ai'));
  let panel = null;
  let messagesEl = null;
  let contextEl = null;

  function renderContext() {
    if (!contextEl) return;
    clear(contextEl);
    contextEl.textContent = context ? `Context: ${context.label}` : 'No lead open — I\'ll answer generally.';
  }
  refreshContextUi = renderContext;

  function openPanel() {
    if (panel) return;
    messagesEl = el('div', { class: 'ai-dock-messages' });
    contextEl = el('div', { class: 'ai-dock-context' }, '');
    renderContext();

    const closeBtn = el('button', { class: 'icon-btn ghost', 'aria-label': 'Close' }, icon('close'));
    closeBtn.addEventListener('click', closePanel);

    const quickActions = el('div', { class: 'ai-dock-quick-actions' }, [
      quickActionButton('Suggest next action', () => suggestNextActionForContext(messagesEl)),
      quickActionButton('Summarize lead', () => summarizeContext(messagesEl)),
      quickActionButton('Hot leads today', () => showTodaysHotLeads(messagesEl)),
    ]);

    const input = el('input', { type: 'text', placeholder: 'Ask the assistant, or type a command…' });
    const sendBtn = el('button', { class: 'primary' }, 'Send');
    async function send() {
      const value = input.value;
      input.value = '';
      await handleCommand(messagesEl, value);
    }
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

    panel = el('div', { class: 'ai-dock' }, [
      el('div', { class: 'ai-dock-header' }, [
        el('strong', {}, [icon('ai'), 'AI Assistant']),
        closeBtn,
      ]),
      contextEl,
      quickActions,
      messagesEl,
      el('div', { class: 'ai-dock-input-row' }, [input, sendBtn]),
    ]);
    document.body.appendChild(panel);
    addMessage(messagesEl, 'Hi — I can summarize a lead, suggest its next action, move it between CRM stages, or show today\'s hottest leads. Open a lead in the CRM for lead-specific help.');
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
