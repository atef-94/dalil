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
  const totalOverrideInput = el('input', { type: 'number', placeholder: '(defaults to unit list price)' });
  const leadIdInput = el('input', { type: 'text', placeholder: 'lead id (optional)' });
  const calcBtn = el('button', {}, 'Calculate preview');
  const generateBtn = el('button', { class: 'primary' }, 'Generate quotation');
  generateBtn.disabled = true;

  const previewSlot = el('div');

  function renderPreview(calc) {
    clear(previewSlot);
    if (!calc) return;
    previewSlot.appendChild(el('div', { class: 'stat-grid' }, [
      el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(calc.totalPrice).toLocaleString()), el('div', { class: 'label' }, 'Total price')]),
      el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(calc.netValue).toLocaleString()), el('div', { class: 'label' }, 'Net value')]),
      el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(calc.downPayment).toLocaleString()), el('div', { class: 'label' }, 'Down payment')]),
      el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, String(calc.schedule.length)), el('div', { class: 'label' }, 'Installments')]),
    ]));
    previewSlot.appendChild(table(
      [
        { label: '#', render: (l) => String(l.sequence) },
        { label: 'Label', key: 'label' },
        { label: 'Due date', render: (l) => new Date(l.dueDate).toLocaleDateString() },
        { label: 'Amount', render: (l) => Number(l.amount).toLocaleString() },
      ],
      calc.schedule,
      { empty: 'No schedule yet.' },
    ));
  }

  calcBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!unitSelect.value || !templateSelect.value) {
      errorSlot.appendChild(errorBanner('Choose a unit and a payment plan template.'));
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
      toast(`Quotation ${quotation.referenceNumber} (v${quotation.version}) generated.`, 'success');
      await loadQuotations();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      generateBtn.disabled = false;
    }
  });

  if (can('quotation', 'create')) {
    container.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, 'Generate a quotation'),
      el('div', { class: 'form-row' }, [
        el('div', {}, [el('label', {}, 'Unit'), unitSelect]),
        el('div', {}, [el('label', {}, 'Payment plan template'), templateSelect]),
        el('div', {}, [el('label', {}, 'Discount %'), discountInput]),
        el('div', {}, [el('label', {}, 'Escalation % / year'), escalationInput]),
        el('div', {}, [el('label', {}, 'Total price override'), totalOverrideInput]),
        el('div', {}, [el('label', {}, 'Lead ID'), leadIdInput]),
      ]),
      el('div', { class: 'form-actions' }, [calcBtn, generateBtn]),
      previewSlot,
    ]));
  }

  const listSlot = el('div');
  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Quotation history'),
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
        toast('Allow pop-ups to open the print view.', 'error');
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

  async function shareQuotation(quotation) {
    const values = await formModal({
      title: `Share quotation ${quotation.referenceNumber}`,
      fields: [
        { key: 'channel', label: 'Channel', type: 'select', options: [{ value: 'whatsapp', label: 'WhatsApp' }, { value: 'email', label: 'Email' }] },
        { key: 'contact', label: 'WhatsApp phone (intl format, e.g. 201234567890) or email address', type: 'text' },
        { key: 'message', label: 'Message', type: 'textarea', value: `Hi, here is quotation ${quotation.referenceNumber} for unit review.` },
      ],
      submitLabel: 'Share',
    });
    if (!values) return;
    try {
      await api.post(`/api/quotations/${quotation.id}/share`, { channel: values.channel, message: values.message });
      if (values.channel === 'whatsapp' && values.contact) {
        const digits = values.contact.replace(/[^0-9]/g, '');
        const waUrl = `https://wa.me/${digits}?text=${encodeURIComponent(values.message)}`;
        window.open(waUrl, '_blank');
      }
      toast('Share logged.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function updateStatus(quotation, status) {
    try {
      await api.patch(`/api/quotations/${quotation.id}/status`, { status });
      toast(`Quotation marked ${status}.`, 'success');
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
          { label: 'Reference', key: 'referenceNumber' },
          { label: 'Version', render: (q) => `v${q.version}` },
          { label: 'Unit', key: 'unitId' },
          { label: 'Status', render: (q) => statusBadge(q.status) },
          { label: 'Created', render: (q) => new Date(q.createdAt).toLocaleString() },
          { label: '', render: (q) => {
            const excelBtn = el('button', {}, 'Excel');
            excelBtn.addEventListener('click', () => downloadExcel(q));
            const printBtn = el('button', {}, 'Print / PDF');
            printBtn.addEventListener('click', () => openPrintView(q));
            const actions = [excelBtn, printBtn];
            if (can('quotation', 'edit')) {
              const shareBtn = el('button', {}, 'Share');
              shareBtn.addEventListener('click', () => shareQuotation(q));
              actions.push(shareBtn);
              if (q.status === 'generated') {
                const sentBtn = el('button', {}, 'Mark sent');
                sentBtn.addEventListener('click', () => updateStatus(q, 'sent'));
                actions.push(sentBtn);
              }
              if (q.status === 'sent') {
                const acceptBtn = el('button', {}, 'Mark accepted');
                acceptBtn.addEventListener('click', () => updateStatus(q, 'accepted'));
                actions.push(acceptBtn);
              }
            }
            return el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, actions);
          } },
        ],
        page.items,
        { empty: 'No quotations generated yet.' },
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
