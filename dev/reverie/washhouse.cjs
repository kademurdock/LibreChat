const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.REVERIE_RECEIPTS || path.join(__dirname, 'receipts');
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const checks = [], errors = [];
    const check = (value, label) => { assert(value, label); checks.push(label); };
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', r => { if (r.status() >= 400) errors.push(r.status() + ' ' + r.url()); });
    await page.addInitScript(() => window.addEventListener('reverie-stage-ready', () => {
      const Stage = window.ReverieStage.Stage;
      window.ReverieStage.Stage = class extends Stage { constructor(...args) { super(...args); window.testStage = this; } };
    }));
    await page.goto(`http://127.0.0.1:${process.env.REVERIE_PORT || 8169}/world`);
    await page.waitForSelector('.has-stage');
    const settled = () => page.waitForFunction(() => document.getElementById('cmdForm').getAttribute('aria-busy') !== 'true');
    const send = async command => { await page.locator('#cmdInput').fill(command); await page.locator('#cmdInput').press('Enter'); await settled(); };
    const click = async name => { await page.getByRole('button', { name, exact: true }).click(); await settled(); };
    await send('go to Gully Washhouse');
    check(await page.getByRole('button', { name: 'Sort buttons', exact: true }).count() === 1, 'button tin action is discoverable');
    await click('Window bench');
    await click('Tighten the loose leg');
    await click('Sand the rough edge');
    await click('Fit the felt pads');
    check((await page.locator('#log').innerText()).includes('stands steady'), 'three shared repairs produce a readable completion');
    check(await page.evaluate(() => window.testStage.model.washhouse.benchStage) === 3, 'picture follows the committed repair');
    await click('Book exchange');
    await click('The Brass Key: read part 1 of 3');
    check(!(await page.locator('#log').innerText()).includes('She had been laying out breakfast'), 'ending is withheld until chosen');
    await page.reload(); await page.waitForSelector('.has-stage');
    await click('Book exchange');
    check(await page.getByRole('button', { name: 'The Brass Key: read part 2 of 3', exact: true }).count() === 1, 'bookmark survives an actual page reload');
    await click('The Brass Key: read part 2 of 3');
    await click('Read part 3 of 3');
    check((await page.locator('#log').innerText()).includes('The end.'), 'book can be finished entirely with buttons');
    check(await page.locator('[role=log]').count() === 1, 'one accessible live log');
    check(await page.locator('canvas').evaluate(el => !!el.closest('[aria-hidden=true]')), 'decorative picture is hidden from screen readers');
    await page.locator('details.settings summary').click();
    await click('Describe the picture');
    check((await page.locator('#log').innerText()).includes('pale green linoleum'), 'picture description matches the new floor');
    await page.locator('#reverieIllustration').screenshot({ path: path.join(out, 'washhouse.png') });
    for (const width of [320, 390, 667]) {
      await page.setViewportSize({ width, height: 844 });
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow at ' + width);
    }
    await page.screenshot({ path: path.join(out, 'washhouse-mobile.png'), fullPage: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => !window.testStage.running);
    check(await page.evaluate(() => !window.testStage.running), 'reduced motion stops the new room animation');
    check(errors.length === 0, 'no browser errors or failed resources');
    fs.writeFileSync(path.join(out, 'washhouse-browser.json'), JSON.stringify({ checks, errors, scope: 'Real local engine and disposable Mongo; desktop Edge with mobile viewport, not a physical device.' }, null, 2));
    console.log(checks.length + ' washhouse browser checks passed');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
