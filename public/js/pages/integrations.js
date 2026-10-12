import { el, clear, table, toast, errorBanner, statusBadge, loadingState, selectInput, confirmModal, paginationControls } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

export async function renderIntegrations(container) {
  clear(container);
  const locale = getLocale();
  let eventsOffset = 0;
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, t(locale, 'page_title_integrations'))));
  container.appendChild(el('p', { class: 'muted' }, t(locale, 'integrations_intro')));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  let connectors = [];
  try {
    connectors = await api.get('/api/integrations/connectors');
  } catch (err) {
    errorSlot.appendChild(errorBanner(err.message));
    return;
  }

  // ---- Connect form ----
  const formCard = el('div', { class: 'card' });
  container.appendChild(formCard);

  const providerSelect = selectInput(connectors.map((c) => ({ value: c.provider, label: c.name })));
  const nameInput = el('input', { type: 'text', placeholder: t(locale, 'integrations_display_name_field') });
  const fieldsSlot = el('div', { class: 'form-row' });

  function renderFields() {
    clear(fieldsSlot);
    const def = connectors.find((c) => c.provider === providerSelect.value);
    const configInputs = {};
    const credInputs = {};
    for (const field of def?.configFields || []) {
      const input = el('input', { type: 'text', placeholder: field });
      configInputs[field] = input;
      fieldsSlot.appendChild(el('div', {}, [el('label', {}, field), input]));
    }
    for (const field of def?.credentialFields || []) {
      const input = el('input', { type: 'password', placeholder: field });
      credInputs[field] = input;
      fieldsSlot.appendChild(el('div', {}, [el('label', {}, `${field} ${t(locale, 'integrations_field_secret_suffix')}`), input]));
    }
    fieldsSlot._get = () => ({
      config: Object.fromEntries(Object.entries(configInputs).map(([k, i]) => [k, i.value.trim()])),
      credentials: Object.fromEntries(Object.entries(credInputs).map(([k, i]) => [k, i.value])),
    });
  }
  providerSelect.addEventListener('change', renderFields);
  renderFields();

  const connectBtn = el('button', { class: 'primary' }, t(locale, 'integrations_connect_btn'));
  connectBtn.addEventListener('click', async () => {
    if (!nameInput.value.trim()) {
      errorSlot.appendChild(errorBanner(t(locale, 'integrations_display_name_required_error')));
      return;
    }
    connectBtn.disabled = true;
    try {
      const { config, credentials } = fieldsSlot._get();
      await api.post('/api/integrations/connections', { provider: providerSelect.value, displayName: nameInput.value.trim(), config, credentials });
      toast(t(locale, 'integrations_connected_toast'), 'success');
      nameInput.value = '';
      await loadConnections();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      connectBtn.disabled = false;
    }
  });

  formCard.appendChild(el('h3', { style: 'margin-top:0' }, t(locale, 'integrations_connect_provider_title')));
  formCard.appendChild(el('div', { class: 'form-row' }, [
    el('div', {}, [el('label', {}, t(locale, 'automation_field_provider')), providerSelect]),
    el('div', {}, [el('label', {}, t(locale, 'integrations_display_name_field')), nameInput]),
  ]));
  formCard.appendChild(fieldsSlot);
  formCard.appendChild(el('div', { class: 'form-actions' }, [connectBtn]));

  // ---- Connections list ----
  const connectionsSlot = el('div');
  container.appendChild(connectionsSlot);

  async function loadConnections() {
    clear(connectionsSlot);
    connectionsSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/integrations/connections', { limit: 50 });
      clear(connectionsSlot);
      connectionsSlot.appendChild(el('h3', {}, t(locale, 'integrations_connections_title')));
      connectionsSlot.appendChild(table(
        [
          { label: t(locale, 'automation_field_provider'), key: 'provider' },
          { label: t(locale, 'units_col_name'), key: 'displayName' },
          { label: t(locale, 'units_col_status'), render: (c) => statusBadge(c.status) },
          { label: t(locale, 'integrations_last_used_col'), render: (c) => c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString() : t(locale, 'integrations_never') },
          { label: t(locale, 'integrations_last_error_col'), render: (c) => c.lastError || '' },
          { label: '', render: (c) => {
            if (c.status === 'disconnected') return '';
            const btn = el('button', { class: 'danger' }, t(locale, 'integrations_disconnect_btn'));
            btn.addEventListener('click', async () => {
              if (!(await confirmModal(`${t(locale, 'integrations_disconnect_confirm_prefix')}${c.displayName}${t(locale, 'integrations_disconnect_confirm_suffix')}`, { danger: true }))) return;
              try {
                await api.delete(`/api/integrations/connections/${c.id}`);
                toast(t(locale, 'integrations_disconnected_toast'), 'success');
                await loadConnections();
              } catch (err) {
                errorSlot.appendChild(errorBanner(err.message));
              }
            });
            return btn;
          } },
        ],
        page.items,
        { empty: t(locale, 'integrations_connections_empty') },
      ));
    } catch (err) {
      clear(connectionsSlot);
      connectionsSlot.appendChild(errorBanner(err.message));
    }
  }

  // ---- Delivery log ----
  const eventsSlot = el('div');
  container.appendChild(eventsSlot);

  async function loadEvents() {
    clear(eventsSlot);
    eventsSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/integrations/events', { limit: 20, offset: eventsOffset });
      clear(eventsSlot);
      eventsSlot.appendChild(el('h3', {}, t(locale, 'integrations_delivery_log_title')));
      eventsSlot.appendChild(table(
        [
          { label: t(locale, 'automation_field_provider'), key: 'provider' },
          { label: t(locale, 'automation_field_action'), key: 'action' },
          { label: t(locale, 'units_col_status'), render: (e) => statusBadge(e.status) },
          { label: t(locale, 'integrations_attempts_col'), key: 'attempts' },
          { label: t(locale, 'automation_col_error'), render: (e) => e.error || '' },
          { label: t(locale, 'ai_col_when'), render: (e) => new Date(e.createdAt).toLocaleString() },
        ],
        page.items.slice().reverse(),
        { empty: t(locale, 'integrations_events_empty') },
      ));
      eventsSlot.appendChild(paginationControls(page, (next) => { eventsOffset = next; loadEvents(); }));
    } catch (err) {
      clear(eventsSlot);
      eventsSlot.appendChild(errorBanner(err.message));
    }
  }

  await Promise.all([loadConnections(), loadEvents()]);
}
