const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { KadeClubRoom } = require('~/models/kadeClubRoom');
const { loungeHtml, engineHtml } = require('./Clubhouse/pages');
const { stripAiTells, KADE_STYLE_NOTE } = require('~/server/utils/stripAiTells');

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
    /* lane 'dj' (July 24 2026, the PURE-NATIVE build): the iPhone app keeps a
     * hidden headless WebKit "engine" alongside its LiveKit Swift connection,
     * because iOS's libwebrtc has ONE audio pipeline — a second hi-fi track
     * (the jukebox's 'music', the guest's 'bot') can only be published from a
     * web context. The engine joins as "<name>-<id4>-dj" and every roster,
     * steward, and announcement path filters identities ending in "-dj". */
    const lane = String(req.body?.lane || '') === 'dj' ? '-dj' : '';
    const identity = firstName + '-' + String(req.user.id).slice(-4) + lane;
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
/* ── THE LINK LANE (July 24 round 7, her ask: "add links to the music
 * player. Youtube first, then followed by spotify.") ──
 * A pasted link becomes ordinary jukebox bytes: the server pulls the
 * audio with yt-dlp (in the image since this deploy) and hands the DJ
 * device an m4a it can decode like any picked file — the rest of the
 * pipeline (queue, cut-ins, radio fights, the native engine feed) never
 * knows the difference. YouTube links go straight through; Spotify's
 * audio is locked (DRM), so a Spotify song link is resolved to its NAME
 * via Spotify's public oEmbed and matched on YouTube — the family-tool
 * move, same trick every Discord bot uses. Caps: 15 minutes, 60MB (the
 * jukebox's own cap), no livestreams. m4a-only keeps Safari decodable. */
function runYtDlp(args, timeoutMs) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const p = spawn('yt-dlp', args);
    const out = [];
    let err = '';
    const t = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch (e) { /* already gone */ }
      reject(new Error('yt-dlp timeout'));
    }, timeoutMs);
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; if (err.length > 8000) err = err.slice(-8000); });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error('yt-dlp exit ' + code + ': ' + err.slice(-300)));
    });
  });
}

const YT_HOSTS = ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'];

/* YouTube stonewalls datacenter IPs ("confirm you're not a bot" — caught
 * live on the first deploy). yt-dlp's alternate innertube clients dodge
 * the wall without cookies, but WHICH one works shifts as Google patches.
 * So: a LADDER — try the default client, then the tv client, then the
 * embedded/mobile-web pair — and REMEMBER the first rung that worked so
 * later fetches start there (resets on restart, self-heals either way).
 * If every rung fails, say so honestly; the next escalation (cookies or
 * a PO-token provider) is a deliberate decision for another session. */
const YT_LADDER = [
  ['--extractor-args', 'youtube:formats=missing_pot'],
  ['--extractor-args', 'youtube:player_client=tv;formats=missing_pot'],
  ['--extractor-args', 'youtube:player_client=android_vr;formats=missing_pot'],
  ['--extractor-args', 'youtube:player_client=web_embedded,mweb;formats=missing_pot'],
];
let ytRung = 0;

/* The cookies hook (dormant until fed): drop a Netscape-format cookies
 * export into Railway env KADE_YT_COOKIES and every fetch rides it —
 * the standard escape hatch when Google fully PO-token-walls an IP.
 * No code change needed later; this just notices the var. */
let ytCookiesPath = null;
function ytCookieArgs() {
  if (ytCookiesPath) return ['--cookies', ytCookiesPath];
  const raw = process.env.KADE_YT_COOKIES || '';
  if (!raw.trim()) return [];
  try {
    const fs = require('fs');
    const p = '/tmp/kade-yt-cookies.txt';
    fs.writeFileSync(p, raw, { mode: 0o600 });
    ytCookiesPath = p;
    logger.info('[lounge/fetch-track] YouTube cookies loaded from env');
    return ['--cookies', p];
  } catch (e) { return []; }
}

async function ytLadder(baseArgs, timeoutMs) {
  let lastErr = null;
  const cookies = ytCookieArgs();
  // the PO-token sidecar (yt-pot service, private networking): the bgutil
  // plugin mints the proof-of-origin tokens YouTube demands from
  // datacenter IPs — set via env, silent when absent.
  const pot = process.env.KADE_POT_URL
    ? ['--extractor-args', 'youtubepot-bgutilhttp:base_url=' + process.env.KADE_POT_URL]
    : [];
  // TWO passes over the whole ladder with a breath between: YouTube's wall
  // FLICKERS (live receipts July 24: same video, same rung — through at
  // 21:05, walled at 21:26). A second wind lands more often than not.
  for (let pass = 0; pass < 2; pass++) {
    if (pass) await new Promise((r) => setTimeout(r, 3000));
    for (let i = 0; i < YT_LADDER.length; i++) {
      const rung = (ytRung + i) % YT_LADDER.length;
      try {
        const out = await runYtDlp([...baseArgs, ...cookies, ...pot, ...YT_LADDER[rung]], timeoutMs);
        ytRung = rung;
        return out;
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr || new Error('every client refused');
}

router.post('/fetch-track', requireJwtAuth, express.json(), async (req, res) => {
  try {
    const raw = String(req.body?.url || '').trim().slice(0, 500);
    let u;
    try { u = new URL(raw); } catch (e) { return res.status(400).json({ error: "That doesn't look like a link." }); }
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    let sel = null;
    let fallbackTitle = 'a song';
    if (YT_HOSTS.includes(host)) {
      sel = raw;
    } else if (host === 'open.spotify.com') {
      const axios = require('axios');
      const oe = await axios.get('https://open.spotify.com/oembed', { params: { url: raw }, timeout: 8000 });
      const spTitle = String(oe.data?.title || '').trim().slice(0, 120);
      if (!spTitle) return res.status(404).json({ error: 'Spotify would not say what that song is — paste the YouTube link instead.' });
      fallbackTitle = spTitle.slice(0, 60);
      sel = 'ytsearch1:' + spTitle + ' audio';
    } else {
      /* THE WIDE LANE (July 24 night, her go: "Yes on link widening"):
       * the extractor speaks ~1,800 sites that never wall anybody —
       * SoundCloud, Bandcamp, Mixcloud, archive.org, podcast feeds,
       * plain MP3/M4A links. Let it try anything public and fail with
       * honest words. Private/internal surfaces stay off-limits. */
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return res.status(400).json({ error: 'Only web links work here.' });
      }
      if (host === 'localhost' || /\.(internal|local)$/i.test(host) || /^[0-9.:\[\]]+$/.test(u.hostname)) {
        return res.status(400).json({ error: 'That link points somewhere private.' });
      }
      sel = raw;
    }
    const filters = ['--no-warnings', '--no-playlist', '--match-filters', '!is_live & duration<905'];
    const metaBuf = await ytLadder([...filters, '--print', '%(title)s', '--skip-download', sel], 40000);
    const title = (metaBuf.toString('utf8').trim().split('\n')[0] || '').slice(0, 60);
    if (!title) return res.status(404).json({ error: 'That one is live, longer than 15 minutes, or missing — the jukebox plays songs, not marathons.' });
    /* HER LIVE CATCH (July 24 night, Amber's link said playing but never
     * sounded): YouTube's m4a is a FRAGMENTED MP4 (ftyp brand 'dash',
     * sidx/moof boxes — receipts in PROJECT_STATUS) and decodeAudioData —
     * the one decoder both DJ engines use — cannot digest fragmented MP4
     * anywhere (WebKit or Chrome). So the server now REMUXES to a classic
     * container: ffmpeg (already aboard) copies the AAC into a normal m4a
     * with the moov up front (faststart) — no re-encode for AAC sources,
     * a real transcode only when a video has nothing but opus. That needs
     * a temp file (postprocessors cannot ride a stdout pipe). */
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const tmpBase = path.join(os.tmpdir(), 'kade-trk-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    let audio;
    try {
      await ytLadder([
        ...filters,
        '-f', 'bestaudio',
        '--extract-audio', '--audio-format', 'm4a',
        '--postprocessor-args', 'ffmpeg:-movflags +faststart',
        '--max-filesize', '60m',
        '-o', tmpBase + '.%(ext)s',
        sel,
      ], 150000);
      audio = fs.readFileSync(tmpBase + '.m4a');
    } finally {
      for (const ext of ['.m4a', '.m4a.part', '.webm', '.webm.part', '.mp4', '.mp4.part', '.opus']) {
        try { fs.unlinkSync(tmpBase + ext); } catch (e) { /* not there */ }
      }
    }
    if (!audio.length) return res.status(413).json({ error: 'That audio came back empty or over the 60MB cap.' });
    res.set('x-kade-title', encodeURIComponent(title || fallbackTitle));
    res.set('Content-Type', 'audio/mp4');
    return res.send(audio);
  } catch (e) {
    logger.error('[lounge/fetch-track] ' + (e.message || e));
    // walled:true tells the client this is the flickering YouTube gate —
    // worth quietly knocking again later — vs. a plain bad/unsupported link.
    const stonewalled = /bot|sign in|cookies|No video formats/i.test(String(e.message || ''));
    return res.status(502).json({ error: stonewalled
      ? 'YouTube is stonewalling the server right now — try again in a minute, it usually relents.'
      : 'That link would not fetch — a song page or a direct audio link works best.',
      walled: stonewalled });
  }
});

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
    /* July 27 2026: this lane used to hit OpenRouter directly — but the fleet
     * runs Kimi, which is reliable ONLY via the reframe proxy (Moonshot-direct,
     * pinned params); OpenRouter's Kimi hosting errors/answers empty, silently
     * dumping every guest onto the flash-lite fallback. Same wire shape. */
    const gatewayUrl = process.env.KADE_LLM_GATEWAY_URL || 'https://reframe-proxy-production.up.railway.app/chat/completions';
    const key = process.env.REFRAME_PROXY_SECRET || process.env.OPENROUTER_KEY;
    if (!key) return res.status(503).json({ error: 'Bot guests are resting right now.' });
    const system = [
      'You are ' + (agent.name || 'a companion') + ', a GUEST sitting in "' + roomLabel + '" — a live family voice room in Kade\'s Clubhouse. Real people are talking out loud around you.',
      '',
      'Your persona:',
      String(agent.instructions || '(no special persona — be yourself)').slice(0, 1400),
      '',
      // July 27 2026: same invisible anti-tell style note every CHAT reply gets
      // (applyKadeAudience) — bot guests were the un-guarded lane.
      KADE_STYLE_NOTE.trim(),
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
        gatewayUrl,
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
      const text = stripAiTells(String(rr.data?.choices?.[0]?.message?.content || '')).replace(/%%%[^%]*%%%/g, ' ').replace(/["“”*_#]/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 480);
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


/* ── THE ENGINE (July 24 2026, the pure-native build) ─────────────────────
 * A HEADLESS page the iPhone app hosts in an invisible WKWebView. Why it
 * exists: iOS's libwebrtc owns exactly one audio pipeline (the mic), so a
 * native app cannot publish a second custom track — but WebKit's WebRTC can
 * publish any WebAudio stream. The app's SwiftUI Clubhouse does everything
 * else (mic, roster, data channel, state machine, volume); THIS page is its
 * hands for three jobs only, commanded over evaluateJavaScript (window.KE)
 * with events back through webkit.messageHandlers.engine:
 *   1. publish the shared jukebox's hi-fi 'music' track (files arrive from
 *      the app over a kadefile:// custom scheme, never the network),
 *   2. publish the bot guest's 'bot' voice track (TTS fetched right here),
 *   3. the bot's EARS — the same 15s capture->transcribe cycles the web
 *      anchor runs (the native user's own mic arrives as a remote track,
 *      since the engine is its own '-dj' participant).
 * No UI, no mic, nothing audible locally, scrubbed fragment, roster-invisible
 * (every surface filters '-dj' identities). */


/* no-store (round 5): a CACHED copy of these pages is a silent killer —
 * an engine page from three deploys ago replays yesterday's bugs on
 * today's phones. These pages are tiny; always serve them fresh. */
router.page = (_req, res) => res.set('Cache-Control', 'no-store').type('html').send(loungeHtml);
router.enginePage = (_req, res) => res.set('Cache-Control', 'no-store').type('html').send(engineHtml);

module.exports = router;
