const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const out = process.env.REVERIE_RECEIPTS;
const base = 'http://127.0.0.1:' + (process.env.REVERIE_PORT || 8173);
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'msedge', args: ['--enable-unsafe-swiftshader'] });
  const checks = [];
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const AudioOriginal = window.Audio;
      window.loopPlayers = [];
      window.Audio = function (...args) { const a = new AudioOriginal(...args); window.loopPlayers.push(a); return a; };
    });
    await page.route('**/api/world/sounds', route => route.fulfill({ json: { event: {}, room: {}, district: { tanglefoot: base + '/test-ward.m4a' } } }));
    await page.route('**/test-ward.m4a', route => route.fulfill({ path: path.join(out, 'district-tanglefoot.m4a'), contentType: 'audio/mp4' }));
    await page.goto(base + '/world');
    await page.waitForSelector('.has-stage');
    const send = async command => {
      await page.locator('#cmdInput').fill(command);
      await page.locator('#cmdInput').press('Enter');
      await page.waitForFunction(() => document.getElementById('cmdForm').getAttribute('aria-busy') !== 'true');
    };
    await send('go to Hock');
    await page.waitForFunction(() => window.loopPlayers.some(a => a.loop && !a.paused && a.currentTime > .2));
    checks.push('Actual production Tanglefoot AAC decodes and plays in pawn shop');
    await page.waitForFunction(() => window.loopPlayers.find(a => a.loop && !a.paused)?.volume > .20);
    checks.push('Indoor room with no separate tone keeps audible 60 percent of chosen ward volume');
    assert((await page.locator('#s-name').textContent()).includes('Hock'));
    checks.push('Real engine reaches pawn shop through city routes');
    const before = await page.evaluate(() => window.loopPlayers.filter(a => a.loop).length);
    await send('look');
    assert.equal(await page.evaluate(() => window.loopPlayers.filter(a => a.loop).length), before);
    checks.push('Same room look preserves playing loop instead of restarting it');
    await page.evaluate(() => window.loopPlayers.filter(a => a.loop).forEach(a => a.pause()));
    await send('look');
    await page.waitForFunction(() => window.loopPlayers.some(a => a.loop && !a.paused));
    checks.push('Next gesture recovers a paused loop even when room key is unchanged');
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.loopPlayers.filter(a => a.loop).forEach(a => a.pause()));
      await page.locator('#s-name').click();
      await page.waitForFunction(() => window.loopPlayers.some(a => a.loop && !a.paused));
    }
    checks.push('Repeated taps recover playback without issuing a world command');
    await page.locator('details.settings summary').click();
    await page.locator('#ambToggle').click();
    await page.waitForFunction(() => window.loopPlayers.filter(a => a.loop).every(a => a.paused));
    checks.push('Ambience off stops all room loops');
    await send('look');
    assert(await page.evaluate(() => window.loopPlayers.filter(a => a.loop).every(a => a.paused)));
    checks.push('Gestures respect saved ambience off');
    await page.locator('#ambToggle').click();
    await page.waitForFunction(() => window.loopPlayers.some(a => a.loop && !a.paused));
    checks.push('Ambience on restores room playback');
    const measured = await page.evaluate(async () => {
      const ctx = new AudioContext();
      const buffer = await ctx.decodeAudioData(await (await fetch('/test-ward.m4a')).arrayBuffer());
      const samples = buffer.getChannelData(0);
      let energy = 0, peak = 0;
      for (const s of samples) { energy += s * s; peak = Math.max(peak, Math.abs(s)); }
      await ctx.close();
      return { seconds: buffer.duration, channels: buffer.numberOfChannels, rms: Math.sqrt(energy / samples.length), peak };
    });
    assert(measured.seconds > 5 && measured.rms > .001 && measured.peak <= 1);
    checks.push('Downloaded district file contains measurable non-clipping audio');
    fs.writeFileSync(path.join(out, 'world-audio-browser.json'), JSON.stringify({ checks, measured, caveat: 'Browser playback and decoded signal only; not human listening, iPhone VoiceOver or native audio routing.' }, null, 2));
    console.log(JSON.stringify({ checks, measured }));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
