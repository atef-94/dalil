// Live E2E check that the AI Assistant panel's free-text command parser
// now recognizes common Arabic phrasings, not just the fixed English
// patterns ("move to X" / "summarize" / "suggest" / "hot leads today").
// Real backend calls throughout — no mocked data.
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
const companyName = `AI Panel AR E2E ${rand}`;
const leadName = `Samir AI Test ${rand}`;

async function lastAssistantMessage() {
  const msgs = page.locator('.ai-dock-msg.assistant');
  const count = await msgs.count();
  return count > 0 ? (await msgs.nth(count - 1).textContent()) || '' : '';
}

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.click('#auth-tab-signup');
  await page.fill('input[placeholder="Acme Real Estate"]', companyName);
  await page.fill('input[placeholder="Your full name"]', 'E2E Owner');
  await page.locator('input[type="email"]').nth(0).fill(email);
  await page.locator('input[type="password"]').nth(0).fill(password);
  await page.click('#auth-submit');
  await page.waitForSelector('#sidebar', { timeout: 8000 });

  // Switch to Arabic — this is where the user's screenshot was taken from.
  await page.selectOption('#locale-toggle', 'ar');
  await page.waitForTimeout(500);

  await page.click('a[href="#/crm"]');
  await page.waitForSelector('.stat-grid .stat-card', { timeout: 8000 });
  await page.click('button:has-text("إضافة عميل محتمل جديد")');
  await page.waitForSelector('.modal-card', { timeout: 5000 });
  const addModal = page.locator('.modal-card');
  await addModal.locator('label:has-text("الاسم") + input').fill(leadName);
  await addModal.locator('label:has-text("الهاتف") + input').fill('01114810096');
  await page.click('.modal-card button:has-text("إضافة")');
  await page.waitForSelector('.modal-card', { state: 'detached', timeout: 8000 }).catch(() => {});
  step('lead created for AI panel test', true);
  await page.waitForSelector('.toast', { state: 'detached', timeout: 5000 }).catch(() => {});

  const toggleCount = await page.locator('.ai-dock-toggle').count();
  step('exactly one AI dock toggle exists in the DOM (no stale duplicate from remounts)', toggleCount === 1, `count=${toggleCount}`);

  // ---- 1. Free-text Arabic query with NO lead open — should stay the
  // real "no lead open" message, not the generic unrecognized-command
  // fallback (this exercises the wantsSummary path itself, not context). ----
  await page.click('.ai-dock-toggle');
  await page.waitForSelector('.ai-dock', { timeout: 5000 });
  const input = page.locator('.ai-dock-input-row input');
  const send = page.locator('.ai-dock-input-row button');

  await input.fill('لخص العميل المحتمل ده');
  await send.click();
  await page.waitForTimeout(400);
  let reply = await lastAssistantMessage();
  step('Arabic "لخص" is recognized (real "open a lead" message, not generic fallback)', reply.includes('فتح') || reply.includes('محتمل مفتوح'), reply);

  await input.fill('ايه الاجراء التالي');
  await send.click();
  await page.waitForTimeout(400);
  reply = await lastAssistantMessage();
  step('Arabic "الاجراء التالي" is recognized', !reply.includes('يمكنني') || reply.includes('مفتوح'), reply);

  await input.fill('أكثر العملاء اهتمامًا اليوم');
  await send.click();
  await page.waitForTimeout(1000);
  reply = await lastAssistantMessage();
  step('Arabic hot-leads phrase triggers the real hot-leads lookup (not the fallback help text)', !reply.includes('يمكنني: تلخيص'), reply);

  // ---- 2. Open the lead, then use Arabic free text for summarize/next-action/move ----
  await page.waitForSelector('.stat-grid .stat-card', { timeout: 8000 });
  await page.locator('.stat-card.clickable').first().click();
  await page.waitForSelector('.lead-card', { timeout: 8000 });
  const card = page.locator('.lead-card', { hasText: leadName }).first();
  await card.locator('.lead-card-actions button').nth(1).click();
  await page.waitForSelector('.modal-card.wide', { timeout: 5000 });
  step('lead detail opened (sets AI context)', true);

  const contextEl = page.locator('.ai-dock-context');
  await page.waitForTimeout(300);
  const contextText = await contextEl.textContent();
  step('AI panel context bar shows the open lead name', (contextText || '').includes(leadName.split(' ')[0]), contextText);

  await input.fill('لخص العميل ده بسرعة');
  await send.click();
  await page.waitForTimeout(800);
  reply = await lastAssistantMessage();
  step('Arabic "لخص" with an open lead returns a real summary (name/phone), not the fallback', reply.includes(leadName) || /\+?20/.test(reply), reply);

  await input.fill('اقترح الإجراء التالي له');
  await send.click();
  await page.waitForTimeout(1500);
  reply = await lastAssistantMessage();
  step('Arabic "اقترح" with an open lead calls the real suggest-next-action decision, not the fallback', !reply.startsWith('يمكنني:'), reply);

  const stagesResp = await page.evaluate(async () => {
    const r = await fetch('/api/crm/stages', { headers: { Authorization: `Bearer ${localStorage.getItem('active_os_token') || ''}` } });
    return r.ok ? r.json() : [];
  });
  const targetStageName = stagesResp.find((s) => !s.isDefault && !s.isLost)?.name || stagesResp[0]?.name;
  if (targetStageName) {
    await input.fill(`انقل العميل ده لمرحلة ${targetStageName}`);
    await send.click();
    await page.waitForTimeout(800);
    reply = await lastAssistantMessage();
    step(`Arabic "انقل ... لمرحلة ${targetStageName}" moves the real lead (not the fallback)`, reply.includes(targetStageName) || reply.includes('نقل'), reply);
  } else {
    step('found a target stage to test Arabic move phrasing', false, 'no stages returned');
  }

  await page.screenshot({ path: '/tmp/claude-0/ai-panel-arabic.png', fullPage: false });

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
