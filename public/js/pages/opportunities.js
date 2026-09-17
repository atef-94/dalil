import { el, clear, table, toast, errorBanner, statusBadge, selectInput, formModal, loadingState, paginationControls } from '../ui.js';
import { api } from '../api.js';

// Tracks reservationId + unit price per opportunity for this browser session,
// since the reservation isn't otherwise addressable from the opportunity
// record alone. Good enough for the sign-in-one-sitting workflow this page
// is built around.
const sessionReservations = new Map();

export async function renderOpportunities(container) {
  clear(container);
  let offset = 0;
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, 'Sales Opportunities')));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const leadSelect = selectInput([], { id: 'opp-lead-select' });
  const createBtn = el('button', { class: 'primary' }, 'Create opportunity');
  createBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!leadSelect.value) {
      errorSlot.appendChild(errorBanner('No qualified lead selected — qualify a lead in Leads first.'));
      return;
    }
    createBtn.disabled = true;
    try {
      await api.post('/api/sales/opportunities', { leadId: leadSelect.value });
      toast('Opportunity created.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createBtn.disabled = false;
    }
  });
  const createCard = el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Create an opportunity from a qualified lead'),
    el('div', { class: 'form-row' }, [el('div', {}, [el('label', {}, 'Lead'), leadSelect])]),
    el('div', { class: 'form-actions' }, [createBtn]),
  ]);
  container.appendChild(createCard);

  const listSlot = el('div');
  container.appendChild(listSlot);

  async function reserveUnit(opportunity) {
    try {
      const unitsPage = await api.get('/api/inventory/units', { limit: 100 });
      const available = unitsPage.items.filter((u) => u.status === 'available');
      if (available.length === 0) {
        errorSlot.appendChild(errorBanner('No available units to reserve. Add one in Inventory first.'));
        return;
      }
      const result = await formModal({
        title: 'Reserve a unit',
        fields: [{
          key: 'unitId',
          label: 'Unit',
          type: 'select',
          options: available.map((u) => ({ value: u.id, label: `${u.code} — ${Number(u.listPrice).toLocaleString()}` })),
        }],
        submitLabel: 'Reserve',
      });
      if (!result || !result.unitId) return;
      const unit = available.find((u) => u.id === result.unitId);
      const reservation = await api.post(`/api/sales/opportunities/${opportunity.id}/reserve-unit`, { unitId: unit.id });
      sessionReservations.set(opportunity.id, { reservationId: reservation.id, unitPrice: unit.listPrice });
      toast('Unit reserved.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function signContract(opportunity) {
    const cached = sessionReservations.get(opportunity.id);
    if (!cached) {
      errorSlot.appendChild(errorBanner('Reservation not found in this browser session — reserve a unit for this opportunity again first (the reservation isn’t otherwise addressable from the opportunity alone).'));
      return;
    }
    try {
      const templatesPage = await api.get('/api/payment-plan-templates', { limit: 100 });
      if (templatesPage.items.length === 0) {
        errorSlot.appendChild(errorBanner('No payment plan templates exist yet. Create one in Payment Plans first.'));
        return;
      }
      const result = await formModal({
        title: 'Sign contract',
        fields: [
          {
            key: 'templateId',
            label: 'Payment plan template',
            type: 'select',
            options: templatesPage.items.map((t) => ({ value: t.id, label: t.name })),
          },
          { key: 'totalPrice', label: 'Total contract price', type: 'number', value: String(cached.unitPrice) },
          { key: 'discountPercent', label: 'Discount (%, optional)', type: 'number' },
        ],
        submitLabel: 'Sign contract',
      });
      if (!result || !result.templateId || !result.totalPrice) return;
      const response = await api.post('/api/sales/contracts', {
        reservationId: cached.reservationId,
        paymentPlanTemplateId: result.templateId,
        totalPrice: Number(result.totalPrice),
        discountPercent: result.discountPercent ? Number(result.discountPercent) : undefined,
      });
      // A discount above the company's configured threshold returns a
      // pending ActionApproval (HTTP 202) instead of a signed Contract
      // (HTTP 201) — only the latter has no actionType.
      if (response.actionType) {
        toast('Discount exceeds the no-approval threshold — sent for approval instead of signing.', 'success');
      } else {
        toast(`Contract signed (${response.id.slice(0, 8)}…).`, 'success');
      }
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const [leadsPage, oppsPage] = await Promise.all([
        api.get('/api/crm/leads', { limit: 200 }),
        api.get('/api/sales/opportunities', { limit: 20, offset }),
      ]);
      const qualified = leadsPage.items.filter((l) => l.status === 'qualified');
      clear(leadSelect);
      qualified.forEach((l) => leadSelect.appendChild(el('option', { value: l.id }, l.fullName)));
      if (qualified.length === 0) {
        leadSelect.appendChild(el('option', { value: '' }, 'No qualified leads yet'));
      }

      clear(listSlot);
      listSlot.appendChild(table(
        [
          { label: 'Lead', render: (o) => leadsPage.items.find((l) => l.id === o.leadId)?.fullName ?? o.leadId },
          { label: 'Stage', render: (o) => statusBadge(o.stage) },
          { label: '', render: (o) => {
            const actions = el('div', { style: 'display:flex;gap:6px' });
            if (o.stage === 'open') {
              const btn = el('button', {}, 'Reserve unit');
              btn.addEventListener('click', () => reserveUnit(o));
              actions.appendChild(btn);
            }
            if (o.stage === 'reserved') {
              const btn = el('button', { class: 'primary' }, 'Sign contract');
              btn.addEventListener('click', () => signContract(o));
              actions.appendChild(btn);
            }
            return actions;
          } },
        ],
        oppsPage.items,
        { empty: 'No opportunities yet.' },
      ));
      listSlot.appendChild(paginationControls(oppsPage, (next) => { offset = next; load(); }));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
