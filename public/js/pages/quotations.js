import { el, clear, table, toast, errorBanner, statusBadge, selectInput, loadingState, formModal } from '../ui.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { can, getLocale } from '../state.js';

/**
 * The live preview and the "Generate" persist call both go through
 * /api/quotations/calculate and /api/quotations respectively, which are
 * thin wrappers around PaymentPlansService.previewSchedule (see
 * quotation.service.ts) — the same engine that powers the Templates page's
 * own preview and every signed contract's real schedule. There is no
 * second calculation path here.
 */
export async function renderQuotations(container) {
  clear(container);
  const locale = getLocale();
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, t(locale, 'page_title_quotations'))));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  let units = [];
  let templates = [];
  let lastCalculation = null;

  const unitSelect = selectInput([]);
  const templateSelect = selectInput([]);
  const discountInput = el('input', { type: 'number', placeholder: '0', value: '0' });
  const escalationInput = el('input', { type: 'number', placeholder: '0', value: '0' });
  const totalOverrideInput = el('input', { type: 'number', placeholder: t(locale, 'quotations_total_override_placeholder') });
  const leadIdInput = el('input', { type: 'text', placeholder: t(locale, 'quotations_lead_id_placeholder') });
  const calcBtn = el('button', {}, t(locale, 'quotations_calc_btn'));
  const generateBtn = el('button', { class: 'primary' }, t(locale, 'quotations_generate_btn'));
  generateBtn.disabled = true;

  const previewSlot = el('div');

  function renderPreview(calc) {
    clear(previewSlot);
    if (!calc) return;
    previewSlot.appendChild(el('div', { class: 'stat-grid' }, [
      el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(calc.totalPrice).toLocaleString()), el('div', { class: 'label' }, t(locale, 'quotations_stat_total_price'))]),
      el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(calc.netValue).toLocaleString()), el('div', { class: 'label' }, t(locale, 'quotations_stat_net_value'))]),
      el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(calc.downPayment).toLocaleString()), el('div', { class: 'label' }, t(locale, 'quotations_stat_down_payment'))]),
      el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, String(calc.schedule.length)), el('div', { class: 'label' }, t(locale, 'quotations_stat_installments'))]),
    ]));
    previewSlot.appendChild(table(
      [
        { label: '#', render: (l) => String(l.sequence) },
        { label: t(locale, 'quotations_col_label'), key: 'label' },
        { label: t(locale, 'sales_col_due_date'), render: (l) => new Date(l.dueDate).toLocaleDateString() },
        { label: t(locale, 'sales_col_amount'), render: (l) => Number(l.amount).toLocaleString() },
      ],
      calc.schedule,
      { empty: t(locale, 'quotations_schedule_empty') },
    ));
  }

  calcBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!unitSelect.value || !templateSelect.value) {
      errorSlot.appendChild(errorBanner(t(locale, 'quotations_err_choose_unit_template')));
      return;
    }
    calcBtn.disabled = true;
    try {
      const calc = await api.post('/api/quotations/calculate', {
        unitId: unitSelect.value,
        paymentPlanTemplateId: templateSelect.value,
        discountPercent: Number(discountInput.value) || 0,
        escalationPercentPerYear: Number(escalationInput.value) || 0,
        totalPriceOverride: totalOverrideInput.value ? Number(totalOverrideInput.value) : undefined,
      });
      lastCalculation = calc;
      generateBtn.disabled = false;
      renderPreview(calc);
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      calcBtn.disabled = false;
    }
  });

  generateBtn.addEventListener('click', async () => {
    clear(errorSlot);
    generateBtn.disabled = true;
    try {
      const quotation = await api.post('/api/quotations', {
        unitId: unitSelect.value,
        paymentPlanTemplateId: templateSelect.value,
        discountPercent: Number(discountInput.value) || 0,
        escalationPercentPerYear: Number(escalationInput.value) || 0,
        totalPriceOverride: totalOverrideInput.value ? Number(totalOverrideInput.value) : undefined,
        leadId: leadIdInput.value.trim() || undefined,
      });
      toast(`${t(locale, 'quotations_toast_generated_prefix')} ${quotation.referenceNumber} (v${quotation.version})${t(locale, 'quotations_toast_generated_suffix')}`, 'success');
      await loadQuotations();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      generateBtn.disabled = false;
    }
  });

  if (can('quotation', 'create')) {
    container.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, t(locale, 'quotations_generate_heading')),
      el('div', { class: 'form-row' }, [
        el('div', {}, [el('label', {}, t(locale, 'sales_col_unit')), unitSelect]),
        el('div', {}, [el('label', {}, t(locale, 'sales_payment_plan_template_field')), templateSelect]),
        el('div', {}, [el('label', {}, t(locale, 'quotations_discount_percent_field')), discountInput]),
        el('div', {}, [el('label', {}, t(locale, 'quotations_escalation_field')), escalationInput]),
        el('div', {}, [el('label', {}, t(locale, 'quotations_total_price_override_field')), totalOverrideInput]),
        el('div', {}, [el('label', {}, t(locale, 'quotations_lead_id_field')), leadIdInput]),
      ]),
      el('div', { class: 'form-actions' }, [calcBtn, generateBtn]),
      previewSlot,
    ]));
  }

  const listSlot = el('div');
  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'quotations_history_heading')),
    listSlot,
  ]));

  function downloadBase64(filename, contentType, base64) {
    const byteChars = atob(base64);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    const blob = new Blob([bytes], { type: contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function downloadExcel(quotation) {
    try {
      const result = await api.get(`/api/quotations/${quotation.id}/excel`);
      downloadBase64(result.filename, result.contentType, result.base64);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function openPrintView(quotation) {
    try {
      const result = await api.get(`/api/quotations/${quotation.id}/print`);
      const win = window.open('', '_blank');
      if (!win) {
        toast(t(locale, 'quotations_err_allow_popups'), 'error');
        return;
      }
      win.document.write(result.html);
      win.document.close();
      win.focus();
      win.print();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // Real branded PDF (project images, payment schedule, master-plan with
  // the unit highlighted, floor plan) and real WhatsApp document send —
  // the same Offer engine the CRM Lead detail's "Price Offer" card uses
  // (quotation.service.ts / offer-pdf.service.ts). "Share" above only
  // logs a text link; these two send/download the actual PDF.
  async function downloadOfferPdf(quotation) {
    try {
      const result = await api.get(`/api/quotations/${quotation.id}/pdf`);
      downloadBase64(result.filename, result.contentType, result.base64);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function sendOfferWhatsApp(quotation) {
    const values = await formModal({
      title: `${t(locale, 'crm_offer_send_whatsapp_title_prefix')} ${quotation.referenceNumber} ${t(locale, 'crm_offer_send_whatsapp_title_suffix')}`,
      fields: [
        { key: 'to', label: t(locale, 'crm_offer_whatsapp_number_field'), type: 'text' },
        { key: 'message', label: t(locale, 'crm_offer_message_field'), type: 'textarea', value: `${t(locale, 'quotations_msg_greeting_prefix')} ${quotation.referenceNumber}${t(locale, 'quotations_msg_plain_suffix')}` },
      ],
      submitLabel: t(locale, 'crm_send_btn'),
    });
    if (!values || !values.to?.trim()) return;
    try {
      await api.post(`/api/quotations/${quotation.id}/send-whatsapp`, { to: values.to.trim(), message: values.message });
      toast(t(locale, 'crm_offer_sent_whatsapp_toast'), 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function shareQuotation(quotation) {
    const values = await formModal({
      title: `${t(locale, 'quotations_share_title_prefix')} ${quotation.referenceNumber}`,
      fields: [
        { key: 'channel', label: t(locale, 'quotations_channel_field'), type: 'select', options: [{ value: 'whatsapp', label: t(locale, 'crm_channel_whatsapp') }, { value: 'email', label: t(locale, 'field_email') }] },
        { key: 'contact', label: t(locale, 'quotations_share_contact_field'), type: 'text' },
        { key: 'message', label: t(locale, 'crm_offer_message_field'), type: 'textarea', value: `${t(locale, 'quotations_msg_greeting_prefix')} ${quotation.referenceNumber}${t(locale, 'quotations_msg_for_review_suffix')}` },
      ],
      submitLabel: t(locale, 'quotations_share_btn'),
    });
    if (!values) return;
    try {
      await api.post(`/api/quotations/${quotation.id}/share`, { channel: values.channel, message: values.message });
      if (values.channel === 'whatsapp' && values.contact) {
        const digits = values.contact.replace(/[^0-9]/g, '');
        const waUrl = `https://wa.me/${digits}?text=${encodeURIComponent(values.message)}`;
        window.open(waUrl, '_blank');
      }
      toast(t(locale, 'quotations_toast_share_logged'), 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function updateStatus(quotation, status) {
    try {
      await api.patch(`/api/quotations/${quotation.id}/status`, { status });
      toast(`${t(locale, 'quotations_toast_marked_prefix')} ${status}.`, 'success');
      await loadQuotations();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function loadQuotations() {
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/quotations', { limit: 50 });
      clear(listSlot);
      listSlot.appendChild(table(
        [
          { label: t(locale, 'crm_offer_col_reference'), key: 'referenceNumber' },
          { label: t(locale, 'quotations_col_version'), render: (q) => `v${q.version}` },
          { label: t(locale, 'sales_col_unit'), key: 'unitId' },
          { label: t(locale, 'units_col_status'), render: (q) => statusBadge(q.status) },
          { label: t(locale, 'automation_col_created'), render: (q) => new Date(q.createdAt).toLocaleString() },
          { label: '', render: (q) => {
            const excelBtn = el('button', {}, t(locale, 'quotations_excel_btn'));
            excelBtn.addEventListener('click', () => downloadExcel(q));
            const printBtn = el('button', {}, t(locale, 'quotations_print_pdf_btn'));
            printBtn.addEventListener('click', () => openPrintView(q));
            const offerPdfBtn = el('button', {}, t(locale, 'quotations_print_pdf_only_btn'));
            offerPdfBtn.addEventListener('click', () => downloadOfferPdf(q));
            const actions = [excelBtn, printBtn, offerPdfBtn];
            if (can('quotation', 'edit')) {
              const shareBtn = el('button', {}, t(locale, 'quotations_share_btn'));
              shareBtn.addEventListener('click', () => shareQuotation(q));
              actions.push(shareBtn);
              const waBtn = el('button', {}, t(locale, 'quotations_send_whatsapp_btn'));
              waBtn.addEventListener('click', () => sendOfferWhatsApp(q));
              actions.push(waBtn);
              if (q.status === 'generated') {
                const sentBtn = el('button', {}, t(locale, 'quotations_mark_sent_btn'));
                sentBtn.addEventListener('click', () => updateStatus(q, 'sent'));
                actions.push(sentBtn);
              }
              if (q.status === 'sent') {
                const acceptBtn = el('button', {}, t(locale, 'quotations_mark_accepted_btn'));
                acceptBtn.addEventListener('click', () => updateStatus(q, 'accepted'));
                actions.push(acceptBtn);
              }
            }
            return el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, actions);
          } },
        ],
        page.items,
        { empty: t(locale, 'quotations_empty') },
      ));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  async function loadPickers() {
    try {
      const [unitsPage, templatesPage] = await Promise.all([
        api.get('/api/inventory/units', { limit: 200 }),
        api.get('/api/payment-plan-templates', { limit: 100 }),
      ]);
      units = unitsPage.items;
      templates = templatesPage.items;
      clear(unitSelect);
      units.forEach((u) => unitSelect.appendChild(el('option', { value: u.id }, `${u.code} — ${u.unitType} (${Number(u.listPrice).toLocaleString()})`)));
      clear(templateSelect);
      templates.forEach((t) => templateSelect.appendChild(el('option', { value: t.id }, t.name)));
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  await loadPickers();
  await loadQuotations();
}
