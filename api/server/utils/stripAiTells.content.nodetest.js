const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const candidate = require('./stripAiTells');
const { positive, stock, outOfScope } = require('./stripAiTells.content.fixtures.cjs');

for (const [name, text] of positive) {
  test(`preserves ${name} in saved and transmitted text`, () => {
    assert.equal(candidate.stripAiTells(text), text);
    const message = {
      text,
      content: [{ type: 'text', text }, { type: 'metadata', value: 'synthetic' }],
    };
    const before = JSON.stringify(message);
    const transmitted = candidate.scrubMessageForTransmit(message);
    assert.equal(transmitted.text, text);
    assert.equal(transmitted.content[0].text, text);
    assert.deepEqual(transmitted.content[1], message.content[1]);
    assert.equal(JSON.stringify(message), before, 'input message must not mutate');
  });
}

function streamText(text, chunkSize, contentShape = 'string') {
  const scrubber = candidate.createStreamScrubber();
  let shown = '';
  function append(events) {
    for (const event of events) {
      const content = event.delta.content;
      shown += typeof content === 'string' ? content : content[0].text;
    }
  }
  for (let start = 0; start < text.length; start += chunkSize) {
    const chunk = text.slice(start, start + chunkSize);
    const content = contentShape === 'string' ? chunk : [{ type: 'text', text: chunk }];
    append(scrubber.transform({ id: 'synthetic', delta: { content } }));
  }
  append(scrubber.flushAll());
  return shown;
}

for (const [name, text] of positive.filter(([, text]) => !text.includes('```'))) {
  test(`preserves ${name} across actual live-stream chunk boundaries`, () => {
    for (const size of [1, 7, 31, text.length]) {
      assert.equal(streamText(text, size), text, `string deltas, chunk size ${size}`);
      assert.equal(streamText(text, size, 'array'), text, `array deltas, chunk size ${size}`);
    }
  });
}

for (const [name, text, expected] of stock) {
  test(`retains existing removal: ${name}`, () => {
    assert.equal(candidate.stripAiTells(text), expected);
  });
}

test('historically deleted corrected facts and specific tastes survive', () => {
  const correction = "You're right: the appointment is Friday at six. I had Thursday written down.";
  const feeling = 'I love how the bass comes in late. It makes the chorus hit harder.';
  const song = 'I love that song. The bass line is filthy.';
  assert.equal(
    candidate.stripAiTells(correction),
    correction,
  );
  assert.equal(
    candidate.stripAiTells(feeling),
    feeling,
  );
  assert.equal(
    candidate.stripAiTells(song),
    song,
  );
});

test('never-empty behavior remains for one-sentence stock responses', () => {
  for (const text of ["You're right.", 'I love that!', 'Certainly!', "That's the trap."]) {
    assert.equal(candidate.stripAiTells(text), text);
  }
});

test('fenced code remains byte-identical, including phrase-ban text', () => {
  const text = 'Run this:\n```js\nconst tell = "Great question!";\nconst feeling = "I love that song.";\n```';
  assert.equal(candidate.stripAiTells(text), text);
});

test('user-created messages remain untouched', () => {
  const message = { isCreatedByUser: true, text: 'Great question! Hope this helps!' };
  assert.equal(candidate.scrubMessageForTransmit(message), message);
});

test('house instructions and examples are unchanged', () => {
  /* Nov 12 2026: KADE_VOICE_LICENCE (default on) drops "dialect quota" from the CONVERSATION
   * half and the printed word list from the casual HABITS half; =0 gives the earlier bytes. */
  const licence = process.env.KADE_VOICE_LICENCE !== '0';
  /* Nov 13 2026: KADE_SELF_KNOWLEDGE (default on) rewords the one "do not say you are an AI"
   * clause in the HABITS half; =0 gives the earlier bytes. */
  const before = process.env.KADE_CASUAL_HOUSE === '0'
    ? licence
      ? '06063903b9980385a484d442eed34f42929f1093cf42c8d56c255e02e18795ac'
      : '7b3000179be1b6520bf990386ae2bba60a38d9e9d549a228abf51f1ded7abbfc'
    : licence
      ? '892cd428c2568d2684658da34d1b69886ba836d18ccfb400ad64bda6c564f2ca'
      : '1efef5d82a82408ed18e0ccc45bf7d276b55af37e3687615dcbc18608e86dcc6';
  const withSelfKnowledge = process.env.KADE_CASUAL_HOUSE === '0'
    ? licence
      ? '135cddb13aafe6d3c146684067f6d5edd3eb017bb20bf64338eb56d161e09c6e'
      : 'f2839903b068b04f5560488e0cebb202abf14af806109e792610dfbbdd204964'
    : licence
      ? '1db0e43454811f78d197dc8d38455ecb75303b9b00766e82097dfa22f0198309'
      : 'f00019db5a92bacec4d0acd3e399da8d076f8fb49a46ee271d58f2af95c25f1f';
  const expected = process.env.KADE_SELF_KNOWLEDGE !== '0' ? withSelfKnowledge : before;
  assert.equal(createHash('sha256').update(candidate.KADE_STYLE_NOTE).digest('hex'), expected);
});

test('known out-of-scope deletions remain explicit', () => {
  for (const [, text, expected] of outOfScope) {
    assert.equal(candidate.stripAiTells(text), expected);
    assert.notEqual(candidate.stripAiTells(text), text);
  }
});
