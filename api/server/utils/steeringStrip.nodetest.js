'use strict';
/* KADE Nov 7 2026: the rooms take %%%steering tags%%% out by structure, so a stray %%% never leaves an orphan closer
 * or a tag's words on the screen.   node --test api/server/utils/steeringStrip.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { stripSteeringTags } = require('./steeringStrip');

/** What the rooms did before: pair the runs from left to right. */
const oldStrip = (text) => text.replace(/%%%[^%]*%%%/g, ' ');
const norm = (text) => text.replace(/\s+/g, ' ').trim();

test('steeringBalance.js is still the proxy file, byte for byte (inworld-tts-proxy 7e474ac, Nov 7 2026)', () => {
  const source = fs.readFileSync(path.join(__dirname, 'steeringBalance.js'), 'utf8').replace(/\r\n/g, '\n');
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  assert.equal(
    hash,
    '9f27b876a530ef9d0531e82aaa2cb1f60760deed0eefe9d5f1902af9364bd8c4',
    'steeringBalance.js was edited here. It is a copy: change inworld-tts-proxy/steering-balance.js (run its tests and ' +
      'its mutation sweep), then copy the file over and update this hash.',
  );
});

test('text with no run of percent signs comes back as the same string', () => {
  for (const text of ['', 'Plain words.', 'Fifty % of it, 50% of that, a single % sign', '%PATH% and %d items']) {
    assert.equal(stripSteeringTags(text), text);
  }
  assert.equal(stripSteeringTags(undefined), '');
  assert.equal(stripSteeringTags(null), '');
  assert.equal(stripSteeringTags(42), '42');
});

test('well-formed tags come out with their words, one replacement where each stood (as the old pattern left them)', () => {
  assert.equal(stripSteeringTags('%%%warm%%% Hello there.'), '  Hello there.');
  assert.equal(
    stripSteeringTags('%%%warm%%% Hello there.\n\n%%%amused and baffled%%% Nothing new here.'),
    '  Hello there.\n\n  Nothing new here.',
  );
  assert.equal(stripSteeringTags('Hi %%%laughs%%% there', '-'), 'Hi - there');
  assert.equal(stripSteeringTags('%%%warm%%% Hello there.'), oldStrip('%%%warm%%% Hello there.'));
});

test("the incident: an empty %%% line in front of the real tag leaves neither the words nor a delimiter behind", () => {
  const reply = "Two different problems.\n\n%%%\n%%%warm and curious%%% So what's the shape of it?";
  const old = oldStrip(reply);
  assert.match(old, /warm and curious/, 'the position pairing leaves the tag words on the screen');
  assert.match(old, /%%%/, 'and an orphan closer');
  const now = stripSteeringTags(reply);
  assert.doesNotMatch(now, /warm and curious/);
  assert.doesNotMatch(now, /%/);
  assert.equal(norm(now), "Two different problems. So what's the shape of it?");
});

// each: [what it is, input, what the screen should say once blanks are collapsed]
const DAMAGED = [
  ['a stray line between paragraphs', 'Hello there.\n\n%%%\nSecond thought.\n\n%%%wry%%% Third.', 'Hello there. Second thought. Third.'],
  ['a stray line after a tag', '%%%warm%%% Hello.\n%%%\nGoodbye.', 'Hello. Goodbye.'],
  ['two stray lines before a tag', 'One.\n\n%%%\n%%%\n%%%dry%%% Two.', 'One. Two.'],
  ['a spaced stray run before a tag', 'One. %%% %%%dry%%% Two.', 'One. Two.'],
  ['a doubled opener', '%%%%%%warm%%% Hello.', 'Hello.'],
  ['a doubled closer', '%%%warm%%%%%% Hello.', 'Hello.'],
  ['padded tags', '%%% warm %%% Hello. %%% amused %%% Bye.', 'Hello. Bye.'],
  ['two-percent delimiters', '%%warm%% Hello there.', 'Hello there.'],
  ['a forgotten closer on its own line', '%%%warm and curious\nHello there.', 'Hello there.'],
  ['a forgotten closer with the speech after it', '%%%warm Hello there.', 'Hello there.'],
  ['CRLF line endings', 'One.\r\n\r\n%%%\r\n%%%dry%%% Two.', 'One. Two.'],
  ['a stray in the middle of a sentence', 'We went %%% home after that.', 'We went home after that.'],
];
for (const [name, input, want] of DAMAGED) {
  test(`damaged: ${name}`, () => {
    const got = stripSteeringTags(input);
    assert.doesNotMatch(got, /%/, `a delimiter is left on the screen: ${JSON.stringify(got)}`);
    assert.equal(norm(got), want);
  });
}

test('the kill switch (KADE_STEERING_BALANCE=0) is exactly the old position pairing', () => {
  const reply = "Two different problems.\n\n%%%\n%%%warm and curious%%% So what's the shape of it?";
  const before = process.env.KADE_STEERING_BALANCE;
  process.env.KADE_STEERING_BALANCE = '0';
  try {
    assert.equal(stripSteeringTags(reply), oldStrip(reply));
  } finally {
    if (before === undefined) delete process.env.KADE_STEERING_BALANCE;
    else process.env.KADE_STEERING_BALANCE = before;
  }
});

test('a reply of well-formed tags reads the same as it did with the old pattern (3,000 generated replies)', () => {
  let seed = 20261107;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const bodies = ['warm', 'amused and baffled', 'wistful, a little teasing', 'fond and curious', 'matter of fact with a bit of pride', 'reset'];
  const sentences = ['Hey, there you are.', 'Nothing new here.', 'How did the thing go?', "Don't step there, that's the bridge.", '50% of it, anyway.'];
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  for (let i = 0; i < 3000; i++) {
    const paragraphs = [];
    for (let p = 1 + Math.floor(rnd() * 4); p > 0; p--) {
      const tag = rnd() < 0.85 ? `%%%${pick(bodies)}%%% ` : '';
      paragraphs.push(tag + [pick(sentences), pick(sentences)].join(' '));
    }
    const reply = paragraphs.join('\n\n');
    assert.equal(norm(stripSteeringTags(reply)), norm(oldStrip(reply)), JSON.stringify(reply));
  }
});

test('it does not throw and does not take long on odd or huge input', () => {
  for (const text of ['%', '%%', '%%%', '%%%%', '%'.repeat(1000), '%%%\n'.repeat(500), 'a%%%b%%%c', '\u0000%%%\u0000%%%']) {
    assert.doesNotThrow(() => stripSteeringTags(text), JSON.stringify(text.slice(0, 20)));
    assert.doesNotMatch(stripSteeringTags(text), /%%/);
  }
  const started = Date.now();
  stripSteeringTags('%%%warm%%% Hello there. '.repeat(5000));
  stripSteeringTags('%'.repeat(140000));
  stripSteeringTags(' '.repeat(140000) + '%%%x');
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});
