import { el, clear, table, toast, errorBanner, statusBadge, loadingState, selectInput, paginationControls, searchInput } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

export async function renderCommunication(container) {
  clear(container);
  const locale = getLocale();
  let offset = 0;
  let q = '';
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, t(locale, 'page_title_communication'))));
  const errorSlot = el('div');
  container.appendChild(errorSlot);
  container.appendChild(el('p', { style: 'color:var(--text-muted);font-size:12.5px;margin-top:-8px' },
    'Internal message log — not connected to a real email/WhatsApp/SMS provider yet. Messages are recorded here for the audit trail.'));

  const toUserIdInput = el('input', { type: 'text', placeholder: 'Recipient user ID (optional)' });
  const channelSelect = selectInput(['internal', 'email', 'whatsapp', 'sms'].map((c) => ({ value: c, label: c })));
  const subjectInput = el('input', { type: 'text', placeholder: 'Subject' });
  const bodyInput = el('textarea', { rows: 3, placeholder: 'Message body' });
  const sendBtn = el('button', { class: 'primary' }, 'Send');

  sendBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!subjectInput.value.trim() || !bodyInput.value.trim()) {
      errorSlot.appendChild(errorBanner('Enter a subject and a message body.'));
      return;
    }
    sendBtn.disabled = true;
    try {
      await api.post('/api/communication/messages', {
        toUserId: toUserIdInput.value.trim() || undefined,
        channel: channelSelect.value,
        subject: subjectInput.value.trim(),
        body: bodyInput.value.trim(),
      });
      subjectInput.value = '';
      bodyInput.value = '';
      toUserIdInput.value = '';
      toast('Message sent.', 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      sendBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Send a message'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'To (user ID)'), toUserIdInput]),
      el('div', {}, [el('label', {}, 'Channel'), channelSelect]),
      el('div', {}, [el('label', {}, 'Subject'), subjectInput]),
    ]),
    el('div', {}, [el('label', {}, 'Body'), bodyInput]),
    el('div', { class: 'form-actions' }, [sendBtn]),
  ]));

  const search = searchInput('Search by subject…', (value) => { q = value; offset = 0; load(); });
  container.appendChild(el('div', { class: 'form-row', style: 'max-width:320px' }, [search]));

  const listSlot = el('div');
  container.appendChild(listSlot);

  async function load() {
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/communication/my-messages', { limit: 20, offset, q });
      clear(listSlot);
      listSlot.appendChild(table(
        [
          { label: 'Subject', key: 'subject' },
          { label: 'Channel', render: (m) => statusBadge(m.channel) },
          { label: 'From', render: (m) => m.fromUserId.slice(0, 8) + '…' },
          { label: 'To', render: (m) => (m.toUserId ? m.toUserId.slice(0, 8) + '…' : '—') },
          { label: 'Status', render: (m) => statusBadge(m.status) },
          { label: 'Sent', render: (m) => new Date(m.createdAt).toLocaleString() },
        ],
        page.items,
        { empty: 'No messages yet — send one above.' },
      ));
      listSlot.appendChild(paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
