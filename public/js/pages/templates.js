import { el, clear, table, toast, errorBanner, selectInput, loadingState } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

const FREQUENCIES = ['monthly', 'quarterly', 'semiannual', 'annual', 'custom'];

export async function renderTemplates(container) {
  clear(container);
  const locale = getLocale();
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, t(locale, 'page_title_templates'))));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const nameInput = el('input', { type: 'text', placeholder: t(locale, 'templates_name_placeholder') });
  const dpTypeSelect = selectInput([{ value: 'percentage', label: t(locale, 'scenario_down_payment_type_percentage_option') }, { value: 'fixed', label: t(locale, 'templates_dp_type_fixed_label') }]);
  const dpValueInput = el('input', { type: 'number', placeholder: '10' });
  // Raw enum-as-label select, deliberately left untranslated — same treatment
  // as the identical FREQUENCIES list in scenario-simulation.js.
  const frequencySelect = selectInput(FREQUENCIES.map((f) => ({ value: f, label: f })));
  const termInput = el('input', { type: 'number', placeholder: '60' });
  const createBtn = el('button', { class: 'primary' }, t(locale, 'templates_create_btn'));

  createBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!nameInput.value.trim() || !(Number(dpValueInput.value) >= 0) || !(Number(termInput.value) > 0)) {
      errorSlot.appendChild(errorBanner(t(locale, 'templates_required_error')));
      return;
    }
    createBtn.disabled = true;
    try {
      await api.post('/api/payment-plan-templates', {
        name: nameInput.value.trim(),
        downPaymentType: dpTypeSelect.value,
        downPaymentValue: Number(dpValueInput.value),
        frequency: frequencySelect.value,
        termMonths: Number(termInput.value),
        fees: [],
      });
      nameInput.value = ''; dpValueInput.value = ''; termInput.value = '';
      toast(t(locale, 'templates_created_toast'), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'templates_create_title')),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'units_col_name')), nameInput]),
      el('div', {}, [el('label', {}, t(locale, 'scenario_down_payment_type_field')), dpTypeSelect]),
      el('div', {}, [el('label', {}, t(locale, 'scenario_down_payment_value_field')), dpValueInput]),
      el('div', {}, [el('label', {}, t(locale, 'scenario_frequency_field')), frequencySelect]),
      el('div', {}, [el('label', {}, t(locale, 'scenario_term_months_field')), termInput]),
    ]),
    el('div', { class: 'form-actions' }, [createBtn]),
  ]));

  // ---- Preview ----
  const previewTemplateSelect = selectInput([]);
  const previewPriceInput = el('input', { type: 'number', placeholder: '2000000' });
  const previewBtn = el('button', {}, t(locale, 'templates_preview_btn'));
  const previewOutput = el('pre', { style: 'white-space:pre-wrap;font-size:12px;background:var(--bg);padding:10px;border-radius:6px;max-height:280px;overflow:auto' }, '—');
  previewBtn.addEventListener('click', async () => {
    if (!previewTemplateSelect.value || !(Number(previewPriceInput.value) > 0)) {
      previewOutput.textContent = t(locale, 'templates_preview_required_error');
      return;
    }
    previewBtn.disabled = true;
    try {
      const lines = await api.post('/api/contracts/preview/payment-schedule/preview', {
        templateId: previewTemplateSelect.value,
        totalPrice: Number(previewPriceInput.value),
      });
      previewOutput.textContent = lines.map((l) => `${l.label.padEnd(16)} ${new Date(l.dueDate).toLocaleDateString()}  ${Number(l.amount).toLocaleString()}`).join('\n');
    } catch (err) {
      previewOutput.textContent = err.message;
    } finally {
      previewBtn.disabled = false;
    }
  });
  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'templates_preview_title')),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'templates_template_field')), previewTemplateSelect]),
      el('div', {}, [el('label', {}, t(locale, 'templates_total_price_field')), previewPriceInput]),
    ]),
    el('div', { class: 'form-actions' }, [previewBtn]),
    previewOutput,
  ]));

  const listSlot = el('div');
  container.appendChild(listSlot);

  async function load() {
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/payment-plan-templates', { limit: 100 });
      clear(previewTemplateSelect);
      page.items.forEach((tpl) => previewTemplateSelect.appendChild(el('option', { value: tpl.id }, tpl.name)));
      clear(listSlot);
      listSlot.appendChild(table(
        [
          { label: t(locale, 'units_col_name'), key: 'name' },
          { label: t(locale, 'quotations_stat_down_payment'), render: (tpl) => (tpl.downPaymentType === 'percentage' ? `${tpl.downPaymentValue}%` : Number(tpl.downPaymentValue).toLocaleString()) },
          { label: t(locale, 'scenario_frequency_field'), key: 'frequency' },
          { label: t(locale, 'scenario_term_months_field'), key: 'termMonths' },
          { label: t(locale, 'quotations_col_version'), key: 'version' },
        ],
        page.items,
        { empty: t(locale, 'templates_list_empty') },
      ));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
