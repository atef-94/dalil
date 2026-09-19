import { t } from './i18n.js';
import { getLocale } from './state.js';

const tt = (key) => t(getLocale(), key);

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== undefined && value !== null && value !== false) {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === undefined || child === null || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) {
  node.innerHTML = '';
}

// ---- Icons (inline SVG, no external icon-font dependency) ----
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  leads: '<circle cx="12" cy="8" r="3.4"/><path d="M5 20c0-4.5 3.5-7 7-7s7 2.5 7 7"/>',
  opportunities: '<path d="M4 4h16l-6 8v6l-4 2v-8z"/>',
  units: '<rect x="4" y="9" width="16" height="12" rx="1"/><path d="M8 9V5a4 4 0 0 1 8 0v4"/>',
  templates: '<rect x="5" y="3" width="14" height="18" rx="1.5"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/>',
  quotations: '<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M8 8h8M8 12h5" /><path d="M9 16l1.5 1.5L14 14"/>',
  finance: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
  brokers: '<circle cx="9" cy="12" r="5"/><circle cx="15" cy="12" r="5" opacity="0.5"/>',
  commissions: '<circle cx="12" cy="12" r="9"/><path d="M9.5 15.5c0 1 1 1.8 2.5 1.8s2.5-.8 2.5-1.8-1-1.5-2.5-1.9-2.5-.9-2.5-1.9 1-1.8 2.5-1.8 2.5.8 2.5 1.8"/><line x1="12" y1="6.5" x2="12" y2="8" /><line x1="12" y1="16" x2="12" y2="17.5"/>',
  marketing: '<path d="M3 10v4h3l6 4V6l-6 4z"/><path d="M16 9a4 4 0 0 1 0 6"/>',
  operations: '<rect x="3" y="7" width="18" height="10" rx="2"/><line x1="9" y1="7" x2="9" y2="17" stroke-dasharray="2 2"/>',
  legal: '<path d="M4 4h7v16H4z"/><path d="M13 4h7v16h-7z"/><line x1="12" y1="4" x2="12" y2="20"/>',
  purchasing: '<path d="M3 7l2-4h14l2 4"/><path d="M3 7h18v13H3z"/><line x1="3" y1="7" x2="21" y2="7"/>',
  communication: '<path d="M4 4h16v12H8l-4 4z"/>',
  analytics: '<line x1="4" y1="20" x2="20" y2="20"/><rect x="6" y="13" width="3" height="7"/><rect x="11" y="9" width="3" height="11"/><rect x="16" y="5" width="3" height="15"/>',
  forecasting: '<path d="M4 17l4-5 4 3 5-7 3 3"/><line x1="4" y1="20" x2="20" y2="20"/>',
  scenario: '<path d="M4 18l5-9 5 5 6-11"/><circle cx="9" cy="9" r="1.4"/><circle cx="14" cy="14" r="1.4"/><circle cx="20" cy="3" r="1.4"/>',
  automation: '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><line x1="7" y1="6" x2="17" y2="6"/><line x1="6.4" y1="7.6" x2="10.8" y2="16.4"/><line x1="17.6" y1="7.6" x2="13.2" y2="16.4"/>',
  ai: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  integrations: '<path d="M9 3v6M15 3v6"/><path d="M6 9h12v4a6 6 0 0 1-12 0z"/><path d="M12 19v3"/>',
  employees: '<circle cx="8" cy="8" r="3"/><path d="M2 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M14.5 20c.3-2.6 2-4.6 4-4.6s3.6 1.8 4 4.2" opacity="0.6"/>',
  hr: '<rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/>',
  roles: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  audit: '<rect x="6" y="4" width="12" height="17" rx="1.5"/><rect x="9" y="2.5" width="6" height="3" rx="1"/><path d="M9 13l2 2 4-4"/>',
  customers: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="11" r="2"/><path d="M6 16c0-1.7 1.2-3 2.5-3s2.5 1.3 2.5 3"/><line x1="14" y1="9" x2="18" y2="9"/><line x1="14" y1="13" x2="18" y2="13"/>',
  contracts: '<rect x="5" y="3" width="13" height="18" rx="1.5"/><line x1="8" y1="8" x2="15" y2="8"/><line x1="8" y1="12" x2="15" y2="12"/><path d="M8 16l2 2 5-5"/>',
  reservations: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2"/><path d="M9 3h6"/>',
  branches: '<circle cx="12" cy="4" r="2"/><line x1="12" y1="6" x2="12" y2="11"/><line x1="6" y1="11" x2="18" y2="11"/><line x1="6" y1="11" x2="6" y2="16"/><line x1="18" y1="11" x2="18" y2="16"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
  approvals: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
  history: '<path d="M4 12a8 8 0 1 1 2.6 6"/><polyline points="2 16 3 20 7 19"/><path d="M12 8v4l3 2"/>',
  settings: '<line x1="4" y1="7" x2="20" y2="7"/><circle cx="9" cy="7" r="1.8"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="1.8"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="11" cy="17" r="1.8"/>',
  portal: '<path d="M4 13a8 8 0 1 1 16 0v4"/><rect x="3" y="13" width="4" height="6" rx="1.5"/><rect x="17" y="13" width="4" height="6" rx="1.5"/>',
  menu: '<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/>',
  close: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
  chevronRight: '<polyline points="9 6 15 12 9 18"/>',
  bell: '<path d="M6 10a6 6 0 1 1 12 0v4l2 3H4l2-3z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.5" y1="15.5" x2="20" y2="20"/>',
  filter: '<line x1="4" y1="5" x2="20" y2="5"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="10" y1="19" x2="14" y2="19"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  warning: '<path d="M12 3l9 16H3z"/><line x1="12" y1="10" x2="12" y2="14"/>',
  lock: '<rect x="6" y="11" width="12" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  inbox: '<path d="M4 12h4l2 3h4l2-3h4"/><path d="M4 12l1.5-7h13L20 12"/><rect x="4" y="12" width="16" height="7" rx="1.5"/>',
};

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon ${cls}`.trim());
  svg.innerHTML = ICONS[name] || ICONS.settings;
  return svg;
}

export function toast(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = el('div', { id: 'toast-container', class: 'toast-container' });
    document.body.appendChild(container);
  }
  const node = el('div', { class: `toast ${type}` }, message);
  container.appendChild(node);
  setTimeout(() => node.remove(), 4000);
}

export function errorBanner(message) {
  return el('div', { class: 'error-banner' }, [icon('warning', 'sm'), el('span', {}, message)]);
}

export function loadingState() {
  const wrap = el('div', {}, []);
  for (let i = 0; i < 4; i++) {
    wrap.appendChild(el('div', { class: 'skeleton-row' }, [
      el('div', { class: 'skeleton-block', style: 'width:32px;height:32px;border-radius:8px' }),
      el('div', { style: 'flex:1;display:flex;flex-direction:column;gap:6px;justify-content:center' }, [
        el('div', { class: 'skeleton-block', style: `height:10px;width:${70 - i * 8}%` }),
        el('div', { class: 'skeleton-block', style: `height:9px;width:${40 - i * 4}%` }),
      ]),
    ]));
  }
  return wrap;
}

/** Richer empty state: an icon, a short title, an optional hint, and an
 * optional primary action button — replaces bare "No records yet" text. */
export function emptyState({ icon: iconName = 'inbox', title, hint, actionLabel, onAction } = {}) {
  const children = [icon(iconName, 'lg'), el('div', { class: 'empty-title' }, title || tt('common_nothing_here'))];
  if (hint) children.push(el('div', { class: 'empty-hint' }, hint));
  if (actionLabel && onAction) {
    const btn = el('button', { class: 'primary' }, actionLabel);
    btn.addEventListener('click', onAction);
    children.push(el('div', { style: 'margin-top:4px' }, btn));
  }
  return el('div', { class: 'empty-state' }, children);
}

/** Shown in place of a page/section a user's RBAC grants don't allow. */
export function deniedState(message = tt('common_no_permission')) {
  return el('div', { class: 'denied-state' }, [
    icon('lock', 'lg'),
    el('div', { class: 'denied-title' }, tt('common_access_restricted')),
    el('div', {}, message),
  ]);
}

/** A row of tabs. `items`: {key, label}[]. Calls onSelect(key) and re-renders
 * the active state itself — the caller just swaps the panel content. */
export function tabs(items, activeKey, onSelect) {
  const wrap = el('div', { class: 'tabs' });
  const render = (active) => {
    clear(wrap);
    for (const item of items) {
      const btn = el('button', { class: `tab${item.key === active ? ' active' : ''}` }, item.label);
      btn.addEventListener('click', () => {
        if (item.key !== active) onSelect(item.key);
        render(item.key);
      });
      wrap.appendChild(btn);
    }
  };
  render(activeKey);
  return wrap;
}

/** A KPI stat card with an optional icon and trend indicator. */
export function statCard({ label, value, iconName, trend }) {
  const top = el('div', { class: 'stat-top' }, [
    el('div', { class: 'value' }, String(value)),
    iconName ? el('div', { class: 'icon-wrap' }, icon(iconName)) : null,
  ]);
  const children = [top, el('div', { class: 'label' }, label)];
  if (trend) children.push(el('div', { class: `trend ${trend.direction || ''}` }, trend.text));
  return el('div', { class: 'stat-card' }, children);
}

/** A minimal, dependency-free bar chart. data: {label, value}[]. */
export function barChart(data, { max } = {}) {
  const peak = max ?? Math.max(1, ...data.map((d) => d.value));
  return el('div', { class: 'bar-chart' }, data.map((d) =>
    el('div', { class: 'bar-col' }, [
      el('div', { class: 'bar-value' }, String(d.value)),
      el('div', { class: `bar${d.muted ? ' muted' : ''}`, style: `height:${Math.max(2, Math.round((d.value / peak) * 100))}%` }),
      el('div', { class: 'bar-label' }, d.label),
    ]),
  ));
}

export function badge(text, color = '') {
  return el('span', { class: `badge ${color}` }, text);
}

const STATUS_COLORS = {
  active: 'green', approved: 'green', paid: 'green', won: 'green', signed: 'green', converted: 'green',
  pending: 'amber', upcoming: 'amber', held: 'amber', reserved: 'amber', pending_approval: 'amber', new: 'blue', open: 'blue',
  overdue: 'red', lost: 'red', rejected: 'red', cancelled: 'red', suspended: 'red', terminated: 'red', rejected_duplicate: 'red', rejected_other: 'red',
};
export function statusBadge(status) {
  return badge(status, STATUS_COLORS[status] || '');
}

export function table(columns, rows, { empty = tt('common_no_records'), emptyIcon = 'inbox' } = {}) {
  if (!rows || rows.length === 0) {
    return emptyState({ icon: emptyIcon, title: empty });
  }
  const thead = el('thead', {}, el('tr', {}, columns.map((c) => el('th', {}, c.label))));
  const tbody = el('tbody', {}, rows.map((row) =>
    el('tr', {}, columns.map((c) => el('td', {}, c.render ? c.render(row) : String(row[c.key] ?? ''))))
  ));
  return el('div', { class: 'table-wrap' }, el('table', {}, [thead, tbody]));
}

export function field(labelText, inputNode) {
  return el('div', {}, [el('label', {}, labelText), inputNode]);
}

export function textInput(props = {}) {
  return el('input', { type: 'text', ...props });
}

export function selectInput(options, props = {}) {
  return el('select', props, options.map((o) =>
    el('option', { value: o.value }, o.label)
  ));
}

/** A debounced search box — calls onSearch(trimmedValue) ~300ms after the
 * user stops typing, not on every keystroke. Callers own resetting their
 * own offset/state and re-fetching; this only owns the input's own timing. */
export function searchInput(placeholder, onSearch, { debounceMs = 300 } = {}) {
  const input = el('input', { type: 'text', placeholder });
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => onSearch(input.value.trim()), debounceMs);
  });
  return input;
}

export function paginationControls(page, onChange) {
  const hasPrev = page.offset > 0;
  const hasNext = page.offset + page.limit < page.total;
  return el('div', { class: 'pagination' }, [
    el('span', {}, `${page.total === 0 ? 0 : page.offset + 1}–${Math.min(page.offset + page.limit, page.total)} ${tt('common_of')} ${page.total}`),
    el('button', { disabled: !hasPrev, onclick: () => onChange(Math.max(0, page.offset - page.limit)) }, tt('common_prev')),
    el('button', { disabled: !hasNext, onclick: () => onChange(page.offset + page.limit) }, tt('common_next')),
  ]);
}

// ---- Modal system (replaces window.prompt/confirm with real in-app UI) ----

function openModalShell(titleText, bodyNode) {
  const overlay = el('div', { class: 'modal-overlay' });
  const card = el('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true' }, [
    el('h3', { class: 'modal-title' }, titleText),
    bodyNode,
  ]);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
  }
  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKeydown);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  return { overlay, card, close };
}

/** Opens a modal around arbitrary read-only content (e.g. a detail/summary
 * view) using the exact same shell confirmModal/formModal use — for pages
 * that need more than a yes/no or a form. Returns { close }; the caller
 * builds and appends its own content to the returned card body region via
 * bodyNode, which it constructs before calling this. */
export function contentModal(title, bodyNode, { wide = false } = {}) {
  const { card, close } = openModalShell(title, bodyNode);
  if (wide) card.classList.add('wide');
  const closeBtn = el('button', { class: 'modal-close', 'aria-label': tt('common_close') }, '×');
  closeBtn.addEventListener('click', close);
  card.insertBefore(closeBtn, card.firstChild);
  return { close };
}

/** Promise-based replacement for window.confirm — styled, keyboard/overlay
 * dismissible, never blocks the whole browser tab. */
export function confirmModal(message, { confirmLabel = tt('common_confirm'), cancelLabel = tt('common_cancel'), danger = false } = {}) {
  return new Promise((resolve) => {
    const body = el('div', {}, [
      el('p', { style: 'margin:0 0 18px' }, message),
    ]);
    const { close } = openModalShell('Please confirm', body);
    const cancelBtn = el('button', {}, cancelLabel);
    const confirmBtn = el('button', { class: danger ? 'danger' : 'primary' }, confirmLabel);
    cancelBtn.addEventListener('click', () => { close(); resolve(false); });
    confirmBtn.addEventListener('click', () => { close(); resolve(true); });
    body.appendChild(el('div', { class: 'form-actions', style: 'justify-content:flex-end' }, [cancelBtn, confirmBtn]));
    confirmBtn.focus();
  });
}

/**
 * Promise-based replacement for window.prompt (and for chaining several
 * prompts) — a single form with typed fields. Resolves with
 * {[fieldKey]: value} or null if dismissed/cancelled.
 *
 * fields: { key, label, type: 'text'|'number'|'select'|'textarea',
 *           options?: [{value,label}], placeholder?, value? }[]
 */
export function formModal({ title, fields, submitLabel = tt('common_submit'), cancelLabel = tt('common_cancel') }) {
  return new Promise((resolve) => {
    const inputs = {};
    const body = el('div', {});
    for (const f of fields) {
      let input;
      if (f.type === 'select') {
        input = selectInput(f.options || [], {});
        if (f.value !== undefined) input.value = f.value;
      } else if (f.type === 'textarea') {
        input = el('textarea', { rows: 3, placeholder: f.placeholder || '' });
        if (f.value !== undefined) input.value = f.value;
      } else {
        input = el('input', { type: f.type || 'text', placeholder: f.placeholder || '', value: f.value ?? '' });
      }
      inputs[f.key] = input;
      body.appendChild(field(f.label, input));
    }

    const { close } = openModalShell(title, body);
    const cancelBtn = el('button', {}, cancelLabel);
    const submitBtn = el('button', { class: 'primary' }, submitLabel);
    cancelBtn.addEventListener('click', () => { close(); resolve(null); });
    function submit() {
      const values = {};
      for (const [key, input] of Object.entries(inputs)) values[key] = input.value;
      close();
      resolve(values);
    }
    submitBtn.addEventListener('click', submit);
    body.appendChild(el('div', { class: 'form-actions', style: 'justify-content:flex-end' }, [cancelBtn, submitBtn]));

    const firstInput = Object.values(inputs)[0];
    firstInput?.focus?.();
    firstInput?.addEventListener?.('keydown', (e) => {
      if (e.key === 'Enter' && fields.length === 1) submit();
    });
  });
}
