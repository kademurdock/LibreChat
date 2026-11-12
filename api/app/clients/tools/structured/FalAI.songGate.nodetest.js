/* Nov 10 2026 (the money review): fal_studio generate_song is paid for, so it needs a price
 * heard in an earlier reply and the person's own plain yes, and a reply makes at most one song.
 * The real FalAI.js and the real services/kadeSpendGate.js run here; fal, the database and the
 * usage log are stand-ins, so nothing is spent and no model is called.
 *
 * Run: node --test api/app/clients/tools/structured/FalAI.songGate.nodetest.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { FakeCollection, stubModules } = require('../../../../test/kadeFakeMongo.cjs');

let colls = {};
let posts = [];
let usage = [];
let rejectSubmit = false;

const axios = {
  post: async (url, body) => {
    posts.push({ url, body });
    if (rejectSubmit) throw Object.assign(new Error('422'), { response: { data: { detail: 'bad style' } } });
    return { data: { request_id: 'r1', status_url: 'https://fal.invalid/status', response_url: 'https://fal.invalid/result' } };
  },
  get: async (url) =>
    url.endsWith('/status')
      ? { data: { status: 'COMPLETED' } }
      : { data: { audio: { url: 'https://media.invalid/song.mp3', duration: 95 } } },
};

stubModules({
  axios,
  mongoose: {
    connection: { collection: (name) => (colls[name] = colls[name] || new FakeCollection()) },
    models: {},
    Types: { ObjectId: class {} },
  },
  '@librechat/api': { falStudioSchema: { type: 'object' }, falNarrationInstructions: '' },
  '@librechat/agents/langchain/tools': { Tool: class {} },
  '@librechat/data-schemas': { logger: { warn() {}, info() {}, error() {} } },
  '~/models/kadeUsage': {
    logKadeUsage: async (row) => usage.push(row),
    KadeUsage: {},
    priceFactorForUser: async () => 2,
    refundUsageOnce: async () => {},
  },
  '~/models/kadeAsset': { logKadeAsset: async () => {}, KadeAsset: {} },
  '~/server/services/kadeRealCost': { userPriceFactor: () => 2, payerFromReq: () => null },
  '~/server/services/kadeSpendGate': require(path.join(__dirname, '../../../../server/services/kadeSpendGate')),
});

process.env.KADE_FAL_MONTHLY_CAP_USD = '0';
process.env.FAL_KEY = 'test-only';
const FalAI = require('./FalAI');

/* The song path waits six seconds between status checks; here it does not wait. */
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args);

const turn = (text, extra = {}) => ({ user: { id: 'u1', role: 'USER' }, body: { conversationId: 'c-1', text, agentName: 'Testa', ...extra } });
const song = (req, data = {}) =>
  new FalAI({ req, userId: 'u1', override: true })._call({ action: 'generate_song', prompt: 'slow country waltz, warm voice, fiddle', ...data });
const gate = require(path.join(__dirname, '../../../../server/services/kadeSpendGate'));
/* A first ask whose reply then said the price (the end of that reply stamps it as heard). */
const priced = async (req, data = {}, replyText = 'A song like that is about 16 cents. Want me to make it?') => {
  const out = await song(req, data);
  await gate.afterReply({ req, replyText, agentName: 'Testa' });
  return out;
};

beforeEach(() => {
  colls = {};
  posts = [];
  usage = [];
  rejectSubmit = false;
  delete process.env.KADE_SONG_YES_GATE;
  delete process.env.KADE_SONG_ONCE_PER_TURN;
  delete process.env.KADE_SPEND_PRICE_HEARD;
  delete process.env.KADE_SPEND_NO_REPLAY;
  gate._resetForTests();
});

test('the first ask spends nothing and tells the character to say the price and ask', async () => {
  const out = await priced(turn('make me a song about rain'));
  assert.match(out, /^NOT MADE YET, and nothing was charged\./);
  assert.match(out, /costs them about 16 cents/);
  assert.match(out, /Tell them that price/);
  assert.match(out, /ask if they want it/);
  assert.equal(posts.length, 0);
  assert.equal(usage.length, 0);
});

test('happy path: price in one reply, a plain yes in the next, one song is made and logged', async () => {
  await priced(turn('make me a song about rain'));
  const out = await song(turn('Yes, go ahead'));
  assert.match(out, /^\[Play the song\]\(https:\/\/media\.invalid\/song\.mp3\)/);
  assert.equal(posts.length, 1);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].service, 'fal_song');
});

test('refused: the same reply that first heard the request cannot also buy the song', async () => {
  const req = turn('yes make me a song');
  await song(req);
  const out = await song(req);
  assert.match(out, /^NOT MADE YET/);
  assert.equal(posts.length, 0);
});

test('refused: "ok, read this page for me" is not a yes to the price', async () => {
  await priced(turn('make me a song about rain'));
  const out = await song(turn('ok, read this page for me'));
  assert.match(out, /^NOT MADE YET, and nothing was charged\. Their last message is not a plain yes/);
  assert.match(out, /about 16 cents/);
  assert.equal(posts.length, 0);
});

test('once per reply: three calls in the yes turn make one song', async () => {
  await priced(turn('make me a song about rain'));
  const req = turn('yes');
  const out = await Promise.all([song(req), song(req), song(req)]);
  assert.equal(out.filter((o) => o.startsWith('[Play the song]')).length, 1);
  assert.equal(out.filter((o) => /^NOT MADE, and nothing was charged\. One paid song per reply/.test(o)).length, 2);
  assert.equal(posts.length, 1);
  /* and one more ask later in that same reply only states the price again */
  assert.match(await song(req), /^NOT MADE/);
  assert.equal(posts.length, 1);
});

test('the yes turn sent again (regenerate) does not buy a second song', async () => {
  await priced(turn('make me a song about rain'));
  assert.match(await song(turn('yes')), /^\[Play the song\]/);
  const again = await song(turn('yes'));
  assert.match(again, /^NOT MADE YET/);
  assert.equal(posts.length, 1);
});

test('the price is per engine: a yes to Lyria does not buy a MiniMax song', async () => {
  await priced(turn('make me a song about rain'));
  const out = await song(turn('yes'), { engine: 'minimax' });
  assert.match(out, /^NOT MADE YET/);
  assert.match(out, /MiniMax Music 2\.6 song costs them about 30 cents/);
  assert.equal(posts.length, 0);
});

test('when fal turns the job away nothing is spent and the yes stands for one more try', async () => {
  await priced(turn('make me a song about rain'));
  const req = turn('yes');
  rejectSubmit = true;
  assert.match(await song(req), /^fal did not accept/);
  rejectSubmit = false;
  assert.match(await song(req), /^\[Play the song\]/);
  assert.equal(usage.length, 1);
});

test('a call turn is refused in words that can be spoken, and nothing is spent', async () => {
  const folded =
    '[EARLIER IN THIS CONVERSATION — context only, already handled, do not re-answer:\n' +
    'THEM: make me a song\nYOU: okay, yes, that is 16 cents. Want it?\n' +
    '— end of earlier context. Reply ONLY to what follows.]\n\nyes';
  const out = await song(turn(folded, { conversationId: 'fresh-each-turn' }));
  assert.match(out, /^NOT MADE, and nothing was charged\. A paid song cannot be started from a call yet/);
  assert.match(out, /text chat/);
  assert.equal(posts.length, 0);
});

test('a background run cannot buy a song', async () => {
  const out = await song({ ...turn('yes'), kadeHiddenRun: true });
  assert.match(out, /^NOT MADE, and nothing was charged\. A background job cannot buy a song/);
  assert.equal(posts.length, 0);
});

test('a database problem fails closed: nothing is spent and the character is told plainly', async () => {
  colls.kadesongquotes = {
    findOne: async () => {
      throw new Error('database away');
    },
  };
  const out = await song(turn('yes'));
  assert.match(out, /^NOT MADE, and nothing was charged: the price check had a problem/);
  assert.equal(posts.length, 0);
});

test('the checks that came before still answer first (a missing style never reaches the gate)', async () => {
  const out = await song(turn('yes'), { prompt: '' });
  assert.match(out, /generate_song needs a prompt/);
  assert.equal(colls.kadesongquotes, undefined);
});

/* Nov 12 2026 craft review: the too-long hint used to advise a repeat mark, which an engine may sing as words. */
test('a MiniMax sheet that is too long is told to drop a section and keep every chorus written out, never to write a repeat mark', async () => {
  const lyrics = '[Verse 1]\n' + 'La la la la la la la\n'.repeat(200);
  const out = await song(turn('make it'), { engine: 'minimax', lyrics });
  assert.match(out, /MiniMax Music caps lyrics at 3,500 characters/);
  assert.match(out, /Trim it: drop a verse or the bridge, or shorten the outro\. Keep every chorus written out in full, because the engine may sing a repeat mark aloud\. Or switch engine to 'lyria3_pro'/);
  assert.doesNotMatch(out, /\(repeat\)/);
  assert.equal(usage.length, 0);
  process.env.KADE_LYRIC_CRAFT_NOV12 = '0';
  try {
    assert.match(await song(turn('make it'), { engine: 'minimax', lyrics }), /writing repeated choruses as \[Chorus\] \(repeat\) instead of pasting them in full/, 'KADE_LYRIC_CRAFT_NOV12=0 puts the old hint back');
  } finally {
    delete process.env.KADE_LYRIC_CRAFT_NOV12;
  }
});

test('card 1: KADE_SONG_YES_GATE=0 no longer skips the yes; nothing is spent on the first ask', async () => {
  process.env.KADE_SONG_YES_GATE = '0';
  process.env.KADE_SONG_ONCE_PER_TURN = '0';
  const req = turn('make me a song about rain');
  assert.match(await song(req), /^NOT MADE YET, and nothing was charged\./);
  assert.match(await song(req), /^NOT MADE YET/);
  assert.equal(posts.length, 0);
  assert.equal(usage.length, 0);
});

test('card 1: a replayed yes cannot buy a song, even with KADE_SPEND_NO_REPLAY=0', async () => {
  process.env.KADE_SPEND_NO_REPLAY = '0';
  await priced(turn('make me a song about rain'));
  const out = await song(turn('yes', { isRegenerate: true }));
  assert.match(out, /retry of an earlier one/);
  assert.equal(posts.length, 0);
});
