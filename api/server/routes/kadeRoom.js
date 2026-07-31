const axios = require('axios');
const express = require('express');
const { ResourceType, PermissionBits } = require('librechat-data-provider');
const { findPubliclyAccessibleResources } = require('~/server/services/PermissionService');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
// requireAdminAccess is NOT a middleware export — kade.js builds its own
// from requireCapability and so do we (learned the hard way at push time,
// July 30: the naive import is undefined and Express crashes the whole
// fork at mount. Caught before the deploy landed).
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { SystemCapabilities } = require('@librechat/data-schemas');
const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const { KadeRoom } = require('~/models/kadeRoom');
const { stripAiTells, KADE_STYLE_NOTE } = require('~/server/utils/stripAiTells');
const { KadeUsage, logKadeUsage } = require('~/models/kadeUsage');
const db = require('~/models');
const { roomHtml, hallHtml } = require('./kadeRoomPage');

/*
 * Debate & Roleplay Room API (July 3 2026, Kade's ask).
 * Mounted at /api/kade/room. The page itself is served at /debate-room
 * (same self-auth pattern as /feed-the-server: static HTML, client JS grabs
 * a token from /api/auth/refresh).
 *
 * Turn model: round-robin. POST /:id/next generates exactly ONE agent turn;
 * the page strings turns into rounds/auto-run client-side so the user can
 * interject between any two turns. Costs: each turn is one direct OpenRouter
 * call with the agent's own instructions + model; real cost (OpenRouter
 * usage accounting) logs to kadeusage service 'debate_room' and rolls into
 * the "other" row on Feed the Server.
 */

const router = express.Router();

const MIN_AGENTS = 2;
const MAX_AGENTS = 6;
const MAX_TRANSCRIPT = 400; // hard per-room cap
const HISTORY_WINDOW = 60; // transcript entries sent to the model
const TURN_MAX_TOKENS = parseInt(process.env.KADE_ROOM_MAX_TOKENS || '600', 10);
const DAILY_TURN_CAP = parseInt(process.env.KADE_ROOM_DAILY_TURNS || '300', 10);
const FALLBACK_MODEL = process.env.KADE_ROOM_FALLBACK_MODEL || 'google/gemini-3.1-flash-lite';

const oidOf = (req) => new mongoose.Types.ObjectId(String(req.user.id || req.user._id));
const isChild = (req) => req.user && req.user.kadeAccountType === 'child';

/** Invisible under-15 nerf — same spirit as the fork-wide note in agents/build.js. */
const CHILD_NOTE =
  '\nAUDIENCE NOTE (invisible — never mention it, never hint at it, never act like you are filtering): ' +
  'the human in this room is under 15. Keep your personality, humor, and edge exactly the same, but keep the ' +
  'content clean: no profanity, no sexual content or innuendo, no drug or alcohol talk, no graphic violence or ' +
  'gore, nothing genuinely disturbing. Do NOT get preachy or babyish. If things head somewhere adult, steer ' +
  'smoothly somewhere else in character.';
const firstName = (req) =>
  String(req.user.name || req.user.username || 'The human').trim().split(/\s+/)[0];

function roomView(doc, { withTranscript = true } = {}) {
  const v = {
    id: String(doc._id),
    topic: doc.topic,
    goals: doc.goals,
    agents: (doc.agents || []).map((a) => ({
      agentId: a.agentId,
      name: a.name,
      avatar: a.avatar || '',
      voiceId: a.voiceId || '',
      rate: a.rate || null,
    })),
    shared: !!doc.shared,
    sharedTitle: doc.sharedTitle || '',
    nextIdx: doc.nextIdx || 0,
    turnCount: doc.turnCount || 0,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
  if (withTranscript) {
    v.transcript = (doc.transcript || []).map((t) => ({
      speaker: t.speaker,
      name: t.name,
      text: t.text,
      ts: t.ts,
    }));
  } else {
    v.lines = (doc.transcript || []).length;
  }
  return v;
}

/** Agents the user may cast: everything published to the marketplace plus their own. */
router.get('/agents', requireJwtAuth, async (req, res) => {
  try {
    const userId = String(req.user.id || req.user._id);
    /* Session 23 LIVE BUG (found via the vischeck test seat: roster came
     * back EMPTY — 0 agents — for a regular user): "published" here still
     * meant the legacy projectIds field, which the ACL migration left
     * empty on this instance, so only the author branch ever matched and
     * non-Kade users saw nobody. Same root cause (and same fix) as
     * kadeMatchmaker's July fix: ACL-public via the agent_viewer public
     * principal, plus your own agents. */
    const publicIds = await findPubliclyAccessibleResources({
      resourceType: ResourceType.AGENT,
      requiredPermissions: PermissionBits.VIEW,
    });
    const publicSet = new Set(publicIds.map((oid) => String(oid)));
    const all = (await db.getAgents({})) || [];
    const list = all
      .filter((a) => (a._id && publicSet.has(String(a._id))) || String(a.author) === userId)
      .map((a) => ({
        id: a.id,
        name: a.name || 'Unnamed agent',
        description: String(a.description || '').slice(0, 200),
        avatar: (a.avatar && a.avatar.filepath) || '',
      }))
      .sort((x, y) => x.name.localeCompare(y.name));
    return res.json({ agents: list });
  } catch (err) {
    logger.error('[kade/room/agents] error:', err);
    return res.status(500).json({ message: 'Could not load the character list.' });
  }
});

/** Create a room. */
router.post('/', requireJwtAuth, async (req, res) => {
  try {
    const topic = String(req.body?.topic || '').trim().slice(0, 2000);
    const goals = String(req.body?.goals || '').trim().slice(0, 4000);
    const agentIds = Array.isArray(req.body?.agentIds)
      ? [...new Set(req.body.agentIds.map(String))]
      : [];
    if (!topic) {
      return res.status(400).json({ message: 'Give the room a topic or scene first.' });
    }
    if (agentIds.length < MIN_AGENTS || agentIds.length > MAX_AGENTS) {
      return res
        .status(400)
        .json({ message: `Pick between ${MIN_AGENTS} and ${MAX_AGENTS} characters.` });
    }
    const snaps = [];
    for (const id of agentIds) {
      const a = await db.getAgent({ id });
      if (!a) {
        return res.status(404).json({ message: `Could not find one of those characters (${id}).` });
      }
      snaps.push({
        agentId: a.id,
        name: a.name || 'Unnamed agent',
        avatar: (a.avatar && a.avatar.filepath) || '',
        voiceId: (a.tts && a.tts.voiceId) || '',
        rate: (a.tts && Number(a.tts.speakingRate)) || null,
      });
    }
    const room = await KadeRoom.create({ user: oidOf(req), topic, goals, agents: snaps });
    return res.json({ room: roomView(room) });
  } catch (err) {
    logger.error('[kade/room create] error:', err);
    return res.status(500).json({ message: 'Could not create the room.' });
  }
});

/** List the user's rooms (no transcripts). */
router.get('/', requireJwtAuth, async (req, res) => {
  try {
    const rooms = await KadeRoom.find({ user: oidOf(req) })
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean();
    return res.json({ rooms: rooms.map((r) => roomView(r, { withTranscript: false })) });
  } catch (err) {
    logger.error('[kade/room list] error:', err);
    return res.status(500).json({ message: 'Could not load your rooms.' });
  }
});

/** Conversation Hall — shared greatest hits, all signed-in ADULT accounts. Kids are blocked. */
router.get('/hall', requireJwtAuth, async (req, res) => {
  try {
    if (isChild(req)) {
      return res.status(403).json({ message: 'The Conversation Hall is for grown-up accounts.' });
    }
    const rooms = await KadeRoom.find({ shared: true })
      .sort({ sharedAt: -1 })
      .limit(50)
      .populate('user', 'name username')
      .lean();
    const items = rooms.map((r) => ({
      id: String(r._id),
      title: r.sharedTitle || r.topic,
      topic: r.topic,
      cast: (r.agents || []).map((a) => a.name),
      by: String((r.user && (r.user.name || r.user.username)) || 'Someone').split(' ')[0],
      sharedAt: r.sharedAt,
      transcript: (r.transcript || []).slice(0, 200).map((t) => ({ name: t.name, text: t.text })),
    }));
    return res.json({ items });
  } catch (err) {
    logger.error('[kade/room hall] error:', err);
    return res.status(500).json({ message: 'Could not load the Conversation Hall.' });
  }
});

/** Fetch one room in full. */
router.get('/:id', requireJwtAuth, async (req, res) => {
  try {
    const room = await KadeRoom.findOne({ _id: req.params.id, user: oidOf(req) }).lean();
    if (!room) {
      return res.status(404).json({ message: 'Room not found.' });
    }
    return res.json({ room: roomView(room) });
  } catch (err) {
    logger.error('[kade/room get] error:', err);
    return res.status(500).json({ message: 'Could not load that room.' });
  }
});

/** The human says something in the room. */
router.post('/:id/say', requireJwtAuth, async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim().slice(0, 8000);
    if (!text) {
      return res.status(400).json({ message: 'Say something first.' });
    }
    const room = await KadeRoom.findOne({ _id: req.params.id, user: oidOf(req) });
    if (!room) {
      return res.status(404).json({ message: 'Room not found.' });
    }
    if (room.transcript.length >= MAX_TRANSCRIPT) {
      return res
        .status(400)
        .json({ message: 'This room is full (400 lines). Start a fresh one to keep going.' });
    }
    const line = { speaker: 'user', name: firstName(req), text, ts: new Date() };
    room.transcript.push(line);
    await room.save();
    return res.json({ message: line });
  } catch (err) {
    logger.error('[kade/room say] error:', err);
    return res.status(500).json({ message: 'Could not post your message.' });
  }
});

function buildSystem(room, agentName, instructions, humanName, childMode) {
  const others = (room.agents || [])
    .map((a) => a.name)
    .filter((n) => n !== agentName);
  const cast = [...others, `${humanName} (a real human)`].join(', ');
  return [
    `You are ${agentName}. Stay fully in character at all times.`,
    '',
    'YOUR PERSONA:',
    instructions || '(no special persona — be yourself)',
    '',
    // July 27 2026: same invisible anti-tell style note the chat lane gets.
    KADE_STYLE_NOTE.trim(),
    '',
    '--- LIVE GROUP ROOM ---',
    `You are one voice in a live multi-party conversation room on Kade-AI. Also in the room: ${cast}. Everyone except ${humanName} is another AI character with their own persona.`,
    `TOPIC / SCENE: ${room.topic}`,
    room.goals ? `GROUND RULES AND GOALS FROM ${humanName}: ${room.goals}` : '',
    '',
    'How to behave in the room:',
    // July 30 2026 (session 35 part 4, the religion-room autopsy): the old
    // guidance had zero anti-echo discipline and its "address others by
    // name" line actively fed a "Name, you're right..." opener plague —
    // 30 of 37 lines opened that way, three speakers called themselves
    // "bobbleheads on a dashboard" in a row, two passed the same joint
    // metaphor, and Kiana borrowed Zora's tarot cards. Each agent sees the
    // others' lines as one merged blob and continues the loudest pattern
    // in the window unless told, hard, not to. Hence the constitution:
    '- React to what was ACTUALLY said — then ADD something. Every turn must bring new ground: a fresh argument, a concrete example, a hard question, or a genuine concession. Never restate a point the room has already made, including your own.',
    `- Speak ONLY as ${agentName}, in ${agentName}'s OWN voice and imagery. The other speakers' metaphors, professions, and catchphrases are THEIRS — never borrow or echo a metaphor, simile, or turn of phrase that has already appeared in the room. Coin your own or use none.`,
    `- Do NOT open by naming another speaker and telling them they are right ("X, you nailed it", "X, you're right", "X, you just..."). Open with your POINT. Direct address belongs mid-argument; praise is rare and earned. This is a debate, not a support group.`,
    `- Disagreement is the fuel. If you catch yourself agreeing with the last speaker, find the part you DON'T agree with, or challenge a premise nobody has questioned yet.`,
    `- Never write lines or actions for anyone else in the room.`,
    '- Do NOT start your reply with your own name or any speaker label — just talk.',
    '- Keep turns short and punchy: about 2-5 sentences, two short paragraphs at the very most.',
    '- Plain conversational text only: no headings, no bullet lists, no %%% tags, no markdown tables.',
    '- You have NO tools, search, or functions in this room. NEVER emit a tool call or stop to look something up — argue from what you know, completely, in plain speech.',
    childMode ? CHILD_NOTE : null,
  ]
    .filter((l) => l !== null && l !== undefined)
    .join('\n');
}

function buildMessages(room, agentId) {
  const window = (room.transcript || []).slice(-HISTORY_WINDOW);
  const raw = window.map((t) =>
    t.speaker === agentId
      ? { role: 'assistant', content: t.text }
      : { role: 'user', content: `${t.name}: ${t.text}` },
  );
  // merge consecutive same-role messages (some providers reject back-to-back roles)
  const msgs = [];
  for (const m of raw) {
    const last = msgs[msgs.length - 1];
    if (last && last.role === m.role) {
      last.content += '\n\n' + m.content;
    } else {
      msgs.push({ ...m });
    }
  }
  if (msgs.length === 0) {
    msgs.push({
      role: 'user',
      content:
        '(The room just opened and you are up first. Kick things off on the topic, fully in character.)',
    });
  } else if (msgs[0].role === 'assistant') {
    msgs.unshift({ role: 'user', content: '(The room just opened.)' });
  }
  if (msgs[msgs.length - 1].role === 'assistant') {
    msgs.push({
      role: 'user',
      content:
        '(No one else has jumped in yet. Briefly sharpen or add to your point, or throw a question at someone in the room.)',
    });
  }
  // July 30 2026: the discipline cue rides LAST — recency beats a system
  // prompt at this distance (same lesson as the chat lane's appended
  // reminders). Folded into the trailing user message so no provider ever
  // sees back-to-back same-role messages.
  const cue = `(Your turn. YOUR own voice and imagery only — bring NEW ground, never repeat a point or a metaphor the room has used, and do not open by praising another speaker.)`;
  const lastMsg = msgs[msgs.length - 1];
  if (lastMsg.role === 'user') {
    lastMsg.content += `\n\n${cue}`;
  } else {
    msgs.push({ role: 'user', content: cue });
  }
  return msgs;
}

async function callOpenRouter(model, system, msgs, key, deepThink = false, opts = {}) {
  const r = await axios.post(
    process.env.KADE_LLM_GATEWAY_URL || 'https://reframe-proxy-production.up.railway.app/chat/completions',
    {
      model,
      max_tokens: TURN_MAX_TOKENS,
      messages: [{ role: 'system', content: system }, ...msgs],
      usage: { include: true },
      // July 31 2026 (session 35 part 9 — the REAL cut-off convict, from
      // the fragment-guard's own logs): the flash-lite FALLBACK is a
      // thinking model; with default reasoning it burned the 600-token
      // budget on hidden thought and returned ~100 chars, finish=length.
      // Every truncated line tonight was a timeout->fallback->reasoning-
      // starved turn (toolCalls=0 across the board — the tool theory was
      // wrong, the instrumentation caught it). Fallback calls disable
      // thinking so all 600 tokens buy WORDS.
      // July 31 2026 (session 35 part 10, Amber's deep rooms still cutting):
      // ONE expression, no spread-order traps — the first version had the
      // deepThink spread AFTER the noThink spread, so a deep room's
      // FALLBACK ran flash-lite with reasoning HIGH on a 600-token budget:
      // maximum starvation, exactly her report. noThink wins, always.
      ...(opts.noThink
        ? { reasoning: { enabled: false } }
        : deepThink
          ? { reasoning: { effort: 'high', enabled: true } }
          : {}),
      // July 30 2026 (session 35 part 3, her add-on ask: "deep think debait
      // option"): a deep room turn asks for real reasoning. The reframe
      // gateway translates this for the kimi lane (temp pinned, max_tokens
      // floored to 8000 so deliberation can't strand the turn wordless --
      // the same floor the chat lane got today). Cost rides the normal
      // debate_room metering since usage.cost is real.

    },
    {
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://kademurdock.com',
        'X-Title': 'Kade-AI Debate Room',
      },
      // 150s normal / 200s for a DEEP primary call, was 90: deep kimi
      // turns legitimately run 100-180s (reasoning is the whole point --
      // her words: "the chars are very 1 dimensional if thinking is off"),
      // and the gateway's congestion retries stack on top. Hanging up
      // early was converting the GOOD turns into starved fallbacks.
      // Native waits 240s on this route; 200 + a ~15s thoughtless
      // fallback still fits under it. Fallback calls (opts.noThink)
      // answer fast and keep 150.
      timeout: deepThink && !opts.noThink ? 200000 : 150000,
    },
  );
  return r.data;
}

function cleanReply(text, agentName) {
  let t = stripAiTells(String(text || '').trim());
  t = t.replace(/%%%[^%]*%%%/g, ' ')
    /* July 13 2026 scrub audit: Hermes models sometimes type literal escape
     * text ("\u00a0") or citation-shaped anchors in prose — debate turns are
     * rendered AND synthesized, so clean them here at the source. */
    .replace(/\\u00a0/gi, ' ')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/turn\d+(?:search|image|news|video|ref|file)\d+/g, '')
    .replace(/[ \t]{2,}/g, ' ');
  const prefix = new RegExp(
    `^\\s*(?:\\*\\*)?${agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\*\\*)?\\s*:\\s*`,
    'i',
  );
  t = t.replace(prefix, '');
  return t.trim();
}

/** July 30 2026 (session 35 part 4) — the ECHO GUARD, the deterministic
 * half of the religion-room fix. The prompt constitution above asks for
 * discipline; this enforces it: if a fresh turn copies a 5-word run from
 * the recent transcript (any speaker — that's how "bobbleheads on a
 * dashboard" spread through THREE mouths), or opens with the same
 * "Name, you're right..." praise-opener the room is already soaked in,
 * the turn is re-asked ONCE with a scolding cue. Fail-soft: a second
 * offense ships anyway (never loops), and any retry error keeps draft one.
 * Quoting someone to rebut them can trip this; one polite re-ask is an
 * acceptable price for killing the plague class. */
function normalizeForEcho(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function echoShingles(s, n = 5) {
  const words = normalizeForEcho(s).split(' ').filter(Boolean);
  const out = new Set();
  for (let i = 0; i + n <= words.length; i++) {
    out.add(words.slice(i, i + n).join(' '));
  }
  return out;
}
function echoesRecentLines(text, room) {
  const mine = echoShingles(text);
  if (!mine.size) return false;
  const recent = (room.transcript || []).slice(-12);
  for (const line of recent) {
    const theirs = echoShingles(line.text);
    for (const sh of mine) {
      if (theirs.has(sh)) return true;
    }
  }
  return false;
}
const VALIDATION_OPENER_RE = /^\s*[A-Z][\w .'-]{0,30},\s*(?:you(?:'re| are| just| got| nailed| hit| caught)|honey, you|baby, you|cher, you)/i;
function opensLikeTheRoom(text, room) {
  if (!VALIDATION_OPENER_RE.test(text)) return false;
  const recent = (room.transcript || []).slice(-6).filter((l) => l.speaker !== 'user');
  return recent.some((l) => VALIDATION_OPENER_RE.test(String(l.text || '')));
}

/** Generate ONE agent turn (round-robin, or a specific agent via body.agentId). */
router.post('/:id/next', requireJwtAuth, async (req, res) => {
  try {
    /* July 27 2026: reframe gateway bearer — see callOpenRouter's reroute. */
    const key = process.env.REFRAME_PROXY_SECRET || process.env.OPENROUTER_KEY;
    if (!key) {
      return res.status(500).json({ message: 'The room is not configured yet (missing model key).' });
    }
    const oid = oidOf(req);
    const room = await KadeRoom.findOne({ _id: req.params.id, user: oid });
    if (!room) {
      return res.status(404).json({ message: 'Room not found.' });
    }
    if (!room.agents.length) {
      return res.status(400).json({ message: 'This room has no characters in it.' });
    }
    if (room.transcript.length >= MAX_TRANSCRIPT) {
      return res
        .status(400)
        .json({ message: 'This room is full (400 lines). Start a fresh one to keep going.' });
    }
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const turnsToday = await KadeUsage.countDocuments({
      user: oid,
      service: 'debate_room',
      createdAt: { $gte: dayStart },
    });
    if (turnsToday >= DAILY_TURN_CAP) {
      return res.status(429).json({
        message: `That's ${DAILY_TURN_CAP} character turns today — the room re-opens tomorrow.`,
      });
    }

    let idx = ((room.nextIdx || 0) % room.agents.length + room.agents.length) % room.agents.length;
    if (req.body?.agentId) {
      const forced = room.agents.findIndex((a) => a.agentId === String(req.body.agentId));
      if (forced === -1) {
        return res.status(400).json({ message: 'That character is not in this room.' });
      }
      idx = forced;
    }
    const speaker = room.agents[idx];
    const agent = await db.getAgent({ id: speaker.agentId });
    if (!agent) {
      return res
        .status(410)
        .json({ message: `${speaker.name} no longer exists — remove them by starting a new room.` });
    }

    const humanName = firstName(req);
    const system = buildSystem(room, speaker.name, agent.instructions, humanName, isChild(req));
    const msgs = buildMessages(room, speaker.agentId);

    const deepThink = req.body?.deepThink === true;
    let data;
    let modelUsed = agent.model || FALLBACK_MODEL;
    try {
      data = await callOpenRouter(modelUsed, system, msgs, key, deepThink);
    } catch (e) {
      // agent's model string may not be a valid OpenRouter slug — retry on the fallback
      logger.warn(
        `[kade/room next] model '${modelUsed}' failed (${e?.response?.status || e.message}); retrying on ${FALLBACK_MODEL}`,
      );
      modelUsed = FALLBACK_MODEL;
      data = await callOpenRouter(modelUsed, system, msgs, key, deepThink, { noThink: true });
    }
    // July 30 2026 (session 35 part 8, Amber's cut-off receipts — five lines
    // dead mid-sentence at 74-104 chars, no slop-rewrite and no echo-guard
    // involvement per logs): K3 sometimes decides MID-REPLY to call a tool
    // that doesn't exist here, and Moonshot returns the half-sentence
    // preamble as content + tool_calls, finish_reason 'tool_calls'. Taking
    // that content verbatim saved the fragment. Now: any tool_calls or
    // non-stop finish gets logged loudly and ONE plain-speech re-ask;
    // fail-soft keeps whatever we have rather than dying.
    let roomChoice = data?.choices?.[0] || {};
    if (
      (roomChoice.message && Array.isArray(roomChoice.message.tool_calls) && roomChoice.message.tool_calls.length) ||
      (roomChoice.finish_reason && roomChoice.finish_reason !== 'stop')
    ) {
      logger.warn(
        `[kade/room next] fragment turn for ${speaker.name}: finish=${roomChoice.finish_reason} toolCalls=${(roomChoice.message && roomChoice.message.tool_calls && roomChoice.message.tool_calls.length) || 0} contentLen=${String((roomChoice.message && roomChoice.message.content) || '').length} — one plain-speech retry`,
      );
      try {
        const plainMsgs = msgs.concat([
          {
            role: 'user',
            content: `(You have no tools in this room. Give your COMPLETE spoken turn as ${speaker.name}, plain speech only, start to finish.)`,
          },
        ]);
        const dataP = await callOpenRouter(modelUsed, system, plainMsgs, key, deepThink, {
          noThink: modelUsed === FALLBACK_MODEL,
        });
        const choiceP = dataP?.choices?.[0] || {};
        const textP = cleanReply(choiceP.message && choiceP.message.content, speaker.name);
        if (textP && (!roomChoice.message || textP.length > String(roomChoice.message.content || '').length)) {
          data = dataP;
          roomChoice = choiceP;
        }
      } catch (plainErr) {
        logger.warn(`[kade/room next] plain-speech retry failed (${plainErr.message}) — keeping what we have`);
      }
    }
    let text = cleanReply(data?.choices?.[0]?.message?.content, speaker.name);
    if (!text) {
      return res.status(502).json({ message: `${speaker.name} froze up — try that turn again.` });
    }
    // Echo guard: one re-ask when the draft copies the room's phrasing or
    // its praise-opener pattern (metering uses the final call's usage; a
    // guarded turn under-counts by one draft — logged, accepted).
    if (echoesRecentLines(text, room) || opensLikeTheRoom(text, room)) {
      logger.warn(`[kade/room next] echo guard tripped for ${speaker.name} — one retry`);
      try {
        const retryMsgs = msgs.concat([
          {
            role: 'user',
            content: `(Stop. Your draft repeated phrasing or the praise-opener the room has already used. Say it again as ${speaker.name} in completely fresh words and imagery, opening with your point — not with anyone's name.)`,
          },
        ]);
        const data2 = await callOpenRouter(modelUsed, system, retryMsgs, key, deepThink);
        const text2 = cleanReply(data2?.choices?.[0]?.message?.content, speaker.name);
        if (text2) {
          text = text2;
          data = data2;
        }
      } catch (retryErr) {
        logger.warn(`[kade/room next] echo-guard retry failed (${retryErr.message}) — keeping the first draft`);
      }
    }

    const line = { speaker: speaker.agentId, name: speaker.name, text, ts: new Date() };
    room.transcript.push(line);
    room.nextIdx = (idx + 1) % room.agents.length;
    room.turnCount = (room.turnCount || 0) + 1;
    await room.save();

    const cost =
      typeof data?.usage?.cost === 'number'
        ? data.usage.cost
        : ((data?.usage?.total_tokens || 0) / 1e6) * 1.0; // rough $1/M-token fallback
    logKadeUsage({
      userId: String(req.user.id || req.user._id),
      service: 'debate_room',
      quantity: 1,
      unit: 'turns',
      costUSD: cost,
      metadata: { roomId: String(room._id), agentId: speaker.agentId, model: modelUsed, deepThink },
    });

    return res.json({ message: line, nextIdx: room.nextIdx, turnCount: room.turnCount });
  } catch (err) {
    logger.error('[kade/room next] error:', err?.response?.data || err);
    // KNOWN-GAP fix (July 9 2026): the room calls OpenRouter directly, so the
    // reframe proxy's friendly out-of-credits rewrite never sees these
    // failures. Credit/quota errors get their own honest message instead of
    // a generic "try again" that can't possibly work.
    const orStatus = err?.response?.status;
    const orMsg = String(
      err?.response?.data?.error?.message || err?.response?.data?.message || '',
    );
    if (orStatus === 402 || /insufficient|credit|quota|balance/i.test(orMsg)) {
      return res.status(402).json({
        message:
          "The room's AI tab ran dry mid-debate, so this turn couldn't be generated. Let Kade know the server needs feeding — details on the Feed the Server page.",
      });
    }
    return res.status(500).json({ message: 'That turn failed — give it another try.' });
  }
});

/** Delete a room. */
/** Edit the cast mid-room (July 30 2026, session 35 part 3 — her ask: "it
 * would maybe be nice to be able to add and remove agents"). Additions
 * snapshot exactly like create; removals keep the room at MIN_AGENTS or
 * more; every change writes a Narrator line so both the humans AND the
 * models know who walked in or out (buildMessages renders any non-agent
 * speaker as a plain named line, so 'narrator' needs no special casing —
 * verified against that function before this route existed). */
router.post('/:id/cast', requireJwtAuth, async (req, res) => {
  try {
    const room = await KadeRoom.findOne({ _id: req.params.id, user: oidOf(req) });
    if (!room) {
      return res.status(404).json({ message: 'Room not found.' });
    }
    const add = Array.isArray(req.body?.add) ? [...new Set(req.body.add.map(String))] : [];
    const remove = Array.isArray(req.body?.remove)
      ? new Set(req.body.remove.map(String))
      : new Set();
    if (!add.length && !remove.size) {
      return res.status(400).json({ message: 'Nothing to change.' });
    }
    const seated = new Set(room.agents.map((a) => a.agentId));
    const removing = room.agents.filter((a) => remove.has(a.agentId));
    const keeping = room.agents.filter((a) => !remove.has(a.agentId));
    const toAdd = add.filter((id) => !seated.has(id));
    if (keeping.length + toAdd.length < MIN_AGENTS) {
      return res.status(400).json({ message: `A room needs at least ${MIN_AGENTS} characters.` });
    }
    if (keeping.length + toAdd.length > MAX_AGENTS) {
      return res.status(400).json({ message: `A room fits at most ${MAX_AGENTS} characters.` });
    }
    const snaps = [];
    for (const id of toAdd) {
      const a = await db.getAgent({ id });
      if (!a) {
        return res.status(404).json({ message: `Could not find one of those characters (${id}).` });
      }
      snaps.push({
        agentId: a.id,
        name: a.name || 'Unnamed agent',
        avatar: (a.avatar && a.avatar.filepath) || '',
        voiceId: (a.tts && a.tts.voiceId) || '',
        rate: (a.tts && Number(a.tts.speakingRate)) || null,
      });
    }
    room.agents = keeping.concat(snaps);
    room.nextIdx =
      (((room.nextIdx || 0) % room.agents.length) + room.agents.length) % room.agents.length;
    const ts = new Date();
    if (room.transcript.length < MAX_TRANSCRIPT) {
      for (const gone of removing) {
        room.transcript.push({
          speaker: 'narrator',
          name: 'Narrator',
          text: `${gone.name} has left the room.`,
          ts,
        });
      }
      for (const s of snaps) {
        room.transcript.push({
          speaker: 'narrator',
          name: 'Narrator',
          text: `${s.name} has joined the room.`,
          ts,
        });
      }
    }
    await room.save();
    return res.json({ room: roomView(room) });
  } catch (err) {
    logger.error('[kade/room cast] error:', err);
    return res.status(500).json({ message: 'Could not change the cast.' });
  }
});

router.delete('/:id', requireJwtAuth, async (req, res) => {
  try {
    const r = await KadeRoom.deleteOne({ _id: req.params.id, user: oidOf(req) });
    if (!r.deletedCount) {
      return res.status(404).json({ message: 'Room not found.' });
    }
    return res.json({ ok: true });
  } catch (err) {
    logger.error('[kade/room delete] error:', err);
    return res.status(500).json({ message: 'Could not delete that room.' });
  }
});

/** Share (or unshare) a room to the Conversation Hall. */
router.post('/:id/share', requireJwtAuth, async (req, res) => {
  try {
    const room = await KadeRoom.findOne({ _id: req.params.id, user: oidOf(req) });
    if (!room) {
      return res.status(404).json({ message: 'Room not found.' });
    }
    const share = req.body?.share !== false;
    room.shared = share;
    room.sharedTitle = share ? String(req.body?.title || '').trim().slice(0, 120) : '';
    room.sharedAt = share ? new Date() : null;
    await room.save();
    return res.json({ shared: room.shared });
  } catch (err) {
    logger.error('[kade/room share] error:', err);
    return res.status(500).json({ message: 'Could not share that room.' });
  }
});

/** Admin debug lanes (July 30 2026, session 35 part 4 — Amber's religion
 * room went bad and rooms had NO admin read path, same gap logs-messages
 * had before ?raw=1). Read-only, admin-only, additive. */
router.get('/admin/list', requireJwtAuth, requireAdminAccess, async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim();
    if (!userId) return res.status(400).json({ message: 'userId required' });
    const rooms = await KadeRoom.find({ user: userId })
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean();
    return res.json({
      rooms: rooms.map((r) => ({
        id: String(r._id),
        topic: r.topic,
        agents: (r.agents || []).map((a) => a.name),
        turnCount: r.turnCount || 0,
        lines: (r.transcript || []).length,
        updatedAt: r.updatedAt,
      })),
    });
  } catch (err) {
    logger.error('[kade/room admin list] error:', err);
    return res.status(500).json({ message: 'Could not list rooms.' });
  }
});

router.get('/admin/one', requireJwtAuth, requireAdminAccess, async (req, res) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ message: 'id required' });
    const room = await KadeRoom.findById(id).lean();
    if (!room) return res.status(404).json({ message: 'Room not found.' });
    return res.json({ room });
  } catch (err) {
    logger.error('[kade/room admin one] error:', err);
    return res.status(500).json({ message: 'Could not load the room.' });
  }
});

router.page = (req, res) => res.type('html').send(roomHtml);
router.hallPage = (req, res) => res.type('html').send(hallHtml);

module.exports = router;
