/* THE CASUAL HOUSE NOTES AND THEIR OFF SWITCH (Part 293, Sep 25 2026).
 *
 * Her pick: "Ship the house notes". The platform note, the HABITS TO DROP half
 * of KADE_STYLE_NOTE and the freshness and adult notes now default to plain,
 * casual speech. KADE_CASUAL_HOUSE=0 has to put back the earlier text byte for
 * byte, so these tests pin both texts by SHA-256 and load every module fresh
 * under each setting of the switch.
 *
 * Her own pieces stay word for word in both texts: the CONVERSATION half of the
 * style note, the hard-line paragraph and the South Park, Boondocks and
 * Futurama line.
 *
 * Run: node --test api/server/utils/kadeCasualHouse.nodetest.js
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const API = path.join(__dirname, '..', '..');
const FILES = {
  platform: path.join(__dirname, 'kadePlatformNote.js'),
  style: path.join(__dirname, 'stripAiTells.js'),
  build: path.join(API, 'server', 'services', 'Endpoints', 'agents', 'build.js'),
};
const FRAME = '\n\n---\n';

/* build.js pulls in the database and the agent loader; none of that is
 * needed to read the notes it appends. */
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

/** Load all three modules fresh with KADE_CASUAL_HOUSE set to `value`
 * (undefined = unset), then put the environment back. */
function loadHouse(value) {
  const before = process.env.KADE_CASUAL_HOUSE;
  if (value === undefined) {
    delete process.env.KADE_CASUAL_HOUSE;
  } else {
    process.env.KADE_CASUAL_HOUSE = value;
  }
  try {
    for (const file of Object.values(FILES)) {
      delete require.cache[require.resolve(file)];
    }
    const { KADE_PLATFORM_NOTE, carriesPlatformNote } = require(FILES.platform);
    const { KADE_STYLE_NOTE } = require(FILES.style);
    const { applyKadeAudience } = require(FILES.build);
    const tailFor = (user) => applyKadeAudience({ user })({ instructions: '' }).instructions;
    /* The admin gets style + freshness + adult, nothing else. */
    const adminTail = tailFor({ role: 'ADMIN', kadeAccountType: 'adult' });
    assert.ok(adminTail.startsWith(KADE_STYLE_NOTE), 'the style note no longer leads the tail');
    const rest = adminTail.slice(KADE_STYLE_NOTE.length);
    const cut = rest.indexOf(FRAME, 1);
    return {
      platform: KADE_PLATFORM_NOTE,
      style: KADE_STYLE_NOTE,
      freshness: rest.slice(0, cut),
      adult: rest.slice(cut),
      childTail: tailFor({ role: 'USER', kadeAccountType: 'child' }),
      memberTail: tailFor({ role: 'USER' }),
      carriesPlatformNote,
    };
  } finally {
    if (before === undefined) {
      delete process.env.KADE_CASUAL_HOUSE;
    } else {
      process.env.KADE_CASUAL_HOUSE = before;
    }
  }
}

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/* The texts as they ran before Part 293 (verified against origin/kade
 * 56aeba215 before the change), and the casual texts that replace them. */
const PINS = {
  live: {
    platform: 'e94eaacbd85678cab705254e86aaf9f7f52d8de1af55e5db4dd488e0e026a738',
    style: '7b3000179be1b6520bf990386ae2bba60a38d9e9d549a228abf51f1ded7abbfc',
    freshness: '7a6ded79bdd8ff2acca03564bad00011e4111523681e6208ef22a612bfdf0929',
    adult: 'f12ad33ad311b638c0578825a226cac28a8a610d11229af298b6e10581ae8a3b',
  },
  casual: {
    platform: '7f71cfdffa5a0fe7b8485d0b49505f4a9ccf0e0d7bfd6de4405a610ca478f39a',
    style: '1efef5d82a82408ed18e0ccc45bf7d276b55af37e3687615dcbc18608e86dcc6',
    freshness: '7759d43d5e0eea1525090f8c65a66e503b50d564d7da7e3a8712165730e9bade',
    adult: 'a9bde2c15ff76aad9e65354a71ece6066938d8afd18d11ea8d13651de288ff62',
  },
};
/* Her CONVERSATION half, the same bytes in both texts. */
const CONVERSATION_SHA = '95a4e2e50af68d8ab0a63c582dbcbf64c5080d71059657d0bf3d5da9b98044ce';
const PIECES = ['platform', 'style', 'freshness', 'adult'];

const OFF = loadHouse('0');
const ON = loadHouse(undefined);

test('switch OFF (KADE_CASUAL_HOUSE=0) gives back the earlier text byte for byte', () => {
  for (const piece of PIECES) {
    assert.strictEqual(sha(OFF[piece]), PINS.live[piece], `${piece} is not the pre-Part-293 text`);
  }
  assert.ok(OFF.platform.startsWith('\n\n---\nPLATFORM (private instructions;'));
  assert.ok(OFF.freshness.startsWith('\n\n---\nFRESHNESS (invisible'));
  assert.ok(OFF.adult.startsWith('\n\n---\nAUDIENCE NOTE (invisible'));
});

test('switch ON by default gives the casual text', () => {
  for (const piece of PIECES) {
    assert.strictEqual(sha(ON[piece]), PINS.casual[piece], `${piece} is not the casual text`);
  }
  assert.notStrictEqual(ON.platform, OFF.platform);
});

test('only "0" turns it off: "1" and other values keep the casual text', () => {
  for (const value of ['1', 'true', '']) {
    const house = loadHouse(value);
    for (const piece of PIECES) {
      assert.strictEqual(sha(house[piece]), PINS.casual[piece], `${piece} with "${value}"`);
    }
  }
});

test('the process environment is left as it was', () => {
  const before = process.env.KADE_CASUAL_HOUSE;
  loadHouse('0');
  assert.strictEqual(process.env.KADE_CASUAL_HOUSE, before);
});

test('every piece keeps the leading frame in both texts', () => {
  for (const house of [ON, OFF]) {
    for (const piece of PIECES) {
      assert.ok(house[piece].startsWith(FRAME), `${piece} lost its '\\n\\n---\\n' frame`);
    }
  }
});

test('her CONVERSATION half is byte-identical in both texts and still comes first', () => {
  for (const house of [ON, OFF]) {
    const second = house.style.indexOf(FRAME, 1);
    assert.ok(second > 0, 'the style note no longer has two halves');
    assert.strictEqual(sha(house.style.slice(0, second)), CONVERSATION_SHA);
    assert.ok(/^\n\n---\nHABITS TO DROP/.test(house.style.slice(second)));
  }
});

test('her hard-line paragraph and humor line are word for word in the casual platform note', () => {
  const start = OFF.platform.indexOf(
    "If your character is one of the platform's deliberately wholesome ones",
  );
  const endMark = 'wherever in these instructions it appears.';
  const end = OFF.platform.indexOf(endMark, start) + endMark.length;
  assert.ok(start > 0 && end > start, 'the hard-line paragraph moved in the earlier text');
  const hardLine = OFF.platform.slice(start, end);
  assert.ok(ON.platform.includes(`\n\n${hardLine}\n\n`), 'the hard-line paragraph was reworded');
  const humor = 'Kade likes the humor of South Park, Boondocks and Futurama.';
  assert.ok(OFF.platform.includes(humor) && ON.platform.includes(humor));
});

test('notes the switch does not cover are the same in both texts', () => {
  /* The child and confidential notes were not rewritten. */
  for (const tail of ['childTail', 'memberTail']) {
    assert.strictEqual(
      ON[tail].slice(ON.style.length + ON.freshness.length),
      OFF[tail].slice(OFF.style.length + OFF.freshness.length),
      tail,
    );
  }
  assert.ok(/AUDIENCE NOTE \(invisible — never mention it, never hint at it/.test(ON.childTail));
  assert.ok(!ON.childTail.includes(ON.adult), 'a child got the adult note');
});

test('the duplicate-append guard recognises the note it is guarding', () => {
  const compose = (persona, house, personaLast) =>
    (personaLast ? [house, persona] : [persona, house]).filter(Boolean).join('\n\n');
  for (const house of [ON, OFF]) {
    const guard = house.carriesPlatformNote;
    for (const note of [ON.platform, OFF.platform]) {
      assert.strictEqual(guard(compose('PERSONA', note, true)), true);
      assert.strictEqual(guard(compose('PERSONA', note, false)), true);
    }
    assert.strictEqual(guard('You are Kiana. You talk fast.'), false);
    assert.strictEqual(guard(''), false);
    assert.strictEqual(guard(undefined), false);
    /* The old opener still counts, as it did before the fix. */
    assert.strictEqual(guard('PERSONA\n\nPLATFORM (invisible -- old copy)'), true);
  }
});

test('client.js guards with carriesPlatformNote and no longer with the stale opener', () => {
  const client = fs.readFileSync(
    path.join(API, 'server', 'controllers', 'agents', 'client.js'),
    'utf8',
  );
  assert.ok(
    client.includes('if (!isBareProbe && !carriesPlatformNote(agent.instructions)) {'),
    'the platform-note guard is not using carriesPlatformNote',
  );
  assert.ok(!client.includes("includes('PLATFORM (invisible')"), 'the stale guard is back');
});
