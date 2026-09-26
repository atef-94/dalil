import { el, clear, table, toast, errorBanner, loadingState, selectInput } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

export async function renderScenarioSimulation(container) {
  clear(container);
  const locale = getLocale();
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, t(locale, 'page_title_scenario_simulation')),
      el('p', { class: 'page-subtitle' }, t(locale, 'scenario_page_subtitle')),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  function buildScenarioForm(prefix) {
    const totalPrice = el('input', { type: 'number', placeholder: t(locale, 'scenario_total_price_placeholder') });
    const discountPercent = el('input', { type: 'number', placeholder: t(locale, 'fin_percent_zero_placeholder') });
    const planSource = selectInput([{ value: 'custom', label: t(locale, 'scenario_plan_source_custom_option') }, { value: 'template', label: t(locale, 'scenario_plan_source_template_option') }]);
    const templateSelect = selectInput([]);
    const downPaymentType = selectInput([{ value: 'percentage', label: t(locale, 'scenario_down_payment_type_percentage_option') }, { value: 'fixed', label: t(locale, 'scenario_down_payment_type_fixed_option') }]);
    const downPaymentValue = el('input', { type: 'number', placeholder: t(locale, 'scenario_down_payment_value_placeholder') });
    const frequency = selectInput(['monthly', 'quarterly', 'semiannual', 'annual'].map((f) => ({ value: f, label: f })));
    const termMonths = el('input', { type: 'number', placeholder: t(locale, 'scenario_term_months_placeholder') });
    const escalationPercentPerYear = el('input', { type: 'number', placeholder: t(locale, 'fin_percent_zero_placeholder') });

    const customFieldsRow = el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'scenario_down_payment_type_field')), downPaymentType]),
      el('div', {}, [el('label', {}, t(locale, 'scenario_down_payment_value_field')), downPaymentValue]),
      el('div', {}, [el('label', {}, t(locale, 'scenario_frequency_field')), frequency]),
      el('div', {}, [el('label', {}, t(locale, 'scenario_term_months_field')), termMonths]),
    ]);
    const templateFieldRow = el('div', { class: 'form-row' }, [el('div', {}, [el('label', {}, t(locale, 'sales_payment_plan_template_field')), templateSelect])]);
    templateFieldRow.style.display = 'none';

    planSource.addEventListener('change', () => {
      const useTemplate = planSource.value === 'template';
      templateFieldRow.style.display = useTemplate ? '' : 'none';
      customFieldsRow.style.display = useTemplate ? 'none' : '';
    });

    const wrap = el('div', {}, [
      el('div', { class: 'form-row' }, [
        el('div', {}, [el('label', {}, `${t(locale, 'quotations_stat_total_price')}${prefix ? ` (${prefix})` : ''}`), totalPrice]),
        el('div', {}, [el('label', {}, t(locale, 'scenario_discount_percent_field')), discountPercent]),
        el('div', {}, [el('label', {}, t(locale, 'scenario_escalation_field')), escalationPercentPerYear]),
      ]),
      el('div', { class: 'form-row' }, [el('div', {}, [el('label', {}, t(locale, 'scenario_plan_source_field')), planSource])]),
      templateFieldRow,
      customFieldsRow,
    ]);

    function toInput() {
      if (!(Number(totalPrice.value) > 0)) throw new Error(t(locale, 'scenario_err_total_price'));
      const input = {
        totalPrice: Number(totalPrice.value),
        discountPercent: discountPercent.value ? Number(discountPercent.value) : undefined,
        escalationPercentPerYear: escalationPercentPerYear.value ? Number(escalationPercentPerYear.value) : undefined,
      };
      if (planSource.value === 'template') {
        if (!templateSelect.value) throw new Error(t(locale, 'scenario_err_choose_template'));
        input.templateId = templateSelect.value;
      } else {
        if (!(Number(downPaymentValue.value) >= 0) || !(Number(termMonths.value) > 0)) {
          throw new Error(t(locale, 'scenario_err_fill_custom_plan'));
        }
        input.adHocPlan = {
          downPaymentType: downPaymentType.value,
          downPaymentValue: Number(downPaymentValue.value),
          frequency: frequency.value,
          termMonths: Number(termMonths.value),
        };
      }
      return input;
    }

    return { wrap, toInput, templateSelect };
  }

  const scenarioForm = buildScenarioForm('');
  const baselineToggle = el('input', { type: 'checkbox', id: 'scenario-compare-toggle' });
  const baselineSlot = el('div');
  baselineSlot.style.display = 'none';
  let baselineForm = null;
  baselineToggle.addEventListener('change', () => {
    clear(baselineSlot);
    if (baselineToggle.checked) {
      baselineForm = buildScenarioForm(t(locale, 'scenario_label_baseline'));
      baselineSlot.appendChild(baselineForm.wrap);
      baselineSlot.style.display = '';
      loadTemplatesInto(baselineForm.templateSelect);
    } else {
      baselineForm = null;
      baselineSlot.style.display = 'none';
    }
  });

  const npvRate = el('input', { type: 'number', placeholder: t(locale, 'scenario_npv_rate_placeholder'), value: '12' });
  const startDate = el('input', { type: 'date' });
  const runBtn = el('button', { class: 'primary' }, t(locale, 'scenario_run_btn'));
  const resultsSlot = el('div');

  function renderScenarioResult(result, label) {
    return el('div', { class: 'card', style: 'margin-top:12px' }, [
      label ? el('h4', { style: 'margin-top:0' }, label) : null,
      el('div', { class: 'stat-grid' }, [
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(result.netContractValue).toLocaleString()), el('div', { class: 'label' }, t(locale, 'scenario_stat_net_contract_value'))]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(result.discountAmount).toLocaleString()), el('div', { class: 'label' }, t(locale, 'scenario_stat_discount_amount'))]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(result.totalCollectible).toLocaleString()), el('div', { class: 'label' }, t(locale, 'scenario_stat_total_collectible'))]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(result.npv).toLocaleString()), el('div', { class: 'label' }, `${t(locale, 'scenario_stat_npv_at')} ${result.annualDiscountRatePercentForNpv}${t(locale, 'scenario_stat_npv_suffix')}`)]),
      ]),
      el('h4', {}, t(locale, 'scenario_monthly_cashflow_heading')),
      table(
        [{ label: t(locale, 'fin_col_month'), key: 'month' }, { label: t(locale, 'sales_col_amount'), render: (m) => Number(m.amount).toLocaleString() }],
        result.cashFlowByMonth,
        { empty: t(locale, 'scenario_cashflow_empty') },
      ),
      el('h4', {}, t(locale, 'scenario_payment_schedule_heading')),
      table(
        [
          { label: t(locale, 'contracts_col_line'), key: 'label' },
          { label: t(locale, 'sales_col_due_date'), render: (l) => new Date(l.dueDate).toLocaleDateString() },
          { label: t(locale, 'sales_col_amount'), render: (l) => Number(l.amount).toLocaleString() },
        ],
        result.schedule,
        { empty: t(locale, 'scenario_schedule_lines_empty') },
      ),
    ].filter(Boolean));
  }

  runBtn.addEventListener('click', async () => {
    clear(errorSlot);
    clear(resultsSlot);
    let scenarioInput;
    let baselineInput;
    try {
      scenarioInput = scenarioForm.toInput();
      if (startDate.value) scenarioInput.startDate = new Date(startDate.value).toISOString();
      if (npvRate.value) scenarioInput.annualDiscountRatePercentForNpv = Number(npvRate.value);
      if (baselineToggle.checked && baselineForm) {
        baselineInput = baselineForm.toInput();
        if (startDate.value) baselineInput.startDate = new Date(startDate.value).toISOString();
        if (npvRate.value) baselineInput.annualDiscountRatePercentForNpv = Number(npvRate.value);
      }
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
      return;
    }
    resultsSlot.appendChild(loadingState());
    runBtn.disabled = true;
    try {
      if (baselineInput) {
        const comparison = await api.post('/api/scenario-simulation/run', { ...scenarioInput, baseline: baselineInput });
        clear(resultsSlot);
        resultsSlot.appendChild(el('div', { class: 'stat-grid' }, [
          el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(comparison.delta.netContractValueDelta).toLocaleString()), el('div', { class: 'label' }, t(locale, 'scenario_stat_ncv_delta'))]),
          el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(comparison.delta.totalCollectibleDelta).toLocaleString()), el('div', { class: 'label' }, t(locale, 'scenario_stat_tc_delta'))]),
          el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(comparison.delta.npvDelta).toLocaleString()), el('div', { class: 'label' }, t(locale, 'scenario_stat_npv_delta'))]),
        ]));
        resultsSlot.appendChild(renderScenarioResult(comparison.scenario, t(locale, 'scenario_label_scenario')));
        resultsSlot.appendChild(renderScenarioResult(comparison.baseline, t(locale, 'scenario_label_baseline')));
      } else {
        const result = await api.post('/api/scenario-simulation/run', scenarioInput);
        clear(resultsSlot);
        resultsSlot.appendChild(renderScenarioResult(result, ''));
      }
    } catch (err) {
      clear(resultsSlot);
      resultsSlot.appendChild(errorBanner(err.message));
    } finally {
      runBtn.disabled = false;
    }
  });

  async function loadTemplatesInto(select) {
    try {
      const templates = await api.get('/api/payment-plan-templates', { limit: 200 });
      clear(select);
      templates.items.forEach((t) => select.appendChild(el('option', { value: t.id }, t.name)));
      if (templates.items.length === 0) select.appendChild(el('option', { value: '' }, t(locale, 'scenario_no_templates_option')));
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'scenario_label_scenario')),
    scenarioForm.wrap,
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'scenario_npv_rate_field')), npvRate]),
      el('div', {}, [el('label', {}, t(locale, 'scenario_start_date_field')), startDate]),
    ]),
    el('div', { class: 'form-row' }, [
      el('div', {}, [
        el('label', {}, [baselineToggle, t(locale, 'scenario_compare_baseline_label')]),
      ]),
    ]),
    baselineSlot,
    el('div', { class: 'form-actions' }, [runBtn]),
  ]));

  container.appendChild(el('div', {}, [resultsSlot]));

  await loadTemplatesInto(scenarioForm.templateSelect);
}
