import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes, createRequire } from 'node:module';
import vm from 'node:vm';
const source = stripTypeScriptTypes(readFileSync(new URL('./writing.ts', import.meta.url), 'utf8'));
const musicSource = stripTypeScriptTypes(readFileSync(new URL('../music/writing.ts', import.meta.url), 'utf8'));
const { musicWritingPrompt, musicWritingSettings, lyricWritingModel, lyricAgentId, lyricTells, lyricRepairRequest, mergeRepairedLyrics } = await import('data:text/javascript;base64,' + Buffer.from(musicSource).toString('base64'));
const { writingCost } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('music drafting reads the current Lyric persona while formatting and speech stay untouched', async () => {
  const reads = [];
  let instructions = 'First saved persona: protect meaning and use internal rhyme.';
  const read = async filter => { reads.push(filter); return { instructions }; };
  const first = await musicWritingPrompt('Sound Booth format', { engine: 'yue2', mode: 'write' }, read);
  assert.ok(first.includes(instructions));
  assert.match(first, /multisyllable/); assert.match(first, /Keep supplied lyrics exactly/);
  assert.match(first, /THREE verses: verse one ten to fourteen sung lines/); assert.match(first, /naming a weekday \(Tuesday above all\)/); assert.match(first, /coffee in any form/); assert.match(first, /shadows, whispers, echoes, neon/);
  assert.ok(first.indexOf(instructions) < first.indexOf('Sound Booth format'), 'persona leads, format closes');
  assert.match(first, /format below overrides Lyric's default/);
  instructions = 'Updated saved persona: vivid narration with conversational phrasing.';
  const updated = await musicWritingPrompt('Sound Booth format', { engine: 'lyria', mode: 'write' }, read);
  assert.ok(updated.includes(instructions)); assert.ok(!updated.includes('First saved persona'));
  assert.deepEqual(reads, [{ id: lyricAgentId }, { id: lyricAgentId }]);
  for (const request of [{ engine: 'yue2', mode: 'format' }, { engine: 'seed', mode: 'write' }, { engine: 'scenema', mode: 'write' }]) {
    assert.equal(await musicWritingPrompt('Original format', request, read), 'Original format');
  }
  assert.equal(reads.length, 2);
  await assert.rejects(() => musicWritingPrompt('format', { engine: 'yue2', mode: 'write' }, async () => null), error => error.status === 503);
});

test('the real music writing handler sends Lyric instructions and reasoning settings to the lyric model and preserves supplied lyrics', async () => {
  const url = new URL('../../../../api/server/routes/kadeSoundBooth.js', import.meta.url), localRequire = createRequire(url);
  const handlers = new Map(), requests = [], ledger = [];
  let instructions = 'Saved Lyric persona v1: connected thoughts and meaningful rhyme.';
  const router = Object.fromEntries(['post', 'get', 'put', 'delete', 'patch', 'use'].map(method => [method, (path, ...values) => handlers.set(method + path, values.at(-1))]));
  const multer = Object.assign(() => ({ single: () => () => {} }), { memoryStorage: () => ({}) });
  const context = { module: { exports: {} }, Buffer, URL, console, process: { env: { REFRAME_PROXY_SECRET: 'fixture' } }, require(name) {
    if (name === 'express') return { Router: () => router, json: () => () => {} };
    if (name === 'multer') return multer;
    if (name === 'axios') return { post: async (_url, body) => { requests.push(body); return { data: { choices: [{ message: { content: 'Intimate R&B with warm piano.\nLyrics:\n[Verse]\nMy exact authored line.\nREADBACK: A quiet song.' } }], usage: { cost: 0.002 } } }; } };
    if (name === '@librechat/api') return { writingCost, musicWritingPrompt, musicWritingSettings, lyricTells, lyricRepairRequest, mergeRepairedLyrics, lyricWritingModel, lyricAgentId, createYueRouter: () => () => {}, createEffectsRouter: () => () => {}, createLyricsRouter: () => () => {}, effectsGuide: {} };
    if (name === '@librechat/data-schemas') return { logger: { info() {}, warn() {}, error() {} } };
    if (name === '~/models') return { getAgent: async filter => { assert.equal(filter.id, lyricAgentId); return { instructions }; } };
    if (name === '~/models/kadeUsage') return { logKadeUsage: async row => ledger.push(row) };
    if (name === './kadeSoundBoothSplit' || name === './kadeSoundBoothScreenplay') return localRequire(name);
    return {};
  } };
  vm.runInNewContext(readFileSync(url, 'utf8'), context);
  let result;
  const response = { status(code) { assert.equal(code, 200); return this; }, json(value) { result = value; return this; } };
  const request = { user: { id: 'writer-fixture' }, body: { engine: 'yue2', mode: 'write', text: 'An intimate R&B song about coming home.', lyrics: 'My exact authored line.' } };
  await handlers.get('post/script')(request, response);
  assert.ok(requests[0].messages[0].content.includes(instructions));
  assert.equal(requests[0].model, lyricWritingModel);
  assert.equal(requests[0].max_tokens, 16000);
  assert.equal(requests[0].temperature, 0.85);
  assert.equal(requests[0].top_p, 0.95);
  assert.deepEqual({ ...requests[0].reasoning }, { enabled: true, effort: 'low', exclude: true }, 'thin briefs must not depend on the gateway classifier to think');
  assert.equal(ledger[0].metadata.model, lyricWritingModel);
  assert.match(requests[0].messages[1].content, /Keep these words exactly/);
  assert.match(result.script, /Lyrics:\n\[Verse\]/);
  assert.equal(ledger[0].metadata.writingPersona, lyricAgentId);
  assert.equal(ledger[0].costUSD, 0.002);
  instructions = 'Saved Lyric persona v2: changed by the owner.';
  await handlers.get('post/script')(request, response);
  assert.ok(requests[1].messages[0].content.includes(instructions));
  assert.ok(!requests[1].messages[0].content.includes('persona v1'));
  request.body.engine = 'lyria';
  await handlers.get('post/script')(request, response);
  assert.equal(requests[2].model, lyricWritingModel);
  request.body.mode = 'format';
  await handlers.get('post/script')(request, response);
  assert.equal(requests[3].model, 'nousresearch/hermes-4-405b');
  assert.equal(requests[3].temperature, 0.7);
  assert.equal(requests[3].reasoning, undefined);
  assert.equal(requests[3].top_p, undefined);
  assert.equal(requests[3].max_tokens, 2200);
});

test('provider cost, including free/cached calls, wins over token estimates', () => {
  assert.deepEqual(writingCost({ cost: 0, prompt_tokens: 3000, completion_tokens: 1000 }, 'nousresearch/hermes-4-405b'), { costUSD: 0, measured: true });
  assert.deepEqual(writingCost({ cost: 0.0032, prompt_tokens: 3000 }, 'custom/model'), { costUSD: 0.0032, measured: true });
});

test('Hermes draft estimates are marked as estimates, with missing and invalid usage handled', () => {
  assert.deepEqual(writingCost({ prompt_tokens: 3000, completion_tokens: 1000 }, 'nousresearch/hermes-4-405b'), { costUSD: 0.006, measured: false });
  assert.deepEqual(writingCost({}, 'nousresearch/hermes-4-405b', 12000, 4000), { costUSD: 0.006, measured: false });
  assert.equal(writingCost({ cost: -1, prompt_tokens: -1, completion_tokens: 1000 }, 'nousresearch/hermes-4-405b').costUSD, 0.003);
});

test('real Sound Booth request honors its configured model and returns its actual cost', async () => {
  const route = readFileSync(new URL('../../../../api/server/routes/kadeSoundBooth.js', import.meta.url), 'utf8');
  const declaration = route.match(/^const MODEL = .*;$/m)[0];
  const start = route.indexOf('async function callModel(');
  const end = route.indexOf('\n/* ---------- AuK XML', start);
  const requests = [];
  const context = { writingCost, process: { env: { KADE_SOUNDBOOTH_MODEL: 'nousresearch/hermes-4-405b', REFRAME_PROXY_SECRET: 'fixture' } }, UA: 'fixture', axios: { post: async (...args) => { requests.push(args); return { data: { choices: [{ message: { content: '<speak>At the end of the day.</speak>' } }], usage: { cost: 0.003 } } }; } } };
  vm.runInNewContext(declaration + '\n' + route.slice(start, end) + '\nthis.call=callModel;', context);
  const result = await context.call({ system: 'Format only.', user: 'At the end of the day.' });
  assert.equal(requests[0][1].model, 'nousresearch/hermes-4-405b');
  assert.equal(result.text, '<speak>At the end of the day.</speak>');
  assert.equal(result.costUSD, 0.003);
  assert.equal(result.measured, true);
  const grok = await context.call({ system: 'Write lyrics.', user: 'Coming home.', ...musicWritingSettings({ engine: 'yue2', mode: 'write' }) });
  assert.equal(requests[1][1].model, lyricWritingModel);
  assert.equal(requests[1][2].timeout, 112000, 'must give up before iPhone build 302 does at 120 seconds');
  assert.equal(requests[0][2].timeout, 90000);
  assert.equal(grok.costUSD, 0.003);
});

test('real script route accounts for the shortening call as well as the first draft', async () => {
  const url = new URL('../../../../api/server/routes/kadeSoundBooth.js', import.meta.url);
  const localRequire = createRequire(url);
  const handlers = new Map();
  const ledger = [];
  let calls = 0;
  const router = Object.fromEntries(['post', 'get', 'put', 'delete', 'patch', 'use'].map(method => [method, (path, ...handlersForPath) => { handlers.set(method + path, handlersForPath.at(-1)); }]));
  const multer = Object.assign(() => ({ single() { return () => {}; } }), { memoryStorage() { return {}; } });
  const context = { module: { exports: {} }, Buffer, URL, console, process: { env: { KADE_SOUNDBOOTH_MODEL: 'nousresearch/hermes-4-405b', REFRAME_PROXY_SECRET: 'fixture' } }, require(name) {
    if (name === 'express') return { Router: () => router, json: () => () => {} };
    if (name === 'multer') return multer;
    if (name === 'axios') return { post: async () => { calls++; return { data: { choices: [{ message: { content: '[Setting: A quiet room.]\nNora (calm woman) says softly: "' + 'Stay here. '.repeat(calls === 1 ? 220 : 30) + '"' } }], usage: { cost: calls === 1 ? 0.004 : 0.002 } } }; } };
    if (name === '@librechat/api') return { writingCost, musicWritingPrompt, musicWritingSettings, lyricTells, lyricRepairRequest, mergeRepairedLyrics, lyricWritingModel, lyricAgentId, createYueRouter: () => () => {}, createEffectsRouter: () => () => {}, createLyricsRouter: () => () => {}, effectsGuide: {} };
    if (name === '@librechat/data-schemas') return { logger: { info() {}, warn() {}, error() {} } };
    if (name === '~/models/kadeUsage') return { logKadeUsage: async row => ledger.push(row) };
    if (name === './kadeSoundBoothSplit' || name === './kadeSoundBoothScreenplay') return localRequire(name);
    return {};
  } };
  vm.runInNewContext(readFileSync(url, 'utf8'), context);
  let result;
  const response = { status(code) { assert.equal(code, 200); return this; }, json(value) { result = value; return this; } };
  await handlers.get('post/script')({ user: { id: 'fixture' }, body: { engine: 'seed', mode: 'write', text: 'Write a quiet exchange in a room.' } }, response);
  assert.ok(result.script);
  assert.equal(calls, 2);
  assert.equal(ledger[0].costUSD, 0.006);
  assert.equal(ledger[0].metadata.costMeasured, true);
  assert.equal(ledger[0].metadata.model, 'nousresearch/hermes-4-405b');
});

test('lyric model token estimates use its own prices', () => {
  assert.equal(lyricWritingModel, 'moonshotai/kimi-k3');
  assert.deepEqual(writingCost({ prompt_tokens: 1000000, completion_tokens: 1000000 }, lyricWritingModel), { costUSD: 12.87, measured: false });
});

const HER_SONG = `A loose mid-tempo pop song. Around 100 BPM, a four-minute song.
Lyrics:
[Verse 1]
I got eleven dollars and a full tank of nothing to do
My phone's at four percent and honestly that feels about right
I'm out of coffee, out of patience, but never out of luck
[Chorus]
Everything's crooked but I'm standing straight up
Call it chaos, I call it Tuesday
[Bridge]
Worst case I end up somewhere with a story and a porch light
[Outro]
Call it chaos, I call it Tuesday
READBACK: A sunny song about a lucky mess on a Tuesday.`;

test('Part 216: the kill scan finds her three tells in her own song and nothing else', () => {
  const tells = lyricTells(HER_SONG);
  assert.deepEqual(tells.map(t => t.tell), ['coffee', 'a named weekday', 'the porch light']);
  assert.equal(tells[1].line, 'Call it chaos, I call it Tuesday', 'a repeated hook line is reported once');
  assert.ok(!tells.some(t => /eleven dollars|four percent|crooked/.test(t.line)), 'good specifics are left alone');
  assert.ok(!tells.some(t => /^READBACK|^A loose/.test(t.line)), 'only sung lines below Lyrics: are scanned');
});

test('Part 216: a word from the person\'s own brief is theirs; drafts without lyrics scan clean', () => {
  assert.deepEqual(lyricTells(HER_SONG, 'a song about my Tuesday coffee run past the porch light').length, 0);
  assert.deepEqual(lyricTells('An instrumental brief with coffee and neon in the prose. Instrumental only, no vocals.'), []);
  for (const line of ['We cleaned the gutters Saturday', 'Shadows on the wall', 'She whispered it twice', 'Keep it steady now', 'at three a.m. again'])
    assert.equal(lyricTells('x\nLyrics:\n' + line).length, 1, line);
  for (const line of ['I burned the rice again, we ordered in', 'The cleaner called about your coat', 'Sundaes at the Dairy Barn', 'He scenery-chewed the whole toast'])
    assert.equal(lyricTells('x\nLyrics:\n' + line).length, 0, line);
});

test('Part 216: the repair request names the exact lines and protects everything else', () => {
  const ask = lyricRepairRequest(HER_SONG, lyricTells(HER_SONG));
  assert.match(ask, /1\. "I'm out of coffee, out of patience, but never out of luck" -- coffee/);
  assert.match(ask, /Rewrite ONLY those lines/); assert.match(ask, /change it the same way everywhere it appears/);
  assert.match(ask, /find a better hook word and carry it through/);
  assert.ok(ask.endsWith(HER_SONG));
});

test('Part 216: the real handler repairs a flagged draft once, and never touches supplied lyrics', async () => {
  const url = new URL('../../../../api/server/routes/kadeSoundBooth.js', import.meta.url), localRequire = createRequire(url);
  const handlers = new Map(), requests = [], ledger = [];
  const router = Object.fromEntries(['post', 'get', 'put', 'delete', 'patch', 'use'].map(method => [method, (path, ...values) => handlers.set(method + path, values.at(-1))]));
  const multer = Object.assign(() => ({ single: () => () => {} }), { memoryStorage: () => ({}) });
  const draft = 'Warm folk.\nLyrics:\n[Verse 1]\nI poured my coffee on a Tuesday\nThe dog ate half my sandwich\nREADBACK: A folk song.';
  const repaired = 'Warm folk.\nLyrics:\n[Verse 1]\nI poured my Tang the day the fair left town\nThe dog ate half my sandwich\nREADBACK: A folk song.';
  const context = { module: { exports: {} }, Buffer, URL, console, Date, process: { env: { REFRAME_PROXY_SECRET: 'fixture' } }, require(name) {
    if (name === 'express') return { Router: () => router, json: () => () => {} };
    if (name === 'multer') return multer;
    if (name === 'axios') return { post: async (_url, body) => { requests.push(body); return { data: { choices: [{ message: { content: requests.length === 1 || /supplied/.test(body.messages[1].content) ? draft : repaired } }], usage: { cost: 0.01 } } }; } };
    if (name === '@librechat/api') return { writingCost, musicWritingPrompt, musicWritingSettings, lyricTells, lyricRepairRequest, mergeRepairedLyrics, lyricWritingModel, lyricAgentId, createYueRouter: () => () => {}, createEffectsRouter: () => () => {}, createLyricsRouter: () => () => {}, effectsGuide: {} };
    if (name === '@librechat/data-schemas') return { logger: { info() {}, warn() {}, error() {} } };
    if (name === '~/models') return { getAgent: async () => ({ instructions: 'Saved Lyric persona.' }) };
    if (name === '~/models/kadeUsage') return { logKadeUsage: async row => ledger.push(row) };
    if (name === './kadeSoundBoothSplit' || name === './kadeSoundBoothScreenplay') return localRequire(name);
    return {};
  } };
  vm.runInNewContext(readFileSync(url, 'utf8'), context);
  let result; const response = { status() { return this; }, json(value) { result = value; return this; } };
  await handlers.get('post/script')({ user: { id: 'scan-fixture' }, body: { engine: 'yue2', mode: 'write', text: 'a folk song about a bad morning' } }, response);
  assert.equal(requests.length, 2, 'one draft, one repair');
  assert.match(requests[1].messages[1].content, /"I poured my coffee on a Tuesday" -- a named weekday|-- coffee/);
  assert.match(result.script, /Tang the day the fair left town/); assert.doesNotMatch(result.script, /Tuesday/);
  assert.deepEqual([...result.repairs], ['rewrote 1 line that leaned on stock images']);
  assert.equal(ledger[0].costUSD, 0.02, 'both calls are on the ledger');
  requests.length = 0;
  await handlers.get('post/script')({ user: { id: 'scan-fixture-2' }, body: { engine: 'yue2', mode: 'write', text: 'arrange my supplied words', lyrics: 'I poured my coffee on a Tuesday' } }, response);
  assert.equal(requests.length, 1, 'supplied lyrics are never scanned or sent for repair');
});

test('Part 216: only the sung words come from a repair; direction and READBACK stay as first written', () => {
  const first = 'Warm folk, about four minutes.\n\nLyrics:\n[Verse 1]\nI poured my coffee on a Tuesday\nThe dog ate half my sandwich\n\nREADBACK: A folk song about a bad morning, sung by a tired man.';
  const labelDropped = 'Warm FOLK, four mins, rewritten.\n\nLyrics:\n[Verse 1]\nI poured my Tang the day the fair left town\nThe dog ate half my sandwich\n\nA folk song about a bad morning, sung by a tired man.';
  const merged = mergeRepairedLyrics(first, labelDropped);
  assert.ok(merged.startsWith('Warm folk, about four minutes.'), 'direction is the original');
  assert.match(merged, /Tang the day the fair left town/);
  assert.ok(merged.endsWith('READBACK: A folk song about a bad morning, sung by a tired man.'), 'readback is the original, with its label');
  assert.equal(merged.match(/sung by a tired man/g).length, 1, 'the unlabeled readback is not sung');
  const dropped = mergeRepairedLyrics(first, 'x\nLyrics:\n[Verse 1]\nI poured my Tang the day the fair left town\nThe dog ate half my sandwich');
  assert.ok(dropped.endsWith('sung by a tired man.'));
  assert.equal(mergeRepairedLyrics(first, 'Sure! Here is a description with no lyrics.'), null);
  assert.equal(mergeRepairedLyrics(first, 'x\nLyrics:\n[Verse 1]\nOnly one line now'), null, 'a repair that lost lines is refused');
});
