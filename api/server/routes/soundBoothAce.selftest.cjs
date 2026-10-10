/* The ACE-Step XL card on the Sound Booth page, in a real browser (headless Edge through Playwright, the way
 * soundBoothWorkspace.selftest.cjs runs the rest of the page). The server is a fixture: the real page, the real guide
 * (the shared GUIDE literal plus the card ace.ts builds), the real carry module, and canned answers for the rest. Nothing
 * leaves this process and nothing is spent. The words are invented placeholders.
 *
 * What it proves: the card sits after YuE2's and reads like it (Make music, Write my song idea, Lyrics, Quality, Length,
 * the seed under More settings, no recording to cover); a render carries the direction and the lyrics and only the choices
 * she changed, no voice, mood, gender or clip; the writing desk drafts for it; a sung song with no words is not sent;
 * the library names it, offers Cover this take on its takes and Carry to the other song engines; Cover this take opens
 * the YuE2 card with the take's MP3 (not its WAV master) attached and the words and style filled in, and sends nothing; a
 * YuE2 take still covers from its WAV master; Open this in the booth restores the choices; Copy draft carries across with the
 * real carry module; and a booth whose guide has no ACE card shows none and does not break on a saved ACE project.
 * Run: node api/server/routes/soundBoothAce.selftest.cjs (PLAYWRIGHT_MODULE and PLAYWRIGHT_CHANNEL as for the workspace test). */
const fs = require('fs'), vm = require('vm'), http = require('http'), assert = require('assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = require('path').resolve(__dirname, '../../..');
const shared = require(root + '/api/server/routes/kadePages.js').SHARED_HEAD;
const context = {
  module: { exports: {} },
  require: (name) => (name === './kadePages' ? { SHARED_HEAD: shared + '<script>async function getToken(){return "fixture"}</script>' } : require(root + '/api/server/routes/' + name)),
};
vm.runInNewContext(fs.readFileSync(root + '/api/server/routes/kadeSoundBoothPage.js', 'utf8'), context);
const html = context.module.exports.soundBoothHtml;
for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]);

const ts = require('typescript');
require.extensions['.ts'] = (mod, filename) =>
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const { effectsGuide } = require(root + '/packages/api/src/audio/effects.ts');
const { aceGuide } = require(root + '/packages/api/src/music/ace.ts');
const carry = require(root + '/api/server/routes/kadeSoundBoothCarry.js');
const backend = fs.readFileSync(root + '/api/server/routes/kadeSoundBooth.js', 'utf8');
const a = backend.indexOf('const GUIDE = ') + 14, b = backend.indexOf('\n};', a) + 2;
const baseGuide = vm.runInNewContext('(' + backend.slice(a, b) + ')', {
  effectsGuide, yueStylesEnabled: () => false, yueStyles: {}, SCREENPLAY_HELP: 'Actor directions in brackets; spoken text outside brackets.',
  yueCost: 'No reliable per-song cost estimate yet. YuE2 currently does not deduct from your credit balance.',
});
/* What /health sends an account that may use ACE-Step XL, and one that may not (the shared guide, untouched). */
const guides = { with: { ...baseGuide, engines: { ...baseGuide.engines, ace: aceGuide({}) } }, without: baseGuide };
assert.ok(!('ace' in baseGuide.engines), 'the shared GUIDE has no ACE card in it');

const LYRICS = '[Verse]\nthe invented words\n\n[Chorus]\nhold on, hold on\n(hold on)';
const DIRECTION = 'Slow soul, 88 BPM, Rhodes and brushed drums';
const ACE_MP3 = 'https://assets.test/ace/3f2c9a0e-5b1d-4c7a-9e11-0a6d2b7c8e44/master.mp3?X-Amz-Signature=aaa';
const ACE_WAV = 'https://assets.test/ace/3f2c9a0e-5b1d-4c7a-9e11-0a6d2b7c8e44/master.wav?X-Amz-Signature=aaa';
const YUE_MP3 = 'https://assets.test/yue2/7d1e2f30-1111-4222-8333-444455556666/master.mp3?X-Amz-Signature=bbb';
const YUE_WAV = 'https://assets.test/yue2/7d1e2f30-1111-4222-8333-444455556666/master.wav?X-Amz-Signature=bbb';
const projects = [
  {
    id: 'ace-1', title: 'Rain Song', engine: 'ace', state: 'done', why: 'ACE-Step XL — a song made on the sleeping music GPU, best quality', costUSD: 0.02,
    script: DIRECTION, sourceText: 'a slow song about rain', mode: 'easy', updatedAt: '2026-10-10T12:00:00Z',
    options: { quality: 'Best', length: '3:00', singing: 'Sung, with my lyrics', lyrics: LYRICS, seed: 5 },
    carryTo: [{ engine: 'lyria', label: 'Lyria' }, { engine: 'yue2', label: 'YuE2' }],
    takes: [{ id: 't1', url: ACE_MP3, masterUrl: ACE_WAV, seconds: 95, note: '' }],
  },
  {
    id: 'yue-1', title: 'Porch Song', engine: 'yue2', state: 'done', why: 'YuE2 — a song made on the sleeping music GPU', costUSD: 0.05,
    script: 'English, folk, warm alto', mode: 'easy', updatedAt: '2026-10-10T11:00:00Z', options: { lyrics: '[Verse]\nporch words' },
    carryTo: [{ engine: 'lyria', label: 'Lyria' }, { engine: 'ace', label: 'ACE-Step XL' }],
    takes: [{ id: 't2', url: YUE_MP3, masterUrl: YUE_WAV, seconds: 120 }],
  },
  {
    id: 'lyria-1', title: 'Brief Song', engine: 'lyria', state: 'done', why: 'Lyria — a song made from a brief', costUSD: 0.08,
    script: 'A pop brief.', mode: 'easy', updatedAt: '2026-10-10T10:00:00Z', options: {}, carryTo: [{ engine: 'yue2', label: 'YuE2' }, { engine: 'ace', label: 'ACE-Step XL' }],
    takes: [{ id: 't3', url: 'https://assets.test/lyria/a.mp3', seconds: 30 }],
  },
];

const sent = [], errors = [];
let guideKey = 'with';
const server = http.createServer((req, res) => {
  if (req.url === '/sound-booth') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
  if (req.url.startsWith('/assets/')) { res.setHeader('Content-Type', 'application/javascript'); res.end(req.url === '/assets/soundbooth/workbench.js' ? fs.readFileSync(root + '/client/public/assets/soundbooth/workbench.js', 'utf8') : ''); return; }
  res.setHeader('Content-Type', 'application/json');
  if (req.url.endsWith('/health')) { res.end(JSON.stringify({ guide: guides[guideKey], moods: [{ key: 'joyful', label: 'Joyful' }] })); return; }
  if (req.url.endsWith('/projects')) { res.end(JSON.stringify({ projects })); return; }
  if (req.method === 'GET') { res.end('{}'); return; }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    sent.push({ url: req.url, body });
    if (req.url.endsWith('/carry') && !req.url.includes('/projects/')) res.end(JSON.stringify(carry.carryOver(body.draft, body.engine, { ace: guideKey === 'with' })));
    else if (req.url.endsWith('/carry')) res.end(JSON.stringify({ project: { title: 'Porch Song (on ACE-Step XL)' }, notes: ['Fixture note.'] }));
    else if (req.url.endsWith('/render')) res.end(JSON.stringify(body.estimateOnly ? { estimate: { spoken: 'Fixture price.' } } : { projectId: 'music-fixture', spoken: 'Fixture recording ready.' }));
    else if (req.url.endsWith('/script')) {
      res.end(JSON.stringify({ script: body.engine === 'ace' ? 'Warm soul, 88 BPM, Rhodes\nLyrics:\n[Verse]\nhere are invented words' : 'A newly written performance.', readback: 'Fixture draft', title: 'Fixture Title' }));
    } else res.end(JSON.stringify({}));
  });
});

const sentTo = (suffix) => sent.filter((entry) => entry.url.endsWith(suffix));

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
  try {
    const open = async () => {
      const page = await browser.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(() => { const original = window.setInterval; window.setInterval = (callback, ms, ...args) => original(callback, ms === 15000 ? 30 : ms, ...args); });
      await page.goto('http://127.0.0.1:' + server.address().port + '/sound-booth');
      await page.locator('#app').waitFor({ state: 'visible' });
      await page.locator('#library .proj').first().waitFor({ state: 'attached' });
      return page;
    };
    const page = await open();

    /* ---- the card ---- */
    assert.deepEqual(await page.locator('#engines .engcard').evaluateAll((els) => els.map((el) => el.dataset.engine)), ['scenema', 'lyria', 'yue2', 'ace', 'stable', 'seed'], 'ACE-Step XL sits after YuE2');
    assert.equal(await page.locator('[data-engine="ace"] strong').innerText(), 'ACE-Step XL');
    assert.equal(await page.locator('[data-engine="ace"] p').innerText(), 'Songs with your own lyrics, in the style you describe.');
    await page.locator('[data-engine="ace"]').click();
    assert.equal(await page.locator('[data-engine="ace"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#status').innerText(), 'ACE-Step XL. Describe the style, add lyrics, then choose Make music.');
    assert.equal(await page.locator('#btnRender').innerText(), 'Make music');
    assert.equal(await page.locator('#editorLabel').innerText(), 'Music direction');
    assert.equal(await page.locator('#btnDraft').innerText(), 'Write my song idea');
    assert.match(await page.locator('#scriptHint').innerText(), /^Describe the style and singing voice\. Lyrics go in song settings/);
    for (const hidden of ['#writingPanel', '#modePanel', '#moodPanel', '#btnPreview']) assert.equal(await page.locator(hidden).isVisible(), false, hidden);
    assert.equal(await page.locator('#howtoList li').count(), 3);
    assert.match(await page.locator('#renderHint').innerText(), /^ACE-Step XL does not deduct from your credit balance yet/);
    assert.equal(await page.locator('#engineWhere').textContent(), 'Runs on a music GPU that sleeps between songs.');
    await page.locator('#settingsDrawer > summary').click();
    assert.equal(await page.locator('#settingsDrawer > summary').innerText(), 'Lyrics and song settings');
    assert.deepEqual(await page.locator('#set_singing option').allInnerTexts(), ['Sung, with my lyrics', 'Instrumental, no singing']);
    assert.equal(await page.locator('#set_lyrics').evaluate((el) => el.tagName), 'TEXTAREA');
    assert.deepEqual(await page.locator('#set_quality option').allInnerTexts(), ['Fast', 'Best']);
    assert.equal(await page.locator('#set_quality').inputValue(), 'Fast');
    assert.deepEqual(await page.locator('#set_length option').allInnerTexts(), ['Match my lyrics', '1:00', '2:00', '3:00', '4:00', '5:00', '6:00']);
    assert.equal(await page.locator('#set_length').inputValue(), 'Match my lyrics');
    assert.equal(await page.locator('#set_seed').isVisible(), false, 'the seed waits under More settings');
    assert.equal(await page.locator('#moreSettingsGroup > summary').innerText(), 'More settings');
    assert.equal(await page.locator('#moreSettingsGroup #set_seed').count(), 1);
    assert.equal(await page.locator('#set_reference_voice_url').count(), 0, 'ACE-Step XL has no recording to cover');
    assert.equal(await page.locator('#btnLyrics').count(), 0);
    assert.deepEqual(await page.locator('#copyEngine option').allInnerTexts(), ['Lyria', 'YuE2'], 'Copy draft offers the other song engines');

    /* ---- a render: the direction, the lyrics, and only the choices she changed ---- */
    await page.locator('#script').fill(DIRECTION);
    await page.locator('#set_lyrics').fill(LYRICS);
    await page.locator('#btnRender').click();
    await page.locator('#status').filter({ hasText: 'Fixture recording ready' }).waitFor();
    let render = sentTo('/render').at(-1).body;
    assert.equal(render.engine, 'ace');
    assert.equal(render.script, DIRECTION);
    assert.equal(render.lyrics, LYRICS);
    for (const field of ['gender', 'mood', 'voice_description', 'reference_voice_url', 'referenceExpected', 'audio_urls', 'quality', 'length', 'singing', 'seed', 'estimateOnly']) {
      assert.equal(field in render, false, field + ' rode along with an untouched ACE render');
    }
    await page.locator('#set_quality').selectOption('Best');
    await page.locator('#set_length').selectOption('3:00');
    await page.locator('#moreSettingsGroup > summary').click();
    await page.locator('#set_seed').fill('5');
    await page.locator('#btnRender').click();
    await page.waitForFunction((n) => document.getElementById('status').textContent.includes('Fixture recording ready') && n > 0, 1);
    await page.waitForFunction(() => !document.getElementById('btnRender').disabled);
    render = sentTo('/render').at(-1).body;
    assert.deepEqual([render.quality, render.length, render.seed], ['Best', '3:00', 5]);
    assert.equal(sentTo('/render').length, 2);

    /* ---- instrumental, and a sung song with no words ---- */
    await page.locator('#set_singing').selectOption('Instrumental, no singing');
    assert.equal(await page.locator('#set_lyrics').count(), 1, 'as on the YuE2 card, the lyrics box stays; the server ignores it');
    await page.locator('#set_lyrics').fill('');
    await page.locator('#btnRender').click();
    await page.waitForFunction(() => !document.getElementById('btnRender').disabled);
    render = sentTo('/render').at(-1).body;
    assert.equal(sentTo('/render').length, 3, 'an instrumental needs no words');
    assert.equal(render.singing, 'Instrumental, no singing');
    assert.equal('lyrics' in render, false);
    await page.locator('#set_singing').selectOption('Sung, with my lyrics');
    await page.locator('#btnRender').click();
    await page.locator('#status').filter({ hasText: 'Add the words to sing' }).waitFor();
    assert.equal(sentTo('/render').length, 3, 'a sung song with no words is not sent');
    assert.equal(await page.locator('#set_lyrics').evaluate((el) => el === document.activeElement), true, 'focus goes to the lyrics box');

    /* ---- the writing desk drafts for it ---- */
    await page.locator('#script').fill('A slow soul song about rain');
    const before = sent.length;
    await page.locator('#btnDraft').click();
    await page.waitForFunction(() => document.getElementById('script').value === 'Warm soul, 88 BPM, Rhodes');
    assert.equal(await page.locator('#set_lyrics').inputValue(), '[Verse]\nhere are invented words');
    const asked = sentTo('/script').at(-1).body;
    assert.deepEqual([asked.engine, asked.mode, asked.text], ['ace', 'write', 'A slow soul song about rain']);
    assert.equal(asked.background, true, 'a sung draft is a deep job, as for YuE2');
    assert.equal(sent.length, before + 1, 'drafting does not start an audio job');
    assert.equal(await page.locator('#trackTitle').inputValue(), 'Fixture Title');
    await page.locator('#btnUndoWriting').click();
    assert.equal(await page.locator('#script').inputValue(), 'A slow soul song about rain');
    assert.equal(await page.locator('#set_lyrics').inputValue(), '');

    /* ---- the library ---- */
    await page.locator('#recentDrawer > summary').click();
    const aceRow = page.locator('#library .proj', { hasText: 'Rain Song' });
    assert.match(await aceRow.locator('.hint').first().innerText(), /^ACE-Step XL — a song made on the sleeping music GPU, best quality · finished · .* · about 2 cents of execution; startup and idle are extra$/);
    assert.equal(await aceRow.locator('[data-use="cover"]').count(), 1, 'Cover this take is offered on an ACE take');
    assert.equal(await aceRow.locator('[data-use="cover"]').innerText(), 'Cover this take');
    for (const other of ['speech', 'edit', 'upload']) assert.equal(await aceRow.locator(`[data-use="${other}"]`).count(), 0, other);
    assert.deepEqual(await aceRow.locator('[data-carryto]').allTextContents(), ['Carry this to Lyria', 'Carry this to YuE2']);
    assert.equal(await aceRow.locator('details > summary', { hasText: 'Music direction' }).count(), 1);
    assert.equal(await aceRow.locator('a', { hasText: 'Download WAV master' }).count(), 1);
    const yueRow = page.locator('#library .proj', { hasText: 'Porch Song' });
    assert.deepEqual(await yueRow.locator('[data-carryto]').allTextContents(), ['Carry this to Lyria', 'Carry this to ACE-Step XL']);
    assert.equal(await yueRow.locator('[data-use="cover"]').count(), 1);
    const sentBeforeCover = sent.length;

    /* ---- Cover this take on an ACE take: the YuE2 card, the MP3, the words and the style; nothing is sent ---- */
    await aceRow.locator('[data-use="cover"]').click();
    assert.equal(await page.locator('[data-engine="yue2"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.clips audio source').getAttribute('src'), ACE_MP3, 'the listening MP3, which fits the twenty megabyte length check');
    assert.equal(await page.locator('.clips li').count(), 1);
    assert.equal(await page.locator('#trackTitle').inputValue(), 'Rain Song (cover)');
    assert.equal(await page.locator('#set_lyrics').inputValue(), LYRICS);
    assert.equal(await page.locator('#script').inputValue(), DIRECTION);
    assert.equal(await page.locator('#status').innerText(), 'Song attached for a YuE2 cover. Describe the new style and check the lyrics. The original is kept.');
    assert.equal(sent.length, sentBeforeCover, 'attaching a take to cover starts nothing');
    /* A YuE2 take is covered exactly as before, from its WAV master. */
    await page.locator('[data-engine="scenema"]').click();
    await yueRow.locator('[data-use="cover"]').click();
    assert.equal(await page.locator('.clips audio source').getAttribute('src'), YUE_WAV);
    assert.equal(await page.locator('#set_lyrics').inputValue(), '[Verse]\nporch words');

    /* ---- Open this in the booth restores the choices ---- */
    await aceRow.locator('[data-open]').click();
    assert.equal(await page.locator('[data-engine="ace"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#set_quality').inputValue(), 'Best');
    assert.equal(await page.locator('#set_length').inputValue(), '3:00');
    assert.equal(await page.locator('#set_singing').inputValue(), 'Sung, with my lyrics');
    assert.equal(await page.locator('#set_lyrics').inputValue(), LYRICS);
    assert.equal(await page.locator('#set_seed').inputValue(), '5');
    assert.equal(await page.locator('#script').inputValue(), DIRECTION);
    assert.equal(await page.locator('.clips li').count(), 0, 'no recording comes with an ACE project');

    /* ---- Copy draft: the real carry module, to YuE2 and back ---- */
    await page.locator('#copyEngine').selectOption('yue2');
    await page.locator('#btnCopyDraft').click();
    await page.locator('#status').filter({ hasText: 'Copied to YuE2.' }).waitFor();
    const copied = sentTo('/carry').at(-1).body;
    assert.equal(copied.draft.engine, 'ace');
    assert.equal(copied.draft.options.lyrics, LYRICS);
    assert.equal(copied.engine, 'yue2');
    assert.equal(await page.locator('[data-engine="yue2"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#set_lyrics').inputValue(), LYRICS);
    assert.equal(await page.locator('#script').inputValue(), DIRECTION);
    assert.match(await page.locator('#status').innerText(), /YuE2 has no quality choice, no length choice, so those were left behind\./);
    assert.match(await page.locator('#status').innerText(), /Nothing was generated or saved/);
    await page.locator('#copyEngine').selectOption('ace');
    await page.locator('#btnCopyDraft').click();
    await page.locator('#status').filter({ hasText: 'Copied to ACE-Step XL.' }).waitFor();
    assert.equal(await page.locator('#set_singing').inputValue(), 'Sung, with my lyrics');
    assert.equal(await page.locator('#set_lyrics').inputValue(), LYRICS);
    assert.equal(await page.locator('[data-engine="ace"]').getAttribute('aria-pressed'), 'true');
    assert.equal(sentTo('/render').length, 3, 'copying a draft spends nothing');

    /* ---- Carry a saved project: the request names the engine ---- */
    await yueRow.locator('details.carry > summary').click();
    await yueRow.locator('[data-carryto="ace"]').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('Carried over as'));
    assert.deepEqual(sentTo('/carry').at(-1), { url: '/api/kade/sound-booth/projects/yue-1/carry', body: { engine: 'ace', rewrite: false } });

    /* ---- a narrow screen reads the same ---- */
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('#btnRender').innerText(), 'Make music');
    await page.close();

    /* ---- an account whose guide has no ACE card: none shown, and a saved ACE project does not break the page ---- */
    guideKey = 'without';
    const plain = await open();
    assert.deepEqual(await plain.locator('#engines .engcard').evaluateAll((els) => els.map((el) => el.dataset.engine)), ['scenema', 'lyria', 'yue2', 'stable', 'seed']);
    assert.equal(await plain.locator('[data-engine="ace"]').count(), 0);
    await plain.locator('[data-engine="yue2"]').click();
    assert.deepEqual(await plain.locator('#copyEngine option').allInnerTexts(), ['Lyria']);
    await plain.locator('#recentDrawer > summary').click();
    await plain.locator('#library .proj', { hasText: 'Rain Song' }).locator('[data-open]').click();
    assert.match(await plain.locator('#status').innerText(), /not open to your account right now/);
    assert.equal(await plain.locator('[data-engine="yue2"]').getAttribute('aria-pressed'), 'true', 'the page stayed where it was');
    await plain.locator('#library .proj', { hasText: 'Rain Song' }).locator('[data-use="cover"]').click();
    assert.equal(await plain.locator('.clips audio source').getAttribute('src'), ACE_MP3, 'a saved ACE take can still be covered on the YuE2 card');
    await plain.close();

    assert.deepEqual(errors, []);
    console.log('ACE-Step XL page tests passed: the card, a render with only the changed choices, instrumental and missing words, the writing desk, the library, Cover this take with the MP3, Open in the booth, Copy draft through the real carry, and a guide with no ACE card.');
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => { console.error(e); server.closeAllConnections(); server.close(); process.exitCode = 1; });
