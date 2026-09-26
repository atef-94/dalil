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
    t(locale, 'communication_info_text')));

  const toUserIdInput = el('input', { type: 'text', placeholder: t(locale, 'communication_recipient_placeholder') });
  const channelSelect = selectInput(['internal', 'email', 'whatsapp', 'sms'].map((c) => ({ value: c, label: c })));
  const subjectInput = el('input', { type: 'text', placeholder: t(locale, 'automation_field_subject') });
  const bodyInput = el('textarea', { rows: 3, placeholder: t(locale, 'communication_body_placeholder') });
  const sendBtn = el('button', { class: 'primary' }, t(locale, 'crm_send_btn'));

  sendBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!subjectInput.value.trim() || !bodyInput.value.trim()) {
      errorSlot.appendChild(errorBanner(t(locale, 'communication_err_required')));
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
      toast(t(locale, 'communication_sent_toast'), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      sendBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'communication_send_message_title')),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'communication_to_field')), toUserIdInput]),
      el('div', {}, [el('label', {}, t(locale, 'crm_activity_channel_field')), channelSelect]),
      el('div', {}, [el('label', {}, t(locale, 'automation_field_subject')), subjectInput]),
    ]),
    el('div', {}, [el('label', {}, t(locale, 'communication_body_field')), bodyInput]),
    el('div', { class: 'form-actions' }, [sendBtn]),
  ]));

  const search = searchInput(t(locale, 'communication_search_placeholder'), (value) => { q = value; offset = 0; load(); });
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
          { label: t(locale, 'automation_field_subject'), key: 'subject' },
          { label: t(locale, 'crm_activity_channel_field'), render: (m) => statusBadge(m.channel) },
          { label: t(locale, 'common_col_from'), render: (m) => m.fromUserId.slice(0, 8) + '…' },
          { label: t(locale, 'crm_timeline_to_field'), render: (m) => (m.toUserId ? m.toUserId.slice(0, 8) + '…' : '—') },
          { label: t(locale, 'common_col_status'), render: (m) => statusBadge(m.status) },
          { label: t(locale, 'communication_col_sent'), render: (m) => new Date(m.createdAt).toLocaleString() },
        ],
        page.items,
        { empty: t(locale, 'communication_empty_messages') },
      ));
      listSlot.appendChild(paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
}
