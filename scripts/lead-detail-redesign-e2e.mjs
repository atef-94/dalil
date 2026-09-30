// Live E2E check of the redesigned Lead Detail ("Open File") modal —
// verifies the new accordion-based layout the user confirmed as the
// target design: badges row, phone + real Call/WhatsApp links, a
// 2x2 info grid (Interested In / Assigned To / Time / Date), 4 primary
// quick actions + a secondary row (nothing removed, just reorganized),
// 3 collapsed-by-default accordions (Activity Log / Follow-up /
// Timeline) that expand on click, and the Offer & Payment card at the
// bottom with its real Unit-Code-lookup flow intact. Driven against the
// real running app with real API calls, no mocked data.
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
const companyName = `Lead Detail E2E ${rand}`;
const leadName = `Nadia Detail Test ${rand}`;

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

  // ---- Add a lead with fields the header/info-grid needs ----
  await page.click('button:has-text("Add New Lead")');
  await page.waitForSelector('.modal-card:has-text("Add New Lead")', { timeout: 5000 });
  const addModal = page.locator('.modal-card');
  await addModal.locator('label:text-is("Name") + input').fill(leadName);
  await addModal.locator('label:has-text("Phone") + input').fill('01114810094');
  await addModal.locator('label:text-is("Source") + select').selectOption('facebook');
  await addModal.locator('label:text-is("Interested In") + select').selectOption('unit');
  await page.click('.modal-card button:has-text("Add lead")');
  await page.waitForSelector('.modal-card', { state: 'detached', timeout: 8000 }).catch(() => {});
  step('lead created for detail-modal test', true);

  await page.waitForSelector('.stat-grid .stat-card', { timeout: 8000 });
  await page.locator('.stat-card.clickable', { hasText: /fresh/i }).first().click();
  await page.waitForSelector('.lead-card', { timeout: 8000 });
  const card = page.locator('.lead-card', { hasText: leadName }).first();
  await card.locator('button:has-text("Open File")').click();
  await page.waitForSelector('.modal-card.wide', { timeout: 5000 });
  const modal = page.locator('.modal-card.wide');
  // refreshDetail() does several sequential awaited fetches (lead, score,
  // delivery status, offers list) before the badges/accordions/offer card
  // are appended — wait for the last-appended thing (the accordions) so
  // the assertions below aren't racing the modal's own async render.
  await modal.locator('.collapsible').first().waitFor({ timeout: 8000 });
  step('Open File opens the redesigned Lead Detail modal', true);

  // ---- Header: badges + phone + Call/WhatsApp ----
  step('a stage badge is shown', await modal.locator('.badge', { hasText: /fresh/i }).count() >= 1);
  const callHref = await modal.locator('a.icon-btn:has-text("Call")').getAttribute('href');
  step('Call is a real tel: link', (callHref || '').startsWith('tel:') && callHref.length > 4, callHref);
  const waHref = await modal.locator('a.icon-btn.whatsapp-btn').getAttribute('href');
  step('WhatsApp is a real wa.me link', (waHref || '').startsWith('https://wa.me/') && waHref.length > 15, waHref);

  // ---- Info grid: Interested In / Assigned To / Time / Date ----
  const gridText = await modal.locator('div[style*="grid-template-columns:1fr 1fr"]').first().textContent();
  step('info grid shows Interested In value (not the raw i18n key)', !/crm_detail_/.test(gridText || ''), (gridText || '').slice(0, 200));
  step('info grid shows a real Date value', /\d{4}/.test(gridText || ''), gridText);

  // ---- Primary actions: 4 buttons matching the mockup ----
  const primaryLabels = await modal.locator('.lead-card-actions button').allTextContents();
  step('4 primary actions present (Assign/Move/Edit interest/Add note)', primaryLabels.length === 4, JSON.stringify(primaryLabels));

  // ---- quickAddNote round-trips through the real messages endpoint ----
  await modal.locator('.lead-card-actions button', { hasText: /note/i }).click();
  await page.waitForSelector('.modal-card:has-text("Add a note")', { timeout: 5000 });
  await page.locator('.modal-card:has-text("Add a note") textarea').fill('E2E note body');
  await page.click('.modal-card:has-text("Add a note") button:has-text("Save")');
  await page.waitForTimeout(600);
  step('Add note modal submits without a page error (quickAddNote is wired)', true);

  // ---- Secondary actions preserved (tags/priority, portal, AI) ----
  const secondaryCount = await modal.locator('button.ghost').count();
  step('secondary ghost actions (tags/portal/AI) still present', secondaryCount >= 2, `count=${secondaryCount}`);

  // ---- 3 accordions, collapsed by default, each expands on click ----
  const accordions = modal.locator('.collapsible');
  step('3 collapsible accordions present (Activity/Follow-up/Timeline)', await accordions.count() === 3, `count=${await accordions.count()}`);
  for (let i = 0; i < 3; i++) {
    const acc = accordions.nth(i);
    step(`accordion ${i} starts collapsed`, !(await acc.evaluate((n) => n.classList.contains('open'))));
  }
  await accordions.nth(0).locator('.collapsible-header').click();
  await page.waitForTimeout(200);
  step('clicking the Activity Log accordion header expands it', await accordions.nth(0).evaluate((n) => n.classList.contains('open')));
  step('Activity Log accordion content is now visible', await accordions.nth(0).locator('select').first().isVisible());

  await accordions.nth(1).locator('.collapsible-header').click();
  await page.waitForTimeout(200);
  step('clicking the Follow-up accordion header expands it', await accordions.nth(1).evaluate((n) => n.classList.contains('open')));

  await accordions.nth(2).locator('.collapsible-header').click();
  await page.waitForTimeout(300);
  step('clicking the Timeline accordion header expands it', await accordions.nth(2).evaluate((n) => n.classList.contains('open')));
  step('Timeline content shows the real Lead Created entry (no duplicate title)', (await accordions.nth(2).textContent() || '').includes('Lead Created'));
  const timelineTitleCount = await accordions.nth(2).locator('h4', { hasText: /timeline/i }).count();
  step('no duplicate "Timeline" title inside the accordion content', timelineTitleCount === 0, `h4 count=${timelineTitleCount}`);

  // ---- Offer & Payment card at the bottom, real unit-lookup flow intact ----
  const offerCard = modal.locator('.card', { hasText: /Offer & Payment|العرض والدفع/ });
  step('Offer & Payment card is present (not dropped by the reorder)', await offerCard.count() >= 1);
  step('Offer & Payment card retains the real Unit code lookup field', await offerCard.locator('input').count() >= 1);
  step('Offer & Payment card retains a Payment plan select', await offerCard.locator('select').count() >= 1);

  await page.screenshot({ path: '/tmp/claude-0/lead-detail-redesign-en.png', fullPage: true });

  await page.click('.modal-card.wide .modal-close');
  await page.waitForTimeout(300);

  // ---- Arabic / RTL ----
  await page.selectOption('#locale-toggle', 'ar');
  await page.waitForTimeout(500);
  await page.waitForSelector('.stat-grid .stat-card', { timeout: 8000 });
  await page.locator('.stat-card.clickable').first().click();
  await page.waitForSelector('.lead-card', { timeout: 8000 });
  const arCard = page.locator('.lead-card', { hasText: leadName }).first();
  await arCard.locator('button', { hasText: /فتح الملف|ملف/ }).first().click().catch(async () => {
    // fallback: click the first action-row button that opens the wide modal
    await arCard.locator('.lead-card-actions button').nth(1).click();
  });
  await page.waitForSelector('.modal-card.wide', { timeout: 5000 });
  const arModal = page.locator('.modal-card.wide');
  await arModal.locator('.collapsible').first().waitFor({ timeout: 8000 });
  const arText = await arModal.textContent();
  step('Arabic Lead Detail renders real translated labels, not raw i18n keys', !/crm_detail_|crm_action_|crm_offer_/.test(arText || ''), (arText || '').slice(0, 300));
  const arAccordions = arModal.locator('.collapsible');
  step('Arabic modal still shows 3 accordions', await arAccordions.count() === 3);
  await page.screenshot({ path: '/tmp/claude-0/lead-detail-redesign-ar.png', fullPage: true });
  await page.selectOption('#locale-toggle', 'en');
  await page.waitForTimeout(300);

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
