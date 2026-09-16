import { el, clear, table, toast, errorBanner, paginationControls, loadingState, confirmModal, formModal, selectInput } from '../ui.js';
import { api } from '../api.js';

export async function renderEmployees(container) {
  clear(container);
  let offset = 0;
  const errorSlot = el('div');
  const listSlot = el('div');

  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, 'Employees')));
  container.appendChild(errorSlot);

  let branches = [];
  let departments = [];

  // ---- Branches & Departments (structure the org before adding people) ----
  const branchNameInput = el('input', { type: 'text', placeholder: 'e.g. Cairo HQ' });
  const addBranchBtn = el('button', {}, 'Add branch');
  addBranchBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!branchNameInput.value.trim()) {
      errorSlot.appendChild(errorBanner('Enter a branch name.'));
      return;
    }
    addBranchBtn.disabled = true;
    try {
      await api.post('/api/organization/branches', { name: branchNameInput.value.trim() });
      branchNameInput.value = '';
      toast('Branch added.', 'success');
      await loadStructure();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      addBranchBtn.disabled = false;
    }
  });

  const deptNameInput = el('input', { type: 'text', placeholder: 'e.g. Sales' });
  const deptBranchSelect = selectInput([{ value: '', label: 'No specific branch' }]);
  const addDeptBtn = el('button', {}, 'Add department');
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
      await loadStructure();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      addDeptBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Branches & departments'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'New branch'), branchNameInput]),
      el('div', { style: 'align-self:flex-end' }, addBranchBtn),
    ]),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'New department'), deptNameInput]),
      el('div', {}, [el('label', {}, 'Branch (optional)'), deptBranchSelect]),
      el('div', { style: 'align-self:flex-end' }, addDeptBtn),
    ]),
  ]));

  const nameInput = el('input', { type: 'text', placeholder: 'Full name' });
  const emailInput = el('input', { type: 'email', placeholder: 'name@company.com' });
  const titleInput = el('input', { type: 'text', placeholder: 'Sales Agent' });
  const empBranchSelect = selectInput([{ value: '', label: 'No branch' }]);
  const empDeptSelect = selectInput([{ value: '', label: 'No department' }]);

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
      });
      nameInput.value = '';
      emailInput.value = '';
      titleInput.value = '';
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
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Full name'), nameInput]),
      el('div', {}, [el('label', {}, 'Email'), emailInput]),
      el('div', {}, [el('label', {}, 'Title'), titleInput]),
      el('div', {}, [el('label', {}, 'Branch'), empBranchSelect]),
      el('div', {}, [el('label', {}, 'Department'), empDeptSelect]),
    ]),
    el('div', { class: 'form-actions' }, [createBtn]),
  ]));

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
      fillSelect(deptBranchSelect, branches, 'No specific branch');
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
      const page = await api.get('/api/organization/employees', { limit: 20, offset });
      clear(listSlot);
      currentItems = page.items;
      const rows = table(
        [
          { label: 'Name', key: 'fullName' },
          { label: 'Email', key: 'email' },
          { label: 'Title', key: 'title' },
          { label: 'Branch', render: (r) => (r.branchId ? nameFor(branches, r.branchId) : '—') },
          { label: 'Department', render: (r) => (r.departmentId ? nameFor(departments, r.departmentId) : '—') },
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
