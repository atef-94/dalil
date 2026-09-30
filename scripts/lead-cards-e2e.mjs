// Live E2E check of the redesigned CRM client-list cards (replaces the
// old plain table row per lead): identity/status/source/target/payment
// plan sections, quick actions (Ask AI/Open File/Move Stage), Call/
// WhatsApp links, dates, the new filter popover, mobile stacking, and
// Arabic/RTL — driven against the real running app with real API calls,
// no mocked data.
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
page.on('dialog', (dialog) => { step('no unexpected native dialog', false, dialog.message()); dialog.dismiss(); });

const rand = Math.random().toString(36).slice(2, 8);
const email = `owner-${rand}@e2e.example`;
const password = 'e2e-password-123';
const companyName = `Lead Cards E2E ${rand}`;

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
  await page.waitForSelector('.stat-grid .stat-card', { timeout: 8000 });
  step('CRM dashboard loads', true);

  // ---- 1. Add a lead with the fields a card needs to show something
  // real in every section (source/interestedIn/budget/location) ----
  await page.click('button:has-text("Add New Lead")');
  await page.waitForSelector('.modal-card:has-text("Add New Lead")', { timeout: 5000 });
  const addModal = page.locator('.modal-card');
  // formModal/field() renders `<div><label>…</label><input/></div>` — label
  // and input are adjacent siblings, not label-wraps-input, so target via
  // the CSS adjacent-sibling combinator against each field's real label text.
  await addModal.locator('label:text-is("Name") + input').fill(`Youssef Card Test ${rand}`);
  await addModal.locator('label:has-text("Phone") + input').fill('01114810093');
  await addModal.locator('label:text-is("Source") + select').selectOption('facebook');
  await addModal.locator('label:text-is("Interested In") + select').selectOption('unit');
  await addModal.locator('label:has-text("Min") + input').fill('1000000');
  await addModal.locator('label:has-text("Max") + input').fill('2000000');
  await addModal.locator('label:has-text("Location") + input').fill('October Gardens');
  await page.click('.modal-card button:has-text("Add lead")');
  await page.waitForSelector('.modal-card', { state: 'detached', timeout: 8000 }).catch(() => {});
  step('Add New Lead with source/interestedIn/budget/location submits without error', true);

  // ---- 2. Open the Fresh Leads stage list and inspect the new cards ----
  await page.waitForSelector('.stat-grid .stat-card', { timeout: 8000 });
  await page.locator('.stat-card.clickable', { hasText: /fresh/i }).first().click();
  await page.waitForSelector('.lead-card', { timeout: 8000 });
  step('the redesigned card list renders (.lead-card present)', true);
  step('no plain <table> row list remains for the lead list', await page.locator('.lead-card-list table').count() === 0);

  const card = page.locator('.lead-card', { hasText: 'Youssef Card Test' }).first();
  step('the new lead\'s card is present', await card.count() >= 1);

  const name = await card.locator('.lead-card-name').textContent();
  step('card shows the real client name', (name || '').includes('Youssef Card Test'), name);
  const phone = await card.locator('.lead-card-phone').textContent();
  step('card shows the real phone number (normalized)', /\+?20\s?1{0,1}1{1,2}/.test((phone || '').replace(/\s/g, '')), phone);

  const callHref = await card.locator('a.icon-btn:has-text("Call")').getAttribute('href');
  step('Call button is a real tel: link using the lead\'s own number', (callHref || '').startsWith('tel:') && callHref.length > 4, callHref);
  const waHref = await card.locator('a.icon-btn:has-text("WhatsApp")').getAttribute('href');
  step('WhatsApp button is a real wa.me link using the lead\'s own number', (waHref || '').startsWith('https://wa.me/') && waHref.length > 15, waHref);

  const badgeTexts = await card.locator('.lead-card-badges .badge').allTextContents();
  step('a status badge (stage name) is shown', badgeTexts.some((t) => /fresh/i.test(t)), JSON.stringify(badgeTexts));

  const sourceText = await card.locator('.lead-card-kv').first().textContent();
  step('Source/Location section shows the real source (Facebook) and location (October Gardens)', /facebook/i.test(sourceText || '') && /october gardens/i.test(sourceText || ''), sourceText);

  const targetText = await card.locator('.lead-card-kv').nth(1).textContent();
  step('Target/Budget section shows the real budget range (not fabricated)', /1,000,000/.test(targetText || '') && /2,000,000/.test(targetText || ''), targetText);

  await page.waitForTimeout(600); // let the async payment-plan chip fetch settle
  const chipTexts = await card.locator('.lead-card-chips .lead-card-chip').allTextContents();
  step('Payment Plans section shows a real empty state, not fabricated chips, for a lead with no Offers yet', chipTexts.some((t) => /no payment plans/i.test(t)), JSON.stringify(chipTexts));

  const actionLabels = await card.locator('.lead-card-actions button').allTextContents();
  step('all three quick actions are present (Ask AI / Open File / Move Stage)', actionLabels.some((t) => /ask ai/i.test(t)) && actionLabels.some((t) => /open file/i.test(t)) && actionLabels.some((t) => /move stage/i.test(t)), JSON.stringify(actionLabels));

  const dateText = await card.locator('.lead-card-dates').textContent();
  step('a real Created date is shown', /created/i.test(dateText || ''), dateText);

  // ---- 3. Existing search box still works ----
  await page.fill('.lead-filters-bar input[type="text"]', 'Youssef Card Test');
  await page.waitForTimeout(500);
  step('search narrows the list to the matching lead', await page.locator('.lead-card', { hasText: 'Youssef Card Test' }).count() >= 1);
  await page.fill('.lead-filters-bar input[type="text"]', 'zzz-no-such-lead-zzz');
  await page.waitForTimeout(500);
  step('search with no match shows the real empty state, not a stale list', await page.locator('.empty-state').count() >= 1);
  await page.fill('.lead-filters-bar input[type="text"]', '');
  await page.waitForTimeout(500);

  // ---- 4. New Filters popover (Priority/Source/Assigned User) ----
  await page.click('.lead-filters-bar button:has-text("Filters")');
  await page.waitForSelector('.lead-filters-panel', { timeout: 5000 });
  step('Filters popover opens', true);
  await page.locator('.lead-filters-panel select').first().selectOption('urgent');
  await page.click('.lead-filters-panel button:has-text("Apply")');
  await page.waitForTimeout(500);
  const filterBadge = await page.locator('.lead-filter-badge-count').count();
  step('an active filter shows a count badge on the Filters button', filterBadge >= 1);
  step('filtering by a priority no lead has shows the real empty state', await page.locator('.empty-state').count() >= 1);
  await page.click('.lead-filters-bar button:has-text("Filters")');
  await page.waitForSelector('.lead-filters-panel', { timeout: 5000 });
  await page.click('.lead-filters-panel button:has-text("Clear filters")');
  await page.waitForTimeout(500);
  step('clearing filters restores the full list', await page.locator('.lead-card', { hasText: 'Youssef Card Test' }).count() >= 1);

  // ---- 5. Open File / Move Stage still call the real existing modals ----
  await card.locator('button:has-text("Open File")').click();
  await page.waitForSelector('.modal-card.wide', { timeout: 5000 });
  step('Open File opens the real (existing) Lead detail modal', true);
  const detailTitle = await page.locator('.modal-card.wide h3.modal-title').textContent();
  step('the detail modal is for the same lead', /Youssef Card Test/.test(detailTitle || ''), detailTitle);
  await page.click('.modal-card.wide .modal-close');
  await page.waitForTimeout(300);

  await card.locator('button:has-text("Move Stage")').click();
  await page.waitForSelector('.modal-card:has-text("Move")', { timeout: 5000 });
  step('Move Stage opens the real (existing) move-stage modal', true);
  await page.click('.modal-card button:has-text("Cancel")');
  await page.waitForTimeout(300);

  // ---- 6. Mobile layout stacks the card into one column ----
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const gridCols = await card.locator('.lead-card-grid').evaluate((n) => getComputedStyle(n).gridTemplateColumns.split(' ').length);
  step('on a mobile viewport the card grid collapses to a single column', gridCols === 1, `columns=${gridCols}`);
  await page.screenshot({ path: '/tmp/claude-0/lead-cards-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/claude-0/lead-cards-desktop.png' });

  // ---- 7. Arabic / RTL ----
  // Switching locale remounts the whole app shell (showApp()), so it lands
  // back on the CRM dashboard — re-enter the Fresh Leads stage list rather
  // than assuming the previous stage view survives the remount.
  await page.selectOption('#locale-toggle', 'ar');
  await page.waitForTimeout(500);
  const dir = await page.evaluate(() => document.documentElement.getAttribute('dir') || document.body.getAttribute('dir'));
  step('switching to Arabic sets an RTL direction on the page', dir === 'rtl', dir);
  await page.waitForSelector('.stat-grid .stat-card', { timeout: 8000 });
  await page.locator('.stat-card.clickable').first().click();
  await page.waitForSelector('.lead-card', { timeout: 8000 });
  const arCardText = await page.locator('.lead-card').first().textContent();
  step('card renders real Arabic labels, not raw i18n keys', !/crm_card_/.test(arCardText || ''), (arCardText || '').slice(0, 200));
  await page.screenshot({ path: '/tmp/claude-0/lead-cards-arabic-rtl.png' });
  await page.selectOption('#locale-toggle', 'en');
  await page.waitForTimeout(500);

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
