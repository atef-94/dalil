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

export function confirmAction(message) {
  return window.confirm(message);
}
