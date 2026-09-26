import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes, createRequire } from 'node:module';
import vm from 'node:vm';
const source = stripTypeScriptTypes(readFileSync(new URL('./writing.ts', import.meta.url), 'utf8'));
const hitSource = stripTypeScriptTypes(readFileSync(new URL('../music/hitSystem.ts', import.meta.url), 'utf8')).replace('export const hitWritingSystem', 'const hitWritingSystem');
const musicSource = hitSource + '\n' + stripTypeScriptTypes(readFileSync(new URL('../music/writing.ts', import.meta.url), 'utf8')).replace("import { hitWritingSystem } from './hitSystem';", '');
const { musicWritingPrompt, musicWritingSettings, lyricWritingModel, lyricAgentId, lyricTells, lyricRepairRequest, mergeRepairedLyrics, lyricShapeIssue, labelReadback, lyricAuditRequest, fixStageDirections, musicWritingCraft, SONG_EXPLICIT_NOTE, SONG_CLEAN_NOTE, lyricEndingTells, lyricEndingLines, songSectionMap, sectionMapNote, sectionMapPool, SECTION_MAPS, ENDING_TELL } = await import('data:text/javascript;base64,' + Buffer.from(musicSource).toString('base64'));
const { writingCost } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
/* What the Sound Booth route needs from @librechat/api to load at all (its GUIDE reads the YuE
 * styles when the file loads), and a stand-in for the Part 293 audience helper whose answer a
 * test can set. */
const bootStubs = { yueStylesEnabled: () => false, yueStyles: {} };
const audienceStub = { answer: 'explicit', calls: [] };
/* The real word checks (Part 293 review: the route holds a clean song to clean with them); only
 * the account lookup is stood in for. */
const audienceModule = createRequire(import.meta.url)('../../../../api/server/utils/kadeSongAudience.js');
const songAudienceStub = { ...audienceModule, songAudience: async (user, options) => { audienceStub.calls.push({ user, options }); return audienceStub.answer; } };

test('music drafting reads the current Lyric persona while formatting and speech stay untouched', async () => {
  const reads = [];
  let instructions = 'First saved persona: protect meaning and use internal rhyme.';
  const read = async filter => { reads.push(filter); return { instructions }; };
  const first = await musicWritingPrompt('Sound Booth format', { engine: 'yue2', mode: 'write' }, read);
  assert.ok(first.includes(instructions));
  assert.match(first, /Multisyllabic and mosaic rhymes/); assert.match(first, /Keep supplied lyrics exactly/);
  assert.match(first, /SYNTHETIC-VOCAL HIT-WRITING SYSTEM/); assert.match(first, /THE FOURTEEN TELLS/); assert.match(first, /about four minutes, 45 to 65 sung lines/); assert.match(first, /laid out on the section map the desk sends with the request/); assert.doesNotMatch(first, /\[Final Chorus\]|either three verses|two long verses/, 'Part 293 follow-up: no list of shapes in the prompt, and no [Final Chorus] unless the drawn map names it');
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
    if (name === './kadeSoundBoothSplit' || name === './kadeSoundBoothScreenplay' || name === './kadeSoundBoothPaste' || name === './kadeSoundBoothCarry') return localRequire(name);
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
    if (name === './kadeSoundBoothSplit' || name === './kadeSoundBoothScreenplay' || name === './kadeSoundBoothPaste' || name === './kadeSoundBoothCarry') return localRequire(name);
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
    if (name === './kadeSoundBoothSplit' || name === './kadeSoundBoothScreenplay' || name === './kadeSoundBoothPaste' || name === './kadeSoundBoothCarry') return localRequire(name);
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
  assert.equal(lyricShapeIssue(long(16, 14), 'a pop song about luck'), null, 'twelve to sixteen each');
  /* Part 293 review: EACH of the two verses must be long; a lopsided song is sent back to grow. */
  for (const [a, b] of [[16, 8], [20, 4], [8, 16]])
    assert.match(lyricShapeIssue(long(a, b), 'a pop song about luck'), /only two verses, one of them short, and this desk writes three verses.*Add a \[Verse 3\]/, `${a} and ${b}`);
  assert.match(lyricShapeIssue(long(12, 11), 'a pop song about luck'), /only two verses, one of them short/);
  assert.match(lyricShapeIssue(long(12, 11).replace('[Verse 2]\n', '[Verse 2]\n(oh)\n(oh, oh)\n'), 'luck'), /only two verses, one of them short/, 'whole-line ad-libs are not verse lines');
  assert.match(lyricShapeIssue(long(8, 8), 'luck'), /only two short verses/);
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
  assert.equal(musicWritingSettings({ engine: 'yue2', mode: 'write', deep: true }).maxTokens, 48000);
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
  assert.equal(await musicWritingPrompt(base, request, read, null), before, 'null (a grown-up under the kill switch) sends no note');
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
  assert.match(before, /\[Solo\], \[Interlude\], \[Outro\]/, 'the system names [Solo]');
  assert.doesNotMatch(before, /Final Chorus\]/, 'Part 293 follow-up: [Final Chorus] comes only with the drawn map that has one');
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
  assert.match(musicWritingCraft, /about four minutes, 45 to 65 sung lines/); assert.match(musicWritingCraft, /The desk draws a SECTION MAP for each song and sends it with the request, under the idea\. Use that map unless the idea clearly wants another; if the brief gives its own length or structure, the brief wins and no map is sent\./);
  assert.doesNotMatch(musicWritingCraft, /Final Chorus|two long verses|three verses/, 'Part 293 follow-up: the shapes live in the drawn map, not in a list');
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
  /* Part 293 review: her own register, which the first narrowing still hit. */
  const herRegister = [
    'Down in Possum Hollow where the creek runs', 'Down at Possum Hollow', 'We camped down in a hollow by the creek', 'Found a hollow, set the trap',
    "The electric's out again", "The electric's due on the fifth", 'They shut off the electric again', 'We fixed the electric pump out back',
    'Electric blue on her fingernails', 'Both electric companies came out', 'Parked the electric carts in a row',
    "I learned to drive in Daddy's Ford", 'I learned to fish before I learned to read', "I'm enough trouble for the both of us", "I'm enough like him", "I'm enough trouble for you",
    'Tuned to the police frequency', 'The scanner frequency, channel nine', 'Some nights I find myself',
  ];
  for (const line of herRegister) assert.deepEqual(flags(line), [], line);
  const stillFlagged = [
    ['I got a hollow heart', 'a worn image word'], ['Hollow, that is all I am', 'a worn image word'], ['It rings so hollow', 'a worn image word'],
    ['The electric feeling in the air', 'a worn image word'], ["We're on the same frequency", 'a worn image word'],
    ['And I learned to fly', 'a lesson-learned line'], ['Somewhere back there I learned to', 'a lesson-learned line'], ['I learned to love myself', 'a lesson-learned line'],
    ["I'm enough just as I am", 'a lesson-learned line'], ["Baby, I'm still enough", 'a lesson-learned line'],
    ['I need to find myself', 'a lesson-learned line'], ["I'll find myself again", 'a lesson-learned line'],
  ];
  for (const [line, tell] of stillFlagged) assert.deepEqual(flags(line), [tell], line);
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
    if (name === './kadeSoundBoothSplit' || name === './kadeSoundBoothScreenplay' || name === './kadeSoundBoothPaste' || name === './kadeSoundBoothCarry') return createRequire(url)(name);
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

/* ---------------- Part 293 review fixes ---------------- */
/** The real Sound Booth route in a sandbox. `reply(body, n)` answers the nth model call; every
 *  router registration is kept in order, so a test can see what runs before what. */
function loadBooth({ reply, api = {}, middleware, jev } = {}) {
  const url = new URL('../../../../api/server/routes/kadeSoundBooth.js', import.meta.url), localRequire = createRequire(url);
  const handlers = new Map(), requests = [], ledger = [], registered = [];
  const router = Object.fromEntries(['post', 'get', 'put', 'delete', 'patch', 'use'].map(method => [method, (path, ...values) => { registered.push([method, path, ...values]); handlers.set(method + path, values.at(-1)); }]));
  const multer = Object.assign(() => ({ single: () => () => {} }), { memoryStorage: () => ({}) });
  const context = { module: { exports: {} }, Buffer, URL, console, Date, Intl, process: { env: { REFRAME_PROXY_SECRET: 'fixture' } }, require(name) {
    if (name === 'express') return { Router: () => router, json: () => (_req, _res, next) => next && next() };
    if (name === 'multer') return multer;
    if (name === 'crypto') return { randomBytes: () => ({ toString: () => 'job-fixture' }) };
    if (name === 'axios') return { post: async (_url, body) => { requests.push(body); return { data: { choices: [{ message: { content: reply(body, requests.length) } }], usage: { cost: 0.01 } } }; } };
    if (name === '@librechat/api') return { writingCost, musicWritingPrompt, musicWritingSettings, lyricTells, lyricRepairRequest, mergeRepairedLyrics, lyricShapeIssue, labelReadback, lyricAuditRequest, fixStageDirections, lyricWritingModel, lyricAgentId, createYueRouter: () => 'the YuE2 router', createEffectsRouter: () => 'the effects router', createLyricsRouter: () => 'the lyrics router', effectsGuide: {}, ...bootStubs, ...api };
    if (name === '@librechat/data-schemas') return { logger: { info() {}, warn() {}, error() {} } };
    if (name === '~/models') return { getAgent: async () => ({ instructions: 'Saved Lyric persona.' }) };
    if (name === '~/models/kadeUsage') return { logKadeUsage: async row => ledger.push(row), KadeUsage: { find: () => ({ sort: () => ({ limit: () => ({ select: () => ({ lean: async () => [] }) }) }) }) } };
    if (name === '~/server/utils/kadeSongAudience') return songAudienceStub;
    if (name === '~/server/middleware' && middleware) return middleware;
    if (name === '~/server/services/kadeJevJudges' && jev) return jev;
    if (name === './kadeSoundBoothSplit' || name === './kadeSoundBoothScreenplay' || name === './kadeSoundBoothPaste' || name === './kadeSoundBoothCarry') return localRequire(name);
    return {};
  } };
  vm.runInNewContext(readFileSync(url, 'utf8'), context);
  const call = async (path, req) => {
    const out = { code: 200, body: null };
    await handlers.get(path)(req, { status(code) { out.code = code; return this; }, json(value) { out.body = value; return this; } });
    return out;
  };
  return { handlers, requests, ledger, registered, call, internals: context.module.exports._internals };
}

test('Part 293 review: a clean song is held to clean in code, and a grown-up\'s song is left alone', async () => {
  const draft = 'Punk with fast drums.\nLyrics:\n[Verse 1]\nThis rent is batshit crazy\nThe sink has broken twice\n[Chorus]\nPay up, pay up\nREADBACK: A punk song about a landlord.';
  const fixed = draft.replace('This rent is batshit crazy', 'This rent is out of line, man');
  const body = { engine: 'yue2', mode: 'write', text: 'a punk song about my landlord' };
  let booth = loadBooth({ reply: (_b, n) => (n === 1 ? draft : fixed) });
  audienceStub.answer = 'clean';
  let out = await booth.call('post/script', { user: { id: 'clean-1' }, body });
  assert.equal(out.code, 200);
  assert.equal(booth.requests.length, 2, 'one draft, one audit');
  assert.match(booth.requests[1].messages[1].content, /"This rent is batshit crazy" -- a swear word or a sexual word, and this song has to be clean/);
  assert.doesNotMatch(out.body.script, /batshit/); assert.match(out.body.script, /out of line, man/);
  assert.ok(out.body.repairs.includes('made 1 line clean'), out.body.repairs.join(' | '));

  booth = loadBooth({ reply: () => draft });
  out = await booth.call('post/script', { user: { id: 'clean-2' }, body });
  assert.equal(out.code, 422, 'the audit kept the swear, so the draft is refused');
  assert.match(out.body.error, /has to be clean/); assert.match(out.body.error, /Your idea is kept/);
  assert.equal(booth.ledger.length, 1); assert.equal(booth.ledger[0].metadata.refused, 'explicit words in a clean song'); assert.equal(booth.ledger[0].costUSD, 0.02, 'what it cost is still on the ledger');

  booth = loadBooth({ reply: () => draft });
  out = await booth.call('post/script', { user: { id: 'clean-3' }, body: { ...body, lyrics: 'My own batshit words' } });
  assert.equal(out.code, 200, 'her own supplied lyrics are hers and are never checked');

  audienceStub.answer = 'explicit';
  booth = loadBooth({ reply: () => draft });
  out = await booth.call('post/script', { user: { id: 'adult-1' }, body });
  assert.equal(out.code, 200);
  assert.doesNotMatch(booth.requests[1].messages[1].content, /has to be clean/, 'a grown-up\'s swearing is not a tell');
  assert.match(out.body.script, /batshit/);
  audienceStub.answer = null;
  booth = loadBooth({ reply: () => draft });
  assert.equal((await booth.call('post/script', { user: { id: 'adult-2' }, body })).code, 200, 'the kill switch only withdraws the permission');
  audienceStub.answer = 'explicit';
});

test('Part 293 review: two short verses grown into two long ones say "lengthened the verses", not "added a third verse"', async () => {
  const lines = (tag, n) => `[${tag}]\n` + Array.from({ length: n }, (_, i) => `${tag.toLowerCase()} row ${i + 1} goes here`).join('\n');
  const song = (...verses) => `Pop.\nLyrics:\n${verses.map((n, i) => lines(`Verse ${i + 1}`, n) + '\n' + lines('Chorus', i < 2 ? 4 : 0)).join('\n').replace(/\n\[Chorus\]\n?$/, '')}\nREADBACK: A pop song.`;
  const draft = song(8, 8);
  assert.match(lyricShapeIssue(draft, 'a pop song about luck'), /two short verses/);
  for (const [grown, label] of [[song(12, 12), 'lengthened the verses'], [song(8, 8, 8), 'added a third verse']]) {
    const booth = loadBooth({ reply: (_b, n) => (n === 1 ? draft : grown) });
    const out = await booth.call('post/script', { user: { id: 'shape-' + label }, body: { engine: 'yue2', mode: 'write', text: 'a pop song about luck' } });
    assert.equal(out.code, 200);
    assert.ok(out.body.repairs.includes(label), `${label}: ${out.body.repairs.join(' | ')}`);
    assert.equal(out.body.repairs.filter(r => /verse/.test(r)).length, 1);
  }
  assert.equal(loadBooth({ reply: () => '' }).internals.verseCount(song(8, 8, 8)), 3);
});

test('Part 293 review: the Kids style never renders explicit lyrics, checked on the server before the YuE2 router', async () => {
  let authed = 0;
  const booth = loadBooth({ reply: () => '', middleware: { requireJwtAuth: (_req, _res, next) => { authed += 1; next(); } } });
  const { kidsStyleRefusal } = booth.internals;
  const yueAt = booth.registered.findIndex(([method, path]) => method === 'use' && path === 'the YuE2 router');
  /* The pasted-song sorter also sits on POST /render ahead of it (it has to: a pasted Lyrics Box
   * must be in the body before the words are checked), so the gate is the last one before YuE2. */
  const gateAt = booth.registered.reduce((at, [method, path], i) => (method === 'post' && path === '/render' && i < yueAt ? i : at), -1);
  assert.ok(gateAt >= 0 && yueAt > gateAt, 'the check runs before the YuE2 router can queue anything');
  const gate = booth.registered[gateAt].at(-1);
  const run = async (body) => {
    const out = { code: 0, body: null, next: false };
    await gate({ body }, { status(code) { out.code = code; return this; }, json(value) { out.body = value; return this; } }, () => { out.next = true; });
    return out;
  };
  const refused = await run({ engine: 'yue2', band: 'kids', lyrics: '[Verse 1]\nThis shit is cold', script: 'A choir.' });
  assert.equal(refused.code, 400); assert.equal(authed, 1, 'only a signed-in person is answered');
  assert.match(refused.body.error, /Kids style/); assert.match(refused.body.error, /have to be clean/); assert.match(refused.body.error, /set Style to None or another style/);
  for (const body of [
    { engine: 'yue2', band: 'kids', lyrics: 'Clap your hands and stomp your feet' },
    { engine: 'yue2', band: 'soul', lyrics: 'This shit is cold' },
    { engine: 'yue2', lyrics: 'This shit is cold' },
    { engine: 'lyria', band: 'kids', lyrics: 'This shit is cold' },
    {},
  ]) assert.equal((await run(body)).next, true, JSON.stringify(body));
  assert.ok(kidsStyleRefusal({ engine: 'yue2', band: 'kids_choir', lyrics: 'f*** this' }));
  assert.equal(kidsStyleRefusal(undefined), null);
});

test('Part 293 review: the writing lane\'s music grammar describes the voice, the map and the length without demonstrating one', () => {
  const { MUSIC_GRAMMAR, MUSIC_GRAMMAR_WRITE, systemPrompt } = loadBooth({ reply: () => '' }).internals;
  const differing = MUSIC_GRAMMAR.split('\n').filter((line, i) => MUSIC_GRAMMAR_WRITE.split('\n')[i] !== line);
  assert.equal(differing.length, 3, 'exactly the three steps are replaced');
  assert.deepEqual(differing.map(l => l.slice(0, 2)), ['3.', '4.', '6.']);
  for (const engine of ['yue2', 'lyria']) {
    const write = systemPrompt({ engine, mode: 'write' });
    assert.ok(write.includes(MUSIC_GRAMMAR_WRITE), engine);
    assert.doesNotMatch(write, /warm alto|close to the microphone|belting|raspy|two-minute song|\[Intro\] -> \[Verse 1\]|piano alone/, `${engine}: no house voice, map or length`);
    assert.match(write, /4\. VOCAL PROFILE if anyone sings: sex, timbre, range and delivery, chosen for this genre and this singer\./);
    assert.match(write, /3\. STRUCTURE as the section tags this song uses/); assert.match(write, /6\. THE TECHNICAL LINE last: BPM as a number, the key, and the length in plain words/);
    const steps = ['1. GENRE WITH ERA', '2. INSTRUMENTS', '3. STRUCTURE', '4. VOCAL PROFILE', '5. MOOD', '6. THE TECHNICAL LINE'].map(s => write.indexOf(s));
    assert.ok(steps.every((at, i) => at > 0 && (i === 0 || at > steps[i - 1])), `${engine}: all six steps, in order`);
    assert.ok(systemPrompt({ engine, mode: 'format' }).includes(MUSIC_GRAMMAR), `${engine}: formatting her words keeps the grammar as it was`);
  }
});

test('Part 293 review: Surprise me for a clean audience never draws a dirty shelf idea or genre, and refuses a dirty pitch', async () => {
  const idea = await loadIdeaModule();
  const isClean = (t) => !audienceModule.hasExplicitWords(t);
  const dirtyShelf = idea.ideaShelf.filter((t) => !isClean(t));
  assert.equal(dirtyShelf.length, 2, 'two of her hundred');
  let n = 7; const rolling = () => ((n = (n * 9301 + 49297) % 233280) / 233280);
  let sawDirty = 0;
  for (let i = 0; i < 400; i++) {
    const open = idea.songIdeaSparks(rolling);
    if (open.shelf.some((t) => dirtyShelf.includes(t))) sawDirty += 1;
    const sparks = idea.songIdeaSparks(rolling, ['A dirty blues about a damn mule', 'A clean one'], isClean);
    assert.equal(sparks.shelf.length, 6);
    assert.ok(sparks.shelf.every(isClean), sparks.shelf.join(' | '));
    assert.doesNotMatch(sparks.sound, /dirty/);
    assert.deepEqual(sparks.avoid, ['A clean one']);
  }
  assert.ok(sawDirty > 0, 'a grown-up\'s draw is unchanged');

  const pitches = ['Blues shuffle: A mule that will not pull the plow gets cussed at all day, damn this and damn that, until the farmer\'s wife takes the reins and it works like a champion.','Country comedy: A man keeps a running feud with the self-checkout at the only grocery in town, and by the third verse the whole store is taking sides over one bag of onions.'];
  const drawn = [];
  const booth = loadBooth({ reply: (_b, count) => pitches[(count - 1) % 2], api: { ...idea, songIdeaSparks: (random, seen, check) => { drawn.push(check); return idea.songIdeaSparks(random, seen, check); } } });
  audienceStub.answer = 'clean';
  let out = await booth.call('post/idea', { user: { id: 'idea-clean' }, body: { band: 'kids' } });
  assert.equal(out.body.idea, pitches[1], 'the dirty pitch was refused and the loop drew again');
  assert.equal(booth.requests.length, 2); assert.equal(typeof drawn[0], 'function');
  assert.equal(audienceStub.calls.at(-1).options.band, 'kids', 'the Style reaches the audience check');
  audienceStub.answer = 'explicit';
  out = await booth.call('post/idea', { user: { id: 'idea-adult-2' }, body: {} });
  assert.equal(out.body.idea, pitches[0], 'a grown-up gets the pitch as written'); assert.equal(drawn.at(-1), undefined);
});

test('Part 293 review: the website sends the Style with Surprise me', () => {
  const page = readFileSync(new URL('../../../../api/server/routes/kadeSoundBoothPage.js', import.meta.url), 'utf8');
  assert.match(page, /post\('\/api\/kade\/sound-booth\/idea',\{band:engine==='yue2'\?state\.values\.band:undefined\}\)/);
});

/* Part 293 follow-up (Sep 25 2026): the before/after test found a house shape ([Final Chorus] in
 * 10 of 10 songs), tidy moral endings that lost four briefs, and two deep drafts that spent the
 * whole 32,000-token budget thinking. Guards in code, not more prompt. */
const EVAL_BRIEFS = ['crunk club song about my ex showing up at the club in my hoodie', 'pop punk song about getting fired from Taco Bell on my birthday', "country song about my mom's cat who hates everybody but the mailman", "sad slow R&B song about cleaning out my grandpa's truck after he died", 'rap song roasting my little brother for losing every game of Uno', "lullaby for a baby goat who won't go to sleep", 'emo song about a vending machine that stole my last dollar', '90s girl group song telling a guy to lose my number', "petty country song about my neighbor's leaf blower", 'gospel choir song thanking the air conditioner in August'];

test('Part 293 follow-up: the desk draws one real section map per request, and only a dance style can draw the drop', () => {
  const brief = EVAL_BRIEFS[2];
  assert.equal(songSectionMap(brief, 'kade\n1758000000000').id, songSectionMap(brief, 'kade\n1758000000000').id, 'the same request draws the same map');
  const counts = {};
  for (let i = 0; i < 1000; i++) { const id = songSectionMap(brief, `kade\n${1758000000000 + i * 977}`).id; counts[id] = (counts[id] || 0) + 1; }
  assert.deepEqual(Object.keys(counts).sort(), ['hookFirst', 'prePost', 'storyRefrain', 'threeVerses', 'twoLong'], 'asking again can draw every map in the hat');
  assert.ok(Math.max(...Object.values(counts)) < 300, `no house shape: ${JSON.stringify(counts)}`);
  assert.ok(new Set(EVAL_BRIEFS.map(b => songSectionMap(b).id)).size >= 3, 'different ideas draw different maps');
  for (const b of [EVAL_BRIEFS[0], 'deep house track about a lost earring', 'EDM banger about a parking ticket', 'a disco song about my roller skates']) {
    const pool = sectionMapPool(b).map(m => m.id);
    assert.ok(pool.includes('dance'), b);
    assert.ok(!pool.some(id => ['storyRefrain', 'threeVerses', 'twoLong'].includes(id)), `${b}: a dance song draws a dance-floor map`);
  }
  for (const b of ["a song about my grandma's house", 'a song about the book club', EVAL_BRIEFS[5], 'a song about my first school dance', EVAL_BRIEFS[3]])
    assert.ok(!sectionMapPool(b).some(m => m.id === 'dance'), `${b}: no drop outside a dance style`);
  for (const b of [EVAL_BRIEFS[7], EVAL_BRIEFS[1]]) assert.ok(!sectionMapPool(b).some(m => m.id === 'storyRefrain'), `${b}: pop keeps a real chorus`);
  for (const b of ['a two verse song about luck', 'a short jingle for my bakery', 'a song about luck, about three minutes long', 'a song with no chorus about luck', 'a song about luck with a refrain', 'a 16 bars rap about luck', ''])
    assert.equal(songSectionMap(b, 'kade\n1'), null, `${b}: her own structure wins, no map`);
  assert.equal(sectionMapNote(null), '');
  for (const map of Object.values(SECTION_MAPS)) {
    const note = sectionMapNote(map);
    assert.ok(note.startsWith(`SECTION MAP, drawn by the desk for this song: ${map.name}. ${map.plan}`), map.id);
    assert.match(note, /Use this map unless the idea clearly wants another\. Write the STRUCTURE line of the music direction from it\.$/);
    assert.equal(/\[Final Chorus\]/.test(note), map.id === 'twoLong', `${map.id}: [Final Chorus] only in the map that has one`);
    assert.doesNotMatch(note, /["“”]/, `${map.id}: names a shape, never demonstrates a line`);
    for (const tag of note.match(/\[[^\]]+\]/g)) assert.match(tag, /^\[(?:Intro|Verse [1-4]|Pre-Chorus|Chorus|Post-Chorus|Bridge|Breakdown|Drop|Final Chorus|Outro)\]$/, `${map.id}: ${tag} is a standard tag`);
  }
});

test('Part 293 follow-up: the length check holds a song to the map that was drawn', () => {
  const rows = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} line ${i + 1} goes here`).join('\n');
  const song = (...verses) => `Pop.\nLyrics:\n${verses.map((n, i) => `[Verse ${i + 1}]\n${rows(n, 'v' + (i + 1))}\n[Chorus]\nhook here`).join('\n')}\n\nREADBACK: x`;
  const M = SECTION_MAPS, brief = 'a song about luck';
  for (const map of Object.values(M)) assert.equal(lyricShapeIssue(song(8, 8, 8), brief, map), null, `${map.id}: three verses pass (the writer may take another shape)`);
  for (const id of ['prePost', 'dance']) assert.equal(lyricShapeIssue(song(8, 9), brief, M[id]), null, `${id}: two verses of eight are the map`);
  assert.equal(lyricShapeIssue(song(12, 14), brief, M.twoLong), null, 'twoLong: two verses of twelve are the map');
  for (const id of ['threeVerses', 'hookFirst', 'storyRefrain']) {
    const ask = lyricShapeIssue(song(12, 12), brief, M[id]);
    assert.ok(ask.startsWith(`The song has only two verses, and the map for this song is ${M[id].name}. Add a [Verse 3] of eight to twelve sung lines in the same voice, ${M[id].addVerse}.`), `${id}: ${ask}`);
  }
  assert.match(lyricShapeIssue(song(16, 8), brief, M.twoLong), /is two long verses, a bridge and a final chorus, and each verse needs at least 12 sung lines: \[Verse 2\] has 8\. Lengthen each short verse to 12 lines or more/);
  assert.match(lyricShapeIssue(song(8, 8), brief, M.twoLong), /\[Verse 1\] has 8 and \[Verse 2\] has 8\./);
  assert.match(lyricShapeIssue(song(6, 10), brief, M.prePost), /at least 8 sung lines: \[Verse 1\] has 6\. Lengthen/);
  assert.match(lyricShapeIssue(song(20), brief, M.twoLong), /only one verse, and the map for this song is two long verses.*Add a \[Verse 2\] of 12 to 16 sung lines in the same voice, before the bridge\./);
  assert.match(lyricShapeIssue(song(10), brief, M.dance), /Add a \[Verse 2\] of eight to twelve sung lines in the same voice, with its pre-chorus, before the breakdown\./);
  for (const map of Object.values(M)) {
    assert.equal(lyricShapeIssue(song(8), 'a two verse song about luck', map), null, `${map.id}: her own structure beats any map`);
    assert.doesNotMatch(lyricShapeIssue(song(8), brief, map), /this desk writes three verses, or two long ones/, `${map.id}: never the old two-map list`);
  }
  assert.match(lyricShapeIssue(song(8, 8), brief), /only two short verses and this desk writes three verses/, 'no map drawn: the check it was');
  assert.match(lyricShapeIssue(song(8, 8), brief, null), /only two short verses/);
});

test('Part 293 follow-up: a tidy ending is flagged only where the song lands, and plain speech is left alone', () => {
  const song = (verse, end) => `Folk.\nLyrics:\n[Verse 1]\n${verse.join('\n')}\n[Chorus]\nGoat on the fence and goat on the stair\n[Outro]\n${end.join('\n')}\n\nREADBACK: A folk song.`;
  const verse = ['I carried the bottle out to the pen', 'She kicked it right over and did it again'];
  for (const ending of ["Turns out that I'm the lucky one", "It's the best present anyway", 'You were right after all', 'In the end, it was just a truck', "And that's okay", 'Guess it turned out fine', "That's all that matters", "I wouldn't change a thing", 'You had my number all along', "We're the lucky ones tonight", 'The best gift of all'])
    assert.deepEqual(lyricEndingTells(song(verse, ['I sat down on the step', ending]), 'a lullaby for a goat'), [{ line: ending, tell: ENDING_TELL }], ending);
  const early = ["Turns out that I'm the lucky one", "It's the best present anyway", 'You were right after all', 'In the end, it was just a truck', "And that's okay"];
  assert.deepEqual(lyricEndingTells(song([...early, 'one more', 'two more', 'three more'], ['Put the bucket by the gate', 'Shut the barn and walked away']), ''), [], 'the same words earlier in the song are speech');
  /* Measured: the goat and hoodie songs closed their payoff verse on the lesson, just before the
   * bridge and the last chorus. The last verse's closing couplet is scanned; verse one's is not. */
  const payoff = (v1, v3) => `Folk.\nLyrics:\n[Verse 1]\nI carried the bottle out to the pen\n${v1}\n[Chorus]\nGo to sleep, little goat\n[Verse 2]\nShe kicked it right over\nand did it again\n[Verse 3]\nNow you're snoring on my arm\n${v3}\n[Bridge]\nOne more round of the song\n[Chorus]\nGo to sleep, little goat\n(I'm right here)\nGo to sleep\n\nREADBACK: x`;
  assert.deepEqual(lyricEndingTells(payoff('Took a while, but you got warm', "Turns out that I'm the lucky one"), '').map(t => t.line), ["Turns out that I'm the lucky one"], 'the last verse lands on the lesson');
  assert.deepEqual(lyricEndingTells(payoff("Turns out that I'm the lucky one", 'Took a while, but you got warm'), ''), [], "verse one's couplet is story, not an ending");
  /* Re-run: the turnaround moved into the one line the last chorus changes. */
  const fired = (last, outro = ['Fired on my birthday', 'Happy birthday to me', 'Fired on my birthday', 'Happy birthday to me']) => `Punk.\nLyrics:\n[Chorus]\nI got fired on my birthday\nWorst job that I ever had\n[Verse 1]\nThey pulled me off the fryer\nfor a talk\n[Chorus]\nI got fired on my birthday\n${last}\n[Outro]\n${outro.join('\n')}\n\nREADBACK: x`;
  assert.deepEqual(lyricEndingTells(fired('Worst job turned out the best day I had'), '').map(t => t.line), ['Worst job turned out the best day I had'], 'the changed line of the last chorus');
  assert.deepEqual(lyricEndingTells(fired('Worst job that I ever had'), ''), [], 'an unchanged chorus line is the hook, not an ending');
  assert.ok(lyricEndingLines(fired('Worst manager I ever had')).includes('Worst manager I ever had'), 'the ENDING gate quotes the changed line even with no giveaway phrase');
  assert.deepEqual(lyricEndingTells(fired('Worst job that I ever had', ['Fired on my birthday', 'I got a free lunch, and I\'m glad']), '').map(t => t.line), ["I got a free lunch, and I'm glad"]);
  for (const plainEnd of ["And I'm glad you came tonight", 'Mama turned out the lights', 'The cows turned out to pasture'])
    assert.deepEqual(lyricEndingTells(fired('Worst job that I ever had', ['Fired on my birthday', plainEnd]), ''), [], plainEnd);
  for (const plainEnd of ['Mama turns out the lights at nine', 'The whole town turned out for the fair', 'Turn out your pockets, boy', 'After all the chairs were stacked', 'We parked in the end spot by the dumpster', 'Best thing on the menu is the fries', "She kept the hoodie, and I'm still her man", 'Yeah, turns out the cows got out'])
    assert.deepEqual(lyricEndingTells(song(verse, ['I sat down on the step', plainEnd]), ''), [], plainEnd);
  assert.deepEqual(lyricEndingTells(song(verse, ['Pour one out', "I'm the lucky one"]), 'a country song called The Lucky One'), [], 'her own words are hers');
  const draft = song(["Turns out that I'm the lucky one", 'She kicked it right over', 'and did it again'], ['I sat down on the step', 'Turns out the goat was the lucky one']);
  assert.deepEqual(lyricTells(draft, '').map(t => [t.line, t.tell]), [['Turns out the goat was the lucky one', ENDING_TELL]], 'the kill scan carries the ending flag, and only at the end');
});

test('Part 293 follow-up: the audit gets an ENDING gate with the exact lines the song and each chorus land on', () => {
  const draft = 'Pop.\nLyrics:\n[Verse 1]\na1\na2\n[Chorus]\nc1\nc2\nc3\n[Verse 2]\nb1\nb2\n[Chorus]\nc1\nc2\nc3\n[Chorus - Belted]\nd1\nd2\n[Post-Chorus]\np1\np2\n[Outro]\no1\n(la la, fading)\no2\n\nREADBACK: x';
  assert.deepEqual(lyricEndingLines(draft), ['c2', 'c3', 'b1', 'b2', 'd1', 'd2', 'o1', 'o2'], 'each chorus pass (back-to-back passes apart), the last verse, the song; ad-libs and the post-chorus skipped; each line once');
  const ask = lyricAuditRequest(draft, [], null);
  assert.ok(ask.includes('\n8. THE ENDING. These are the last two sung lines of the song, of each chorus pass, of the last verse and of the bridge, and any line the last chorus changed, pulled by the desk:\n   - "c2"\n   - "c3"\n   - "b1"\n   - "b2"\n   - "d1"\n   - "d2"\n   - "o1"\n   - "o2"\n'), ask.slice(0, 4000));
  assert.match(ask, /Rewrite any that states a lesson, a turnaround, a verdict on the story or a sum-up of it/);
  assert.ok(ask.indexOf('7. Singability') < ask.indexOf('8. THE ENDING') && ask.indexOf('8. THE ENDING') < ask.indexOf('Return the complete song'), 'last of the gates');
  const gate = ask.slice(ask.indexOf('8. THE ENDING'), ask.indexOf('Return the complete song'));
  assert.equal((gate.match(/"/g) || []).length, 16, 'the only quotes are the pulled lines: the gate names the shape and never demonstrates one');
  assert.deepEqual(lyricEndingLines(draft.replace('[Post-Chorus]', '[Bridge]')), ['c2', 'c3', 'b1', 'b2', 'd1', 'd2', 'p1', 'p2', 'o1', 'o2'], 'the bridge too');
  const withShape = lyricAuditRequest(draft, lyricTells(draft), 'Add a [Verse 3].');
  assert.match(withShape, /\n8\. Length\. Add a \[Verse 3\]\.\n9\. THE ENDING\./);
  assert.doesNotMatch(lyricAuditRequest('An instrumental. Instrumental only, no vocals.', [], null), /THE ENDING/);
  const story = 'Folk.\nLyrics:\n[Verse 1]\nv1\nThat goat will never sleep\n[Verse 2]\nv2\nThat goat will never sleep\n\nREADBACK: x';
  assert.deepEqual(lyricEndingLines(story), ['That goat will never sleep', 'v2'], 'a story song with no chorus: the last two lines, in the order they first appear');
});

test('Part 293 follow-up: the deep lane may think to 48,000 tokens; the phone and the web keep 24,000', () => {
  const deep = musicWritingSettings({ engine: 'yue2', mode: 'write', deep: true });
  assert.equal(deep.maxTokens, 48000); assert.ok(deep.maxTokens <= 131072, "inside the model's listed max output (OpenRouter, Sep 25 2026)");
  assert.equal(deep.timeoutMs, 600000); assert.equal(deep.reasoning.effort, 'medium');
  assert.equal(musicWritingSettings({ engine: 'yue2', mode: 'write' }).maxTokens, 24000, 'phone lane untouched');
  assert.equal(musicWritingSettings({ engine: 'yue2', mode: 'write', patient: true }).maxTokens, 24000, 'web lane untouched');
  assert.equal(musicWritingSettings({ engine: 'lyria', mode: 'write', deep: true }).maxTokens, 48000);
});

test('Part 293 follow-up: the route sends the drawn map under the idea, holds the length check to it, and no Jev veto drops a tidy ending', async () => {
  const rows = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} row ${i + 1} goes here`).join('\n');
  const draft = `Pop with bright guitars.\nLyrics:\n[Verse 1]\n${rows(8, 'first')}\n[Chorus]\nLucky me, lucky me\nPut it on the tab for free\n[Verse 2]\n${rows(8, 'second')}\n[Chorus]\nLucky me, lucky me\nPut it on the tab for free\n[Outro]\nI set the scratch card down\nTurns out that I'm the lucky one\n\nREADBACK: A pop song about luck.`;
  const fixed = draft.replace("Turns out that I'm the lucky one", 'And I scratched the next one with my thumb');
  const vetoAll = { lyricTellsJev: async () => ({ tells: [], asked: 20, costUSD: 0, scores: new Map() }), lyricTellsLog: () => {} };
  for (const forced of ['prePost', 'threeVerses']) {
    const salts = [];
    const api = { songSectionMap: (brief, salt) => { salts.push(salt); return songSectionMap(brief, salt) && SECTION_MAPS[forced]; }, sectionMapNote, lyricEndingTells };
    const booth = loadBooth({ reply: (_b, n) => (n === 1 ? draft : fixed), api, jev: vetoAll });
    const out = await booth.call('post/script', { user: { id: 'map-fixture' }, body: { engine: 'yue2', mode: 'write', text: 'a song about luck' } });
    assert.equal(out.code, 200);
    assert.match(salts[0], /^map-fixture\n\d{13}$/, 'seeded by the idea, who asked and when');
    assert.ok(booth.requests[0].messages[1].content.startsWith(`WHAT THEY WANT MADE:\na song about luck\n\n${sectionMapNote(SECTION_MAPS[forced])}`), `${forced}: the map rides under the idea`);
    assert.equal(booth.ledger[0].metadata.sectionMap, forced);
    const audit = booth.requests[1].messages[1].content;
    assert.match(audit, /"Turns out that I'm the lucky one" -- a tidy ending/, `${forced}: Jev vetoed every flag, the tidy ending is still flagged`);
    assert.match(audit, /THE ENDING\. These are the last two sung lines/);
    if (forced === 'prePost') assert.doesNotMatch(audit, /8\. Length/, 'two verses of eight are this map');
    else assert.match(audit, /8\. Length\. The song has only two verses, and the map for this song is three verses, a chorus after each, and a short bridge\. Add a \[Verse 3\]/);
    assert.doesNotMatch(out.body.script, /Turns out/); assert.match(out.body.script, /scratched the next one/);
  }
  const plainApi = { songSectionMap, sectionMapNote, lyricEndingTells };
  let booth = loadBooth({ reply: () => draft, api: plainApi });
  await booth.call('post/script', { user: { id: 'map-2' }, body: { engine: 'yue2', mode: 'write', text: 'a two verse song about luck' } });
  assert.doesNotMatch(booth.requests[0].messages[1].content, /SECTION MAP/, 'her own structure: no map');
  assert.equal(booth.ledger[0].metadata.sectionMap, undefined);
  booth = loadBooth({ reply: () => draft, api: plainApi });
  await booth.call('post/script', { user: { id: 'map-3' }, body: { engine: 'yue2', mode: 'write', text: 'a song about luck', lyrics: 'My own words about luck' } });
  assert.doesNotMatch(booth.requests[0].messages[1].content, /SECTION MAP/, 'her supplied lyrics: no map');
  booth = loadBooth({ reply: () => draft, api: plainApi });
  await booth.call('post/script', { user: { id: 'map-4' }, body: { engine: 'yue2', mode: 'write', text: 'a song about luck' } });
  const drawn = booth.ledger[0].metadata.sectionMap;
  assert.ok(drawn in SECTION_MAPS, 'the real draw');
  assert.ok(booth.requests[0].messages[1].content.includes(sectionMapNote(SECTION_MAPS[drawn])), 'the note sent is the map logged');
});
