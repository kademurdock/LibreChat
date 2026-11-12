/* TURN-7 (turn audit, Nov 12 2026): the live tell-scrubber must give the same text however the
 * reply is split into deltas, must not drop words when a stream degrades to raw, and must not
 * re-scrub the whole prefix on every delta.
 *   node --test api/server/utils/stripAiTells.splits.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createStreamScrubber } = require('./stripAiTells');

/* scrubCore is not exported; load the module's own source to reach it (no requires inside). */
function loadScrubCore() {
  const src = fs.readFileSync(path.join(__dirname, 'stripAiTells.js'), 'utf8');
  const mod = { exports: {} };
  vm.runInNewContext(`${src}\n;module.exports.scrubCore = scrubCore;`, {
    module: mod,
    exports: mod.exports,
    process,
    console,
  });
  return mod.exports.scrubCore;
}
const scrubCore = loadScrubCore();

const fixtures = [
  'It costs 3.5 dollars. The other one is 12.75, which is more. Done.',
  'The U.S. office opens at 9. The U.K. one at 10, e.g. after the train. Fine.',
  'Go to example.com and look under help. Then call me back.',
  '"Is that it?" she asked. "Yes." Okay then.',
  'Here is the code:\n\n```js\nconst x = 1.5;\n```\n\n\n\nThat is all of it.',
  "Here's the thing: it costs 3.5 dollars. That's the whole design. Done.",
  'As an AI model, I think the 2.5 version wins. Great question! It is cheaper by 1.25.',
  'Line one.\n\n\n\nLine two after blank lines. Line three? Yes! End.',
];

/* Feed `parts` through one scrubber; return the joined text it emitted. `exact`: the stream
 * must never fall back to raw passthrough (a passthrough hands back the input object). */
function run(parts, exact = true) {
  const s = createStreamScrubber();
  let out = '';
  for (const part of parts) {
    const data = { id: 'step-1', delta: { content: [{ type: 'text', text: part }] } };
    for (const o of s.transform(data)) {
      if (exact) assert.notStrictEqual(o, data, 'a returned object is never the input object');
      out += o.delta.content[0].text;
    }
  }
  for (const o of s.flushAll()) out += o.delta.content[0].text;
  return out;
}

function splitAt(text, cuts) {
  const parts = [];
  let from = 0;
  for (const c of cuts) {
    parts.push(text.slice(from, c));
    from = c;
  }
  parts.push(text.slice(from));
  return parts.filter((p) => p !== '');
}

function steps(text, n) {
  const parts = [];
  for (let i = 0; i < text.length; i += n) parts.push(text.slice(i, i + n));
  return parts;
}

test('the same text however the reply is split (every index, nearby pairs, fixed steps)', () => {
  for (const reply of fixtures) {
    const want = scrubCore(reply, false, true);
    for (let i = 1; i < reply.length; i++) {
      assert.strictEqual(run(splitAt(reply, [i])), want, `split at ${i}: ${JSON.stringify(reply)}`);
      for (const d of [1, 2, 3]) {
        if (i + d < reply.length) {
          assert.strictEqual(run(splitAt(reply, [i, i + d])), want, `split at ${i},${i + d}`);
        }
      }
    }
    for (const n of [1, 2, 3, 4, 5, 7]) {
      assert.strictEqual(run(steps(reply, n)), want, `steps of ${n}: ${JSON.stringify(reply)}`);
    }
  }
});

test('a split decimal no longer drops the stream to raw (the repro)', () => {
  const out = run(["Here's the thing: it costs 3.", '5', " dollars. That's the whole design. Done."]);
  assert.strictEqual(out, 'It costs 3.5 dollars. Done.');
});

function wordsInOrder(haystack, needle) {
  const words = needle.split(/\s+/).filter(Boolean);
  let at = 0;
  for (const w of words) {
    const i = haystack.indexOf(w, at);
    if (i < 0) return w;
    at = i + w.length;
  }
  return null;
}

test('no word is lost when a stream degrades', () => {
  const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
  const cases = ['As an AI\nmodel, I think. Fine then.', `${long} here's the thing: nope. End.`];
  for (const reply of cases) {
    const want = scrubCore(reply, false, true);
    for (const n of [1, 2, 3, 5, 7]) {
      const out = run(steps(reply, n), false);
      assert.ok(!out.includes('AImodel'), `no glued words (steps ${n}): ${JSON.stringify(out)}`);
      const missing = wordsInOrder(out, want);
      assert.strictEqual(missing, null, `lost "${missing}" at steps of ${n}: ${JSON.stringify(out)}`);
    }
    for (let i = 1; i < reply.length; i++) {
      const out = run(splitAt(reply, [i]), false);
      assert.ok(!out.includes('AImodel'));
      assert.strictEqual(wordsInOrder(out, want), null, `split at ${i}`);
    }
  }
});

test('tiny deltas cost about what whole sentences cost (one scrub per sentence, not per delta)', () => {
  /* Machine-independent: the old scrubber re-scrubbed the whole prefix on every delta, so
   * 3-character deltas cost about 24 times what one-delta-per-sentence costs on this text
   * (measured on kadepc: 25K chars, 21.8 s before, 4.2 s after). Now a delta that does not
   * move the cut does nothing, so the two cost about the same. */
  const sentence = 'The price was 3.5 dollars and the train left at 6.40 from platform two. ';
  let reply = '';
  while (reply.length < 8000) reply += sentence;
  const want = scrubCore(reply, false, true);
  const time = (parts) => {
    const t0 = process.hrtime.bigint();
    const out = run(parts);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.strictEqual(out, want);
    return ms;
  };
  const bySentence = splitAt(
    reply,
    Array.from({ length: Math.floor(reply.length / sentence.length) }, (_, i) => (i + 1) * sentence.length),
  );
  time(bySentence); /* warm up */
  const whole = Math.max(time(bySentence), 5);
  const tiny = time(steps(reply, 3));
  assert.ok(tiny < whole * 6, `3-char deltas ${tiny.toFixed(0)} ms vs sentence deltas ${whole.toFixed(0)} ms`);
});
