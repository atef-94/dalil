import { el, clear, table, toast, errorBanner, statusBadge, paginationControls, loadingState } from '../ui.js';
import { api } from '../api.js';

export async function renderUnits(container) {
  clear(container);
  let offset = 0;
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, 'Inventory')));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const projectInput = el('input', { type: 'text', placeholder: 'proj-1' });
  const codeInput = el('input', { type: 'text', placeholder: 'A-101' });
  const typeInput = el('input', { type: 'text', placeholder: 'apartment' });
  const areaInput = el('input', { type: 'number', placeholder: '120' });
  const priceInput = el('input', { type: 'number', placeholder: '1500000' });
  const createBtn = el('button', { class: 'primary' }, 'Add unit');

  createBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!projectInput.value.trim() || !codeInput.value.trim() || !typeInput.value.trim() || !(Number(areaInput.value) > 0) || !(Number(priceInput.value) > 0)) {
      errorSlot.appendChild(errorBanner('Fill in project, code, type, and a positive area and price.'));
      return;
    }
    createBtn.disabled = true;
    try {
      await api.post('/api/inventory/units', {
        projectId: projectInput.value.trim(),
        code: codeInput.value.trim(),
        unitType: typeInput.value.trim(),
        areaSqm: Number(areaInput.value),
        listPrice: Number(priceInput.value),
      });
      [projectInput, codeInput, typeInput, areaInput, priceInput].forEach((i) => (i.value = ''));
      toast('Unit added.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Add a unit'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Project ID'), projectInput]),
      el('div', {}, [el('label', {}, 'Unit code'), codeInput]),
      el('div', {}, [el('label', {}, 'Type'), typeInput]),
      el('div', {}, [el('label', {}, 'Area (sqm)'), areaInput]),
      el('div', {}, [el('label', {}, 'List price'), priceInput]),
    ]),
    el('div', { class: 'form-actions' }, [createBtn]),
  ]));

  const listSlot = el('div');
  container.appendChild(listSlot);

  async function hold(unit, btn) {
    try {
      await api.post(`/api/inventory/units/${unit.id}/hold`, {});
      toast('Unit held for 15 minutes.', 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/inventory/units', { limit: 20, offset });
      clear(listSlot);
      listSlot.append(table(
        [
          { label: 'Code', key: 'code' },
          { label: 'Project', key: 'projectId' },
          { label: 'Type', key: 'unitType' },
          { label: 'Area', render: (u) => `${u.areaSqm} m²` },
          { label: 'Price', render: (u) => Number(u.listPrice).toLocaleString() },
          { label: 'Status', render: (u) => statusBadge(u.status) },
          { label: '', render: (u) => {
            if (u.status !== 'available') return '';
            const btn = el('button', {}, 'Hold');
            btn.addEventListener('click', () => {
              btn.disabled = true;
              hold(u, btn);
            });
            return btn;
          } },
        ],
        page.items,
        { empty: 'No units yet — add one above.' },
      ), paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
