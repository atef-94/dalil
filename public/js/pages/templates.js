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

  const nameInput = el('input', { type: 'text', placeholder: 'Standard 5yr Plan' });
  const dpTypeSelect = selectInput([{ value: 'percentage', label: 'Percentage' }, { value: 'fixed', label: 'Fixed' }]);
  const dpValueInput = el('input', { type: 'number', placeholder: '10' });
  const frequencySelect = selectInput(FREQUENCIES.map((f) => ({ value: f, label: f })));
  const termInput = el('input', { type: 'number', placeholder: '60' });
  const createBtn = el('button', { class: 'primary' }, 'Create template');

  createBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!nameInput.value.trim() || !(Number(dpValueInput.value) >= 0) || !(Number(termInput.value) > 0)) {
      errorSlot.appendChild(errorBanner('Enter a name, a down payment value, and a positive term.'));
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
      toast('Template created.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Create a template'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Name'), nameInput]),
      el('div', {}, [el('label', {}, 'Down payment type'), dpTypeSelect]),
      el('div', {}, [el('label', {}, 'Down payment value'), dpValueInput]),
      el('div', {}, [el('label', {}, 'Frequency'), frequencySelect]),
      el('div', {}, [el('label', {}, 'Term (months)'), termInput]),
    ]),
    el('div', { class: 'form-actions' }, [createBtn]),
  ]));

  // ---- Preview ----
  const previewTemplateSelect = selectInput([]);
  const previewPriceInput = el('input', { type: 'number', placeholder: '2000000' });
  const previewBtn = el('button', {}, 'Preview schedule');
  const previewOutput = el('pre', { style: 'white-space:pre-wrap;font-size:12px;background:var(--bg);padding:10px;border-radius:6px;max-height:280px;overflow:auto' }, '—');
  previewBtn.addEventListener('click', async () => {
    if (!previewTemplateSelect.value || !(Number(previewPriceInput.value) > 0)) {
      previewOutput.textContent = 'Choose a template and enter a positive total price.';
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
    el('h3', { style: 'margin-top:0' }, 'Preview a schedule'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Template'), previewTemplateSelect]),
      el('div', {}, [el('label', {}, 'Total price'), previewPriceInput]),
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
          { label: 'Name', key: 'name' },
          { label: 'Down payment', render: (t) => (t.downPaymentType === 'percentage' ? `${t.downPaymentValue}%` : Number(t.downPaymentValue).toLocaleString()) },
          { label: 'Frequency', key: 'frequency' },
          { label: 'Term (months)', key: 'termMonths' },
          { label: 'Version', key: 'version' },
        ],
        page.items,
        { empty: 'No templates yet — create one above.' },
      ));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
