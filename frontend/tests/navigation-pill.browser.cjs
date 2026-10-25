// Render the real legacy navigation CSS, markup and positioning function without
// starting the business app or touching its API/database.
const assert = require('node:assert/strict');
const { readFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

async function main() {
  const source = await readFile(process.env.LEGACY_HTML || path.join(__dirname, '../public/legacy.html'), 'utf8');
  const styles = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]).join('\n');
  const nav = source.match(/<nav id="nav">[\s\S]*?<\/nav>/)[0];
  const movePill = source.match(/function movePill\(b\)\{[\s\S]*?(?=\r?\n\r?\n\/\*)/)[0];
  const output = path.resolve(__dirname, '../../.simulation-work');
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const failures = [];
  let checked = 0;
  try {
    await page.setContent(`<html class="app-ready" lang="th" data-layout="top" data-theme="dark"><head><style>${styles}</style></head><body><div class="navwrap">${nav}</div></body></html>`);
    await page.addScriptTag({ content: `function $(s){return document.querySelector(s);} ${movePill}` });
    const thai = await page.locator('#nav [data-tab] .navlbl').allTextContents();
    const english = ['Overview', 'Outbound gate', 'Gate In', 'Inventory', 'Track Box', 'Master data setup'];
    // The deployed compact header used 2px top padding while the lens stayed at
    // 9px. Test both spacings, plus font/zoom changes, to catch that drift.
    for (const theme of ['dark', 'light']) {
      for (const labels of [thai, english]) {
        for (const compact of [false, true]) {
          for (const zoom of [1, 1.25]) {
            await page.evaluate(({ theme, labels, compact, zoom }) => {
              document.documentElement.dataset.theme = theme;
              document.documentElement.style.zoom = zoom;
              const nav = document.querySelector('#nav');
              nav.style.paddingTop = compact ? '2px' : '9px';
              nav.style.paddingBottom = compact ? '6px' : '9px';
              [...nav.querySelectorAll('[data-tab]')].forEach((button, index) => {
                button.querySelector('.navlbl').textContent = labels[index];
                button.style.fontSize = zoom > 1 ? '18px' : '14px';
              });
            }, { theme, labels, compact, zoom });
            const measurements = await page.evaluate(() => {
              const buttons = [...document.querySelectorAll('#nav [data-tab]')];
              return buttons.map(button => {
                buttons.forEach(other => other.classList.toggle('active', other === button));
                movePill(button);
                const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
                return { tab: button.dataset.tab, button: rect(button), label: rect(button.querySelector('.navlbl')), pill: rect(document.querySelector('#pillBg')) };
              });
            });
            for (const result of measurements) {
              checked++;
              const { button, label, pill } = result;
              const context = `${theme}/${labels === thai ? 'th' : 'en'}/${compact ? 'compact' : 'normal'}/zoom${zoom}/${result.tab}`;
              const delta = Math.abs(pill.y + pill.height / 2 - label.y - label.height / 2);
              if (delta > 1) failures.push(`${context}: label is ${delta.toFixed(2)}px off the pill's vertical centre`);
              if (Math.abs(button.x - pill.x) > 1 || Math.abs(button.width - pill.width) > 1) failures.push(`${context}: horizontal pill bounds do not match its button`);
            }
            if (theme === 'dark' && labels === thai && compact && zoom === 1) {
              await page.locator('.navwrap').screenshot({ path: path.join(output, 'navigation-pill.png') });
            }
          }
        }
      }
    }
    // The horizontal lens must remain hidden in existing sidebar/mobile modes.
    await page.evaluate(() => { document.documentElement.dataset.layout = 'sidebar'; document.documentElement.style.zoom = ''; });
    assert.equal(await page.locator('#pillBg').isVisible(), false, 'Sidebar retains button-based active styling');
    await page.setViewportSize({ width: 440, height: 800 });
    await page.evaluate(() => { document.documentElement.dataset.layout = 'top'; document.querySelector('.navwrap').classList.add('mobile-open'); });
    assert.equal(await page.locator('#pillBg').isVisible(), false, 'Mobile drawer does not show a horizontal lens');
    assert.equal(await page.locator('#nav [data-tab="setup"]').isVisible(), true, 'Mobile active tab remains visible');
    assert.deepEqual(failures, [], 'Selected labels must stay centred inside the pill');
    console.log(JSON.stringify({ result: 'PASS', checked, layouts: ['top', 'sidebar', 'mobile'], screenshot: path.join(output, 'navigation-pill.png') }));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
