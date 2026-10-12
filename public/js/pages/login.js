import { el, clear, errorBanner } from '../ui.js';
import { api, setToken, saveCompanyId, getSavedCompanyId } from '../api.js';
import { t } from '../i18n.js';
import { getLocale, setLocale } from '../state.js';

// Public self-service registration has been removed platform-wide (accounts
// are created only by a platform owner or via an admin-issued invitation —
// see InvitationService / PlatformAdminService on the backend). This page
// therefore renders only the Login form; there is no Sign Up tab to switch
// to and no 'signup' mode.
//
// It also drives the full MFA lifecycle in-page, since /api/auth/login can
// hand back three different outcomes (see auth.service.ts login()):
//   1. a token straight away (MFA not enabled for this account)
//   2. a token + mfaSetupRequired:true (platform owner in production,
//      totpEnabled still false — must enroll before using the app)
//   3. 401 {error:'mfa_required'} (totpEnabled already true — needs a
//      totpCode, or one of the one-time recovery codes, to retry the
//      exact same login call)
export function renderLogin(container, { onSuccess }) {
  clear(container);
  let locale = getLocale();

  // Carries the password across the credentials -> code step (never stored
  // beyond this closure, never sent anywhere except the retried login call).
  let pendingCredentials = null;

  const card = el('div', { class: 'auth-card' });

  const localeToggle = el('select', { id: 'locale-toggle-auth', style: 'width:auto;margin-bottom:14px' }, [
    el('option', { value: 'en' }, 'English'),
    el('option', { value: 'ar' }, 'العربية'),
  ]);
  localeToggle.value = locale;
  localeToggle.addEventListener('change', () => {
    setLocale(localeToggle.value);
    renderLogin(container, { onSuccess });
  });

  function renderStep(buildBody) {
    clear(card);
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
    card.appendChild(localeToggle);
    buildBody(card);
  }

  // ---- Step 1: company/email/password ----
  function renderCredentialsStep(prefill) {
    renderStep((root) => {
      const errorSlot = el('div');
      const companyId = el('input', { type: 'text', placeholder: t(locale, 'field_company_id'), value: prefill?.companyId ?? getSavedCompanyId() });
      const email = el('input', { type: 'email', placeholder: t(locale, 'login_email_placeholder'), value: prefill?.email ?? '' });
      const password = el('input', { type: 'password', placeholder: '••••••••' });

      const submitBtn = el('button', { id: 'auth-submit', class: 'primary', style: 'width:100%;margin-top:16px' }, t(locale, 'submit_login'));

      async function submit() {
        clear(errorSlot);
        submitBtn.disabled = true;
        const credentials = { companyId: companyId.value.trim(), email: email.value.trim(), password: password.value };
        try {
          const result = await api.post('/api/auth/login', credentials);
          saveCompanyId(credentials.companyId);
          await handleLoginSuccess(result);
        } catch (err) {
          if (err.message === 'mfa_required') {
            pendingCredentials = credentials;
            renderCodeStep();
            return;
          }
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

      root.appendChild(el('h1', {}, t(locale, 'login_title')));
      root.appendChild(el('p', { class: 'subtitle' }, t(locale, 'login_subtitle')));
      root.appendChild(errorSlot);
      root.appendChild(el('div', {}, [
        el('label', {}, t(locale, 'field_company_id')), companyId,
        el('label', {}, t(locale, 'field_email')), email,
        el('label', {}, t(locale, 'field_password')), password,
      ]));
      root.appendChild(submitBtn);
      setTimeout(() => (prefill?.email ? password : email).focus(), 0);
    });
  }

  // ---- Step 2 (already-enrolled account): 6-digit code / recovery code ----
  function renderCodeStep() {
    renderStep((root) => {
      const errorSlot = el('div');
      const code = el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456' });

      const submitBtn = el('button', { class: 'primary', style: 'width:100%;margin-top:16px' }, t(locale, 'submit_verify'));
      const backBtn = el('button', { style: 'width:100%;margin-top:8px' }, t(locale, 'back_to_login'));

      async function submit() {
        clear(errorSlot);
        submitBtn.disabled = true;
        try {
          const result = await api.post('/api/auth/login', { ...pendingCredentials, totpCode: code.value.trim() });
          saveCompanyId(pendingCredentials.companyId);
          await handleLoginSuccess(result);
        } catch (err) {
          errorSlot.appendChild(errorBanner(err.message || t(locale, 'generic_error')));
        } finally {
          submitBtn.disabled = false;
        }
      }

      submitBtn.addEventListener('click', submit);
      code.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });
      backBtn.addEventListener('click', () => {
        pendingCredentials = null;
        renderCredentialsStep();
      });

      root.appendChild(el('h1', {}, t(locale, 'mfa_code_title')));
      root.appendChild(el('p', { class: 'subtitle' }, t(locale, 'mfa_code_subtitle')));
      root.appendChild(errorSlot);
      root.appendChild(el('div', {}, [el('label', {}, t(locale, 'field_mfa_code')), code]));
      root.appendChild(submitBtn);
      root.appendChild(backBtn);
      setTimeout(() => code.focus(), 0);
    });
  }

  // ---- Step 3 (first-ever login, MFA not yet enrolled): enroll TOTP ----
  async function renderEnrollStep() {
    renderStep((root) => {
      root.appendChild(el('p', { class: 'subtitle' }, '…'));
    });
    let enrollment;
    try {
      enrollment = await api.post('/api/me/mfa/enroll');
    } catch (err) {
      renderStep((root) => {
        root.appendChild(errorBanner(err.message || t(locale, 'generic_error')));
      });
      return;
    }

    renderStep((root) => {
      const errorSlot = el('div');
      const code = el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456' });
      const submitBtn = el('button', { class: 'primary', style: 'width:100%;margin-top:16px' }, t(locale, 'submit_enable_mfa'));

      async function submit() {
        clear(errorSlot);
        submitBtn.disabled = true;
        try {
          const result = await api.post('/api/me/mfa/verify', { code: code.value.trim() });
          renderRecoveryCodesStep(result.recoveryCodes);
        } catch (err) {
          errorSlot.appendChild(errorBanner(err.message || t(locale, 'generic_error')));
        } finally {
          submitBtn.disabled = false;
        }
      }

      submitBtn.addEventListener('click', submit);
      code.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });

      root.appendChild(el('h1', {}, t(locale, 'mfa_enroll_title')));
      root.appendChild(el('p', { class: 'subtitle' }, t(locale, 'mfa_enroll_subtitle')));
      root.appendChild(errorSlot);
      root.appendChild(el('div', {}, [
        el('label', {}, t(locale, 'mfa_enroll_secret_label')),
        el('div', { style: `font-family:var(--font-mono);font-size:13px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 10px;word-break:break-all;user-select:all` }, enrollment.secret),
        el('label', { style: 'margin-top:10px' }, t(locale, 'mfa_enroll_uri_label')),
        el('div', { style: `font-family:var(--font-mono);font-size:11px;color:var(--text-muted);background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 10px;word-break:break-all;user-select:all` }, enrollment.otpauthUri),
        el('label', { style: 'margin-top:10px' }, t(locale, 'field_mfa_code')),
        code,
      ]));
      root.appendChild(submitBtn);
      setTimeout(() => code.focus(), 0);
    });
  }

  // ---- Step 4 (first-ever login only): show the 10 one-time recovery codes ----
  function renderRecoveryCodesStep(recoveryCodes) {
    renderStep((root) => {
      const continueBtn = el('button', { class: 'primary', style: 'width:100%;margin-top:16px' }, t(locale, 'mfa_recovery_continue'));
      continueBtn.addEventListener('click', () => onSuccess());

      root.appendChild(el('h1', {}, t(locale, 'mfa_recovery_title')));
      root.appendChild(el('p', { class: 'subtitle' }, t(locale, 'mfa_recovery_subtitle')));
      root.appendChild(el('div', {
        style: `font-family:var(--font-mono);font-size:13px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;display:grid;grid-template-columns:1fr 1fr;gap:6px;user-select:all`,
      }, recoveryCodes.map((rc) => el('div', {}, rc))));
      root.appendChild(continueBtn);
    });
  }

  async function handleLoginSuccess(result) {
    setToken(result.token);
    if (result.mfaSetupRequired) {
      await renderEnrollStep();
    } else {
      onSuccess();
    }
  }

  renderCredentialsStep();
  container.appendChild(el('div', { class: 'auth-page' }, card));
}
