/* Part 293: the website's "Or paste a YouTube link" field for a YuE2 cover, driven in a real
 * browser (the same harness shape as soundBoothWorkspace.selftest.cjs). The server is a fixture;
 * the guide is the real GUIDE passed through guideFor, once for a family account and once for
 * the App Review seat.
 *
 * Run: PLAYWRIGHT_MODULE=<path to playwright> node api/server/routes/soundBoothLink.selftest.cjs
 */
const fs = require('fs'), vm = require('vm'), http = require('http'), assert = require('assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = require('path').resolve(__dirname, '../../..');
const { guideFor } = require('./kadeSoundBoothLink');

const shared = require(root + '/api/server/routes/kadePages.js').SHARED_HEAD;
const context = { module: { exports: {} }, require: () => ({ SHARED_HEAD: shared + '<script>async function getToken(){return "fixture"}</script>' }) };
vm.runInNewContext(fs.readFileSync(root + '/api/server/routes/kadeSoundBoothPage.js', 'utf8'), context);
const html = context.module.exports.soundBoothHtml;
const backend = fs.readFileSync(root + '/api/server/routes/kadeSoundBooth.js', 'utf8');
const a = backend.indexOf('const GUIDE = ') + 14, b = backend.indexOf('\n};', a) + 2;
const GUIDE = vm.runInNewContext('(' + backend.slice(a, b) + ')', {
  effectsGuide: { name: 'Stable Audio', tagline: 'Sounds.', where: '', cost: '', bestFor: [], notFor: [], howToWrite: [], settings: [] },
  SCREENPLAY_HELP: '', yueCost: 'No reliable per-song cost estimate yet.', yueStylesEnabled: () => false, yueStyles: {},
});

let guide, held = [], sent = [];
const server = http.createServer((req, res) => {
  if (req.url === '/sound-booth') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
  if (req.url.startsWith('/assets/')) { res.setHeader('Content-Type', 'application/javascript'); res.end(''); return; }
  res.setHeader('Content-Type', 'application/json');
  if (req.url.endsWith('/health')) { res.end(JSON.stringify({ guide, moods: [] })); return; }
  if (req.url.endsWith('/projects')) { res.end(JSON.stringify({ projects: [] })); return; }
  if (req.method === 'GET') { res.end('{}'); return; }
  let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
    sent.push({ url: req.url, body: JSON.parse(raw || '{}') });
    if (req.url.endsWith('/reference/link')) { held.push(res); return; }
    res.end('{}');
  });
});
const waitHeld = async () => { while (!held.length) await new Promise((r) => setTimeout(r, 10)); return held.shift(); };
const focusedId = (page) => page.evaluate(() => document.activeElement && document.activeElement.id);

async function openCover(page) {
  await page.goto('http://127.0.0.1:' + server.address().port + '/sound-booth');
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.locator('[data-engine="yue2"]').click();
  await page.locator('#settingsDrawer > summary').click();
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
  const errors = [];
  try {
    const page = await browser.newPage(); page.on('pageerror', (e) => errors.push(e.message));

    /* The App Review seat: no field, and no mention of links. */
    guide = guideFor(GUIDE, { id: 'review' }, () => true, {});
    await openCover(page);
    assert.equal(await page.locator('#set_reference_voice_url').count(), 1, 'the file import is still there');
    assert.equal(await page.locator('#set_reference_voice_url_link').count(), 0);
    assert.doesNotMatch(await page.locator('#settings').innerText(), /YouTube/);

    /* A family account. */
    guide = guideFor(GUIDE, { id: 'family' }, () => false, {});
    await openCover(page);
    const field = page.getByLabel('Or paste a YouTube link', { exact: true });
    assert.equal(await field.count(), 1, 'a real label names the field');
    assert.match(await field.getAttribute('aria-describedby'), /set_reference_voice_url_link_h/);
    assert.match(await page.locator('#set_reference_voice_url_h').innerText(), /paste a YouTube link/);
    const button = page.getByRole('button', { name: 'Import from YouTube', exact: true });

    await button.click();
    await page.locator('#status').filter({ hasText: 'Paste a YouTube link first.' }).waitFor();
    assert.equal(await focusedId(page), 'set_reference_voice_url_link');
    assert.equal(sent.length, 0);

    await field.fill('https://youtu.be/dQw4w9WgXcQ?list=RD1');
    await field.press('Enter');
    let res = await waitHeld();
    assert.deepEqual(sent.at(-1), { url: '/api/kade/sound-booth/reference/link', body: { engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ?list=RD1' } });
    await page.locator('#status').filter({ hasText: 'Bringing in the sound from YouTube' }).waitFor();
    assert.equal(await page.locator('#btnLinkImport').getAttribute('aria-disabled'), 'true');
    assert.equal(await page.locator('#btnLinkImport').innerText(), 'Importing from YouTube…');
    assert.equal(await focusedId(page), 'btnLinkImport', 'focus stays on the button while it works');
    assert.equal(await page.locator('#btnRender').isDisabled(), true, 'no generation while the song comes in');
    await page.locator('#btnLinkImport').click({ force: true }); // aria-disabled stays pressable, as it is for a screen reader
    await page.locator('#status').filter({ hasText: 'Still bringing in the song' }).waitFor();
    assert.equal(sent.length, 1, 'a second press does not start a second import');

    res.statusCode = 503;
    res.end(JSON.stringify({ error: 'YouTube is blocking the server right now. Try again in a few minutes, or download the song and import the file.', kind: 'bot' }));
    await page.locator('#status.err').filter({ hasText: 'YouTube is blocking the server right now' }).waitFor();
    assert.equal(await focusedId(page), 'set_reference_voice_url_link', 'focus returns to the link after a failure');
    assert.equal(await field.inputValue(), 'https://youtu.be/dQw4w9WgXcQ?list=RD1', 'the link is kept to retry');
    assert.match(await page.locator('#settings [role=alert]').innerText(), /YouTube is blocking the server/);
    assert.equal(await page.locator('#btnRender').isDisabled(), true, 'a failed import blocks generation until retried or discarded');

    await page.locator('#discardImport').click();
    await button.click();
    res = await waitHeld();
    res.end(JSON.stringify({
      ok: true, url: 'https://assets.test/audios/soundbooth-ref-x.mp3', bytes: 4600000, seconds: 192.4, name: 'Sunny Day', ext: 'mp3',
      spoken: 'Covering Sunny Day, 3 minutes 12 seconds, from YouTube. The full original is kept. Choose Transcribe reference lyrics for an editable draft of the words.',
      source: { site: 'youtube', title: 'Sunny Day', seconds: 192, link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    }));
    await page.locator('#status').filter({ hasText: 'Covering Sunny Day, 3 minutes 12 seconds' }).waitFor();
    assert.match(await page.locator('.clips li').innerText(), /^Covering: Sunny Day \(3:12\)/);
    assert.equal(await page.locator('.clips audio source').getAttribute('src'), 'https://assets.test/audios/soundbooth-ref-x.mp3');
    assert.equal(await page.locator('#set_reference_voice_url_link').count(), 0, 'one cover at a time');
    assert.equal(await focusedId(page), 'btnLyrics', 'Transcribe reference lyrics is offered next');
    assert.equal(await page.locator('#settings [role=alert]').count(), 0);

    await page.getByRole('button', { name: 'Remove Sunny Day', exact: true }).click();
    assert.equal(await page.locator('#set_reference_voice_url_link').count(), 1, 'the link field returns after removing the cover');
    assert.equal(await field.inputValue(), '', 'a used link is cleared');
    assert.deepEqual(errors, []);
    console.log('YouTube link field: labelled, hidden from App Review, announces progress and failures, keeps focus sensible, fills the cover like a file import and offers Transcribe reference lyrics.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
