import { el, clear, errorBanner } from '../ui.js';
import { api, setToken, saveCompanyId, getSavedCompanyId } from '../api.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';

export function renderLogin(container, { onSuccess }) {
  clear(container);
  const locale = getLocale();
  let mode = 'login';

  const errorSlot = el('div');

  const companyId = el('input', { type: 'text', placeholder: 'Company ID', value: getSavedCompanyId() });
  const email = el('input', { type: 'email', placeholder: 'you@company.com' });
  const password = el('input', { type: 'password', placeholder: '••••••••' });
  const companyName = el('input', { type: 'text', placeholder: 'Acme Real Estate' });
  const fullName = el('input', { type: 'text', placeholder: 'Your full name' });

  const loginFields = el('div', {}, [
    el('label', {}, 'Company ID'),
    companyId,
    el('label', {}, 'Email'),
    email,
    el('label', {}, 'Password'),
    password,
  ]);

  const signupEmail = el('input', { type: 'email', placeholder: 'you@company.com' });
  const signupPassword = el('input', { type: 'password', placeholder: 'At least 8 characters' });
  const signupFields = el('div', {}, [
    el('label', {}, 'Organization name'), companyName,
    el('label', {}, 'Your full name'), fullName,
    el('label', {}, 'Email'), signupEmail,
    el('label', {}, 'Password'), signupPassword,
  ]);

  const submitBtn = el('button', { id: 'auth-submit', class: 'primary', style: 'width:100%;margin-top:16px' }, t(locale, 'submit_login'));

  const body = el('div', {}, [loginFields]);

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
      errorSlot.appendChild(errorBanner(err.message || 'Something went wrong.'));
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

  const tabLogin = el('button', { id: 'auth-tab-login', class: 'active' }, t(locale, 'tab_login'));
  const tabSignup = el('button', { id: 'auth-tab-signup' }, t(locale, 'tab_signup'));
  const title = el('h1', {}, t(locale, 'login_title'));
  const subtitle = el('p', { class: 'subtitle' }, t(locale, 'login_subtitle'));

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

  const card = el('div', { class: 'auth-card' }, [
    title,
    subtitle,
    el('div', { class: 'auth-tabs' }, [tabLogin, tabSignup]),
    errorSlot,
    body,
    submitBtn,
  ]);
  container.appendChild(el('div', { class: 'auth-page' }, card));
}
