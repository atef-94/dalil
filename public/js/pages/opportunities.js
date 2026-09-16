import { el, clear, table, toast, errorBanner, statusBadge, selectInput } from '../ui.js';
import { api } from '../api.js';

// Tracks reservationId + unit price per opportunity for this browser session,
// since the reservation isn't otherwise addressable from the opportunity
// record alone. Good enough for the sign-in-one-sitting workflow this page
// is built around.
const sessionReservations = new Map();

export async function renderOpportunities(container) {
  clear(container);
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, 'Sales Opportunities')));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const leadSelect = selectInput([], { id: 'opp-lead-select' });
  const createBtn = el('button', { class: 'primary' }, 'Create opportunity');
  createBtn.addEventListener('click', async () => {
    if (!leadSelect.value) return;
    try {
      await api.post('/api/sales/opportunities', { leadId: leadSelect.value });
      toast('Opportunity created.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
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
      const codes = available.map((u) => `${u.code} (${Number(u.listPrice).toLocaleString()})`).join(', ');
      const chosenCode = window.prompt(`Which unit code to reserve? Available: ${codes}`);
      const unit = available.find((u) => u.code === chosenCode?.trim());
      if (!unit) return;
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
      errorSlot.appendChild(errorBanner('Reservation not found in this session — reserve a unit for this opportunity again first.'));
      return;
    }
    try {
      const templatesPage = await api.get('/api/payment-plan-templates', { limit: 100 });
      if (templatesPage.items.length === 0) {
        errorSlot.appendChild(errorBanner('No payment plan templates exist yet. Create one in Payment Plans first.'));
        return;
      }
      const names = templatesPage.items.map((t) => t.name).join(', ');
      const chosenName = window.prompt(`Which payment plan template? Available: ${names}`, templatesPage.items[0].name);
      const template = templatesPage.items.find((t) => t.name === chosenName?.trim());
      if (!template) return;
      const priceStr = window.prompt('Total contract price:', String(cached.unitPrice));
      if (!priceStr) return;
      const contract = await api.post('/api/sales/contracts', {
        reservationId: cached.reservationId,
        paymentPlanTemplateId: template.id,
        totalPrice: Number(priceStr),
      });
      toast(`Contract signed (${contract.id.slice(0, 8)}…).`, 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    clear(listSlot);
    try {
      const [leadsPage, oppsPage] = await Promise.all([
        api.get('/api/crm/leads', { limit: 200 }),
        api.get('/api/sales/opportunities', { limit: 50 }),
      ]);
      const qualified = leadsPage.items.filter((l) => l.status === 'qualified');
      clear(leadSelect);
      qualified.forEach((l) => leadSelect.appendChild(el('option', { value: l.id }, l.fullName)));
      if (qualified.length === 0) {
        leadSelect.appendChild(el('option', { value: '' }, 'No qualified leads yet'));
      }

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
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
