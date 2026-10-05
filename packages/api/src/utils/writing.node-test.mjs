import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes, createRequire } from 'node:module';
import vm from 'node:vm';
const source = stripTypeScriptTypes(readFileSync(new URL('./writing.ts', import.meta.url), 'utf8'));
const hitSource = stripTypeScriptTypes(readFileSync(new URL('../music/hitSystem.ts', import.meta.url), 'utf8')).replace('export const hitWritingSystem', 'const hitWritingSystem');
const musicSource = hitSource + '\n' + stripTypeScriptTypes(readFileSync(new URL('../music/writing.ts', import.meta.url), 'utf8')).replace("import { hitWritingSystem } from './hitSystem';", '');
const { musicWritingPrompt, musicWritingSettings, lyricWritingModel, lyricAgentId, lyricTells, lyricRepairRequest, mergeRepairedLyrics, lyricShapeIssue, labelReadback, lyricAuditRequest, fixStageDirections, musicWritingCraft, SONG_EXPLICIT_NOTE, SONG_CLEAN_NOTE, lyricEndingTells, lyricEndingLines, songSectionMap, sectionMapNote, sectionMapPool, SECTION_MAPS, ENDING_TELL, chorusShapeFor, chorusShapeNote, CHORUS_SHAPES, lyricRepeatIssues, lyricRepeatWeight, lyricRepeatRequest, applyRepeatRewrite, lyricKissOffTells, KISS_OFF_TELL } = await import('data:text/javascript;base64,' + Buffer.from(musicSource).toString('base64'));
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
    if (name === './kadeSoundBoothLink') return { createReferenceLinkRouter: () => (_req, _res, next) => next && next(), guideFor: guide => guide };
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

test('Part 295: a normal reply costs its cost once; the upstream figure that restates it is never added', () => {
  /* The shape of a saved non-BYOK OpenRouter reply (google/gemini-2.5-flash-lite, Sep 25 2026). */
  const plain = { prompt_tokens: 11722, completion_tokens: 110, cost: 0.0125646, is_byok: false, cost_details: { upstream_inference_cost: 0.0125646 } };
  assert.deepEqual(writingCost(plain, 'custom/model'), { costUSD: 0.0125646, measured: true });
  assert.deepEqual(writingCost({ ...plain, is_byok: undefined }, 'custom/model'), { costUSD: 0.0125646, measured: true });
  assert.deepEqual(writingCost({ cost: 0.0032, cost_details: { upstream_inference_cost: null } }, 'custom/model'), { costUSD: 0.0032, measured: true });
});

test('Part 295: a BYOK call costs OpenRouter\'s fee plus what the provider charged the key', () => {
  assert.deepEqual(writingCost({ cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.0042 } }, 'custom/model'), { costUSD: 0.0042, measured: true });
  assert.ok(Math.abs(writingCost({ cost: 0.0002, is_byok: true, cost_details: { upstream_inference_cost: 0.004 } }, 'custom/model').costUSD - 0.0042) < 1e-12);
  /* Review: a BYOK reply without the upstream figure is priced from its tokens, as the describer does. */
  assert.deepEqual(writingCost({ cost: 0.0002, is_byok: true, cost_details: { upstream_inference_cost: null }, prompt_tokens: 3000, completion_tokens: 1000 }, 'nousresearch/hermes-4-405b'), { costUSD: 0.006, measured: false });
  assert.deepEqual(writingCost({ cost: 0, is_byok: true, cost_details: { upstream_inference_cost: null } }, 'nousresearch/hermes-4-405b', 12000, 4000), { costUSD: 0.006, measured: false });
  assert.deepEqual(writingCost({ cost: 0.0002, is_byok: true, cost_details: { upstream_inference_cost: null } }, 'custom/model'), { costUSD: 0.0002, measured: false }, 'no price row: the writer keeps working, the fee marked unmeasured');
  assert.deepEqual(writingCost({ cost_details: { upstream_inference_cost: 0.001 } }, 'custom/model'), { costUSD: 0.001, measured: true });
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
    if (name === './kadeSoundBoothLink') return { createReferenceLinkRouter: () => (_req, _res, next) => next && next(), guideFor: guide => guide };
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
    if (name === './kadeSoundBoothLink') return { createReferenceLinkRouter: () => (_req, _res, next) => next && next(), guideFor: guide => guide };
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
  assert.match(audit, /SING-ALONG/); assert.doesNotMatch(audit, /one line rhymes with nothing/);
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
  assert.match(audit, /do not count syllables yourself/i); assert.match(audit, /not a nursery rhyme either/);
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
    /* Part 296 follow-up: the can-do-without is now her named kiss-off, which takes these in. */
    ["I don't need your money, I need your time", KISS_OFF_TELL], ["I don't need a crown, I just want the keys", KISS_OFF_TELL],
    ["I ain't need no help, just need a ride", KISS_OFF_TELL], ["I don't need to win, I just need you", '"I don\'t need X, I need Y"'],
  ];
  for (const [line, tell] of tells) assert.deepEqual(flags(line), [tell], line);
  const plainSpeech = [
    'He plays electric guitar at the Legion', 'Paid the electric bill in quarters', 'The electric company cut us off', 'Doing the Electric Slide at the reunion',
    'She got the electric blanket and the good pillow', 'Down in the hollow past the church', 'I would do it again in a heartbeat', 'Unfold the lawn chair, sit a spell',
    'She unfolded the map on the hood', 'I found myself at the Waffle House at noon', "I'm enough of a fool to call", 'I survived three kids and a Buick',
    'Chained the dog out by the shed', 'Sitting in the truck bed', 'He learned the hard way', 'Now they know',
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
    if (name === './kadeSoundBoothLink') return { createReferenceLinkRouter: () => (_req, _res, next) => next && next(), guideFor: guide => guide };
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
test('rap audits keep deliberate cadence while melodic audits check uneven verses', () => {
  const uneven = 'Modern hip-hop, conversational rap.\nLyrics:\n[Verse 1]\nWait\nI brought the invoice with the part you thought I would forget\nRead it\nEvery little number has a name you have not met\nREADBACK: A confrontation.';
  const rap = lyricAuditRequest(uneven, [], null, [], 'Rap with shifting cadences');
  assert.match(rap, /FLOW AND MEANING/);
  assert.doesNotMatch(rap, /Counted by the desk|these verses cannot carry one tune/);
  assert.match(musicWritingCraft, /Build this singer's own vocabulary and point of view/);
  assert.match(musicWritingCraft, /GENRE CHOOSES THE TECHNIQUE/);
});

test('unsaved transfers use the real route without model calls or saved projects', async () => {
  const booth = loadBooth();
  const lyrics = '[Verse]\nEvery authored word stays here';
  const source = { engine: 'yue2', script: 'English, folk, clear alto', title: 'Current edits', sourceText: 'Original idea', options: { lyrics, singing: 'Instrumental, no singing', reference_voice_url: 'https://example.test/song.wav' } };
  const result = await booth.call('post/carry', { body: { engine: 'lyria', draft: source } });
  assert.equal(result.code, 200);
  assert.equal(result.body.draft.options.lyrics, lyrics);
  assert.equal(result.body.draft.options.instrumental, true);
  assert.equal(result.body.draft.sourceText, source.sourceText);
  assert.equal(result.body.draft.id, undefined);
  assert.equal(result.body.draft.projectId, undefined);
  assert.equal(result.body.draft.options.reference_voice_url, undefined);
  assert.match(result.body.notes.join(' '), /does not take an imported recording/);
  assert.equal(booth.requests.length, 0);
  assert.equal(booth.ledger.length, 0);
  assert.equal((await booth.call('post/carry', { body: { engine: 'seed', draft: source } })).code, 400);
  assert.equal((await booth.call('post/carry', { body: { engine: 'lyria' } })).code, 400);
});

test('instrumental settings override a sung idea without asking the writer to fill lyrics', async () => {
  const booth = loadBooth({ reply: () => 'English folk instrumental, acoustic guitar and fiddle.\nREADBACK: A folk instrumental.' });
  const result = await booth.call('post/script', { user: { id: 'writer-fixture' }, body: { engine: 'yue2', mode: 'write', text: 'A folk song about home', singing: 'Instrumental, no singing' } });
  assert.equal(result.code, 200);
  assert.equal(booth.requests.length, 1);
  assert.match(booth.requests[0].messages[1].content, /INSTRUMENTAL MODE IS SELECTED/);
  assert.doesNotMatch(booth.requests[0].messages[1].content, /SECTION MAP/);
});

function loadBooth({ reply, api = {}, middleware, jev, clock, env = {} } = {}) {
  const url = new URL('../../../../api/server/routes/kadeSoundBooth.js', import.meta.url), localRequire = createRequire(url);
  const handlers = new Map(), requests = [], ledger = [], registered = [];
  const router = Object.fromEntries(['post', 'get', 'put', 'delete', 'patch', 'use'].map(method => [method, (path, ...values) => { registered.push([method, path, ...values]); handlers.set(method + path, values.at(-1)); }]));
  const multer = Object.assign(() => ({ single: () => () => {} }), { memoryStorage: () => ({}) });
  const context = { module: { exports: {} }, Buffer, URL, console, Date: clock || Date, Intl, process: { env: { REFRAME_PROXY_SECRET: 'fixture', ...env } }, require(name) {
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
    if (name === './kadeSoundBoothLink') return { createReferenceLinkRouter: () => (_req, _res, next) => next && next(), guideFor: guide => guide };
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

test('Sep 27 2026: no Kids-style refusal; explicit lyrics pass through to YuE2 like any style', () => {
  const booth = loadBooth({ reply: () => '' });
  assert.equal(booth.internals.kidsStyleRefusal, undefined, 'the refusal is gone');
  const yueAt = booth.registered.findIndex(([method, path]) => method === 'use' && path === 'the YuE2 router');
  assert.ok(yueAt >= 0, 'the YuE2 router is still registered');
});

test('Part 293 review: the writing lane\'s music grammar describes the voice, the map and the length without demonstrating one', () => {
  const { MUSIC_GRAMMAR, MUSIC_GRAMMAR_WRITE, systemPrompt } = loadBooth({ reply: () => '' }).internals;
  const differing = MUSIC_GRAMMAR.split('\n').filter((line, i) => MUSIC_GRAMMAR_WRITE.split('\n')[i] !== line);
  assert.equal(differing.length, 3, 'exactly the three steps are replaced');
  assert.deepEqual(differing.map(l => l.slice(0, 2)), ['3.', '4.', '6.']);
  for (const engine of ['lyria']) {
    const write = systemPrompt({ engine, mode: 'write' });
    assert.ok(write.includes(MUSIC_GRAMMAR_WRITE), engine);
    assert.doesNotMatch(write, /warm alto|close to the microphone|belting|raspy|two-minute song|\[Intro\] -> \[Verse 1\]|piano alone/, `${engine}: no house voice, map or length`);
    assert.match(write, /4\. VOCAL PROFILE if anyone sings: sex, timbre, range and delivery, chosen for this genre and this singer\./);
    assert.match(write, /3\. STRUCTURE as the section tags this song uses/); assert.match(write, /6\. THE TECHNICAL LINE last: BPM as a number, the key, and the length in plain words/);
    const steps = ['1. GENRE WITH ERA', '2. INSTRUMENTS', '3. STRUCTURE', '4. VOCAL PROFILE', '5. MOOD', '6. THE TECHNICAL LINE'].map(s => write.indexOf(s));
    assert.ok(steps.every((at, i) => at > 0 && (i === 0 || at > steps[i - 1])), `${engine}: all six steps, in order`);
    assert.ok(systemPrompt({ engine, mode: 'format' }).includes(MUSIC_GRAMMAR), `${engine}: formatting her words keeps the grammar as it was`);
  }
  const yue = systemPrompt({ engine: 'yue2', mode: 'write' });
  assert.match(yue, /YUE2 MUSIC FORMAT/);
  assert.doesNotMatch(yue, /LYRIA 3.5 MUSIC BRIEF FORMAT|THE TECHNICAL LINE last/);
  assert.match(yue, /concise style direction/);
  assert.match(systemPrompt({ engine: 'yue2', mode: 'format' }), /Never invent lyrics/);
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
  /* Part 295: the Style rides along only while it is not locked (outside the Family feature pack). */
  assert.match(page, /var styleOpen=engine==='yue2'&&/);
  assert.match(page, /post\('\/api\/kade\/sound-booth\/idea',\{band:styleOpen\?state\.values\.band:undefined\}\)/);
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

/* ---------------- Part 296 (Sep 27 2026): the chorus that is its hook and nothing else ----------------
 * Her words: "it does good on some of the rhymes, but the chorus is horrible... over and over, nothing
 * else... Then also, same this same this same this and that. Very ai." Every lyric below is invented for
 * these tests. */
const chorusOf = (lines, tag = 'Chorus') => `Pop.\nLyrics:\n[${tag}]\n${lines.join('\n')}\n\nREADBACK: x`;
const flagsOf = (script, brief = '') => lyricRepeatIssues(script, brief).flatMap(i => i.problems);

test('Part 296: the chorus gate finds a hook sung over and over and passes a chorus that develops', () => {
  const collapsed = chorusOf(['Fired on my birthday', 'Fired on my birthday', 'They took the paper crown right off my head', 'Fired on my birthday']);
  const [issue] = lyricRepeatIssues(collapsed, 'punk song about getting fired');
  assert.equal(issue.tag, 'Chorus'); assert.equal(issue.chorus, true); assert.equal(issue.hook, 'Fired on my birthday');
  assert.deepEqual(issue.problems, ['the hook "Fired on my birthday" is sung 3 times in one chorus', 'only 2 of its 4 lines are different', 'only 2 of its 4 lines say anything the hook does not', '3 of its lines end on the word "birthday"']);
  const develops = chorusOf(['Fired on my birthday', 'Twenty minutes into the shift', 'They took the paper crown right off my head', 'Fired on my birthday']);
  assert.deepEqual(lyricRepeatIssues(develops, ''), [], 'the hook twice, first and last, and every other line new');
  assert.deepEqual(lyricRepeatIssues(chorusOf(['Fired on my birthday', 'Twenty minutes into the shift', 'Fired on my birthday', 'I kept the paper crown']), ''), [], 'first and third');
  /* A hook sung twice inside one line counts twice. */
  assert.match(flagsOf(chorusOf(['Go on home, go on home', 'You gave the key back in July', 'Go on home, go on home', 'The dog stopped waiting by the door']))[0], /the hook "Go on home" is sung 4 times in one chorus/);
  /* The phrase sung most is the hook, even inside a longer line. */
  assert.match(flagsOf(chorusOf(['One more ride', 'Just one more ride', 'Your hand on the wheel at ten and two', 'One more ride', 'Just one more ride']))[0], /the hook "One more ride" is sung 4 times/);
  /* Echoes in parentheses are backing vocals, not the lead singing the hook again. */
  assert.deepEqual(lyricRepeatIssues(chorusOf(['Lose my number (lose it)', 'You had a year to call', 'I changed the lock on the mailbox too', '(Lose my number)', 'Lose my number, that is all']), ''), []);
  /* Another line sung twice besides the hook. */
  assert.match(flagsOf(chorusOf(['Fired on my birthday', 'Hand me my check', 'Twenty minutes into the shift', 'Hand me my check', 'Fired on my birthday'])).join('|'), /besides the hook, "Hand me my check" is sung more than once in it/);
  /* One word ending three lines, but a voice tic at the end of a line is breath. */
  assert.match(flagsOf(chorusOf(['Not one more', 'I hung the towel on the door', 'The boss can mop his own floor', 'You owe me for the day before'])).join('|'), /^$/, 'three different rhyme words on one sound are a rhyme, not a repeat');
  assert.match(flagsOf(chorusOf(['I want you gone', 'Pack the van and move along', 'I sing it louder every song', 'I want you gone, yeah', 'Yeah, you are gone'])).join('|'), /3 of its lines end on the word "gone"/);
  /* Chants live where the map puts them. */
  for (const tag of ['Post-Chorus', 'Drop', 'Outro', 'Intro']) assert.deepEqual(lyricRepeatIssues(chorusOf(['Come get your truck', 'Come get your truck', 'Come get your truck', 'Come get your truck'], tag), ''), [], tag);
  /* Her brief asked for the chant: the chorus is left alone whole (review: its end words used to still send it to the rewrite). */
  assert.deepEqual(lyricRepeatIssues(collapsed, 'a repetitive chant about getting fired'), []);
  /* A chorus sung three times is one entry naming its three passes; a changed last chorus is its own entry. */
  const song = `Pop.\nLyrics:\n[Verse 1]\nWe parked the Buick by the levee gate\n[Chorus]\nFired on my birthday\nFired on my birthday\nThey took the paper crown right off my head\nFired on my birthday\n[Verse 2]\nMama had a cake with the candles out\n[Chorus]\nFired on my birthday\nFired on my birthday\nThey took the paper crown right off my head\nFired on my birthday\n[Final Chorus]\nFired on my birthday\nFired on my birthday\nI took the paper crown and I kept the change\nFired on my birthday\n\nREADBACK: x`;
  const issues = lyricRepeatIssues(song, '');
  assert.deepEqual(issues.map(i => [i.label, i.passes.length]), [['Chorus', 2], ['Final Chorus', 1]]);
  assert.equal(lyricRepeatWeight(song, ''), issues.reduce((n, i) => n + i.weight, 0));
  assert.deepEqual(lyricRepeatIssues('An instrumental. Instrumental only, no vocals.', ''), []);
});

test('Part 296: lines that open the same way and a line that stacks a list are flagged; plain speech is left alone', () => {
  const verse = lines => `Country.\nLyrics:\n[Verse 1]\n${lines.join('\n')}\n\nREADBACK: x`;
  assert.match(flagsOf(verse(['I got a job at the feed store', 'I got a dog that bites the mail', 'I got a truck that runs on prayer', 'And a porch swing hanging by one nail'])).join('|'), /3 lines in a row open with "I got"/);
  assert.match(flagsOf(verse(['Take the Buick to the levee', 'Take the long way past the mill', 'Take your mama to the Walmart', 'Then come on back up the hill'])).join('|'), /3 lines in a row open with "Take"/);
  assert.match(flagsOf(verse(['Same bar, same stool, same song and that', 'I drove home by the water tower'])).join('|'), /the line "Same bar, same stool, same song and that" stacks 3 clauses that each open with "Same"/);
  assert.match(flagsOf(verse(["Don't wave, don't smile, don't call my phone", 'I moved out to Mountain Home'])).join('|'), /stacks 3 clauses that each open with "Don't"/);
  /* Part 296 follow-up, the measured miss: "and" splits the line, and the last clause opens on "the same". */
  assert.match(flagsOf(verse(['Same three cousins, same old dog, and the same damn everything', 'I drove home by the water tower'])).join('|'), /the line "Same three cousins, same old dog, and the same damn everything" stacks 3 clauses that each open with "Same"/);
  assert.match(flagsOf(verse(['The same old road, the same old town, the same old you', 'I drove home by the water tower'])).join('|'), /stacks 3 clauses that each open with "The same"/, 'the two words were already counted, and still name it');
  for (const plainLine of ['The fair, the fireworks and the Ferris wheel', 'The rain on the roof, the wind, and the cold in my boots', 'Same old dog and the same old truck'])
    assert.deepEqual(lyricRepeatIssues(verse([plainLine, 'I drove home by the water tower']), ''), [], plainLine);
  for (const plainVerse of [
    ['I drove to Harrison for parts', 'I found a gasket and a cup', 'I paid the man in quarters', 'You never even woke up'],
    ['And the dog came back at dinner', 'And a cat was on the roof', 'And my preacher called at seven', 'With a sermon and no proof'],
    ['Shake it, shake it, shake it', 'Nah, nah, nah, nah', 'Higher, higher, higher', 'We are dancing on the car'],
    ['Na na na, hey', 'Na na na, ho', 'Na na na, oh', 'We are dancing on the car'],
    ['I got a job at the feed store', 'I got a dog', 'We parked out by the levee', 'Where the fishing boats all sog'],
  ]) assert.deepEqual(lyricRepeatIssues(verse(plainVerse), ''), [], plainVerse[0]);
  /* One common opening word is speech; the same two words three lines running is the list. */
  assert.match(flagsOf(verse(['And the dog came back at dinner', 'And the cat was on the roof', 'And the preacher called at seven', 'With a sermon and no proof'])).join('|'), /3 lines in a row open with "And the"/);
  assert.deepEqual(lyricRepeatIssues(verse(['Same bar, same stool, same song and that', 'I drove home by the water tower']), 'a song about the same old same old'), [], 'a word from her brief is hers');
  /* Her own Tier 2 ban names the bridge that only lists. */
  assert.match(flagsOf('Pop.\nLyrics:\n[Bridge]\nIt was the shuffle\nIt was the seat\nIt was the dog\n\nREADBACK: x').join('|'), /3 lines in a row open with "It was"/);
});

test('Part 296 follow-up: her hit-writing system asks for the hook once or twice in a chorus, and its worked examples do what it says', async () => {
  /* Her word (Sep 27 2026): "You can fix the instructions and turn it on. Those instructions were written by an ai." */
  const { hitWritingSystem } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(readFileSync(new URL('../music/hitSystem.ts', import.meta.url), 'utf8'))).toString('base64'));
  const markdown = readFileSync(new URL('../music/hit-writing-system.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  assert.equal(hitWritingSystem, markdown, 'hitSystem.ts is regenerated from the markdown');
  for (const old of [/says one thing eight times/, /One phrase, four passes/, /repeats its hook six times/, /repeat one phrase eight times/, /rhyme a word with itself if the cadence/, /two to four times inside the chorus, sometimes more/, /including internal repeats/, /One word repeated three times in a row/, /repeats five times/, /The title lands four to eight times\. /, /One line, four times, rising/])
    assert.doesNotMatch(hitWritingSystem, old);
  assert.match(hitWritingSystem, /Sing the hook phrase once or twice inside the chorus, and give every other chorus line a job: a turn, a concrete image, a consequence\. The title lands several times across the song because the chorus comes back\./);
  assert.match(hitWritingSystem, /Choruses: 4 to 8 lines, the hook in one or two of them and something new in each of the others\./);
  assert.match(hitWritingSystem, /9\. One word repeated for pressure, once in the song, never stretched into a list\./);
  /* Review: the bridge toolkit's mantra asked for one line four times, which the desk's own gate flags
   * (four lines ending on one word) and her Tier 2 bans. Built the way it now reads, a mantra bridge passes. */
  assert.match(hitWritingSystem, /5\. \*\*The mantra\.\*\* One line sung twice, rising, with a new line answering it each time\./);
  const bridge = lines => `x\nLyrics:\n[Bridge]\n${lines.join('\n')}\n\nREADBACK: x`;
  assert.deepEqual(lyricRepeatIssues(bridge(['I ain\'t coming back to town', 'Sold the truck to Randy for a hundred flat', 'I ain\'t coming back to town', 'Left the key inside your mama\'s welcome mat']), ''), []);
  assert.equal(lyricRepeatIssues(bridge(Array(4).fill('I ain\'t coming back to town')), '').length, 1, 'one line four times is still flagged');
  /* Everything else of hers stays, her own bans on the list shape included. */
  assert.match(hitWritingSystem, /Self-declarative bridge repetition that just lists/);
  assert.match(hitWritingSystem, /Forced self-rhyme: rhyming a word with itself as cadence padding\. Deliberate hook repetition is fine\./);
  assert.match(hitWritingSystem, /Every repeated chorus is written out in full\./);
  assert.match(hitWritingSystem, /Across a full song the title should land roughly four to eight times\./);
  /* Her worked examples used to sing the hook three to five times in one chorus: each now passes the desk's own gate. */
  const examples = hitWritingSystem.slice(hitWritingSystem.indexOf('## APPENDIX C: WORKED EXAMPLES'));
  const choruses = [...examples.matchAll(/\[Chorus\]\n([\s\S]*?)\n\n/g)].map(m => m[1]);
  assert.equal(choruses.length, 3);
  for (const chorus of choruses) {
    const script = `x\nLyrics:\n[Chorus]\n${chorus}\n\nREADBACK: x`;
    assert.deepEqual(lyricRepeatIssues(script, ''), [], chorus);
    assert.deepEqual(lyricTells(script, '').filter(t => !/copied from the writing system/.test(t.tell)), [], chorus);
  }
  /* The rewritten rules name the shape and never do it themselves. */
  const rules = ['2. Repetition avoidance.', 'FIX: One hook, sung once', '**Repetition as feeling.**', '**Confidence in simplicity.**', 'Sing the hook phrase once or twice', '- Choruses: 4 to 8 lines', '9. One word repeated for pressure', '5. **The mantra.**']
    .map(start => { const at = hitWritingSystem.indexOf(start); assert.ok(at !== -1, start); return hitWritingSystem.slice(at, hitWritingSystem.indexOf('\n', at)).replace(/ Pre-choruses:.*$/, ''); });
  assert.deepEqual(lyricRepeatIssues(`x\nLyrics:\n[Verse 1]\n${rules.join(' ').split(/(?<=[.:])\s+/).join('\n')}\n\nREADBACK: x`, ''), []);
  /* Our own notes no longer point at advice the system has stopped giving. */
  assert.doesNotMatch(musicWritingCraft, /pass after pass|sung three times for pressure/);
  assert.match(musicWritingCraft, /One word repeated for pressure, once in a song, or a chant in a post-chorus, is not this\./);
});

test('Part 296: the desk draws one chorus shape in code and says it in words, never with a line to copy', () => {
  const brief = 'pop song about finally deleting his number';
  assert.equal(chorusShapeFor(brief, 'kade\n1').id, chorusShapeFor(brief, 'kade\n1').id, 'the same request draws the same shape');
  const counts = {};
  for (let i = 0; i < 600; i++) { const id = chorusShapeFor(brief, `kade\n${1758000000000 + i * 977}`).id; counts[id] = (counts[id] || 0) + 1; }
  assert.deepEqual(Object.keys(counts).sort(), Object.keys(CHORUS_SHAPES).sort(), 'asking again can draw every shape');
  assert.ok(Math.max(...Object.values(counts)) < 300, JSON.stringify(counts));
  assert.equal(chorusShapeFor(brief, 'x', SECTION_MAPS.storyRefrain), null, 'the story song has a refrain line, not a chorus');
  for (const b of ['a song with no chorus about my truck', 'a repetitive chant for the football game', 'a call and response gospel song', 'a sea shanty about my leaky kayak', 'a chorus that is nothing but the hook over and over', 'I want it catchy and repetitive', 'honky tonk song, the chorus goes: Last call, last call, the jukebox ate my dollar, last call', ''])
    assert.equal(chorusShapeFor(b, 'x'), null, b);
  /* Review: asking NOT to repeat, or a story that only mentions repeating, keeps the fix on. */
  for (const b of ["breakup song with the hook you thought I'd take you back", "breakup song, and please don't repeat the hook over and over this time", 'country song, no repetitive chorus', 'a pop song that is not too repetitive', 'catchy but less repetitive than last time', 'a song about my toddler who repeats everything I say', 'a song about a guy who calls me over and over', 'a song about being stuck in a time loop at work'])
    assert.ok(chorusShapeFor(b, 'x'), b);
  assert.equal(chorusShapeNote(null), '');
  for (const shape of Object.values(CHORUS_SHAPES)) {
    const note = chorusShapeNote(shape, SECTION_MAPS.threeVerses);
    assert.ok(note.startsWith(`CHORUS SHAPE, drawn by the desk for this song: ${shape.plan} `), shape.id);
    assert.match(note, /the hook is sung no more than twice in one chorus, and every line that is not the hook says something the hook does not\. Other lines are never sung twice inside it/);
    assert.match(note, /so the title still lands four to eight times across the song\.$/);
    assert.doesNotMatch(note, /["“”]/, `${shape.id}: names the shape, never demonstrates a line`);
    assert.deepEqual(lyricRepeatIssues(`x\nLyrics:\n[Verse 1]\n${note.split(/(?<=[.:])\s+/).join('\n')}\n\nREADBACK: x`, ''), [], `${shape.id}: the note does not do what it bans`);
  }
  assert.match(chorusShapeNote(CHORUS_SHAPES.bookends, SECTION_MAPS.prePost), /Chanting one short phrase belongs to the \[Post-Chorus\], not to the chorus\.$/);
  assert.match(chorusShapeNote(CHORUS_SHAPES.bookends, SECTION_MAPS.dance), /belongs to the \[Drop\]/);
  assert.doesNotMatch(chorusShapeNote(CHORUS_SHAPES.bookends, SECTION_MAPS.twoLong), /Chanting/);
});

test('Part 296: the desk notes and the audit say the four-to-eight count is for the whole song, and the audit gets what was measured', () => {
  assert.doesNotMatch(musicWritingCraft, /Four to six lines plus repeats/);
  assert.match(musicWritingCraft, /Four to six lines, and the hook is sung in them no more than twice/);
  assert.match(musicWritingCraft, /The title lands four to eight times across the whole song because the chorus comes back, never four times inside one chorus/);
  assert.match(musicWritingCraft, /7\. NO LISTS OF LINES THAT OPEN THE SAME WAY/);
  assert.doesNotMatch(musicWritingCraft, /Final Chorus|two long verses|three verses/, 'still no list of song shapes');
  /* Her own words may be quoted; the shapes she hates are never demonstrated. */
  const rules = musicWritingCraft.slice(musicWritingCraft.indexOf('3. THE CHORUS STATES THE HOOK'), musicWritingCraft.indexOf('4. SONG, NOT SHORT STORY')) + musicWritingCraft.slice(musicWritingCraft.indexOf('7. NO LISTS'), musicWritingCraft.indexOf('- WRITE IT LIKE A PERSON'));
  assert.deepEqual(lyricRepeatIssues(`x\nLyrics:\n[Verse 1]\n${rules.split(/(?<=[.:])\s+/).join('\n')}\n\nREADBACK: x`, ''), []);
  const draft = chorusOf(['Fired on my birthday', 'Fired on my birthday', 'They took the paper crown right off my head', 'Fired on my birthday']);
  const plainAsk = lyricAuditRequest(draft, [], null);
  assert.doesNotMatch(plainAsk, /repeated verbatim, title landing four to eight times/);
  assert.match(plainAsk, /It is sung word for word once or twice in each chorus, never more: the title lands because the chorus comes back, not because one chorus says it over and over\. Every other chorus line says something the hook does not\./);
  assert.doesNotMatch(plainAsk.slice(plainAsk.indexOf('2. The hook.'), plainAsk.indexOf('3. Hook stew.')), /four to eight/, 'no song-wide count for a low-effort audit to verify (a count in a gate is where DeepSeek burns its budget)');
  assert.match(plainAsk, /exactly one surprise/); assert.doesNotMatch(plainAsk, /REPEATS/);
  const issues = lyricRepeatIssues(draft, '');
  const ask = lyricAuditRequest(draft, [], null, issues);
  assert.match(ask, /\n8\. REPEATS, measured by the desk\. \[Chorus\]: the hook "Fired on my birthday" is sung 3 times in one chorus; only 2 of its 4 lines are different; only 2 of its 4 lines say anything the hook does not; 3 of its lines end on the word "birthday"\. Fix each where it stands\./);
  assert.match(ask, /\n9\. THE ENDING\./, 'the ending gate stays last');
  const withShape = lyricAuditRequest(draft, [], 'Add a [Verse 3].', issues);
  assert.match(withShape, /\n8\. Length\. Add a \[Verse 3\]\.\n9\. REPEATS, measured by the desk\./); assert.match(withShape, /\n10\. THE ENDING\./);
  assert.ok(ask.endsWith(draft));
  /* Review: the audit never sees the idea, so a chant the idea asked for is said in gate 2 instead of cut to two. */
  const chant = lyricAuditRequest(draft, [], null, [], 'a repetitive chant for my softball team');
  assert.match(chant, /2\. The hook\. Plain speech, six to eight syllables, its click syllable on an open vowel, exactly one surprise\. The idea asked for this repetition \(a chant, or a chorus it spelled out itself\), so the chorus sings its hook as often as the idea does\. If the best line/);
  assert.doesNotMatch(chant, /never more/);
  assert.match(lyricAuditRequest(draft, [], null, [], 'honky tonk song, the chorus goes: Last call, last call, the jukebox ate my dollar, last call'), /The idea asked for this repetition/);
  assert.match(lyricAuditRequest(draft, [], null, [], "breakup song, don't repeat the hook over and over"), /once or twice in each chorus, never more/);
  assert.match(musicWritingCraft, /An idea that itself asks for a chant or for repetition gets what it asks for\./);
});

test('Part 296 review: a chorus written into her own idea is hers; a section flagged for its end words is told which lines, and never told to keep them', () => {
  const song = chorusOf(["You thought I'd take you back?", "You thought I'd take you back?", "I ain't cutting you slack, you thought I'd take you back", "You thought I'd take you back?"]);
  const hers = "Write a song with this chorus: You thought I'd take you back? You thought I'd take you back? I ain't cutting you slack, you thought I'd take you back. You thought I'd take you back?";
  assert.deepEqual(lyricRepeatIssues(song, hers), [], 'her chorus as she wrote it');
  /* Naming the hook once leaves how often to sing it to the desk. */
  assert.match(flagsOf(song, "a breakup song with the hook you thought I'd take you back").join('|'), /the hook "You thought I'd take you back" is sung 4 times in one chorus/);
  /* A line her brief sings twice is hers; one it does not is still counted. */
  const twice = chorusOf(['Go lose my number', 'Hand me the keys', 'Hand me the keys', 'I changed the lock on the mailbox', 'Go lose my number']);
  assert.match(flagsOf(twice, 'girl group song').join('|'), /besides the hook, "Hand me the keys" is sung more than once/);
  assert.deepEqual(lyricRepeatIssues(twice, 'girl group song, the chorus goes: hand me the keys, hand me the keys'), []);
  /* Outside a chorus the lines that share an end word are quoted, and the rewrite changes those words on the same rhyme sound. */
  const bridge = 'Pop.\nLyrics:\n[Bridge]\nYou swore you would be back in a minute\nThe dog sat by the door for a minute\nThe engine ran the whole tank dry in a minute\n\nREADBACK: x';
  const issues = lyricRepeatIssues(bridge, '');
  assert.deepEqual(issues[0].problems, ['3 of its lines end on the word "minute" ("You swore you would be back in a minute", "The dog sat by the door for a minute", "The engine ran the whole tank dry in a minute")']);
  const ask = lyricRepeatRequest(bridge, issues);
  assert.match(ask, /Rewrite only the lines named: lines that open the same way get new openings, a line that stacks a list becomes one plain thought, and a word that ends too many lines gives way to other words on the same rhyme sound\. Keep what each line says, its rhyme sound and its length\./);
  assert.doesNotMatch(ask, /last word where you can/);
  assert.match(lyricAuditRequest(bridge, [], null, issues), /a word that ends too many lines gives way to other words on the same rhyme sound/);
  /* The new instructions do not do what they ban. */
  const told = [ask.match(/Rewrite only the lines named: [^.]*\./)[0], lyricAuditRequest(bridge, [], null, issues).match(/Lines that open the same way [^.]*\./)[0]];
  for (const sentence of told) assert.deepEqual(lyricRepeatIssues(`x\nLyrics:\n[Verse 1]\n${sentence}\n\nREADBACK: x`, ''), [], sentence);
});

/* A song with a collapsed chorus sung twice, a final chorus that changed one line, and a verse whose
 * lines open the same way. */
const P296_SONG = `Punk with fast drums, 170 BPM.

Lyrics:
[Verse 1]
They pulled me off the fryer for a talk
The manager was holding a clipboard and a sock
I got a name tag with a typo on the front
I got a paper crown from the birthday lunch
I got a warning for the ketchup on the wall
So I clocked out early and I told them all

[Chorus]
Fired on my birthday
Fired on my birthday
Handed me a cupcake and a pink slip
Fired on my birthday
(Hey!)

[Verse 2]
Drove home in the uniform with the windows down
Mama had the candles lit for half the town

[Chorus]
Fired on my birthday
Fired on my birthday
Handed me a cupcake and a pink slip
Fired on my birthday
(Hey!)

[Final Chorus]
Fired on my birthday
Fired on my birthday
Blew the candles out and kept the pink slip
Fired on my birthday

READBACK: A punk song about getting fired on a birthday.`;
const P296_REPLY = `[Chorus]
Fired on my birthday
Twenty minutes into the shift
Took the paper crown right off my head
Fired on my birthday

[Verse 1]
They pulled me off the fryer for a talk
The manager was holding a clipboard and a sock
My name tag had a typo on the front
There was a paper crown from the birthday lunch
They warned me for the ketchup on the wall
So I clocked out early and I told them all

[Final Chorus]
Fired on my birthday
Twenty minutes into the shift
Blew the candles out and kept the pink slip
Fired on my birthday`;

test('Part 296: one targeted rewrite goes into every chorus pass, keeps the last chorus\'s changed line, and refuses what would not sing', () => {
  const issues = lyricRepeatIssues(P296_SONG, 'punk song about getting fired on my birthday');
  assert.deepEqual(issues.map(i => i.label), ['Verse 1', 'Chorus', 'Final Chorus']);
  const ask = lyricRepeatRequest(P296_SONG, issues);
  assert.match(ask, /^Think briefly: fix what is named, then write it out\. Do not count syllables\./);
  assert.match(ask, /1\. \[Verse 1\]: 3 lines in a row open with "I got"/); assert.match(ask, /Rewrite only the lines named/);
  assert.match(ask, /2\. \[Chorus\], sung 2 times: the hook "Fired on my birthday" is sung 3 times in one chorus/);
  assert.match(ask, /Keep the hook "Fired on my birthday" word for word and sing it no more than twice: open and close on it, or sing it first and third\./);
  assert.match(ask, /none longer than the longest line it has now/);
  assert.match(ask, /3\. \[Final Chorus\]: a later chorus that changed from the first one, with the same problems\. Its changed line "Blew the candles out and kept the pink slip" stays word for word, in the same place in the chorus; everything else is your new \[Chorus\]\./);
  assert.match(ask, /Return ONLY the rewritten parts, each under its label in square brackets exactly as written above \(\[Verse 1\], \[Chorus\], \[Final Chorus\]\)/);
  assert.ok(ask.endsWith(P296_SONG), 'the whole song rides last, for the story');
  const brief = 'punk song about getting fired on my birthday';
  const fixed = applyRepeatRewrite(P296_SONG, P296_REPLY, issues, brief);
  assert.equal(fixed.split('Twenty minutes into the shift').length - 1, 3, 'the new chorus in every chorus pass');
  assert.equal(fixed.split('Handed me a cupcake').length - 1, 0);
  assert.match(fixed, /\[Final Chorus\]\nFired on my birthday\nTwenty minutes into the shift\nBlew the candles out and kept the pink slip\nFired on my birthday\n\nREADBACK:/);
  assert.match(fixed, /My name tag had a typo on the front/); assert.doesNotMatch(fixed, /I got a name tag/);
  assert.ok(fixed.startsWith('Punk with fast drums, 170 BPM.\n\nLyrics:\n[Verse 1]\n'), 'the direction as written');
  assert.ok(fixed.endsWith('READBACK: A punk song about getting fired on a birthday.'));
  assert.match(fixed, /\[Verse 2\]\nDrove home in the uniform with the windows down\nMama had the candles lit for half the town\n\n\[Chorus\]/, 'untouched sections and the blank lines between them stay');
  assert.deepEqual(lyricRepeatIssues(fixed, brief), []);
  /* No answer for the last chorus: it gets the new chorus, so the song keeps one chorus. */
  const noFinal = applyRepeatRewrite(P296_SONG, P296_REPLY.slice(0, P296_REPLY.indexOf('[Final Chorus]')), issues, brief);
  assert.equal(noFinal.split('Twenty minutes into the shift').length - 1, 3); assert.doesNotMatch(noFinal, /Handed me a cupcake|Blew the candles/);
  /* Refused: a chorus that still repeats, one that lost its lines, one whose lines grew past the tune,
   * and an answer with none of the labels. A later chorus is never rewritten without the first. */
  const only = (chorus) => `[Chorus]\n${chorus.join('\n')}\n\n[Final Chorus]\nFired on my birthday\nTwenty minutes into the shift\nBlew the candles out and kept the pink slip\nFired on my birthday`;
  assert.equal(applyRepeatRewrite(P296_SONG, only(['Fired on my birthday', 'Fired on my birthday', 'Fired on my birthday', 'Handed me a cupcake']), issues.slice(1), brief), null);
  assert.equal(applyRepeatRewrite(P296_SONG, only(['Fired on my birthday']), issues.slice(1), brief), null);
  assert.equal(applyRepeatRewrite(P296_SONG, only(['Fired on my birthday', 'Twenty minutes into the shift of the longest Saturday morning of my entire natural life', 'Took the crown', 'Fired on my birthday']), issues.slice(1), brief), null);
  assert.equal(applyRepeatRewrite(P296_SONG, 'Sure! Here is a better chorus for you.', issues, brief), null);
  /* The wrapper a model adds is not sung. */
  const noisy = '```\n**[Chorus]**\nFired on my birthday\nTwenty minutes into the shift\nTook the paper crown right off my head\nFired on my birthday\n```\nThis version keeps the hook on the first and last lines and gives the middle lines new facts from the story.';
  const cleaned = applyRepeatRewrite(P296_SONG, noisy, issues.slice(1), brief);
  assert.doesNotMatch(cleaned, /```|\*\*|This version/); assert.equal(cleaned.split('Twenty minutes into the shift').length - 1, 3);
  const noted = applyRepeatRewrite(P296_SONG, '[Chorus]\nFired on my birthday\nTwenty minutes into the shift\nTook the paper crown right off my head\nFired on my birthday\n\nI kept the hook first and last.', issues.slice(1), brief);
  assert.doesNotMatch(noted, /I kept the hook/, 'a note under the section is not sung');
});

test('Part 296: the route tells the writer the chorus shape, hands the audit what repeats, and makes ONE bounded rewrite', async () => {
  const lines = ["Mama bought a ticket at the Casey's on the square", 'Daddy said the numbers never paid for anything', 'Uncle Ray was parking in the handicapped spot', 'The cashier gave a look and then a pack of gum', 'We scratched it on the hood with a nickel from the cup', 'Three cherries in a row and a dollar sign', 'My cousin started screaming like the Cardinals won', 'The dog jumped in the truck bed and knocked the cooler down'];
  const chorus = ['Lucky me tonight', 'Lucky me tonight', 'Found a twenty in the dryer', 'Lucky me tonight'];
  const draft = `Country with a fiddle.\nLyrics:\n[Verse 1]\n${lines.join('\n')}\n\n[Chorus]\n${chorus.join('\n')}\n\n[Verse 2]\n${lines.join('\n')}\n\n[Chorus]\n${chorus.join('\n')}\n\n[Bridge]\nWe drove it to the lottery office in Batesville\n\n[Verse 3]\n${lines.join('\n')}\n\n[Chorus]\n${chorus.join('\n')}\n\nREADBACK: A country song about a lucky night.`;
  const good = '[Chorus]\nLucky me tonight\nFound a twenty in the dryer\nBought the whole bar onion rings\nLucky me tonight';
  const api = { songSectionMap: () => SECTION_MAPS.threeVerses, sectionMapNote, lyricEndingTells, chorusShapeFor, chorusShapeNote, lyricRepeatIssues, lyricRepeatRequest, applyRepeatRewrite };
  const body = { engine: 'yue2', mode: 'write', text: 'a song about luck', patient: true };
  let booth = loadBooth({ reply: (_b, n) => (n <= 2 ? draft : good), api });
  let out = await booth.call('post/script', { user: { id: 'repeat-1' }, body });
  assert.equal(out.code, 200);
  assert.equal(booth.requests.length, 3, 'draft, audit, one rewrite');
  const shapeId = booth.ledger[0].metadata.chorusShape;
  assert.ok(shapeId in CHORUS_SHAPES);
  assert.ok(booth.requests[0].messages[1].content.startsWith(`WHAT THEY WANT MADE:\na song about luck\n\n${sectionMapNote(SECTION_MAPS.threeVerses)}\n\n${chorusShapeNote(CHORUS_SHAPES[shapeId], SECTION_MAPS.threeVerses)}`), 'the chorus shape rides under the map');
  assert.match(booth.requests[1].messages[1].content, /REPEATS, measured by the desk\. \[Chorus\], sung 3 times: the hook "Lucky me tonight" is sung 3 times in one chorus/);
  const rewrite = booth.requests[2];
  assert.match(rewrite.messages[1].content, /repeating instead of saying something/); assert.ok(rewrite.messages[1].content.endsWith(draft));
  assert.equal(rewrite.messages[0].content, booth.requests[0].messages[0].content, 'the same system prompt: the gateway keeps the songwriter lane, and the audience note rides along');
  assert.equal(rewrite.reasoning.effort, 'low');
  assert.equal(out.body.script.split('Bought the whole bar onion rings').length - 1, 3);
  assert.equal(out.body.script.split('Lucky me tonight').length - 1, 6, 'the title still lands six times across the song');
  assert.ok(out.body.repairs.includes('rewrote the chorus so it says more than its hook'));
  assert.deepEqual({ ...booth.ledger[0].metadata.repeats }, { draft: 1, left: 0, rewrite: 'fixed' });
  assert.equal(booth.ledger[0].costUSD, 0.03, 'all three calls are on the ledger');
  /* Kept the draft: a rewrite that brings in a stock image, one that still repeats, or one that
   * swears in a clean song. Never a second try. */
  for (const [bad, audience] of [[good.replace('Bought the whole bar onion rings', 'Poured a coffee for the band'), 'explicit'], ['[Chorus]\nLucky me tonight\nLucky me tonight\nLucky me tonight\nFound a twenty', 'explicit'], [good.replace('Bought the whole bar onion rings', 'Bought the whole damn bar onion rings'), 'clean']]) {
    audienceStub.answer = audience;
    booth = loadBooth({ reply: (_b, n) => (n <= 2 ? draft : bad), api });
    out = await booth.call('post/script', { user: { id: 'repeat-2' }, body });
    audienceStub.answer = 'explicit';
    assert.equal(out.code, 200, bad);
    assert.equal(booth.requests.length, 3, 'one rewrite, never a loop');
    assert.equal(out.body.script.split('Found a twenty in the dryer').length - 1, 3, 'the song as it was');
    assert.doesNotMatch(out.body.script, /coffee|damn/);
    assert.ok(!out.body.repairs.some(r => /rewrote the chorus/.test(r)));
    assert.equal(booth.ledger[0].metadata.repeats.rewrite, 'kept the draft');
  }
  /* The phone waits 112 seconds: no time left after the audit, no rewrite. */
  let offset = 0;
  const clock = class extends Date { static now() { return Date.now() + offset; } };
  booth = loadBooth({ reply: (_b, n) => { if (n === 2) offset += 90000; return draft; }, api, clock });
  out = await booth.call('post/script', { user: { id: 'repeat-3' }, body: { ...body, patient: false } });
  assert.equal(booth.requests.length, 2, 'draft and audit only');
  assert.equal(booth.ledger[0].metadata.repeats.rewrite, 'skipped');
  /* Nothing repeats: no rewrite call at all. */
  const fine = draft.replaceAll(chorus.join('\n'), good.replace('[Chorus]\n', ''));
  booth = loadBooth({ reply: () => fine, api });
  out = await booth.call('post/script', { user: { id: 'repeat-4' }, body });
  assert.equal(booth.requests.length, 2);
  assert.deepEqual({ ...booth.ledger[0].metadata.repeats }, { draft: 0, left: 0, rewrite: undefined });
  /* The kill switch: no shape, no REPEATS gate, no rewrite; the desk as it was plus the corrected wording. */
  booth = loadBooth({ reply: () => draft, api, env: { KADE_LYRIC_REPEATS: '0' } });
  out = await booth.call('post/script', { user: { id: 'repeat-off' }, body });
  assert.equal(booth.requests.length, 2);
  assert.doesNotMatch(booth.requests[0].messages[1].content, /CHORUS SHAPE/); assert.doesNotMatch(booth.requests[1].messages[1].content, /REPEATS/);
  assert.equal(booth.ledger[0].metadata.repeats, undefined); assert.equal(booth.ledger[0].metadata.chorusShape, undefined);
  /* Review: an idea that asks for the chant gets it: no chorus shape, the chorus is not sent to the rewrite, and the audit is told. */
  booth = loadBooth({ reply: () => draft, api });
  out = await booth.call('post/script', { user: { id: 'repeat-chant' }, body: { ...body, text: 'a repetitive chant about luck' } });
  assert.equal(booth.requests.length, 2, 'draft and audit, no rewrite');
  assert.doesNotMatch(booth.requests[0].messages[1].content, /CHORUS SHAPE/);
  assert.match(booth.requests[1].messages[1].content, /The idea asked for this repetition/); assert.doesNotMatch(booth.requests[1].messages[1].content, /REPEATS/);
  assert.deepEqual({ ...booth.ledger[0].metadata.repeats }, { draft: 0, left: 0, rewrite: undefined });
  /* Her own words are never measured or rewritten, and get no chorus shape. */
  booth = loadBooth({ reply: () => draft, api });
  out = await booth.call('post/script', { user: { id: 'repeat-5' }, body: { ...body, lyrics: chorus.join('\n') } });
  assert.equal(booth.requests.length, 1);
  assert.doesNotMatch(booth.requests[0].messages[1].content, /CHORUS SHAPE/);
  assert.equal(booth.ledger[0].metadata.repeats, undefined);
});

/* ---------------- Part 296 follow-up (Sep 27 2026): the stock kiss-off ----------------
 * Her words after the chorus fix went live: "really one of the only ai tells I could find in them was
 * keep your... keep your this, keep your that, I don't need blah blah blah... I feel like we should
 * break those patterns specific". Every lyric below is invented for these tests. */
const kissFlags = (line, brief = '') => lyricKissOffTells('x\nLyrics:\n[Verse 1]\n' + line + '\n\nREADBACK: x', brief).map(t => t.tell);

test('Part 296 follow-up: the kiss-off scan flags the hand-back and the can-do-without, and leaves plain speech alone', () => {
  const kissOffs = [
    'You can keep the bass boat and the dog', 'Keep your class ring, I got my own', 'So keep the casserole dish', 'Baby, you can keep it', 'Keep it all for all I care',
    'Honey, you could have the recliner', 'You can have her, she likes your truck', 'I told him keep the lawnmower', 'Keep the change and the bad advice', "You can keep your mama's opinion",
    'Take your lawn gnomes and go', 'Take the fruitcake back to your mama', 'Take it and git', 'Take your drama outta my driveway',
    "I don't need your cousin's boat", "We don't need a DJ", "Don't need a map to find the Dairy Queen", "She don't need nobody's help", 'Who needs a husband with a bass boat',
    "I sure don't even need the raise", "I ain't never needed you", 'We never needed much', "I don’t need your pity, Darrell",
    "You can keep knockin' on the screen door", 'You could keep on calling, Darrell',
  ];
  for (const line of kissOffs) {
    assert.deepEqual(kissFlags(line), [KISS_OFF_TELL], line);
    assert.deepEqual(lyricTells('x\nLyrics:\n' + line).map(t => t.tell), [KISS_OFF_TELL], line);
  }
  const plainSpeech = [
    'Keep your eyes on the gravel road', 'Keep your elbows off the table', 'Keep your voice down in church', 'Keep your hands to yourself at the fair', "Keep the engine runnin' by the bank",
    'Keep the truck in second gear', 'Keep her warm till the sun comes up', "Keep it movin' down the line", 'Keep your word to the man', 'Keep the faith, sister', 'Keep the yard mowed for the realtor',
    "You keep callin' after ten", 'I keep the jar of pennies by the sink', 'Mama keeps a pistol in her purse', 'Worked two jobs to keep the lights on', 'You should keep the receipt', "She'll keep the Buick",
    'I need to see the doctor', "I don't need to hear it twice", "We don't need to talk about Randy", "A hat I didn't need and a pair of boots", 'For anybody who needs a ride to Branson',
    'Take the long way past the Walmart', 'Take the back road through Mountain Home', 'Take your time with the gravy', 'Take my hand and hold on', 'Take it back, you lied about the dog',
    "You don't need him, girl", 'I need you like the creek needs rain', "Keep on rollin' to Harrison", "You just keep talkin' at the Legion",
  ];
  for (const line of plainSpeech) assert.deepEqual(kissFlags(line), [], line);
  /* Named first when a stock word rides in the same line: the new move takes the word out with it. */
  assert.deepEqual(lyricTells('x\nLyrics:\nKeep your coffee, I got my own').map(t => t.tell), [`${KISS_OFF_TELL}, and coffee`]);
  /* The music direction is never scanned. */
  assert.deepEqual(lyricKissOffTells("Honky-tonk; the singer tells him he can keep the truck.\nLyrics:\n[Verse 1]\nI sold the boat to Randy's wife"), []);
});

test('Part 296 follow-up: a kiss-off from her own idea is hers; asking for a kiss-off song is not asking for the stock one', () => {
  assert.deepEqual(kissFlags('You can keep the recliner', 'breakup song where she tells him he can keep the recliner'), [], 'her phrase');
  assert.deepEqual(kissFlags("I don't need your truck", "a song called I Don't Need Your Truck"), [], 'her title');
  assert.deepEqual(kissFlags("Baby I don't need your money", "country song, I don't need him anymore"), [], 'the same move asked for');
  assert.deepEqual(kissFlags('You can keep the recliner', 'a kiss-off song for my ex'), [KISS_OFF_TELL]);
  assert.deepEqual(kissFlags('You can keep the recliner', 'breakup song, no keep your stuff lines please'), [KISS_OFF_TELL], 'a mention she bans does not turn the scan off');
  assert.deepEqual(kissFlags("I don't need your truck", "breakup song, never do the I don't need you thing"), [KISS_OFF_TELL]);
  assert.deepEqual(kissFlags('You can keep the recliner', "breakup song, I don't need him anymore"), [KISS_OFF_TELL], 'asking for one move is not asking for the other');
});

test('Part 296 follow-up: the desk notes and the audit name the kiss-off in words and never demonstrate it', async () => {
  const eight = musicWritingCraft.slice(musicWritingCraft.indexOf('8. NO STOCK KISS-OFF'), musicWritingCraft.indexOf('- WRITE IT LIKE A PERSON'));
  assert.match(eight, /tells the other person to keep their things, or offers the things up or sends them off with them, and the line about what the singer does not need/);
  assert.match(eight, /A breakup, a quitting song or a brag still gets its kiss-off/);
  assert.doesNotMatch(eight, /["“”]/, 'no example lines and no templates to copy');
  const song = 'Country.\nLyrics:\n[Verse 1]\nYou can keep the bass boat and the dog\nI sold the camper to a man from Joplin\n\nREADBACK: x';
  const audit = lyricAuditRequest(song, lyricTells(song), null);
  assert.match(audit, /1\. "You can keep the bass boat and the dog" -- the stock kiss-off/);
  assert.match(audit, /A line marked as the stock kiss-off needs a different move, not the same move in new words/);
  const other = song.replace('You can keep the bass boat and the dog', 'I drank a Tuesday');
  assert.doesNotMatch(lyricAuditRequest(other, lyricTells(other), null), /stock kiss-off/, 'only when one is flagged');
  /* What bans a shape must not do it: the scan and the repeat gate both read the note, the gate and the label clean. */
  const at = audit.indexOf('A line marked as the stock kiss-off');
  const gate = audit.slice(at, audit.indexOf('\n', at));
  for (const text of [eight, gate, KISS_OFF_TELL]) {
    const asSong = `x\nLyrics:\n[Verse 1]\n${text.split(/(?<=[.:])\s+/).join('\n')}\n\nREADBACK: x`;
    assert.deepEqual(lyricKissOffTells(asSong), [], text.slice(0, 40));
    assert.deepEqual(lyricRepeatIssues(asSong, ''), [], text.slice(0, 40));
  }
  /* Her worked examples no longer show the can-do-without (Example A's chorus did). */
  const { hitWritingSystem } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(readFileSync(new URL('../music/hitSystem.ts', import.meta.url), 'utf8'))).toString('base64'));
  const examples = hitWritingSystem.slice(hitWritingSystem.indexOf('## APPENDIX C'));
  assert.ok(examples.length > 1000);
  assert.deepEqual(lyricKissOffTells(`x\nLyrics:\n${examples}`), []);
  assert.match(examples, /Ain't bring a crowd, they lift the rope/);
});

test('Part 296 follow-up: the route flags kiss-offs past a Jev veto, the audit rewrites them, and the ledger counts them', async () => {
  const verse = ['I found your fishing hat behind the seat', 'The dog still waits for you at half past five', 'You can keep the bass boat and the dog', "And I don't need your cousin's boat", 'I paid the phone bill with the jar of quarters', 'Your mama called and asked me how I was', 'I told her I was fine and meant it mostly', 'The yard looks better since I mowed it crooked'];
  const draft = `Country with a steel guitar.\nLyrics:\n[Verse 1]\n${verse.join('\n')}\n\n[Chorus]\nI sold the camper\nI sold it for a song\nThe man from Joplin\nTowed it before dawn\n\nREADBACK: A country song about a breakup.`;
  const fixed = draft.replace('You can keep the bass boat and the dog', 'I left your waders hanging in the barn').replace("And I don't need your cousin's boat", 'And changed the code on the garage');
  const vetoAll = { lyricTellsJev: async () => ({ tells: [], asked: 20, costUSD: 0, scores: new Map() }), lyricTellsLog: () => {} };
  const api = { lyricEndingTells, lyricKissOffTells };
  const body = { engine: 'yue2', mode: 'write', text: 'a breakup song about my ex', patient: true };
  let booth = loadBooth({ reply: (_b, n) => (n === 1 ? draft : fixed), api, jev: vetoAll });
  let out = await booth.call('post/script', { user: { id: 'kiss-1' }, body });
  assert.equal(out.code, 200);
  const audit = booth.requests[1].messages[1].content;
  assert.match(audit, /"You can keep the bass boat and the dog" -- the stock kiss-off/, 'Jev vetoed every flag; the kiss-off is still flagged');
  assert.match(audit, /"And I don't need your cousin's boat" -- the stock kiss-off/);
  assert.match(audit, /needs a different move/);
  assert.doesNotMatch(out.body.script, /keep the bass boat|don't need your cousin/);
  assert.ok(out.body.repairs.includes('rewrote 2 lines that leaned on stock images'), out.body.repairs.join(' | '));
  assert.deepEqual({ ...booth.ledger[0].metadata.kissOffs }, { draft: 2, left: 0 });
  /* An audit that leaves one: the better song is kept and the ledger says one got through. */
  booth = loadBooth({ reply: (_b, n) => (n === 1 ? draft : draft.replace('You can keep the bass boat and the dog', 'I left your waders hanging in the barn')), api, jev: vetoAll });
  out = await booth.call('post/script', { user: { id: 'kiss-2' }, body });
  assert.deepEqual({ ...booth.ledger[0].metadata.kissOffs }, { draft: 2, left: 1 });
  /* Her own words are never scanned. */
  booth = loadBooth({ reply: () => draft, api, jev: vetoAll });
  out = await booth.call('post/script', { user: { id: 'kiss-3' }, body: { ...body, lyrics: verse.join('\n') } });
  assert.equal(booth.requests.length, 1);
  assert.equal(booth.ledger[0].metadata.kissOffs, undefined);
});

/* Part 296 follow-up review: what the review found on the 600 stored desk texts and in how a brief
 * is read. Every lyric below is invented for these tests. */
test('Part 296 follow-up review: a note to the writer in her idea does not switch the kiss-off scan off', () => {
  const writerNotes = [
    ['You can keep the recliner', 'breakup song, keep it upbeat'], ['You can keep the recliner', 'country breakup song, keep the chorus short'],
    ['You can keep the recliner', 'breakup song, keep the tempo fast'], ['You can keep the recliner', 'breakup song, keep your language clean'],
    ['You can keep the recliner', 'a song about trying to keep the farm'], ['Take your lawn gnomes and go', 'breakup song, take it slow at first'],
    ["I don't need your pity", "breakup song, I don't need it to rhyme perfectly"], ["I don't need your pity", "sad song, don't need a bridge"],
    ["I don't need your pity", 'a song for anybody who needs a ride home'],
    /* Her phrase counts through the thing itself: "keep it" or "don't need a" alone is not hers. */
    ['Baby, you can keep it', 'breakup song, keep it upbeat'], ["I don't need a DJ", "dance song, I don't need a bridge"],
  ];
  for (const [line, brief] of writerNotes) assert.deepEqual(kissFlags(line, brief), [KISS_OFF_TELL], `${line} | ${brief}`);
  const asked = [
    ['Take your lawn gnomes and go', 'breakup song where she tells him to take his lawn gnomes and go'],
    ['You can keep the recliner', 'divorce song, she gets to keep the house'], ['Baby, you can keep it', 'she tells him he can keep it all'],
    ["We don't need the lights", 'love song, I never needed him anyway'], ["I don't need a DJ", "dance song called I Don't Need a DJ"],
    ['Who needs a husband with a bass boat', 'who needs a man, a girls night song'],
  ];
  for (const [line, brief] of asked) assert.deepEqual(kissFlags(line, brief), [], `${line} | ${brief}`);
});

test('Part 296 follow-up review: the singer carrying on a sentence keeps the thing; it or them handed over, bare have and a run of takes are the kiss-off', () => {
  const song = (...lines) => 'x\nLyrics:\n[Verse 1]\n' + lines.join('\n') + '\n\nREADBACK: x';
  /* Seen on a grief song: the singer's own sentence runs on, so the singer keeps the keys. */
  assert.deepEqual(lyricKissOffTells(song("I'll drive it round the square one time for him", 'And keep the keys and his old fishing hat')), []);
  assert.deepEqual(lyricKissOffTells(song("We'll sell the boat to Randy's cousin Ted", 'And keep the trailer for the hay instead')), []);
  /* Still an order: the sentence above ended, or its verb cannot take "and keep" after it, or it is in another section. */
  assert.equal(lyricKissOffTells(song("I'll drive it round the square one time for him.", 'And keep the keys and his old fishing hat')).length, 1);
  assert.equal(lyricKissOffTells(song("I'm leavin' on the Greyhound bus tonight", 'And keep the ring, I never liked the stone')).length, 1);
  assert.equal(lyricKissOffTells('x\nLyrics:\n[Verse 1]\nI\'ll drive it once around and park it by the shed\n\n[Chorus]\nAnd keep the keys and his old fishing hat\n\nREADBACK: x').length, 1);
  const kissOffs = [
    'Go on and take it, give it to your mama', 'Take it, I figure six years is plenty', 'Have it, I got a bus to catch', "Have 'em both, I'm headed to Branson",
    'Take the boat, take the camper, take the dog', 'Fine, take them all',
  ];
  for (const line of kissOffs) assert.deepEqual(kissFlags(line), [KISS_OFF_TELL], line);
  const plainSpeech = [
    'Take it slow, we got all night', "Take it or leave it, that's the price", 'Take it easy on the gravel', 'Have it your way, Darrell', 'Have a good night, Randy',
    'Take the high road, take the long way home', 'Take your time, take your turn', 'Take my hand, take my name', "Take it all back, you know you lied", 'Have them call me after five',
  ];
  for (const line of plainSpeech) assert.deepEqual(kissFlags(line), [], line);
});
