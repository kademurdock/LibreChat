'use strict';
/* Oct 11 2026: Describe the sound of the recording, in a real browser (Edge through Playwright), on the real Sound Booth page.
 *
 * The page is built by kadeSoundBoothPage.js and served with the real guide; the server is a fixture that answers the lyric and
 * the describe routes with whatever the test sets. Nothing leaves this machine and no model is called.
 *
 * Proved here, in the DOM a screen reader reads: the two buttons are real buttons with their text labels and a hint they name;
 * the Music direction box fills after Transcribe reference lyrics only while it is empty or still holds what the feature wrote;
 * text she typed is never replaced and she is told which button to use; the explicit button always replaces, says so in the one
 * status line, and Undo writing change brings her text back and leaves her lyrics alone; a failure keeps her text and returns
 * focus to the button; the buttons are disabled while anything else works; no id is used twice. With KADE_DESCRIBE_SOUND=0 the
 * second page has no Describe button and the first still transcribes exactly as before.
 *
 * Run: node --test api/server/routes/soundBoothDescribePage.selftest.cjs
 */
const fs = require('fs'), vm = require('vm'), http = require('http'), assert = require('assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = require('path').resolve(__dirname, '../../..');
const shared = require(root + '/api/server/routes/kadePages.js').SHARED_HEAD;

function buildPage(flag) {
  const saved = process.env.KADE_DESCRIBE_SOUND;
  if (flag === undefined) delete process.env.KADE_DESCRIBE_SOUND; else process.env.KADE_DESCRIBE_SOUND = flag;
  try {
    const context = { module: { exports: {} }, require: (name) => name === './kadePages' ? ({ SHARED_HEAD: shared + '<script>async function getToken(){return "fixture"}</script>' }) : require(root + '/api/server/routes/' + name) };
    vm.runInNewContext(fs.readFileSync(root + '/api/server/routes/kadeSoundBoothPage.js', 'utf8'), context);
    return context.module.exports.soundBoothHtml;
  } finally {
    if (saved === undefined) delete process.env.KADE_DESCRIBE_SOUND; else process.env.KADE_DESCRIBE_SOUND = saved;
  }
}
const pageOn = buildPage(undefined), pageOff = buildPage('0');
assert.notEqual(pageOn, pageOff);

const ts = require('typescript');
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const { effectsGuide } = require(root + '/packages/api/src/audio/effects.ts');
const backend = fs.readFileSync(root + '/api/server/routes/kadeSoundBooth.js', 'utf8');
const a = backend.indexOf('const GUIDE = ') + 14, b = backend.indexOf('\n};', a) + 2;
const guide = vm.runInNewContext('(' + backend.slice(a, b) + ')', { effectsGuide, yueStylesEnabled: () => false, yueStyles: {}, SCREENPLAY_HELP: 'Actor directions in brackets; spoken text outside brackets.', yueCost: 'No reliable per-song cost estimate yet.' });

const LINE_1 = 'English, folk, mid-tempo, female lead vocal, warm acoustic guitar, soft harmonies';
const LINE_2 = 'English, soul, slow tempo, male lead vocal, gritty vocals, warm organ';
const WARNING = 'Draft lyrics only: review the words before generating.';
const FILLED = 'Music direction filled with what the recording sounds like. Change it or clear it if you want a different style.';
const NAMED = ' Track title: cover (cover).';
const READY = 'A description of the sound is ready, but your Music direction was kept. Choose Describe the sound of the recording to use it.';
const REPLACED = 'Music direction replaced with what the recording sounds like. Change it or clear it to move the cover to another genre. Undo writing change brings back your previous direction.';
const NOTE = 'I could not describe the sound this time; type it yourself.';
const HINT = 'Free. Fills Music direction with what the recording sounds like, for a cover in the same style. Change or clear it to move the cover to another genre.';

const sent = [], errors = [];
let lyricsReply = () => ({ transcript: '[Verse]\nTranscribed singing', warning: WARNING, direction: LINE_1 });
let describeReply = () => ({ status: 200, body: { direction: LINE_2, cached: false } });
let holdDescribe = null;
let holdLyrics = null;
let lyricsStatus = 200;

const server = http.createServer((req, res) => {
  if (req.url === '/sound-booth') { res.setHeader('Content-Type', 'text/html'); res.end(pageOn); return; }
  if (req.url === '/sound-booth-off') { res.setHeader('Content-Type', 'text/html'); res.end(pageOff); return; }
  if (req.url.startsWith('/assets/')) { res.setHeader('Content-Type', 'application/javascript'); res.end(req.url === '/assets/soundbooth/workbench.js' ? fs.readFileSync(root + '/client/public/assets/soundbooth/workbench.js', 'utf8') : ''); return; }
  res.setHeader('Content-Type', 'application/json');
  if (req.url.endsWith('/health')) { res.end(JSON.stringify({ guide, moods: [{ key: 'joyful', label: 'Joyful' }] })); return; }
  if (req.url.endsWith('/projects')) { res.end(JSON.stringify({ projects: [] })); return; }
  if (req.method === 'GET') { res.end('{}'); return; }
  let raw = '';
  req.on('data', (c) => raw += c);
  req.on('end', async () => {
    if (req.url.endsWith('/reference')) { res.end(JSON.stringify({ url: 'https://example.test/cover.mp3', name: 'cover.mp3', seconds: 200, spoken: 'Song imported.' })); return; }
    const body = JSON.parse(raw || '{}');
    sent.push({ url: req.url, body });
    if (req.url.endsWith('/reference/lyrics')) {
      if (holdLyrics) await holdLyrics;
      res.statusCode = lyricsStatus; res.end(JSON.stringify(lyricsReply())); return;
    }
    if (req.url.endsWith('/reference/describe')) {
      if (holdDescribe) await holdDescribe;
      const reply = describeReply();
      res.statusCode = reply.status; res.end(JSON.stringify(reply.body)); return;
    }
    res.end(JSON.stringify({}));
  });
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/sound-booth');
    await page.locator('#app').waitFor({ state: 'visible' });
    const status = () => page.locator('#status').innerText();
    const focused = () => page.evaluate(() => document.activeElement && document.activeElement.id);
    const importCover = async () => {
      if (!(await page.locator('#settingsDrawer').evaluate((el) => el.open))) await page.locator('#settingsDrawer > summary').click();
      await page.locator('#set_reference_voice_url').setInputFiles({ name: 'cover.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('fixture') });
      await page.locator('.clips audio source').waitFor({ state: 'attached' });
    };

    /* ---- no recording yet: neither button ---- */
    await page.locator('[data-engine="yue2"]').click();
    assert.equal(await page.locator('#btnLyrics').count(), 0);
    assert.equal(await page.locator('#btnDescribe').count(), 0, 'no recording, no button');
    await importCover();

    /* ---- the buttons: real, labelled, hinted ---- */
    const transcribe = page.getByRole('button', { name: 'Transcribe reference lyrics', exact: true });
    const describe = page.getByRole('button', { name: 'Describe the sound of the recording', exact: true });
    assert.equal(await transcribe.count(), 1);
    assert.equal(await describe.count(), 1, 'a real button, found by its text label');
    assert.equal(await page.locator('#btnDescribe').evaluate((el) => el.tagName + ':' + el.type + ':' + el.textContent), 'BUTTON:button:Describe the sound of the recording');
    assert.equal(await page.locator('#btnDescribe').getAttribute('aria-describedby'), 'describeHint');
    assert.equal(await page.locator('#describeHint').innerText(), HINT);
    assert.equal(await page.locator('#btnDescribe').isEnabled(), true);
    assert.equal(await page.locator('#status').getAttribute('role'), 'status');
    assert.equal(await page.locator('#status').getAttribute('aria-live'), 'polite');
    const order = await page.evaluate(() => [...document.querySelectorAll('#settingsExtras button')].map((b) => b.textContent));
    assert.deepEqual(order.slice(0, 2), ['Transcribe reference lyrics', 'Describe the sound of the recording'], 'in reading order, one after the other');
    const doubled = await page.evaluate(() => { const seen = {}; for (const el of document.querySelectorAll('[id]')) seen[el.id] = (seen[el.id] || 0) + 1; return Object.entries(seen).filter(([, n]) => n > 1).map(([id]) => id); });
    assert.deepEqual(doubled, [], 'no id is used twice');

    /* ---- Transcribe reference lyrics: an empty box is filled ---- */
    await page.locator('#set_lyrics').fill('My first lyrics');
    assert.equal(await page.locator('#script').inputValue(), '');
    await transcribe.click();
    await page.waitForFunction((line) => document.getElementById('script').value === line, LINE_1);
    assert.equal(await page.locator('#set_lyrics').inputValue(), '[Verse]\nTranscribed singing');
    assert.equal(await status(), FILLED + NAMED + ' ' + WARNING, 'one sentence in the one status line, the part about Music direction first');
    assert.equal(await page.locator('#trackTitle').inputValue(), 'cover (cover)', 'an untitled cover is named after its recording');
    assert.equal(await focused(), 'set_lyrics', 'focus lands on the lyrics, as before');
    assert.equal(await page.locator('#script').getAttribute('data-auto-direction'), LINE_1);
    assert.equal(await page.locator('#btnUndoWriting').isVisible(), true);
    assert.equal(sent.at(-1).url, '/api/kade/sound-booth/reference/lyrics');
    assert.deepEqual(sent.at(-1).body, { url: 'https://example.test/cover.mp3', describe: true }, 'the page asks for the description');
    /* Undo writing change brings back the empty direction, the empty title and her lyrics */
    await page.locator('#btnUndoWriting').click();
    assert.equal(await page.locator('#script').inputValue(), '');
    assert.equal(await page.locator('#set_lyrics').inputValue(), 'My first lyrics');
    assert.equal(await page.locator('#trackTitle').inputValue(), '', 'and the title the feature wrote');
    assert.equal(await status(), 'Previous writing restored.');

    /* ---- the box still holds the feature's own earlier line: it is replaced ---- */
    await transcribe.click();
    await page.waitForFunction((line) => document.getElementById('script').value === line, LINE_1);
    lyricsReply = () => ({ transcript: '[Verse]\nSecond draft', warning: WARNING, direction: LINE_2 });
    await transcribe.click();
    await page.waitForFunction((line) => document.getElementById('script').value === line, LINE_2);
    assert.equal(await status(), FILLED + ' ' + WARNING, 'the title was already named, so it is not announced again');
    assert.equal(await page.locator('#script').getAttribute('data-auto-direction'), LINE_2);

    /* ---- typing clears the flag; what she typed is never replaced ---- */
    await page.locator('#script').press('End');
    await page.locator('#script').pressSequentially(' with more reverb');
    assert.equal(await page.locator('#script').getAttribute('data-auto-direction'), null, 'editing clears the flag');
    const mine = LINE_2 + ' with more reverb';
    assert.equal(await page.locator('#script').inputValue(), mine);
    lyricsReply = () => ({ transcript: '[Verse]\nThird draft', warning: WARNING, direction: LINE_1 });
    await transcribe.click();
    await page.waitForFunction(() => document.getElementById('set_lyrics').value.includes('Third draft'));
    assert.equal(await page.locator('#script').inputValue(), mine, 'her text is kept');
    assert.equal(await status(), READY + ' ' + WARNING, 'she is told a description is ready and which button uses it, before the warning');
    /* her own text from the start (never filled by the feature) */
    await page.locator('#script').fill('A slow blues cover with a gravel voice');
    await transcribe.click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('is ready, but your Music direction was kept'));
    assert.equal(await page.locator('#script').inputValue(), 'A slow blues cover with a gravel voice');

    /* ---- a description that could not be made: the lyrics still land, a plain note is said ---- */
    await page.locator('#script').fill('');
    lyricsReply = () => ({ transcript: '[Verse]\nFourth draft', warning: WARNING, direction_note: NOTE });
    await transcribe.click();
    await page.waitForFunction(() => document.getElementById('set_lyrics').value.includes('Fourth draft'));
    assert.equal(await status(), NOTE + ' ' + WARNING);
    assert.equal(await page.locator('#script').inputValue(), '');

    /* ---- an older server (no direction fields): exactly the old sentence ---- */
    lyricsReply = () => ({ transcript: '[Verse]\nFifth draft', warning: WARNING });
    await transcribe.click();
    await page.waitForFunction(() => document.getElementById('set_lyrics').value.includes('Fifth draft'));
    assert.equal(await status(), WARNING);

    /* ---- the explicit button: replaces her text, announces, Undo restores it and leaves the lyrics ---- */
    await page.locator('#script').fill('My own direction, typed by me');
    await page.locator('#set_lyrics').fill('Lyrics she wrote');
    const before = sent.length;
    await describe.click();
    await page.waitForFunction((line) => document.getElementById('script').value === line, LINE_2);
    assert.equal(sent.length, before + 1, 'one press, one request');
    assert.equal(sent.at(-1).url, '/api/kade/sound-booth/reference/describe');
    assert.deepEqual(sent.at(-1).body, { url: 'https://example.test/cover.mp3' });
    assert.equal(await status(), REPLACED);
    assert.equal(await focused(), 'script', 'focus goes to the Music direction box');
    assert.equal(await page.locator('#script').getAttribute('data-auto-direction'), LINE_2);
    assert.equal(await page.locator('#set_lyrics').inputValue(), 'Lyrics she wrote', 'the lyrics are not touched');
    assert.equal(await page.locator('#btnUndoWriting').isVisible(), true);
    await page.locator('#btnUndoWriting').click();
    assert.equal(await page.locator('#script').inputValue(), 'My own direction, typed by me');
    assert.equal(await page.locator('#set_lyrics').inputValue(), 'Lyrics she wrote', 'Undo of a description leaves the lyrics alone');
    assert.equal(await status(), 'Previous writing restored.');
    assert.equal(await page.locator('#btnUndoWriting').isHidden(), true);
    /* the same press again, by keyboard only: no mouse, no trap */
    await page.locator('#btnDescribe').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction((line) => document.getElementById('script').value === line, LINE_2);
    assert.equal(await focused(), 'script');
    await page.keyboard.press('Tab');
    assert.notEqual(await focused(), 'script', 'focus moves on: no trap');

    /* ---- busy: while the description is out nothing else can start ---- */
    let release;
    holdDescribe = new Promise((resolve) => { release = resolve; });
    describeReply = () => ({ status: 200, body: { direction: LINE_1, cached: false } });
    await page.locator('#script').fill('Typed while nothing is running');
    await page.locator('#btnDescribe').click();
    await page.locator('#status').filter({ hasText: 'Listening to how the recording sounds. Your Music direction is kept until the description is ready.' }).waitFor();
    assert.equal(await page.locator('#btnDescribe').isDisabled(), true, 'unavailable while it works (to a screen reader and to the mouse)');
    assert.equal(await page.locator('#btnDescribe').getAttribute('aria-disabled'), 'true');
    assert.equal(await focused(), 'btnDescribe', 'and focus stays on the button instead of dropping to the page');
    assert.equal(await page.locator('#btnLyrics').isDisabled(), true, 'so is the transcribe button');
    assert.equal(await page.locator('#btnRender').isDisabled(), true, 'and Render');
    assert.equal(await page.locator('#btnDraft').isDisabled(), true, 'and Help write this, which would otherwise silently do nothing');
    assert.equal(await page.locator('#btnInspire').isDisabled(), true, 'and Surprise me');
    assert.equal(await page.locator('#script').isEditable(), false, 'Music direction cannot be typed into while the description is on its way to replace it');
    assert.equal(await page.locator('#script').inputValue(), 'Typed while nothing is running', 'her text is kept until the description is ready');
    await page.locator('#btnDescribe').evaluate((el) => el.onclick());
    assert.equal(sent.filter((s) => s.url.endsWith('/reference/describe')).length, 3, 'a second press while it works sends nothing');
    release();
    holdDescribe = null;
    await page.waitForFunction((line) => document.getElementById('script').value === line, LINE_1);
    assert.equal(await page.locator('#btnDescribe').isEnabled(), true);
    assert.equal(await page.locator('#btnDescribe').getAttribute('aria-disabled'), null, 'the unavailable mark is gone');
    assert.equal(await page.locator('#btnLyrics').isEnabled(), true);
    assert.equal(await page.locator('#btnRender').isEnabled(), true);
    assert.equal(await page.locator('#btnDraft').isEnabled(), true);
    assert.equal(await page.locator('#btnInspire').isEnabled(), true);
    assert.equal(await page.locator('#script').isEditable(), true);

    /* ---- Undo brings back what she typed, however many times the buttons are pressed (Edge) ---- */
    await page.locator('#script').fill('MY OWN TYPED DIRECTION');
    await page.locator('#set_lyrics').fill('Lyrics she wrote');
    await page.locator('#trackTitle').fill('');
    describeReply = () => ({ status: 200, body: { direction: LINE_1, cached: false } });
    await describe.click();
    await page.waitForFunction((line) => document.getElementById('script').value === line, LINE_1);
    assert.equal(await page.locator('#trackTitle').inputValue(), 'cover (cover)', 'an untitled cover is named after its recording, not after the first words of the description');
    assert.equal(await status(), REPLACED.replace('genre. Undo', 'genre.' + NAMED + ' Undo'));
    describeReply = () => ({ status: 200, body: { direction: LINE_2, cached: false } });
    await describe.click();
    await page.waitForFunction((line) => document.getElementById('script').value === line, LINE_2);
    assert.equal(await status(), REPLACED, 'the title was named already, so it is not announced again');
    await page.locator('#btnUndoWriting').click();
    assert.equal(await page.locator('#script').inputValue(), 'MY OWN TYPED DIRECTION', 'Undo after a second press brings back her text, not the first description');
    assert.equal(await page.locator('#trackTitle').inputValue(), '', 'and the empty title');
    assert.equal(await page.locator('#set_lyrics').inputValue(), 'Lyrics she wrote');
    /* Describe, then Transcribe, then Undo */
    describeReply = () => ({ status: 200, body: { direction: LINE_1, cached: false } });
    await describe.click();
    await page.waitForFunction((line) => document.getElementById('script').value === line, LINE_1);
    lyricsReply = () => ({ transcript: '[Verse]\nUndo chain draft', warning: WARNING, direction: LINE_2 });
    await transcribe.click();
    await page.waitForFunction(() => document.getElementById('set_lyrics').value.includes('Undo chain draft'));
    assert.equal(await page.locator('#script').inputValue(), LINE_2);
    await page.locator('#btnUndoWriting').click();
    assert.equal(await page.locator('#script').inputValue(), 'MY OWN TYPED DIRECTION', 'Undo after Describe then Transcribe brings back her text');
    assert.equal(await page.locator('#set_lyrics').inputValue(), 'Lyrics she wrote');
    assert.equal(await page.locator('#trackTitle').inputValue(), '');
    /* a title she wrote is never replaced */
    await page.locator('#trackTitle').fill('My porch song');
    describeReply = () => ({ status: 200, body: { direction: LINE_1, cached: false } });
    await describe.click();
    await page.waitForFunction((line) => document.getElementById('script').value === line, LINE_1);
    assert.equal(await page.locator('#trackTitle').inputValue(), 'My porch song');
    assert.equal(await status(), REPLACED);
    await page.locator('#trackTitle').fill('');

    /* ---- Transcribe reference lyrics: focus stays on its button while it works, and comes back after a failure ---- */
    await page.locator('#script').fill('');
    let freeLyrics;
    holdLyrics = new Promise((resolve) => { freeLyrics = resolve; });
    lyricsReply = () => ({ transcript: '[Verse]\nHeld draft', warning: WARNING, direction: LINE_1 });
    await page.locator('#btnLyrics').focus();
    await page.keyboard.press('Enter');
    await page.locator('#status').filter({ hasText: 'Listening for the sung words.' }).waitFor();
    assert.equal(await focused(), 'btnLyrics', 'focus stays on the button while it works');
    assert.equal(await page.locator('#btnLyrics').getAttribute('aria-disabled'), 'true');
    assert.equal(await page.locator('#btnLyrics').isDisabled(), true);
    assert.equal(await page.locator('#btnDescribe').isDisabled(), true);
    assert.equal(await page.locator('#btnDraft').isDisabled(), true);
    assert.equal(await page.locator('#btnInspire').isDisabled(), true);
    freeLyrics();
    holdLyrics = null;
    await page.waitForFunction(() => document.getElementById('set_lyrics').value.includes('Held draft'));
    assert.equal(await focused(), 'set_lyrics', 'a success moves focus to the lyrics, as before');
    assert.equal(await page.locator('#btnDraft').isEnabled(), true);
    assert.equal(await page.locator('#btnInspire').isEnabled(), true);
    assert.equal(await status(), FILLED + NAMED + ' ' + WARNING);
    lyricsStatus = 502;
    lyricsReply = () => ({ error: 'Could not transcribe this recording.' });
    await page.locator('#btnLyrics').focus();
    await page.keyboard.press('Enter');
    await page.locator('#status.err').waitFor();
    assert.equal(await status(), 'Could not transcribe this recording.');
    assert.equal(await focused(), 'btnLyrics', 'a failure puts focus back on the button');
    assert.equal(await page.locator('#btnLyrics').isEnabled(), true);
    assert.equal(await page.locator('#btnDraft').isEnabled(), true);
    assert.equal(await page.locator('#btnInspire').isEnabled(), true);
    lyricsStatus = 200;
    await page.locator('#trackTitle').fill('');

    /* ---- a failure: her text is kept, the error is said, focus is on the button, Undo is not armed for it ---- */
    await page.locator('#script').fill('My text before the failure');
    await page.locator('#btnUndoWriting').evaluate((el) => { el.hidden = true; });
    describeReply = () => ({ status: 502, body: { error: 'I could not describe the sound this time. Your Music direction is kept; type it yourself.' } });
    await describe.click();
    await page.locator('#status.err').waitFor();
    assert.equal(await status(), 'I could not describe the sound this time. Your Music direction is kept; type it yourself.');
    assert.equal(await page.locator('#script').inputValue(), 'My text before the failure');
    assert.equal(await focused(), 'btnDescribe', 'focus is on the button, not lost');
    assert.equal(await page.locator('#btnDescribe').isEnabled(), true);
    assert.equal(await page.locator('#btnUndoWriting').isHidden(), true);

    /* ---- the page is still a page: no script errors, no duplicate ids ---- */
    const doubledAfter = await page.evaluate(() => { const seen = {}; for (const el of document.querySelectorAll('[id]')) seen[el.id] = (seen[el.id] || 0) + 1; return Object.entries(seen).filter(([, n]) => n > 1).map(([id]) => id); });
    assert.deepEqual(doubledAfter, []);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('#btnDescribe').isVisible(), true, 'and it is there on a phone-sized screen');
    /* The page's Describe-a-music-direction panel already runs 16px past a 390px screen without this feature (the same in the
     * switched-off page); the new button and its hint add nothing to that: both sit inside the screen. */
    const edges = await page.evaluate(() => ['btnDescribe', 'describeHint', 'btnLyrics'].map((id) => Math.round(document.getElementById(id).getBoundingClientRect().right)).concat(document.documentElement.clientWidth));
    assert.ok(edges.slice(0, 3).every((right) => right <= edges[3]), 'the buttons and the hint fit the width: ' + edges.join(','));

    /* ---- other engines never show it ---- */
    await page.locator('[data-engine="lyria"]').click();
    assert.equal(await page.locator('#btnDescribe').count(), 0);
    await page.locator('[data-engine="scenema"]').click();
    assert.equal(await page.locator('#btnDescribe').count(), 0, 'AuK keeps its reference without it');

    /* ---- KADE_DESCRIBE_SOUND=0: the second page ---- */
    const off = await browser.newPage();
    off.on('pageerror', (e) => errors.push(e.message));
    await off.goto(base + '/sound-booth-off');
    await off.locator('#app').waitFor({ state: 'visible' });
    await off.locator('[data-engine="yue2"]').click();
    await off.locator('#settingsDrawer > summary').click();
    await off.locator('#set_reference_voice_url').setInputFiles({ name: 'cover.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('fixture') });
    await off.locator('.clips audio source').waitFor({ state: 'attached' });
    assert.equal(await off.locator('#btnLyrics').count(), 1);
    assert.equal(await off.locator('#btnDescribe').count(), 0, 'no button');
    assert.equal(await off.locator('#describeHint').count(), 0);
    lyricsReply = () => ({ transcript: '[Verse]\nOff-page draft', warning: WARNING, direction: LINE_1 });
    await off.locator('#btnLyrics').click();
    await off.waitForFunction(() => document.getElementById('set_lyrics').value.includes('Off-page draft'));
    assert.equal(await off.locator('#status').innerText(), WARNING, 'a direction a server sent is ignored: the old sentence only');
    assert.equal(await off.locator('#script').inputValue(), '', 'and the box is left alone');
    assert.deepEqual(sent.at(-1).body, { url: 'https://example.test/cover.mp3' }, 'and it does not ask for a description');
    await off.locator('#btnUndoWriting').click();
    assert.equal(await off.locator('#status').innerText(), 'Previous writing restored.');
    assert.equal(await off.evaluate(() => typeof describeSound + typeof heardSound), 'undefinedundefined');

    assert.deepEqual(errors, []);
    console.log('Describe the sound page tests passed: real labelled buttons, fill when empty or earlier auto-fill, typed text kept and the button named, explicit replace with announce and undo, busy and failure handling, keyboard use, phone width, and the switched-off page.');
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((e) => { console.error(e); server.closeAllConnections(); server.close(); process.exitCode = 1; });
