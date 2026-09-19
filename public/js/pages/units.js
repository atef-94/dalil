import { el, clear, table, toast, errorBanner, statusBadge, paginationControls, loadingState, searchInput } from '../ui.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { can, getLocale } from '../state.js';
import { openImportWizard } from '../import-wizard.js';

export async function renderUnits(container) {
  clear(container);
  const locale = getLocale();
  let offset = 0;
  let q = '';
  const headerActions = el('div');
  container.appendChild(el('div', { class: 'page-header' }, [el('h1', {}, t(locale, 'page_title_units')), headerActions]));
  if (can('unit', 'create')) {
    const importBtn = el('button', {}, 'Import Units');
    importBtn.addEventListener('click', () => {
      openImportWizard({
        title: 'Import Units',
        uploadPath: '/api/inventory/units/import/upload',
        onImported: () => { load(); loadImportHistory(); },
      });
    });
    headerActions.appendChild(importBtn);
  }
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const newProjectNameInput = el('input', { type: 'text', placeholder: 'e.g. Marina Towers' });
  const newProjectLocationInput = el('input', { type: 'text', placeholder: 'e.g. North Coast (optional)' });
  const addProjectBtn = el('button', {}, 'Add project');
  addProjectBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!newProjectNameInput.value.trim()) {
      errorSlot.appendChild(errorBanner('Enter a project name.'));
      return;
    }
    addProjectBtn.disabled = true;
    try {
      const project = await api.post('/api/inventory/projects', {
        name: newProjectNameInput.value.trim(),
        location: newProjectLocationInput.value.trim() || undefined,
      });
      newProjectNameInput.value = '';
      newProjectLocationInput.value = '';
      toast(`Project created — id: ${project.id}`, 'success');
      await loadProjects();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      addProjectBtn.disabled = false;
    }
  });

  const projectsListSlot = el('div');
  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Projects'),
    el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, 'Create a project here, then use its ID as the Project field below when adding units.'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Project name'), newProjectNameInput]),
      el('div', {}, [el('label', {}, 'Location'), newProjectLocationInput]),
      el('div', { style: 'align-self:flex-end' }, addProjectBtn),
    ]),
    projectsListSlot,
  ]));

  async function loadProjects() {
    clear(projectsListSlot);
    try {
      const page = await api.get('/api/inventory/projects', { limit: 50 });
      projectsListSlot.appendChild(table(
        [
          { label: 'Name', key: 'name' },
          { label: 'Location', render: (p) => p.location || '—' },
          { label: 'ID (paste into Project field below)', render: (p) => p.id },
        ],
        page.items,
        { empty: 'No projects yet — add one above.' },
      ));
    } catch (err) {
      projectsListSlot.appendChild(errorBanner(err.message));
    }
  }

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

  const search = searchInput('Search by code or type…', (value) => { q = value; offset = 0; load(); });
  container.appendChild(el('div', { class: 'form-row', style: 'max-width:320px' }, [search]));

  const listSlot = el('div');
  container.appendChild(listSlot);

  const importHistorySlot = el('div');
  if (can('unit', 'view')) {
    container.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, 'Import History'),
      el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, 'Every Inventory Import run for this company, newest first.'),
      importHistorySlot,
    ]));
  }

  async function loadImportHistory() {
    if (!can('unit', 'view')) return;
    clear(importHistorySlot);
    try {
      const sessions = await api.get('/api/imports/history', { targetType: 'inventory_unit' });
      importHistorySlot.appendChild(table(
        [
          { label: 'File', key: 'fileName' },
          { label: 'Type', render: (s) => s.fileType.toUpperCase() },
          { label: 'Rows', render: (s) => String(s.rawRows.length) },
          { label: 'Status', render: (s) => statusBadge(s.status) },
          { label: 'Uploaded', render: (s) => new Date(s.createdAt).toLocaleString() },
        ],
        sessions,
        { empty: 'No imports yet.' },
      ));
    } catch (err) {
      importHistorySlot.appendChild(errorBanner(err.message));
    }
  }

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
    await loadProjects();
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/inventory/units', { limit: 20, offset, q });
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
  await loadImportHistory();
}
