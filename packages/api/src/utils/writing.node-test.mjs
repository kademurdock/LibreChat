import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes, createRequire } from 'node:module';
import vm from 'node:vm';
const source = stripTypeScriptTypes(readFileSync(new URL('./writing.ts', import.meta.url), 'utf8'));
const musicSource = stripTypeScriptTypes(readFileSync(new URL('../music/writing.ts', import.meta.url), 'utf8'));
const { musicWritingPrompt, musicWritingSettings, lyricWritingModel, lyricAgentId } = await import('data:text/javascript;base64,' + Buffer.from(musicSource).toString('base64'));
const { writingCost } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('music drafting reads the current Lyric persona while formatting and speech stay untouched', async () => {
  const reads = [];
  let instructions = 'First saved persona: protect meaning and use internal rhyme.';
  const read = async filter => { reads.push(filter); return { instructions }; };
  const first = await musicWritingPrompt('Sound Booth format', { engine: 'yue2', mode: 'write' }, read);
  assert.ok(first.includes(instructions));
  assert.match(first, /multisyllabic/); assert.match(first, /Keep supplied lyrics exactly/);
  assert.match(first, /format above overrides Lyric's default/);
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

test('the real music writing handler sends Lyric instructions and creative settings to Grok and preserves supplied lyrics', async () => {
  const url = new URL('../../../../api/server/routes/kadeSoundBooth.js', import.meta.url), localRequire = createRequire(url);
  const handlers = new Map(), requests = [], ledger = [];
  let instructions = 'Saved Lyric persona v1: connected thoughts and meaningful rhyme.';
  const router = Object.fromEntries(['post', 'get', 'put', 'delete', 'patch', 'use'].map(method => [method, (path, ...values) => handlers.set(method + path, values.at(-1))]));
  const multer = Object.assign(() => ({ single: () => () => {} }), { memoryStorage: () => ({}) });
  const context = { module: { exports: {} }, Buffer, URL, console, process: { env: { REFRAME_PROXY_SECRET: 'fixture' } }, require(name) {
    if (name === 'express') return { Router: () => router, json: () => () => {} };
    if (name === 'multer') return multer;
    if (name === 'axios') return { post: async (_url, body) => { requests.push(body); return { data: { choices: [{ message: { content: 'Intimate R&B with warm piano.\nLyrics:\n[Verse]\nMy exact authored line.\nREADBACK: A quiet song.' } }], usage: { cost: 0.002 } } }; } };
    if (name === '@librechat/api') return { writingCost, musicWritingPrompt, musicWritingSettings, lyricWritingModel, lyricAgentId, createYueRouter: () => () => {}, createEffectsRouter: () => () => {}, createLyricsRouter: () => () => {}, effectsGuide: {} };
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
  assert.equal(requests[0].model, 'x-ai/grok-4.20');
  assert.equal(requests[0].temperature, 0.85);
  assert.equal(requests[0].top_p, 0.95);
  assert.equal(requests[0].reasoning.enabled, false);
  assert.equal(requests[0].reasoning.effort, 'none');
  assert.equal(ledger[0].metadata.model, 'x-ai/grok-4.20');
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
  assert.equal(requests[2].model, 'x-ai/grok-4.20');
  request.body.mode = 'format';
  await handlers.get('post/script')(request, response);
  assert.equal(requests[3].model, 'nousresearch/hermes-4-405b');
  assert.equal(requests[3].temperature, 0.7);
  assert.equal(requests[3].reasoning, undefined);
  assert.equal(requests[3].top_p, undefined);
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
  assert.equal(requests[1][1].model, 'x-ai/grok-4.20');
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
    if (name === '@librechat/api') return { writingCost, musicWritingPrompt, musicWritingSettings, lyricWritingModel, lyricAgentId, createYueRouter: () => () => {}, createEffectsRouter: () => () => {}, createLyricsRouter: () => () => {}, effectsGuide: {} };
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

test('Grok token estimates use Grok prices', () => {
  assert.deepEqual(writingCost({ prompt_tokens: 3000, completion_tokens: 1000 }, lyricWritingModel), { costUSD: 0.00625, measured: false });
});
