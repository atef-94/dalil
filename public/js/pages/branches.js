import { el, clear, table, toast, errorBanner, loadingState, selectInput, badge } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

export async function renderBranches(container) {
  clear(container);
  const locale = getLocale();
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, t(locale, 'page_title_branches')),
      el('p', { class: 'page-subtitle' }, 'The org structure Employees, Roles, and department-scoped permissions are built on.'),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const branchNameInput = el('input', { type: 'text', placeholder: 'e.g. Cairo HQ' });
  const branchAddressInput = el('input', { type: 'text', placeholder: 'Address (optional)' });
  const addBranchBtn = el('button', { class: 'primary' }, 'Add branch');
  addBranchBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!branchNameInput.value.trim()) {
      errorSlot.appendChild(errorBanner('Enter a branch name.'));
      return;
    }
    addBranchBtn.disabled = true;
    try {
      await api.post('/api/organization/branches', { name: branchNameInput.value.trim(), address: branchAddressInput.value.trim() || undefined });
      branchNameInput.value = '';
      branchAddressInput.value = '';
      toast('Branch added.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      addBranchBtn.disabled = false;
    }
  });

  const deptNameInput = el('input', { type: 'text', placeholder: 'e.g. Sales' });
  const deptBranchSelect = selectInput([{ value: '', label: 'No specific branch' }]);
  const addDeptBtn = el('button', { class: 'primary' }, 'Add department');
  addDeptBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!deptNameInput.value.trim()) {
      errorSlot.appendChild(errorBanner('Enter a department name.'));
      return;
    }
    addDeptBtn.disabled = true;
    try {
      await api.post('/api/organization/departments', { name: deptNameInput.value.trim(), branchId: deptBranchSelect.value || undefined });
      deptNameInput.value = '';
      toast('Department added.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      addDeptBtn.disabled = false;
    }
  });

  const tabsWrap = el('div');
  const panelSlot = el('div');
  container.appendChild(tabsWrap);
  container.appendChild(panelSlot);

  let branches = [];
  let departments = [];
  let employees = [];

  function branchesPanel() {
    clear(panelSlot);
    panelSlot.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, 'Add a branch'),
      el('div', { class: 'form-row' }, [
        el('div', {}, [el('label', {}, 'Name'), branchNameInput]),
        el('div', {}, [el('label', {}, 'Address'), branchAddressInput]),
        el('div', { style: 'align-self:flex-end' }, addBranchBtn),
      ]),
    ]));
    panelSlot.appendChild(table(
      [
        { label: 'Name', key: 'name' },
        { label: 'Address', render: (b) => b.address || '—' },
        { label: 'Departments', render: (b) => String(departments.filter((d) => d.branchId === b.id).length) },
        { label: 'Employees', render: (b) => String(employees.filter((e) => e.branchId === b.id).length) },
      ],
      branches,
      { empty: 'No branches yet — add your first one above.', emptyIcon: 'branches' },
    ));
  }

  function departmentsPanel() {
    clear(panelSlot);
    panelSlot.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, 'Add a department'),
      el('div', { class: 'form-row' }, [
        el('div', {}, [el('label', {}, 'Name'), deptNameInput]),
        el('div', {}, [el('label', {}, 'Branch (optional)'), deptBranchSelect]),
        el('div', { style: 'align-self:flex-end' }, addDeptBtn),
      ]),
    ]));
    panelSlot.appendChild(table(
      [
        { label: 'Name', key: 'name' },
        { label: 'Branch', render: (d) => branches.find((b) => b.id === d.branchId)?.name || '—' },
        { label: 'Employees', render: (d) => String(employees.filter((e) => e.departmentId === d.id).length) },
      ],
      departments,
      { empty: 'No departments yet — add your first one above.', emptyIcon: 'branches' },
    ));
  }

  function teamsPanel() {
    clear(panelSlot);
    const teamNames = [...new Set(employees.map((e) => e.teamId).filter(Boolean))];
    panelSlot.appendChild(el('p', { class: 'page-subtitle', style: 'margin:0 0 12px' }, 'Teams are a free-form grouping set per-employee (Employees → Team field) — this view is derived, not a separate record to manage here.'));
    panelSlot.appendChild(table(
      [
        { label: 'Team', render: (name) => el('span', { style: 'font-weight:600' }, name) },
        { label: 'Members', render: (name) => String(employees.filter((e) => e.teamId === name).length) },
        { label: '', render: (name) => badge(`${employees.filter((e) => e.teamId === name && e.status === 'active').length} active`, 'blue') },
      ],
      teamNames,
      { empty: 'No teams yet — set a Team on an employee to see it here.', emptyIcon: 'branches' },
    ));
  }

  const TABS = [
    { key: 'branches', label: 'Branches', render: branchesPanel },
    { key: 'departments', label: 'Departments', render: departmentsPanel },
    { key: 'teams', label: 'Teams', render: teamsPanel },
  ];
  let activeTab = 'branches';
  function renderTabs() {
    clear(tabsWrap);
    tabsWrap.appendChild(el('div', { class: 'tabs' }, TABS.map((tabDef) => {
      const btn = el('button', { class: `tab${tabDef.key === activeTab ? ' active' : ''}` }, tabDef.label);
      btn.addEventListener('click', () => { activeTab = tabDef.key; renderTabs(); tabDef.render(); });
      return btn;
    })));
  }

  async function load() {
    clear(panelSlot);
    panelSlot.appendChild(loadingState());
    try {
      const [branchesPage, departmentsPage, employeesPage] = await Promise.all([
        api.get('/api/organization/branches', { limit: 100 }),
        api.get('/api/organization/departments', { limit: 100 }),
        api.get('/api/organization/employees', { limit: 200 }),
      ]);
      branches = branchesPage.items;
      departments = departmentsPage.items;
      employees = employeesPage.items;

      clear(deptBranchSelect);
      deptBranchSelect.appendChild(el('option', { value: '' }, 'No specific branch'));
      branches.forEach((b) => deptBranchSelect.appendChild(el('option', { value: b.id }, b.name)));

      renderTabs();
      const active = TABS.find((tb) => tb.key === activeTab);
      active.render();
    } catch (err) {
      clear(panelSlot);
      panelSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
