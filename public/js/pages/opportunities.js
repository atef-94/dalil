import { el, clear, table, toast, errorBanner, statusBadge, selectInput, formModal, loadingState, paginationControls } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

// Tracks reservationId + unit price per opportunity for this browser session,
// since the reservation isn't otherwise addressable from the opportunity
// record alone. Good enough for the sign-in-one-sitting workflow this page
// is built around.
const sessionReservations = new Map();

export async function renderOpportunities(container) {
  clear(container);
  const locale = getLocale();
  let offset = 0;
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, t(locale, 'page_title_offers'))));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const leadSelect = selectInput([], { id: 'opp-lead-select' });
  const createBtn = el('button', { class: 'primary' }, t(locale, 'opportunities_create_offer_btn'));
  createBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!leadSelect.value) {
      errorSlot.appendChild(errorBanner(t(locale, 'opportunities_err_no_qualified_lead')));
      return;
    }
    createBtn.disabled = true;
    try {
      await api.post('/api/sales/opportunities', { leadId: leadSelect.value });
      toast(t(locale, 'opportunities_toast_offer_created'), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createBtn.disabled = false;
    }
  });
  const createCard = el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'opportunities_create_heading')),
    el('div', { class: 'form-row' }, [el('div', {}, [el('label', {}, t(locale, 'opportunities_lead_field')), leadSelect])]),
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
        errorSlot.appendChild(errorBanner(t(locale, 'opportunities_err_no_available_units')));
        return;
      }
      const result = await formModal({
        title: t(locale, 'opportunities_reserve_unit_title'),
        fields: [{
          key: 'unitId',
          label: t(locale, 'sales_col_unit'),
          type: 'select',
          options: available.map((u) => ({ value: u.id, label: `${u.code} — ${Number(u.listPrice).toLocaleString()}` })),
        }],
        submitLabel: t(locale, 'opportunities_reserve_btn'),
      });
      if (!result || !result.unitId) return;
      const unit = available.find((u) => u.id === result.unitId);
      const reservation = await api.post(`/api/sales/opportunities/${opportunity.id}/reserve-unit`, { unitId: unit.id });
      sessionReservations.set(opportunity.id, { reservationId: reservation.id, unitPrice: unit.listPrice });
      toast(t(locale, 'opportunities_toast_unit_reserved'), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function signContract(opportunity) {
    const cached = sessionReservations.get(opportunity.id);
    if (!cached) {
      errorSlot.appendChild(errorBanner(t(locale, 'opportunities_err_reservation_not_found')));
      return;
    }
    try {
      const templatesPage = await api.get('/api/payment-plan-templates', { limit: 100 });
      if (templatesPage.items.length === 0) {
        errorSlot.appendChild(errorBanner(t(locale, 'opportunities_err_no_templates')));
        return;
      }
      const result = await formModal({
        title: t(locale, 'opportunities_sign_contract_btn'),
        fields: [
          {
            key: 'templateId',
            label: t(locale, 'sales_payment_plan_template_field'),
            type: 'select',
            options: templatesPage.items.map((tpl) => ({ value: tpl.id, label: tpl.name })),
          },
          { key: 'totalPrice', label: t(locale, 'opportunities_total_contract_price_field'), type: 'number', value: String(cached.unitPrice) },
          { key: 'discountPercent', label: t(locale, 'sales_discount_percent_optional_field'), type: 'number' },
        ],
        submitLabel: t(locale, 'opportunities_sign_contract_btn'),
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
        toast(t(locale, 'opportunities_toast_discount_exceeds'), 'success');
      } else {
        toast(`${t(locale, 'opportunities_toast_contract_signed_prefix')} (${response.id.slice(0, 8)}…).`, 'success');
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
      const [leadsPage, oppsPage, stages] = await Promise.all([
        api.get('/api/crm/leads', { limit: 200 }),
        api.get('/api/sales/opportunities', { limit: 20, offset }),
        api.get('/api/crm/stages'),
      ]);
      // Leads moved to the configurable CRM stage engine (stageId), which
      // replaced the old fixed status enum — 'qualified' is the seeded
      // default stage's stable key, not a status string.
      const qualifiedStage = stages.find((s) => s.key === 'qualified');
      const qualified = qualifiedStage
        ? leadsPage.items.filter((l) => l.stageId === qualifiedStage.id)
        : leadsPage.items.filter((l) => l.status === 'qualified');
      clear(leadSelect);
      qualified.forEach((l) => leadSelect.appendChild(el('option', { value: l.id }, l.fullName)));
      if (qualified.length === 0) {
        leadSelect.appendChild(el('option', { value: '' }, t(locale, 'opportunities_no_qualified_leads_option')));
      }

      clear(listSlot);
      listSlot.appendChild(table(
        [
          { label: t(locale, 'opportunities_lead_field'), render: (o) => leadsPage.items.find((l) => l.id === o.leadId)?.fullName ?? o.leadId },
          { label: t(locale, 'opportunities_col_stage'), render: (o) => statusBadge(o.stage) },
          { label: '', render: (o) => {
            const actions = el('div', { style: 'display:flex;gap:6px' });
            if (o.stage === 'open') {
              const btn = el('button', {}, t(locale, 'opportunities_reserve_unit_btn'));
              btn.addEventListener('click', () => reserveUnit(o));
              actions.appendChild(btn);
            }
            if (o.stage === 'reserved') {
              const btn = el('button', { class: 'primary' }, t(locale, 'opportunities_sign_contract_btn'));
              btn.addEventListener('click', () => signContract(o));
              actions.appendChild(btn);
            }
            return actions;
          } },
        ],
        oppsPage.items,
        { empty: t(locale, 'opportunities_empty') },
      ));
      listSlot.appendChild(paginationControls(oppsPage, (next) => { offset = next; load(); }));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
