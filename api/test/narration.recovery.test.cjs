const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  let response = {
    id: 'own-job',
    userId: 'alice',
    state: 'queued',
    wait: { spoken: 'Waiting for a free graphics card.' },
  };
  let error;
  const urls = [];
  const provider = {
    async get(url) {
      urls.push(url);
      if (error) throw error;
      return { data: response };
    },
    async post() {
      if (error) throw error;
      return { data: { jobId: 'own-job', estimate: {} } };
    },
  };
  const mod = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../app/clients/tools/structured/FalAI.js'), 'utf8'),
    {
      module: mod,
      require: (name) => {
        if (name === 'axios') return provider;
        if (name === '@librechat/agents/langchain/tools') return { Tool: class {} };
        if (name === '@librechat/data-schemas') return { logger: {} };
        if (name.startsWith('~/models/')) return {};
        return require(name);
      },
      process: { env: { BRIDGE_SECRET: 'test-only' } },
      URLSearchParams,
      console,
    },
  );
  const tool = Object.create(mod.exports.prototype);
  tool.userId = 'alice';
  tool.resolveAudioRefs = async () => ({ urls: [] });
  return {
    tool,
    urls,
    respond: (value) => {
      response = value;
    },
    fail: (value) => {
      error = value;
    },
  };
}

test('narration status sends both the authenticated owner and exact job and relays real wait state', async () => {
  const f = fixture();
  const result = await f.tool.checkNarration({ job_id: 'own-job' });
  const query = new URL(f.urls[0]).searchParams;
  assert.equal(query.get('userId'), 'alice');
  assert.equal(query.get('jobId'), 'own-job');
  assert.match(result, /Waiting for a free graphics card/);
  assert.doesNotMatch(result, /phone buzzes|minute\(s\)/);
});

test('narration tool never exposes a different owner or substituted job', async () => {
  const f = fixture();
  for (const row of [
    { id: 'own-job', userId: 'bob' },
    { id: 'different-job', userId: 'alice' },
  ]) {
    f.respond({ ...row, state: 'done', result: { url: 'https://private.example/audio' } });
    const result = await f.tool.checkNarration({ job_id: 'own-job' });
    assert.match(result, /could not be verified/);
    assert.doesNotMatch(result, /private.example/);
  }
});

test('expired and failed narration reports do not invent absence or final charges', async () => {
  const f = fixture();
  f.respond({ id: 'own-job', userId: 'alice', state: 'failed', error: 'GPU timed out' });
  const failed = await f.tool.checkNarration({ job_id: 'own-job' });
  assert.match(failed, /does not confirm the final provider charge/);
  assert.doesNotMatch(failed, /Nothing more was charged/);
  f.fail({ response: { status: 404 } });
  assert.match(await f.tool.checkNarration({ job_id: 'expired' }), /may have expired/);
  assert.match(await f.tool.checkNarration({}), /older audio/);
});

test('an uncertain narration start asks for status before a new paid render', async () => {
  const f = fixture();
  f.fail(new Error('connection lost'));
  const result = await f.tool.generateNarration({ prompt: 'Invented spoken line.' });
  assert.match(result, /may already be queued/);
  assert.match(result, /check_narration/);
  assert.match(result, /do not start another automatically/);
});
