// Live E2E check of the session-expiry UX fix: a 401 from any API call
// (simulated here by corrupting the stored token, the same end state as a
// real 15-min-then-12h TTL expiry) should show a clear "session expired"
// toast and drop the user back to the login screen — not leave the
// already-rendered page up with random actions throwing raw error text.
import { chromium } from 'playwright';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3199';
const results = [];
function step(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`);
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', (err) => step('no uncaught page error', false, err.message));
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

const rand = Math.random().toString(36).slice(2, 8);
const email = `owner-${rand}@e2e.example`;
const password = 'e2e-password-123';
const companyName = `Session Expiry E2E ${rand}`;

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.click('#auth-tab-signup');
  await page.fill('input[placeholder="Acme Real Estate"]', companyName);
  await page.fill('input[placeholder="Your full name"]', 'E2E Owner');
  await page.locator('input[type="email"]').nth(0).fill(email);
  await page.locator('input[type="password"]').nth(0).fill(password);
  await page.click('#auth-submit');
  await page.waitForSelector('#sidebar', { timeout: 8000 });
  step('signup lands in the app shell', true);

  // Simulate token expiry the same way a real 401 would happen: corrupt
  // the stored token so the next API call is rejected, without touching
  // any already-rendered DOM — this is exactly the mid-session-expiry case.
  await page.evaluate(() => localStorage.setItem('active_os_token', 'corrupted.invalid.token'));
  step('corrupted the stored token to simulate an expired/invalid session', true);

  // Trigger a real API call (navigating to CRM fetches stages/leads).
  await page.click('a[href="#/crm"]');

  await page.waitForSelector('.toast.error', { timeout: 5000 });
  const toastText = await page.locator('.toast.error').first().textContent();
  step('a session-expired toast is shown', /session expired|sign in again/i.test(toastText || ''), toastText);

  await page.waitForSelector('#auth-tab-login, #auth-tab-signup', { timeout: 5000 });
  step('the app drops back to the login screen (not a broken half-logged-in page)', true);

  const sidebarStillThere = await page.locator('#sidebar').count();
  step('the old app shell is gone, replaced by the login screen', sidebarStillThere === 0, `sidebar count=${sidebarStillThere}`);

  // Confirm logging back in works cleanly after the forced logout.
  await page.click('#auth-tab-login');
  await page.locator('input[type="email"]').nth(0).fill(email);
  await page.locator('input[type="password"]').nth(0).fill(password);
  await page.click('#auth-submit');
  await page.waitForSelector('#sidebar', { timeout: 8000 });
  step('logging back in after a session-expiry works cleanly', true);

} catch (err) {
  step('unexpected exception', false, err.stack || err.message);
} finally {
  const realJsErrors = consoleErrors.filter((e) => !/Failed to load resource/.test(e));
  step('no real JS console errors accumulated during the run', realJsErrors.length === 0, JSON.stringify(consoleErrors));
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.log('FAILURES:', JSON.stringify(failed, null, 2));
  process.exit(1);
}
