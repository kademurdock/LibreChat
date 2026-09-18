const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = 'http://127.0.0.1:' + (process.env.REVERIE_PORT || 8205);
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const checks = [];
  const check = (value, label) => {
    assert(value, label);
    checks.push(label);
    console.log('PASS', label);
  };
  try {
    const page = await browser.newPage();
    let weather = 'rain',
      outdoor = true;
    await page.route(/\/api\/world\/(here|command)$/, async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      if (data.room) {
        data.room.weather = weather;
        data.room.outdoor = outdoor;
      }
      if (data.hud) data.hud.weather = weather;
      await route.fulfill({ response, json: data });
    });
    await page.addInitScript(() => {
      const Original = window.Audio;
      window.audioForTest = [];
      window.Audio = function (...args) {
        const a = new Original(...args);
        window.audioForTest.push(a);
        return a;
      };
      window.hiddenForTest = false;
      Object.defineProperty(document, 'hidden', { get: () => window.hiddenForTest });
    });
    await page.goto(base + '/world');
    await page.locator('details.settings summary').click();
    const rain = () =>
      page.evaluate(() =>
        window.audioForTest
          .filter((a) => a.src.includes('amb.weather.rain') && !a.paused)
          .map((a) => ({ volume: a.volume, ready: a.readyState })),
      );
    await page.waitForFunction(() =>
      window.audioForTest.some(
        (a) =>
          a.src.includes('amb.weather.rain') && !a.paused && a.volume > 0.2 && a.readyState >= 2,
      ),
    );
    check((await rain()).length === 1, 'rain starts once after a real gesture');
    await page.locator('#ambToggle').click();
    await page.waitForFunction(() =>
      window.audioForTest.filter((a) => a.src.includes('amb.weather.rain')).every((a) => a.paused),
    );
    check(true, 'ambience mute stops rain');
    await page.locator('#ambToggle').click();
    await page.waitForFunction(() =>
      window.audioForTest.some(
        (a) => a.src.includes('amb.weather.rain') && !a.paused && a.volume > 0.2,
      ),
    );
    await page.evaluate(() => {
      window.hiddenForTest = true;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() =>
      window.audioForTest.filter((a) => a.src.includes('amb.weather.rain')).every((a) => a.paused),
    );
    check(true, 'hidden document stops rain');
    outdoor = false;
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#cmdInput').disabled);
    await page.locator('details.settings summary').click();
    await page.waitForFunction(() =>
      window.audioForTest.some(
        (a) =>
          a.src.includes('amb.weather.rain') && !a.paused && a.volume > 0.06 && a.volume < 0.08,
      ),
    );
    check((await rain()).length === 1, 'sheltered rain plays at the reduced volume');
    weather = 'clear';
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#cmdInput').disabled);
    await page.locator('details.settings summary').click();
    check((await rain()).length === 0, 'clear weather creates no rain loop');
    const out = process.env.REVERIE_RECEIPTS || path.join(__dirname, 'receipts');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      path.join(out, 'waterfront-audio.json'),
      JSON.stringify(
        {
          checks,
          scope:
            'Browser playback and mocked weather/visibility lifecycle, not human listening acceptance.',
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
