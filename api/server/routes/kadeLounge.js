const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { KadeClubRoom } = require('~/models/kadeClubRoom');
const { SHARED_HEAD } = require('./kadePages');

/**
 * KADE'S CLUBHOUSE (born THE LOUNGE, July 24 2026 — renamed the same night
 * it first connected, per her vision doc CLUBHOUSE_VISION_2026-07-24.md).
 * TeamTalk-style HQ audio rooms: voice + hi-fi stereo music, self-hosted
 * LiveKit on her own Railway (lounge-livekit + lounge-turn relay).
 *
 * What lives here now (all spec'd in her own words the night the relay lane
 * first connected):
 *   1. THE SHARED JUKEBOX — one room-wide player. ANYONE can play / pause /
 *      skip / back / stop and it hits everyone, like a real living-room
 *      stereo. Add a song politely (queue) or rudely (cut in) — and if
 *      somebody skips your song you can hit back and have a radio fight.
 *      Radio fights are a feature, not a bug. No permission hierarchy in
 *      public rooms — the social layer IS the moderation (family scale).
 *      Implementation: data-channel state + HOST-HOP playback (the queue
 *      entry's adder publishes the audio; ownership hops with the queue) —
 *      zero new infra. Music VOLUME IS PERSONAL per listener (WebAudio gain
 *      on the music track only, voices untouched), default LOW so talk
 *      rides over the music out of the box. Her explicit design calls.
 *   2. THE HOTEL — private passcode rooms ("get a room" energy). Room
 *      registry in Mongo with HASHED speakable codes; the token mint
 *      refuses to sign without the right code. A Parlor party's table code
 *      works fine as a Hotel passcode — one code, cards AND voices.
 *   3. BOT GUESTS — invite a companion into a room as an honest turn-taking
 *      guest. A "Your turn" button cues it; between turns the room's speech
 *      is transcribed (existing Deepgram lane) as its listening context.
 *      Opt-in per room, kickable by anyone, obvious in the roster. The
 *      INVITER's device anchors the bot (captures the room mix, fetches the
 *      LLM turn + TTS, publishes the voice into the room) — no new service.
 *      Every turn is metered: kadeusage 'clubhouse_bot' (LLM) and
 *      'clubhouse_ears' (transcription seconds, logged by kadeTranscribe).
 *
 * WIRING (unchanged): LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET on
 * the LibreChat service. Missing vars = warm fail-soft. The /lounge URL
 * stays alive forever (native build 154's doorway points at it); /clubhouse
 * is the pretty new front door to the same page.
 *
 * Token shape (LiveKit spec): HS256 JWT, iss = API key, sub = identity,
 * `video` grant {room, roomJoin, canPublish, canSubscribe, canPublishData}.
 * 6-hour expiry — long movie nights welcome.
 */

const router = express.Router();

const ROOMS = [
  { key: 'porch', name: 'The Porch', blurb: 'The everyday hangout — come sit.' },
  { key: 'game-night', name: 'Game Night', blurb: 'Talk trash while the cards fly. Pairs with Parlor party tables.' },
  { key: 'music-night', name: 'Music Night', blurb: 'Load up the jukebox, fight over the skip button, may the best song win.' },
];

const HOTEL_MAX_ROOMS = 30;
const HOTEL_STALE_DAYS = 60;

function loungeConfigured() {
  return !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
}

/** July 24 2026 (Kade's first live tap: three connect tries all landed inside
 * the slept server's wake window): fire-and-forget WAKE PING at the LiveKit
 * HTTP root. Called when the page LOADS (/config) and again at token mint —
 * the room starts spinning up a good half-minute before anyone's connect
 * attempt, so the cold start happens while she's still picking a room. */
function wakeLoungeServer() {
  try {
    if (!process.env.LIVEKIT_URL) return;
    const httpUrl = process.env.LIVEKIT_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const axios = require('axios');
    axios.get(httpUrl, { timeout: 25000 }).catch(() => {});
  } catch (_) {
    /* waking is best-effort, never in the request path */
  }
}

function hashCode(key, code) {
  return crypto.createHash('sha256').update(String(key) + ':' + String(code)).digest('hex');
}

/** Speakable-code rule (platform-wide convention): lowercase letters and
 * numbers only, 3-16 chars. A Parlor table code (4 chars) passes on purpose. */
function normalizeCode(raw) {
  const code = String(raw || '').trim().toLowerCase();
  if (!/^[a-z0-9]{3,16}$/.test(code)) return null;
  return code;
}

async function listHotelRooms() {
  try {
    const rows = await KadeClubRoom.find({}).sort({ name: 1 }).limit(HOTEL_MAX_ROOMS).lean();
    return rows.map((r) => ({ key: r.key, name: r.name, by: r.createdByName || '', createdBy: String(r.createdBy) }));
  } catch (e) {
    logger.warn('[kade/lounge] hotel list unavailable: ' + e.message);
    return [];
  }
}

router.get('/config', requireJwtAuth, async (req, res) => {
  const uid = String(req.user.id);
  // July 24 2026, her call: Hotel rooms are HIDDEN — no public list, ever.
  // You see only rooms YOU opened (so you can close them); everybody else
  // checks in blind with the passcode. The code is the key.
  const hotel = (await listHotelRooms())
    .filter((r) => r.createdBy === uid)
    .map((r) => ({ key: r.key, name: r.name, mine: true }));
  if (!loungeConfigured()) {
    return res.json({ ready: false, rooms: ROOMS, hotel });
  }
  wakeLoungeServer(); // page just opened — start the room spinning now
  return res.json({ ready: true, url: process.env.LIVEKIT_URL, rooms: ROOMS, hotel });
});

/** Open a room in the Hotel. Body: { name, code }. */
router.post('/hotel', requireJwtAuth, express.json(), async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (name.length < 2) return res.status(400).json({ error: 'Give the room a name first.' });
    const code = normalizeCode(req.body?.code);
    if (!code) {
      return res.status(400).json({
        error: 'Passcodes are 3 to 16 letters and numbers, no spaces — keep it easy to say out loud.',
      });
    }
    // Polite housekeeping: rooms nobody has used in a couple months check out.
    try {
      const cutoff = new Date(Date.now() - HOTEL_STALE_DAYS * 24 * 60 * 60 * 1000);
      await KadeClubRoom.deleteMany({ lastUsedAt: { $lt: cutoff } });
    } catch (_) {}
    const existing = await KadeClubRoom.find({}).limit(HOTEL_MAX_ROOMS + 1).lean();
    if (existing.length >= HOTEL_MAX_ROOMS) {
      return res.status(400).json({ error: 'The Hotel is full — close an old room before opening another.' });
    }
    // Rooms are hidden, so the passcode alone finds the room at check-in —
    // which means codes must be unique across the whole Hotel.
    if (existing.some((r) => hashCode(r.key, code) === r.codeHash)) {
      return res.status(400).json({ error: 'That passcode is already keeping another room — pick a different one.' });
    }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 10) || 'room';
    const key = 'hotel-' + slug + '-' + crypto.randomBytes(2).toString('hex');
    const firstName = (req.user.name || 'Someone').trim().split(/\s+/)[0] || 'Someone';
    await KadeClubRoom.create({
      key,
      name,
      codeHash: hashCode(key, code),
      createdBy: String(req.user.id),
      createdByName: firstName,
    });
    logger.info('[kade/lounge] hotel room opened: ' + key + ' by ' + firstName);
    return res.json({ key, name });
  } catch (e) {
    logger.error('[kade/lounge hotel] error:', e);
    return res.status(500).json({ error: 'Could not open that room — try again.' });
  }
});

/** Check in: the passcode alone finds its room — rooms are hidden by
 * design ("They check in with pass codes"), and codes are unique across
 * the Hotel (enforced at create). The token mint still re-verifies. */
router.post('/hotel/checkin', requireJwtAuth, express.json(), async (req, res) => {
  try {
    const code = normalizeCode(req.body?.code);
    if (!code) {
      return res.status(400).json({ error: 'Passcodes are 3 to 16 letters and numbers, no spaces.' });
    }
    const rows = await KadeClubRoom.find({}).limit(HOTEL_MAX_ROOMS + 1).lean();
    const hit = rows.find((r) => hashCode(r.key, code) === r.codeHash);
    if (!hit) {
      return res.status(404).json({ error: 'No room answers to that code — double-check it with whoever opened the room.' });
    }
    return res.json({ key: hit.key, name: hit.name });
  } catch (e) {
    logger.error('[kade/lounge hotel checkin] error:', e);
    return res.status(500).json({ error: 'The front desk hiccuped — try again.' });
  }
});

/** Close a Hotel room you opened. */
router.delete('/hotel/:key', requireJwtAuth, async (req, res) => {
  try {
    const key = String(req.params.key || '');
    const doc = await KadeClubRoom.findOne({ key }).lean();
    if (!doc) return res.status(404).json({ error: 'No such room.' });
    if (String(doc.createdBy) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Only the one who opened this room can close it.' });
    }
    await KadeClubRoom.deleteOne({ key });
    return res.json({ ok: true });
  } catch (e) {
    logger.error('[kade/lounge hotel close] error:', e);
    return res.status(500).json({ error: 'Could not close that room.' });
  }
});

router.post('/token', requireJwtAuth, express.json(), async (req, res) => {
  try {
    if (!loungeConfigured()) {
      return res.status(503).json({
        error:
          "The Clubhouse is built but its room server isn't wired in yet — Kade just needs to drop the LiveKit keys into Railway.",
      });
    }
    let room = String(req.body?.room || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
    if (!room) return res.status(400).json({ error: 'Which room?' });
    // Parlor fusion: joining by a 4-char table code lands everyone from that
    // party table in the same voice room, no extra coordination.
    if (/^[a-z0-9]{4}$/.test(room) && !ROOMS.some((r) => r.key === room)) {
      room = 'table-' + room;
    }
    // THE HOTEL: a private room's key only unlocks with its passcode.
    if (room.startsWith('hotel-')) {
      const doc = await KadeClubRoom.findOne({ key: room }).lean();
      if (!doc) return res.status(404).json({ error: 'That Hotel room has checked out.' });
      const code = normalizeCode(req.body?.code);
      if (!code || hashCode(room, code) !== doc.codeHash) {
        return res.status(403).json({ error: "That's not this room's passcode." });
      }
      KadeClubRoom.updateOne({ key: room }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
    }
    wakeLoungeServer(); // belt and braces — token mint = a join is seconds away
    const firstName = (req.user.name || 'Someone').trim().split(/\s+/)[0] || 'Someone';
    const identity = firstName + '-' + String(req.user.id).slice(-4);
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      {
        iss: process.env.LIVEKIT_API_KEY,
        sub: identity,
        name: firstName,
        nbf: now - 10,
        exp: now + 6 * 60 * 60,
        video: {
          room,
          roomJoin: true,
          canPublish: true,
          canSubscribe: true,
          canPublishData: true,
        },
      },
      process.env.LIVEKIT_API_SECRET,
      { algorithm: 'HS256' },
    );
    return res.json({ token, url: process.env.LIVEKIT_URL, room, identity, name: firstName });
  } catch (e) {
    logger.error('[kade/lounge token] error:', e);
    return res.status(500).json({ error: 'Could not mint a room key.' });
  }
});

/**
 * BOT GUEST TURN — the inviter's device (the bot's "anchor") posts the
 * room's rolling transcript here when somebody presses the bot's talk
 * button. Runs ONE in-character turn on the agent's own model (same recipe
 * as Parlor table talk), resolves the agent's real voice through the
 * unified resolver, meters the cost, and hands text + voice back for the
 * anchor to TTS and publish into the room.
 */
router.post('/bot-turn', requireJwtAuth, express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const userId = String(req.user.id);
    const agentId = String(req.body?.agentId || '').slice(0, 64);
    if (!agentId) return res.status(400).json({ error: 'Which companion?' });
    const roomLabel = String(req.body?.roomLabel || 'the Clubhouse').slice(0, 60);
    const transcript = String(req.body?.transcript || '').slice(-4000);
    const cuedBy = String(req.body?.cuedBy || 'Someone').slice(0, 40);

    const db = require('~/models');
    const agent = await db.getAgent({ id: agentId });
    if (!agent) return res.status(410).json({ error: 'That companion is not around anymore.' });
    // Same visibility rule as the roster: ACL-public agents or your own.
    try {
      const { ResourceType, PermissionBits } = require('librechat-data-provider');
      const { findPubliclyAccessibleResources } = require('~/server/services/PermissionService');
      const publicIds = await findPubliclyAccessibleResources({
        resourceType: ResourceType.AGENT,
        requiredPermissions: PermissionBits.VIEW,
      });
      const isPublic = agent._id && publicIds.map((x) => String(x)).includes(String(agent._id));
      const isMine = String(agent.author) === userId;
      if (!isPublic && !isMine) {
        return res.status(403).json({ error: 'That companion is private.' });
      }
    } catch (aclErr) {
      logger.warn('[kade/lounge bot-turn] ACL check unavailable: ' + aclErr.message);
    }

    const axios = require('axios');
    const key = process.env.OPENROUTER_KEY;
    if (!key) return res.status(503).json({ error: 'Bot guests are resting right now.' });
    const system = [
      'You are ' + (agent.name || 'a companion') + ', a GUEST sitting in "' + roomLabel + '" — a live family voice room in Kade\'s Clubhouse. Real people are talking out loud around you.',
      '',
      'Your persona:',
      String(agent.instructions || '(no special persona — be yourself)').slice(0, 1400),
      '',
      'You have been listening politely. Below is a rough live transcription of what the room has been saying (it is messy, unattributed, and may mishear words — roll with it, never complain about transcription quality).',
      cuedBy + ' just pressed your talk button — it is YOUR turn to speak, out loud, to the whole room.',
      'Reply with ONE natural spoken contribution: under 60 words, no stage directions, no markdown, no lists. React to what was actually said when you can.',
    ].join('\n');
    const userMsg = transcript
      ? 'What the room has been saying (rough transcription):\n' + transcript
      : 'The room just went quiet — nobody has said much yet. Break the ice.';
    /* The agent's own model first; ONE retry on flash-lite if it errors or
     * answers empty (same failure class the Parlor's first live table-talk
     * hit — a live voice room can't afford a silent guest). */
    async function oneTurn(model) {
      const rr = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model,
          max_tokens: 220,
          messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
          usage: { include: true },
        },
        {
          headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://kademurdock.com', 'X-Title': 'Kade-AI Clubhouse' },
          timeout: 45000,
        },
      );
      const text = String(rr.data?.choices?.[0]?.message?.content || '').replace(/%%%[^%]*%%%/g, ' ').replace(/["“”*_#]/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 480);
      return { text, usage: rr.data?.usage };
    }
    const FALLBACK_MODEL = 'google/gemini-3.1-flash-lite';
    let turn;
    try {
      turn = await oneTurn(agent.model || FALLBACK_MODEL);
      if (!turn.text && (agent.model && agent.model !== FALLBACK_MODEL)) turn = await oneTurn(FALLBACK_MODEL);
    } catch (modelErr) {
      if (agent.model && agent.model !== FALLBACK_MODEL) {
        logger.warn('[kade/lounge bot-turn] ' + agent.model + ' failed (' + modelErr.message + ') — retrying on ' + FALLBACK_MODEL);
        turn = await oneTurn(FALLBACK_MODEL);
      } else {
        throw modelErr;
      }
    }
    const line = turn.text;
    if (!line) return res.status(502).json({ error: (agent.name || 'The guest') + ' just smiled and said nothing.' });

    // The agent's REAL voice, same chain every other surface uses
    // (personal pick -> builder default -> name match -> platform default).
    let voice = null;
    try {
      const { resolveVoice } = require('~/server/services/kadeVoiceResolver');
      const resolved = await resolveVoice({ userId, agentId, surface: 'web' });
      if (resolved && resolved.voice) voice = resolved.voice;
    } catch (vErr) {
      logger.warn('[kade/lounge bot-turn] voice resolver unavailable: ' + vErr.message);
    }
    if (!voice) voice = (agent.tts && agent.tts.voiceId) || null;

    try {
      const { logKadeUsage } = require('~/models/kadeUsage');
      const cost = typeof turn.usage?.cost === 'number' ? turn.usage.cost : ((turn.usage?.total_tokens || 0) / 1e6) * 1.0;
      logKadeUsage({ userId, service: 'clubhouse_bot', quantity: 1, unit: 'turns', costUSD: cost, metadata: { agentId, kind: 'bot_turn', roomLabel } });
    } catch (_) { /* never break the room */ }
    return res.json({ name: agent.name || 'Guest', line, voice });
  } catch (e) {
    logger.error('[kade/lounge bot-turn] error:', e);
    return res.status(500).json({ error: 'The guest lost their train of thought — cue them again.' });
  }
});

/* ── The page ─────────────────────────────────────────────────────────── */
const loungeHtml = `<!doctype html><html lang="en"><head><title>Kade's Clubhouse</title>${SHARED_HEAD}
<style>
  .rowbtn { font: inherit; background: #1f7a49; color: #fff; border: 0; border-radius: 10px; padding: .7rem 1.1rem; font-weight: 600; cursor: pointer; margin: .35rem .4rem .35rem 0; }
  .rowbtn.gray { background: #5b6270; }
  .rowbtn.red { background: #a33; }
  .rowbtn.small { padding: .45rem .7rem; font-size: .9rem; font-weight: 600; }
  .rowbtn:focus-visible, button.room:focus-visible { outline: 3px solid #ffbf47; outline-offset: 2px; }
  button.room { display:block; width:100%; text-align:left; font:inherit; background:#fff; color:inherit; border:1px solid #cdd3da; border-radius:12px; padding:.85rem 1rem; margin:.45rem 0; cursor:pointer; }
  button.room .desc { display:block; font-weight:400; opacity:.8; font-size:.92rem; margin-top:.15rem; }
  @media (prefers-color-scheme: dark) { button.room { background:#1e2127; border-color:#3a4150; } }
  #roster li { margin:.35rem 0; }
  .talking { font-weight:700; }
  label.blk { display:block; margin:.7rem 0 .25rem; font-weight:600; }
  input[type="text"], input[type="password"], select { font:inherit; padding:.55rem .6rem; border-radius:9px; border:1px solid #cdd3da; background:#fff; color:inherit; max-width:100%; }
  @media (prefers-color-scheme: dark) { input[type="text"], input[type="password"], select { background:#1e2127; border-color:#3a4150; } }
  ol#jb-queue { padding-left:1.3rem; margin:.5rem 0; }
  ol#jb-queue li { margin:.45rem 0; }
  input[type="range"] { width: min(100%, 340px); accent-color:#1f7a49; }
  .nowline { font-weight:600; }
</style>
</head>
<body>
  <p><a class="back" href="/" aria-label="Back to chat">&larr; Back to chat</a> &nbsp;&middot;&nbsp; <a class="back" href="/parlor">The Parlor</a> &nbsp;&middot;&nbsp; <a class="back" href="/help/whats-new">What's new</a></p>
  <h1>Kade's Clubhouse</h1>
  <div id="status" class="status" role="status" aria-live="polite">Opening the Clubhouse&hellip;</div>

  <section id="pick" hidden>
    <p class="muted">Family voice rooms with real stereo sound. Sit and talk, load the shared jukebox, invite a companion to hang out &mdash; or get a private room in the Hotel.</p>
    <div id="room-list"></div>

    <div class="card">
      <h2 style="margin-top:0">The Hotel &mdash; private rooms</h2>
      <p class="muted">Rooms stay off the list on purpose &mdash; the code is the key. Check in with your group's passcode, or open a room of your own and pass the code around. A Parlor party's table code can be a passcode too.</p>
      <label class="blk" for="hotel-code">Your group's passcode</label>
      <input type="text" id="hotel-code" maxlength="16" autocapitalize="none" autocomplete="off">
      <p><button type="button" class="rowbtn" id="hotel-checkin">Check in</button></p>
      <div id="hotel-mine"></div>
      <h3>Open a room</h3>
      <label class="blk" for="hotel-name">Room name</label>
      <input type="text" id="hotel-name" maxlength="40">
      <label class="blk" for="hotel-newcode">Passcode &mdash; letters and numbers, easy to say out loud</label>
      <input type="text" id="hotel-newcode" maxlength="16" autocapitalize="none" autocomplete="off">
      <p><button type="button" class="rowbtn" id="hotel-create">Open the room</button></p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Join a game table's room</h2>
      <label class="blk" for="code">The Parlor party code</label>
      <input type="text" id="code" maxlength="8" autocapitalize="characters" style="text-transform:uppercase">
      <p><button type="button" class="rowbtn" id="join-code">Join that table's voices</button></p>
    </div>
  </section>

  <section id="room" hidden>
    <h2 id="room-title"></h2>
    <div id="rstatus" class="status" role="status" aria-live="polite" tabindex="-1"></div>
    <div class="card">
      <h3 style="margin-top:0" id="roster-h">Who's here</h3>
      <ul id="roster" style="list-style:none;padding:0;margin:0" aria-labelledby="roster-h"></ul>
    </div>
    <p>
      <button type="button" class="rowbtn" id="btn-mic">Mute my mic</button>
      <button type="button" class="rowbtn gray" id="btn-who">Say who's here</button>
      <button type="button" class="rowbtn red" id="btn-leave">Leave the room</button>
    </p>

    <div class="card">
      <h3 style="margin-top:0">The jukebox</h3>
      <p class="muted">One player for the whole room &mdash; anybody can play, pause, skip, or jump back. Queue your song politely, or cut in and start a radio fight. House rule: volume is yours alone.</p>
      <p id="jb-now" class="nowline" aria-live="off">Nothing playing yet.</p>
      <p>
        <button type="button" class="rowbtn" id="jb-toggle">Play</button>
        <button type="button" class="rowbtn gray" id="jb-back">Back a song</button>
        <button type="button" class="rowbtn gray" id="jb-skip">Skip ahead</button>
        <button type="button" class="rowbtn red" id="jb-stop">Stop the music</button>
      </p>
      <h4 style="margin:.8rem 0 .2rem">Up next</h4>
      <ol id="jb-queue" aria-label="The queue"></ol>
      <label class="blk" for="jb-file">Add a song or any audio file</label>
      <input type="file" id="jb-file" accept="audio/*">
      <p>
        <button type="button" class="rowbtn" id="jb-cutin" hidden>Cut in and play it now</button>
        <button type="button" class="rowbtn gray" id="jb-queue-add" hidden>Add it to the queue</button>
      </p>
      <label class="blk" for="jb-vol">My music volume &mdash; just for my ears</label>
      <input type="range" id="jb-vol" min="0" max="100" step="5" value="25" aria-label="My music volume, percent">
      <p class="muted" style="font-size:.85rem">Music starts low by default so talk rides over it. Voices always come through at full volume.</p>
    </div>

    <div class="card" id="bot-card">
      <h3 style="margin-top:0">Company</h3>
      <p class="muted">Invite a companion to sit in as a guest. They take turns like a polite guest: press their talk button when it's their turn, and they answer out loud in their own voice. Between turns they listen along through a rough transcription. Anyone can ask them to leave.</p>
      <div id="bot-invite-row">
        <label class="blk" for="bot-pick">Who to invite</label>
        <select id="bot-pick"><option value="">Loading companions&hellip;</option></select>
        <p><button type="button" class="rowbtn" id="bot-invite">Invite them in</button></p>
      </div>
      <p id="bot-line" aria-live="polite"></p>
    </div>
  </section>

  <footer class="muted">Your voices never touch the AI unless you invite a guest &mdash; the Clubhouse is person-to-person audio on Kade's own room server. &mdash; Kade-AI</footer>

  <script src="https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.min.js"></script>
  <script>
    (async function(){
      const $ = (id) => document.getElementById(id);
      const status = $('status');
      // July 24 2026: the NATIVE app opens this page in an in-app WebKit
      // screen and hands its own sign-in over in the URL FRAGMENT (never
      // sent to the server, never logged): /lounge#lktok=<jwt>. Fragment
      // wins when present; the cookie-refresh path stays for browsers.
      let token = null;
      try {
        const m = /[#&]lktok=([^&]+)/.exec(location.hash || '');
        if (m) {
          token = decodeURIComponent(m[1]);
          history.replaceState(null, '', location.pathname); // scrub the hash
        }
      } catch(e) {}
      if (!token) { try { token = await getToken(); } catch(e) {} }
      if(!token){ status.className='status err'; status.textContent='Please sign in at the chat site first, then reload this page.'; return; }
      if(typeof LivekitClient === 'undefined'){
        status.className='status err';
        status.textContent='The audio engine could not load — check the connection and reload.';
        return;
      }
      const LK = LivekitClient;
      const AC = window.AudioContext || window.webkitAudioContext;

      let cfg;
      try{
        const r = await apiGet('/api/kade/lounge/config', token);
        cfg = await r.json();
      }catch(e){ status.className='status err'; status.textContent='Could not reach the Clubhouse — try a reload.'; return; }

      /* ── the picker ── */
      $('room-list').innerHTML = (cfg.rooms||[]).map(function(r){
        return '<button type="button" class="room" data-room="'+r.key+'">'+r.name+' <span class="desc">'+r.blurb+'</span></button>';
      }).join('');
      function renderHotel(list){
        // Only rooms YOU opened ever render — the Hotel keeps no public list.
        if(!list || !list.length){ $('hotel-mine').innerHTML = ''; return; }
        $('hotel-mine').innerHTML = '<h3>Rooms you opened</h3>' + list.map(function(h){
          return '<p>'+esc(h.name)+' <button type="button" class="rowbtn small red" data-close="'+h.key+'">Close this room</button></p>';
        }).join('');
      }
      function esc(s){ var d=document.createElement('div'); d.textContent = s || ''; return d.innerHTML.replace(/"/g,'&quot;'); }
      renderHotel(cfg.hotel);
      $('pick').hidden = false;
      if(!cfg.ready){
        status.className = 'status';
        status.textContent = "The Clubhouse is built and ready — it's just waiting on Kade to drop the room-server keys into Railway. Two-minute job, then this page comes alive.";
      } else {
        status.textContent = 'Pick a room.';
      }

      /* ── shared room state ── */
      let lkRoom = null;
      let micTrack = null;
      let micMuted = false;
      let myIdentity = null;
      let myName = null;
      let roomLabel = '';

      function say(text){ $('rstatus').textContent = text; }

      function rosterParts(){
        if(!lkRoom) return [];
        return [lkRoom.localParticipant].concat(Array.from(lkRoom.remoteParticipants.values()));
      }
      function rosterNames(){
        return rosterParts().map(function(p){ return (p.name || p.identity || 'Someone'); });
      }
      function present(identity){
        if(!lkRoom) return false;
        if(identity === myIdentity) return true;
        return Array.from(lkRoom.remoteParticipants.values()).some(function(p){ return p.identity === identity; });
      }
      function stewardId(){
        var ids = rosterParts().map(function(p){ return p.identity; });
        ids.sort();
        return ids[0];
      }

      function renderRoster(){
        if(!lkRoom) return;
        const speaking = new Set((lkRoom.activeSpeakers||[]).map(function(p){ return p.identity; }));
        var html = rosterParts().map(function(p){
          const me = p === lkRoom.localParticipant;
          const talking = speaking.has(p.identity);
          return '<li'+(talking?' class="talking"':'')+'>'+(p.name||p.identity)+(me?' (you)':'')+(talking?' — talking':'')+'</li>';
        }).join('');
        if(BOT){
          html += '<li>'+esc(BOT.name)+' — companion guest, invited by '+esc(BOT.anchorName||'someone')+(botBusy? ' — thinking' : '')+
            ' <button type="button" class="rowbtn small" data-botact="cue">Your turn, '+esc(BOT.name)+'</button>'+
            ' <button type="button" class="rowbtn small gray" data-botact="kick">Ask them to leave</button></li>';
        }
        $('roster').innerHTML = html;
        $('bot-invite-row').hidden = !!BOT;
      }

      /* ── THE SHARED JUKEBOX + BOT GUEST state (data-channel, host-hop) ──
       * One CLUB state for the whole room. The AUTHORITY (the current
       * song's adder if present, else the alphabetically-first identity)
       * applies every command, bumps the version, and broadcasts. Every
       * device then reconciles: "is it MY file that should be playing?
       * start/stop accordingly." Music files never leave the phone that
       * added them — the audio itself rides the room as a hi-fi track. */
      let CLUB = { v:0, actn:0, act:'', jb:{ queue:[], curId:null, playing:false, pos:-1 } };
      let lastActn = 0;
      let BOT = null;       // {agentId,name,anchor,anchorName}
      let botBusy = false;

      const myFiles = {};   // entry id -> File (only my own adds)
      const myBuffers = {}; // entry id -> AudioBuffer (my own, decoded)
      const myPos = {};     // entry id -> seconds to resume from (radio fights)
      let jbCtx=null, jbDest=null, jbMonitor=null, jbSrc=null, jbTrack=null;
      let playingEntryId=null, jbStartOffset=0, jbStartTime=0, jbStopping=false, jbSession=0;
      let musicVol = 0.25;
      try{ var sv = parseInt(localStorage.getItem('kadeClubMusicVol'), 10); if(!isNaN(sv)) musicVol = Math.max(0, Math.min(100, sv))/100; }catch(e){}
      $('jb-vol').value = String(Math.round(musicVol*100));

      /* personal listening lane: remote music plays through a WebAudio gain
       * (iPhones ignore element volume; a muted keepalive element + gain
       * node works everywhere). Voices attach plain at full volume. */
      let listenCtx = null;
      let musicGains = [];
      function ensureListenCtx(){
        if(!listenCtx){ try{ listenCtx = new AC(); }catch(e){ return null; } }
        if(listenCtx.state === 'suspended'){ try{ listenCtx.resume(); }catch(e){} }
        return listenCtx;
      }
      function wireMusicGain(track){
        var ctx = ensureListenCtx(); if(!ctx) return false;
        try{
          var src = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
          var g = ctx.createGain(); g.gain.value = musicVol;
          src.connect(g); g.connect(ctx.destination);
          musicGains.push({ track: track, src: src, gain: g });
          return true;
        }catch(e){ return false; }
      }
      function unwireMusicGain(track){
        musicGains = musicGains.filter(function(m){
          if(m.track !== track) return true;
          try{ m.src.disconnect(); m.gain.disconnect(); }catch(e){}
          return false;
        });
      }
      function applyMusicVol(){
        musicGains.forEach(function(m){ try{ m.gain.gain.value = musicVol; }catch(e){} });
        if(jbMonitor){ try{ jbMonitor.gain.value = musicVol; }catch(e){} }
      }
      $('jb-vol').addEventListener('input', function(){
        musicVol = Math.max(0, Math.min(100, parseInt($('jb-vol').value,10)||0))/100;
        try{ localStorage.setItem('kadeClubMusicVol', String(Math.round(musicVol*100))); }catch(e){}
        applyMusicVol();
      });

      /* ── data channel ── */
      function sendData(obj){
        if(!lkRoom) return;
        try{
          lkRoom.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(obj)), { reliable: true, topic: 'club' });
        }catch(e){}
      }
      function curIndex(){
        var jb = CLUB.jb;
        for(var i=0;i<jb.queue.length;i++){ if(jb.queue[i].id === jb.curId) return i; }
        return -1;
      }
      function curEntry(){ var i = curIndex(); return i>=0 ? CLUB.jb.queue[i] : null; }
      function entryById(id){ for(var i=0;i<CLUB.jb.queue.length;i++){ if(CLUB.jb.queue[i].id===id) return CLUB.jb.queue[i]; } return null; }
      function authorityId(){
        var cur = curEntry();
        if(cur && present(cur.by)) return cur.by;
        return stewardId();
      }
      function iAmAuthority(){ return lkRoom && authorityId() === myIdentity; }
      function nextPlayable(fromIndex, dir){
        var q = CLUB.jb.queue;
        for(var i=fromIndex+dir; i>=0 && i<q.length; i+=dir){
          if(present(q[i].by)) return q[i];
        }
        return null;
      }
      function setCurrentId(id){ CLUB.jb.curId = id; CLUB.jb.pos = -1; }
      function setAct(text){ CLUB.act = text; CLUB.actn++; }
      function broadcastState(){
        sendData({ t:'state', v: CLUB.v, actn: CLUB.actn, act: CLUB.act, jb: CLUB.jb });
      }
      function bumpBroadcast(){
        CLUB.v++;
        broadcastState();
        if(CLUB.actn > lastActn){ lastActn = CLUB.actn; if(CLUB.act) say(CLUB.act); }
        reconcile();
        renderJukebox();
      }
      function adoptState(msg){
        if(!(msg.v > CLUB.v)) return;
        CLUB.v = msg.v; CLUB.jb = msg.jb || CLUB.jb; CLUB.act = msg.act || ''; CLUB.actn = msg.actn || 0;
        if(CLUB.actn > lastActn){ lastActn = CLUB.actn; if(CLUB.act) say(CLUB.act); }
        reconcile();
        renderJukebox();
      }
      function normalizeCurrent(){
        var jb = CLUB.jb;
        if(!jb.curId) return;
        var c = entryById(jb.curId);
        if(!c){ jb.curId = null; jb.playing = false; return; }
        if(jb.playing && !present(c.by)){
          var n = nextPlayable(curIndex(), +1);
          if(n){ setCurrentId(n.id); setAct((c.byName||'Somebody') + " left and took their song along — next up: " + n.title + "."); }
          else { jb.playing = false; setAct((c.byName||'Somebody') + " left and took their song along. Music off."); }
        }
      }
      function applyCmd(m){
        var jb = CLUB.jb; var i = curIndex(); var who = m.fromName || 'Somebody';
        if(m.cmd === 'play'){
          if(!jb.curId){ var f = nextPlayable(-1, +1); if(f) setCurrentId(f.id); }
          if(jb.curId){ jb.playing = true; setAct(who + ' pressed play.'); }
        } else if(m.cmd === 'pause'){
          if(jb.playing){ jb.playing = false; jb.pos = -1; setAct(who + ' paused the music.'); }
        } else if(m.cmd === 'stop'){
          if(jb.curId){ jb.playing = false; jb.pos = 0; setAct(who + ' stopped the music.'); }
        } else if(m.cmd === 'skip'){
          var n = nextPlayable(i, +1);
          if(n){ setCurrentId(n.id); jb.playing = true; setAct(who + ' skipped ahead to ' + n.title + '.'); }
          else if(jb.curId){ jb.playing = false; jb.pos = 0; setAct(who + ' skipped — that was the end of the queue.'); }
        } else if(m.cmd === 'back'){
          var p = nextPlayable(i, -1);
          if(p){ setCurrentId(p.id); jb.playing = true; setAct(who + ' went back to ' + p.title + '.'); }
          else if(jb.curId){ jb.pos = 0; jb.playing = true; setAct(who + ' started the song over.'); }
        } else if(m.cmd === 'jump'){
          var e = entryById(m.id);
          if(e && present(e.by)){ setCurrentId(e.id); jb.playing = true; setAct(who + ' jumped to ' + e.title + '.'); }
        } else if(m.cmd === 'remove'){
          var r = entryById(m.id);
          if(r){
            var wasCur = jb.curId === r.id;
            var n2 = wasCur ? nextPlayable(curIndex(), +1) : null;
            jb.queue = jb.queue.filter(function(x){ return x.id !== r.id; });
            if(wasCur){
              if(n2){ setCurrentId(n2.id); } else { jb.curId = null; jb.playing = false; }
            }
            setAct(who + ' took ' + r.title + ' off the list.');
          }
        } else if(m.cmd === 'ended'){
          var n3 = nextPlayable(i, +1);
          if(n3){ setCurrentId(n3.id); jb.playing = true; setAct('Next up: ' + n3.title + '.'); }
          else { jb.playing = false; jb.pos = 0; setAct('That was the end of the queue.'); }
        }
        normalizeCurrent();
        bumpBroadcast();
      }
      function applyAdd(entry, interrupt, fromName){
        var jb = CLUB.jb;
        if(interrupt && jb.curId){
          var i = curIndex();
          jb.queue.splice(i+1, 0, entry);
          setCurrentId(entry.id); jb.playing = true;
          setAct(fromName + ' cut in with ' + entry.title + '.');
        } else {
          jb.queue.push(entry);
          if(!jb.curId){ setCurrentId(entry.id); jb.playing = true; setAct(fromName + ' dropped a quarter in: ' + entry.title + '.'); }
          else { setAct(fromName + ' queued up ' + entry.title + '.'); }
        }
        normalizeCurrent();
        bumpBroadcast();
      }
      function clubCmd(cmd, extra){
        var msg = Object.assign({ t:'cmd', cmd: cmd, fromName: myName }, extra || {});
        if(iAmAuthority()){ applyCmd(msg); } else { sendData(msg); }
      }

      /* ── my playback engine (only for entries I added) ── */
      function myCurrentPos(){
        if(!jbCtx || !jbSrc) return 0;
        return jbStartOffset + (jbCtx.currentTime - jbStartTime);
      }
      async function getBuffer(id){
        if(myBuffers[id]) return myBuffers[id];
        var f = myFiles[id];
        if(!f) throw new Error('no file');
        var scratch = jbCtx || new AC();
        var buf = await scratch.decodeAudioData(await f.arrayBuffer());
        Object.keys(myBuffers).forEach(function(k){ if(k !== id) delete myBuffers[k]; });
        myBuffers[id] = buf;
        return buf;
      }
      async function startPlayback(entry){
        var session = ++jbSession;
        var prevId = playingEntryId;
        if(jbSrc && prevId && prevId !== entry.id){ myPos[prevId] = myCurrentPos(); }
        playingEntryId = entry.id;
        try{
          if(!jbCtx){
            jbCtx = new AC();
            jbDest = jbCtx.createMediaStreamDestination();
            jbMonitor = jbCtx.createGain();
            jbMonitor.gain.value = musicVol;
            jbMonitor.connect(jbCtx.destination);
          }
          if(jbCtx.state === 'suspended'){ try{ await jbCtx.resume(); }catch(e){} }
          var buf = await getBuffer(entry.id);
          if(session !== jbSession) return;
          if(!jbTrack){
            jbTrack = jbDest.stream.getAudioTracks()[0];
            await lkRoom.localParticipant.publishTrack(jbTrack, {
              dtx: false,
              red: false,
              audioPreset: LK.AudioPresets.musicHighQualityStereo,
              source: LK.Track.Source.Unknown,
              name: 'music',
            });
            if(session !== jbSession) return;
          }
          if(jbSrc){ jbStopping = true; try{ jbSrc.onended=null; jbSrc.stop(); }catch(e){} jbStopping = false; jbSrc = null; }
          var offset = (CLUB.jb.pos === 0) ? 0 : (myPos[entry.id] || 0);
          if(offset >= buf.duration - 0.3) offset = 0;
          jbSrc = jbCtx.createBufferSource();
          jbSrc.buffer = buf;
          jbSrc.connect(jbDest);
          jbSrc.connect(jbMonitor);
          jbStartOffset = offset; jbStartTime = jbCtx.currentTime;
          var thisId = entry.id;
          jbSrc.onended = function(){
            if(jbStopping || playingEntryId !== thisId) return;
            myPos[thisId] = 0;
            playingEntryId = null; jbSrc = null;
            if(iAmAuthority()){ applyCmd({ cmd:'ended', fromName:'' }); }
          };
          jbSrc.start(0, offset);
        }catch(e){
          playingEntryId = null;
          say("That file would not play — try an MP3, M4A, or WAV.");
          clubCmd('remove', { id: entry.id });
        }
      }
      function stopPlayback(savePos){
        jbSession++;
        if(jbSrc){
          jbStopping = true;
          if(savePos && playingEntryId){ myPos[playingEntryId] = myCurrentPos(); }
          try{ jbSrc.onended = null; jbSrc.stop(); }catch(e){}
          jbStopping = false;
          jbSrc = null;
        }
        if(jbTrack && lkRoom){
          try{ lkRoom.localParticipant.unpublishTrack(jbTrack, true); }catch(e){}
          jbTrack = null;
        }
        playingEntryId = null;
      }
      function reconcile(){
        var cur = curEntry();
        var mine = cur && CLUB.jb.playing && cur.by === myIdentity;
        if(mine){
          if(playingEntryId !== cur.id){ startPlayback(cur); }
          else if(CLUB.jb.pos === 0 && myCurrentPos() > 1.5){ CLUB.jb.pos = -1; myPos[cur.id] = 0; startPlayback(cur); }
        } else if(playingEntryId){
          stopPlayback(true);
        }
      }
      function renderJukebox(){
        var jb = CLUB.jb; var cur = curEntry();
        $('jb-now').textContent = cur
          ? ((jb.playing ? 'Now playing: ' : 'Paused: ') + cur.title + ' — brought by ' + cur.byName)
          : 'Nothing playing yet.';
        $('jb-toggle').textContent = jb.playing ? 'Pause the music' : 'Play';
        $('jb-queue').innerHTML = jb.queue.map(function(e2){
          var here = present(e2.by);
          var mark = e2.id === jb.curId ? (jb.playing ? ' — playing' : ' — paused') : (here ? '' : ' — owner stepped out');
          return '<li>' + esc(e2.title) + ' <span class="muted">(' + esc(e2.byName) + ')</span>' + mark +
            ' <button type="button" class="rowbtn small" data-jump="' + e2.id + '">Play this now</button>' +
            ' <button type="button" class="rowbtn small gray" data-drop="' + e2.id + '">Take it off</button></li>';
        }).join('');
      }

      /* ── the room ── */
      async function joinRoom(roomKey, label, hotelCode){
        status.textContent = 'Getting your room key…';
        let mint;
        try{
          const r = await fetch('/api/kade/lounge/token', { method:'POST', headers:{ 'Authorization':'Bearer '+token, 'Content-Type':'application/json' }, body: JSON.stringify({ room: roomKey, code: hotelCode || undefined }) });
          mint = await r.json();
          if(!r.ok) throw new Error(mint.error || 'No key.');
        }catch(e){ status.className='status err'; status.textContent = e.message; return; }
        status.className = 'status';
        myIdentity = mint.identity; myName = mint.name || (mint.identity||'Me').split('-')[0];
        roomLabel = label;

        lkRoom = new LK.Room({ adaptiveStream: false, dynacast: false });
        wireRoomEvents();
        // Waking-the-room retry: a slept Railway service can take 10-25s to
        // wake — eight patient tries (~30s), progress SAID each round; the
        // server-side wake ping has usually finished the job before try 3.
        let attempt = 0;
        while(true){
          attempt++;
          try{
            status.textContent = attempt === 1
              ? 'Connecting…'
              : 'Waking the room up — still warming, try ' + attempt + ' of 8…';
            await lkRoom.connect(mint.url, mint.token);
            break;
          }catch(e){
            if(attempt >= 8){ status.className='status err'; status.textContent='The room server never answered — it may need a look. Try once more in a minute.'; return; }
            await new Promise(function(res){ setTimeout(res, 3500); });
          }
        }
        ensureListenCtx();
        try{
          micTrack = await LK.createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true });
          await lkRoom.localParticipant.publishTrack(micTrack);
        }catch(e){
          say('Mic permission was refused — you can listen, but the room cannot hear you.');
        }
        $('pick').hidden = true;
        $('room').hidden = false;
        $('room-title').textContent = label;
        micMuted = false;
        $('btn-mic').textContent = 'Mute my mic';
        CLUB = { v:0, actn:0, act:'', jb:{ queue:[], curId:null, playing:false, pos:-1 } };
        lastActn = 0; BOT = null; botBusy = false;
        renderRoster(); renderJukebox();
        loadBotRoster();
        say('You are in ' + label + ' with ' + Math.max(0, rosterNames().length - 1) + ' other' + (rosterNames().length === 2 ? '' : 's') + '. Your mic is live.');
        $('rstatus').focus();
        setTimeout(function(){ sendData({ t:'hello' }); }, 700);
      }

      function wireRoomEvents(){
        lkRoom
          .on(LK.RoomEvent.TrackSubscribed, function(track, pub){
            if(track.kind !== 'audio') return;
            var nm = (pub && (pub.trackName || pub.name)) || '';
            var el = track.attach();
            el.setAttribute('aria-hidden', 'true');
            el.dataset.club = nm || 'voice';
            if(nm === 'music'){
              el.muted = true; el.volume = 0; // keepalive only — audible lane is the gain node
              if(!wireMusicGain(track)){ el.muted = false; try{ el.volume = musicVol; }catch(e){} }
            }
            document.body.appendChild(el);
          })
          .on(LK.RoomEvent.TrackUnsubscribed, function(track){
            unwireMusicGain(track);
            try{ track.detach().forEach(function(el){ el.remove(); }); }catch(e){}
          })
          .on(LK.RoomEvent.DataReceived, function(payload, participant, kind, topic){
            if(topic && topic !== 'club') return;
            var msg;
            try{ msg = JSON.parse(new TextDecoder().decode(payload)); }catch(e){ return; }
            handleClubMsg(msg, participant);
          })
          .on(LK.RoomEvent.ParticipantConnected, function(p){
            renderRoster(); say((p.name||p.identity)+' joined.');
          })
          .on(LK.RoomEvent.ParticipantDisconnected, function(p){
            if(BOT && BOT.anchor === p.identity){
              var bn = BOT.name; BOT = null;
              say((p.name||p.identity)+' left and took '+bn+' with them.');
            } else {
              say((p.name||p.identity)+' left.');
            }
            renderRoster();
            if(iAmAuthority()){
              normalizeCurrent();
              bumpBroadcast();
            } else {
              reconcile(); renderJukebox();
            }
          })
          .on(LK.RoomEvent.ActiveSpeakersChanged, function(){ renderRoster(); })
          .on(LK.RoomEvent.Disconnected, function(){
            say('You left the room.');
            cleanupRoom();
          });
      }

      function handleClubMsg(msg, participant){
        var fromId = participant && participant.identity;
        if(msg.t === 'state'){ adoptState(msg); return; }
        if(msg.t === 'hello'){
          if(iAmAuthority()){ broadcastState(); }
          if(BOT && BOT.anchor === myIdentity){ sendBotState(); }
          return;
        }
        if(msg.t === 'cmd'){ if(iAmAuthority()) applyCmd(msg); return; }
        if(msg.t === 'add'){ if(iAmAuthority()) applyAdd(msg.entry, msg.interrupt, msg.fromName || 'Somebody'); return; }
        if(msg.t === 'bot'){
          if(msg.bot && fromId && msg.bot.anchor === fromId){ BOT = msg.bot; renderRoster(); }
          else if(!msg.bot && BOT && fromId && BOT.anchor === fromId){ BOT = null; botBusy = false; renderRoster(); }
          return;
        }
        if(msg.t === 'bot-cue'){ if(BOT && BOT.anchor === myIdentity){ doBotTurn(msg.fromName || 'Somebody'); } return; }
        if(msg.t === 'bot-kick'){ if(BOT && BOT.anchor === myIdentity){ removeBot(msg.fromName || 'Somebody'); } return; }
        if(msg.t === 'bot-said'){ showBotLine(msg.name, msg.line); return; }
        if(msg.t === 'bot-busy'){ botBusy = !!msg.busy; renderRoster(); return; }
      }

      /* every 4s: the current song's owner reports position + reasserts
       * state (this is also what catches late joiners up); the bot's anchor
       * reasserts the guest. */
      setInterval(function(){
        if(!lkRoom) return;
        var cur = curEntry();
        if(cur && CLUB.jb.playing && cur.by === myIdentity && playingEntryId === cur.id){
          CLUB.jb.pos = Math.round(myCurrentPos());
          CLUB.v++;
          broadcastState();
        }
        if(BOT && BOT.anchor === myIdentity){ sendBotState(); }
      }, 4000);

      /* ── BOT GUEST (anchored on the inviter's device) ── */
      let botCtx=null, botDest=null, botTrack=null;
      let TRANS = '';
      let capTimer=null, capRec=null, capCtx=null;

      function sendBotState(){
        sendData({ t:'bot', bot: BOT && BOT.anchor === myIdentity ? BOT : (BOT || null) });
      }
      function showBotLine(name, line){
        $('bot-line').textContent = name + ': ' + line;
      }
      async function loadBotRoster(){
        try{
          const r = await apiGet('/api/kade/room/agents', token);
          const j = await r.json();
          var opts = (j.agents||[]).map(function(a){
            return '<option value="'+esc(a.id)+'" data-name="'+esc(a.name)+'">'+esc(a.name)+'</option>';
          }).join('');
          $('bot-pick').innerHTML = '<option value="">Pick a companion…</option>' + opts;
        }catch(e){
          $('bot-pick').innerHTML = '<option value="">Could not load companions</option>';
        }
      }
      $('bot-invite').addEventListener('click', async function(){
        if(BOT){ say('One guest at a time — ask ' + BOT.name + ' to leave first.'); return; }
        var sel = $('bot-pick');
        var id = sel.value;
        if(!id){ say('Pick a companion first.'); return; }
        var nm = sel.options[sel.selectedIndex].getAttribute('data-name') || 'Guest';
        try{
          botCtx = new AC();
          if(botCtx.state === 'suspended'){ try{ await botCtx.resume(); }catch(e){} }
          botDest = botCtx.createMediaStreamDestination();
          botTrack = botDest.stream.getAudioTracks()[0];
          await lkRoom.localParticipant.publishTrack(botTrack, { name: 'bot', source: LK.Track.Source.Unknown });
        }catch(e){
          say('Could not set up the guest chair — try again.');
          botTeardownLocal();
          return;
        }
        BOT = { agentId: id, name: nm, anchor: myIdentity, anchorName: myName };
        TRANS = '';
        sendBotState();
        renderRoster();
        say(nm + ' pulled up a chair. Press their talk button when you want them to speak — they listen along in between.');
        startCapture();
      });
      $('roster').addEventListener('click', function(ev){
        var b = ev.target.closest('button[data-botact]'); if(!b || !BOT) return;
        var act = b.getAttribute('data-botact');
        if(act === 'cue'){
          if(BOT.anchor === myIdentity){ doBotTurn(myName); }
          else { sendData({ t:'bot-cue', fromName: myName }); say('Told ' + BOT.name + " it's their turn."); }
        } else if(act === 'kick'){
          if(BOT.anchor === myIdentity){ removeBot(myName); }
          else { sendData({ t:'bot-kick', fromName: myName }); }
        }
      });
      async function doBotTurn(fromName){
        if(!BOT || BOT.anchor !== myIdentity) return;
        if(botBusy){ say(BOT.name + ' is already mid-thought.'); return; }
        botBusy = true; renderRoster();
        sendData({ t:'bot-busy', busy: true });
        try{
          const r = await fetch('/api/kade/lounge/bot-turn', { method:'POST', headers:{ 'Authorization':'Bearer '+token, 'Content-Type':'application/json' }, body: JSON.stringify({ agentId: BOT.agentId, roomLabel: roomLabel, transcript: TRANS, cuedBy: fromName }) });
          const j = await r.json();
          if(!r.ok) throw new Error(j.error || 'No answer.');
          TRANS += '\n' + j.name + ' (the guest): ' + j.line;
          if(TRANS.length > 3800) TRANS = TRANS.slice(-3800);
          sendData({ t:'bot-said', name: j.name, line: j.line });
          showBotLine(j.name, j.line);
          if(j.voice){
            try{
              const tr = await fetch('/api/files/speech/tts/manual', { method:'POST', headers:{ 'Authorization':'Bearer '+token, 'Content-Type':'application/json' }, body: JSON.stringify({ input: j.line, voice: j.voice }) });
              if(tr.ok){
                var ab = await tr.arrayBuffer();
                var buf = await botCtx.decodeAudioData(ab);
                await new Promise(function(done){
                  var src = botCtx.createBufferSource();
                  src.buffer = buf;
                  src.connect(botDest);
                  src.connect(botCtx.destination); // the anchor hears them too
                  src.onended = done;
                  src.start();
                });
              }
            }catch(ttsErr){ /* text already landed on-screen for everyone */ }
          }
        }catch(e){
          say((BOT ? BOT.name : 'The guest') + ' lost their train of thought — cue them again.');
        }
        botBusy = false; renderRoster();
        sendData({ t:'bot-busy', busy: false });
      }
      function removeBot(byName){
        if(!BOT || BOT.anchor !== myIdentity) return;
        var nm = BOT.name;
        BOT = null; botBusy = false;
        stopCapture();
        botTeardownLocal();
        sendBotState();
        renderRoster();
        say(nm + ' said goodnight and headed out. (' + byName + ' showed them the door.)');
        sendData({ t:'bot-said', name: nm, line: '(left the room)' });
      }
      function botTeardownLocal(){
        if(botTrack && lkRoom){ try{ lkRoom.localParticipant.unpublishTrack(botTrack, true); }catch(e){} }
        botTrack = null; botDest = null;
        if(botCtx){ try{ botCtx.close(); }catch(e){} botCtx = null; }
      }

      /* room ears: 15-second capture cycles of mic + voices (never the
       * music, never the bot itself), each cycle a standalone file posted
       * to the existing transcribe lane. Runs ONLY on the anchor's device,
       * ONLY while a guest is seated. */
      function startCapture(){
        stopCapture();
        capCycle();
      }
      function stopCapture(){
        if(capTimer){ clearTimeout(capTimer); capTimer = null; }
        if(capRec){ try{ if(capRec.state !== 'inactive'){ capRec.onstop = null; capRec.stop(); } }catch(e){} capRec = null; }
        capCleanup();
      }
      function capCleanup(){
        if(capCtx){ try{ capCtx.close(); }catch(e){} capCtx = null; }
      }
      function capCycle(){
        if(!BOT || BOT.anchor !== myIdentity || !lkRoom) return;
        try{
          if(!window.MediaRecorder) return; // guest still works, just with no ears
          capCtx = new AC();
          var dest = capCtx.createMediaStreamDestination();
          var sources = 0;
          if(micTrack && micTrack.mediaStreamTrack && !micMuted){
            try{ capCtx.createMediaStreamSource(new MediaStream([micTrack.mediaStreamTrack])).connect(dest); sources++; }catch(e){}
          }
          lkRoom.remoteParticipants.forEach(function(p){
            (p.audioTrackPublications || new Map()).forEach(function(pub){
              var nm = (pub && (pub.trackName || pub.name)) || '';
              if(nm === 'music' || nm === 'bot') return;
              if(pub.track && pub.track.mediaStreamTrack){
                try{ capCtx.createMediaStreamSource(new MediaStream([pub.track.mediaStreamTrack])).connect(dest); sources++; }catch(e){}
              }
            });
          });
          if(!sources){ capCleanup(); capTimer = setTimeout(capCycle, 15000); return; }
          var mime = '';
          if(MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime = 'audio/webm;codecs=opus';
          else if(MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/mp4')) mime = 'audio/mp4';
          capRec = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
          var chunks = [];
          capRec.ondataavailable = function(ev){ if(ev.data && ev.data.size) chunks.push(ev.data); };
          capRec.onstop = function(){
            var blob = new Blob(chunks, { type: (capRec && capRec.mimeType) || mime || 'audio/webm' });
            capCleanup();
            capRec = null;
            sendChunk(blob);
            if(BOT && BOT.anchor === myIdentity){ capTimer = setTimeout(capCycle, 250); }
          };
          capRec.start();
          capTimer = setTimeout(function(){ try{ if(capRec && capRec.state !== 'inactive') capRec.stop(); }catch(e){} }, 15000);
        }catch(e){
          capCleanup();
          capTimer = setTimeout(capCycle, 15000);
        }
      }
      async function sendChunk(blob){
        if(!blob || blob.size < 2500) return; // near-silence — save the pennies
        try{
          const r = await fetch('/api/kade/transcribe', { method:'POST', headers:{ 'Authorization':'Bearer '+token, 'Content-Type': blob.type || 'audio/webm', 'x-kade-club':'1' }, body: blob });
          const j = await r.json();
          if(r.ok && j.transcript){
            TRANS += '\n' + j.transcript;
            if(TRANS.length > 3800) TRANS = TRANS.slice(-3800);
          }
        }catch(e){ /* quiet ears are fail-soft ears */ }
      }

      function cleanupRoom(){
        stopCapture();
        if(BOT && BOT.anchor === myIdentity){ botTeardownLocal(); }
        BOT = null; botBusy = false; TRANS = '';
        stopPlayback(false);
        if(jbCtx){ try{ jbCtx.close(); }catch(e){} jbCtx = null; jbDest = null; jbMonitor = null; }
        musicGains.forEach(function(m){ try{ m.src.disconnect(); m.gain.disconnect(); }catch(e){} });
        musicGains = [];
        if(listenCtx){ try{ listenCtx.close(); }catch(e){} listenCtx = null; }
        if(micTrack){ try{ micTrack.stop(); }catch(e){} micTrack = null; }
        document.querySelectorAll('audio[aria-hidden="true"]').forEach(function(el){ el.remove(); });
        lkRoom = null;
        CLUB = { v:0, actn:0, act:'', jb:{ queue:[], curId:null, playing:false, pos:-1 } };
        $('room').hidden = true;
        $('pick').hidden = false;
        status.textContent = 'Pick a room.';
      }

      /* iOS autoplay policy: any tap re-arms suspended audio engines. */
      document.addEventListener('click', function(){
        [listenCtx, jbCtx, botCtx].forEach(function(c){
          if(c && c.state === 'suspended'){ try{ c.resume(); }catch(e){} }
        });
      }, true);

      /* ── picker wiring ── */
      $('room-list').addEventListener('click', function(ev){
        const b = ev.target.closest('button[data-room]'); if(!b) return;
        const r = (cfg.rooms||[]).find(function(x){ return x.key === b.getAttribute('data-room'); });
        joinRoom(b.getAttribute('data-room'), r ? r.name : b.getAttribute('data-room'));
      });
      $('hotel-mine').addEventListener('click', async function(ev){
        const cb = ev.target.closest('button[data-close]');
        if(!cb) return;
        if(!confirm('Close this room for good?')) return;
        try{
          const r = await fetch('/api/kade/lounge/hotel/' + cb.getAttribute('data-close'), { method:'DELETE', headers:{ 'Authorization':'Bearer '+token } });
          const j = await r.json();
          if(!r.ok) throw new Error(j.error || 'Could not close it.');
          status.textContent = 'Room closed.';
          const cr = await apiGet('/api/kade/lounge/config', token);
          cfg = await cr.json();
          renderHotel(cfg.hotel);
        }catch(e){ status.className='status err'; status.textContent = e.message; }
      });
      $('hotel-checkin').addEventListener('click', async function(){
        var code = $('hotel-code').value.trim().toLowerCase();
        if(!code){ $('hotel-code').focus(); return; }
        try{
          const r = await fetch('/api/kade/lounge/hotel/checkin', { method:'POST', headers:{ 'Authorization':'Bearer '+token, 'Content-Type':'application/json' }, body: JSON.stringify({ code: code }) });
          const j = await r.json();
          if(!r.ok) throw new Error(j.error || 'No room answered.');
          status.className = 'status';
          $('hotel-code').value = '';
          joinRoom(j.key, j.name, code);
        }catch(e){ status.className='status err'; status.textContent = e.message; }
      });
      $('hotel-create').addEventListener('click', async function(){
        var name = $('hotel-name').value.trim();
        var code = $('hotel-newcode').value.trim().toLowerCase();
        if(!name){ $('hotel-name').focus(); return; }
        if(!code){ $('hotel-newcode').focus(); return; }
        try{
          const r = await fetch('/api/kade/lounge/hotel', { method:'POST', headers:{ 'Authorization':'Bearer '+token, 'Content-Type':'application/json' }, body: JSON.stringify({ name: name, code: code }) });
          const j = await r.json();
          if(!r.ok) throw new Error(j.error || 'Could not open the room.');
          status.textContent = 'The Hotel opened ' + j.name + '. Share the passcode with your people — walking you in now.';
          $('hotel-name').value = ''; $('hotel-newcode').value = '';
          joinRoom(j.key, j.name, code);
        }catch(e){ status.className='status err'; status.textContent = e.message; }
      });
      $('join-code').addEventListener('click', function(){
        const code = $('code').value.trim().toUpperCase();
        if(!code) return;
        joinRoom(code.toLowerCase(), 'Table ' + code);
      });
      $('btn-mic').addEventListener('click', async function(){
        if(!lkRoom) return;
        micMuted = !micMuted;
        try{ await lkRoom.localParticipant.setMicrophoneEnabled(!micMuted); }catch(e){}
        $('btn-mic').textContent = micMuted ? 'Unmute my mic' : 'Mute my mic';
        say(micMuted ? 'Mic muted.' : 'Mic live.');
      });
      $('btn-who').addEventListener('click', function(){
        const names = rosterNames();
        if(BOT){ names.push(BOT.name + ' (guest)'); }
        say(names.length ? ('Here now: ' + names.join(', ') + '.') : 'Nobody here yet.');
      });
      $('btn-leave').addEventListener('click', async function(){
        if(lkRoom){ try{ await lkRoom.disconnect(); }catch(e){} }
        cleanupRoom();
      });

      /* ── jukebox wiring ── */
      $('jb-file').addEventListener('change', function(){
        var has = !!$('jb-file').files.length;
        $('jb-cutin').hidden = !has;
        $('jb-queue-add').hidden = !has;
      });
      function addTrack(interrupt){
        var f = $('jb-file').files[0];
        if(!f || !lkRoom) return;
        var id = 'e' + Math.random().toString(36).slice(2, 9);
        var title = (f.name || 'a song').replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 60);
        var entry = { id: id, title: title, by: myIdentity, byName: myName };
        myFiles[id] = f;
        if(iAmAuthority()){ applyAdd(entry, interrupt, myName); }
        else { sendData({ t:'add', entry: entry, interrupt: interrupt, fromName: myName }); }
        $('jb-file').value = '';
        $('jb-cutin').hidden = true;
        $('jb-queue-add').hidden = true;
      }
      $('jb-cutin').addEventListener('click', function(){ addTrack(true); });
      $('jb-queue-add').addEventListener('click', function(){ addTrack(false); });
      $('jb-toggle').addEventListener('click', function(){
        if(!lkRoom) return;
        clubCmd(CLUB.jb.playing ? 'pause' : 'play');
      });
      $('jb-skip').addEventListener('click', function(){ if(lkRoom) clubCmd('skip'); });
      $('jb-back').addEventListener('click', function(){ if(lkRoom) clubCmd('back'); });
      $('jb-stop').addEventListener('click', function(){ if(lkRoom) clubCmd('stop'); });
      $('jb-queue').addEventListener('click', function(ev){
        var jb = ev.target.closest('button[data-jump]');
        if(jb){ clubCmd('jump', { id: jb.getAttribute('data-jump') }); return; }
        var dr = ev.target.closest('button[data-drop]');
        if(dr){ clubCmd('remove', { id: dr.getAttribute('data-drop') }); }
      });
    })();
  </script>
</body></html>`;

router.page = (_req, res) => res.type('html').send(loungeHtml);

module.exports = router;
