/* Nov 10 2026: songs by conversation (services/kadeStudio.js) and the YuE2 song charge
 * (services/kadeSongCharge.js), against a stubbed Sound Booth. The stub booth runs the REAL
 * charge gate in front of a fake YuE2 router, the way routes/kadeSoundBooth.js mounts it, so the
 * money rules are the shipped code. No database, no network, no model, no GPU.
 *
 * Run: node --test api/server/services/kadeStudio.nodetest.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FakeCollection, stubModules } = require('../../test/kadeFakeMongo.cjs');

stubModules({ '@librechat/data-schemas': { logger: { warn() {}, info() {}, error() {} } } });
const spend = require('./kadeSpendGate');
const charge = require('./kadeSongCharge');
const studio = require('./kadeStudio');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const CENT = 10000; /* tokenCredits */
const OLD_LINE =
  'YuE2 does not deduct from your credit balance yet, and there is no per-song estimate. GPU time is billed by the second, including startup and two minutes awake after the last job; extra takes and higher settings use more.';

const fold = (lines, last) =>
  '[EARLIER IN THIS CONVERSATION — context only, already handled, do not re-answer:\n' +
  lines.join('\n') +
  '\n— end of earlier context. Reply ONLY to what follows.]\n\n' +
  last;

/** A whole small platform: accounts, balances, a booth, and the collections the code writes. */
function world({ accounts = {}, balances = {}, env = {} } = {}) {
  const w = {
    env,
    accounts: {
      grown: { role: 'USER', kadeAccountType: 'adult' },
      kid: { role: 'USER', kadeAccountType: 'child' },
      boss: { role: 'ADMIN', kadeAccountType: 'adult' },
      seat: { role: 'ADMIN', kadeAccountType: 'adult' },
      ...accounts,
    },
    credits: new Map(Object.entries({ grown: 100 * CENT, kid: 100 * CENT, boss: 0, seat: 0, ...balances })),
    charges: new FakeCollection(),
    quotes: new FakeCollection(),
    drafts: new FakeCollection(),
    tasks: new FakeCollection(),
    usage: [],
    jobs: new Map(),
    posts: [],
    pushes: [],
    renders: [],
    scripts: new Map(),
    seq: 0,
  };
  const wallet = {
    async take(uid, n) {
      await tick();
      const have = w.credits.get(uid) ?? 0;
      if (have < n) return { ok: false, have };
      w.credits.set(uid, have - n);
      return { ok: true, left: have - n };
    },
    async give(uid, n) {
      await tick();
      w.credits.set(uid, (w.credits.get(uid) ?? 0) + n);
    },
  };
  w.chargeDeps = { coll: w.charges, wallet, usage: { row: async (doc) => void w.usage.push(doc) }, env, log() {}, job: async (id) => w.jobs.get(id) || null };

  /* The fake YuE2 router: the booth's own answers, in the booth's own words. */
  const router = (req, res) => {
    const b = req.body;
    const uid = req.user.id;
    if (typeof b.script !== 'string' || b.script.trim().length < 3) return res.status(400).json({ error: 'Describe the music in 3 to 3000 characters.' });
    if (!b.singing && !String(b.lyrics || '').trim()) return res.status(400).json({ error: 'Add the words to sing in Lyrics, up to 8000 characters.' });
    const estimate = { spoken: `${b.count} take${b.count === 1 ? '' : 's'}. ${OLD_LINE}` };
    if (b.estimateOnly) return res.json({ ok: true, estimate });
    if ([...w.jobs.values()].some((j) => j.user === uid && j.active)) {
      return res.status(409).json({ error: 'You already have a YuE2 request in progress. Wait for it before making another.' });
    }
    if (w.submitFails) return res.status(502).json({ ok: false, queued: false, jobId: `yue_${++w.seq}`, error: 'Could not confirm whether one take started.' });
    const id = `yue_${++w.seq}`;
    const job = { id, user: uid, projectId: `p${w.seq}`, state: 'queued', active: true, takes: Array.from({ length: b.count }, () => ({ state: 'queued' })), body: b };
    w.jobs.set(id, job);
    return res.json({ ok: true, queued: true, engine: 'yue2', projectId: job.projectId, jobId: id, estimate });
  };

  /* POST /render as routes/kadeSoundBooth.js mounts it: the style gate, the charge gate, the router. */
  w.render = (uid, body) =>
    new Promise((resolve, reject) => {
      const req = { body, user: { id: uid, ...w.accounts[uid] } };
      const res = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(data) {
          resolve({ status: this.statusCode, ok: this.statusCode < 400, data });
          return this;
        },
        on() {},
      };
      if (body.band && body.band !== 'none' && !w.accounts[uid].pack) {
        return res.status(403).json({ error: 'Styles are part of the Family feature pack.', pack: true });
      }
      if (!charge.chargeOn(env)) return router(req, res);
      return charge.boothGate(req, res, () => router(req, res), w.chargeDeps).catch(reject);
    });

  /* The queue moving a job on: the booth's update hook, then its notify hook. */
  w.move = async (jobId, state, takeStates) => {
    const job = w.jobs.get(jobId);
    job.state = state;
    job.takes = takeStates.map((s) => ({ state: s }));
    job.active = ['queued', 'running'].includes(state);
    const money = await charge.afterJobUpdate(job, w.chargeDeps);
    return money;
  };
  w.announce = (jobId, title = 'Rain Song') => {
    const job = w.jobs.get(jobId);
    const completed = job.takes.filter((t) => t.state === 'done').length;
    return studio.deliver({ job, title, completed, total: job.takes.length, urls: async () => job.takes.filter((t) => t.state === 'done').map((_, i) => `https://files.example/${jobId}_${i + 1}.mp3`) }, w.deps);
  };

  w.booth = {
    render: async (uid, body) => {
      w.renders.push({ uid, body });
      if (w.boothDown) throw new Error('fetch failed');
      return w.render(uid, body);
    },
    status: async (uid, jobId) => {
      const job = w.jobs.get(jobId);
      if (!job || job.user !== uid) return { status: 404, ok: false, data: { error: 'No such sound request on your account.' } };
      const completed = job.takes.filter((t) => t.state === 'done').length;
      return { status: 200, ok: true, data: { jobId, projectId: job.projectId, state: job.state, completed, total: job.takes.length, spoken: `${completed} of ${job.takes.length} takes ready.` } };
    },
    cancel: async (uid, jobId) => {
      const job = w.jobs.get(jobId);
      if (!job || job.user !== uid) return { status: 404, ok: false, data: {} };
      await w.move(jobId, 'cancelled', job.takes.map((t) => (t.state === 'done' ? 'done' : 'cancelled')));
      return { status: 200, ok: true, data: { ok: true, spoken: 'Stop requested for unfinished takes.' } };
    },
    projects: async (uid) => ({
      status: 200,
      ok: true,
      data: { projects: [...w.jobs.values()].filter((j) => j.user === uid).map((j) => ({ id: j.projectId, engine: 'yue2', title: j.body.title, state: j.state, takes: j.takes.filter((t) => t.state === 'done') })) },
    }),
    project: async (uid, projectId) => {
      const job = [...w.jobs.values()].find((j) => j.projectId === projectId && j.user === uid);
      if (!job) return { status: 404, ok: false, data: {} };
      return { status: 200, ok: true, data: { project: { id: projectId, takes: job.takes.filter((t) => t.state === 'done').map((_, i) => ({ url: `https://files.example/${job.id}_${i + 1}.mp3`, seconds: 180 })) } } };
    },
    script: async (uid, body) => {
      const id = `d${++w.seq}`;
      w.scripts.set(id, { uid, state: 'working', body });
      return { status: 202, ok: true, data: { job: id, state: 'working' } };
    },
    scriptJob: async (uid, id) => {
      const d = w.scripts.get(id);
      if (!d || d.uid !== uid) return { status: 404, ok: false, data: { error: 'That draft is gone.' } };
      if (d.state === 'working') return { status: 200, ok: true, data: { state: 'working', seconds: 12 } };
      return { status: 200, ok: true, data: { state: 'done', result: d.result } };
    },
  };

  w.deps = {
    env,
    booth: w.booth,
    quotes: w.quotes,
    drafts: w.drafts,
    charge: w.chargeDeps,
    account: async (id) => (w.accounts[id] ? { id, ...w.accounts[id] } : null),
    audience: async (account) => (account.kadeAccountType === 'adult' && !account.review ? 'explicit' : 'clean'),
    explicit: (text) => /\b(?:damn|hell no)\b/i.test(text),
    turn: {
      post: async (p) => {
        await tick();
        w.posts.push(p);
        return { conversationId: p.conversationId || 'convo-picked', messageId: `m${w.posts.length}`, created: false, agentName: 'Testa' };
      },
      notifyPost: async (p) => {
        w.pushes.push(p);
        return { ok: true, sent: 1 };
      },
    },
  };
  return w;
}

const AGENT = { agentId: 'agent_testa', agentName: 'Testa' };
const SONG = { title: 'Rain Song', direction: 'slow country ballad, acoustic guitar, warm female lead vocal', lyrics: '[Verse]\nRain on the tin roof\n[Chorus]\nLet it rain' };
const reqFor = (uid, text, w, over = {}) => ({ user: { id: uid, role: w.accounts[uid].role }, body: { text, conversationId: 'convo-1', ...over.body }, ...over.req });
const replied = (w, req, replyText = 'That song takes 12 cents from your balance. Want me to make it?') =>
  spend.afterReply({ req, replyText, agentName: AGENT.agentName, env: w.env, colls: { kadesongquotes: w.quotes, kadetaskquotes: w.tasks } });

/** A price given in one turn and heard; returns the quote. */
async function priced(w, uid = 'grown', input = SONG, over = {}) {
  const req = reqFor(uid, 'make me a song about the rain', w, over);
  const q = await studio.quote({ req, ...AGENT, input }, w.deps);
  await replied(w, req, over.reply);
  return q;
}
const yes = (w, uid = 'grown', text = 'yes', over = {}) => reqFor(uid, text, w, over);

/* ------------------------------------------------------------------ quote */

test('quote: the price is 12 cents a take, the song is kept as asked, and nothing is spent or queued', async () => {
  spend._resetForTests();
  const w = world();
  const req = reqFor('grown', 'make me a song about the rain', w);
  const q = await studio.quote({ req, ...AGENT, input: { ...SONG, takes: 2 } }, w.deps);
  assert.equal(q.ok, true);
  assert.match(q.quoteId, /^y[0-9a-f]{12}$/);
  assert.match(q.tellThem, /This takes 24 cents from their balance: 12 cents for each of 2 takes\. A take that fails gets its 12 cents back\./);
  assert.match(q.tellThem, /Do not start it in this reply/);
  assert.equal(w.credits.get('grown'), 100 * CENT, 'a quote spends nothing');
  assert.equal(w.jobs.size, 0);
  assert.deepEqual(w.renders.map((r) => r.body.estimateOnly), [true], 'the booth was only asked for its estimate');
  assert.equal(w.renders[0].uid, 'grown');
  const row = w.quotes.rows[0];
  assert.equal(row.kind, 'studio');
  assert.equal(row.engine, 'yue2');
  assert.equal(row.userId, 'grown');
  assert.equal(row.conversationId, 'convo-1');
  assert.equal(row.body.count, 2);
  assert.equal(row.body.lyrics, SONG.lyrics);
});

test('quote: the booth decides what it will take, and its own words come back', async () => {
  const w = world();
  const none = await studio.quote({ req: reqFor('grown', 'song please', w), ...AGENT, input: { direction: 'x' } }, w.deps);
  assert.equal(none.ok, false);
  assert.match(none.error, /describe the music first/);
  const wordless = await studio.quote({ req: reqFor('grown', 'song please', w), ...AGENT, input: { direction: 'bright pop' } }, w.deps);
  assert.match(wordless.error, /needs its words/);
  const styled = await studio.quote({ req: reqFor('grown', 'song please', w), ...AGENT, input: { ...SONG, style: 'Soul' } }, w.deps);
  assert.equal(styled.ok, false);
  assert.match(styled.error, /the Sound Booth says: Styles are part of the Family feature pack/);
  assert.equal(w.quotes.rows.length, 0, 'a refused song leaves no price behind');
  const family = world({ accounts: { grown: { role: 'USER', kadeAccountType: 'adult', pack: true } } });
  const ok = await studio.quote({ req: reqFor('grown', 'song please', family), ...AGENT, input: { ...SONG, style: 'Soul' } }, family.deps);
  assert.equal(ok.ok, true);
  assert.equal(family.quotes.rows[0].body.band, 'soul');
});

/* ------------------------------------------------------------------ start */

test('start: a heard price and a plain yes in a later message starts one song and takes 12 cents once', async () => {
  spend._resetForTests();
  const w = world();
  const q = await priced(w);
  const s = await studio.start({ req: yes(w), ...AGENT, quoteId: q.quoteId }, w.deps);
  assert.equal(s.ok, true, s.error);
  assert.equal(s.charged, '12 cents');
  assert.match(s.tellThem, /being made now/);
  assert.match(s.tellThem, /12 cents was taken from their balance/);
  assert.equal(w.credits.get('grown'), 88 * CENT);
  assert.equal(w.jobs.size, 1);
  const job = w.jobs.get(s.jobId);
  assert.equal(job.user, 'grown');
  assert.equal(job.body.title, 'Rain Song');
  assert.equal(w.usage.length, 1);
  assert.equal(w.usage[0].service, 'yue2_song');
  assert.equal(w.usage[0].chargedUSD, 0.12);
  assert.equal(w.usage[0].costUSD, 0, "her real GPU cost stays on the take; this row is the person's price");
  const row = w.charges.rows[0];
  assert.equal(row.state, 'charged');
  assert.equal(row.jobId, s.jobId);
  assert.equal(row.origin, 'character');
  assert.equal(row.agentId, 'agent_testa');
  assert.equal(row.conversationId, 'convo-1');
});

test('start: refused in the reply that worked out the price, and nothing is spent', async () => {
  spend._resetForTests();
  const w = world();
  const req = reqFor('grown', 'yes make me a song about the rain', w);
  const q = await studio.quote({ req, ...AGENT, input: SONG }, w.deps);
  const s = await studio.start({ req, ...AGENT, quoteId: q.quoteId }, w.deps);
  assert.equal(s.ok, false);
  assert.equal(s.error, studio.REFUSED.sameTurn);
  assert.equal(w.jobs.size, 0);
  assert.equal(w.credits.get('grown'), 100 * CENT);
});

test('start: refused without a quote, without a yes, when the price was never said, and on a regenerate', async () => {
  spend._resetForTests();
  const w = world();
  const bare = await studio.start({ req: yes(w), ...AGENT }, w.deps);
  assert.equal(bare.error, studio.REFUSED.noQuote);

  const q = await priced(w);
  const question = await studio.start({ req: yes(w, 'grown', 'how long will it take?'), ...AGENT, quoteId: q.quoteId }, w.deps);
  assert.equal(question.error, studio.REFUSED.noYes);
  const page = await studio.start({ req: yes(w, 'grown', 'ok, read this page for me'), ...AGENT, quoteId: q.quoteId }, w.deps);
  assert.equal(page.error, studio.REFUSED.noYes);
  const again = await studio.start({ req: yes(w, 'grown', 'yes', { body: { isRegenerate: true } }), ...AGENT, quoteId: q.quoteId }, w.deps);
  assert.equal(again.error, studio.REFUSED.replay);

  const silent = world();
  const unsaid = await priced(silent, 'grown', SONG, { reply: 'I can make that for you. Shall I?' });
  const s = await studio.start({ req: yes(silent), ...AGENT, quoteId: unsaid.quoteId }, silent.deps);
  assert.equal(s.error, studio.REFUSED.notSaid);
  assert.equal(w.jobs.size + silent.jobs.size, 0);
  assert.equal(w.credits.get('grown'), 100 * CENT);
});

test('start: a price that was not taken up closes, so a later yes to something else buys nothing', async () => {
  spend._resetForTests();
  const w = world();
  const q = await priced(w);
  /* Their next message is a question, answered in a reply: the spend gate closes the price. */
  await replied(w, yes(w, 'grown', 'how long will it take?'), 'A few minutes.');
  const s = await studio.start({ req: yes(w, 'grown', 'sure'), ...AGENT, quoteId: q.quoteId }, w.deps);
  assert.equal(s.ok, false);
  assert.equal(s.error, studio.REFUSED.noQuote);
  assert.equal(w.jobs.size, 0);
});

test('start: a price from another conversation or another person cannot be used', async () => {
  spend._resetForTests();
  const w = world();
  const q = await priced(w);
  const elsewhere = await studio.start({ req: yes(w, 'grown', 'yes', { body: { conversationId: 'convo-2' } }), ...AGENT, quoteId: q.quoteId }, w.deps);
  assert.equal(elsewhere.error, studio.REFUSED.noQuote);
  const other = await studio.start({ req: yes(w, 'kid'), ...AGENT, quoteId: q.quoteId }, w.deps);
  assert.equal(other.error, studio.REFUSED.noQuote);
  assert.equal(w.jobs.size, 0);
});

test('double start: two calls in one reply, or the same yes on two servers, start one song and charge once', async () => {
  spend._resetForTests();
  const w = world();
  const q = await priced(w);
  const one = yes(w);
  const same = await Promise.all([
    studio.start({ req: one, ...AGENT, quoteId: q.quoteId }, w.deps),
    studio.start({ req: one, ...AGENT, quoteId: q.quoteId }, w.deps),
  ]);
  assert.equal(same.filter((r) => r.ok).length, 1);
  assert.equal(same.find((r) => !r.ok).error, studio.REFUSED.oncePerTurn);

  const w2 = world();
  const q2 = await priced(w2);
  const both = await Promise.all([
    studio.start({ req: yes(w2), ...AGENT, quoteId: q2.quoteId }, w2.deps),
    studio.start({ req: yes(w2), ...AGENT, quoteId: q2.quoteId }, w2.deps),
  ]);
  assert.equal(both.filter((r) => r.ok).length, 1);
  assert.equal(both.find((r) => !r.ok).error, studio.REFUSED.taken);
  for (const each of [w, w2]) {
    assert.equal(each.jobs.size, 1);
    assert.equal(each.credits.get('grown'), 88 * CENT, 'charged once');
    assert.equal(each.usage.length, 1);
  }
});

test('a second song while one is in progress: the booth says so in its own words and the 12 cents is not kept', async () => {
  spend._resetForTests();
  const w = world();
  const first = await studio.start({ req: yes(w), ...AGENT, quoteId: (await priced(w)).quoteId }, w.deps);
  assert.equal(first.ok, true);
  const q = await priced(w, 'grown', { ...SONG, title: 'Second' });
  const second = await studio.start({ req: yes(w), ...AGENT, quoteId: q.quoteId }, w.deps);
  assert.equal(second.ok, false);
  assert.match(second.error, /You already have a YuE2 request in progress/);
  assert.equal(w.jobs.size, 1);
  assert.equal(w.credits.get('grown'), 88 * CENT, 'only the first song was paid for');
  assert.deepEqual(w.charges.rows.map((r) => r.state).sort(), ['charged', 'refunded']);
  /* Up to four takes of one song is still one request, as on the booth page. */
  assert.equal(studio.songBody({ ...SONG, takes: 4 }).count, 4);
  assert.equal(studio.songBody({ ...SONG, takes: 9 }).count, 4);
});

/* ------------------------------------------------------------- low balance */

test('low balance: refused in plain words, nothing queued, nothing charged, and the price can still be used after a top-up', async () => {
  spend._resetForTests();
  const w = world({ balances: { grown: 5 * CENT } });
  const q = await priced(w);
  const s = await studio.start({ req: yes(w), ...AGENT, quoteId: q.quoteId }, w.deps);
  assert.equal(s.ok, false);
  assert.equal(s.lowBalance, true);
  assert.match(s.error, /Your balance is too low for this song\. A YuE2 song takes 12 cents and your balance is about 5 cents\./);
  assert.match(s.error, /Nothing was started and nothing was charged/);
  assert.equal(w.jobs.size, 0);
  assert.equal(w.credits.get('grown'), 5 * CENT);
  assert.equal(w.charges.rows.length, 0);
  assert.equal(w.usage.length, 0);
  w.credits.set('grown', 50 * CENT);
  const again = await studio.start({ req: yes(w), ...AGENT, quoteId: q.quoteId }, w.deps);
  assert.equal(again.ok, true, again.error);
  assert.equal(w.credits.get('grown'), 38 * CENT);
});

test('exactly enough: 12 cents in the balance starts a song and leaves nothing; 11 cents is refused and untouched', async () => {
  const w = world({ balances: { grown: 12 * CENT, kid: 11 * CENT } });
  const a = await w.render('grown', { engine: 'yue2', script: 'bright pop', lyrics: 'la la', count: 1 });
  assert.equal(a.status, 200);
  assert.equal(w.credits.get('grown'), 0);
  const b = await w.render('kid', { engine: 'yue2', script: 'bright pop', lyrics: 'la la', count: 1 });
  assert.equal(b.status, 402);
  assert.equal(b.data.lowBalance, true);
  assert.equal(w.credits.get('kid'), 11 * CENT);
});

/* ------------------------------------------------------------------ refund */

test('refund: a song that fails with nothing saved gives the 12 cents back, once', async () => {
  spend._resetForTests();
  const w = world();
  const s = await studio.start({ req: yes(w), ...AGENT, quoteId: (await priced(w)).quoteId }, w.deps);
  assert.equal(await w.move(s.jobId, 'running', ['running']), 'kept');
  assert.equal(w.credits.get('grown'), 88 * CENT);
  const out = await Promise.all([w.move(s.jobId, 'failed', ['failed']), charge.afterJobUpdate(w.jobs.get(s.jobId), w.chargeDeps)]);
  assert.equal(out.filter((o) => o === 'refunded').length, 1, 'two servers, one refund');
  assert.equal(await w.move(s.jobId, 'failed', ['failed']), 'none');
  assert.equal(w.credits.get('grown'), 100 * CENT);
  assert.equal(w.charges.rows[0].state, 'refunded');
  assert.deepEqual(w.usage.map((u) => u.chargedUSD), [0.12, -0.12]);
  assert.equal(w.usage[1].metadata.refund_for, w.charges.rows[0].chargeId);
});

test('refund: stopped before rendering comes back; stopped after rendering began, or with a take saved, does not', async () => {
  spend._resetForTests();
  const early = world();
  const a = await studio.start({ req: yes(early), ...AGENT, quoteId: (await priced(early)).quoteId }, early.deps);
  const stopped = await studio.cancel({ req: reqFor('grown', 'stop my song', early), ...AGENT }, early.deps);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.refunded, '12 cents');
  assert.match(stopped.tellThem, /went back to their balance/);
  assert.equal(early.credits.get('grown'), 100 * CENT);
  assert.equal(a.jobId, stopped.jobId);

  const late = world();
  const b = await studio.start({ req: yes(late), ...AGENT, quoteId: (await priced(late)).quoteId }, late.deps);
  await late.move(b.jobId, 'running', ['running']);
  const kept = await studio.cancel({ req: reqFor('grown', 'stop my song', late), ...AGENT, jobId: b.jobId }, late.deps);
  assert.equal(kept.refunded, null);
  assert.equal(late.credits.get('grown'), 88 * CENT, 'GPU time was spent');

  const partial = world();
  const c = await studio.start({ req: yes(partial), ...AGENT, quoteId: (await priced(partial, 'grown', { ...SONG, takes: 2 })).quoteId }, partial.deps);
  assert.equal(partial.credits.get('grown'), 76 * CENT, 'two takes, 24 cents');
  const both = await Promise.all([partial.move(c.jobId, 'failed', ['done', 'failed']), charge.afterJobUpdate(partial.jobs.get(c.jobId), partial.chargeDeps)]);
  assert.equal(both.filter((o) => o === 'refunded').length, 1, 'two servers, one refund');
  assert.equal(await partial.move(c.jobId, 'failed', ['done', 'failed']), 'none', 'closed: never again');
  assert.equal(partial.credits.get('grown'), 88 * CENT, 'the saved take is paid for, the failed one came back');
  assert.equal(partial.charges.rows[0].state, 'part-refunded');
  assert.equal(partial.charges.rows[0].refundedCents, 12);
  assert.deepEqual(partial.usage.map((u) => u.chargedUSD), [0.24, -0.12]);

  const whole = world();
  const d = await studio.start({ req: yes(whole), ...AGENT, quoteId: (await priced(whole, 'grown', { ...SONG, takes: 2 })).quoteId }, whole.deps);
  assert.equal(await whole.move(d.jobId, 'done', ['done', 'done']), 'kept');
  assert.equal(await whole.move(d.jobId, 'done', ['done', 'done']), 'none');
  assert.equal(whole.credits.get('grown'), 76 * CENT, 'both takes saved, both paid for');
  assert.equal(whole.charges.rows[0].state, 'charged');
  assert.ok(whole.charges.rows[0].closedAt instanceof Date);
});

test('build two: the flat price switch charges a request once, and a saved take keeps it all', async () => {
  spend._resetForTests();
  const w = world({ env: { KADE_SONG_CHARGE_PER_TAKE: '0' } });
  assert.equal(charge.priceFor({ role: 'USER' }, w.env, 4).cents, 12);
  const s = await studio.start({ req: yes(w), ...AGENT, quoteId: (await priced(w, 'grown', { ...SONG, takes: 2 })).quoteId }, w.deps);
  assert.equal(w.credits.get('grown'), 88 * CENT);
  assert.equal(await w.move(s.jobId, 'failed', ['done', 'failed']), 'kept');
  assert.equal(w.credits.get('grown'), 88 * CENT);
});

test('build two: a song whose job never ends is closed by the sweep and its unsaved takes come back, once', async () => {
  spend._resetForTests();
  const w = world();
  const s = await studio.start({ req: yes(w), ...AGENT, quoteId: (await priced(w, 'grown', { ...SONG, takes: 2 })).quoteId }, w.deps);
  await w.move(s.jobId, 'running', ['done', 'saving']);
  assert.equal(w.credits.get('grown'), 76 * CENT);
  assert.deepEqual(await charge.sweep(w.chargeDeps), { holds: 0, closed: 0 }, 'not old enough: left alone');
  w.charges.rows[0].settledAt = new Date(Date.now() - 3 * 3600000);
  const out = await Promise.all([charge.sweep(w.chargeDeps), charge.sweep(w.chargeDeps)]);
  assert.equal(out[0].closed + out[1].closed, 1, 'two servers, one close');
  assert.equal(w.credits.get('grown'), 88 * CENT, 'the take stuck saving came back; the saved one is paid for');
  assert.deepEqual(await charge.sweep(w.chargeDeps), { holds: 0, closed: 0 });
  /* and if that take saves after all, nothing more moves */
  assert.equal(await w.move(s.jobId, 'done', ['done', 'done']), 'none');
  assert.equal(w.credits.get('grown'), 88 * CENT);
  /* the sweep switch */
  const off = world({ env: { KADE_SONG_SWEEP: '0' } });
  off.charges.rows.push({ _id: 'rx', chargeId: 'cx', userId: 'grown', credits: 12 * CENT, state: 'held', createdAt: new Date(Date.now() - 3600000) });
  assert.deepEqual(await charge.sweep(off.chargeDeps), { holds: 0, closed: 0 });
});

test('build two: a hold left by a crash is given back by the sweep for anyone, without them starting another song', async () => {
  const w = world();
  w.credits.set('grown', 88 * CENT);
  w.charges.rows.push({ _id: 'r1', chargeId: 'c1', userId: 'grown', credits: 12 * CENT, cents: 12, state: 'held', createdAt: new Date(Date.now() - 11 * 60000) });
  w.charges.rows.push({ _id: 'r2', chargeId: 'c2', userId: 'kid', credits: 12 * CENT, cents: 12, state: 'held', createdAt: new Date() });
  const out = await charge.sweep(w.chargeDeps);
  assert.equal(out.holds, 1);
  assert.equal(w.credits.get('grown'), 100 * CENT);
  assert.equal(w.charges.rows[1].state, 'held', 'a fresh hold is a start still in flight');
});

test('build two: a job that ended in the moment before the charge was written is still refunded', async () => {
  spend._resetForTests();
  const w = world();
  /* the queue ends the job before settle has marked the row charged: its hook finds nothing to refund */
  const realSettle = w.chargeDeps.coll.findOneAndUpdate.bind(w.chargeDeps.coll);
  let raced = false;
  w.chargeDeps.coll.findOneAndUpdate = async (filter, update, opts) => {
    if (!raced && filter.state === 'held' && update.$set && update.$set.state === 'charged') {
      raced = true;
      const job = [...w.jobs.values()][0];
      job.state = 'failed';
      job.active = false;
      job.takes = [{ state: 'failed' }];
      assert.equal(await charge.afterJobUpdate(job, w.chargeDeps), 'none');
    }
    return realSettle(filter, update, opts);
  };
  const s = await studio.start({ req: yes(w), ...AGENT, quoteId: (await priced(w)).quoteId }, w.deps);
  assert.equal(s.ok, true);
  for (let i = 0; i < 20; i += 1) await tick();
  assert.equal(raced, true);
  assert.equal(w.credits.get('grown'), 100 * CENT, 'the look after settle gave it back');
  assert.equal(w.charges.rows[0].state, 'refunded');
});

test('refund: a submission the booth could not confirm is never retried and never charged', async () => {
  spend._resetForTests();
  const w = world();
  const q = await priced(w);
  w.submitFails = true;
  const s = await studio.start({ req: yes(w), ...AGENT, quoteId: q.quoteId }, w.deps);
  assert.equal(s.ok, false);
  assert.equal(s.uncertain, true);
  assert.match(s.error, /Nothing was charged\. Do not try again in this reply/);
  assert.equal(w.credits.get('grown'), 100 * CENT);
  assert.equal(w.renders.filter((r) => !r.body.estimateOnly).length, 1, 'one attempt only');
  w.submitFails = false;
  const again = await studio.start({ req: yes(w), ...AGENT, quoteId: q.quoteId }, w.deps);
  assert.equal(again.ok, false, 'the price is spent; a new start needs a new price and a new yes');

  const down = world();
  const q2 = await priced(down);
  down.boothDown = true;
  const lost = await studio.start({ req: yes(down), ...AGENT, quoteId: q2.quoteId }, down.deps);
  assert.equal(lost.uncertain, true);
  assert.match(lost.error, /Call status to find out/);
});

test('a job the queue could not confirm, found later, is refunded even with a take still listed as queued', async () => {
  const w = world();
  const r = await w.render('grown', { engine: 'yue2', script: 'bright pop', lyrics: 'la la', count: 2 });
  assert.equal(await w.move(r.data.jobId, 'uncertain', ['uncertain', 'queued']), 'refunded');
  assert.equal(w.credits.get('grown'), 100 * CENT);
});

test('a second answer for the same request is dropped, and the first keeps its own status', async () => {
  const w = world();
  const sent = [];
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      sent.push({ code: this.statusCode, data });
      return this;
    },
    on() {},
  };
  const req = { body: { engine: 'yue2', script: 'bright pop', lyrics: 'la', count: 1 }, user: { id: 'grown', role: 'USER' } };
  await charge.boothGate(
    req,
    res,
    () => {
      res.json({ ok: true, jobId: 'yue_x', projectId: 'p', estimate: { spoken: '1 take.' } });
      res.status(503).json({ error: 'late catch' });
    },
    w.chargeDeps,
  );
  for (let i = 0; i < 10; i += 1) await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].code, 200);
  assert.equal(sent[0].data.charge.state, 'charged');
  assert.equal(w.credits.get('grown'), 88 * CENT);
});

test('a hold whose answer never came is given back the next time that person starts a song', async () => {
  const w = world({ env: { KADE_SONG_HOLD_MINUTES: '1' } });
  w.charges.rows.push({ _id: 'old', chargeId: 'cold', userId: 'grown', credits: 12 * CENT, cents: 12, state: 'held', origin: 'booth', createdAt: new Date(Date.now() - 5 * 60000) });
  w.credits.set('grown', 88 * CENT);
  const r = await w.render('grown', { engine: 'yue2', script: 'bright pop', lyrics: 'la la', count: 1 });
  assert.equal(r.status, 200);
  assert.equal(w.credits.get('grown'), 88 * CENT, '12 back, 12 taken');
  assert.equal(w.charges.rows.find((row) => row.chargeId === 'cold').state, 'refunded');
});

/* ---------------------------------------------------------------- admin free */

test('admin: told it is free for her with the GPU estimate, still says yes, pays nothing', async () => {
  spend._resetForTests();
  const w = world();
  const req = reqFor('boss', 'make me a song about the rain', w);
  const q = await studio.quote({ req, ...AGENT, input: SONG }, w.deps);
  assert.match(q.tellThem, /^Free for you\. It will use about 5 cents of GPU time for each take, or 10 to 15 cents/);
  /* The reply need not carry an amount for a free song, but it must have ended. */
  const early = await studio.start({ req: yes(w, 'boss'), ...AGENT, quoteId: q.quoteId }, w.deps);
  assert.equal(early.error, studio.REFUSED.notSaid);
  await replied(w, req, 'Free for you. Want me to make it?');
  const noYes = await studio.start({ req: yes(w, 'boss', 'what key is it in?'), ...AGENT, quoteId: q.quoteId }, w.deps);
  assert.equal(noYes.error, studio.REFUSED.noYes);
  const s = await studio.start({ req: yes(w, 'boss', 'yes please'), ...AGENT, quoteId: q.quoteId }, w.deps);
  assert.equal(s.ok, true, s.error);
  assert.equal(s.charged, 'nothing');
  assert.doesNotMatch(s.tellThem, /taken from their balance/);
  assert.equal(w.credits.get('boss'), 0);
  assert.equal(w.usage.length, 0);
  assert.equal(w.charges.rows.length, 1);
  assert.equal(w.charges.rows[0].state, 'free');
  assert.equal(w.charges.rows[0].agentId, 'agent_testa', 'the job still remembers who asked, for the message back');
});

test('the charge switch and the price setting', async () => {
  assert.equal(charge.priceFor({ role: 'USER' }, {}).cents, 12);
  assert.equal(charge.priceFor({ role: 'USER' }, { KADE_SONG_PRICE_CENTS: '10' }).cents, 10);
  assert.equal(charge.priceFor({ role: 'USER' }, { KADE_SONG_PRICE_CENTS: 'lots' }).cents, 12);
  assert.equal(charge.priceFor({ role: 'USER' }, { KADE_SONG_CHARGE: '0' }).free, true);
  assert.equal(charge.priceFor({ role: 'ADMIN' }, {}).free, true);
  assert.equal(charge.priceSentence({ role: 'ADMIN' }, {}), null);
  assert.equal(
    charge.priceSentence({ role: 'USER' }, {}),
    'Each YuE2 take you start takes 12 cents from your balance: one take is 12 cents, four takes are 48 cents. A take that fails gets its 12 cents back, and so does a song you stop before it starts rendering.',
  );
  assert.equal(
    charge.priceSentence({ role: 'USER' }, { KADE_SONG_CHARGE_PER_TAKE: '0' }),
    'Each YuE2 song you start takes 12 cents from your balance, however many takes you ask for. If the song fails, or you stop it before it starts rendering, the 12 cents goes back to your balance.',
  );
  assert.equal(charge.priceFor({ role: 'USER' }, {}, 4).cents, 48);
  assert.equal(charge.priceFor({ role: 'USER' }, {}, 9).cents, 12, 'a count the booth would refuse is priced as one; the booth refuses it and the hold goes back');
  assert.equal(charge.priceFor({ role: 'ADMIN' }, {}, 4).cents, 0);
  const off = world({ env: { KADE_SONG_CHARGE: '0' } });
  const r = await off.render('grown', { engine: 'yue2', script: 'bright pop', lyrics: 'la la', count: 1 });
  assert.equal(r.status, 200);
  assert.equal(off.credits.get('grown'), 100 * CENT);
  assert.equal(off.charges.rows.length, 0);
});

/* ------------------------------------------------------------ the booth page */

test('booth page: the estimate says the price, the confirmation says what was taken, the admin hears what she always did', async () => {
  const w = world();
  const est = await w.render('grown', { engine: 'yue2', script: 'bright pop', lyrics: 'la la', count: 2, estimateOnly: true });
  assert.equal(est.data.estimate.spoken, '2 takes. Starting this takes 24 cents from your balance, 12 cents for each of 2 takes.');
  assert.equal(est.data.charge.cents, 24);
  assert.equal(w.credits.get('grown'), 100 * CENT);
  const go = await w.render('grown', { engine: 'yue2', script: 'bright pop', lyrics: 'la la', count: 2 });
  assert.equal(go.data.estimate.spoken, '2 takes. 24 cents was taken from your balance, 12 cents for each of 2 takes. A take that fails gets its 12 cents back.');
  assert.equal(go.data.charge.state, 'charged');
  assert.equal(w.credits.get('grown'), 76 * CENT, 'two takes, 12 cents each, one hold');
  const one = world();
  const single = await one.render('grown', { engine: 'yue2', script: 'bright pop', lyrics: 'la la', count: 1 });
  assert.equal(single.data.estimate.spoken, '1 take. 12 cents was taken from your balance for this song. If the song fails, the 12 cents goes back.');
  assert.equal(w.charges.rows[0].origin, 'booth');
  const hers = await w.render('boss', { engine: 'yue2', script: 'bright pop', lyrics: 'la la', count: 1, estimateOnly: true });
  assert.equal(hers.data.estimate.spoken, `1 take. ${OLD_LINE}`);
  assert.equal(hers.data.charge, undefined);
  const bad = await w.render('kid', { engine: 'yue2', script: 'x', lyrics: 'la', count: 1 });
  assert.equal(bad.status, 400);
  assert.equal(w.credits.get('kid'), 100 * CENT, 'a refused request is not charged');
});

/* ------------------------------------------------------------- child, clean */

test('child account: may make songs, charged the same, and explicit words are refused without naming a rule', async () => {
  spend._resetForTests();
  const w = world();
  const dirty = await studio.quote({ req: reqFor('kid', 'song please', w), ...AGENT, input: { ...SONG, lyrics: '[Verse]\nWell damn that rain' } }, w.deps);
  assert.equal(dirty.ok, false);
  assert.equal(dirty.soft, true);
  assert.match(dirty.error, /Rewrite those lines clean/);
  assert.match(dirty.error, /Do not mention any rule/);
  assert.equal(w.renders.length, 0, 'the booth was never asked');
  assert.equal(w.quotes.rows.length, 0);
  /* The same words are fine for a grown-up. */
  const grown = await studio.quote({ req: reqFor('grown', 'song please', w), ...AGENT, input: { ...SONG, lyrics: '[Verse]\nWell damn that rain' } }, w.deps);
  assert.equal(grown.ok, true);
  /* An untyped account (and the App Review seat) is held clean too. */
  const plain = world({ accounts: { grown: { role: 'USER' } } });
  const untyped = await studio.quote({ req: reqFor('grown', 'song please', plain), ...AGENT, input: { ...SONG, title: 'Damn Rain' } }, plain.deps);
  assert.equal(untyped.soft, true);

  const q = await priced(w, 'kid');
  assert.equal(q.ok, true);
  const s = await studio.start({ req: yes(w, 'kid'), ...AGENT, quoteId: q.quoteId }, w.deps);
  assert.equal(s.ok, true, s.error);
  assert.equal(w.credits.get('kid'), 88 * CENT);
});

/* ------------------------------------------------------------------- lanes */

test('phone lane: acts as the caller, tells the price, and refuses to start, stop, draft, or say anything about the account', async () => {
  spend._resetForTests();
  const w = world();
  const call = (text) => ({ user: { id: 'seat', role: 'ADMIN' }, kadeOnBehalfOf: { id: 'grown', role: 'USER' }, body: { text, conversationId: 'new', kadeOnBehalfOf: 'someone@example.com' } });
  const q = await studio.quote({ req: call('make me a song about the rain'), ...AGENT, input: SONG }, w.deps);
  assert.equal(q.ok, true);
  assert.equal(q.quoteId, null);
  assert.match(q.tellThem, /takes 12 cents from their balance/);
  assert.match(q.tellThem, /cannot be started while you are talking by voice or on a phone call/);
  assert.equal(w.renders[0].uid, 'grown', 'the booth is asked as the caller, never as the service seat');
  assert.equal(w.quotes.rows.length, 0);
  const s = await studio.start({ req: call(fold(['THEM: make me a song', 'YOU: that is 12 cents, okay?'], 'yes')), ...AGENT }, w.deps);
  assert.equal(s.error, studio.REFUSED.phone);
  assert.equal((await studio.cancel({ req: call('stop my song'), ...AGENT }, w.deps)).ok, false);
  assert.equal((await studio.draft({ req: call('write me lyrics'), ...AGENT, idea: 'a song about rain' }, w.deps)).ok, false);
  assert.equal((await studio.status({ req: call('is my song ready'), ...AGENT }, w.deps)).ok, false, 'a caller known only by number hears nothing about the account');
  assert.equal((await studio.list({ req: call('what songs have I made'), ...AGENT }, w.deps)).ok, false);
  assert.equal(w.jobs.size, 0);
  assert.equal(w.credits.get('grown'), 100 * CENT);
  /* A caller the bridge named but the site could not match is nobody. */
  const unknown = { user: { id: 'seat', role: 'ADMIN' }, kadeOnBehalfOfUnresolved: true, body: { text: 'song', kadeOnBehalfOf: 'x@example.com' } };
  assert.equal((await studio.quote({ req: unknown, ...AGENT, input: SONG }, w.deps)).ok, false);
  assert.equal((await studio.status({ req: unknown, ...AGENT }, w.deps)).ok, false);
  /* A folded call text with nobody named is still a call. */
  assert.equal(studio.actor({ user: { id: 'seat', role: 'ADMIN' }, body: { text: fold(['THEM: hi'], 'make a song') } }, {}).lane, 'phone');
});

test('signed-in app voice: off unless the switch is set and the service seat says the caller signed in; then the last utterance alone is the yes', async () => {
  spend._resetForTests();
  const voice = (text, body = {}) => ({ user: { id: 'seat', role: 'ADMIN' }, kadeOnBehalfOf: { id: 'grown', role: 'USER' }, body: { text, conversationId: 'new', kadeOnBehalfOf: 'someone@example.com', kadeCallerSignedIn: true, ...body } });
  assert.equal(studio.actor(voice('hi'), {}).lane, 'phone', 'the marker alone is not enough');
  assert.equal(studio.actor(voice('hi', { kadeCallerSignedIn: undefined }), { KADE_STUDIO_APP_VOICE: '1' }).lane, 'phone');
  assert.equal(studio.actor({ ...voice('hi'), user: { id: 'grown', role: 'USER' } }, { KADE_STUDIO_APP_VOICE: '1' }).lane, 'phone', 'only the service seat may say so');

  const w = world({ env: { KADE_STUDIO_APP_VOICE: '1' } });
  const first = voice('make me a song about the rain');
  const q = await studio.quote({ req: first, ...AGENT, input: SONG }, w.deps);
  assert.match(q.quoteId, /^y/);
  await replied(w, first);
  /* The character's own "okay" in the folded history is not the caller's yes. */
  const own = await studio.start({ req: voice(fold(['THEM: make me a song', 'YOU: okay, that is 12 cents'], 'what was that?')), ...AGENT }, w.deps);
  assert.equal(own.error, studio.REFUSED.noYes);
  const s = await studio.start({ req: voice(fold(['THEM: make me a song', 'YOU: that is 12 cents, want it?'], 'yes go ahead')), ...AGENT }, w.deps);
  assert.equal(s.ok, true, s.error);
  assert.match(s.tellThem, /in their chat with you/);
  assert.equal(w.jobs.get(s.jobId).user, 'grown', 'made and paid for as the caller');
  assert.equal(w.credits.get('grown'), 88 * CENT);
  assert.equal(w.credits.get('seat'), 0);
  assert.equal(w.charges.rows[0].conversationId, null, "the message goes to the caller's own chat with the character");
  assert.equal(w.charges.rows[0].lane, 'app-voice');
});

test('a background run cannot make a song, and KADE_STUDIO=0 refuses everything', async () => {
  const w = world();
  const hidden = { ...reqFor('grown', 'make a song', w), kadeHiddenRun: true };
  assert.equal((await studio.quote({ req: hidden, ...AGENT, input: SONG }, w.deps)).ok, false);
  assert.equal((await studio.start({ req: hidden, ...AGENT }, w.deps)).ok, false);
  const off = world({ env: { KADE_STUDIO: '0' } });
  const q = await studio.quote({ req: reqFor('grown', 'make a song', off), ...AGENT, input: SONG }, off.deps);
  assert.equal(q.ok, false);
  assert.match(q.error, /switched off/);
  assert.equal(off.renders.length, 0);
});

/* ---------------------------------------------------------------- delivery */

test('delivery: the finished song is posted once as the character, library first then the link, and pushed once, even from two servers', async () => {
  spend._resetForTests();
  const w = world();
  const s = await studio.start({ req: yes(w), ...AGENT, quoteId: (await priced(w)).quoteId }, w.deps);
  await w.move(s.jobId, 'done', ['done']);
  const both = await Promise.all([w.announce(s.jobId), w.announce(s.jobId)]);
  assert.equal(both.filter(Boolean).length, 1, 'one server wins the claim');
  assert.equal(await w.announce(s.jobId), null);
  assert.equal(w.posts.length, 1);
  assert.equal(w.pushes.length, 1);
  const post = w.posts[0];
  assert.equal(post.userId, 'grown');
  assert.equal(post.agentId, 'agent_testa');
  assert.equal(post.conversationId, 'convo-1');
  assert.equal(
    post.text,
    'Your song "Rain Song" is ready. It is in your Sound Booth library: on the phone app, open the Sound Booth and then your library to play it.' +
      ` On the website you can also play it from here: [Play Rain Song](https://files.example/${s.jobId}_1.mp3) If a link here stops working, the song is still in your library.`,
  );
  assert.equal(w.pushes[0].conversationId, 'convo-1');
  assert.equal(w.pushes[0].requested, true);
  assert.equal(w.pushes[0].text, 'Your song "Rain Song" is ready. It is in your Sound Booth library.');
  const receipt = both.find(Boolean);
  assert.equal(receipt.accepted, 1);
  assert.ok(receipt.at instanceof Date);
});

test('delivery: a failed song says so and says the money came back; a booth-page song is left to the booth', async () => {
  spend._resetForTests();
  const w = world();
  const s = await studio.start({ req: yes(w), ...AGENT, quoteId: (await priced(w)).quoteId }, w.deps);
  await w.move(s.jobId, 'failed', ['failed']);
  assert.ok(await w.announce(s.jobId));
  assert.equal(w.posts[0].text, 'Your song "Rain Song" did not finish, so there is nothing to play. The 12 cents went back to your balance. Ask me if you want to try it again.');

  const page = await w.render('grown', { engine: 'yue2', script: 'bright pop', lyrics: 'la la', count: 1 });
  await w.move(page.data.jobId, 'done', ['done']);
  assert.equal(await w.announce(page.data.jobId), null, 'no character asked for it');
  assert.equal(w.posts.length, 1);

  const off = world({ env: { KADE_STUDIO_DELIVER: '0' } });
  const t = await studio.start({ req: yes(off), ...AGENT, quoteId: (await priced(off)).quoteId }, off.deps);
  await off.move(t.jobId, 'done', ['done']);
  assert.equal(await off.announce(t.jobId), null);
  assert.equal(off.posts.length, 0);
});

test('delivery: several takes are all linked, and a post that fails falls back to the booth notice', async () => {
  spend._resetForTests();
  const w = world();
  const s = await studio.start({ req: yes(w), ...AGENT, quoteId: (await priced(w, 'grown', { ...SONG, takes: 3 })).quoteId }, w.deps);
  await w.move(s.jobId, 'failed', ['done', 'done', 'failed']);
  await w.announce(s.jobId);
  assert.match(w.posts[0].text, /2 of 3 takes were saved\. The 12 cents for what was not saved went back to your balance\. On the website you can also play it from here: \[Play Rain Song\]\(.*_1\.mp3\) \[Play take 2\]\(.*_2\.mp3\) If a link/);
  assert.equal(w.credits.get('grown'), 76 * CENT, 'three takes held, the failed one returned');

  const broken = world();
  broken.deps.turn.post = async () => {
    throw new Error('database away');
  };
  const t = await studio.start({ req: yes(broken), ...AGENT, quoteId: (await priced(broken)).quoteId }, broken.deps);
  await broken.move(t.jobId, 'done', ['done']);
  assert.equal(await broken.announce(t.jobId), null, 'null hands the job to the Sound Booth push');
  assert.equal(broken.pushes.length, 0);
});

/* ------------------------------------------------- status, list, lyric desk */

test('status answers "is my song ready", with the play link once it is; list names their songs', async () => {
  spend._resetForTests();
  const w = world();
  const none = await studio.status({ req: reqFor('grown', 'is my song ready', w), ...AGENT }, w.deps);
  assert.equal(none.none, true);
  const s = await studio.start({ req: yes(w), ...AGENT, quoteId: (await priced(w)).quoteId }, w.deps);
  const working = await studio.status({ req: reqFor('grown', 'is my song ready', w), ...AGENT }, w.deps);
  assert.equal(working.state, 'queued');
  assert.equal(working.title, 'Rain Song');
  assert.equal(working.play, undefined);
  await w.move(s.jobId, 'done', ['done']);
  const ready = await studio.status({ req: reqFor('grown', 'is my song ready', w), ...AGENT, jobId: s.jobId }, w.deps);
  assert.equal(ready.state, 'done');
  assert.deepEqual(ready.play, [{ take: 1, url: `https://files.example/${s.jobId}_1.mp3`, seconds: 180 }]);
  const someoneElse = await studio.status({ req: reqFor('kid', 'is my song ready', w), ...AGENT, jobId: s.jobId }, w.deps);
  assert.equal(someoneElse.ok, false, 'never another person');
  const songs = await studio.list({ req: reqFor('grown', 'my songs', w), ...AGENT }, w.deps);
  assert.deepEqual(songs.songs, [{ title: 'Rain Song', state: 'done', takes: 1 }]);
});

test('build two: the lyric desk is not used from a conversation, so no draft can spend anyone\'s balance unasked', async () => {
  const w = world();
  for (const uid of ['grown', 'kid', 'boss']) {
    const d = await studio.draft({ req: reqFor(uid, 'write me a song about rain', w), ...AGENT, idea: 'a slow song about rain on a tin roof' }, w.deps);
    assert.equal(d.ok, false, uid);
    assert.equal(d.soft, true);
    assert.match(d.error, /Write the words yourself, with them/);
    assert.equal((await studio.draftRead({ req: reqFor(uid, 'read it to me', w), ...AGENT }, w.deps)).ok, false);
  }
  assert.equal(w.scripts.size, 0, 'the booth\'s lyric desk was never asked');
  /* the switch opens it for the administrator only: nobody else is charged for a draft they heard no price for */
  const on = world({ env: { KADE_STUDIO_DRAFT: '1' } });
  assert.equal((await studio.draft({ req: reqFor('grown', 'write me a song', on), ...AGENT, idea: 'a slow song about rain' }, on.deps)).ok, false);
  assert.equal(on.scripts.size, 0);
});

test('lyric desk, switched on for the administrator: a draft is asked for, read back when ready, and split into direction and words', async () => {
  const w = world({ env: { KADE_STUDIO_DRAFT: '1' } });
  const d = await studio.draft({ req: reqFor('boss', 'write me a song about rain', w), ...AGENT, idea: 'a slow song about rain on a tin roof' }, w.deps);
  assert.equal(d.state, 'working');
  const sent = w.scripts.get(d.draftId).body;
  assert.equal(sent.engine, 'yue2');
  assert.equal(sent.mode, 'write');
  assert.equal(sent.background, true);
  const waiting = await studio.draftRead({ req: reqFor('boss', 'read it to me', w), ...AGENT }, w.deps);
  assert.equal(waiting.state, 'working');
  Object.assign(w.scripts.get(d.draftId), {
    state: 'done',
    result: { title: 'Tin Roof', script: 'slow country ballad, warm female lead vocal\n\nLyrics:\n[Verse]\nRain on the tin roof\n[Chorus]\nLet it rain\nREADBACK: a slow song' },
  });
  const done = await studio.draftRead({ req: reqFor('boss', 'read it to me', w), ...AGENT }, w.deps);
  assert.equal(done.state, 'done');
  assert.equal(done.title, 'Tin Roof');
  assert.equal(done.direction, 'slow country ballad, warm female lead vocal');
  assert.equal(done.lyrics, '[Verse]\nRain on the tin roof\n[Chorus]\nLet it rain');
  assert.equal((await studio.draftRead({ req: reqFor('kid', 'read it', w), ...AGENT, draftId: d.draftId }, w.deps)).ok, false);
});

/* ------------------------------------------------- attaching by keyword only */

test('kade_studio rides only on song-shaped words, or once it is already riding in the conversation', async () => {
  const R = require('./kadeToolRetrieval.js');
  const tools = ['kade_studio', 'kade_weather', 'kade_help', 'web_search', 'kade_joke'].map((name) => ({ name, description: `${name} does things` }));
  const down = async () => null;
  const pick = (text, conversationId = 'c-song', embed = down) => R.selectTools({ tools, text, agentId: 'a', conversationId, embed });
  R._resetForTests();
  /* The embed lane is down and no keyword hit: the whole set rides, except this tool. */
  const chat = await pick('I had the strangest day at work today, honestly', 'c-chat');
  assert.match(chat.reason, /embed-(?:down|slow)/);
  assert.equal(chat.keep.has('kade_weather'), true);
  assert.equal(chat.keep.has('kade_studio'), false);
  assert.equal(chat.dropped.includes('kade_studio'), true);
  for (const text of ['can you make me a song about my dog', 'write a lullaby for the baby', 'is my song ready yet', 'let us use the sound booth', 'write me some lyrics']) {
    R._resetForTests();
    assert.equal((await pick(text)).keep.has('kade_studio'), true, text);
  }
  for (const text of ['do you know this song', 'what is the weather like', 'tell me a joke']) {
    R._resetForTests();
    assert.equal((await pick(text, 'c-other')).keep.has('kade_studio'), false, text);
  }
  /* The yes after a price carries the tool, in the same conversation only. */
  R._resetForTests();
  await pick('make me a song about the rain', 'c-yes');
  assert.equal((await pick('yes', 'c-yes')).keep.has('kade_studio'), true);
  assert.equal((await pick('yes', 'c-elsewhere')).keep.has('kade_studio'), false);
  /* On a call there is no conversation: the caller's last few lines carry it; the character's do not. */
  R._resetForTests();
  const carried = await pick(fold(['THEM: make me a song about the rain', 'YOU: that is 12 cents, want it?'], 'yes'), null);
  assert.equal(carried.keep.has('kade_studio'), true);
  const hers = await pick(fold(['THEM: hi there', 'YOU: want me to make you a song about it?'], 'no thanks'), null);
  assert.equal(hers.keep.has('kade_studio'), false);
  /* The switch. */
  R._resetForTests();
  process.env.KADE_TOOLS_KEYWORD_ONLY = '0';
  const loose = await pick('I had the strangest day at work today, honestly', 'c-loose');
  delete process.env.KADE_TOOLS_KEYWORD_ONLY;
  assert.equal(loose.keep.has('kade_studio'), true);
});

test('build two: after a restart the yes turn still has the tool, when this conversation holds an open song price or a recent song', async () => {
  const R = require('./kadeToolRetrieval.js');
  const tools = ['kade_studio', 'kade_weather', 'kade_help', 'web_search', 'kade_joke'].map((name) => ({ name, description: `${name} does things` }));
  /* an embed that takes a moment, as a real one does, and matches nothing */
  const slow = () => new Promise((resolve) => setTimeout(() => resolve(null), 30));
  const pick = (text, conversationId) => R.selectTools({ tools, text, agentId: 'a', conversationId, embed: slow });
  const looked = [];
  R._resetForTests();
  R._seam.studioOpen = async (id) => {
    looked.push(id);
    return id === 'c-priced';
  };
  try {
    const yesTurn = await pick('yeah go ahead and make it', 'c-priced');
    assert.equal(yesTurn.keep.has('kade_studio'), true);
    assert.match(yesTurn.reason, /studio-open|embed-/);
    const next = await pick('is it done yet', 'c-priced');
    assert.equal(next.keep.has('kade_studio'), true, 'and it rides from then on');
    const other = await pick('yeah go ahead', 'c-plain');
    assert.equal(other.keep.has('kade_studio'), false, 'a conversation with no song in it does not get the tool on a yes');
    assert.deepEqual(looked, ['c-priced', 'c-plain'], 'one look per conversation until it rides; never for a placeholder id');
    assert.equal((await pick('yes', 'new')).keep.has('kade_studio'), false);
    /* a look that is not back in time is not waited for */
    R._resetForTests();
    R._seam.studioOpen = () => new Promise((resolve) => setTimeout(() => resolve(true), 400));
    const t0 = Date.now();
    const late = await pick('yes', 'c-slow-look');
    assert.equal(late.keep.has('kade_studio'), false);
    assert.ok(Date.now() - t0 < 300, 'the reply did not wait on the look');
    /* the switch */
    process.env.KADE_STUDIO_OPEN_LOOK = '0';
    R._resetForTests();
    R._seam.studioOpen = async () => true;
    assert.equal((await pick('yes', 'c-priced')).keep.has('kade_studio'), false);
  } finally {
    delete process.env.KADE_STUDIO_OPEN_LOOK;
    R._seam.studioOpen = null;
    R._resetForTests();
  }
  /* first asks and follow-ups that used to miss */
  for (const said of ['make me a rap about my cat', 'can we make music together', 'can you sing me something about my dog', 'did the song finish', 'play my song', 'change the second verse', 'the lyrics look good']) {
    assert.equal(R.keywordHits(said, ['kade_studio']).has('kade_studio'), true, said);
  }
  for (const said of ['play some music', 'I love that song by the way', 'what a day']) {
    assert.equal(R.keywordHits(said, ['kade_studio']).has('kade_studio'), false, said);
  }
});
