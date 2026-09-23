import { el, clear, table, toast, errorBanner, statusBadge, badge, paginationControls, loadingState, searchInput, selectInput, contentModal, formModal } from '../ui.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { can, getLocale } from '../state.js';
import { openImportWizard } from '../import-wizard.js';

export async function renderUnits(container) {
  clear(container);
  const locale = getLocale();
  let offset = 0;
  let q = '';
  let filters = {};
  let projects = [];
  let developers = [];
  const headerActions = el('div');
  container.appendChild(el('div', { class: 'page-header' }, [el('h1', {}, t(locale, 'page_title_units')), headerActions]));
  if (can('unit', 'create')) {
    const importBtn = el('button', {}, 'Import Units');
    importBtn.addEventListener('click', () => {
      openImportWizard({
        title: 'Import Units',
        uploadPath: '/api/inventory/units/import/upload',
        onImported: () => { load(); loadImportHistory(); },
        uploadOptions: [
          { key: 'fillDownBlankCells', label: 'My file has merged cells — repeat the value above into blank cells (e.g. a Project/Developer name shown once above a block of unit rows)', default: false },
          { key: 'sheetNameAsProject', label: 'Each sheet (tab) in this file is a different project — use the sheet name as the Project (e.g. a sheet named "Stayn" → Project "Stayn")', default: false },
        ],
        mappingOptions: [
          {
            key: 'rangeStrategy',
            type: 'select',
            label: "If a row has a range (e.g. Price From/To or BUA From/To) instead of one value, use:",
            options: [
              { value: 'avg', label: 'Average of From & To' },
              { value: 'from', label: 'The "From" value' },
              { value: 'to', label: 'The "To" value' },
            ],
            default: 'avg',
          },
          { key: 'autoGenerateUnitCode', type: 'checkbox', label: "Auto-generate a unit code for rows that don't have one", default: true },
          { key: 'autoCreateMissingProjects', type: 'checkbox', label: "Automatically create any project named in the file that doesn't exist yet", default: true },
        ],
      });
    });
    headerActions.appendChild(importBtn);
  }
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  // ---- Developers ----
  const developersListSlot = el('div');
  const newDeveloperNameInput = el('input', { type: 'text', placeholder: 'e.g. Emaar' });
  const addDeveloperBtn = el('button', {}, 'Add developer');
  addDeveloperBtn.addEventListener('click', async () => {
    if (!newDeveloperNameInput.value.trim()) return;
    addDeveloperBtn.disabled = true;
    try {
      await api.post('/api/inventory/developers', { name: newDeveloperNameInput.value.trim() });
      newDeveloperNameInput.value = '';
      toast('Developer added.', 'success');
      await loadDevelopers();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      addDeveloperBtn.disabled = false;
    }
  });
  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Developers'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Developer name'), newDeveloperNameInput]),
      el('div', { style: 'align-self:flex-end' }, addDeveloperBtn),
    ]),
    developersListSlot,
  ]));

  async function loadDevelopers() {
    clear(developersListSlot);
    try {
      const page = await api.get('/api/inventory/developers', { limit: 50 });
      developers = page.items;
      developersListSlot.appendChild(table(
        [
          { label: 'Name', key: 'name' },
          { label: '', render: (d) => {
            const btn = el('button', {}, 'Portfolio');
            btn.addEventListener('click', () => viewDeveloperPortfolio(d));
            return btn;
          } },
        ],
        developers,
        { empty: 'No developers yet — add one above.' },
      ));
    } catch (err) {
      developersListSlot.appendChild(errorBanner(err.message));
    }
  }

  async function viewDeveloperPortfolio(developer) {
    const body = el('div', {}, loadingState());
    contentModal(`${developer.name} — Portfolio`, body);
    try {
      const result = await api.get(`/api/inventory/developers/${developer.id}/portfolio`);
      clear(body);
      body.appendChild(table(
        [{ label: 'Project', key: 'name' }, { label: 'Destination', render: (p) => p.destination || '—' }],
        result.projects,
        { empty: 'No projects yet for this developer.' },
      ));
    } catch (err) {
      clear(body);
      body.appendChild(errorBanner(err.message));
    }
  }

  // ---- Projects ----
  const newProjectNameInput = el('input', { type: 'text', placeholder: 'e.g. Marina Towers' });
  const newProjectLocationInput = el('input', { type: 'text', placeholder: 'e.g. North Coast (optional)' });
  const newProjectDestinationInput = el('input', { type: 'text', placeholder: 'e.g. New Cairo' });
  const newProjectDeveloperSelect = selectInput([{ value: '', label: '— none —' }]);
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
        destination: newProjectDestinationInput.value.trim() || undefined,
        developerId: newProjectDeveloperSelect.value || undefined,
      });
      newProjectNameInput.value = '';
      newProjectLocationInput.value = '';
      newProjectDestinationInput.value = '';
      newProjectDeveloperSelect.value = '';
      toast(`Project "${project.name}" created.`, 'success');
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
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Project name'), newProjectNameInput]),
      el('div', {}, [el('label', {}, 'Location'), newProjectLocationInput]),
      el('div', {}, [el('label', {}, 'Destination'), newProjectDestinationInput]),
      el('div', {}, [el('label', {}, 'Developer'), newProjectDeveloperSelect]),
      el('div', { style: 'align-self:flex-end' }, addProjectBtn),
    ]),
    projectsListSlot,
  ]));

  function developerName(id) {
    return developers.find((d) => d.id === id)?.name || '—';
  }

  async function loadProjects() {
    clear(projectsListSlot);
    try {
      const page = await api.get('/api/inventory/projects', { limit: 200 });
      projects = page.items;
      newProjectDeveloperSelect.innerHTML = '';
      newProjectDeveloperSelect.appendChild(el('option', { value: '' }, '— none —'));
      developers.forEach((d) => newProjectDeveloperSelect.appendChild(el('option', { value: d.id }, d.name)));
      projectSelect.innerHTML = '';
      projects.forEach((p) => projectSelect.appendChild(el('option', { value: p.id }, p.name)));
      filterDestinationSelect.innerHTML = '';
      filterDestinationSelect.appendChild(el('option', { value: '' }, 'Any destination'));
      [...new Set(projects.map((p) => p.destination).filter(Boolean))].forEach((d) => filterDestinationSelect.appendChild(el('option', { value: d }, d)));

      projectsListSlot.appendChild(table(
        [
          { label: 'Name', key: 'name' },
          { label: 'Destination', render: (p) => p.destination || '—' },
          { label: 'Developer', render: (p) => developerName(p.developerId) },
          { label: '', render: (p) => {
            const btn = el('button', {}, 'Details');
            btn.addEventListener('click', () => openProjectDetail(p));
            return btn;
          } },
        ],
        page.items,
        { empty: 'No projects yet — add one above.' },
      ));
    } catch (err) {
      projectsListSlot.appendChild(errorBanner(err.message));
    }
  }

  async function openProjectDetail(project) {
    const body = el('div', {}, loadingState());
    contentModal(project.name, body, { wide: true });

    async function refresh() {
      clear(body);
      body.appendChild(loadingState());
      let details;
      try {
        details = await api.get(`/api/inventory/projects/${project.id}`);
      } catch (err) {
        clear(body);
        body.appendChild(errorBanner(err.message));
        return;
      }
      clear(body);
      const { project: p, developer, phases, launches, facilities, engineeringConsultant, projectManagement, salesPhoneNumbers } = details;

      const editBtn = el('button', {}, 'Edit details');
      editBtn.addEventListener('click', async () => {
        const values = await formModal({
          title: 'Edit project details',
          fields: [
            { key: 'destination', label: 'Destination', value: p.destination || '' },
            { key: 'address', label: 'Address', value: p.address || '' },
            { key: 'locationMapUrl', label: 'Location on map (URL)', value: p.locationMapUrl || '' },
            { key: 'finishingType', label: 'Finishing Type', value: p.finishingType || '' },
            { key: 'projectAreaSqm', label: 'Project Area (sqm)', type: 'number', value: p.projectAreaSqm ?? '' },
            { key: 'priceFrom', label: 'Price From', type: 'number', value: p.priceFrom ?? '' },
            { key: 'priceTo', label: 'Price To', type: 'number', value: p.priceTo ?? '' },
            { key: 'cashDiscountPercent', label: 'Cash Discount %', type: 'number', value: p.cashDiscountPercent ?? '' },
            { key: 'maintenanceFeePercent', label: 'Maintenance Fees %', type: 'number', value: p.maintenanceFeePercent ?? '' },
            { key: 'ministerialDecisionNumber', label: 'قرار وزاري (Ministerial Decision No.)', value: p.ministerialDecisionNumber || '' },
          ],
        });
        if (!values) return;
        try {
          await api.patch(`/api/inventory/projects/${project.id}`, {
            destination: values.destination || undefined,
            address: values.address || undefined,
            locationMapUrl: values.locationMapUrl || undefined,
            finishingType: values.finishingType || undefined,
            projectAreaSqm: values.projectAreaSqm ? Number(values.projectAreaSqm) : undefined,
            priceFrom: values.priceFrom ? Number(values.priceFrom) : undefined,
            priceTo: values.priceTo ? Number(values.priceTo) : undefined,
            cashDiscountPercent: values.cashDiscountPercent ? Number(values.cashDiscountPercent) : undefined,
            maintenanceFeePercent: values.maintenanceFeePercent ? Number(values.maintenanceFeePercent) : undefined,
            ministerialDecisionNumber: values.ministerialDecisionNumber || undefined,
          });
          toast('Project details saved.', 'success');
          await refresh();
          await loadProjects();
        } catch (err) {
          errorSlot.appendChild(errorBanner(err.message));
        }
      });

      const summary = el('div', { class: 'card', style: 'margin-bottom:12px' }, [
        el('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, [
          el('div', {}, [
            p.destination ? badge(p.destination, 'blue') : null,
            developer ? el('span', { style: 'margin-left:8px' }, `Developer: ${developer.name}`) : null,
          ]),
          editBtn,
        ]),
        el('div', { style: 'margin-top:8px;font-size:13px;color:var(--text-muted)' }, [
          p.address ? el('div', {}, `Address: ${p.address}`) : null,
          p.locationMapUrl ? el('div', {}, [el('a', { href: p.locationMapUrl, target: '_blank', rel: 'noopener' }, 'View on map')]) : null,
          p.finishingType ? el('div', {}, `Finishing: ${p.finishingType}`) : null,
          p.projectAreaSqm ? el('div', {}, `Project area: ${p.projectAreaSqm} sqm`) : null,
          (p.priceFrom || p.priceTo) ? el('div', {}, `Price range: ${p.priceFrom ? Number(p.priceFrom).toLocaleString() : '—'} – ${p.priceTo ? Number(p.priceTo).toLocaleString() : '—'} ${p.currency || 'EGP'}`) : null,
          p.cashDiscountPercent !== undefined ? el('div', {}, `Cash discount: ${p.cashDiscountPercent}%`) : null,
          p.maintenanceFeePercent !== undefined ? el('div', {}, `Maintenance: ${p.maintenanceFeePercent}%`) : null,
          p.ministerialDecisionNumber ? el('div', {}, `قرار وزاري: ${p.ministerialDecisionNumber}`) : null,
          engineeringConsultant ? el('div', {}, `Engineering consultant: ${engineeringConsultant.name}`) : null,
          projectManagement ? el('div', {}, `Project management: ${projectManagement.name}`) : null,
        ]),
      ]);
      body.appendChild(summary);

      // Facilities
      const addFacilityBtn = el('button', {}, '+ Facility');
      addFacilityBtn.addEventListener('click', async () => {
        const values = await formModal({ title: 'Add facility', fields: [{ key: 'name', label: 'Facility name', placeholder: 'e.g. Clubhouse' }] });
        if (!values?.name?.trim()) return;
        try {
          const f = await api.post('/api/inventory/facilities', { name: values.name.trim() });
          await api.patch(`/api/inventory/projects/${project.id}`, { facilityIds: [...(p.facilityIds || []), f.id] });
          toast('Facility added.', 'success');
          await refresh();
        } catch (err) {
          errorSlot.appendChild(errorBanner(err.message));
        }
      });
      body.appendChild(el('div', { class: 'card', style: 'margin-bottom:12px' }, [
        el('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, [el('h4', { style: 'margin:0' }, 'Facilities'), addFacilityBtn]),
        el('div', { style: 'margin-top:8px' }, facilities.length ? facilities.map((f) => badge(f.name)) : [el('span', { class: 'muted' }, 'None yet.')]),
      ]));

      // Phases
      const addPhaseBtn = el('button', {}, '+ Phase');
      addPhaseBtn.addEventListener('click', async () => {
        const values = await formModal({ title: 'Add phase', fields: [{ key: 'name', label: 'Phase name', placeholder: 'e.g. Phase 1' }] });
        if (!values?.name?.trim()) return;
        try {
          await api.post(`/api/inventory/projects/${project.id}/phases`, { name: values.name.trim(), order: phases.length });
          toast('Phase added.', 'success');
          await refresh();
        } catch (err) {
          errorSlot.appendChild(errorBanner(err.message));
        }
      });
      body.appendChild(el('div', { class: 'card', style: 'margin-bottom:12px' }, [
        el('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, [el('h4', { style: 'margin:0' }, 'Phases'), addPhaseBtn]),
        table([{ label: 'Name', key: 'name' }, { label: 'Order', key: 'order' }], phases, { empty: 'No phases yet.' }),
      ]));

      // Launches
      const addLaunchBtn = el('button', {}, '+ Launch');
      addLaunchBtn.addEventListener('click', async () => {
        const values = await formModal({
          title: 'Add launch',
          fields: [
            { key: 'name', label: 'Launch name', placeholder: 'e.g. New Release' },
            { key: 'launchDate', label: 'Launch date', type: 'date' },
            { key: 'notes', label: 'Notes', type: 'textarea' },
          ],
        });
        if (!values?.name?.trim()) return;
        try {
          await api.post(`/api/inventory/projects/${project.id}/launches`, { name: values.name.trim(), launchDate: values.launchDate || undefined, notes: values.notes || undefined });
          toast('Launch added.', 'success');
          await refresh();
        } catch (err) {
          errorSlot.appendChild(errorBanner(err.message));
        }
      });
      body.appendChild(el('div', { class: 'card', style: 'margin-bottom:12px' }, [
        el('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, [el('h4', { style: 'margin:0' }, 'Launches'), addLaunchBtn]),
        table([{ label: 'Name', key: 'name' }, { label: 'Date', render: (l) => l.launchDate || '—' }], launches, { empty: 'No launches yet.' }),
      ]));

      // Sales phone numbers
      const addPhoneBtn = el('button', {}, '+ Sales Phone Number');
      addPhoneBtn.addEventListener('click', async () => {
        const values = await formModal({ title: 'Add sales direct phone number', fields: [{ key: 'phoneNumber', label: 'Phone number', placeholder: 'e.g. +20 100 000 0000' }] });
        if (!values?.phoneNumber?.trim()) return;
        try {
          await api.post(`/api/inventory/projects/${project.id}/sales-phone-numbers`, { phoneNumber: values.phoneNumber.trim() });
          toast('Sales phone number added.', 'success');
          await refresh();
        } catch (err) {
          errorSlot.appendChild(errorBanner(err.message));
        }
      });
      body.appendChild(el('div', { class: 'card' }, [
        el('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, [el('h4', { style: 'margin:0' }, 'Sales Direct Phone Numbers'), addPhoneBtn]),
        el('div', { style: 'margin-top:8px' }, salesPhoneNumbers.length ? salesPhoneNumbers.map((s) => badge(s.phoneNumber)) : [el('span', { class: 'muted' }, 'None yet.')]),
      ]));
    }

    await refresh();
  }

  // ---- Add a unit ----
  const projectSelect = selectInput([]);
  const codeInput = el('input', { type: 'text', placeholder: 'A-101' });
  const typeInput = el('input', { type: 'text', placeholder: 'apartment' });
  const areaInput = el('input', { type: 'number', placeholder: '120' });
  const priceInput = el('input', { type: 'number', placeholder: '1500000' });
  const bedroomsInput = el('input', { type: 'number', min: '0', placeholder: '3' });
  const floorInput = el('input', { type: 'text', placeholder: 'Ground / 1 / 2…' });
  const designTypeInput = el('input', { type: 'text', placeholder: 'e.g. Corner' });
  const viewInput = el('input', { type: 'text', placeholder: 'e.g. Garden, Pool' });
  const buildingInput = el('input', { type: 'text', placeholder: 'e.g. B3' });
  const gardenAreaInput = el('input', { type: 'number', min: '0', placeholder: 'optional' });
  const finishingInput = el('input', { type: 'text', placeholder: 'e.g. Fully Finished' });
  const createBtn = el('button', { class: 'primary' }, 'Add unit');

  createBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!projectSelect.value || !codeInput.value.trim() || !typeInput.value.trim() || !(Number(areaInput.value) > 0) || !(Number(priceInput.value) > 0)) {
      errorSlot.appendChild(errorBanner('Select a project, and fill in code, type, and a positive area and price.'));
      return;
    }
    createBtn.disabled = true;
    try {
      await api.post('/api/inventory/units', {
        projectId: projectSelect.value,
        code: codeInput.value.trim(),
        unitType: typeInput.value.trim(),
        areaSqm: Number(areaInput.value),
        listPrice: Number(priceInput.value),
        bedrooms: bedroomsInput.value ? Number(bedroomsInput.value) : undefined,
        floorLabel: floorInput.value.trim() || undefined,
        designType: designTypeInput.value.trim() || undefined,
        view: viewInput.value.trim() ? viewInput.value.split(',').map((v) => v.trim()).filter(Boolean) : undefined,
        buildingLabel: buildingInput.value.trim() || undefined,
        gardenAreaSqm: gardenAreaInput.value ? Number(gardenAreaInput.value) : undefined,
        finishingType: finishingInput.value.trim() || undefined,
      });
      [codeInput, typeInput, areaInput, priceInput, bedroomsInput, floorInput, designTypeInput, viewInput, buildingInput, gardenAreaInput, finishingInput].forEach((i) => (i.value = ''));
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
    el('div', { class: 'form-row', style: 'flex-wrap:wrap' }, [
      el('div', {}, [el('label', {}, 'Project'), projectSelect]),
      el('div', {}, [el('label', {}, 'Unit code'), codeInput]),
      el('div', {}, [el('label', {}, 'Type'), typeInput]),
      el('div', {}, [el('label', {}, 'Area (sqm)'), areaInput]),
      el('div', {}, [el('label', {}, 'List price'), priceInput]),
      el('div', {}, [el('label', {}, 'Bedrooms'), bedroomsInput]),
      el('div', {}, [el('label', {}, 'Floor'), floorInput]),
      el('div', {}, [el('label', {}, 'Design type'), designTypeInput]),
      el('div', {}, [el('label', {}, 'View'), viewInput]),
      el('div', {}, [el('label', {}, 'Building'), buildingInput]),
      el('div', {}, [el('label', {}, 'Garden area (sqm)'), gardenAreaInput]),
      el('div', {}, [el('label', {}, 'Finishing'), finishingInput]),
    ]),
    el('div', { class: 'form-actions' }, [createBtn]),
  ]));

  // ---- Search + advanced filters ----
  const search = searchInput('Search by code or type…', (value) => { q = value; offset = 0; load(); });
  const filterMinPrice = el('input', { type: 'number', placeholder: 'Min price' });
  const filterMaxPrice = el('input', { type: 'number', placeholder: 'Max price' });
  const filterMinArea = el('input', { type: 'number', placeholder: 'Min area (sqm)' });
  const filterMaxArea = el('input', { type: 'number', placeholder: 'Max area (sqm)' });
  const filterBedrooms = el('input', { type: 'number', min: '0', placeholder: 'Bedrooms' });
  const filterFinishing = el('input', { type: 'text', placeholder: 'Finishing' });
  const filterDestinationSelect = selectInput([{ value: '', label: 'Any destination' }]);
  const filterStatusSelect = selectInput([
    { value: 'any', label: 'Any status' },
    { value: 'available', label: 'Available' },
    { value: 'held', label: 'Held' },
    { value: 'reserved', label: 'Reserved' },
    { value: 'contracted', label: 'Contracted' },
  ]);
  const applyFiltersBtn = el('button', { class: 'primary' }, 'Apply filters');
  const clearFiltersBtn = el('button', {}, 'Clear');
  applyFiltersBtn.addEventListener('click', () => {
    filters = {
      minPrice: filterMinPrice.value || undefined,
      maxPrice: filterMaxPrice.value || undefined,
      minAreaSqm: filterMinArea.value || undefined,
      maxAreaSqm: filterMaxArea.value || undefined,
      bedrooms: filterBedrooms.value || undefined,
      finishingType: filterFinishing.value || undefined,
      destination: filterDestinationSelect.value || undefined,
      status: filterStatusSelect.value,
    };
    offset = 0;
    load();
  });
  clearFiltersBtn.addEventListener('click', () => {
    [filterMinPrice, filterMaxPrice, filterMinArea, filterMaxArea, filterBedrooms, filterFinishing].forEach((i) => (i.value = ''));
    filterDestinationSelect.value = '';
    filterStatusSelect.value = 'any';
    filters = {};
    offset = 0;
    load();
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'form-row', style: 'max-width:320px' }, [search]),
    el('h4', { style: 'margin:12px 0 6px' }, 'Advanced filters'),
    el('div', { class: 'form-row', style: 'flex-wrap:wrap' }, [
      el('div', {}, [el('label', {}, 'Min price'), filterMinPrice]),
      el('div', {}, [el('label', {}, 'Max price'), filterMaxPrice]),
      el('div', {}, [el('label', {}, 'Min area'), filterMinArea]),
      el('div', {}, [el('label', {}, 'Max area'), filterMaxArea]),
      el('div', {}, [el('label', {}, 'Bedrooms'), filterBedrooms]),
      el('div', {}, [el('label', {}, 'Finishing'), filterFinishing]),
      el('div', {}, [el('label', {}, 'Destination'), filterDestinationSelect]),
      el('div', {}, [el('label', {}, 'Status'), filterStatusSelect]),
      el('div', { style: 'align-self:flex-end;display:flex;gap:6px' }, [applyFiltersBtn, clearFiltersBtn]),
    ]),
  ]));

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

  function projectName(id) {
    return projects.find((p) => p.id === id)?.name || id;
  }

  async function load() {
    await loadDevelopers();
    await loadProjects();
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/inventory/units', { limit: 20, offset, q, ...filters });
      clear(listSlot);
      listSlot.append(table(
        [
          { label: 'Code', key: 'code' },
          { label: 'Project', render: (u) => projectName(u.projectId) },
          { label: 'Type', key: 'unitType' },
          { label: 'Beds', render: (u) => (u.bedrooms !== undefined ? String(u.bedrooms) : '—') },
          { label: 'Area', render: (u) => `${u.areaSqm} m²` },
          { label: 'Price', render: (u) => Number(u.listPrice).toLocaleString() },
          { label: 'Finishing', render: (u) => u.finishingType || '—' },
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
        { empty: 'No units match — add one above or adjust your filters.' },
      ), paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
  await loadImportHistory();
}
