// Live E2E check of the new "Offers" feature inside a Lead's detail panel:
// look up a unit by code (auto-fill), create an Offer against a real
// payment plan template, see it in the lead's Offers list, and download the
// real generated PDF.
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
const email = `offers-e2e-${rand}@e2e.example`;
const password = 'e2e-password-123';
const companyName = `Offers E2E ${rand}`;

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.click('#auth-tab-signup');
  await page.fill('input[placeholder="Acme Real Estate"]', companyName);
  await page.fill('input[placeholder="Your full name"]', 'Offers E2E Owner');
  await page.locator('input[type="email"]').nth(0).fill(email);
  await page.locator('input[type="password"]').nth(0).fill(password);
  await page.click('#auth-submit');
  await page.waitForSelector('#sidebar', { timeout: 8000 });
  step('signup lands in the app shell', true);

  const token = await page.evaluate(() => localStorage.getItem('active_os_token'));
  step('auth token present in localStorage', !!token);
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Fast test-data setup via direct API calls (project/unit/template/lead) —
  // the UI paths for these are already covered by other e2e scripts.
  const project = await (await page.request.post(`${BASE_URL}/api/inventory/projects`, { headers: authHeaders, data: { name: `OffersE2EProj-${rand}` } })).json();
  const unitCode = `OE-${rand}`;
  const unit = await (await page.request.post(`${BASE_URL}/api/inventory/units`, {
    headers: authHeaders,
    data: { projectId: project.id, code: unitCode, listPrice: 2_500_000, unitType: 'apartment', areaSqm: 130, floorLabel: '5', buildingLabel: 'B2' },
  })).json();
  await page.request.post(`${BASE_URL}/api/payment-plan-templates`, {
    headers: authHeaders,
    data: { name: `OffersE2EPlan-${rand}`, downPaymentType: 'percentage', downPaymentValue: 15, frequency: 'quarterly', termMonths: 36, fees: [] },
  });
  const leadRes = await page.request.post(`${BASE_URL}/api/crm/leads`, { headers: authHeaders, data: { fullName: `Offer Lead ${rand}`, phone: `010${rand}` } });
  const lead = await leadRes.json();
  step('test fixtures created (project/unit/template/lead)', !!unit.id && !!lead.id, JSON.stringify({ unitId: unit.id, leadId: lead.id }));

  await page.click('a[href="#/crm"]');
  await page.waitForSelector('.stat-grid .stat-card', { timeout: 8000 });
  step('CRM dashboard loads', true);

  // Open the Fresh Leads stage list and click into our lead.
  const freshCard = page.locator('.stat-card.clickable', { hasText: /fresh/i }).first();
  await freshCard.click();
  await page.waitForSelector('button:has-text("Back to Pipeline")', { timeout: 8000 });
  await page.fill('input[placeholder*="Search" i]', lead.fullName).catch(() => {});
  await page.waitForTimeout(500);
  const leadRow = page.locator('tr', { hasText: lead.fullName }).first();
  await leadRow.locator('button', { hasText: /detail/i }).first().click().catch(async () => {
    await leadRow.locator('button').first().click();
  });
  await page.waitForSelector('.modal-card:has-text("Offers")', { timeout: 8000 });
  step('Lead detail modal opens with an Offers card', true);

  const modal = page.locator('.modal-card');
  await modal.locator('input[placeholder*="Unit code" i]').fill(unitCode);
  await modal.locator('button', { hasText: 'Look up' }).click();
  await page.waitForTimeout(600);
  const unitInfoText = await modal.locator('.card:has-text("Offers")').textContent();
  step('unit lookup auto-fills project/unit info', unitInfoText.includes(project.name) && unitInfoText.includes('130'), unitInfoText.slice(0, 300));

  const createBtn = modal.locator('button', { hasText: 'Create Offer' });
  step('Create Offer button becomes enabled after lookup', await createBtn.isEnabled());
  await createBtn.click();
  await page.waitForTimeout(800);
  const offersTableText = await modal.locator('.card:has-text("Offers")').textContent();
  step('the new Offer appears in the lead\'s Offers list', /Q-\d{8}-\d{4}/.test(offersTableText), offersTableText.slice(0, 400));

  // Print downloads a real PDF.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }),
    modal.locator('button', { hasText: 'Print' }).first().click(),
  ]);
  const downloadPath = await download.path();
  step('Print button downloads a file', !!downloadPath, download.suggestedFilename());
  step('downloaded file is named like a PDF', /\.pdf$/i.test(download.suggestedFilename()), download.suggestedFilename());

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
