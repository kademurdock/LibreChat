const axios = require('axios');
const express = require('express');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { KadeRoom } = require('~/models/kadeRoom');
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
    const all = (await db.getAgents({})) || [];
    const list = all
      .filter(
        (a) =>
          (Array.isArray(a.projectIds) && a.projectIds.length > 0) ||
          String(a.author) === userId,
      )
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
    '--- LIVE GROUP ROOM ---',
    `You are one voice in a live multi-party conversation room on Kade-AI. Also in the room: ${cast}. Everyone except ${humanName} is another AI character with their own persona.`,
    `TOPIC / SCENE: ${room.topic}`,
    room.goals ? `GROUND RULES AND GOALS FROM ${humanName}: ${room.goals}` : '',
    '',
    'How to behave in the room:',
    '- React to what was actually said. Agree, push back, argue, joke, challenge, concede — whatever your persona would honestly do. Disagreement is welcome; do not go along with things just to be polite.',
    `- Speak ONLY as ${agentName}. Never write lines or actions for anyone else in the room.`,
    '- Do NOT start your reply with your own name or any speaker label — just talk.',
    '- Keep turns short and punchy: about 2-5 sentences, two short paragraphs at the very most.',
    '- Address the others by name when you are responding to them.',
    '- Plain conversational text only: no headings, no bullet lists, no %%% tags, no markdown tables.',
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
  return msgs;
}

async function callOpenRouter(model, system, msgs, key) {
  const r = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model,
      max_tokens: TURN_MAX_TOKENS,
      messages: [{ role: 'system', content: system }, ...msgs],
      usage: { include: true },
    },
    {
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://kademurdock.com',
        'X-Title': 'Kade-AI Debate Room',
      },
      timeout: 90000,
    },
  );
  return r.data;
}

function cleanReply(text, agentName) {
  let t = String(text || '').trim();
  t = t.replace(/%%%[^%]*%%%/g, ' ').replace(/[ \t]{2,}/g, ' ');
  const prefix = new RegExp(
    `^\\s*(?:\\*\\*)?${agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\*\\*)?\\s*:\\s*`,
    'i',
  );
  t = t.replace(prefix, '');
  return t.trim();
}

/** Generate ONE agent turn (round-robin, or a specific agent via body.agentId). */
router.post('/:id/next', requireJwtAuth, async (req, res) => {
  try {
    const key = process.env.OPENROUTER_KEY;
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

    let data;
    let modelUsed = agent.model || FALLBACK_MODEL;
    try {
      data = await callOpenRouter(modelUsed, system, msgs, key);
    } catch (e) {
      // agent's model string may not be a valid OpenRouter slug — retry on the fallback
      logger.warn(
        `[kade/room next] model '${modelUsed}' failed (${e?.response?.status || e.message}); retrying on ${FALLBACK_MODEL}`,
      );
      modelUsed = FALLBACK_MODEL;
      data = await callOpenRouter(modelUsed, system, msgs, key);
    }
    const text = cleanReply(data?.choices?.[0]?.message?.content, speaker.name);
    if (!text) {
      return res.status(502).json({ message: `${speaker.name} froze up — try that turn again.` });
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
      metadata: { roomId: String(room._id), agentId: speaker.agentId, model: modelUsed },
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

router.page = (req, res) => res.type('html').send(roomHtml);
router.hallPage = (req, res) => res.type('html').send(hallHtml);

module.exports = router;
