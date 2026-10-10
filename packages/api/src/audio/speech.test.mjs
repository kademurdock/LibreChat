import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('./speech.ts', import.meta.url), 'utf8');
const compiled = { exports: {} };
new Function(
  'require',
  'module',
  'exports',
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
)(require, compiled, compiled.exports);
const { pipeSpeechAudio } = compiled.exports;

const wav = readFileSync(
  new URL('../../../data-provider/src/audio/fixtures/sunfish.wav', import.meta.url),
);
const mp3 = readFileSync(new URL('../../../../client/public/assets/silence.mp3', import.meta.url));

async function serve(callback) {
  const errors = [];
  const server = createServer((req, res) => {
    callback(req, res).catch((error) => {
      errors.push(error);
      res.destroy(error);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return { response, bytes, errors };
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

for (const [name, bytes, claimed, expected] of [
  ['Sunfish WAV', wav, 'audio/mpeg', 'audio/wav'],
  ['real MP3', mp3, 'audio/wav', 'audio/mpeg'],
]) {
  test(`${name}: torn upstream header sets real MIME before any HTTP body, preserving every byte`, async () => {
    const result = await serve(async (_req, res) => {
      await pipeSpeechAudio(
        Readable.from([bytes.subarray(0, 1), bytes.subarray(1, 7), bytes.subarray(7)]),
        res,
        claimed,
      );
    });
    assert.equal(result.response.headers.get('content-type'), expected);
    assert.deepEqual(result.bytes, bytes);
    assert.deepEqual(result.errors, []);
  });
}

test('sequential provider chunks do not rewrite a sent header or end the HTTP response early', async () => {
  const result = await serve(async (_req, res) => {
    await pipeSpeechAudio(Readable.from([mp3]), res, 'audio/mpeg', false);
    assert.equal(res.writableEnded, false);
    await pipeSpeechAudio(Readable.from([mp3]), res, 'audio/mpeg', true);
  });
  assert.equal(result.response.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual(result.bytes, Buffer.concat([mp3, mp3]));
  assert.deepEqual(result.errors, []);
});

test('short upstream audio uses only a safe normalized MIME fallback', async () => {
  const result = await serve(async (_req, res) => {
    await pipeSpeechAudio(Readable.from([Buffer.from([1, 2])]), res, 'audio/x-wav; charset=binary');
  });
  assert.equal(result.response.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(result.bytes, Buffer.from([1, 2]));
});

test('many sentence chunks leave no response listeners behind', async () => {
  const result = await serve(async (_req, res) => {
    const counts = res.eventNames().map((name) => [name, res.listenerCount(name)]);
    for (let i = 0; i < 12; i++)
      await pipeSpeechAudio(Readable.from([mp3]), res, 'audio/mpeg', false);
    assert.deepEqual(
      res.eventNames().map((name) => [name, res.listenerCount(name)]),
      counts,
    );
    res.end();
  });
  assert.deepEqual(result.bytes, Buffer.concat(Array(12).fill(mp3)));
  assert.deepEqual(result.errors, []);
});

test('upstream error before audio preserves the ability to return a normal HTTP error', async () => {
  const result = await serve(async (_req, res) => {
    const broken = new Readable({
      read() {
        this.destroy(new Error('upstream failed'));
      },
    });
    await assert.rejects(pipeSpeechAudio(broken, res, 'audio/mpeg'), /upstream failed/);
    assert.equal(res.headersSent, false);
    assert.equal(broken.destroyed, true);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('upstream failed');
  });
  assert.equal(result.response.status, 502);
  assert.equal(result.bytes.toString(), 'upstream failed');
  assert.deepEqual(result.errors, []);
});

test('client disconnect tears down the upstream stream and removes forwarding listeners', async () => {
  let upstream;
  let settle;
  const stopped = new Promise((resolve) => {
    settle = resolve;
  });
  const server = createServer((_req, res) => {
    let sent = false;
    upstream = new Readable({
      read() {
        if (!sent) {
          sent = true;
          this.push(wav.subarray(0, 44));
        }
      },
    });
    pipeSpeechAudio(upstream, res, 'audio/mpeg').then(
      () => settle(new Error('disconnected stream should fail')),
      () => settle(null),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, {
      signal: controller.signal,
    });
    await response.body.getReader().read();
    controller.abort();
    const error = await stopped;
    assert.equal(error, null);
    assert.equal(upstream.destroyed, true);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('upstream failure after a WAV header closes the HTTP body instead of hanging', async () => {
  let responseDestroyed = false;
  await assert.rejects(
    serve(async (_req, res) => {
      let sent = false;
      const broken = new Readable({
        read() {
          if (sent) return;
          sent = true;
          this.push(wav.subarray(0, 44));
          setImmediate(() => this.destroy(new Error('streaming provider failed')));
        },
      });
      await assert.rejects(pipeSpeechAudio(broken, res, 'audio/mpeg'), /streaming provider failed/);
      responseDestroyed = res.destroyed;
    }),
    /terminated|fetch failed|socket/,
  );
  assert.equal(responseDestroyed, true);
});
