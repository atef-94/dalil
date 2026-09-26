import { el, clear, table, toast, errorBanner, statusBadge, loadingState, selectInput, paginationControls, searchInput } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

export async function renderPurchasing(container) {
  clear(container);
  const locale = getLocale();
  let vendorsOffset = 0;
  let vendorsQuery = '';
  let ordersOffset = 0;
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, t(locale, 'page_title_purchasing'))));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const vendorNameInput = el('input', { type: 'text', placeholder: t(locale, 'purchasing_vendor_name_placeholder') });
  const vendorCategoryInput = el('input', { type: 'text', placeholder: t(locale, 'purchasing_vendor_category_placeholder') });
  const vendorPhoneInput = el('input', { type: 'text', placeholder: t(locale, 'purchasing_vendor_phone_placeholder') });
  const registerVendorBtn = el('button', {}, t(locale, 'purchasing_register_vendor_btn'));
  registerVendorBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!vendorNameInput.value.trim() || !vendorCategoryInput.value.trim()) {
      errorSlot.appendChild(errorBanner(t(locale, 'purchasing_vendor_required_error')));
      return;
    }
    registerVendorBtn.disabled = true;
    try {
      await api.post('/api/purchasing/vendors', {
        name: vendorNameInput.value.trim(),
        category: vendorCategoryInput.value.trim(),
        contactPhone: vendorPhoneInput.value.trim() || undefined,
      });
      vendorNameInput.value = '';
      vendorCategoryInput.value = '';
      vendorPhoneInput.value = '';
      toast(t(locale, 'purchasing_vendor_registered_toast'), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      registerVendorBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'purchasing_register_vendor_title')),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'units_col_name')), vendorNameInput]),
      el('div', {}, [el('label', {}, t(locale, 'ai_memory_category_label')), vendorCategoryInput]),
      el('div', {}, [el('label', {}, t(locale, 'crm_col_phone')), vendorPhoneInput]),
    ]),
    el('div', { class: 'form-actions' }, [registerVendorBtn]),
  ]));

  const vendorsTableSlot = el('div');
  const vendorsSearch = searchInput(t(locale, 'purchasing_vendors_search_placeholder'), (value) => { vendorsQuery = value; vendorsOffset = 0; load(); });
  const vendorsSlot = el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'purchasing_vendors_title')),
    el('div', { class: 'form-row', style: 'max-width:320px;margin-bottom:10px' }, [vendorsSearch]),
    vendorsTableSlot,
  ]);
  container.appendChild(vendorsSlot);

  const vendorSelect = selectInput([]);
  const descriptionInput = el('input', { type: 'text', placeholder: t(locale, 'purchasing_po_description_placeholder') });
  const amountInput = el('input', { type: 'number', placeholder: '5000' });
  const createPoBtn = el('button', { class: 'primary' }, t(locale, 'purchasing_create_po_btn'));
  createPoBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!vendorSelect.value || !descriptionInput.value.trim() || !(Number(amountInput.value) > 0)) {
      errorSlot.appendChild(errorBanner(t(locale, 'purchasing_po_required_error')));
      return;
    }
    createPoBtn.disabled = true;
    try {
      await api.post('/api/purchasing/purchase-orders', {
        vendorId: vendorSelect.value,
        description: descriptionInput.value.trim(),
        amount: Number(amountInput.value),
      });
      descriptionInput.value = '';
      amountInput.value = '';
      toast(t(locale, 'purchasing_po_created_toast'), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createPoBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'purchasing_create_po_title')),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'purchasing_vendor_field')), vendorSelect]),
      el('div', {}, [el('label', {}, t(locale, 'automation_label_description')), descriptionInput]),
      el('div', {}, [el('label', {}, t(locale, 'sales_col_amount')), amountInput]),
    ]),
    el('div', { class: 'form-actions' }, [createPoBtn]),
  ]));

  const ordersSlot = el('div', { class: 'card' });
  container.appendChild(ordersSlot);

  const PO_ACTION_TOAST_KEYS = { approve: 'purchasing_po_approved_toast', cancel: 'purchasing_po_cancelled_toast', fulfill: 'purchasing_po_fulfilled_toast' };

  async function orderAction(order, action, btn) {
    btn.disabled = true;
    try {
      await api.post(`/api/purchasing/purchase-orders/${order.id}/${action}`, {});
      toast(t(locale, PO_ACTION_TOAST_KEYS[action]), 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    clear(vendorsTableSlot);
    try {
      // A separate, unpaginated fetch just for the create-PO vendor dropdown
      // — capped generously since the dropdown needs every active vendor,
      // not just the current search/page.
      const allVendorsPage = await api.get('/api/purchasing/vendors', { limit: 200 });
      clear(vendorSelect);
      allVendorsPage.items.filter((v) => v.status === 'active').forEach((v) => vendorSelect.appendChild(el('option', { value: v.id }, v.name)));

      const page = await api.get('/api/purchasing/vendors', { limit: 20, offset: vendorsOffset, q: vendorsQuery });
      vendorsTableSlot.appendChild(table(
        [
          { label: t(locale, 'units_col_name'), key: 'name' },
          { label: t(locale, 'ai_memory_category_label'), key: 'category' },
          { label: t(locale, 'units_col_status'), render: (v) => statusBadge(v.status) },
        ],
        page.items,
        { empty: t(locale, 'purchasing_vendors_empty') },
      ));
      vendorsTableSlot.appendChild(paginationControls(page, (next) => { vendorsOffset = next; load(); }));
    } catch (err) {
      vendorsTableSlot.appendChild(errorBanner(err.message));
    }

    clear(ordersSlot);
    ordersSlot.appendChild(el('h3', { style: 'margin-top:0' }, t(locale, 'purchasing_orders_title')));
    ordersSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/purchasing/purchase-orders', { limit: 20, offset: ordersOffset });
      clear(ordersSlot);
      ordersSlot.appendChild(el('h3', { style: 'margin-top:0' }, t(locale, 'purchasing_orders_title')));
      ordersSlot.appendChild(table(
        [
          { label: t(locale, 'automation_label_description'), key: 'description' },
          { label: t(locale, 'sales_col_amount'), render: (o) => Number(o.amount).toLocaleString() },
          { label: t(locale, 'units_col_status'), render: (o) => statusBadge(o.status) },
          { label: '', render: (o) => {
            if (o.status === 'draft') {
              const approveBtn = el('button', { class: 'primary' }, t(locale, 'brokers_approve_btn'));
              approveBtn.addEventListener('click', () => orderAction(o, 'approve', approveBtn));
              const cancelBtn = el('button', { class: 'danger' }, t(locale, 'common_cancel'));
              cancelBtn.addEventListener('click', () => orderAction(o, 'cancel', cancelBtn));
              return el('div', { class: 'form-actions' }, [approveBtn, cancelBtn]);
            }
            if (o.status === 'approved') {
              const fulfillBtn = el('button', { class: 'primary' }, t(locale, 'purchasing_fulfill_btn'));
              fulfillBtn.addEventListener('click', () => orderAction(o, 'fulfill', fulfillBtn));
              const cancelBtn = el('button', { class: 'danger' }, t(locale, 'common_cancel'));
              cancelBtn.addEventListener('click', () => orderAction(o, 'cancel', cancelBtn));
              return el('div', { class: 'form-actions' }, [fulfillBtn, cancelBtn]);
            }
            return '';
          } },
        ],
        page.items,
        { empty: t(locale, 'purchasing_po_empty') },
      ));
      ordersSlot.appendChild(paginationControls(page, (next) => { ordersOffset = next; load(); }));
    } catch (err) {
      ordersSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
