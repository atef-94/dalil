import { el, clear, table, toast, errorBanner, statusBadge, loadingState, selectInput, confirmModal, paginationControls } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

export async function renderIntegrations(container) {
  clear(container);
  const locale = getLocale();
  let eventsOffset = 0;
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, t(locale, 'page_title_integrations'))));
  container.appendChild(el('p', { class: 'muted' },
    'Connect external providers with securely encrypted credentials. Every send is rate-limited, retried on failure, and logged below — nothing is silent.'));
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
  const nameInput = el('input', { type: 'text', placeholder: 'Display name' });
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
      fieldsSlot.appendChild(el('div', {}, [el('label', {}, `${field} (secret)`), input]));
    }
    fieldsSlot._get = () => ({
      config: Object.fromEntries(Object.entries(configInputs).map(([k, i]) => [k, i.value.trim()])),
      credentials: Object.fromEntries(Object.entries(credInputs).map(([k, i]) => [k, i.value])),
    });
  }
  providerSelect.addEventListener('change', renderFields);
  renderFields();

  const connectBtn = el('button', { class: 'primary' }, 'Connect');
  connectBtn.addEventListener('click', async () => {
    if (!nameInput.value.trim()) {
      errorSlot.appendChild(errorBanner('A display name is required.'));
      return;
    }
    connectBtn.disabled = true;
    try {
      const { config, credentials } = fieldsSlot._get();
      await api.post('/api/integrations/connections', { provider: providerSelect.value, displayName: nameInput.value.trim(), config, credentials });
      toast('Integration connected.', 'success');
      nameInput.value = '';
      await loadConnections();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      connectBtn.disabled = false;
    }
  });

  formCard.appendChild(el('h3', { style: 'margin-top:0' }, 'Connect a provider'));
  formCard.appendChild(el('div', { class: 'form-row' }, [
    el('div', {}, [el('label', {}, 'Provider'), providerSelect]),
    el('div', {}, [el('label', {}, 'Display name'), nameInput]),
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
      connectionsSlot.appendChild(el('h3', {}, 'Connections'));
      connectionsSlot.appendChild(table(
        [
          { label: 'Provider', key: 'provider' },
          { label: 'Name', key: 'displayName' },
          { label: 'Status', render: (c) => statusBadge(c.status) },
          { label: 'Last used', render: (c) => c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString() : 'never' },
          { label: 'Last error', render: (c) => c.lastError || '' },
          { label: '', render: (c) => {
            if (c.status === 'disconnected') return '';
            const btn = el('button', { class: 'danger' }, 'Disconnect');
            btn.addEventListener('click', async () => {
              if (!(await confirmModal(`Disconnect "${c.displayName}"? Its stored credentials will be deleted.`, { danger: true }))) return;
              try {
                await api.delete(`/api/integrations/connections/${c.id}`);
                toast('Integration disconnected.', 'success');
                await loadConnections();
              } catch (err) {
                errorSlot.appendChild(errorBanner(err.message));
              }
            });
            return btn;
          } },
        ],
        page.items,
        { empty: 'No integrations connected yet.' },
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
      eventsSlot.appendChild(el('h3', {}, 'Delivery log'));
      eventsSlot.appendChild(table(
        [
          { label: 'Provider', key: 'provider' },
          { label: 'Action', key: 'action' },
          { label: 'Status', render: (e) => statusBadge(e.status) },
          { label: 'Attempts', key: 'attempts' },
          { label: 'Error', render: (e) => e.error || '' },
          { label: 'When', render: (e) => new Date(e.createdAt).toLocaleString() },
        ],
        page.items.slice().reverse(),
        { empty: 'No delivery attempts logged yet.' },
      ));
      eventsSlot.appendChild(paginationControls(page, (next) => { eventsOffset = next; loadEvents(); }));
    } catch (err) {
      clear(eventsSlot);
      eventsSlot.appendChild(errorBanner(err.message));
    }
  }

  await Promise.all([loadConnections(), loadEvents()]);
}
