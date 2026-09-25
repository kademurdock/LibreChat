import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes, createRequire } from 'node:module';
import vm from 'node:vm';
const source = stripTypeScriptTypes(readFileSync(new URL('./writing.ts', import.meta.url), 'utf8'));
const hitSource = stripTypeScriptTypes(readFileSync(new URL('../music/hitSystem.ts', import.meta.url), 'utf8')).replace('export const hitWritingSystem', 'const hitWritingSystem');
const musicSource = hitSource + '\n' + stripTypeScriptTypes(readFileSync(new URL('../music/writing.ts', import.meta.url), 'utf8')).replace("import { hitWritingSystem } from './hitSystem';", '');
const { musicWritingPrompt, musicWritingSettings, lyricWritingModel, lyricAgentId, lyricTells, lyricRepairRequest, mergeRepairedLyrics, lyricShapeIssue, labelReadback, lyricAuditRequest, fixStageDirections, musicWritingCraft, SONG_EXPLICIT_NOTE, SONG_CLEAN_NOTE } = await import('data:text/javascript;base64,' + Buffer.from(musicSource).toString('base64'));
const { writingCost } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
/* What the Sound Booth route needs from @librechat/api to load at all (its GUIDE reads the YuE
 * styles when the file loads), and a stand-in for the Part 293 audience helper whose answer a
 * test can set. */
const bootStubs = { yueStylesEnabled: () => false, yueStyles: {} };
const audienceStub = { answer: 'explicit', calls: [] };
const songAudienceStub = { songAudience: async (user, options) => { audienceStub.calls.push({ user, options }); return audienceStub.answer; } };

test('music drafting reads the current Lyric persona while formatting and speech stay untouched', async () => {
  const reads = [];
  let instructions = 'First saved persona: protect meaning and use internal rhyme.';
  const read = async filter => { reads.push(filter); return { instructions }; };
  const first = await musicWritingPrompt('Sound Booth format', { engine: 'yue2', mode: 'write' }, read);
  assert.ok(first.includes(instructions));
  assert.match(first, /Multisyllabic and mosaic rhymes/); assert.match(first, /Keep supplied lyrics exactly/);
  assert.match(first, /SYNTHETIC-VOCAL HIT-WRITING SYSTEM/); assert.match(first, /THE FOURTEEN TELLS/); assert.match(first, /about four minutes, 45 to 65 sung lines/); assert.match(first, /either three verses, or two long verses of 12 to 16 lines each/);
  assert.match(first, /a named weekday \(Tuesday above all\)/); assert.match(first, /drinks are always coffee/);
  assert.match(first, /There is no Lyrics Box, Tag Box or Negative Tag Box here/);
  assert.doesNotMatch(first, /begins with the words `Lyrics Box`|APPENDIX B: TAG BOX PRESETS|REVISION PROTOCOL|30 to 40 lines total/, 'the other product\'s output contract and short budget are not carried');
  assert.doesNotMatch(first, /It's Tuesday\./, 'the system must not seed the tell it bans');
  assert.ok(first.indexOf(instructions) < first.indexOf('THE SEVEN LAWS') && first.indexOf('THE SEVEN LAWS') < first.indexOf('DESK NOTES FROM THE OWNER') && first.indexOf('DESK NOTES FROM THE OWNER') < first.indexOf('Sound Booth format'), 'persona, system, desk notes, format'); assert.match(first, /neon, shadows, whispers or echoes/);
  assert.ok(first.indexOf(instructions) < first.indexOf('Sound Booth format'), 'persona leads, format closes');
  assert.match(first, /format below is the ONLY output format/);
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
    if (name === 'crypto') return { randomBytes: () => ({ toString: () => 'job-fixture' }) };
    if (name === 'axios') return { post: async (_url, body) => { requests.push(body); return { data: { choices: [{ message: { content: 'Intimate R&B with warm piano.\nLyrics:\n[Verse]\nMy exact authored line.\nREADBACK: A quiet song.' } }], usage: { cost: 0.002 } } }; } };
    if (name === '@librechat/api') return { writingCost, musicWritingPrompt, musicWritingSettings, lyricTells, lyricRepairRequest, mergeRepairedLyrics, lyricShapeIssue, labelReadback, lyricAuditRequest, fixStageDirections, lyricWritingModel, lyricAgentId, createYueRouter: () => () => {}, createEffectsRouter: () => () => {}, createLyricsRouter: () => () => {}, effectsGuide: {}, ...bootStubs };
    if (name === '@librechat/data-schemas') return { logger: { info() {}, warn() {}, error() {} } };
    if (name === '~/models') return { getAgent: async filter => { assert.equal(filter.id, lyricAgentId); return { instructions }; } };
    if (name === '~/models/kadeUsage') return { logKadeUsage: async row => ledger.push(row) };
    if (name === '~/server/utils/kadeSongAudience') return songAudienceStub;
    if (name === './kadeSoundBoothSplit' || name === './kadeSoundBoothScreenplay') return localRequire(name);
    return {};
  } };
  vm.runInNewContext(readFileSync(url, 'utf8'), context);
  let result;
  const response = { status(code) { assert.equal(code, 200); return this; }, json(value) { result = value; return this; } };
  const request = { user: { id: 'writer-fixture' }, body: { engine: 'yue2', mode: 'write', text: 'An intimate R&B song about coming home.', lyrics: 'My exact authored line.' } };
  audienceStub.answer = 'explicit'; audienceStub.calls.length = 0;
  await handlers.get('post/script')(request, response);
  assert.ok(requests[0].messages[0].content.includes(instructions));
  /* Part 293: the desk asks who the song is for, and a grown-up's desk carries the explicit note. */
  assert.equal(audienceStub.calls.length, 1); assert.equal(audienceStub.calls[0].user.id, 'writer-fixture');
  assert.ok(requests[0].messages[0].content.includes(SONG_EXPLICIT_NOTE)); assert.ok(!requests[0].messages[0].content.includes(SONG_CLEAN_NOTE));
  assert.equal(ledger[0].metadata.audience, 'explicit');
  assert.equal(requests[0].model, lyricWritingModel);
  assert.equal(requests[0].max_tokens, 24000);
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
  assert.equal(audienceStub.calls.length, 3, 'formatting her own words never asks, and never gets a note');
  assert.doesNotMatch(requests[3].messages[0].content, /CLEAN OR EXPLICIT/);
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
    if (name === 'crypto') return { randomBytes: () => ({ toString: () => 'job-fixture' }) };
    if (name === 'axios') return { post: async () => { calls++; return { data: { choices: [{ message: { content: '[Setting: A quiet room.]\nNora (calm woman) says softly: "' + 'Stay here. '.repeat(calls === 1 ? 220 : 30) + '"' } }], usage: { cost: calls === 1 ? 0.004 : 0.002 } } }; } };
    if (name === '@librechat/api') return { writingCost, musicWritingPrompt, musicWritingSettings, lyricTells, lyricRepairRequest, mergeRepairedLyrics, lyricShapeIssue, labelReadback, lyricAuditRequest, fixStageDirections, lyricWritingModel, lyricAgentId, createYueRouter: () => () => {}, createEffectsRouter: () => () => {}, createLyricsRouter: () => () => {}, effectsGuide: {}, ...bootStubs };
    if (name === '@librechat/data-schemas') return { logger: { info() {}, warn() {}, error() {} } };
    if (name === '~/models/kadeUsage') return { logKadeUsage: async row => ledger.push(row) };
    if (name === '~/server/utils/kadeSongAudience') return songAudienceStub;
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
  assert.equal(lyricWritingModel, 'deepseek/deepseek-v4.1-flash');
  assert.deepEqual(writingCost({ prompt_tokens: 1000000, completion_tokens: 1000000 }, lyricWritingModel), { costUSD: 1.5, measured: false });
  assert.deepEqual(writingCost({ prompt_tokens: 1000000, completion_tokens: 1000000 }, 'moonshotai/kimi-k3'), { costUSD: 12.87, measured: false });
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

test('Part 217: the real handler runs one producer\'s audit that also repairs flagged lines, and never touches supplied lyrics', async () => {
  const url = new URL('../../../../api/server/routes/kadeSoundBooth.js', import.meta.url), localRequire = createRequire(url);
  const handlers = new Map(), requests = [], ledger = [];
  const router = Object.fromEntries(['post', 'get', 'put', 'delete', 'patch', 'use'].map(method => [method, (path, ...values) => handlers.set(method + path, values.at(-1))]));
  const multer = Object.assign(() => ({ single: () => () => {} }), { memoryStorage: () => ({}) });
  const draft = 'Warm folk.\nLyrics:\n[Verse 1]\nI poured my coffee on a Tuesday\nThe dog ate half my sandwich\nREADBACK: A folk song.';
  const repaired = 'Warm folk.\nLyrics:\n[Verse 1]\nI poured my Tang the day the fair left town\nThe dog ate half my sandwich\nREADBACK: A folk song.';
  const context = { module: { exports: {} }, Buffer, URL, console, Date, process: { env: { REFRAME_PROXY_SECRET: 'fixture' } }, require(name) {
    if (name === 'express') return { Router: () => router, json: () => () => {} };
    if (name === 'multer') return multer;
    if (name === 'crypto') return { randomBytes: () => ({ toString: () => 'job-fixture' }) };
    if (name === 'axios') return { post: async (_url, body) => { requests.push(body); return { data: { choices: [{ message: { content: requests.length === 1 || /supplied/.test(body.messages[1].content) ? draft : repaired } }], usage: { cost: 0.01 } } }; } };
    if (name === '@librechat/api') return { writingCost, musicWritingPrompt, musicWritingSettings, lyricTells, lyricRepairRequest, mergeRepairedLyrics, lyricShapeIssue, labelReadback, lyricAuditRequest, fixStageDirections, lyricWritingModel, lyricAgentId, createYueRouter: () => () => {}, createEffectsRouter: () => () => {}, createLyricsRouter: () => () => {}, effectsGuide: {}, ...bootStubs };
    if (name === '@librechat/data-schemas') return { logger: { info() {}, warn() {}, error() {} } };
    if (name === '~/models') return { getAgent: async () => ({ instructions: 'Saved Lyric persona.' }) };
    if (name === '~/models/kadeUsage') return { logKadeUsage: async row => ledger.push(row) };
    if (name === '~/server/utils/kadeSongAudience') return songAudienceStub;
    if (name === './kadeSoundBoothSplit' || name === './kadeSoundBoothScreenplay') return localRequire(name);
    return {};
  } };
  vm.runInNewContext(readFileSync(url, 'utf8'), context);
  let result; const response = { status() { return this; }, json(value) { result = value; return this; } };
  audienceStub.answer = 'clean'; audienceStub.calls.length = 0;
  await handlers.get('post/script')({ user: { id: 'scan-fixture' }, body: { engine: 'yue2', mode: 'write', band: 'kids', text: 'a folk song about a bad morning' } }, response);
  assert.equal(requests.length, 2, 'one draft, one audit');
  /* Part 293: the Kids style reaches the audience check, and the audit reuses the draft's system
   * prompt, so it carries the same clean note. */
  assert.equal(audienceStub.calls[0].options.band, 'kids');
  for (const call of requests) { assert.ok(call.messages[0].content.includes(SONG_CLEAN_NOTE)); assert.ok(!call.messages[0].content.includes(SONG_EXPLICIT_NOTE)); }
  assert.equal(requests[1].messages[0].content, requests[0].messages[0].content, 'the audit sees the same system prompt');
  audienceStub.answer = 'explicit';
  assert.match(requests[1].messages[1].content, /be the producer who decides whether it gets cut/);
  assert.match(requests[1].messages[1].content, /"I poured my coffee on a Tuesday" -- a named weekday|-- coffee/);
  assert.match(result.script, /Tang the day the fair left town/); assert.doesNotMatch(result.script, /Tuesday/);
  assert.deepEqual([...result.repairs], ["second pass: the producer's audit", 'rewrote 1 line that leaned on stock images']);
  assert.equal(ledger[0].costUSD, 0.02, 'both calls are on the ledger');
  requests.length = 0;
  await handlers.get('post/script')({ user: { id: 'scan-fixture-2' }, body: { engine: 'yue2', mode: 'write', text: 'arrange my supplied words', lyrics: 'I poured my coffee on a Tuesday' } }, response);
  assert.equal(requests.length, 1, 'supplied lyrics are never scanned or sent for repair');
  /* Part 218: the deep lane answers at once with a job, thinks on medium, audits on low. */
  requests.length = 0; let code = 0; result = null;
  const accepted = { status(value) { code = value; return this; }, json(value) { result = value; return this; } };
  handlers.get('post/script')({ user: { id: 'deep-fixture' }, body: { engine: 'yue2', mode: 'write', background: true, notify: false, text: 'a folk song about a bad morning' } }, accepted);
  assert.equal(code, 202); assert.equal(result.job, 'job-fixture'); assert.match(result.spoken, /about five minutes/);
  handlers.get('post/script')({ user: { id: 'deep-fixture' }, body: { engine: 'yue2', mode: 'write', background: true, text: 'another one' } }, accepted);
  assert.equal(code, 409, 'one deep draft per person at a time');
  for (let i = 0; i < 50 && requests.length < 2; i++) await new Promise(done => setTimeout(done, 5));
  await new Promise(done => setTimeout(done, 20));
  assert.equal(requests[0].reasoning.effort, 'medium'); assert.equal(requests[1].reasoning.effort, 'low');
  let polled; const poll = { status() { return this; }, json(value) { polled = value; return this; } };
  handlers.get('get/script/job/:id')({ user: { id: 'deep-fixture' }, params: { id: 'job-fixture' } }, poll);
  assert.equal(polled.state, 'done'); assert.match(polled.result.script, /Tang the day the fair left town/);
  handlers.get('get/script/job/:id')({ user: { id: 'someone-else' }, params: { id: 'job-fixture' } }, poll);
  assert.match(polled.error, /That draft is gone/, 'a job belongs to the person who asked');
  const deepSettings = musicWritingSettings({ engine: 'yue2', mode: 'write', deep: true });
  assert.equal(deepSettings.reasoning.effort, 'medium'); assert.equal(deepSettings.timeoutMs, 600000);
  assert.deepEqual(musicWritingSettings({ engine: 'scenema', mode: 'write', deep: true }), {}, 'speech has no deep lane');
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

test('Part 216: a song the desk sized itself must have three verses; her own length wins', () => {
  const two = 'Pop.\nLyrics:\n[Verse 1]\na\n[Chorus]\nb\n[Verse 2]\nc\n[Bridge]\nd\n[Chorus]\nb\nREADBACK: x';
  assert.match(lyricShapeIssue(two, 'a pop song about luck'), /only two short verses.*or two long ones.*Add a \[Verse 3\]/);
  assert.equal(lyricShapeIssue(two.replace('[Bridge]', '[Verse 3]'), 'a pop song about luck'), null);
  /* Part 293: two LONG verses (24 sung verse lines between them) are the desk's other map. */
  const verse = n => Array.from({ length: n }, (_, i) => `line ${i + 1} of this verse`).join('\n');
  const long = (a, b) => `Pop.\nLyrics:\n[Verse 1]\n${verse(a)}\n[Chorus]\nb\n[Verse 2]\n${verse(b)}\n[Bridge]\nd\n[Final Chorus]\nb\n\nREADBACK: x`;
  assert.equal(lyricShapeIssue(long(12, 12), 'a pop song about luck'), null, 'two verses of twelve pass');
  assert.equal(lyricShapeIssue(long(16, 8), 'a pop song about luck'), null, 'the total is what counts');
  assert.match(lyricShapeIssue(long(12, 11), 'a pop song about luck'), /only two short verses/);
  assert.match(lyricShapeIssue(long(12, 11).replace('[Verse 2]\n', '[Verse 2]\n(oh)\n(oh, oh)\n'), 'luck'), /only two short verses/, 'whole-line ad-libs are not verse lines');
  assert.match(lyricShapeIssue(`Pop.\nLyrics:\n[Verse 1]\n${verse(30)}\n[Chorus]\nb\n\nREADBACK: x`, 'luck'), /only one verse.*Add a \[Verse 2\]/, 'one long verse is still one verse');
  assert.equal(lyricShapeIssue(long(12, 12).replace('[Verse 2]', '[Verse 2 - Spoken]'), 'luck'), null, 'a delivery cue keeps a verse a verse');
  for (const brief of ['a short jingle', 'two verses and a chorus', 'a ninety second song', 'sixteen bars about my dog'])
    assert.equal(lyricShapeIssue(two, brief), null, brief);
  assert.equal(lyricShapeIssue('Instrumental brief. Instrumental only, no vocals.', 'surf rock'), null);
  const ask = lyricRepairRequest(two, [], lyricShapeIssue(two, 'luck'));
  assert.match(ask, /it stays, word for word/); assert.match(ask, /Add a \[Verse 3\]/); assert.ok(ask.endsWith(two));
  assert.match(lyricRepairRequest(two, [{ line: 'a', tell: 'coffee' }], 'Add a verse.'), /Also: Add a verse\./);
});

test('Part 216: an unlabelled readback is never left among the sung words', () => {
  const prose = 'A sunny pop song of about four minutes sung by a grinning woman who keeps failing upward, with every mistake landing her somewhere better than she planned.';
  const raw = 'Pop.\n\nLyrics:\n[Verse 1]\nI missed the turn and found the shortcut anyway\n[Outro]\nIt works out anyway\n\n' + prose;
  const fixed = labelReadback(raw);
  assert.ok(fixed.endsWith('READBACK: ' + prose)); assert.match(fixed, /It works out anyway\n\nREADBACK:/);
  assert.equal(labelReadback(fixed), fixed, 'a labelled draft is left alone');
  const sung = 'Pop.\n\nLyrics:\n[Outro]\nIt works out anyway\n\nGood enough, good enough for me';
  assert.equal(labelReadback(sung), sung, 'a short sung last line is not mistaken for prose');
});

test('Part 228: a repair whose READBACK was reworded and unlabelled is never sung (her harp song)', () => {
  const first = 'Orchestral R&B slow jam, 66 BPM.\n\nLyrics:\n[Verse 1]\nThe swing chain creaks the way it did\nI let my shoes fall in the grass\n[Chorus]\nLet it spin, let it spin\nI will catch it coming round\n\nREADBACK: A tired woman sings from a swing in her yard over a rolling harp, about four minutes, and the bridge turns it.';
  const reworded = 'A woman sits on a swing in her yard at the end of a long day, singing low and close to the microphone while a harp rolls in triple time behind her, and the whole thing runs about four minutes. The mood turns at the bridge, where the arrangement drops to harp and one voice and she admits the world has been spinning fine without her.';
  const repair = 'Direction.\n\nLyrics:\n[Verse 1]\nThe swing chain creaks the way it did\nI let my good shoes fall in the grass\n[Chorus]\nLet it spin, let it spin\nI will catch it coming round\n\n' + reworded;
  const merged = mergeRepairedLyrics(first, repair);
  assert.match(merged, /good shoes/);
  assert.doesNotMatch(merged, /singing low and close/);
  assert.ok(merged.endsWith('and the bridge turns it.'));
  const twoParagraphs = mergeRepairedLyrics(first, repair.replace('four minutes. The mood', 'four minutes, with room to breathe between every phrase she sings tonight.\n\nThe mood'));
  assert.doesNotMatch(twoParagraphs, /singing low|mood turns/);
  const relabelled = mergeRepairedLyrics(first, repair.replace(reworded, '**Readback:** short one.'));
  assert.doesNotMatch(relabelled, /short one/);
  assert.match(labelReadback('Pop.\n\nLyrics:\n[Outro]\nIt works out\n\n**Readback:** A pop song.'), /\n\nREADBACK: A pop song\.$/);
});

test('Part 217: the website says it can wait and gets time for the audit; the phone stays inside its limit', () => {
  const phone = musicWritingSettings({ engine: 'yue2', mode: 'write' });
  const web = musicWritingSettings({ engine: 'yue2', mode: 'write', patient: true });
  assert.equal(phone.reasoning.effort, 'low'); assert.equal(phone.timeoutMs, 112000, 'iPhone build 302 gives up at 120 s');
  assert.equal(web.reasoning.effort, 'low', 'medium measured 275 s with the system in the prompt'); assert.equal(web.timeoutMs, 225000, 'the web page aborts at 240 s');
  assert.equal(web.model, phone.model);
  assert.deepEqual(musicWritingSettings({ engine: 'scenema', mode: 'write', patient: true }), {}, 'speech is untouched');
});

test('Part 217: the audit asks for the turn, the hook and the spice, carries flagged lines, and stage directions never get sung', () => {
  const draft = 'Pop.\n\nLyrics:\n[Intro]\n(Whistling)\n[Verse 1]\nI poured my coffee slow\n(oh-oh)\n(Claps and bass only)\nREADBACK: x';
  const ask = lyricAuditRequest(draft, lyricTells(draft), 'Add a [Verse 3].');
  assert.match(ask, /THE TURN and the payoff/); assert.match(ask, /exactly one surprise/); assert.match(ask, /The spice\. Exactly one/);
  assert.match(ask, /1\. "I poured my coffee slow" -- coffee/); assert.match(ask, /8\. Length\. Add a \[Verse 3\]\./); assert.ok(ask.endsWith(draft));
  assert.doesNotMatch(lyricAuditRequest(draft, [], null), /must be rewritten|8\. Length/);
  const fixed = fixStageDirections(draft);
  assert.match(fixed, /^\[Whistling\]$/m); assert.match(fixed, /^\[Claps and bass only\]$/m);
  assert.match(fixed, /^\(oh-oh\)$/m, 'a sung ad-lib stays in parentheses');
});

test('Part 217: a line lifted from the system\'s own examples is flagged like any other tell', () => {
  const copied = 'R&B.\nLyrics:\n[Verse 1]\nYou text at a decent hour now\nReal polite, like we ain\'t been through it\nI burned the toast and blamed the toaster\n[Outro - Vamp]\nMm. I saw it. I ain\'t answer.\n(I sleep fine)';
  const tells = lyricTells(copied, 'r&b song about being over somebody');
  assert.deepEqual(tells.map(t => t.line), ['You text at a decent hour now', "Real polite, like we ain't been through it", "Mm. I saw it. I ain't answer."]);
  assert.ok(tells.every(t => /copied from the writing system/.test(t.tell)));
  assert.equal(lyricTells('x\nLyrics:\nI paid the light bill twice this month and I ain\'t tell nobody').length, 1, 'FIX lines are examples too');
  assert.equal(lyricTells('x\nLyrics:\nNow they know').length, 0, 'three common words are not ownable');
});

test('Part 231: Surprise me writes ideas in her format, shows her list only as a register, and refuses a copy', async () => {
  const strip = file => stripTypeScriptTypes(readFileSync(new URL('../music/' + file, import.meta.url), 'utf8'));
  const shelfSource = strip('ideaShelf.ts').replace('export const ideaShelf', 'const ideaShelf');
  const ideaSource = shelfSource + '\n' + strip('idea.ts').replace("import { ideaShelf } from './ideaShelf';", '') + '\nexport { ideaShelf };';
  const { songIdeaSparks, songIdeaSystem, songIdeaRequest, songIdeaTitle, cleanSongIdea, tooCloseToShelf, ideaShelf } = await import('data:text/javascript;base64,' + Buffer.from(ideaSource).toString('base64'));
  assert.equal(ideaShelf.length, 100, 'her hundred, all of them');
  let n = 0; const rolling = () => ((n = (n * 9301 + 49297) % 233280) / 233280);
  const sparks = songIdeaSparks(rolling, Array.from({ length: 40 }, (_, i) => 'Shown ' + i));
  for (const key of ['sound', 'lens', 'territory']) assert.ok(sparks[key] && sparks[key].length > 3, key);
  assert.equal(typeof sparks.rule, 'boolean');
  assert.equal(sparks.shelf.length, 6); assert.equal(new Set(sparks.shelf).size, 6, 'six different ideas of hers');
  assert.equal(sparks.avoid.length, 30); assert.equal(sparks.avoid.at(-1), 'Shown 39');
  for (const edge of [() => 0, () => 0.999999, () => 1]) assert.ok(songIdeaSparks(edge).sound);
  assert.doesNotMatch(songIdeaSparks(() => 0.1).sound, /^(.+) crossed with \1$/, 'a genre is never crossed with itself');
  assert.ok(songIdeaSystem.startsWith("You are Lyric, working the songwriting desk in Kade-AI's Sound Booth."), 'the gateway keeps chat guards off this opening; keep it identical to musicWritingPrompt');
  assert.match(songIdeaSystem, /They are not material/); assert.match(songIdeaSystem, /No title, no instrument list/);
  assert.doesNotMatch(songIdeaSystem, /sump pump|falls in love with a stick/i, 'an example in the prompt comes back as the idea');
  const ask = songIdeaRequest(sparks);
  assert.ok(ask.includes('Genre: ' + sparks.sound) && ask.includes(sparks.shelf[3]) && ask.includes('- Shown 39') && !ask.includes('- Shown 9\n'));
  const good = "Miami bass: The cashier at a check-cashing place notices which customers fold their pay stubs before sliding them across and which keep them flat, and she knows who will ask for the extra twenty before they open their mouths. Never say the word broke.";
  assert.equal(cleanSongIdea('Here is one:\n\n**' + good + '**'), good);
  assert.equal(cleanSongIdea('1. ' + good), good);
  assert.equal(cleanSongIdea('A paragraph with no genre tag at all, however long it happens to run on for, is not an idea in her format.'), null);
  assert.equal(cleanSongIdea(good + '\n\nLyrics:\n[Verse 1]\nla la'), null, 'an idea is never lyrics');
  assert.equal(songIdeaTitle(good).length, 170);
  assert.equal(tooCloseToShelf(good), false);
  assert.equal(tooCloseToShelf('Swing: Someone keeps taking the long way home because the flat is empty and the dog died.'), true, 'five of her words in a row is a copy');
  assert.equal(tooCloseToShelf('Polka: A different idea entirely about a cashier who notices which customers fold their pay stubs.', [good]), true, 'so is one she was already shown');
});

test('Part 230: the desk demands rhyme and one meter, counts syllables itself, and knows her newest pet hates', async () => {
  const prompt = await musicWritingPrompt('format', { engine: 'yue2', mode: 'write' }, async () => ({ instructions: 'persona' }));
  assert.match(prompt, /SING-ALONG FIRST/); assert.match(prompt, /This desk under-rhymes/); assert.match(prompt, /THE CHORUS STATES THE HOOK\. The verses can show; the chorus TELLS/);
  assert.doesNotMatch(prompt, /say it plain/i, 'Part 293: the old heading was sung back in a real song and is on her ban list');
  const wander = 'Pop.\n\nLyrics:\n[Verse 1]\nBar is half full and the jukebox is dying tonight again\nYou by the window\nSome fella walked in and he looked you up and he looked you down\nI got a beer\n[Chorus]\nLook at her\n\nREADBACK: x';
  const audit = lyricAuditRequest(wander, [], null);
  assert.match(audit, /SING-ALONG, the gate this desk fails most/); assert.doesNotMatch(audit, /one line rhymes with nothing/);
  assert.match(audit, /\[Verse 1\] lines run \d+, \d+, \d+, \d+ syllables/);
  const even = 'Pop.\n\nLyrics:\n[Verse 1]\nI saw it lying on the ground\nThe best thing I have ever found\nYou threw the frisbee, I don\'t care\nI dropped it and I left it there\n\nREADBACK: x';
  assert.doesNotMatch(lyricAuditRequest(even, [], null), /Counted by the desk/);
  const tells = lyricTells('x\nLyrics:\n[Verse 1]\nThe heater hummin\' warm and low\nShe gave me that knowing look\nI know the way back home\n(Mm, mm)', '');
  assert.deepEqual(tells.map(t => t.tell), ['humming', '"knowing" as a mood']);
  assert.equal(musicWritingSettings({ engine: 'yue2', mode: 'write', deep: true }).maxTokens, 32000);
});

test('Part 231: a duet line that opens with a singer cue is a sung line, so a repair that relabels singers still merges', () => {
  const first = 'Duet.\n\nLyrics:\n[Verse 1]\n(Her) You go first\n(Him) No, you go first\n(Her) I saved you a seat\n(Him) You ordered the lamb\n\nREADBACK: Two singers argue.';
  const repair = 'Duet.\n\nLyrics:\n[Verse 1]\n[Her] You go first\n[Him] No, you go first\n[Her] I saved you a seat by the door\n[Him] You ordered the lamb\n\nREADBACK: Two singers argue.';
  const merged = mergeRepairedLyrics(first, repair);
  assert.ok(merged, 'four sung lines in, four sung lines out');
  assert.match(merged, /\[Her\] I saved you a seat by the door/);
  const audit = lyricAuditRequest(first, [], null);
  assert.match(audit, /do NOT count syllables yourself/); assert.match(audit, /not a nursery rhyme either/);
});

/* ---------------- Part 293 (Sep 25 2026): who the song is for, and her ChatGPT prompt ---------------- */
const DESK_OPENING = "You are Lyric, working the songwriting desk in Kade-AI's Sound Booth. Your saved persona below is who you are in conversation. The HIT-WRITING SYSTEM after it is how every song at this desk is written; where the two differ about craft, the system wins. Then come the owner's desk notes and the delivery format the audio engine needs.";

test('Part 293: the audience note sits after the desk notes and before the delivery contract; READBACK stays last', async () => {
  const read = async () => ({ instructions: 'persona' });
  const base = 'You are the script desk.\n\nAFTER the script, on a new line, output exactly:\nREADBACK: one or two plain sentences saying what a listener will hear.';
  const request = { engine: 'yue2', mode: 'write' };
  const before = await musicWritingPrompt(base, request, read);
  assert.equal(await musicWritingPrompt(base, request, read, null), before, 'the kill switch (null) is the desk exactly as it was');
  assert.equal(await musicWritingPrompt(base, request, read, undefined), before);
  assert.doesNotMatch(before, /CLEAN OR EXPLICIT/);
  assert.equal(before.split('\n')[0], DESK_OPENING, 'the gateway matches this opening line');
  for (const [audience, note, other] of [['explicit', SONG_EXPLICIT_NOTE, SONG_CLEAN_NOTE], ['clean', SONG_CLEAN_NOTE, SONG_EXPLICIT_NOTE]]) {
    const prompt = await musicWritingPrompt(base, request, read, audience);
    assert.equal(prompt.split('\n')[0], DESK_OPENING, `${audience}: the opening line never changes`);
    const at = prompt.indexOf(note);
    assert.ok(at >= prompt.indexOf(musicWritingCraft) + musicWritingCraft.length, `${audience}: after the owner's desk notes`);
    assert.ok(at < prompt.indexOf('SOUND BOOTH DELIVERY CONTRACT'), `${audience}: before the delivery contract`);
    assert.ok(prompt.lastIndexOf('READBACK: one or two plain sentences') > prompt.indexOf('SOUND BOOTH DELIVERY CONTRACT') && prompt.endsWith(base), `${audience}: the READBACK rule stays last`);
    assert.equal(prompt.split(note).length, 2, `${audience}: said once`);
    assert.ok(!prompt.includes(other), `${audience}: never both`);
    assert.equal(prompt.replace(note + '\n\n', ''), before, `${audience}: the note is the only change`);
  }
  assert.ok((await musicWritingPrompt(base, { engine: 'lyria', mode: 'write' }, read, 'clean')).includes(SONG_CLEAN_NOTE), 'Lyria drafts get it too');
  assert.equal(await musicWritingPrompt('Original format', { engine: 'yue2', mode: 'format' }, read, 'explicit'), 'Original format', 'her own words: no note');
  assert.equal(await musicWritingPrompt('Original format', { engine: 'scenema', mode: 'write' }, read, 'clean'), 'Original format', 'speech: no note');
  for (const words of ['explicit is allowed', 'funny, filthy, horny, furious, petty, dark, cruel, sarcastic or stupid on purpose', 'write fuck, shit, bitch, asshole, damn and the rest in full', 'no asterisks, no bleeps and no "f-ing"', 'Sexual jokes, dark humor, petty insults and dumb immature jokes', 'Do not sand a line down just because a cleaner word exists', 'Do not force it into a song that does not want it', 'as punctuation or as the escalation of a joke that already works', 'A lullaby, a hymn or a sweet song usually wants none', 'If the brief asks for clean, radio or kid-friendly words, write it clean', 'Never slurs, and nothing sexual involving anyone under 18'])
    assert.ok(SONG_EXPLICIT_NOTE.includes(words), words);
  for (const words of ['this song must be clean', 'No swearing, no sexual content or innuendo, no drug jokes, nothing gory', 'Keep the edge and lose the words', 'instead of bleeping or starring anything out'])
    assert.ok(SONG_CLEAN_NOTE.includes(words), words);
  assert.match(before, /\[Solo\], \[Interlude\], \[Final Chorus\], \[Outro\]/, 'the system names the two new section tags');
});

test('Part 293: her ChatGPT prompt joins the desk notes as plain rules, with no example lines to copy', () => {
  const at = musicWritingCraft.indexOf('WRITE IT LIKE A PERSON WROTE IT');
  const end = musicWritingCraft.indexOf('- Do the SONG SPEC');
  assert.ok(at > 0 && end > at, 'inside the owner notes, before the closing instruction');
  const section = musicWritingCraft.slice(at, end);
  for (const rule of ['Trust the listener', 'When a line lands, move on', 'Never explain a joke', 'one saying how sad the singer is', 'No lesson at the end', 'grief can stay grief, anger can stay anger', 'want the person they shouldn', 'Give the singer a personality', 'opinions, bad habits, pettiness, contradictions', 'do not have to be the good guy', 'Songs are not HR training videos', 'Every line earns its spot', 'could sit in 500 other songs', 'exists only for the rhyme', 'explains the line before it', 'only links two better lines', 'Plain words with a sharp observation beat fancy words', 'No thesaurus poetry', 'never turn a feeling into a person just to get a rhyme', 'take the premise seriously', 'Start with a believable version and escalate', 'callbacks and misdirection', 'set up an expectation and wreck it', 'Specific beats random', 'Never explain the punchline', 'a phrase, a question, a command, a ridiculous image, a repeated word or a punchline', 'Take the title from the hook or from the central joke', 'Punk and emo', 'hard consonants, specific grievances, not eyeliner and darkness', 'no vocabulary flexing and no generic bragging', 'only when something happens there', 'bodies and rooms', 'brutally clear in one sentence', 'Experimental may break the shape, never into nonsense'])
    assert.ok(section.includes(rule), rule);
  assert.doesNotMatch(section, /["“”]/, 'no worked example lines: the writer hands examples back');
  assert.match(musicWritingCraft, /could another good songwriter surprise me with this\? Are there a few lines somebody would quote, caption or yell with friends the next morning\?/);
  /* The conflicts, settled her way. */
  assert.match(musicWritingCraft, /At most ONE deliberately unrhymed line in the whole song\. Slant rhyme counts as rhyme\. Never twist word order or grammar to land a rhyme/);
  assert.match(musicWritingCraft, /Skip the nursery-rhyme pairs/);
  assert.match(musicWritingCraft, /about four minutes, 45 to 65 sung lines/); assert.match(musicWritingCraft, /or two long verses of twelve to sixteen lines each, with a bridge and a final chorus/);
  assert.match(musicWritingCraft, /Do not reach for the same shape every time: a pre-chorus only when it earns its place/); assert.match(musicWritingCraft, /\[Final Chorus\] and \[Solo\] are fine too/);
  assert.match(musicWritingCraft, /No more than two observed details per verse, and each one something only this song could contain/);
  assert.match(musicWritingCraft, /unless her brief names them: rain on the window, a swing and its chain, doors, windows, plates, a phone, the TV/);
  assert.doesNotMatch(musicWritingCraft, /what was on the plate|the chain that squeaks|kitchens|timestamps|unfinished drinks/, 'no prop list to copy');
  assert.match(musicWritingCraft, /chooses the lead voice, its range and its delivery for this song and this genre\. There is no house voice at this desk\./);
  assert.doesNotMatch(musicWritingCraft, /\balto\b|close to the microphone|\bbelt/i, 'the house default is never shown as something to copy');
  assert.doesNotMatch(musicWritingCraft, /Lyrics Box|Tag Box|elite professional songwriter/, 'her ChatGPT output contract stays out');
  const audit = lyricAuditRequest('Pop.\n\nLyrics:\n[Verse 1]\nOne line\n\nREADBACK: x', [], null);
  assert.match(audit, /Does the last verse do new work\?/); assert.doesNotMatch(audit, /what was on the plate|the traffic was bad/);
});

test('Part 293: the kill scan knows the rest of her ChatGPT ban list and leaves plain speech alone', () => {
  const flags = (line, brief = '') => lyricTells('x\nLyrics:\n' + line, brief).map(t => t.tell);
  const tells = [
    ["I'm breaking these chains tonight", 'a greeting-card phrase'], ['Breaking the chains she put on me', 'a greeting-card phrase'], ['This war inside my head', 'a greeting-card phrase'],
    ['Showing off my battle scars', 'a greeting-card phrase'], ["I'm a beautiful mess", 'a greeting-card phrase'], ['Perfectly imperfect, baby', 'a greeting-card phrase'],
    ['Picking up the shattered pieces', 'a greeting-card phrase'], ['This is my truth', 'a greeting-card phrase'], ['I finally found my voice', 'a greeting-card phrase'],
    ['And I chose myself', 'a greeting-card phrase'], ["I'm finally free", 'a greeting-card phrase'],
    ["Now I'm enough", 'a lesson-learned line'], ['I am enough for me', 'a lesson-learned line'], ['I survived', 'a lesson-learned line'], ['I survived it all', 'a lesson-learned line'],
    ['Yeah, I survived the storm', 'a lesson-learned line'], ['I learned to let it go', 'a lesson-learned line'], ["I've learned how to breathe", 'a lesson-learned line'],
    ['Now I know better', 'a lesson-learned line'], ['I finally found myself', 'a lesson-learned line'], ['Finding myself again (again)', 'a lesson-learned line'],
    ["And I been doing it too, I'll say it plain", "the desk's own filler"], ['He showed up right on cue', "the desk's own filler"], ["And that's the wild part", "the desk's own filler"],
    ["Now I'm sitting pretty", "the desk's own filler"], ["Sittin' pretty on a Pontiac", "the desk's own filler"],
    ['Fighting all my demons', 'a worn image word'], ['I feel hollow', 'a worn image word'], ['The house felt hollow', 'a worn image word'], ['Stars that shimmer on the lake', 'a worn image word'],
    ['Shimmering like gold', 'a worn image word'], ['Watch it all unfold', 'a worn image word'], ['The night is unfolding', 'a worn image word'], ["I don't want your validation", 'a worn image word'],
    ['Good vibrations only', 'a worn image word'], ["We're on the same frequency", 'a worn image word'], ['My heartbeat is a drum', 'a worn image word'], ['The room was electric', 'a worn image word'],
    ['Electric love', 'a worn image word'],
    ["I don't need your money, I need your time", '"I don\'t need X, I need Y"'], ["I don't need a crown, I just want the keys", '"I don\'t need X, I need Y"'],
    ["I ain't need no help, just need a ride", '"I don\'t need X, I need Y"'],
  ];
  for (const [line, tell] of tells) assert.deepEqual(flags(line), [tell], line);
  const plainSpeech = [
    'He plays electric guitar at the Legion', 'Paid the electric bill in quarters', 'The electric company cut us off', 'Doing the Electric Slide at the reunion',
    'She got the electric blanket and the good pillow', 'Down in the hollow past the church', 'I would do it again in a heartbeat', 'Unfold the lawn chair, sit a spell',
    'She unfolded the map on the hood', 'I found myself at the Waffle House at noon', "I'm enough of a fool to call", 'I survived three kids and a Buick',
    "I don't need a medal, I don't need a prize", 'Chained the dog out by the shed', 'Sitting in the truck bed', 'He learned the hard way', 'Now they know',
  ];
  for (const line of plainSpeech) assert.deepEqual(flags(line), [], line);
  assert.deepEqual(flags('The room was electric', 'an electric blues song'), [], 'a word from her brief is hers');
  assert.deepEqual(flags('Fighting all my demons', 'a metal song about demons'), []);
  assert.deepEqual(lyricTells('Neo-soul with electric piano, shimmering cymbals and a heartbeat kick.\nLyrics:\n[Verse 1]\nI paid the rent in quarters'), [], 'the style paragraph is never scanned');
});

async function loadIdeaModule() {
  const strip = file => stripTypeScriptTypes(readFileSync(new URL('../music/' + file, import.meta.url), 'utf8'));
  const shelfSource = strip('ideaShelf.ts').replace('export const ideaShelf', 'const ideaShelf');
  const ideaSource = shelfSource + '\n' + strip('idea.ts').replace("import { ideaShelf } from './ideaShelf';", '') + '\nexport { ideaShelf };';
  return import('data:text/javascript;base64,' + Buffer.from(ideaSource).toString('base64'));
}

test('Part 293: Surprise me keeps every pitch clean for a clean audience and is unchanged for a grown-up', async () => {
  const idea = await loadIdeaModule();
  const { songIdeaSystem, songIdeaSystemFor, SONG_IDEA_CLEAN_NOTE } = idea;
  for (const audience of ['explicit', null, undefined]) assert.equal(songIdeaSystemFor(audience), songIdeaSystem, String(audience));
  const clean = songIdeaSystemFor('clean');
  assert.ok(clean.startsWith(songIdeaSystem) && clean.endsWith(SONG_IDEA_CLEAN_NOTE));
  assert.ok(clean.startsWith("You are Lyric, working the songwriting desk in Kade-AI's Sound Booth."), 'the gateway still knows the desk');
  assert.equal(SONG_IDEA_CLEAN_NOTE.match(/[.!?](?=\s|$)/g).length, 1, 'one sentence');
  assert.match(SONG_IDEA_CLEAN_NOTE, /clean/);

  /* The real /idea route asks who is asking and sends the matching system. */
  const url = new URL('../../../../api/server/routes/kadeSoundBooth.js', import.meta.url);
  const handlers = new Map(), requests = [];
  const router = Object.fromEntries(['post', 'get', 'put', 'delete', 'patch', 'use'].map(method => [method, (path, ...values) => handlers.set(method + path, values.at(-1))]));
  const multer = Object.assign(() => ({ single: () => () => {} }), { memoryStorage: () => ({}) });
  const pitch = 'Country comedy: A man keeps a running feud with the self-checkout at the only grocery in town, and by the third verse the whole store is taking sides over one bag of onions.';
  const context = { module: { exports: {} }, Buffer, URL, console, Date, Intl, process: { env: { REFRAME_PROXY_SECRET: 'fixture' } }, require(name) {
    if (name === 'express') return { Router: () => router, json: () => () => {} };
    if (name === 'multer') return multer;
    if (name === 'axios') return { post: async (_url, body) => { requests.push(body); return { data: { choices: [{ message: { content: pitch } }], usage: { cost: 0.001 } } }; } };
    if (name === '@librechat/api') return { ...idea, writingCost, musicWritingPrompt, musicWritingSettings, lyricTells, lyricRepairRequest, mergeRepairedLyrics, lyricShapeIssue, labelReadback, lyricAuditRequest, fixStageDirections, lyricWritingModel, lyricAgentId, createYueRouter: () => () => {}, createEffectsRouter: () => () => {}, createLyricsRouter: () => () => {}, effectsGuide: {}, ...bootStubs };
    if (name === '@librechat/data-schemas') return { logger: { info() {}, warn() {}, error() {} } };
    if (name === '~/models/kadeUsage') return { logKadeUsage: async () => {}, KadeUsage: { find: () => ({ sort: () => ({ limit: () => ({ select: () => ({ lean: async () => [] }) }) }) }) } };
    if (name === '~/server/utils/kadeSongAudience') return songAudienceStub;
    if (name === './kadeSoundBoothSplit' || name === './kadeSoundBoothScreenplay') return createRequire(url)(name);
    return {};
  } };
  vm.runInNewContext(readFileSync(url, 'utf8'), context);
  let result; const response = { status() { return this; }, json(value) { result = value; return this; } };
  audienceStub.calls.length = 0;
  for (const [answer, user] of [['clean', 'idea-child'], ['explicit', 'idea-adult']]) {
    audienceStub.answer = answer;
    await handlers.get('post/idea')({ user: { id: user }, body: {} }, response);
    assert.equal(result.idea, pitch);
    assert.equal(requests.at(-1).messages[0].content, songIdeaSystemFor(answer), answer);
  }
  assert.deepEqual(audienceStub.calls.map(c => c.user.id), ['idea-child', 'idea-adult']);
  audienceStub.answer = 'explicit';
});
