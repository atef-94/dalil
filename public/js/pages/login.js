import { el, clear, errorBanner } from '../ui.js';
import { api, setToken, saveCompanyId, getSavedCompanyId } from '../api.js';
import { t } from '../i18n.js';
import { getLocale, setLocale } from '../state.js';

export function renderLogin(container, { onSuccess }, initialMode = 'login') {
  clear(container);
  let locale = getLocale();
  let mode = initialMode;

  const errorSlot = el('div');

  const companyId = el('input', { type: 'text', placeholder: t(locale, 'field_company_id'), value: getSavedCompanyId() });
  const email = el('input', { type: 'email', placeholder: t(locale, 'login_email_placeholder') });
  const password = el('input', { type: 'password', placeholder: '••••••••' });
  const companyName = el('input', { type: 'text', placeholder: t(locale, 'signup_company_name_placeholder') });
  const fullName = el('input', { type: 'text', placeholder: t(locale, 'field_full_name') });

  const companyIdLabel = el('label', {}, t(locale, 'field_company_id'));
  const emailLabel1 = el('label', {}, t(locale, 'field_email'));
  const passwordLabel1 = el('label', {}, t(locale, 'field_password'));
  const loginFields = el('div', {}, [
    companyIdLabel,
    companyId,
    emailLabel1,
    email,
    passwordLabel1,
    password,
  ]);

  const signupEmail = el('input', { type: 'email', placeholder: t(locale, 'login_email_placeholder') });
  const signupPassword = el('input', { type: 'password', placeholder: t(locale, 'crm_portal_password_placeholder') });
  const orgNameLabel = el('label', {}, t(locale, 'field_org_name'));
  const fullNameLabel = el('label', {}, t(locale, 'field_full_name'));
  const emailLabel2 = el('label', {}, t(locale, 'field_email'));
  const passwordLabel2 = el('label', {}, t(locale, 'field_password'));
  const signupFields = el('div', {}, [
    orgNameLabel, companyName,
    fullNameLabel, fullName,
    emailLabel2, signupEmail,
    passwordLabel2, signupPassword,
  ]);

  const submitBtn = el('button', { id: 'auth-submit', class: 'primary', style: 'width:100%;margin-top:16px' }, t(locale, mode === 'login' ? 'submit_login' : 'submit_signup'));

  const body = el('div', {}, [mode === 'login' ? loginFields : signupFields]);

  async function submit() {
    clear(errorSlot);
    submitBtn.disabled = true;
    try {
      if (mode === 'login') {
        const result = await api.post('/api/auth/login', {
          companyId: companyId.value.trim(),
          email: email.value.trim(),
          password: password.value,
        });
        setToken(result.token);
        saveCompanyId(result.companyId);
      } else {
        const result = await api.post('/api/auth/signup', {
          companyName: companyName.value.trim(),
          fullName: fullName.value.trim(),
          email: signupEmail.value.trim(),
          password: signupPassword.value,
          locale,
        });
        setToken(result.token);
        saveCompanyId(result.companyId);
      }
      onSuccess();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message || t(locale, 'generic_error')));
    } finally {
      submitBtn.disabled = false;
    }
  }

  submitBtn.addEventListener('click', submit);
  [companyId, email, password, companyName, fullName, signupEmail, signupPassword].forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
  });

  const tabLogin = el('button', { id: 'auth-tab-login', class: mode === 'login' ? 'active' : '' }, t(locale, 'tab_login'));
  const tabSignup = el('button', { id: 'auth-tab-signup', class: mode === 'signup' ? 'active' : '' }, t(locale, 'tab_signup'));
  const title = el('h1', {}, t(locale, mode === 'login' ? 'login_title' : 'signup_title'));
  const subtitle = el('p', { class: 'subtitle' }, t(locale, mode === 'login' ? 'login_subtitle' : 'signup_subtitle'));

  function setMode(next) {
    mode = next;
    clear(body);
    if (next === 'login') {
      tabLogin.classList.add('active');
      tabSignup.classList.remove('active');
      title.textContent = t(locale, 'login_title');
      subtitle.textContent = t(locale, 'login_subtitle');
      submitBtn.textContent = t(locale, 'submit_login');
      body.appendChild(loginFields);
    } else {
      tabSignup.classList.add('active');
      tabLogin.classList.remove('active');
      title.textContent = t(locale, 'signup_title');
      subtitle.textContent = t(locale, 'signup_subtitle');
      submitBtn.textContent = t(locale, 'submit_signup');
      body.appendChild(signupFields);
    }
  }
  tabLogin.addEventListener('click', () => setMode('login'));
  tabSignup.addEventListener('click', () => setMode('signup'));

  // The main app-shell locale toggle only exists once signed in — this lets
  // a user pick Arabic/English before they even have an account or session.
  const localeToggle = el('select', { id: 'locale-toggle-auth', style: 'width:auto;margin-bottom:14px' }, [
    el('option', { value: 'en' }, 'English'),
    el('option', { value: 'ar' }, 'العربية'),
  ]);
  localeToggle.value = locale;
  localeToggle.addEventListener('change', () => {
    setLocale(localeToggle.value);
    renderLogin(container, { onSuccess }, mode);
  });

  const card = el('div', { class: 'auth-card' }, [
    localeToggle,
    title,
    subtitle,
    el('div', { class: 'auth-tabs' }, [tabLogin, tabSignup]),
    errorSlot,
    body,
    submitBtn,
  ]);
  container.appendChild(el('div', { class: 'auth-page' }, card));
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
}
