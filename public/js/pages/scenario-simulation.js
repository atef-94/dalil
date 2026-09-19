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
      el('p', { class: 'page-subtitle' }, 'A "what if" calculator — never saves anything. Reuses the exact same payment-plan engine that generates a real signed contract\'s schedule.'),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  function buildScenarioForm(prefix) {
    const totalPrice = el('input', { type: 'number', placeholder: 'e.g. 2000000' });
    const discountPercent = el('input', { type: 'number', placeholder: '0' });
    const planSource = selectInput([{ value: 'custom', label: 'Custom plan' }, { value: 'template', label: 'Existing template' }]);
    const templateSelect = selectInput([]);
    const downPaymentType = selectInput([{ value: 'percentage', label: 'Percentage' }, { value: 'fixed', label: 'Fixed amount' }]);
    const downPaymentValue = el('input', { type: 'number', placeholder: 'e.g. 20' });
    const frequency = selectInput(['monthly', 'quarterly', 'semiannual', 'annual'].map((f) => ({ value: f, label: f })));
    const termMonths = el('input', { type: 'number', placeholder: 'e.g. 36' });
    const escalationPercentPerYear = el('input', { type: 'number', placeholder: '0' });

    const customFieldsRow = el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Down payment type'), downPaymentType]),
      el('div', {}, [el('label', {}, 'Down payment value'), downPaymentValue]),
      el('div', {}, [el('label', {}, 'Frequency'), frequency]),
      el('div', {}, [el('label', {}, 'Term (months)'), termMonths]),
    ]);
    const templateFieldRow = el('div', { class: 'form-row' }, [el('div', {}, [el('label', {}, 'Payment plan template'), templateSelect])]);
    templateFieldRow.style.display = 'none';

    planSource.addEventListener('change', () => {
      const useTemplate = planSource.value === 'template';
      templateFieldRow.style.display = useTemplate ? '' : 'none';
      customFieldsRow.style.display = useTemplate ? 'none' : '';
    });

    const wrap = el('div', {}, [
      el('div', { class: 'form-row' }, [
        el('div', {}, [el('label', {}, `Total price${prefix ? ` (${prefix})` : ''}`), totalPrice]),
        el('div', {}, [el('label', {}, 'Discount (%)'), discountPercent]),
        el('div', {}, [el('label', {}, 'Escalation (%/year)'), escalationPercentPerYear]),
      ]),
      el('div', { class: 'form-row' }, [el('div', {}, [el('label', {}, 'Payment plan source'), planSource])]),
      templateFieldRow,
      customFieldsRow,
    ]);

    function toInput() {
      if (!(Number(totalPrice.value) > 0)) throw new Error('Enter a total price greater than zero.');
      const input = {
        totalPrice: Number(totalPrice.value),
        discountPercent: discountPercent.value ? Number(discountPercent.value) : undefined,
        escalationPercentPerYear: escalationPercentPerYear.value ? Number(escalationPercentPerYear.value) : undefined,
      };
      if (planSource.value === 'template') {
        if (!templateSelect.value) throw new Error('Choose a payment plan template.');
        input.templateId = templateSelect.value;
      } else {
        if (!(Number(downPaymentValue.value) >= 0) || !(Number(termMonths.value) > 0)) {
          throw new Error('Fill in the custom plan\'s down payment and term.');
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
      baselineForm = buildScenarioForm('baseline');
      baselineSlot.appendChild(baselineForm.wrap);
      baselineSlot.style.display = '';
      loadTemplatesInto(baselineForm.templateSelect);
    } else {
      baselineForm = null;
      baselineSlot.style.display = 'none';
    }
  });

  const npvRate = el('input', { type: 'number', placeholder: 'e.g. 12', value: '12' });
  const startDate = el('input', { type: 'date' });
  const runBtn = el('button', { class: 'primary' }, 'Run scenario');
  const resultsSlot = el('div');

  function renderScenarioResult(result, label) {
    return el('div', { class: 'card', style: 'margin-top:12px' }, [
      label ? el('h4', { style: 'margin-top:0' }, label) : null,
      el('div', { class: 'stat-grid' }, [
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(result.netContractValue).toLocaleString()), el('div', { class: 'label' }, 'Net contract value (after discount)')]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(result.discountAmount).toLocaleString()), el('div', { class: 'label' }, 'Discount amount' )]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(result.totalCollectible).toLocaleString()), el('div', { class: 'label' }, 'Total collectible (incl. fees)')]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(result.npv).toLocaleString()), el('div', { class: 'label' }, `NPV @ ${result.annualDiscountRatePercentForNpv}%/yr`)]),
      ]),
      el('h4', {}, 'Monthly cash flow'),
      table(
        [{ label: 'Month', key: 'month' }, { label: 'Amount', render: (m) => Number(m.amount).toLocaleString() }],
        result.cashFlowByMonth,
        { empty: 'No cash flow.' },
      ),
      el('h4', {}, 'Payment schedule'),
      table(
        [
          { label: 'Line', key: 'label' },
          { label: 'Due date', render: (l) => new Date(l.dueDate).toLocaleDateString() },
          { label: 'Amount', render: (l) => Number(l.amount).toLocaleString() },
        ],
        result.schedule,
        { empty: 'No schedule lines.' },
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
          el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(comparison.delta.netContractValueDelta).toLocaleString()), el('div', { class: 'label' }, 'Net contract value delta')]),
          el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(comparison.delta.totalCollectibleDelta).toLocaleString()), el('div', { class: 'label' }, 'Total collectible delta')]),
          el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(comparison.delta.npvDelta).toLocaleString()), el('div', { class: 'label' }, 'NPV delta')]),
        ]));
        resultsSlot.appendChild(renderScenarioResult(comparison.scenario, 'Scenario'));
        resultsSlot.appendChild(renderScenarioResult(comparison.baseline, 'Baseline'));
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
      if (templates.items.length === 0) select.appendChild(el('option', { value: '' }, 'No templates yet'));
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Scenario'),
    scenarioForm.wrap,
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'NPV discount rate (%/year)'), npvRate]),
      el('div', {}, [el('label', {}, 'Start date (optional, defaults to today)'), startDate]),
    ]),
    el('div', { class: 'form-row' }, [
      el('div', {}, [
        el('label', {}, [baselineToggle, ' Compare against a baseline scenario']),
      ]),
    ]),
    baselineSlot,
    el('div', { class: 'form-actions' }, [runBtn]),
  ]));

  container.appendChild(el('div', {}, [resultsSlot]));

  await loadTemplatesInto(scenarioForm.templateSelect);
}
