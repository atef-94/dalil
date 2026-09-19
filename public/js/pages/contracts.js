import { el, clear, table, toast, errorBanner, statusBadge, loadingState, confirmModal, formModal, paginationControls } from '../ui.js';
import { api } from '../api.js';

export async function renderContracts(container) {
  clear(container);
  let offset = 0;
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, 'Contracts'),
      el('p', { class: 'page-subtitle' }, 'Every signed, draft, or cancelled contract across Sales — cancel a signed contract or open its payment schedule.'),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const thresholdInput = el('input', { type: 'number', placeholder: 'e.g. 10', step: '0.1', min: '0', max: '100' });
  const savePolicyBtn = el('button', {}, 'Save policy');
  savePolicyBtn.addEventListener('click', async () => {
    clear(errorSlot);
    const threshold = Number(thresholdInput.value);
    if (!(threshold >= 0 && threshold <= 100)) {
      errorSlot.appendChild(errorBanner('Enter a threshold percentage between 0 and 100.'));
      return;
    }
    savePolicyBtn.disabled = true;
    try {
      await api.post('/api/sales/discount-policy', { maxDiscountPercentWithoutApproval: threshold });
      toast('Discount approval policy saved.', 'success');
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      savePolicyBtn.disabled = false;
    }
  });
  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Discount approval policy'),
    el('p', { class: 'page-subtitle' }, 'A discount above this threshold can\'t be applied directly — it creates a pending approval on the Approvals page instead. Leave unconfigured for no gate at all.'),
    el('div', { class: 'form-row' }, [el('div', {}, [el('label', {}, 'Max discount without approval (%)'), thresholdInput])]),
    el('div', { class: 'form-actions' }, [savePolicyBtn]),
  ]));
  (async () => {
    try {
      const policy = await api.get('/api/sales/discount-policy');
      thresholdInput.value = policy.maxDiscountPercentWithoutApproval;
    } catch {
      // No policy configured yet — leave the field blank, matching "no gate at all".
    }
  })();

  const listSlot = el('div');
  container.appendChild(listSlot);

  async function viewSchedule(contract) {
    try {
      const lines = await api.get(`/api/contracts/${contract.id}/payment-schedule`);
      const modal = el('div', { class: 'modal-overlay' });
      const card = el('div', { class: 'modal-card', style: 'width:560px' }, [
        el('h3', { class: 'modal-title' }, `Payment schedule — contract ${contract.id.slice(0, 8)}…`),
        table(
          [
            { label: 'Line', key: 'label' },
            { label: 'Due date', render: (l) => new Date(l.dueDate).toLocaleDateString() },
            { label: 'Amount', render: (l) => Number(l.amount).toLocaleString() },
            { label: 'Paid', render: (l) => Number(l.amountPaid).toLocaleString() },
            { label: 'Status', render: (l) => statusBadge(l.status) },
          ],
          lines,
          { empty: 'No schedule lines for this contract yet — generate one from Payment Plans.' },
        ),
        el('div', { class: 'form-actions', style: 'justify-content:flex-end' }, [
          (() => { const b = el('button', { class: 'primary' }, 'Close'); b.addEventListener('click', () => modal.remove()); return b; })(),
        ]),
      ]);
      modal.appendChild(card);
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
      document.body.appendChild(modal);
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function cancelContract(contract) {
    if (!(await confirmModal('Cancel this contract? The unit is released back onto the market and its reservation is cancelled. Already-recorded payments stay on file.', { confirmLabel: 'Cancel contract', danger: true }))) return;
    try {
      await api.post(`/api/sales/contracts/${contract.id}/cancel`, {});
      toast('Contract cancelled.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  // Every amendment requires approval — no threshold escape, unlike the
  // discount-override gate on signing — so this always returns 202 with
  // a pending ActionApproval, never a directly-applied change.
  async function amendContract(contract) {
    const result = await formModal({
      title: `Amend contract ${contract.id.slice(0, 8)}…`,
      fields: [
        { key: 'newTotalPrice', label: 'New total contract price', type: 'number', value: String(contract.totalPrice ?? '') },
        { key: 'discountPercent', label: 'Discount (%, optional)', type: 'number' },
        { key: 'reason', label: 'Reason for this amendment', type: 'textarea' },
      ],
      submitLabel: 'Submit for approval',
    });
    if (!result || !result.newTotalPrice || !result.reason) return;
    try {
      await api.post(`/api/sales/contracts/${contract.id}/amend`, {
        newTotalPrice: Number(result.newTotalPrice),
        discountPercent: result.discountPercent ? Number(result.discountPercent) : undefined,
        reason: result.reason,
      });
      toast('Amendment request submitted — pending approval. See the Approvals page for its status.', 'success');
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const [contractsPage, leadsPage, unitsPage] = await Promise.all([
        api.get('/api/sales/contracts', { limit: 20, offset }),
        api.get('/api/crm/leads', { limit: 200 }),
        api.get('/api/inventory/units', { limit: 200 }),
      ]);
      const leadById = new Map(leadsPage.items.map((l) => [l.id, l]));
      const unitById = new Map(unitsPage.items.map((u) => [u.id, u]));
      clear(listSlot);
      listSlot.appendChild(table(
        [
          { label: 'Client', render: (c) => leadById.get(c.clientId)?.fullName ?? c.clientId },
          { label: 'Unit', render: (c) => unitById.get(c.unitId)?.code ?? c.unitId },
          { label: 'Status', render: (c) => statusBadge(c.status) },
          { label: 'Created', render: (c) => new Date(c.createdAt).toLocaleDateString() },
          { label: '', render: (c) => {
            const wrap = el('div', { style: 'display:flex;gap:6px' });
            const scheduleBtn = el('button', {}, 'Schedule');
            scheduleBtn.addEventListener('click', () => viewSchedule(c));
            wrap.appendChild(scheduleBtn);
            if (c.status === 'signed') {
              const amendBtn = el('button', {}, 'Amend');
              amendBtn.addEventListener('click', () => amendContract(c));
              wrap.appendChild(amendBtn);
              const cancelBtn = el('button', { class: 'danger' }, 'Cancel');
              cancelBtn.addEventListener('click', () => cancelContract(c));
              wrap.appendChild(cancelBtn);
            }
            return wrap;
          } },
        ],
        contractsPage.items,
        { empty: 'No contracts yet — sign one from an Offer once a unit is reserved.', emptyIcon: 'contracts' },
      ));
      listSlot.appendChild(paginationControls(contractsPage, (next) => { offset = next; load(); }));
    } catch (err) {
      clear(listSlot);
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
