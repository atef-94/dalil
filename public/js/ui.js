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
  return el('div', { class: 'error-banner' }, message);
}

export function loadingState(message = 'Loading…') {
  return el('div', { class: 'empty-state' }, message);
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

export function table(columns, rows, { empty = 'No records yet.' } = {}) {
  if (!rows || rows.length === 0) {
    return el('div', { class: 'empty-state' }, empty);
  }
  const thead = el('thead', {}, el('tr', {}, columns.map((c) => el('th', {}, c.label))));
  const tbody = el('tbody', {}, rows.map((row) =>
    el('tr', {}, columns.map((c) => el('td', {}, c.render ? c.render(row) : String(row[c.key] ?? ''))))
  ));
  return el('table', {}, [thead, tbody]);
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

export function paginationControls(page, onChange) {
  const hasPrev = page.offset > 0;
  const hasNext = page.offset + page.limit < page.total;
  return el('div', { class: 'pagination' }, [
    el('span', {}, `${page.total === 0 ? 0 : page.offset + 1}–${Math.min(page.offset + page.limit, page.total)} of ${page.total}`),
    el('button', { disabled: !hasPrev, onclick: () => onChange(Math.max(0, page.offset - page.limit)) }, '‹ Prev'),
    el('button', { disabled: !hasNext, onclick: () => onChange(page.offset + page.limit) }, 'Next ›'),
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

/** Promise-based replacement for window.confirm — styled, keyboard/overlay
 * dismissible, never blocks the whole browser tab. */
export function confirmModal(message, { confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
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
export function formModal({ title, fields, submitLabel = 'Submit', cancelLabel = 'Cancel' }) {
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
