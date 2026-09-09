const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
(async () => {
  const out = path.resolve(process.env.CHARACTER_RECEIPTS || '../outputs'); fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1040, height: 850 } });
    const errors = [], starts = [], artwork = [];
    page.on('request', request => { if (request.url().includes('/assets/characters/')) artwork.push(request.url()); });
    page.on('pageerror', e => errors.push(e.message));
    await page.route(/^https:\/\//, route => route.abort());
    await page.addInitScript(() => {
      window.audioStarts = [];
      const create = AudioContext.prototype.createBufferSource;
      AudioContext.prototype.createBufferSource = function () {
        const source = create.call(this), ctx = this, start = source.start;
        source.start = function (at, ...rest) {
          window.audioStarts.push({ at: at ?? ctx.currentTime, ctx, duration: source.buffer?.duration });
          return start.call(this, at, ...rest);
        };
        return source;
      };
    });
    await page.goto('http://127.0.0.1:' + (process.env.CHARACTER_PORT || 8166));
    const trigger = page.getByRole('button', { name: 'Start voice conversation with the active agent', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog'), motion = page.getByRole('checkbox', { name: 'Animate character during calls' });
    await dialog.waitFor(); await motion.waitFor();
    assert.ok(await dialog.evaluate(e => {
      const color = getComputedStyle(e).backgroundColor;
      return color !== 'rgba(0, 0, 0, 0)' && !color.includes(' / 0)');
    }), 'call overlay has an opaque dark background on a light page');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('Listening'));
    assert.equal(await motion.isChecked(), false);
    assert.equal(artwork.length, 0, 'initially off does not download animation assets');
    await motion.check(); await page.waitForFunction(() => !document.querySelector('canvas').hidden);
    const act = name => page.evaluate(n => fetch('/test/' + n, { method: 'POST' }), name);
    const resetStarts = () => page.evaluate(() => { window.audioStarts = []; });
    const waitAudio = (time, count = 3) => page.waitForFunction(({ time, count }) => window.audioStarts.length >= count &&
      window.audioStarts[0].ctx.currentTime >= window.audioStarts[0].at + time, { time, count });
    for (const mode of ['on', 'off', 'reduced', 'hidden']) {
      await act('clear'); await resetStarts();
      await motion.setChecked(mode !== 'off');
      await page.emulateMedia({ reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference' });
      await page.evaluate(hidden => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
        document.dispatchEvent(new Event('visibilitychange'));
      }, mode === 'hidden');
      await act('queue'); await waitAudio(.25);
      assert.equal(await dialog.locator('img').count(), 1, mode + ': keep current speaker before queued start');
      assert.equal(await dialog.locator('canvas').isVisible(), mode === 'on');
      if (mode === 'on') await page.screenshot({ path: path.join(out, 'dialog-speaking.png') });
      await waitAudio(1.05);
      assert.equal(await dialog.locator('img').count(), 0, mode + ': unknown voice uses fallback at start');
      assert.equal(await dialog.locator('canvas').isVisible(), false);
      await waitAudio(1.90);
      assert.equal(await dialog.locator('img').count(), 1, mode + ': original speaker returns at its start');
      await waitAudio(2.50);
      starts.push({ mode, starts: await page.evaluate(() => window.audioStarts.map(s => ({ start: s.at, duration: s.duration }))) });
    }
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.emulateMedia({ reducedMotion: 'no-preference' }); await motion.check();
    await act('clear'); await resetStarts(); await act('cues'); await waitAudio(.3);
    const warm = await page.locator('canvas').evaluate(e => e.style.transform);
    assert.match(warm, /rotate\(0\.[1-9]/, 'warm cue reaches the actual portrait at playback');
    await waitAudio(1.1);
    const skeptical = await page.locator('canvas').evaluate(e => e.style.transform);
    assert.notEqual(skeptical, warm, 'queued delivery cue changes at its clip');
    await waitAudio(1.9);
    assert.match(await page.locator('canvas').evaluate(e => e.style.transform), /rotate\(0deg\)/, 'untagged clip clears the previous cue');
    await act('clear'); await resetStarts(); await act('queue'); await waitAudio(.2);
    await act('clear'); await page.waitForTimeout(1800);
    assert.equal(await dialog.locator('img').count(), 1, 'interruption cancels queued identity');
    for (const command of ['missing', 'malformed']) {
      await act('clear'); await act(command); await page.waitForTimeout(250);
      assert.equal(await dialog.locator('canvas').isVisible(), false, command + ' metadata stays static');
    }
    await act('clear'); await act('sample'); await page.waitForTimeout(500);
    assert.equal(await dialog.locator('img').count(), 1); await act('clear');
    await act('spotter'); await page.waitForTimeout(250);
    assert.equal(await dialog.locator('img').count(), 0, 'Spotter never impersonates the portrait');
    assert.equal(await dialog.locator('canvas').isVisible(), false);
    await act('off'); await act('sample'); await page.waitForTimeout(500); await act('clear');
    await dialog.focus(); await page.keyboard.press('Tab'); assert.equal(await motion.evaluate(e => e === document.activeElement), true);
    await page.keyboard.press('Shift+Tab'); assert.equal(await page.getByRole('button', { name: 'End voice conversation' }).evaluate(e => e === document.activeElement), true);
    await page.keyboard.press('Tab'); assert.equal(await motion.evaluate(e => e === document.activeElement), true);
    for (const [width, height] of [[1040, 850], [360, 640], [667, 375]]) {
      await page.setViewportSize({ width, height });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await motion.scrollIntoViewIfNeeded();
      assert.ok(await motion.evaluate(e => e.getBoundingClientRect().top >= 0));
      const end = page.getByRole('button', { name: 'End voice conversation' });
      await end.scrollIntoViewIfNeeded();
      assert.ok(await end.evaluate(e => e.getBoundingClientRect().bottom <= innerHeight));
      await page.screenshot({ path: path.join(out, `dialog-${width}.png`) });
    }
    const tree = await dialog.ariaSnapshot();
    assert.ok(tree.includes('checkbox "Animate character during calls"')); assert.ok(!tree.includes('canvas'));
    fs.writeFileSync(path.join(out, 'dialog-accessibility.txt'), tree);
    await page.keyboard.press('Escape'); await trigger.waitFor();
    assert.equal(await page.locator('canvas').count(), 0);
    await trigger.click(); await motion.waitFor(); assert.equal(await motion.isChecked(), true);
    await page.waitForFunction(() => !document.querySelector('canvas').hidden);
    await act('disconnect'); await page.waitForTimeout(400);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'dialog-browser.json'), JSON.stringify({ errors, starts,
      checks: 'Actual ConversationMode + useStreamingCall + bridge WAV sender over local WebSocket; queue identity/on/off/reduced/hidden; interrupt; missing metadata; Spotter; real sample; focus trap; accessibility tree; layouts; teardown/reopen/disconnect' }, null, 2));
    console.log('Complete call-dialog browser checks passed');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
