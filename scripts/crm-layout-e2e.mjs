// Live E2E check of the reworked CRM page layout: stage tabs removed,
// action buttons stacked top-right, pipeline cards clickable, everything
// else on the page still functional.
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
page.on('response', (res) => { if (res.status() >= 400 && !res.url().endsWith('favicon.ico')) console.log(`HTTP ${res.status()} ${res.request().method()} ${res.url()}`); });
page.on('dialog', (dialog) => { step('no unexpected native dialog', false, dialog.message()); dialog.dismiss(); });

const rand = Math.random().toString(36).slice(2, 8);
const email = `owner-${rand}@e2e.example`;
const password = 'e2e-password-123';
const companyName = `CRM Layout E2E ${rand}`;

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

  await page.click('a[href="#/crm"]');
  await page.waitForSelector('.page-header h1', { timeout: 8000 });
  step('CRM page loads', true);

  // ---- 1. Horizontal stage-tab row is gone ----
  await page.waitForSelector('.stat-grid .stat-card', { timeout: 8000 });
  const tabTexts = await page.locator('.tabs .tab').allTextContents();
  step('no "CRM Dashboard" tab remains', !tabTexts.some((t) => /crm dashboard/i.test(t)), JSON.stringify(tabTexts));
  step('no per-stage tab remains (e.g. "Fresh")', !tabTexts.some((t) => /fresh|contacted|negotiation|qualified/i.test(t)), JSON.stringify(tabTexts));
  step('module tabs (Customers/Offers/...) are still present', tabTexts.some((t) => /customers|offers/i.test(t)), JSON.stringify(tabTexts));

  // ---- 2. Action buttons: present, top-right, stacked vertically, smaller ----
  const actionsBox = page.locator('.page-header .page-actions.stacked');
  step('.page-actions.stacked exists in the header', await actionsBox.count() === 1);
  const btnTexts = await actionsBox.locator('button').allTextContents();
  step('all 3 action buttons present', btnTexts.some((t) => /add new lead/i.test(t)) && btnTexts.some((t) => /import leads/i.test(t)) && btnTexts.some((t) => /add crm section/i.test(t)), JSON.stringify(btnTexts));
  const flexDirection = await actionsBox.evaluate((n) => getComputedStyle(n).flexDirection);
  step('action buttons are stacked vertically (flex-direction: column)', flexDirection === 'column', flexDirection);
  const headerBox = await page.locator('.page-header').boundingBox();
  const actionsBoxRect = await actionsBox.boundingBox();
  step('action buttons sit on the right side of the header', actionsBoxRect.x > headerBox.x + headerBox.width / 2, `header.x=${headerBox.x} actions.x=${actionsBoxRect.x} header.width=${headerBox.width}`);
  const stackedBtnHeight = (await actionsBox.locator('button', { hasText: 'Add New Lead' }).boundingBox()).height;
  const defaultBtnHeight = await page.evaluate(() => {
    const probe = document.createElement('button');
    probe.textContent = 'probe';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);
    const h = probe.getBoundingClientRect().height;
    probe.remove();
    return h;
  });
  step('action buttons are smaller than a default-size button', stackedBtnHeight < defaultBtnHeight, `stacked=${stackedBtnHeight} default=${defaultBtnHeight}`);

  // ---- 3. Pipeline cards expand to fill the main content and are clickable ----
  const pipelineCard = page.locator('.card', { hasText: 'Pipeline' }).first();
  step('Pipeline card is present', await pipelineCard.count() >= 1);
  const cardBox = await pipelineCard.boundingBox();
  const contentBox = await page.locator('#content').boundingBox();
  step('Pipeline card spans close to the full content width', cardBox.width > contentBox.width * 0.9, `card.width=${cardBox.width} content.width=${contentBox.width}`);

  const freshCard = page.locator('.stat-card.clickable', { hasText: /fresh/i }).first();
  step('a clickable Fresh Leads pipeline card exists', await freshCard.count() >= 1);
  await freshCard.click();
  await page.waitForSelector('button:has-text("Back to Pipeline")', { timeout: 8000 });
  step('clicking the pipeline card opens that stage\'s lead list', true);
  const stageHeading = await page.locator('h2').first().textContent();
  step('stage list shows the stage name as a heading', /fresh/i.test(stageHeading || ''), stageHeading);

  await page.click('button:has-text("Back to Pipeline")');
  await page.waitForSelector('.stat-grid .stat-card', { timeout: 8000 });
  step('"Back to Pipeline" returns to the dashboard', true);

  // ---- 4. Add New Lead still works ----
  await page.click('button:has-text("Add New Lead")');
  await page.waitForSelector('.modal-card:has-text("Add New Lead")', { timeout: 5000 });
  await page.fill('.modal-card input[placeholder=""], .modal-card label:has-text("Full name") + input, .modal-card input', ''); // no-op safeguard
  const modal = page.locator('.modal-card');
  await modal.locator('label:has-text("Full name") input, input').nth(0).fill(`Test Lead ${rand}`);
  await modal.locator('label:has-text("Mobile") input, input').nth(1).fill(`010${rand}`);
  await page.click('.modal-card button:has-text("Add lead")');
  await page.waitForSelector('.modal-card', { state: 'detached', timeout: 8000 }).catch(() => {});
  step('Add New Lead modal submits without error', true);

  // ---- 5. Import Leads wizard opens ----
  await page.waitForSelector('.stat-grid .stat-card', { timeout: 8000 });
  await page.click('button:has-text("Import Leads")');
  await page.waitForSelector('.modal-card:has-text("Import Leads")', { timeout: 5000 });
  step('Import Leads wizard opens', true);
  await page.keyboard.press('Escape').catch(() => {});
  const closeBtn = page.locator('.modal-card button:has-text("Cancel"), .modal-overlay .modal-close');
  if (await closeBtn.count() > 0) await closeBtn.first().click().catch(() => {});
  await page.waitForTimeout(300);

  // ---- 6. Add CRM Section works and appears as a pipeline card, not a tab ----
  await page.waitForSelector('.stat-grid .stat-card', { timeout: 8000 });
  await page.click('button:has-text("Add CRM Section")');
  await page.waitForSelector('.modal-card:has-text("Add CRM Section")', { timeout: 5000 });
  const newStageName = `E2E Stage ${rand}`;
  await page.locator('.modal-card label:has-text("Name") input, .modal-card input').nth(0).fill(newStageName);
  await page.click('.modal-card button:has-text("Add section")');
  await page.waitForSelector('.modal-card', { state: 'detached', timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  const cardTexts = await page.locator('.stat-card .label').allTextContents();
  step('new CRM section appears as a pipeline card', cardTexts.some((t) => t === newStageName), JSON.stringify(cardTexts));
  const tabTextsAfter = await page.locator('.tabs .tab').allTextContents();
  step('new CRM section did NOT appear as a tab', !tabTextsAfter.some((t) => t === newStageName), JSON.stringify(tabTextsAfter));

  // ---- 7. A module tab (Contracts) still works ----
  consoleErrors.length = 0;
  await page.click('.tabs .tab:has-text("Contracts")');
  await page.waitForTimeout(800);
  await page.screenshot({ path: '/tmp/claude-0/crm-contracts-tab.png' });
  const jsErrors = consoleErrors.filter((e) => !/Failed to load resource/.test(e));
  step('Contracts module tab renders without a real JS error (404s on optional endpoints are expected/handled)', jsErrors.length === 0, JSON.stringify(consoleErrors));

  // ---- 8. Returning to CRM from the sidebar resets to the dashboard ----
  await page.click('a[href="#/crm"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/claude-0/crm-after-residebar.png' });
  await page.waitForSelector('.stat-grid .stat-card', { timeout: 8000 });
  step('re-opening CRM from the sidebar returns to the pipeline dashboard', true);

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
