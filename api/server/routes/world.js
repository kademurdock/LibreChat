/* KADE WORLD — the DIRECT lane (Aug 8 2026, her correction: "hard to interact
 * seriously via telling someone else to perform your actions"). No LLM in this
 * loop, ever: command in, engine out, ~50ms. MUD hands type n/e/w/s as fast as
 * telnet ever let them; the /world page is the client. Porter and his kin are
 * NPCs inside the world now, not the gate to it. Same engine, same state —
 * a traveler through Porter and a traveler through this lane share the city. */
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
/* LIFE LAYER (Sep 6 2026): the Sims side of the city. Same signature, same
 * result shape plus hud/actions/people/exits, falls through to the old engine
 * for every verb it does not own. REVERIE_ENGINE=v1 is the hatch back. */
const { runCommand } = process.env.REVERIE_ENGINE === 'v1'
  ? require('~/app/clients/tools/kademoo/engine')
  : require('~/app/clients/tools/kademoo/life');
const reverie = require('~/app/clients/tools/kademoo/reverie');
const { angelBuild, angelLines } = require('~/app/clients/tools/kademoo/angel');
const { seedSounds } = require('~/app/clients/tools/kademoo/seedSounds');

const router = express.Router();
router.use(requireJwtAuth);

/* SOUND SEED — 2026-08-13 (round 9). This used to be a bare `seedSounds()`
 * right here, at module load, and it has NEVER ONCE WORKED. The logs say
 * exactly one thing about it, on every boot since it was written:
 *
 *     error: [seed] sound seed failed (non-fatal):
 *
 * — with an empty message, because the catch logged `e.message` on something
 * that did not have one. It is called during route registration, which is
 * before Mongo is connected, so the very first thing it does is a query
 * against a model that has no connection behind it yet.
 *
 * The cost of that: the round-8 entry recorded "manifest count 31 -> 46" and
 * the index published 46 for a day. The live manifest served 41 the whole
 * time. Nobody fetched a URL, so nobody found out — which is precisely what
 * the standing rule three files away exists to prevent, and it was written
 * INTO the file that broke it.
 *
 * Now: lazy, awaited from the /sounds route where a live connection is
 * guaranteed, retried on failure rather than latched off, and it logs the
 * whole error instead of a field that may not exist. */
let _seedTried = false;
async function seedOnce() {
  if (_seedTried) return;
  _seedTried = true;
  try {
    await seedSounds();
  } catch (e) {
    _seedTried = false; /* let the next request try again */
    logger.error('[world] sound seed threw:', e && (e.stack || e.message || e));
  }
}

router.post('/command', async (req, res) => {
  try {
    /* HER CALL (Aug 10 2026): Reverie stays behind the admin gate for now —
     * "hidden behind the admin gate but eventually moved more public." The
     * hatch is one env var: REVERIE_PUBLIC=1 opens the city to every account,
     * no code change. Family who wander onto /world early hear a closed gate,
     * kindly. */
    if (req.user.role !== 'ADMIN' && process.env.REVERIE_PUBLIC !== '1') {
      return res.json({ ok: false, lines: ['The Threshold Gate is closed. Beyond it, a city is being built — you can hear faint hammering and, once, a bell ringing the wrong hour. It will open when the Founder says it opens.'] });
    }
    /* KADE 2026-08-12: this cap used to be 400 and it was SILENTLY EATING
     * wizardry. A presigned Backblaze URL is ~370 characters, so
     * "@sound event transit.train.horn.night <url>" came to 400 exactly and
     * the signature lost its last few bytes — the install reported success,
     * the manifest served the truncated link, and the sound 403'd forever
     * with nothing anywhere saying why. Measured: every broken row was
     * precisely (400 - prefix) characters long. The same trap was waiting for
     * any @desc longer than a paragraph. The angel lane next door has always
     * taken 2000; there is no reason a wizard's line should take less. */
    const command = String(req.body?.command || '').slice(0, 2000);
    if (!command.trim()) {
      return res.status(400).json({ error: 'empty command' });
    }
    /* THE ANGEL PREFIX (Aug 9 2026): "angel: carve a bakery north of the
     * gate" typed into ANY existing world client — the web page, the native
     * World screen behind the admin door — wakes the Angel Lane with zero
     * client changes. Wizards only; everyone else's "angel..." is just a
     * word the parser will shrug at. */
    const angelAsk = /^angel[,:]?\s+(.+)$/is.exec(command);
    if (angelAsk && req.user.role === 'ADMIN') {
      /* "angel preview: ..." shows the plan without executing it. */
      const preview = /^preview[,:]?\s+(.+)$/is.exec(angelAsk[1].trim());
      const out = await angelBuild((preview ? preview[1] : angelAsk[1]).trim(), { dryRun: !!preview });
      return res.json({ ok: true, lines: angelLines(out) });
    }
    const result = await runCommand({
      userId: req.user.id,
      displayName: req.user.name || req.user.username,
      command,
      /* a client holding /stream open already hears the room live; it asks
       * for no MEANWHILE recap so nothing is read twice. */
      live: req.body?.live === true,
      /* Wizard tier = platform admins (the Founder and deputies) — the #2
       * workflow: walk with NVDA, build as you go. */
      isWizard: req.user.role === 'ADMIN',
    });
    /* Merge `sounds` into `kinds` so every client (web and native) plays the
     * specific sound id through the same channel it already reads. The native
     * WorldResult struct only decodes `kinds`; keeping one channel means the
     * phone never needs rebuilding when new sound ids ship. */
    if (result.sounds && result.sounds.length) {
      result.kinds = [...(result.kinds || []), ...result.sounds];
      delete result.sounds;
    }
    res.json(result);
  } catch (e) {
    logger.error('[world] direct command failed:', e.message);
    res.status(500).json({ error: 'the world flickered — try again' });
  }
});

/* THE ANGEL LANE, direct (Aug 9 2026 — last session's designed opener,
 * built): plain English in, the city changed, a chronicle out. Admin-only —
 * the Angel answers the Founder. One K3 call per ask, zero idle cost; the
 * execution half is the same chronicled runCommand as every traveler.
 * Body: { instruction } (or { command } — the native box sends that). */
router.post('/angel', async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'the angel answers only the Founder' });
    }
    const instruction = String(req.body?.instruction || req.body?.command || '').slice(0, 2000);
    if (!instruction.trim()) {
      return res.status(400).json({ error: 'tell the angel what to build' });
    }
    const dryRun = req.body?.dryRun === true;
    const out = await angelBuild(instruction.trim(), { dryRun });
    res.json({ ok: true, dryRun: dryRun || undefined, note: out.note, results: out.results, lines: angelLines(out) });
  } catch (e) {
    logger.error('[world] angel failed:', e.message);
    res.status(500).json({ error: 'the angel lost the thread — try again' });
  }
});

/** The sound manifest — her designed audio as data. Clients merge this over
 *  their synth defaults; installing a sound in-world (@sound) needs no deploy.
 *
 *  KADE 2026-08-11: sounds live in the PRIVATE Backblaze bucket, so a stored
 *  s3 URL 401s on her phone. Presign at SERVE time (not install time) — the
 *  manifest is re-fetched on every world page load and every native World
 *  screen open, so each fetch hands the client URLs that are valid right now
 *  and a stored link can never go stale. Same helper the gallery uses.
 *  Non-S3 URLs (fal.media, anything public) pass through untouched. */
router.get('/sounds', async (_req, res) => {
  try {
    await seedOnce();
    const { MooSound } = require('~/models/kadeMoo');
    const { needsRefresh, getNewS3URL } = require('@librechat/api');
    /* Sep 6 2026: the live manifest served {} while the seeder in the SAME
     * request counted 25 installed rows. find({}) and find({scopeType}) cannot
     * disagree on a sane collection, so this names the scopes explicitly and
     * logs the count, to make the next reader's job a one-line grep. */
    const rows = await MooSound.find({ scopeType: { $in: ['event', 'room', 'district'] } }).lean();
    logger.info(`[world] sound manifest: ${rows.length} rows (${rows.filter((r) => r.scopeType === 'event').length} event, ${rows.filter((r) => r.scopeType === 'room').length} room, ${rows.filter((r) => r.scopeType === 'district').length} district)`);
    const { presignReverieUrl } = require('~/app/clients/tools/kademoo/seedSounds');
    const fresh = async (url) => {
      const u = String(url || '');
      try {
        /* Sep 6 2026: our own keys, our own signature. getNewS3URL returns
         * undefined for `reverie-sounds/<id>.m4a` (upstream parseS3Key wants
         * three path parts), and an undefined value vanishes from JSON — that
         * is how the manifest served {} with 66 rows in the collection. */
        if (/reverie-sounds\//.test(u)) {
          const ours = await presignReverieUrl(u);
          if (ours) return ours;
        }
        if (/[?&]X-Amz-/.test(u) && typeof needsRefresh === 'function' && needsRefresh(u, 3600)) {
          const re = await getNewS3URL(u);
          if (re) return re;
        }
      } catch (e) {
        logger.warn('[world] sound URL re-sign failed (serving stored):', e.message);
      }
      return u;
    };
    const manifest = { event: {}, room: {}, district: {}, versions: {} };
    for (const r of rows) {
      if (manifest[r.scopeType]) {
        manifest[r.scopeType][r.scopeId] = await fresh(r.url);
        manifest.versions[`${r.scopeType}:${r.scopeId}`] = r.updatedAt ? new Date(r.updatedAt).toISOString() : '';
      }
    }
    res.json(manifest);
  } catch (e) {
    logger.error('[world] sounds manifest failed:', e.message);
    res.status(500).json({ error: 'no sounds today' });
  }
});


/* ── THE LIVE STREAM (Sep 6 2026) ─────────────────────────────────────────
 * Server-sent events: everything that happens in your room, and everything
 * whispered to you, pushed as it lands — so a person can leave the page open
 * and HEAR the room without typing a thing. This is what makes hanging out
 * possible: two friends at Dez's talking, a citizen wandering in, the freight
 * horn at 11:40. Polls Mongo every two seconds per open connection (cheap;
 * one indexed read), advances the same lastSeenSeq cursor the command lane
 * uses, and nudges the world tick so the census keeps moving for a room that
 * is only listening. The client sends `live:true` on commands while this is
 * open, and the MEANWHILE recap stays quiet. */
const gateClosed = (req) => req.user.role !== 'ADMIN' && process.env.REVERIE_PUBLIC !== '1';
router.get('/stream', async (req, res) => {
  if (gateClosed(req)) return res.status(403).json({ error: 'the gate is closed' });
  const { MooChar, MooEvent } = require('~/models/kadeMoo');
  const userId = String(req.user.id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': reverie live\n\n');
  let alive = true;
  req.on('close', () => { alive = false; });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let beat = 0;
  let lastTouch = 0;
  let activeId = null;
  let cursor = 0;
  const resume = Number(req.query.after);
  try {
    while (alive) {
      const ch = await MooChar.findOne({ userId, active: true }).select('_id roomId lastSeenSeq attrs.seenEventSeqs').lean();
      if (!ch) { res.write('data: {"end":"no character"}\n\n'); break; }
      if (String(ch._id) !== activeId) {
        cursor = activeId === null && Number.isSafeInteger(resume) && resume >= 0 ? resume : (ch.lastSeenSeq || 0);
        activeId = String(ch._id);
        res.write(`data: ${JSON.stringify({ cursor, events: [] })}\n\n`);
      }
      const evs = await MooEvent.find({ roomId: { $in: [ch.roomId, `whisper:${userId}`] }, seq: { $gt: cursor, $nin: ch.attrs?.seenEventSeqs || [] }, actorUserId: { $ne: userId } }).sort({ seq: 1 }).limit(40).lean();
      if (evs.length) {
        cursor = evs[evs.length - 1].seq;
        await MooChar.updateOne({ _id: ch._id }, { $max: { lastSeenSeq: cursor } });
        res.write(`id: ${cursor}\ndata: ${JSON.stringify({ cursor, events: evs.map((e) => ({ seq: e.seq, kind: e.kind, text: e.text, sound: e.sound || null, actor: e.actorName, roomId: e.roomId, at: e.at })) })}\n\n`);
      } else if (beat % 8 === 0) {
        res.write(': hb\n\n');
      }
      beat++;
      const now = Date.now();
      if (now - lastTouch > 60000) {
        lastTouch = now;
        await MooChar.updateOne({ _id: ch._id }, { $set: { lastActiveAt: new Date() } });
        try { await reverie.tickWorld(); } catch (_) { /* the tick is never load-bearing */ }
      }
      await sleep(2000);
    }
  } catch (e) {
    logger.warn('[world] stream ended:', e && e.message);
  }
  try { res.end(); } catch (_) { /* gone */ }
});

/* HERE — the room, the people, the compass, the buttons, with no side
 * effects and no line in the log. The client calls it after a live event
 * says somebody came or went, so the panels stay true without a "look". */
router.get('/here', async (req, res) => {
  try {
    if (gateClosed(req)) return res.status(403).json({ error: 'the gate is closed' });
    const { MooChar } = require('~/models/kadeMoo');
    const view = require('~/app/clients/tools/kademoo/life/view');
    const ch = await MooChar.findOne({ userId: String(req.user.id), active: true }).lean();
    if (!ch) return res.json({ ok: false });
    const life = (ch.attrs && ch.attrs.life) || {};
    const ctx = { ch, userId: ch.userId, life, isWizard: req.user.role === 'ADMIN', _room: null, async room() { if (!this._room) this._room = await require('~/app/clients/tools/kademoo/life/ctx').roomOf(this.ch); return this._room; } };
    const [room, hud, actions] = await Promise.all([view.describeRoom(ctx), view.hud(ctx), view.actions(ctx)]);
    res.json({ ok: true, room, hud, actions, people: room.peopleDetail, exits: room.exitsDetail, district: room.district, mode: life.created && !life.wiz ? 'play' : 'create' });
  } catch (e) {
    logger.error('[world] here failed:', e.message);
    res.status(500).json({ error: 'the world flickered' });
  }
});

module.exports = router;
