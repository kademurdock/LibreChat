import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const axios = require('axios');
const ts = require('typescript');
const filename = fileURLToPath(new URL('./embedding.ts', import.meta.url));
const loaded = new Module(filename);
loaded.paths = Module._nodeModulePaths(dirname(filename));
loaded._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const { memoryEmbeddingLane, requestMemoryEmbedding, indexedEmbedding, embeddingTextHash, memoryEmbeddingPurpose, memoryEmbeddingTimeoutMs } = loaded.exports;

const env = { KADE_EMBED_MODEL: 'qwen/qwen3-embedding-8b', OPENROUTER_KEY: 'test-only', KADE_EMBED_DIMENSIONS: '32' };
const vector = Array.from({ length: 32 }, (_, index) => index / 100);

test('explicit compatible provider wins, and a missing direct key cannot leak the Google or router key', () => {
  assert.equal(memoryEmbeddingLane({ ...env, KADE_EMBED_GEMINI_KEY: 'other' }).provider, 'compatible');
  assert.equal(memoryEmbeddingLane({ ...env, KADE_EMBED_BASE: 'https://example.org/v1' }), null);
  assert.equal(memoryEmbeddingLane({ ...env, KADE_EMBED_BASE: 'http://example.org/v1', KADE_EMBED_KEY: 'direct' }), null);
  assert.equal(memoryEmbeddingLane({ ...env, KADE_EMBED_DIMENSIONS: '31' }), null);
  assert.equal(memoryEmbeddingLane({ ...env, KADE_EMBED_BASE: 'broken' }), null);
  assert.equal(memoryEmbeddingLane({ KADE_EMBED_GEMINI_KEY: 'legacy' }).identity, 'gemini-embedding-001');
});

test('a staged vector is usable only for the same model, dimension and unchanged text', () => {
  const model = memoryEmbeddingLane(env).identity;
  const row = { embedModel: 'gemini-embedding-001', embedding: vector, embedNextModel: model,
    embeddingNext: vector, embedNextHash: embeddingTextHash('original') };
  assert.equal(indexedEmbedding(row, model, 'original', 32), vector);
  assert.equal(indexedEmbedding(row, model, 'changed', 32), null);
  assert.equal(indexedEmbedding(row, model, 'original', 33), null);
  assert.equal(indexedEmbedding(row, 'different', 'original', 32), null);
  assert.equal(indexedEmbedding({ ...row, embeddingNext: vector.map(() => NaN) }, model, 'original', 32), null);
  assert.equal(indexedEmbedding({ ...row, embeddingNext: vector.map(() => 0) }, model, 'original', 32), null);
});

test('query instructions stay out of documents and every response must have the requested dimensions', async () => {
  const seen = [];
  const original = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    seen.push({ url: config.url, body: JSON.parse(config.data) });
    return { status: 200, statusText: 'OK', headers: {}, config, data: { data: [{ index: 0, embedding: vector }] } };
  };
  try {
    const lane = memoryEmbeddingLane(env);
    assert.deepEqual(await requestMemoryEmbedding(lane, 'my concert', 'query'), vector);
    await requestMemoryEmbedding(lane, 'my concert', 'document');
    assert.match(seen[0].body.input, /^Instruct: .*\nQuery: my concert$/);
    assert.equal(seen[1].body.input, 'my concert');
    assert.equal(seen[0].body.dimensions, 32);
    assert.equal(seen[0].body.provider.max_price.prompt, 0.02);
    await assert.rejects(requestMemoryEmbedding({ ...lane, dimensions: 64 }, 'x'), /invalid vector/);
  } finally { axios.defaults.adapter = original; }
});

test('Oct 16: tool matching has its own instruction, and the turn path waits less than a write', async () => {
  const seen = [];
  const original = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    seen.push({ timeout: config.timeout, body: JSON.parse(config.data) });
    return { status: 200, statusText: 'OK', headers: {}, config, data: { data: [{ index: 0, embedding: vector }] } };
  };
  try {
    const lane = memoryEmbeddingLane(env);
    await requestMemoryEmbedding(lane, 'what is the weather', 'tools');
    await requestMemoryEmbedding(lane, 'what is the weather', 'query');
    await requestMemoryEmbedding(lane, 'what is the weather', 'document');
    assert.match(seen[0].body.input, /^Instruct: Given a user message, retrieve the tool whose description can fulfil the request/);
    assert.match(seen[1].body.input, /personal memories/);
    assert.equal(seen[2].body.input, 'what is the weather');
    assert.deepEqual(seen.map((call) => call.timeout), [3000, 3000, 8000]);
  } finally { axios.defaults.adapter = original; }
  assert.equal(memoryEmbeddingTimeoutMs('query', { KADE_EMBED_TIMEOUT_MS: '2000' }), 2000);
  assert.equal(memoryEmbeddingTimeoutMs('query', { KADE_EMBED_TIMEOUT_MS: 'soon' }), 3000);
  assert.equal(memoryEmbeddingTimeoutMs('query', { KADE_EMBED_TIMEOUT_MS: '10' }), 3000, 'too short to ever answer');
  assert.equal(memoryEmbeddingTimeoutMs('document', { KADE_EMBED_TIMEOUT_MS: '2000', KADE_EMBED_DOC_TIMEOUT_MS: '9000' }), 9000);
  assert.equal(memoryEmbeddingPurpose(memoryEmbeddingLane(env), 'tools'), 'tools');
  assert.equal(memoryEmbeddingPurpose(memoryEmbeddingLane({ KADE_EMBED_GEMINI_KEY: 'legacy' }), 'tools'), 'query');
  assert.equal(memoryEmbeddingPurpose(null, 'document'), 'document');
});
