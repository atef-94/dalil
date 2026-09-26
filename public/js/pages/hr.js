import { el, clear, table, toast, errorBanner, statusBadge, loadingState, selectInput, paginationControls } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

export async function renderHr(container) {
  clear(container);
  const locale = getLocale();
  let offset = 0;
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, t(locale, 'page_title_hr'))));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const employeeSelect = selectInput([]);
  const typeSelect = selectInput(['annual', 'sick', 'unpaid', 'other'].map((t) => ({ value: t, label: t })));
  const startInput = el('input', { type: 'date' });
  const endInput = el('input', { type: 'date' });
  const reasonInput = el('input', { type: 'text', placeholder: t(locale, 'hr_reason_placeholder') });
  const createBtn = el('button', { class: 'primary' }, t(locale, 'hr_request_leave_btn'));

  createBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!employeeSelect.value || !startInput.value || !endInput.value) {
      errorSlot.appendChild(errorBanner(t(locale, 'hr_err_required')));
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
      toast(t(locale, 'hr_submitted_toast'), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'hr_request_leave_btn')),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'comm_employee_col')), employeeSelect]),
      el('div', {}, [el('label', {}, t(locale, 'units_col_type')), typeSelect]),
      el('div', {}, [el('label', {}, t(locale, 'common_field_start_date')), startInput]),
      el('div', {}, [el('label', {}, t(locale, 'common_field_end_date')), endInput]),
      el('div', {}, [el('label', {}, t(locale, 'fin_reason_field')), reasonInput]),
    ]),
    el('div', { class: 'form-actions' }, [createBtn]),
  ]));

  const listSlot = el('div');
  container.appendChild(listSlot);

  async function decide(request, action, btn) {
    btn.disabled = true;
    try {
      await api.post(`/api/hr/leave-requests/${request.id}/${action}`, {});
      toast(action === 'approve' ? t(locale, 'hr_leave_approved_toast') : t(locale, 'hr_leave_rejected_toast'), 'success');
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
          { label: t(locale, 'comm_employee_col'), render: (r) => employeeSelect.querySelector(`option[value="${r.employeeId}"]`)?.textContent || r.employeeId },
          { label: t(locale, 'units_col_type'), key: 'type' },
          { label: t(locale, 'common_col_from'), render: (r) => new Date(r.startDate).toLocaleDateString() },
          { label: t(locale, 'crm_timeline_to_field'), render: (r) => new Date(r.endDate).toLocaleDateString() },
          { label: t(locale, 'common_col_status'), render: (r) => statusBadge(r.status) },
          { label: '', render: (r) => {
            if (r.status !== 'pending') return '';
            const approveBtn = el('button', { class: 'primary' }, t(locale, 'brokers_approve_btn'));
            approveBtn.addEventListener('click', () => decide(r, 'approve', approveBtn));
            const rejectBtn = el('button', {}, t(locale, 'approvals_reject_btn'));
            rejectBtn.addEventListener('click', () => decide(r, 'reject', rejectBtn));
            return el('div', { class: 'form-actions' }, [approveBtn, rejectBtn]);
          } },
        ],
        page.items,
        { empty: t(locale, 'hr_empty_leave_requests') },
      ));
      listSlot.appendChild(paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
