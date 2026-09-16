import { el, clear, table, toast, errorBanner, paginationControls } from '../ui.js';
import { api } from '../api.js';

export async function renderEmployees(container) {
  clear(container);
  let offset = 0;
  const errorSlot = el('div');
  const listSlot = el('div');

  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, 'Employees')));
  container.appendChild(errorSlot);

  const nameInput = el('input', { type: 'text', placeholder: 'Full name' });
  const emailInput = el('input', { type: 'email', placeholder: 'name@company.com' });
  const titleInput = el('input', { type: 'text', placeholder: 'Sales Agent' });
  const deptInput = el('input', { type: 'text', placeholder: 'e.g. dept-sales (optional)' });

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
        departmentId: deptInput.value.trim() || undefined,
      });
      nameInput.value = '';
      emailInput.value = '';
      titleInput.value = '';
      deptInput.value = '';
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
      el('div', {}, [el('label', {}, 'Department (optional)'), deptInput]),
    ]),
    el('div', { class: 'form-actions' }, [createBtn]),
  ]));

  container.appendChild(listSlot);

  async function load() {
    clear(listSlot);
    try {
      const page = await api.get('/api/organization/employees', { limit: 20, offset });
      const rows = table(
        [
          { label: 'Name', key: 'fullName' },
          { label: 'Email', key: 'email' },
          { label: 'Title', key: 'title' },
          { label: 'Department', key: 'departmentId' },
          { label: 'Manager', key: 'managerEmployeeId' },
          { label: 'Status', render: (r) => r.status },
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
