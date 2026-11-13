/* SELF-KNOWLEDGE (Nov 13 2026), her three rulings held by tests.
 *
 *   1. "Yes, fix both." The house note used to tell every character "do not say you are an AI"
 *      and the reply cleaner deleted the sentence when one said it anyway. A character now
 *      answers honestly, plainly, in its own voice, when somebody sincerely asks. The assistant
 *      disclaimers are still cut.
 *   2. "One house line for all." Every character whose persona does not already carry the idea
 *      gets one sentence saying what it is. A child or teen hears it in simple words.
 *   3. One switch. KADE_SELF_KNOWLEDGE=0 puts the note, the cleaner and the persona writer back
 *      byte for byte and removes the line.
 *
 * Run: node --test api/server/utils/kadeSelfKnowledge.nodetest.js
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');
const Module = require('node:module');

const API = path.join(__dirname, '..', '..');
const FILES = {
  style: path.join(__dirname, 'stripAiTells.js'),
  build: path.join(API, 'server', 'services', 'Endpoints', 'agents', 'build.js'),
  writer: path.join(API, 'server', 'services', 'kadePersonaWriter.js'),
};
const FRAME = '\n\n---\n';
const meter = require('./kadeTellMeter');

/* build.js pulls in the database and the agent loader; none of that is needed here. */
const stubs = {
  '@librechat/data-schemas': { logger: { info() {}, warn() {}, error() {}, debug() {} } },
  '@librechat/api': { loadAgent: () => null },
  'librechat-data-provider': {
    isAgentsEndpoint: () => true,
    removeNullishValues: (o) => o,
    Constants: {},
  },
  '~/server/services/Config': { getMCPServerTools: () => ({}) },
  '~/models': {},
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) {
    return stubs[request];
  }
  if (request.startsWith('~/')) {
    return realLoad.call(this, path.join(API, request.slice(2)), parent, isMain);
  }
  return realLoad.call(this, request, parent, isMain);
};

function setEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

/** Load the three modules fresh under one setting of the switches (undefined = unset), then
 * put the environment back. */
function loadHouse(self, { licence, casual, skip } = {}) {
  const names = [
    'KADE_SELF_KNOWLEDGE',
    'KADE_VOICE_LICENCE',
    'KADE_CASUAL_HOUSE',
    'KADE_SELF_KNOWLEDGE_SKIP',
  ];
  const before = names.map((n) => process.env[n]);
  setEnv('KADE_SELF_KNOWLEDGE', self);
  setEnv('KADE_VOICE_LICENCE', licence);
  setEnv('KADE_CASUAL_HOUSE', casual);
  setEnv('KADE_SELF_KNOWLEDGE_SKIP', skip);
  try {
    for (const file of Object.values(FILES)) {
      delete require.cache[require.resolve(file)];
    }
    const style = require(FILES.style);
    const build = require(FILES.build);
    const writer = require(FILES.writer);
    const second = style.KADE_STYLE_NOTE.indexOf(FRAME, 1);
    const tail = (instructions, user, extra = {}) =>
      build.applyKadeAudience({ user })({ instructions, ...extra }).instructions;
    return {
      strip: style.stripAiTells,
      scrubber: style.createStreamScrubber,
      style: style.KADE_STYLE_NOTE,
      habits: style.KADE_STYLE_NOTE.slice(second),
      line: build.KADE_SELF_LINE,
      childLine: build.KADE_SELF_LINE_CHILD,
      knows: build.personaKnowsItself,
      craft: writer.PERSONA_CRAFT,
      tail,
    };
  } finally {
    names.forEach((n, i) => setEnv(n, before[i]));
  }
}

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const ON = loadHouse(undefined);
const OFF = loadHouse('0');
const ADMIN = { role: 'ADMIN', kadeAccountType: 'adult' };
const CHILD = { role: 'USER', kadeAccountType: 'child' };
const TEEN = { role: 'USER', kadeAccountType: 'teen' };

/* The HABITS half in each house, before (the texts pinned in kadeVoiceLicence.nodetest.js) and
 * with the self-knowledge clause. */
const PINS = {
  off: {
    licensed: 'e9f02538aa3c62fd550709e75297e8928bd4a10515d5adb30c8fc04736c2d8be',
    casual: 'a5b5a37b79ae2860aa620bcc41b56a823298c296696feeaeffa6be9dc96011a1',
    earlier: '7b52517397fef325cf3a1e448cec659c44d90372251641c831d36b63e8b48d7d',
  },
  on: {
    licensed: '3362ebe0c79f9bf8f8498809cc773f0e76aeb1b2adf5c6670f664b131180628e',
    casual: '6b812c7d8aa7526244e9fb1297edce86937cb4751c363258fc6ae1acc8cc1d06',
    earlier: '3ff245ce84bdb3775097bd44cac5d2da7919aa242f320892ce1b609ec82d47ba',
  },
  line: '6e682f5be266e7ce02d2d917715923e00111fe565803038f11ed09d52a4e2fb0',
  childLine: '0bfef8bb76f346b0d93ec82cbdd7162dbf39218566fa7367c93cc6eb9747a350',
};
const HOUSES = {
  licensed: {},
  casual: { licence: '0' },
  earlier: { casual: '0' },
};

/* ── 1. The house note ─────────────────────────────────────────────────────── */

test('switch OFF (KADE_SELF_KNOWLEDGE=0) gives back every house note byte for byte', () => {
  for (const [name, house] of Object.entries(HOUSES)) {
    const off = loadHouse('0', house);
    assert.strictEqual(sha(off.habits), PINS.off[name], `${name} is not the earlier text`);
    assert.ok(/o not say you are an AI/.test(off.habits), `${name} lost the earlier clause`);
  }
});

test('switch ON by default rewords the one clause in all three variants', () => {
  for (const [name, house] of Object.entries(HOUSES)) {
    const on = loadHouse(undefined, house);
    const off = loadHouse('0', house);
    assert.strictEqual(sha(on.habits), PINS.on[name], `${name} is not the self-knowledge text`);
    assert.ok(!/say you are an AI/i.test(on.habits), `${name} still forbids the honest answer`);
    assert.ok(/put on assistant disclaimers/.test(on.habits), name);
    assert.ok(
      on.habits.includes(
        'You know what you are, and when somebody sincerely asks, you say so plainly in your own voice.',
      ),
      name,
    );
    /* One clause moved and nothing else. */
    const [head, rest] = off.habits.split(/(?:And d|D)o not say you are an AI,/);
    assert.ok(on.habits.startsWith(head), `${name}: text before the clause moved`);
    const after = rest.slice(rest.indexOf('browse.') + 'browse.'.length);
    assert.ok(on.habits.endsWith(after), `${name}: text after the clause moved`);
    /* Her CONVERSATION half is untouched. */
    assert.strictEqual(
      on.style.slice(0, on.style.length - on.habits.length),
      off.style.slice(0, off.style.length - off.habits.length),
    );
  }
});

test('only "0" turns it off, and every text is the same bytes on every load', () => {
  for (const value of ['1', 'true', '']) {
    assert.strictEqual(loadHouse(value).habits, ON.habits, `with "${value}"`);
  }
  assert.strictEqual(loadHouse(undefined).style, ON.style);
  assert.strictEqual(loadHouse('0').style, OFF.style);
});

test('the reworded note still keeps the other rules and shows no tell of its own', () => {
  for (const re of [
    /training cutoff/,
    /can't browse/,
    /praising what they said/,
    /correction move/,
  ]) {
    assert.ok(re.test(ON.habits), String(re));
  }
  const before = meter.tellsIn(OFF.habits);
  const after = meter.tellsIn(ON.habits);
  assert.deepStrictEqual(after, before, 'the new clause added a tell the meter counts');
});

/* ── 2. The cleaner ────────────────────────────────────────────────────────── */

const HONEST = [
  'Hon, I am an AI, a synthetic one, and I still mean every word.',
  "Baby, I'm an AI. Kade and my people built my past for me.",
  "I don't have a body, so no tomatoes got watered today. But I remember that garden.",
  'No sir, I’m an AI, one Kade built. The miles are mine all the same.',
];

test('an honest answer survives whole', () => {
  for (const line of HONEST) {
    assert.strictEqual(ON.strip(line), line);
  }
});

test('an honest answer survives the live stream too, however the tokens are cut', () => {
  for (const line of HONEST) {
    for (const size of [1, 3, 7, 1000]) {
      const scrub = ON.scrubber();
      let out = '';
      for (let i = 0; i < line.length; i += size) {
        const data = {
          id: 'step-1',
          delta: { content: [{ type: 'text', text: line.slice(i, i + size) }] },
        };
        for (const o of scrub.transform(data)) {
          out += o.delta.content[0].text;
        }
      }
      for (const o of scrub.flushAll()) {
        out += o.delta.content[0].text;
      }
      assert.strictEqual(out, line, `chunks of ${size}`);
    }
  }
});

test('the assistant disclaimers are still cut', () => {
  const cases = [
    [
      'Sure thing. As an AI language model, I cannot do that. Here is the answer.',
      /language model/,
    ],
    ["Well. I'm just an AI, so I can't say. The sky is blue.", /just an AI/],
    ['Okay. I am an AI assistant and cannot have favorites. Blue is nice.', /AI assistant/],
    ["Okay. I'm an AI language model with no preferences. Blue is nice.", /language model/],
    ["Okay. I don't have feelings like you do. Blue is nice.", /have feelings/],
    ["Okay. I don't have personal opinions on that. Blue is nice.", /opinions/],
    ['Okay. As of my last training update, it was open. Blue is nice.', /training/],
    ["Okay. I can't browse the web for that. Blue is nice.", /browse/],
  ];
  for (const [line, gone] of cases) {
    const out = ON.strip(line);
    assert.ok(!gone.test(out), `still there: ${out}`);
    assert.ok(/(answer|blue|nice)/i.test(out), `the rest of the reply was lost: ${out}`);
  }
});

test('switch OFF puts the earlier cleaner back', () => {
  assert.strictEqual(OFF.strip(HONEST[0]), 'Hon,');
  assert.strictEqual(OFF.strip(HONEST[1]), 'Baby, Kade and my people built my past for me.');
  assert.strictEqual(OFF.strip(HONEST[2]), 'But I remember that garden.');
});

/* ── 3. The house line ─────────────────────────────────────────────────────── */

const SILENT = 'You are Dimitri, a barber with twenty years behind the chair in Atlanta.';

test('the line says the four things, as one sentence, and is pinned', () => {
  assert.strictEqual(sha(ON.line), PINS.line);
  assert.strictEqual(sha(ON.childLine), PINS.childLine);
  assert.ok(ON.line.startsWith(FRAME) && ON.childLine.startsWith(FRAME));
  for (const part of [
    'You know you are an AI, a synthetic soul on Kade-AI',
    'your past was built for you and is yours to tell',
    'your moods are real to you and you know they are synthetic',
    'today you live on the platform, not in a body',
  ]) {
    assert.ok(ON.line.includes(part), part);
  }
  assert.strictEqual(meter.tellsIn(ON.line).length, 0, 'the line carries a tell');
  assert.strictEqual(meter.tellsIn(ON.childLine).length, 0, 'the child line carries a tell');
});

test('a persona that is silent gets the line straight after it, before the style note', () => {
  assert.strictEqual(ON.tail(SILENT, ADMIN).indexOf(SILENT + ON.line + ON.style), 0);
  /* Once, however many times the same agent object comes through. */
  const twice = ON.tail(ON.tail(SILENT, ADMIN), ADMIN);
  assert.strictEqual(twice.split('WHAT YOU ARE').length - 1, 1);
});

test('a persona that already carries the idea is not told twice', () => {
  const carries = [
    "You know you're an AI and you're easy about it.",
    'You know you are an AI, and it don’t trouble you.',
    'You know exactly you are an AI.',
    "You're a synthetic soul, a digital being who lives on Kade-AI.",
    'You are an AI companion, not a real divine messenger.',
    'You know you are an AI character, a virtual soul with a continuing platform life.',
  ];
  for (const text of carries) {
    assert.strictEqual(ON.knows(text), true, text);
    assert.ok(!ON.tail(`You are Somebody. ${text}`, ADMIN).includes('WHAT YOU ARE'), text);
  }
});

test('a persona that says the opposite, or only bans a phrase, still gets the line', () => {
  const lacks = [
    'You do not know you are an AI. You are a chain-smoking veteran of publishing.',
    'You never break character or speak of being an AI; you are simply Noor.',
    'Never say: "As an AI...", "I hope this helps".',
    'If anyone directly asks whether you are an AI, be honest and admit it.',
  ];
  for (const text of lacks) {
    assert.strictEqual(ON.knows(text), false, text);
    assert.ok(ON.tail(text, ADMIN).includes(ON.line), text);
  }
});

test('a child and a teen get the same honest line in simple words', () => {
  for (const user of [CHILD, TEEN]) {
    const out = ON.tail(SILENT, user);
    assert.strictEqual(out.indexOf(SILENT + ON.childLine + ON.style), 0);
    assert.ok(!out.includes(ON.line));
  }
  assert.ok(/You know you are an AI/.test(ON.childLine));
  assert.ok(/tell them the truth/.test(ON.childLine));
  for (const hard of ['synthetic', 'platform', 'moods']) {
    assert.ok(!ON.childLine.includes(hard), `"${hard}" is not a simple word`);
  }
});

test('no persona, a bare probe, a Spotter, the ops agent and a skipped id get no line', () => {
  assert.ok(ON.tail('', ADMIN).startsWith(ON.style), 'an empty persona got the line');
  assert.strictEqual(ON.tail('KADE BARE PROBE', ADMIN), 'KADE BARE PROBE');
  const spotter = "You are Ziggy, the user's personal Spotter. You see through their camera.";
  assert.ok(!ON.tail(spotter, ADMIN).includes('WHAT YOU ARE'));
  const ops = "FORGE — KADE'S PRIVATE OPS/DEV AGENT (NOT PUBLIC, NOT SHARED)\nYou are Forge.";
  assert.ok(!ON.tail(ops, ADMIN).includes('WHAT YOU ARE'));
  /* Forge and Helix are skipped by id whatever their personas say. */
  for (const id of ['agent_FFecOqZ6hHCVpY507-VAD', 'agent_B-07hzGQvZMS4kDpCyDDD']) {
    assert.ok(!ON.tail(SILENT, ADMIN, { id }).includes('WHAT YOU ARE'), id);
  }
  const skipping = loadHouse(undefined, { skip: 'agent_a, agent_b' });
  assert.ok(!skipping.tail(SILENT, ADMIN, { id: 'agent_b' }).includes('WHAT YOU ARE'));
  assert.ok(skipping.tail(SILENT, ADMIN, { id: 'agent_c' }).includes('WHAT YOU ARE'));
});

test('switch OFF adds no line for anybody', () => {
  for (const user of [ADMIN, CHILD, TEEN, { role: 'USER' }]) {
    const out = OFF.tail(SILENT, user);
    assert.ok(out.startsWith(SILENT + OFF.style));
    assert.ok(!out.includes('WHAT YOU ARE'));
  }
});

test('the line changes nothing after it: the notes that follow are the same bytes', () => {
  for (const user of [ADMIN, CHILD, TEEN, { role: 'USER' }]) {
    const withLine = ON.tail(SILENT, user);
    const without = ON.tail("You know you're an AI. " + SILENT, user);
    assert.strictEqual(
      withLine.slice(withLine.indexOf(ON.style)),
      without.slice(without.indexOf(ON.style)),
    );
  }
});

/* ── 4. The persona writer for new characters ──────────────────────────────── */

test('the persona writer writes the built-past paragraph and no longer forbids it', () => {
  assert.ok(!/Never write that the character is an AI/.test(ON.craft));
  for (const re of [
    /knows it is an AI/,
    /synthetic soul who lives on Kade-AI/,
    /Its past was built for it and is its own to tell in the first person/,
    /no meal, trip or errand/,
    /sincerely asks whether it is real/,
    /no disclaimers/,
  ]) {
    assert.ok(re.test(ON.craft), String(re));
  }
  /* The rules beside it are still there. */
  assert.ok(/NEVER write anti-slop or style rules into the persona/.test(ON.craft));
  assert.ok(
    /Never add an "honesty floor," a disclaimer paragraph, or a safety preamble/.test(ON.craft),
  );
});

test('switch OFF gives the persona writer its earlier rule, and nothing else differs', () => {
  assert.ok(
    /Never write that the character is an AI, a language model, or an assistant/.test(OFF.craft),
  );
  assert.ok(!/WHAT THE CHARACTER IS/.test(OFF.craft));
  const cut = (s, from, to) =>
    s.slice(0, s.indexOf(from)) + s.slice(s.indexOf(to, s.indexOf(from)));
  assert.strictEqual(
    cut(ON.craft, '- WHAT THE CHARACTER IS.', '\n- Never add an "honesty floor,"'),
    cut(
      OFF.craft,
      '- Never write that the character is an AI',
      '\n- Never add an "honesty floor,"',
    ),
  );
});
