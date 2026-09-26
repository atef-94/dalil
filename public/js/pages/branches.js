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
      el('p', { class: 'page-subtitle' }, t(locale, 'branches_page_subtitle')),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const branchNameInput = el('input', { type: 'text', placeholder: t(locale, 'branches_name_placeholder') });
  const branchAddressInput = el('input', { type: 'text', placeholder: t(locale, 'branches_address_placeholder') });
  const addBranchBtn = el('button', { class: 'primary' }, t(locale, 'branches_add_branch_btn'));
  addBranchBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!branchNameInput.value.trim()) {
      errorSlot.appendChild(errorBanner(t(locale, 'branches_enter_name_error')));
      return;
    }
    addBranchBtn.disabled = true;
    try {
      await api.post('/api/organization/branches', { name: branchNameInput.value.trim(), address: branchAddressInput.value.trim() || undefined });
      branchNameInput.value = '';
      branchAddressInput.value = '';
      toast(t(locale, 'branches_added_toast'), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      addBranchBtn.disabled = false;
    }
  });

  const deptNameInput = el('input', { type: 'text', placeholder: t(locale, 'branches_dept_name_placeholder') });
  const deptBranchSelect = selectInput([{ value: '', label: t(locale, 'branches_no_specific_branch') }]);
  const addDeptBtn = el('button', { class: 'primary' }, t(locale, 'branches_add_dept_btn'));
  addDeptBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!deptNameInput.value.trim()) {
      errorSlot.appendChild(errorBanner(t(locale, 'branches_enter_dept_name_error')));
      return;
    }
    addDeptBtn.disabled = true;
    try {
      await api.post('/api/organization/departments', { name: deptNameInput.value.trim(), branchId: deptBranchSelect.value || undefined });
      deptNameInput.value = '';
      toast(t(locale, 'branches_added_dept_toast'), 'success');
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
      el('h3', { style: 'margin-top:0' }, t(locale, 'branches_add_branch_title')),
      el('div', { class: 'form-row' }, [
        el('div', {}, [el('label', {}, t(locale, 'crm_col_name')), branchNameInput]),
        el('div', {}, [el('label', {}, t(locale, 'branches_address_field')), branchAddressInput]),
        el('div', { style: 'align-self:flex-end' }, addBranchBtn),
      ]),
    ]));
    panelSlot.appendChild(table(
      [
        { label: t(locale, 'crm_col_name'), key: 'name' },
        { label: t(locale, 'branches_address_field'), render: (b) => b.address || '—' },
        { label: t(locale, 'branches_departments_col'), render: (b) => String(departments.filter((d) => d.branchId === b.id).length) },
        { label: t(locale, 'nav_employees'), render: (b) => String(employees.filter((e) => e.branchId === b.id).length) },
      ],
      branches,
      { empty: t(locale, 'branches_list_empty'), emptyIcon: 'branches' },
    ));
  }

  function departmentsPanel() {
    clear(panelSlot);
    panelSlot.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, t(locale, 'branches_add_dept_title')),
      el('div', { class: 'form-row' }, [
        el('div', {}, [el('label', {}, t(locale, 'crm_col_name')), deptNameInput]),
        el('div', {}, [el('label', {}, t(locale, 'branches_branch_optional_field')), deptBranchSelect]),
        el('div', { style: 'align-self:flex-end' }, addDeptBtn),
      ]),
    ]));
    panelSlot.appendChild(table(
      [
        { label: t(locale, 'crm_col_name'), key: 'name' },
        { label: t(locale, 'branches_field_branch'), render: (d) => branches.find((b) => b.id === d.branchId)?.name || '—' },
        { label: t(locale, 'nav_employees'), render: (d) => String(employees.filter((e) => e.departmentId === d.id).length) },
      ],
      departments,
      { empty: t(locale, 'branches_dept_list_empty'), emptyIcon: 'branches' },
    ));
  }

  function teamsPanel() {
    clear(panelSlot);
    const teamNames = [...new Set(employees.map((e) => e.teamId).filter(Boolean))];
    panelSlot.appendChild(el('p', { class: 'page-subtitle', style: 'margin:0 0 12px' }, t(locale, 'branches_teams_subtitle')));
    panelSlot.appendChild(table(
      [
        { label: t(locale, 'branches_field_team'), render: (name) => el('span', { style: 'font-weight:600' }, name) },
        { label: t(locale, 'branches_members_col'), render: (name) => String(employees.filter((e) => e.teamId === name).length) },
        { label: '', render: (name) => badge(`${employees.filter((e) => e.teamId === name && e.status === 'active').length} ${t(locale, 'branches_active_suffix')}`, 'blue') },
      ],
      teamNames,
      { empty: t(locale, 'branches_teams_empty'), emptyIcon: 'branches' },
    ));
  }

  const TABS = [
    { key: 'branches', label: t(locale, 'branches_tab_branches'), render: branchesPanel },
    { key: 'departments', label: t(locale, 'branches_departments_col'), render: departmentsPanel },
    { key: 'teams', label: t(locale, 'branches_tab_teams'), render: teamsPanel },
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
      deptBranchSelect.appendChild(el('option', { value: '' }, t(locale, 'branches_no_specific_branch')));
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
