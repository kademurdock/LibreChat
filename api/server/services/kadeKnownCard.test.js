/* Nov 11 2026 (card 8): "what do you know about me", "you remember that wrong", "forget that".
 * Plain node:test, no model, no network, no database:
 *   node --test api/server/services/kadeKnownCard.test.js
 * (kadeSpendGate reads its yes words through kadeApprovals, which loads @librechat/data-schemas
 * for its logger; run with NODE_PATH pointing at an installed copy's node_modules.)
 * Storage is an in-memory stand-in. Every person and fact here is made up. */
const test = require('node:test');
const assert = require('node:assert/strict');

const K = require('./kadeKnownCard');
const T = require('./kadeKnownTombstones');
const lanes = require('./kadeLaneTrustAdapter');

const A = '64a000000000000000000001';
const B = '64b000000000000000000002';
const AGENT = 'agent_harley';
const OTHER_AGENT = 'agent_della';

function tombColl() {
  const rows = [];
  let n = 0;
  return {
    rows,
    find: (f) => ({ limit: () => ({ toArray: async () => rows.filter((r) => r.userId === f.userId) }) }),
    insertOne: async (d) => rows.push({ _id: `t${++n}`, ...d }),
    deleteMany: async (f) => {
      const ids = f._id && f._id.$in;
      let k = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].userId === f.userId && (!ids || ids.includes(rows[i]._id))) {
          rows.splice(i, 1);
          k += 1;
        }
      }
      return { deletedCount: k };
    },
  };
}

function pendingColl() {
  const rows = [];
  const match = (r, f) =>
    Object.entries(f).every(([k, v]) => (v && typeof v === 'object' && v.$gte ? r[k] >= v.$gte : r[k] === v));
  return {
    rows,
    findOne: async (f) => rows.find((r) => match(r, f)) || null,
    insertOne: async (d) => rows.push({ ...d }),
    deleteMany: async (f) => {
      for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], f)) rows.splice(i, 1);
    },
  };
}

const card = (userId, agentId, key, value, extra = {}) => ({ userId, agentId, key, value, type: 'fact', status: 'active', updated_at: new Date('2026-11-01T12:00:00Z'), ...extra });

function world(cards) {
  const w = {
    cards,
    deleted: [],
    corrected: [],
    marksCleared: [],
    carriers: [],
    cleared: [],
    pending: pendingColl(),
    tombs: tombColl(),
  };
  w.deps = {
    /* A store that wrongly returns another person's rows too: the service must drop them. */
    cards: async (userId, agentId) => w.cards.filter((c) => c.agentId == null || c.agentId === agentId).map((c) => ({ ...c })),
    deleteCard: async ({ userId, agentId, key }) => {
      const i = w.cards.findIndex((c) => c.userId === userId && (c.agentId || null) === (agentId || null) && c.key === key);
      if (i < 0) return { ok: false };
      w.cards.splice(i, 1);
      w.deleted.push({ userId, agentId, key });
      return { ok: true };
    },
    correctCard: async ({ userId, agentId, key, value }) => {
      const c = w.cards.find((x) => x.userId === userId && (x.agentId || null) === (agentId || null) && x.key === key);
      if (!c) return { ok: false };
      w.corrected.push({ key, before: c.value, after: value });
      c.value = value;
      c.correctionLocked = true;
      return { ok: true };
    },
    clearAll: async ({ userId, agentId }) => {
      const before = w.cards.length;
      w.cards = w.cards.filter((c) => !(c.userId === userId && (c.agentId == null || c.agentId === agentId)));
      w.cleared.push({ userId, agentId });
      return before - w.cards.length;
    },
    clearMarks: async (row) => w.marksCleared.push(row),
    removeCarriers: async (row) => {
      w.carriers.push(row);
      return 2;
    },
    addTombstone: (row) => T.add(row),
    liftTombstones: (row) => T.lift(row),
    pending: () => w.pending,
    now: () => new Date('2026-11-11T15:00:00Z'),
  };
  return w;
}

async function inWorld(w, fn) {
  const a = K.__seam.deps;
  const b = T.__seam.coll;
  K.__seam.deps = w.deps;
  T.__seam.coll = w.tombs;
  try {
    return await fn();
  } finally {
    K.__seam.deps = a;
    T.__seam.coll = b;
  }
}

/** A signed-in website turn by `userId`. */
const textReq = (userId, text = 'what do you know about me', convo = 'conv1') => ({ user: { id: userId, role: 'USER' }, body: { text, conversationId: convo } });
/** A plain phone call for `userId`, sent by the bridge's service seat. */
const phoneReq = (userId) => ({ user: { id: 'seat', role: 'ADMIN' }, kadeOnBehalfOf: { id: userId }, body: { text: 'what do you know about me', kadeOnBehalfOf: userId } });

function sampleCards() {
  return [
    card(A, null, 'eye_clinic_visit', 'Her clinic visit is Thursday the 19th at the eye doctor.', { knownSource: 'errand' }),
    card(A, null, 'garden_plans', 'Is planning raised garden beds along the south fence.'),
    card(A, AGENT, 'favorite_song', 'Loves old Patsy Cline records.', { updated_at: new Date('2026-11-05T12:00:00Z') }),
    card(A, null, 'sister_dana', 'Her sister Dana lives in Tulsa.'),
    card(A, null, 'pharmacy_hours', 'The pharmacy closes at 6 on Saturdays.', { knownSource: 'mail' }),
    card(A, null, 'refill_reminder', 'Refill the blood pressure pills.', { type: 'reminder' }),
    card(A, OTHER_AGENT, 'della_only', 'Told Della about the quilt show.'),
    card(B, null, 'marker_b', 'ZEBRA-7731 is the B marker fact about the bakery.'),
  ];
}

/* ── scenario 8, step by step ─────────────────────────────────────────── */

test('scenario 8: counts first, by group, with the someone-else count; reminders and other characters left out', async () => {
  const w = world(sampleCards());
  await inWorld(w, async () => {
    const r = await K.count({ req: textReq(A), agentId: AGENT });
    assert.equal(r.ok, true);
    assert.deepEqual(
      { told: r.counts.told, errand: r.counts.errand, mail: r.counts.mail, others: r.counts.others, total: r.counts.total },
      { told: 3, errand: 1, mail: 1, others: 1, total: 5 },
    );
    assert.equal(r.tellThem, '3 things you told me, 1 from an errand and 1 from your mail. One of them is about someone else. Which would you like to hear?');
    assert.equal(r.counts.softCapChars, 2000);
    assert.equal(r.counts.over, false);
  });
});

test('scenario 8: read one group, with where each came from, by ref and never by key', async () => {
  const w = world(sampleCards());
  await inWorld(w, async () => {
    const r = await K.read({ req: textReq(A), agentId: AGENT, group: 'errand' });
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].fact, 'Her clinic visit is Thursday the 19th at the eye doctor.');
    assert.equal(r.items[0].from, 'from an errand');
    assert.match(r.items[0].ref, /^f[0-9a-f]{6}$/);
    assert.ok(!JSON.stringify(r).includes('eye_clinic_visit'), 'the card key is never handed to the model');
    const others = await K.read({ req: textReq(A), agentId: AGENT, group: 'others' });
    assert.deepEqual(others.items.map((i) => i.fact), ['Her sister Dana lives in Tulsa.']);
    assert.equal(others.items[0].aboutSomeoneElse, true);
    const all = await K.read({ req: textReq(A), agentId: AGENT, group: 'all' });
    assert.equal(all.items.length, 5);
    assert.ok(!all.items.some((i) => /quilt|ZEBRA|Refill/.test(i.fact)), 'no other character\'s card, no other person\'s, no reminder');
  });
});

test('scenario 8: forget deletes in code, reads back what was forgotten, tombstones it and clears what carried it', async () => {
  const w = world(sampleCards());
  await inWorld(w, async () => {
    const { items } = await K.read({ req: textReq(A), agentId: AGENT, group: 'errand' });
    const r = await K.forget({ req: textReq(A, 'forget that'), agentId: AGENT, ref: items[0].ref });
    assert.equal(r.ok, true);
    assert.equal(r.forgotten, 'Her clinic visit is Thursday the 19th at the eye doctor.');
    assert.match(r.tellThem, /^Forgotten: "Her clinic visit is Thursday the 19th at the eye doctor\."/);
    assert.match(r.tellThem, /still be in your old chats/);
    assert.deepEqual(w.deleted, [{ userId: A, agentId: null, key: 'eye_clinic_visit' }]);
    assert.deepEqual(w.marksCleared, [{ userId: A, agentId: null, key: 'eye_clinic_visit' }]);
    assert.equal(w.carriers.length, 1);
    assert.equal(r.alsoRemoved, 2);
    assert.equal(w.tombs.rows.length, 1);
    assert.ok(!JSON.stringify(w.tombs.rows).match(/clinic|eye|thursday/i), 'the tombstone keeps no words');
    /* the same fact, written again by any writer, is refused; B is never affected */
    assert.equal(await T.blocks(A, 'Clinic visit on Thursday the 19th with the eye doctor.'), true);
    assert.equal(await T.blocks(B, 'Clinic visit on Thursday the 19th with the eye doctor.'), false);
    /* and it is gone from the card */
    const again = await K.count({ req: textReq(A), agentId: AGENT });
    assert.equal(again.counts.errand, 0);
    /* a stale ref is refused plainly, nothing else deleted */
    const stale = await K.forget({ req: textReq(A), agentId: AGENT, ref: items[0].ref });
    assert.equal(stale.ok, false);
    assert.equal(w.deleted.length, 1);
  });
});

test('a failed delete is never reported as forgotten', async () => {
  const w = world(sampleCards());
  w.deps.deleteCard = async () => ({ ok: false });
  await inWorld(w, async () => {
    const { items } = await K.read({ req: textReq(A), agentId: AGENT, group: 'told' });
    const r = await K.forget({ req: textReq(A), agentId: AGENT, ref: items[0].ref });
    assert.equal(r.ok, false);
    assert.match(r.tellThem, /do not say it is gone/);
    assert.equal(w.tombs.rows.length, 0);
  });
});

test('remember wrong: the correction is saved as theirs, the old wording is tombstoned, a told-again fact is lifted', async () => {
  const w = world(sampleCards());
  await inWorld(w, async () => {
    const { items } = await K.read({ req: textReq(A), agentId: AGENT, group: 'errand' });
    const r = await K.correct({ req: textReq(A, 'you have that wrong'), agentId: AGENT, ref: items[0].ref, value: 'Her clinic visit moved to Friday the 20th.' });
    assert.equal(r.ok, true);
    assert.deepEqual(w.corrected, [{ key: 'eye_clinic_visit', before: 'Her clinic visit is Thursday the 19th at the eye doctor.', after: 'Her clinic visit moved to Friday the 20th.' }]);
    assert.equal(await T.blocks(A, 'Clinic visit Thursday the 19th at the eye doctor.'), true, 'the wrong version does not come back');
    assert.equal(await T.blocks(A, 'Her clinic visit moved to Friday the 20th.'), false, 'the right one is not blocked');
    /* telling a forgotten fact again on purpose lifts it */
    const { items: told } = await K.read({ req: textReq(A), agentId: AGENT, group: 'told' });
    const garden = told.find((i) => /garden/.test(i.fact));
    await K.forget({ req: textReq(A), agentId: AGENT, ref: garden.ref });
    assert.equal(await T.blocks(A, 'Is planning raised garden beds along the south fence.'), true);
    const sd = told.find((i) => /Dana/.test(i.fact));
    await K.correct({ req: textReq(A), agentId: AGENT, ref: sd.ref, value: 'Planning raised garden beds along the south fence, and her sister Dana lives in Tulsa.' });
    assert.equal(await T.blocks(A, 'Is planning raised garden beds along the south fence.'), false);
  });
});

test('forget everything from my mail is one command and touches only mail', async () => {
  const w = world(sampleCards());
  await inWorld(w, async () => {
    const r = await K.forgetSource({ req: textReq(A), agentId: AGENT, source: 'mail' });
    assert.equal(r.ok, true);
    assert.equal(r.forgottenCount, 1);
    assert.deepEqual(w.deleted.map((d) => d.key), ['pharmacy_hours']);
    assert.match(r.tellThem, /still in that chat/);
    const bad = await K.forgetSource({ req: textReq(A), agentId: AGENT, source: 'told' });
    assert.equal(bad.ok, false);
  });
});

test('forget everything asks first, then needs a plain yes in the NEXT message; anything else closes it', async () => {
  const w = world(sampleCards());
  await inWorld(w, async () => {
    const ask = textReq(A, 'forget everything');
    const first = await K.forgetAll({ req: ask, agentId: AGENT });
    assert.equal(first.needsYes, true);
    assert.equal(first.count, 6);
    assert.match(first.tellThem, /^That is 5 things, and 1 saved reminder kept with them\./);
    assert.equal(w.cleared.length, 0);
    /* the same reply cannot answer its own question */
    const same = await K.forgetAll({ req: ask, agentId: AGENT });
    assert.equal(same.ok, false);
    assert.equal(same.why, 'same-turn');
    /* a later message that is not a plain yes closes it */
    const no = await K.forgetAll({ req: textReq(A, 'hmm, what would that do to my reminders?'), agentId: AGENT });
    assert.equal(no.ok, false);
    assert.equal(no.why, 'no-yes');
    assert.equal(w.cleared.length, 0);
    const late = await K.forgetAll({ req: textReq(A, 'yes'), agentId: AGENT });
    assert.equal(late.needsYes, true, 'after a no, a bare yes only starts a new ask');
    /* ask again, then yes */
    const yes = await K.forgetAll({ req: textReq(A, 'yes, forget it all'), agentId: AGENT });
    assert.equal(yes.ok, true);
    assert.equal(yes.forgottenCount, 6);
    assert.deepEqual(w.cleared, [{ userId: A, agentId: AGENT }]);
    assert.ok(w.cards.some((c) => c.userId === B), 'B is untouched');
    assert.ok(w.cards.some((c) => c.agentId === OTHER_AGENT), 'another character\'s own bucket is untouched');
  });
});

test('a regenerated reply can never be the yes to forget everything', async () => {
  const w = world(sampleCards());
  await inWorld(w, async () => {
    await K.forgetAll({ req: textReq(A, 'forget everything'), agentId: AGENT });
    const regen = textReq(A, 'yes');
    regen.body.isRegenerate = true;
    const r = await K.forgetAll({ req: regen, agentId: AGENT });
    assert.equal(r.ok, false);
    assert.equal(w.cleared.length, 0);
  });
});

/* ── lanes ────────────────────────────────────────────────────────────── */

test('only the signed-in app or website: a phone call, a paired phone, a hidden run and an unknown caller read nothing', async () => {
  const w = world(sampleCards());
  let read = 0;
  const cards = w.deps.cards;
  w.deps.cards = async (...a) => {
    read += 1;
    return cards(...a);
  };
  await inWorld(w, async () => {
    const phone = await K.count({ req: phoneReq(A), agentId: AGENT });
    assert.equal(phone.ok, false);
    assert.equal(phone.why, 'phone');
    assert.match(phone.tellThem, /never on a phone call/);
    const f = await K.forgetAll({ req: phoneReq(A), agentId: AGENT });
    assert.equal(f.why, 'phone');
    /* a folded voice history in a plain request is a call too */
    const folded = await K.read({ req: textReq(A, '[earlier in this conversation: THEM: hi] reply only to what follows.] forget that'), agentId: AGENT });
    assert.equal(folded.why, 'phone');
    const hidden = textReq(A);
    hidden.kadeHiddenRun = true;
    assert.equal((await K.count({ req: hidden, agentId: AGENT })).why, 'hidden');
    const unknown = { user: { id: 'seat', role: 'ADMIN' }, kadeOnBehalfOfUnresolved: true, body: {} };
    assert.equal((await K.count({ req: unknown, agentId: AGENT })).why, 'unknown-caller');
    /* the safety lane's helper, when it exists, decides; a paired phone is still refused */
    lanes.__seam.laneTrust = () => 'paired-phone';
    try {
      assert.equal((await K.forget({ req: textReq(A), agentId: AGENT, ref: 'f000000' })).why, 'phone');
    } finally {
      lanes.__seam.laneTrust = null;
    }
    assert.equal(read, 0, 'nothing was read for a refused lane');
    assert.equal(w.deleted.length, 0);
  });
});

test('app voice counts as signed in only when switched on and the bridge says so', async () => {
  const appVoice = { user: { id: 'seat', role: 'ADMIN' }, kadeOnBehalfOf: { id: A }, body: { kadeCallerSignedIn: true, text: 'hi' } };
  assert.equal(lanes.laneOf(appVoice, {}), 'phone');
  assert.equal(lanes.laneOf(appVoice, { KADE_STUDIO_APP_VOICE: '1' }), 'signed-in');
  assert.equal(lanes.laneOf({ ...appVoice, user: { id: 'x', role: 'USER' } }, { KADE_STUDIO_APP_VOICE: '1' }), 'phone');
  assert.equal(lanes.laneOf(textReq(A), {}), 'signed-in');
});

test('off switch: KADE_KNOWN_CARD=0 refuses before anything is read', async () => {
  const w = world(sampleCards());
  await inWorld(w, async () => {
    const r = await K.count({ req: textReq(A), agentId: AGENT, env: { KADE_KNOWN_CARD: '0' } });
    assert.equal(r.ok, false);
    assert.equal(r.why, 'off');
  });
});

test('the size target is reported, never enforced: a long card is not deleted', async () => {
  const many = [];
  for (let i = 0; i < 30; i++) many.push(card(A, null, `fact_${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${i}`.replace(/[0-9]/g, 'x') + i, `Fact number ${i} about the garden, the cat, the porch and the weekly market trip.`));
  const w = world(many.map((c, i) => ({ ...c, key: `fact_${String.fromCharCode(97 + (i % 26))}_${String.fromCharCode(97 + Math.floor(i / 26))}` })));
  await inWorld(w, async () => {
    const r = await K.count({ req: textReq(A), agentId: AGENT });
    assert.equal(r.counts.total, 30);
    assert.ok(r.counts.chars > 2000);
    assert.equal(r.counts.over, true);
    assert.equal(w.deleted.length, 0);
    const page = await K.read({ req: textReq(A), agentId: AGENT, group: 'all' });
    assert.equal(page.items.length, 10);
    assert.equal(page.more, 20);
  });
});

test('about someone else: an explicit tag wins; older cards are read from their key or subject', () => {
  assert.equal(K.aboutOther({ key: 'mom_foot_surgery' }), true);
  assert.equal(K.aboutOther({ key: 'garden', subject: 'granddaughter_birthday' }), true);
  assert.equal(K.aboutOther({ key: 'momentum_at_work' }), false);
  assert.equal(K.aboutOther({ key: 'mom_x', aboutOther: false }), false);
  assert.equal(K.aboutOther({ key: 'garden', aboutOther: true }), true);
  assert.equal(K.sourceOf({}), 'told');
  assert.equal(K.sourceOf({ knownSource: 'mail' }), 'mail');
  assert.equal(K.sourceOf({ knownSource: 'web' }), 'told');
});

/* ── the forgotten fact stays forgotten (plan: "This is tested.") ─────── */

test('same-day memory does not bring a forgotten fact back', async () => {
  const M = require('./kadeSameDayMemory');
  const w = world(sampleCards());
  const saved = [];
  const NOW = new Date('2026-11-10T21:00:00Z');
  const lines = [];
  for (let i = 0; i < 12; i++) {
    const at = new Date(Date.UTC(2026, 10, 10, 15, i));
    lines.push({ messageId: `u${i}`, isCreatedByUser: true, text: i === 0 ? 'My clinic visit is Thursday the 19th at the eye doctor.' : `person line ${i} about the garden beds and the fence`, createdAt: at });
    lines.push({ messageId: `a${i}`, isCreatedByUser: false, content: [{ type: 'text', text: `companion line ${i} about the garden` }], createdAt: new Date(at.getTime() + 20000) });
  }
  await inWorld(w, async () => {
    const { items } = await K.read({ req: textReq(A), agentId: AGENT, group: 'errand' });
    await K.forget({ req: textReq(A), agentId: AGENT, ref: items[0].ref });
    const before = M.__seam.deps;
    M.__seam.deps = {
      log: () => {},
      warn: () => {},
      memoryAllowed: async () => true,
      getSummary: async () => null,
      saveSummary: async (_u, _a, fields) => {
        saved.push(fields.summary);
        return fields.summary;
      },
      scrub: (userId, text) => T.scrub(userId, text),
      policyRevision: async () => 1,
      clearCutoff: async () => null,
      conversations: async () => ['c1'],
      conversationExcluded: async () => false,
      messages: async () => lines,
      permitted: (turns) => turns,
      corrections: async () => [],
      agentName: async () => 'Harley',
      readCap: async () => null,
      claimCap: async () => true,
      markDone: async () => {},
      /* the model writes the forgotten fact straight back into the summary */
      complete: async () => 'SUMMARY:\nShe spent the day on the raised garden beds. Her clinic visit is Thursday the 19th at the eye doctor. She wants cedar boards.',
    };
    try {
      const r = await M.refreshQuiet({ userId: A, agentId: AGENT, now: NOW });
      assert.equal(r.ok, true, JSON.stringify(r));
    } finally {
      M.__seam.deps = before;
    }
  });
  assert.equal(saved.length, 1);
  assert.doesNotMatch(saved[0], /clinic|eye doctor|19th/i);
  assert.match(saved[0], /garden beds/);
  assert.match(saved[0], /cedar boards/);
});

test('the nightly card check does not write a forgotten fact back as a fix', async () => {
  const C = require('./kadeCardCheck');
  const tombs = tombColl();
  const TALK = new Date('2026-11-10T20:00:00Z');
  const run = async (withTomb) => {
    const live = [{ key: 'sister_visit', value: 'Sister Dana visits on Saturday the 15th, driving up from Tulsa.', agentId: AGENT, type: 'fact', sourceKind: 'conversation', sourceConversationIds: ['c1'], sourceMessageId: 'a0', updated_at: new Date(TALK.getTime() + 300000) }];
    const sets = [];
    const msgs = [
      { messageId: 'u0', isCreatedByUser: true, text: 'My sister Dana is visiting on Friday the 14th, she is driving up from Tulsa.', createdAt: TALK },
      { messageId: 'a0', isCreatedByUser: false, content: [{ type: 'text', text: 'That sounds lovely.' }], createdAt: new Date(TALK.getTime() + 30000) },
    ];
    const checks = [];
    const deps = {
      log: () => {},
      warn: () => {},
      clock: () => 0,
      people: async () => [A],
      memoryAllowed: async () => true,
      policyRevision: async () => 1,
      cards: async () => live.map((c) => ({ ...c })),
      liveCard: async (_u, _a, key) => live.find((c) => c.key === key) || null,
      setCard: async (row) => {
        sets.push(row);
        return { ok: true };
      },
      blocks: withTomb ? (userId, text) => T.blocks(userId, text) : undefined,
      ledger: async () => {},
      checks: async () => checks,
      conversationExcluded: async () => false,
      excludedConversations: async () => [],
      messages: async () => msgs,
      clearCutoff: async () => null,
      permitted: (turns) => turns,
      claim: async () => true,
      release: async () => {},
      mark: async () => {},
      prune: async () => 0,
      complete: async () =>
        JSON.stringify({ cards: [{ id: 'c1', verdict: 'wrong', quote: 'My sister Dana is visiting on Friday the 14th', fixed: 'Sister Dana visits on Friday the 14th, driving up from Tulsa.' }] }),
    };
    const before = C.__seam.deps;
    const beforeColl = T.__seam.coll;
    C.__seam.deps = deps;
    T.__seam.coll = tombs;
    const oldFix = process.env.KADE_CARD_CHECK_FIX;
    process.env.KADE_CARD_CHECK_FIX = '1';
    try {
      const r = await C.runCardCheck({ now: new Date('2026-11-11T08:05:00Z') });
      return { r, sets };
    } finally {
      C.__seam.deps = before;
      T.__seam.coll = beforeColl;
      if (oldFix === undefined) delete process.env.KADE_CARD_CHECK_FIX;
      else process.env.KADE_CARD_CHECK_FIX = oldFix;
    }
  };
  /* control: with no tombstone the fix is written (the machinery works) */
  const control = await run(true);
  assert.equal(control.sets.length, 1);
  /* the person forgot the Friday visit: the same fix is now refused */
  const beforeColl = T.__seam.coll;
  T.__seam.coll = tombs;
  await T.add({ userId: A, agentId: AGENT, text: 'Sister Dana visits on Friday the 14th, driving up from Tulsa.' });
  T.__seam.coll = beforeColl;
  const after = await run(true);
  assert.equal(after.sets.length, 0, 'no fix carrying the forgotten fact is written');
  assert.equal(after.r.fixed, 0);
});

test('the keeper\'s own card write respects the same tombstone (the TypeScript twin, same inputs)', async () => {
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const ts = await import(pathToFileURL(path.resolve(__dirname, '../../../packages/data-schemas/src/memory/tombstoneMatch.ts')).href);
  const forgotten = 'Her clinic visit is Thursday the 19th at the eye doctor.';
  const tomb = T.hashes(A, forgotten);
  /* what policy.ts memoryTombstoned computes for a keeper write */
  assert.equal(ts.tombstoneCovers(tomb, ts.tombstoneHashes(A, 'Eye doctor clinic visit Thursday the 19th.')), true);
  assert.equal(ts.tombstoneCovers(tomb, ts.tombstoneHashes(A, 'Loves the eye doctor\'s waiting room fish tank.')), false);
  assert.equal(ts.tombstoneCovers(tomb, ts.tombstoneHashes(B, forgotten)), false);
});
