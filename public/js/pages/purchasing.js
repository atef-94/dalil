import { el, clear, table, toast, errorBanner, statusBadge, loadingState, selectInput } from '../ui.js';
import { api } from '../api.js';

export async function renderPurchasing(container) {
  clear(container);
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, 'Purchasing')));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const vendorNameInput = el('input', { type: 'text', placeholder: 'e.g. Acme Supplies' });
  const vendorCategoryInput = el('input', { type: 'text', placeholder: 'e.g. materials' });
  const vendorPhoneInput = el('input', { type: 'text', placeholder: 'Phone (optional)' });
  const registerVendorBtn = el('button', {}, 'Register vendor');
  registerVendorBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!vendorNameInput.value.trim() || !vendorCategoryInput.value.trim()) {
      errorSlot.appendChild(errorBanner('Enter a vendor name and category.'));
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
      toast('Vendor registered.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      registerVendorBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Register a vendor'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Name'), vendorNameInput]),
      el('div', {}, [el('label', {}, 'Category'), vendorCategoryInput]),
      el('div', {}, [el('label', {}, 'Phone'), vendorPhoneInput]),
    ]),
    el('div', { class: 'form-actions' }, [registerVendorBtn]),
  ]));

  const vendorsSlot = el('div', { class: 'card' });
  container.appendChild(vendorsSlot);

  const vendorSelect = selectInput([]);
  const descriptionInput = el('input', { type: 'text', placeholder: 'e.g. Cement, 200 bags' });
  const amountInput = el('input', { type: 'number', placeholder: '5000' });
  const createPoBtn = el('button', { class: 'primary' }, 'Create purchase order');
  createPoBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!vendorSelect.value || !descriptionInput.value.trim() || !(Number(amountInput.value) > 0)) {
      errorSlot.appendChild(errorBanner('Choose a vendor, description, and a positive amount.'));
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
      toast('Purchase order created.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createPoBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Create a purchase order'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Vendor'), vendorSelect]),
      el('div', {}, [el('label', {}, 'Description'), descriptionInput]),
      el('div', {}, [el('label', {}, 'Amount'), amountInput]),
    ]),
    el('div', { class: 'form-actions' }, [createPoBtn]),
  ]));

  const ordersSlot = el('div', { class: 'card' });
  container.appendChild(ordersSlot);

  async function orderAction(order, action, btn) {
    btn.disabled = true;
    try {
      await api.post(`/api/purchasing/purchase-orders/${order.id}/${action}`, {});
      toast(`Purchase order ${action}d.`, 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  async function load() {
    clear(vendorsSlot);
    vendorsSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Vendors'));
    try {
      const page = await api.get('/api/purchasing/vendors', { limit: 100 });
      clear(vendorSelect);
      page.items.filter((v) => v.status === 'active').forEach((v) => vendorSelect.appendChild(el('option', { value: v.id }, v.name)));
      vendorsSlot.appendChild(table(
        [
          { label: 'Name', key: 'name' },
          { label: 'Category', key: 'category' },
          { label: 'Status', render: (v) => statusBadge(v.status) },
        ],
        page.items,
        { empty: 'No vendors yet — register one above.' },
      ));
    } catch (err) {
      vendorsSlot.appendChild(errorBanner(err.message));
    }

    clear(ordersSlot);
    ordersSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Purchase orders'));
    ordersSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/purchasing/purchase-orders', { limit: 100 });
      clear(ordersSlot);
      ordersSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Purchase orders'));
      ordersSlot.appendChild(table(
        [
          { label: 'Description', key: 'description' },
          { label: 'Amount', render: (o) => Number(o.amount).toLocaleString() },
          { label: 'Status', render: (o) => statusBadge(o.status) },
          { label: '', render: (o) => {
            if (o.status === 'draft') {
              const approveBtn = el('button', { class: 'primary' }, 'Approve');
              approveBtn.addEventListener('click', () => orderAction(o, 'approve', approveBtn));
              const cancelBtn = el('button', { class: 'danger' }, 'Cancel');
              cancelBtn.addEventListener('click', () => orderAction(o, 'cancel', cancelBtn));
              return el('div', { class: 'form-actions' }, [approveBtn, cancelBtn]);
            }
            if (o.status === 'approved') {
              const fulfillBtn = el('button', { class: 'primary' }, 'Fulfill');
              fulfillBtn.addEventListener('click', () => orderAction(o, 'fulfill', fulfillBtn));
              const cancelBtn = el('button', { class: 'danger' }, 'Cancel');
              cancelBtn.addEventListener('click', () => orderAction(o, 'cancel', cancelBtn));
              return el('div', { class: 'form-actions' }, [fulfillBtn, cancelBtn]);
            }
            return '';
          } },
        ],
        page.items,
        { empty: 'No purchase orders yet — create one above.' },
      ));
    } catch (err) {
      ordersSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
