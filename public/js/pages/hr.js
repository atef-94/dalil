import { el, clear, table, toast, errorBanner, statusBadge, loadingState, selectInput, paginationControls } from '../ui.js';
import { api } from '../api.js';

export async function renderHr(container) {
  clear(container);
  let offset = 0;
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, 'HR — Leave Requests')));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const employeeSelect = selectInput([]);
  const typeSelect = selectInput(['annual', 'sick', 'unpaid', 'other'].map((t) => ({ value: t, label: t })));
  const startInput = el('input', { type: 'date' });
  const endInput = el('input', { type: 'date' });
  const reasonInput = el('input', { type: 'text', placeholder: 'Reason (optional)' });
  const createBtn = el('button', { class: 'primary' }, 'Request leave');

  createBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!employeeSelect.value || !startInput.value || !endInput.value) {
      errorSlot.appendChild(errorBanner('Choose an employee and both dates.'));
      return;
    }
    createBtn.disabled = true;
    try {
      await api.post('/api/hr/leave-requests', {
        employeeId: employeeSelect.value,
        type: typeSelect.value,
        startDate: startInput.value,
        endDate: endInput.value,
        reason: reasonInput.value.trim() || undefined,
      });
      startInput.value = '';
      endInput.value = '';
      reasonInput.value = '';
      toast('Leave request submitted.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Request leave'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Employee'), employeeSelect]),
      el('div', {}, [el('label', {}, 'Type'), typeSelect]),
      el('div', {}, [el('label', {}, 'Start date'), startInput]),
      el('div', {}, [el('label', {}, 'End date'), endInput]),
      el('div', {}, [el('label', {}, 'Reason'), reasonInput]),
    ]),
    el('div', { class: 'form-actions' }, [createBtn]),
  ]));

  const listSlot = el('div');
  container.appendChild(listSlot);

  async function decide(request, action, btn) {
    btn.disabled = true;
    try {
      await api.post(`/api/hr/leave-requests/${request.id}/${action}`, {});
      toast(`Leave request ${action === 'approve' ? 'approved' : 'rejected'}.`, 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    try {
      const employeesPage = await api.get('/api/organization/employees', { limit: 100 });
      clear(employeeSelect);
      employeesPage.items.filter((e) => e.status !== 'terminated').forEach((e) => employeeSelect.appendChild(el('option', { value: e.id }, e.fullName)));
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }

    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/hr/leave-requests', { limit: 20, offset });
      clear(listSlot);
      listSlot.appendChild(table(
        [
          { label: 'Employee', render: (r) => employeeSelect.querySelector(`option[value="${r.employeeId}"]`)?.textContent || r.employeeId },
          { label: 'Type', key: 'type' },
          { label: 'From', render: (r) => new Date(r.startDate).toLocaleDateString() },
          { label: 'To', render: (r) => new Date(r.endDate).toLocaleDateString() },
          { label: 'Status', render: (r) => statusBadge(r.status) },
          { label: '', render: (r) => {
            if (r.status !== 'pending') return '';
            const approveBtn = el('button', { class: 'primary' }, 'Approve');
            approveBtn.addEventListener('click', () => decide(r, 'approve', approveBtn));
            const rejectBtn = el('button', {}, 'Reject');
            rejectBtn.addEventListener('click', () => decide(r, 'reject', rejectBtn));
            return el('div', { class: 'form-actions' }, [approveBtn, rejectBtn]);
          } },
        ],
        page.items,
        { empty: 'No leave requests yet — submit one above, or you may not have permission to view them.' },
      ));
      listSlot.appendChild(paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
