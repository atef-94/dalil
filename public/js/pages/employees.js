import { el, clear, table, toast, errorBanner, paginationControls, loadingState, confirmModal, formModal, selectInput, searchInput } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

export async function renderEmployees(container) {
  clear(container);
  const locale = getLocale();
  let offset = 0;
  let q = '';
  const errorSlot = el('div');
  const listSlot = el('div');

  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, t(locale, 'page_title_employees'))));
  container.appendChild(errorSlot);

  let branches = [];
  let departments = [];

  const nameInput = el('input', { type: 'text', placeholder: t(locale, 'crm_lead_field_full_name') });
  const emailInput = el('input', { type: 'email', placeholder: t(locale, 'employees_email_placeholder') });
  const titleInput = el('input', { type: 'text', placeholder: t(locale, 'employees_title_placeholder') });
  const empBranchSelect = selectInput([{ value: '', label: t(locale, 'employees_no_branch') }]);
  const empDeptSelect = selectInput([{ value: '', label: t(locale, 'employees_no_department') }]);
  const teamInput = el('input', { type: 'text', placeholder: t(locale, 'employees_team_placeholder') });

  const createBtn = el('button', { class: 'primary' }, t(locale, 'employees_add_btn'));
  createBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!nameInput.value.trim() || !emailInput.value.trim() || !titleInput.value.trim()) {
      errorSlot.appendChild(errorBanner(t(locale, 'employees_required_fields_error')));
      return;
    }
    createBtn.disabled = true;
    try {
      await api.post('/api/organization/employees', {
        fullName: nameInput.value.trim(),
        email: emailInput.value.trim(),
        title: titleInput.value.trim(),
        branchId: empBranchSelect.value || undefined,
        departmentId: empDeptSelect.value || undefined,
        teamId: teamInput.value.trim() || undefined,
      });
      nameInput.value = '';
      emailInput.value = '';
      titleInput.value = '';
      teamInput.value = '';
      toast(t(locale, 'employees_added_toast'), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'employees_add_title')),
    el('p', { class: 'page-subtitle', style: 'margin-bottom:12px' }, `${t(locale, 'employees_manage_hint_prefix')} ${t(locale, 'page_title_branches')}.`),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'crm_lead_field_full_name')), nameInput]),
      el('div', {}, [el('label', {}, t(locale, 'field_email')), emailInput]),
      el('div', {}, [el('label', {}, t(locale, 'employees_job_title_field')), titleInput]),
      el('div', {}, [el('label', {}, t(locale, 'branches_field_branch')), empBranchSelect]),
      el('div', {}, [el('label', {}, t(locale, 'branches_field_department')), empDeptSelect]),
      el('div', {}, [el('label', {}, t(locale, 'branches_field_team')), teamInput]),
    ]),
    el('div', { class: 'form-actions' }, [createBtn]),
  ]));

  const search = searchInput(t(locale, 'employees_search_placeholder'), (value) => { q = value; offset = 0; load(); });
  container.appendChild(el('div', { class: 'form-row', style: 'max-width:320px' }, [search]));

  container.appendChild(listSlot);

  async function reassignManager(employee, btn) {
    const others = (currentItems || []).filter((e) => e.id !== employee.id && e.status !== 'terminated');
    if (others.length === 0) {
      errorSlot.appendChild(errorBanner(t(locale, 'employees_no_other_managers_error')));
      return;
    }
    const values = await formModal({
      title: `${t(locale, 'employees_reassign_manager_prefix')} ${employee.fullName}`,
      fields: [
        {
          key: 'newManagerEmployeeId',
          label: t(locale, 'employees_new_manager_field'),
          type: 'select',
          options: others.map((e) => ({ value: e.id, label: `${e.fullName} (${e.title})` })),
        },
      ],
      submitLabel: t(locale, 'employees_reassign_btn'),
    });
    if (!values || !values.newManagerEmployeeId) return;
    btn.disabled = true;
    try {
      await api.post(`/api/organization/employees/${employee.id}/reassign-manager`, { newManagerEmployeeId: values.newManagerEmployeeId });
      toast(t(locale, 'employees_manager_reassigned_toast'), 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function terminate(employee, btn) {
    if (!(await confirmModal(`${t(locale, 'employees_terminate_btn')} ${employee.fullName}${t(locale, 'employees_terminate_confirm_suffix')}`, { confirmLabel: t(locale, 'employees_terminate_btn'), danger: true }))) return;
    btn.disabled = true;
    try {
      await api.post(`/api/organization/employees/${employee.id}/terminate`, {});
      toast(t(locale, 'employees_terminated_toast'), 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  let currentItems = [];

  function nameFor(list, id) {
    return list.find((x) => x.id === id)?.name || '—';
  }

  async function loadStructure() {
    try {
      const [branchesPage, departmentsPage] = await Promise.all([
        api.get('/api/organization/branches', { limit: 100 }),
        api.get('/api/organization/departments', { limit: 100 }),
      ]);
      branches = branchesPage.items;
      departments = departmentsPage.items;

      const fillSelect = (select, items, placeholder) => {
        const previous = select.value;
        clear(select);
        select.appendChild(el('option', { value: '' }, placeholder));
        items.forEach((item) => select.appendChild(el('option', { value: item.id }, item.name)));
        select.value = previous;
      };
      fillSelect(empBranchSelect, branches, t(locale, 'employees_no_branch'));
      fillSelect(empDeptSelect, departments, t(locale, 'employees_no_department'));
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    await loadStructure();
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/organization/employees', { limit: 20, offset, q });
      clear(listSlot);
      currentItems = page.items;
      const rows = table(
        [
          { label: t(locale, 'crm_col_name'), key: 'fullName' },
          { label: t(locale, 'field_email'), key: 'email' },
          { label: t(locale, 'employees_job_title_field'), key: 'title' },
          { label: t(locale, 'branches_field_branch'), render: (r) => (r.branchId ? nameFor(branches, r.branchId) : '—') },
          { label: t(locale, 'branches_field_department'), render: (r) => (r.departmentId ? nameFor(departments, r.departmentId) : '—') },
          { label: t(locale, 'branches_field_team'), render: (r) => r.teamId || '—' },
          { label: t(locale, 'employees_manager_col'), render: (r) => (r.managerEmployeeId ? currentItems.find((e) => e.id === r.managerEmployeeId)?.fullName || '—' : '—') },
          { label: t(locale, 'units_col_status'), render: (r) => r.status },
          { label: '', render: (r) => {
            if (r.status === 'terminated') return '';
            const reassignBtn = el('button', {}, t(locale, 'employees_reassign_manager_btn'));
            reassignBtn.addEventListener('click', () => reassignManager(r, reassignBtn));
            const terminateBtn = el('button', { class: 'danger' }, t(locale, 'employees_terminate_btn'));
            terminateBtn.addEventListener('click', () => terminate(r, terminateBtn));
            return el('div', { class: 'form-actions' }, [reassignBtn, terminateBtn]);
          } },
        ],
        page.items,
        { empty: t(locale, 'employees_list_empty') },
      );
      listSlot.append(rows, paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
