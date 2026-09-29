import { el, clear, table, toast, errorBanner, statusBadge, selectInput, loadingState, formModal } from '../ui.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { can, getLocale } from '../state.js';
import { renderTemplates } from './templates.js';

/**
 * The unified Payment Plan workspace (Payment Plan Redesign spec): what
 * used to be two separate CRM sub-tabs — "Payment Plans" (reusable
 * PaymentPlanTemplate CRUD) and "Quotations" (per-unit priced offers) —
 * merged into one page, per the user's explicit confirmed choice. A
 * Payment Plan here is always a Quotation under the hood: either linked to
 * a reusable PaymentPlanTemplate, or built from one-off "custom terms"
 * that the backend persists as a single-use (adHoc) template exactly once,
 * at Generate time — never on every live-preview keystroke (see
 * quotation.service.ts's inlineTerms handling). Reusable-template CRUD
 * itself is folded in below as a collapsed, admin-only section reusing
 * templates.js's existing renderTemplates() unchanged.
 *
 * The live preview and the "Generate" persist call both go through
 * /api/quotations/calculate and /api/quotations respectively, which are
 * thin wrappers around the same schedule-generator.ts engine that powers
 * every signed contract's real schedule. There is no second calculation
 * path here.
 */

const FREQUENCIES = ['monthly', 'quarterly', 'semiannual', 'annual', 'custom'];
const FREQUENCY_LABEL_KEYS = { monthly: 'scenario_frequency_monthly', quarterly: 'scenario_frequency_quarterly', semiannual: 'scenario_frequency_semiannual', annual: 'scenario_frequency_annual', custom: 'templates_frequency_custom' };
const PAYMENT_TYPE_LABEL_KEYS = { down_payment: 'pp_type_down_payment', installment: 'pp_type_installment', scheduled_payment: 'pp_type_scheduled_payment', fee: 'pp_type_fee' };

export async function renderQuotations(container) {
  clear(container);
  const locale = getLocale();
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, t(locale, 'page_title_payment_plans'))));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  let units = [];
  let templates = [];
  let lastCalculation = null;
  let unitMode = 'inventory'; // 'inventory' | 'manual'
  let termsMode = 'template'; // 'template' | 'custom'
  let scheduledPayments = []; // {id, amount, dueDate, label}

  function stat(value, label) {
    return el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, value), el('div', { class: 'label' }, label)]);
  }

  // ---- Unit source: pick from Inventory, or enter manually (spec 2A/2B) ----
  const unitSelect = selectInput([]);
  const manualCodeInput = el('input', { type: 'text', placeholder: 'B2-304' });
  const manualUnitTypeInput = el('input', { type: 'text', placeholder: t(locale, 'pp_unit_type_placeholder') });
  const manualAreaInput = el('input', { type: 'number', placeholder: '120' });
  const manualPriceInput = el('input', { type: 'number', placeholder: '2000000' });
  const manualMaintenanceInput = el('input', { type: 'number', placeholder: '8' });
  const manualParkingIncludedCheckbox = el('input', { type: 'checkbox' });
  const manualParkingSpacesInput = el('input', { type: 'number', placeholder: '1' });
  const manualParkingPriceInput = el('input', { type: 'number', placeholder: '150000' });
  const manualProjectIdInput = el('input', { type: 'text', placeholder: t(locale, 'pp_project_optional_placeholder') });

  const unitInventoryFields = el('div', { class: 'form-row' }, [
    el('div', {}, [el('label', {}, t(locale, 'sales_col_unit')), unitSelect]),
  ]);
  const unitManualFields = el('div', { class: 'form-row', style: 'display:none' }, [
    el('div', {}, [el('label', {}, t(locale, 'pp_unit_code_field')), manualCodeInput]),
    el('div', {}, [el('label', {}, t(locale, 'units_col_type')), manualUnitTypeInput]),
    el('div', {}, [el('label', {}, t(locale, 'pp_area_field')), manualAreaInput]),
    el('div', {}, [el('label', {}, t(locale, 'pp_total_price_field')), manualPriceInput]),
    el('div', {}, [el('label', {}, t(locale, 'pp_maintenance_fee_percent_field')), manualMaintenanceInput]),
    el('div', {}, [el('label', {}, t(locale, 'pp_parking_included_field')), manualParkingIncludedCheckbox]),
    el('div', {}, [el('label', {}, t(locale, 'pp_parking_spaces_field')), manualParkingSpacesInput]),
    el('div', {}, [el('label', {}, t(locale, 'pp_parking_price_field')), manualParkingPriceInput]),
    el('div', {}, [el('label', {}, t(locale, 'pp_project_optional_field')), manualProjectIdInput]),
  ]);
  const unitModeSelect = selectInput([
    { value: 'inventory', label: t(locale, 'pp_unit_source_inventory') },
    { value: 'manual', label: t(locale, 'pp_unit_source_manual') },
  ]);
  unitModeSelect.addEventListener('change', () => {
    unitMode = unitModeSelect.value;
    unitInventoryFields.style.display = unitMode === 'inventory' ? '' : 'none';
    unitManualFields.style.display = unitMode === 'manual' ? '' : 'none';
  });

  // ---- Payment terms source: reusable Template, or Custom Terms ----
  const templateSelect = selectInput([]);
  const customDpTypeSelect = selectInput([
    { value: 'percentage', label: t(locale, 'scenario_down_payment_type_percentage_option') },
    { value: 'fixed', label: t(locale, 'templates_dp_type_fixed_label') },
  ]);
  const customDpValueInput = el('input', { type: 'number', placeholder: '10' });
  const customFrequencySelect = selectInput(FREQUENCIES.map((f) => ({ value: f, label: t(locale, FREQUENCY_LABEL_KEYS[f]) })));
  const customIntervalInput = el('input', { type: 'number', placeholder: '2' });
  const customTermInput = el('input', { type: 'number', placeholder: '60' });
  const customMethodSelect = selectInput([
    { value: 'equal_installments', label: t(locale, 'pp_method_equal') },
    { value: 'installments_plus_scheduled', label: t(locale, 'pp_method_scheduled') },
  ]);
  const customRecurringAmountInput = el('input', { type: 'number', placeholder: t(locale, 'pp_recurring_amount_auto_placeholder') });

  const scheduledPaymentsListEl = el('div');
  function renderScheduledPaymentsList() {
    clear(scheduledPaymentsListEl);
    if (scheduledPayments.length === 0) {
      scheduledPaymentsListEl.appendChild(el('p', { style: 'color:var(--text-muted);font-size:12.5px;margin:4px 0' }, t(locale, 'pp_no_scheduled_payments')));
      return;
    }
    scheduledPayments.forEach((sp, idx) => {
      const removeBtn = el('button', {}, t(locale, 'common_remove'));
      removeBtn.addEventListener('click', () => { scheduledPayments.splice(idx, 1); renderScheduledPaymentsList(); });
      scheduledPaymentsListEl.appendChild(el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:6px;font-size:13px' }, [
        el('span', { style: 'flex:1' }, `${new Date(sp.dueDate).toLocaleDateString()} — ${Number(sp.amount).toLocaleString()}${sp.label ? ` (${sp.label})` : ''}`),
        removeBtn,
      ]));
    });
  }
  const newSpDateInput = el('input', { type: 'date' });
  const newSpAmountInput = el('input', { type: 'number', placeholder: '200000' });
  const newSpLabelInput = el('input', { type: 'text', placeholder: t(locale, 'pp_scheduled_payment_label_placeholder') });
  const addSpBtn = el('button', {}, t(locale, 'pp_add_scheduled_payment_btn'));
  addSpBtn.addEventListener('click', () => {
    if (!newSpDateInput.value || !(Number(newSpAmountInput.value) > 0)) {
      toast(t(locale, 'pp_scheduled_payment_required_error'), 'error');
      return;
    }
    scheduledPayments.push({
      id: `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      amount: Number(newSpAmountInput.value),
      dueDate: new Date(newSpDateInput.value).toISOString(),
      label: newSpLabelInput.value.trim() || undefined,
    });
    newSpDateInput.value = ''; newSpAmountInput.value = ''; newSpLabelInput.value = '';
    renderScheduledPaymentsList();
  });
  const scheduledPaymentsSection = el('div', { style: 'display:none;margin-top:10px' }, [
    el('label', {}, t(locale, 'pp_scheduled_payments_label')),
    scheduledPaymentsListEl,
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'pp_scheduled_payment_date_field')), newSpDateInput]),
      el('div', {}, [el('label', {}, t(locale, 'pp_scheduled_payment_amount_field')), newSpAmountInput]),
      el('div', {}, [el('label', {}, t(locale, 'pp_scheduled_payment_label_field')), newSpLabelInput]),
    ]),
    el('div', { class: 'form-actions' }, [addSpBtn]),
  ]);
  const recurringAmountRow = el('div', { style: 'display:none' }, [el('label', {}, t(locale, 'pp_recurring_installment_amount_field')), customRecurringAmountInput]);
  customMethodSelect.addEventListener('change', () => {
    const scheduled = customMethodSelect.value === 'installments_plus_scheduled';
    recurringAmountRow.style.display = scheduled ? '' : 'none';
    scheduledPaymentsSection.style.display = scheduled ? '' : 'none';
  });

  const termsTemplateFields = el('div', { class: 'form-row' }, [
    el('div', {}, [el('label', {}, t(locale, 'sales_payment_plan_template_field')), templateSelect]),
  ]);
  const termsCustomFields = el('div', { style: 'display:none' }, [
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'scenario_down_payment_type_field')), customDpTypeSelect]),
      el('div', {}, [el('label', {}, t(locale, 'scenario_down_payment_value_field')), customDpValueInput]),
      el('div', {}, [el('label', {}, t(locale, 'scenario_frequency_field')), customFrequencySelect]),
      el('div', {}, [el('label', {}, t(locale, 'pp_custom_interval_field')), customIntervalInput]),
      el('div', {}, [el('label', {}, t(locale, 'scenario_term_months_field')), customTermInput]),
      el('div', {}, [el('label', {}, t(locale, 'pp_payment_method_field')), customMethodSelect]),
    ]),
    recurringAmountRow,
    scheduledPaymentsSection,
  ]);
  const termsModeSelect = selectInput([
    { value: 'template', label: t(locale, 'pp_terms_source_template') },
    { value: 'custom', label: t(locale, 'pp_terms_source_custom') },
  ]);
  termsModeSelect.addEventListener('change', () => {
    termsMode = termsModeSelect.value;
    termsTemplateFields.style.display = termsMode === 'template' ? '' : 'none';
    termsCustomFields.style.display = termsMode === 'custom' ? '' : 'none';
  });

  const discountInput = el('input', { type: 'number', placeholder: '0', value: '0' });
  const escalationInput = el('input', { type: 'number', placeholder: '0', value: '0' });
  const totalOverrideInput = el('input', { type: 'number', placeholder: t(locale, 'quotations_total_override_placeholder') });
  const leadIdInput = el('input', { type: 'text', placeholder: t(locale, 'quotations_lead_id_placeholder') });
  const calcBtn = el('button', {}, t(locale, 'quotations_calc_btn'));
  const generateBtn = el('button', { class: 'primary' }, t(locale, 'quotations_generate_btn'));
  generateBtn.disabled = true;

  const previewSlot = el('div');

  function renderValidationBanner(validation) {
    if (!validation) return null;
    if (validation.isValid) {
      return el('div', { class: 'pp-validation-banner pp-validation-ok' }, t(locale, 'pp_validation_balanced'));
    }
    if (validation.overpayment > 0) {
      return el('div', { class: 'pp-validation-banner pp-validation-error' }, `${t(locale, 'pp_validation_overpayment_prefix')} ${Number(validation.overpayment).toLocaleString()}`);
    }
    return el('div', { class: 'pp-validation-banner pp-validation-warn' }, `${t(locale, 'pp_validation_remaining_prefix')} ${Number(validation.remainingBalance).toLocaleString()}`);
  }

  function renderPreview(calc) {
    clear(previewSlot);
    if (!calc) return;
    const banner = renderValidationBanner(calc.validation);
    if (banner) previewSlot.appendChild(banner);
    const snap = calc.unitSnapshot;
    const statCards = [
      stat(Number(calc.totalPrice).toLocaleString(), t(locale, 'quotations_stat_total_price')),
      stat(Number(calc.netValue).toLocaleString(), t(locale, 'quotations_stat_net_value')),
      stat(Number(calc.downPayment).toLocaleString(), t(locale, 'quotations_stat_down_payment')),
      stat(String(calc.schedule.length), t(locale, 'quotations_stat_installments')),
    ];
    if (snap) {
      statCards.push(stat(Number(snap.pricePerMeter).toLocaleString(), t(locale, 'pp_stat_price_per_meter')));
      if (snap.maintenanceFeeAmount != null) statCards.push(stat(Number(snap.maintenanceFeeAmount).toLocaleString(), t(locale, 'pp_stat_maintenance')));
    }
    previewSlot.appendChild(el('div', { class: 'stat-grid' }, statCards));
    previewSlot.appendChild(table(
      [
        { label: '#', render: (l) => String(l.sequence + 1) },
        { label: t(locale, 'pp_col_type'), render: (l) => (l.kind && PAYMENT_TYPE_LABEL_KEYS[l.kind] ? t(locale, PAYMENT_TYPE_LABEL_KEYS[l.kind]) : l.label) },
        { label: t(locale, 'quotations_col_label'), key: 'label' },
        { label: t(locale, 'sales_col_due_date'), render: (l) => new Date(l.dueDate).toLocaleDateString() },
        { label: t(locale, 'sales_col_amount'), render: (l) => Number(l.amount).toLocaleString() },
      ],
      calc.schedule,
      { empty: t(locale, 'quotations_schedule_empty') },
    ));
  }

  function buildRequestBody() {
    const body = {
      discountPercent: Number(discountInput.value) || 0,
      escalationPercentPerYear: Number(escalationInput.value) || 0,
      totalPriceOverride: totalOverrideInput.value ? Number(totalOverrideInput.value) : undefined,
    };
    if (unitMode === 'inventory') {
      body.unitId = unitSelect.value;
    } else {
      body.manualUnit = {
        code: manualCodeInput.value.trim(),
        unitType: manualUnitTypeInput.value.trim() || t(locale, 'pp_default_unit_type'),
        areaSqm: Number(manualAreaInput.value),
        listPrice: Number(manualPriceInput.value),
        maintenanceFeePercent: manualMaintenanceInput.value ? Number(manualMaintenanceInput.value) : undefined,
        parkingIncluded: manualParkingIncludedCheckbox.checked,
        parkingSpaces: manualParkingSpacesInput.value ? Number(manualParkingSpacesInput.value) : undefined,
        parkingPrice: manualParkingPriceInput.value ? Number(manualParkingPriceInput.value) : undefined,
      };
      if (manualProjectIdInput.value.trim()) body.manualProjectId = manualProjectIdInput.value.trim();
    }
    if (termsMode === 'template') {
      body.paymentPlanTemplateId = templateSelect.value;
    } else {
      const scheduled = customMethodSelect.value === 'installments_plus_scheduled';
      body.inlineTerms = {
        downPaymentType: customDpTypeSelect.value,
        downPaymentValue: Number(customDpValueInput.value),
        frequency: customFrequencySelect.value,
        customMonthInterval: customFrequencySelect.value === 'custom' ? Number(customIntervalInput.value) : undefined,
        termMonths: Number(customTermInput.value),
        fees: [],
        paymentMethod: customMethodSelect.value,
        recurringInstallmentAmount: scheduled && customRecurringAmountInput.value ? Number(customRecurringAmountInput.value) : undefined,
        scheduledPayments: scheduled ? scheduledPayments : undefined,
      };
    }
    return body;
  }

  function validateBeforeSubmit() {
    if (unitMode === 'inventory' && !unitSelect.value) return t(locale, 'pp_err_choose_unit');
    if (unitMode === 'manual' && (!manualCodeInput.value.trim() || !(Number(manualAreaInput.value) > 0) || !(Number(manualPriceInput.value) > 0))) {
      return t(locale, 'pp_err_manual_unit_required');
    }
    if (termsMode === 'template' && !templateSelect.value) return t(locale, 'pp_err_choose_template');
    if (termsMode === 'custom' && (!(Number(customDpValueInput.value) >= 0) || !(Number(customTermInput.value) > 0))) {
      return t(locale, 'pp_err_custom_terms_required');
    }
    return null;
  }

  calcBtn.addEventListener('click', async () => {
    clear(errorSlot);
    const validationError = validateBeforeSubmit();
    if (validationError) {
      errorSlot.appendChild(errorBanner(validationError));
      return;
    }
    calcBtn.disabled = true;
    try {
      const calc = await api.post('/api/quotations/calculate', buildRequestBody());
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
    const validationError = validateBeforeSubmit();
    if (validationError) {
      errorSlot.appendChild(errorBanner(validationError));
      return;
    }
    generateBtn.disabled = true;
    try {
      const body = buildRequestBody();
      body.leadId = leadIdInput.value.trim() || undefined;
      const quotation = await api.post('/api/quotations', body);
      toast(`${t(locale, 'quotations_toast_generated_prefix')} ${quotation.referenceNumber} (v${quotation.version})${t(locale, 'quotations_toast_generated_suffix')}`, 'success');
      scheduledPayments = [];
      renderScheduledPaymentsList();
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
      el('div', { class: 'form-row' }, [el('div', {}, [el('label', {}, t(locale, 'pp_unit_source_field')), unitModeSelect])]),
      unitInventoryFields,
      unitManualFields,
      el('div', { class: 'form-row' }, [el('div', {}, [el('label', {}, t(locale, 'pp_terms_source_field')), termsModeSelect])]),
      termsTemplateFields,
      termsCustomFields,
      el('div', { class: 'form-row' }, [
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

  // ---- Admin-only: manage reusable Payment Plan Templates, folded into
  // this same page (see this file's own top comment) rather than a
  // separate tab. Reuses templates.js's renderTemplates() unmodified. ----
  if (can('payment_plan_template', 'create')) {
    const templatesBody = el('div', { style: 'margin-top:10px' });
    const templatesDetails = el('details', { style: 'margin-top:16px' }, [
      el('summary', { style: 'cursor:pointer;font-weight:600;padding:8px 0' }, t(locale, 'pp_manage_templates_toggle')),
      templatesBody,
    ]);
    templatesDetails.addEventListener('toggle', async () => {
      if (templatesDetails.open) {
        if (!templatesBody.dataset.loaded) {
          templatesBody.dataset.loaded = '1';
          await renderTemplates(templatesBody);
        }
      } else {
        await loadPickers(); // pick up any template created/edited while open
      }
    });
    container.appendChild(templatesDetails);
  }

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
  // (quotation.service.ts / offer-pdf.service.ts). "Share" below only
  // logs a text link unless the native share sheet is available (see
  // shareQuotation); this button always downloads/opens the actual PDF.
  async function fetchOfferPdfFile(quotation) {
    const result = await api.get(`/api/quotations/${quotation.id}/pdf`);
    const byteChars = atob(result.base64);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    return { bytes, filename: result.filename, contentType: result.contentType };
  }

  async function downloadOfferPdf(quotation) {
    try {
      const result = await api.get(`/api/quotations/${quotation.id}/pdf`);
      downloadBase64(result.filename, result.contentType, result.base64);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function previewOfferPdf(quotation) {
    try {
      const { bytes, contentType } = await fetchOfferPdfFile(quotation);
      const blob = new Blob([bytes], { type: contentType });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
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

  // Prefers the device/browser's native share sheet with the actual Offer
  // PDF attached (Web Share API Level 2 — navigator.canShare({files})),
  // per spec section 25: "Do not hard-code WhatsApp as the only sharing
  // destination... the Share action should use the system's available
  // native sharing mechanism where possible." Falls back to the existing
  // log-a-message + optional wa.me deep link when the native share sheet
  // or file sharing isn't supported (most desktop browsers today).
  async function shareQuotation(quotation) {
    if (typeof navigator.share === 'function' && typeof navigator.canShare === 'function') {
      try {
        const { bytes, filename, contentType } = await fetchOfferPdfFile(quotation);
        const file = new File([bytes], filename, { type: contentType });
        if (navigator.canShare({ files: [file] })) {
          const shareText = `${t(locale, 'quotations_msg_greeting_prefix')} ${quotation.referenceNumber}${t(locale, 'quotations_msg_for_review_suffix')}`;
          await navigator.share({ files: [file], title: `${t(locale, 'quotations_share_title_prefix')} ${quotation.referenceNumber}`, text: shareText });
          await api.post(`/api/quotations/${quotation.id}/share`, { channel: 'whatsapp', message: shareText });
          toast(t(locale, 'quotations_toast_share_logged'), 'success');
          return;
        }
      } catch (err) {
        if (err?.name === 'AbortError') return; // user cancelled the native share sheet
        // any other failure (e.g. not a secure context) falls through to the modal flow below
      }
    }
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
          { label: t(locale, 'sales_col_unit'), render: (q) => q.unitSnapshot?.code ?? q.unitId ?? '—' },
          { label: t(locale, 'units_col_status'), render: (q) => statusBadge(q.status) },
          { label: t(locale, 'pp_col_balance'), render: (q) => {
            if (!q.validation) return '—';
            if (q.validation.isValid) return el('span', { style: 'color:var(--success,#0a7a3c)' }, t(locale, 'pp_validation_balanced_short'));
            if (q.validation.overpayment > 0) return el('span', { style: 'color:var(--danger,#b3261e)' }, `+${Number(q.validation.overpayment).toLocaleString()}`);
            return el('span', { style: 'color:#8a5a00' }, `-${Number(q.validation.remainingBalance).toLocaleString()}`);
          } },
          { label: t(locale, 'automation_col_created'), render: (q) => new Date(q.createdAt).toLocaleString() },
          { label: '', render: (q) => {
            const previewBtn = el('button', {}, t(locale, 'pp_preview_btn'));
            previewBtn.addEventListener('click', () => previewOfferPdf(q));
            const excelBtn = el('button', {}, t(locale, 'quotations_excel_btn'));
            excelBtn.addEventListener('click', () => downloadExcel(q));
            const printBtn = el('button', {}, t(locale, 'quotations_print_pdf_btn'));
            printBtn.addEventListener('click', () => openPrintView(q));
            const offerPdfBtn = el('button', {}, t(locale, 'quotations_print_pdf_only_btn'));
            offerPdfBtn.addEventListener('click', () => downloadOfferPdf(q));
            const actions = [previewBtn, excelBtn, printBtn, offerPdfBtn];
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
      templates = templatesPage.items.filter((tpl) => !tpl.adHoc);
      clear(unitSelect);
      units.forEach((u) => unitSelect.appendChild(el('option', { value: u.id }, `${u.code} — ${u.unitType} (${Number(u.listPrice).toLocaleString()})`)));
      clear(templateSelect);
      templates.forEach((tpl) => templateSelect.appendChild(el('option', { value: tpl.id }, tpl.name)));
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  await loadPickers();
  await loadQuotations();
}
