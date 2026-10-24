// Read-only application smoke after framework/dependency upgrades.
// Optional normal login uses an existing account; never creates or resets one.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const origin = process.env.BOXTRACE_TEST_ORIGIN || 'http://localhost:3000';

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);
  const errors = [], checks = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(origin);
    await page.waitForURL('**/login');
    await page.locator('input[autocomplete="username"]').waitFor();
    assert.equal(await page.locator('iframe').count(), 0);
    checks.push('anonymous-root-redirect');

    await page.goto(`${origin}/login?u=upgrade-readonly-check`);
    // WEB offers a compact remembered-account card; the older deployment
    // retains a prefilled input. Both must show the requested identity.
    await page.waitForFunction(() => document.querySelector('input[autocomplete="username"]')?.value === 'upgrade-readonly-check'
      || document.body.textContent.includes('upgrade-readonly-check'));
    checks.push('client-query-prefill');
    await page.goto(`${origin}/login`);
    await page.locator('input[autocomplete="username"]').waitFor();

    const submit = page.locator('button[type="submit"]');
    assert.equal(await submit.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(29, 29, 31)');
    assert.equal(await submit.evaluate(el => getComputedStyle(el).borderRadius), '20px');
    assert.equal(await page.locator('main').evaluate(el => getComputedStyle(el).display), 'flex');
    checks.push('tailwind-postcss-styles');

    const languages = page.locator('[aria-label="เปลี่ยนภาษา"], [aria-label="Switch language"]');
    if (await languages.count()) {
      await languages.getByRole('button', { name: 'English', exact: true }).click();
      await page.waitForFunction(() => document.documentElement.lang === 'en');
      await page.getByRole('button', { name: /forgot password/i }).click();
      await page.getByRole('button', { name: /back.*sign|back.*log/i }).click();
      checks.push('english-language-and-forgot-navigation');
      await page.goto(`${origin}/onboarding`);
      await page.waitForURL('**/login');
      checks.push('onboarding-auth-guard');
    } else {
      await page.getByRole('button', { name: 'ลืมรหัสผ่าน?' }).click();
      await page.getByRole('button', { name: 'ขอรหัส OTP', exact: true }).waitFor();
      await page.getByRole('button', { name: 'กลับไปเข้าสู่ระบบ' }).click();
      checks.push('forgot-navigation-without-sending');
    }

    const denied = await page.request.get(`${origin}/api/auth/me`);
    assert.equal(denied.status(), 401, 'Protected API must not admit anonymous access');
    checks.push('api-proxy-auth-denial');
    for (const asset of ['/warehouse-simulation.html', '/warehouse-simulation-session.mjs', '/warehouse-simulation-engine.mjs']) {
      assert.equal((await page.request.get(origin + asset)).status(), 200, asset);
    }
    checks.push('simulation-static-assets');

    if (process.env.BOXTRACE_TEST_USERNAME && process.env.BOXTRACE_TEST_PASSWORD) {
      await page.locator('input[autocomplete="username"]').fill(process.env.BOXTRACE_TEST_USERNAME);
      await page.locator('input[autocomplete="current-password"]').fill(process.env.BOXTRACE_TEST_PASSWORD);
      await submit.click();
      await page.waitForURL(origin + '/');
      await page.locator('iframe[src="/legacy.html"]').waitFor({ timeout: 60000 });
      checks.push('react-login-form-and-app-shell');
    }
    assert.deepEqual(errors, [], 'No JavaScript/hydration errors');
    checks.push('no-runtime-errors');
    console.log(JSON.stringify({ result: 'PASS', origin, checks }));
  } catch (error) {
    console.error(JSON.stringify({ origin, completedChecks: checks, url: page.url(), errors }));
    throw error;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
