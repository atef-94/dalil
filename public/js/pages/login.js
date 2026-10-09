import { el, clear, errorBanner } from '../ui.js';
import { api, setToken, saveCompanyId, getSavedCompanyId } from '../api.js';
import { t } from '../i18n.js';
import { getLocale, setLocale } from '../state.js';

// Public self-service registration has been removed platform-wide (accounts
// are created only by a platform owner or via an admin-issued invitation —
// see InvitationService / PlatformAdminService on the backend). This page
// therefore renders only the Login form; there is no Sign Up tab to switch
// to and no 'signup' mode.
export function renderLogin(container, { onSuccess }) {
  clear(container);
  let locale = getLocale();

  const errorSlot = el('div');

  const companyId = el('input', { type: 'text', placeholder: t(locale, 'field_company_id'), value: getSavedCompanyId() });
  const email = el('input', { type: 'email', placeholder: t(locale, 'login_email_placeholder') });
  const password = el('input', { type: 'password', placeholder: '••••••••' });

  const body = el('div', {}, [
    el('label', {}, t(locale, 'field_company_id')),
    companyId,
    el('label', {}, t(locale, 'field_email')),
    email,
    el('label', {}, t(locale, 'field_password')),
    password,
  ]);

  const submitBtn = el('button', { id: 'auth-submit', class: 'primary', style: 'width:100%;margin-top:16px' }, t(locale, 'submit_login'));

  async function submit() {
    clear(errorSlot);
    submitBtn.disabled = true;
    try {
      const result = await api.post('/api/auth/login', {
        companyId: companyId.value.trim(),
        email: email.value.trim(),
        password: password.value,
      });
      setToken(result.token);
      saveCompanyId(result.companyId);
      onSuccess();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message || t(locale, 'generic_error')));
    } finally {
      submitBtn.disabled = false;
    }
  }

  submitBtn.addEventListener('click', submit);
  [companyId, email, password].forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
  });

  // The main app-shell locale toggle only exists once signed in — this lets
  // a user pick Arabic/English before they even have an account or session.
  const localeToggle = el('select', { id: 'locale-toggle-auth', style: 'width:auto;margin-bottom:14px' }, [
    el('option', { value: 'en' }, 'English'),
    el('option', { value: 'ar' }, 'العربية'),
  ]);
  localeToggle.value = locale;
  localeToggle.addEventListener('change', () => {
    setLocale(localeToggle.value);
    renderLogin(container, { onSuccess });
  });

  const card = el('div', { class: 'auth-card' }, [
    localeToggle,
    el('h1', {}, t(locale, 'login_title')),
    el('p', { class: 'subtitle' }, t(locale, 'login_subtitle')),
    errorSlot,
    body,
    submitBtn,
  ]);
  container.appendChild(el('div', { class: 'auth-page' }, card));
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
}
