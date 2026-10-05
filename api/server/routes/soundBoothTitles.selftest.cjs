'use strict';
const fs = require('node:fs'), vm = require('node:vm'), http = require('node:http'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = require('node:path').resolve(__dirname, '../../..');
const ts = require('typescript');
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
const { effectsGuide } = require(root + '/packages/api/src/audio/effects.ts');
const backend = fs.readFileSync(root + '/api/server/routes/kadeSoundBooth.js', 'utf8');
const a = backend.indexOf('const GUIDE = ') + 14, b = backend.indexOf('\n};', a) + 2;
const guide = vm.runInNewContext('(' + backend.slice(a, b) + ')', { effectsGuide, yueStylesEnabled: () => false, yueStyles: {}, SCREENPLAY_HELP: '', yueCost: '' });
const context = { module: { exports: {} }, require: name => name === './kadePages' ? { SHARED_HEAD: '<script>async function getToken(){return "offline-fixture"}</script>' } : require(root + '/api/server/routes/' + name) };
vm.runInNewContext(fs.readFileSync(root + '/api/server/routes/kadeSoundBoothPage.js', 'utf8'), context);
const result = { title: 'Ribbon Thief', script: 'Playful folk, guitar and handclaps.\nLyrics:\n[Verse 1]\nA red kite clears the barn', readback: 'A playful kite jingle.' };
let released = false, polls = 0;
const sent = [], errors = [];
const server = http.createServer((req, res) => {
  if (req.url === '/sound-booth') { res.setHeader('Content-Type', 'text/html'); res.end(context.module.exports.soundBoothHtml); return; }
  res.setHeader('Content-Type', 'application/json');
  if (req.url.endsWith('/health')) { res.end(JSON.stringify({ guide, moods: [] })); return; }
  if (req.url.endsWith('/projects')) { res.end('{"projects":[]}'); return; }
  if (req.url.includes('/script/job/')) { polls++; res.end(JSON.stringify(released ? { state: 'done', result } : { state: 'working', seconds: 0 })); return; }
  if (req.method === 'GET') { res.end('{}'); return; }
  let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
    const body = JSON.parse(raw || '{}'); sent.push({ url: req.url, body });
    if (req.url.endsWith('/script')) { res.statusCode = 202; res.end('{"job":"offline-song","state":"working"}'); }
    else res.end('{"spoken":"Offline recording fixture accepted."}');
  });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
  try {
    const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { const original = window.setTimeout; window.setTimeout = (fn, ms, ...args) => original(fn, ms === 8000 ? 30 : ms, ...args); });
    const url = 'http://127.0.0.1:' + server.address().port + '/sound-booth';
    async function open() { await page.goto(url); await page.locator('#app').waitFor({ state: 'visible' }); await page.locator('[data-engine="lyria"]').click(); }
    async function draft(title, during) {
      await page.locator('#trackTitle').fill(title); await page.locator('#script').fill('A red kite escapes the barn.');
      released = false; const before = polls; await page.locator('#btnDraft').click();
      while (polls === before) await new Promise(resolve => setTimeout(resolve, 10));
      if (during !== undefined) for (const title of Array.isArray(during) ? during : [during]) await page.locator('#trackTitle').fill(title);
      released = true; await page.locator('#status').filter({ hasText: 'Draft ready in the editor' }).waitFor();
    }
    await open();
    for (const mode of ['Low', 'Medium', 'High']) await page.getByRole('button', { name: 'Writing thought: ' + (mode === 'Low' ? 'Auto' : mode === 'Medium' ? 'Low' : 'Medium'), exact: true }).click();
    await draft('');
    assert.equal(sent.at(-1).body.thinkMode, 'high');
    assert.equal(await page.locator('#trackTitle').inputValue(), 'Ribbon Thief');
    assert.doesNotMatch(await page.locator('#script').inputValue(), /Ribbon Thief|TITLE:/);
    assert.equal(await page.locator('#set_lyrics').inputValue(), '[Verse 1]\nA red kite clears the barn');
    await page.locator('[data-engine="seed"]').click(); await page.locator('[data-engine="lyria"]').click();
    assert.equal(await page.locator('#trackTitle').inputValue(), 'Ribbon Thief', 'engine draft restoration keeps its generated title');
    await page.locator('#btnRender').click(); await page.locator('#status').filter({ hasText: 'Offline recording fixture accepted' }).waitFor();
    assert.equal(sent.at(-1).body.title, 'Ribbon Thief', 'save/render payload uses the title field');
    await draft('My title'); assert.equal(await page.locator('#trackTitle').inputValue(), 'My title');
    await draft('', 'Title typed while waiting'); assert.equal(await page.locator('#trackTitle').inputValue(), 'Title typed while waiting');
    await draft('', ['Typed then cleared', '']); assert.equal(await page.locator('#trackTitle').inputValue(), '', 'a title typed then cleared during writing remains empty');
    await draft('My title', ''); assert.equal(await page.locator('#trackTitle').inputValue(), '', 'a manual title cleared while waiting is not silently restored');
    await draft(''); await page.locator('#btnUndoWriting').click(); assert.equal(await page.locator('#trackTitle').inputValue(), '');
    await draft(''); await page.locator('#trackTitle').fill('Edited after completion'); await page.locator('#btnUndoWriting').click(); assert.equal(await page.locator('#trackTitle').inputValue(), 'Edited after completion');
    released = true;
    await page.evaluate(() => { localStorage.setItem('kadeSoundBoothDraftJob', 'offline-song|lyria'); localStorage.setItem('kadeSoundBoothThinkMode', 'high'); });
    const posts = sent.filter(s => s.url.endsWith('/script')).length;
    await page.reload(); await page.locator('#status').filter({ hasText: 'Draft ready in the editor' }).waitFor();
    assert.equal(await page.locator('#trackTitle').inputValue(), 'Ribbon Thief', 'resumed background draft fills the empty title');
    assert.equal(await page.getByRole('button', { name: 'Writing thought: High', exact: true }).count(), 1);
    assert.equal(sent.filter(s => s.url.endsWith('/script')).length, posts, 'resume does not create a second writing request');
    assert.deepEqual(errors, []);
    console.log('Booth title/High browser checks passed: async/manual/edited/cleared titles, undo, draft restoration, save payload, resume, persisted High and no duplicate writing request.');
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.closeAllConnections(); server.close(); process.exitCode = 1; });
