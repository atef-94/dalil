import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { call, withServer } from './test-support/test-app.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mandatory proof point 1: "Public registration is blocked at both frontend
// and backend levels."

test('POST /api/auth/signup (the old public self-service signup route) no longer exists', async () => {
  await withServer(async (base) => {
    const attempt = await call(base, 'POST', '/api/auth/signup', {
      companyName: 'Attacker Co', fullName: 'Attacker', email: `attacker-${Date.now()}@evil.example`, password: 'whatever12345',
    });
    assert.ok([404, 410].includes(attempt.status), `expected 404/410, got ${attempt.status}`);
  });
});

test('POST /api/organization/companies (the old public bare-company-creation route) no longer exists', async () => {
  await withServer(async (base) => {
    const attempt = await call(base, 'POST', '/api/organization/companies', { name: `Attacker Co ${Date.now()}` });
    assert.ok([404, 410].includes(attempt.status), `expected 404/410, got ${attempt.status}`);
  });
});

test('an unauthenticated caller cannot create an account through any other known auth route either', async () => {
  await withServer(async (base) => {
    // /api/auth/register exists but requires an authenticated, already-
    // privileged actor (create:employee) — never reachable by an anonymous
    // caller. This proves that path specifically, distinct from the
    // removed public signup route above.
    const attempt = await call(base, 'POST', '/api/auth/register', {
      companyId: 'company-demo', email: `anon-${Date.now()}@evil.example`, password: 'whatever12345', userType: 'employee_user',
    });
    assert.equal(attempt.status, 401);
  });
});

test('the frontend login page source contains no Sign Up tab, fields, or submit handler', () => {
  const source = readFileSync(join(__dirname, '..', 'public', 'js', 'pages', 'login.js'), 'utf8');
  assert.equal(source.includes('/api/auth/signup'), false, 'login.js must not call the removed signup route');
  assert.equal(source.includes("'auth-tab-signup'"), false, 'login.js must not render a Sign Up tab');
  assert.equal(/\bmode\s*===?\s*['"]signup['"]/.test(source), false, "login.js must not have a 'signup' UI mode");
});

test('the frontend i18n dictionary carries no orphaned Sign Up strings for the login page', () => {
  const source = readFileSync(join(__dirname, '..', 'public', 'js', 'i18n.js'), 'utf8');
  for (const key of ['signup_title', 'tab_signup', 'submit_signup', 'signup_subtitle', 'signup_company_name_placeholder']) {
    assert.equal(source.includes(key), false, `i18n.js must not define ${key}`);
  }
});
