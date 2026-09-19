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

  const nameInput = el('input', { type: 'text', placeholder: 'Full name' });
  const emailInput = el('input', { type: 'email', placeholder: 'name@company.com' });
  const titleInput = el('input', { type: 'text', placeholder: 'Sales Agent' });
  const empBranchSelect = selectInput([{ value: '', label: 'No branch' }]);
  const empDeptSelect = selectInput([{ value: '', label: 'No department' }]);
  const teamInput = el('input', { type: 'text', placeholder: 'e.g. Alpha Sales Squad (optional)' });

  const createBtn = el('button', { class: 'primary' }, 'Add employee');
  createBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!nameInput.value.trim() || !emailInput.value.trim() || !titleInput.value.trim()) {
      errorSlot.appendChild(errorBanner('Full name, email, and title are required.'));
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
      toast('Employee added.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Add an employee'),
    el('p', { class: 'page-subtitle', style: 'margin-bottom:12px' }, 'Manage branches and departments themselves from Branches & Departments.'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Full name'), nameInput]),
      el('div', {}, [el('label', {}, 'Email'), emailInput]),
      el('div', {}, [el('label', {}, 'Title'), titleInput]),
      el('div', {}, [el('label', {}, 'Branch'), empBranchSelect]),
      el('div', {}, [el('label', {}, 'Department'), empDeptSelect]),
      el('div', {}, [el('label', {}, 'Team'), teamInput]),
    ]),
    el('div', { class: 'form-actions' }, [createBtn]),
  ]));

  const search = searchInput('Search by name, email, or title…', (value) => { q = value; offset = 0; load(); });
  container.appendChild(el('div', { class: 'form-row', style: 'max-width:320px' }, [search]));

  container.appendChild(listSlot);

  async function reassignManager(employee, btn) {
    const others = (currentItems || []).filter((e) => e.id !== employee.id && e.status !== 'terminated');
    if (others.length === 0) {
      errorSlot.appendChild(errorBanner('No other active employees available to become the manager.'));
      return;
    }
    const values = await formModal({
      title: `Reassign manager for ${employee.fullName}`,
      fields: [
        {
          key: 'newManagerEmployeeId',
          label: 'New manager',
          type: 'select',
          options: others.map((e) => ({ value: e.id, label: `${e.fullName} (${e.title})` })),
        },
      ],
      submitLabel: 'Reassign',
    });
    if (!values || !values.newManagerEmployeeId) return;
    btn.disabled = true;
    try {
      await api.post(`/api/organization/employees/${employee.id}/reassign-manager`, { newManagerEmployeeId: values.newManagerEmployeeId });
      toast('Manager reassigned.', 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function terminate(employee, btn) {
    if (!(await confirmModal(`Terminate ${employee.fullName}? This cannot be undone.`, { confirmLabel: 'Terminate', danger: true }))) return;
    btn.disabled = true;
    try {
      await api.post(`/api/organization/employees/${employee.id}/terminate`, {});
      toast('Employee terminated.', 'success');
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
      fillSelect(empBranchSelect, branches, 'No branch');
      fillSelect(empDeptSelect, departments, 'No department');
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
          { label: 'Name', key: 'fullName' },
          { label: 'Email', key: 'email' },
          { label: 'Title', key: 'title' },
          { label: 'Branch', render: (r) => (r.branchId ? nameFor(branches, r.branchId) : '—') },
          { label: 'Department', render: (r) => (r.departmentId ? nameFor(departments, r.departmentId) : '—') },
          { label: 'Team', render: (r) => r.teamId || '—' },
          { label: 'Manager', render: (r) => (r.managerEmployeeId ? currentItems.find((e) => e.id === r.managerEmployeeId)?.fullName || '—' : '—') },
          { label: 'Status', render: (r) => r.status },
          { label: '', render: (r) => {
            if (r.status === 'terminated') return '';
            const reassignBtn = el('button', {}, 'Reassign manager');
            reassignBtn.addEventListener('click', () => reassignManager(r, reassignBtn));
            const terminateBtn = el('button', { class: 'danger' }, 'Terminate');
            terminateBtn.addEventListener('click', () => terminate(r, terminateBtn));
            return el('div', { class: 'form-actions' }, [reassignBtn, terminateBtn]);
          } },
        ],
        page.items,
        { empty: 'No employees yet — add one above, or you may not have permission to view the roster.' },
      );
      listSlot.append(rows, paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
