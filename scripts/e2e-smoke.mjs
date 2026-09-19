// Manual E2E smoke test: drives the real running app in a real browser to
// prove the frontend actually works end-to-end, not just the API.
// Usage: node scripts/e2e-smoke.mjs (expects the server already running on
// BASE_URL, default http://localhost:3094)
import { chromium } from 'playwright';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3094';
const results = [];

function step(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`);
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', (err) => step('no uncaught page errors', false, err.message));
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('response', (res) => {
  if (res.status() >= 400 && !res.url().endsWith('favicon.ico')) {
    console.log(`HTTP ${res.status()} ${res.request().method()} ${res.url()}`);
  }
});

// The app no longer uses window.prompt/confirm — it has real in-app modals
// (.modal-overlay/.modal-card, see public/js/ui.js). No native dialog
// handler is needed; interact with the modal DOM directly instead.
page.on('dialog', (dialog) => {
  step('no unexpected native browser dialogs', false, `unexpected dialog: ${dialog.message()}`);
  dialog.dismiss();
});

const rand = Math.random().toString(36).slice(2, 8);
const email = `owner-${rand}@e2e.example`;
const password = 'e2e-password-123';
const companyName = `E2E Realty ${rand}`;

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  step('landing page loads', await page.locator('.auth-card').isVisible());

  await page.click('#auth-tab-signup');
  await page.fill('input[placeholder="Acme Real Estate"]', companyName);
  await page.fill('input[placeholder="Your full name"]', 'E2E Owner');
  const signupEmailInput = page.locator('input[type="email"]').nth(0);
  await signupEmailInput.fill(email);
  await page.locator('input[type="password"]').nth(0).fill(password);
  await page.click('#auth-submit');
  try {
    await page.waitForSelector('#sidebar', { timeout: 8000 });
    step('signup creates a real account and lands in the app shell', true);
  } catch (err) {
    const bannerText = await page.locator('.error-banner').allTextContents().catch(() => []);
    step('signup creates a real account and lands in the app shell', false, `banner=${JSON.stringify(bannerText)} err=${err.message}`);
    throw err;
  }

  await page.waitForSelector('.stat-grid', { timeout: 8000 });
  step('dashboard renders with live stats', await page.locator('.stat-grid').isVisible());

  // ---- Leads ----
  await page.click('a[href="#/leads"]');
  await page.waitForSelector('h1:has-text("Leads")');
  await page.fill('input[placeholder="Full name"]', 'Sara Client');
  await page.fill('input[placeholder="010-000-0000"]', '0501234567');
  await page.click('button:has-text("Add lead")');
  await page.waitForSelector('text=Sara Client', { timeout: 5000 });
  step('lead created and appears in the list', true);

  const saraRow = page.locator('tr', { hasText: 'Sara Client' });
  await saraRow.locator('button:has-text("Requirements")').click();
  await page.waitForSelector('.modal-card:has-text("Requirements for Sara Client")', { timeout: 5000 });
  await page.fill('.modal-card input[placeholder="e.g. apartment, villa"]', 'apartment');
  await page.click('.modal-card button:has-text("Save requirements")');
  await page.waitForSelector('.modal-overlay', { state: 'detached', timeout: 5000 });
  step('lead custom fields (requirements) saved via the real in-app modal', true);

  await saraRow.locator('button:has-text("Timeline")').click();
  await page.waitForSelector('.modal-card:has-text("Sara Client — Timeline")', { timeout: 5000 });
  await page.waitForSelector('.modal-card:has-text("Lead created")', { timeout: 5000 });
  step('lead unified timeline shows the real lead_created entry', true);
  await page.click('.modal-close');
  await page.waitForSelector('.modal-overlay', { state: 'detached', timeout: 5000 });

  await page.click('button:has-text("→ contacted")');
  await page.waitForTimeout(300);
  await page.click('button:has-text("→ qualified")');
  await page.waitForSelector('.badge:has-text("qualified")', { timeout: 5000 });
  step('lead advances through status transitions', true);

  // A second, disposable lead just to exercise the "mark lost" modal
  // (a textarea-based formModal) without disturbing the qualified lead the
  // rest of the flow depends on.
  await page.fill('input[placeholder="Full name"]', 'Disposable Lost Lead');
  await page.fill('input[placeholder="010-000-0000"]', '0509999999');
  await page.click('button:has-text("Add lead")');
  await page.waitForSelector('text=Disposable Lost Lead', { timeout: 5000 });
  const lostLeadRow = page.locator('tr', { hasText: 'Disposable Lost Lead' });
  await lostLeadRow.locator('button:has-text("Mark lost")').click();
  await page.waitForSelector('.modal-card:has-text("Mark")', { timeout: 5000 });
  await page.fill('.modal-card textarea', 'E2E test reason');
  await page.click('.modal-card button:has-text("Mark lost")');
  await page.waitForSelector('tr:has-text("Disposable Lost Lead") .badge:has-text("lost")', { timeout: 5000 });
  step('lead marked lost via the real in-app modal (textarea formModal)', true);

  // ---- Inventory ----
  await page.click('a[href="#/units"]');
  await page.waitForSelector('h1:has-text("Inventory")');
  await page.fill('input[placeholder="proj-1"]', 'proj-e2e');
  await page.fill('input[placeholder="A-101"]', `U-${rand}`);
  await page.fill('input[placeholder="apartment"]', 'apartment');
  await page.fill('input[placeholder="120"]', '140');
  await page.fill('input[placeholder="1500000"]', '900000');
  await page.click('button:has-text("Add unit")');
  await page.waitForSelector(`text=U-${rand}`, { timeout: 5000 });
  step('unit created and appears in inventory', true);

  // ---- Payment plan template ----
  await page.click('a[href="#/templates"]');
  await page.waitForSelector('h1:has-text("Payment Plan Templates")');
  await page.fill('input[placeholder="Standard 5yr Plan"]', 'E2E Plan');
  await page.fill('input[placeholder="10"]', '10');
  await page.fill('input[placeholder="60"]', '24');
  await page.click('button:has-text("Create template")');
  await page.waitForSelector('td:has-text("E2E Plan")', { timeout: 5000 });
  step('payment plan template created', true);

  // ---- Opportunity -> reserve -> sign ----
  await page.click('a[href="#/opportunities"]');
  await page.waitForSelector('h1:has-text("Sales Opportunities")');
  await page.selectOption('#opp-lead-select', { label: 'Sara Client' });
  await page.click('button:has-text("Create opportunity")');
  await page.waitForSelector('.badge:has-text("open")', { timeout: 5000 });
  step('opportunity created from qualified lead', true);

  await page.click('button:has-text("Reserve unit")');
  await page.waitForSelector('.modal-card:has-text("Reserve a unit")', { timeout: 5000 });
  await page.locator('.modal-card select').selectOption({ index: 0 }); // the one unit just created
  await page.click('.modal-card button:has-text("Reserve")');
  await page.waitForSelector('.badge:has-text("reserved")', { timeout: 5000 });
  step('unit reserved via the real in-app modal (concurrency-protected path)', true);

  await page.click('button:has-text("Sign contract")');
  await page.waitForSelector('.modal-card:has-text("Sign contract")', { timeout: 5000 });
  await page.locator('.modal-card select').selectOption({ index: 0 }); // the one template just created
  await page.fill('.modal-card input[type="number"]', '900000');
  await page.click('.modal-card button:has-text("Sign contract")');
  await page.waitForSelector('.badge:has-text("won")', { timeout: 5000 });
  step('contract signed via the real in-app modal, opportunity moves to won', true);

  // ---- Finance ----
  await page.click('a[href="#/finance"]');
  await page.waitForSelector('h1:has-text("Finance")');
  await page.waitForSelector('.stat-card', { timeout: 5000 });
  step('finance page loads contract balance', await page.locator('.stat-card').first().isVisible());

  // ---- Roles & Permissions ----
  await page.click('a[href="#/roles"]');
  await page.waitForSelector('h1:has-text("Roles & Permissions")');
  await page.waitForSelector('table', { timeout: 5000 });
  step('roles page lists the auto-created Owner role', await page.locator('text=Owner').first().isVisible());

  await page.fill('input[placeholder="e.g. Sales Manager"]', 'E2E Disposable Role');
  await page.click('button:has-text("Create role")');
  await page.waitForSelector('tr:has-text("E2E Disposable Role")', { timeout: 5000 });
  const disposableRoleRow = page.locator('tr', { hasText: 'E2E Disposable Role' });
  await disposableRoleRow.locator('button:has-text("Manage grants")').click();
  await page.waitForSelector('h3:has-text("Grants for")', { timeout: 5000 });
  await page.click('button:has-text("Add grant")');
  await page.waitForSelector('tr:has-text("view")', { timeout: 5000 });
  step('custom role created and a grant added', true);

  await page.click('button:has-text("Revoke")');
  await page.waitForSelector('.modal-card:has-text("Please confirm")', { timeout: 5000 });
  await page.click('.modal-card button:has-text("Revoke")');
  await page.waitForSelector('text=No grants on this role yet', { timeout: 5000 });
  step('grant revoked via the real in-app confirm modal', true);

  // ---- Logout / session persistence ----
  await page.click('button:has-text("Log out")');
  await page.waitForSelector('.auth-card', { timeout: 5000 });
  step('logout returns to the auth screen', true);

  await page.fill('input[placeholder="Company ID"]', await page.evaluate(() => localStorage.getItem('active_os_company_id')));
  await page.locator('input[type="email"]').nth(0).fill(email);
  await page.locator('input[type="password"]').nth(0).fill(password);
  await page.click('#auth-submit');
  await page.waitForSelector('#sidebar', { timeout: 8000 });
  step('re-login with real credentials works', true);
} catch (err) {
  step('smoke run completed without throwing', false, err.message);
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
if (consoleErrors.length > 0) {
  console.log(`\nBrowser console errors (${consoleErrors.length}):`);
  consoleErrors.forEach((e) => console.log('  ' + e));
}
process.exit(failed.length > 0 ? 1 : 0);
