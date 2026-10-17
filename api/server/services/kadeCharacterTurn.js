/**
 * KADE CHARACTER TURNS (Oct 16 2026): a character speaks first, for real.
 *
 * Kade wants characters she can work with the way she works with Claude Code
 * from her phone, and friends who text first. Before this, nothing a character
 * did in the background could come back: research, errands and coding jobs
 * finished with at most a generic push, Kiana's friend texts were written on
 * the service seat with none of the person's memory loaded, and every one of
 * them arrived as a notification with no conversation behind it to answer.
 *
 *   compose()  runs ONE turn of the character on the person's own seat, inside
 *              a throwaway temporary chat, from a platform note. Their memory,
 *              the character's persona, house notes, mood, time sense, moments
 *              and tools all ride exactly as they do in a chat. The turn is a
 *              hidden run (services/kadeHiddenRun.js): no keeper, no waiting-note
 *              pickup, no soul writes. The throwaway chat is deleted after.
 *   post()     writes the text into the person's real conversation as the
 *              character's message and lifts that conversation to the top.
 *   speakFirst() both, plus a push that opens that conversation (iPhone
 *              builds that know the "conversation" route; older ones just open).
 *
 * Billing follows Kade's word (Oct 16 2026): work a person asked for is billed
 * to that person like any chat turn; a character texting first, unasked, is the
 * platform's expense (platformPaid). Kill switch: KADE_CHARACTER_TURNS=0.
 */
'use strict';

const { v4: uuidv4 } = require('uuid');
const { logger } = require('@librechat/data-schemas');
const { Constants } = require('librechat-data-provider');
const { hiddenRunHeaders } = require('./kadeHiddenRun');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REUSE_DAYS = Number(process.env.KADE_POST_REUSE_DAYS || 3);

function enabled() {
  return process.env.KADE_CHARACTER_TURNS !== '0';
}

function base() {
  return `http://127.0.0.1:${process.env.PORT || 3080}`;
}

function db() {
  return require('~/models');
}

/* Oct 17 2026: two live checks hung after the reply was written, with no error. Every
 * database step now logs how long it took and gives up after 30 seconds by name, so a
 * stall says where it is instead of holding the call open. */
async function step(name, promise, ms = 30000) {
  const t0 = Date.now();
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} took longer than ${ms / 1000} s`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    logger.info(`[kadeCharacterTurn] step ${name} ${Date.now() - t0} ms`);
  }
}

/** Only what a post needs: the full record carries every saved version (megabytes for some). */
function agentBasics(agentId) {
  return require('mongoose').models.Agent.findOne({ id: String(agentId) }).select('id name model').lean();
}

/** The text of a finished turn from the stream's final event. */
function finalText(d) {
  const msg = d && d.responseMessage;
  if (!msg) return typeof (d && d.text) === 'string' ? d.text : '';
  if (typeof msg.text === 'string' && msg.text.trim()) return msg.text;
  return (Array.isArray(msg.content) ? msg.content : [])
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

/** Read one SSE stream to its final event. */
async function readStream(res, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const dec = new TextDecoder();
  let buf = '';
  let reply = '';
  let siteError = '';
  let toolCalls = 0;
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let d;
      try {
        d = JSON.parse(line.slice(6));
      } catch (_) {
        continue;
      }
      if (!siteError && d && typeof d.error === 'string' && d.error.trim()) siteError = d.error.trim();
      if (d.event === 'on_message_delta' && Array.isArray(d.data?.delta?.content)) {
        for (const part of d.data.delta.content) {
          if (part.type === 'text' && part.text) reply += part.text;
        }
      }
      if (d.event === 'on_run_step' && d.data?.stepDetails?.type === 'tool_calls') toolCalls += 1;
      if (d.final) {
        return { text: finalText(d) || reply, toolCalls, siteError };
      }
    }
    if (Date.now() > deadline) {
      throw new Error('the character took too long');
    }
  }
  return { text: reply, toolCalls, siteError };
}

/**
 * Run one hidden turn of `agentId` for `userId` and return what it said.
 * @returns {Promise<{ text: string, toolCalls: number }>}
 */
async function compose({ userId, agentId, note, platformPaid = false, steps, timezone, timeoutMs = 240000, onStart }) {
  if (!enabled()) throw new Error('character turns are switched off');
  const user = await db().getUserById(String(userId), '_id username email provider role name');
  if (!user) throw new Error('no such person');
  const token = await db().generateToken(user, 15 * 60 * 1000);
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': UA,
    ...hiddenRunHeaders({ platformPaid, steps }),
  };
  const body = {
    endpoint: 'agents',
    agent_id: agentId,
    text: note,
    conversationId: 'new',
    parentMessageId: Constants.NO_PARENT,
    isTemporary: true,
    ...(timezone ? { timezone } : {}),
  };
  let start;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    start = await fetch(`${base()}/api/agents/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    /* The person may be mid-chat; the concurrency guard says wait, so wait. */
    if (start.status !== 429 || attempt === 4) break;
    await new Promise((r) => setTimeout(r, 15000 * attempt));
  }
  if (!start.ok) {
    const t = await start.text().catch(() => '');
    throw new Error(`the site would not start the turn (${start.status}): ${t.slice(0, 160)}`);
  }
  const { streamId, conversationId: tempConvo } = await start.json();
  if (!streamId) throw new Error('the site returned no stream');
  if (typeof onStart === 'function') {
    try {
      await onStart({ streamId, conversationId: tempConvo || streamId });
    } catch (_) {}
  }
  let result;
  try {
    await new Promise((r) => setTimeout(r, 300));
    const stream = await fetch(`${base()}/api/agents/chat/stream/${encodeURIComponent(streamId)}`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA, Accept: 'text/event-stream' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!stream.ok) throw new Error(`could not follow the turn (${stream.status})`);
    result = await readStream(stream, timeoutMs);
    logger.info(`[kadeCharacterTurn] step compose-read ${String(result.text || '').length} chars`);
  } finally {
    const convoId = tempConvo || streamId;
    db()
      .deleteConvos(String(userId), { conversationId: convoId })
      .catch((e) => logger.warn('[kadeCharacterTurn] throwaway chat not deleted (it is temporary anyway): ' + e.message));
  }
  const text = String(result.text || '').trim();
  if (!text) {
    throw new Error(result.siteError ? `no reply (the site said: ${result.siteError.slice(0, 200)})` : 'no reply');
  }
  return { text, toolCalls: result.toolCalls, composeConversationId: tempConvo || streamId };
}

/** Pick the conversation a post belongs in, creating one when there is none. */
async function pickConversation({ userId, agent, conversationId, title }) {
  const Conversation = require('mongoose').models.Conversation;
  if (conversationId) {
    const own = await Conversation.findOne({ conversationId: String(conversationId), user: String(userId) })
      .select('conversationId isTemporary')
      .lean();
    if (own && !own.isTemporary) return { conversationId: own.conversationId, created: false };
  }
  const since = new Date(Date.now() - REUSE_DAYS * 86400000);
  const recent = await Conversation.findOne({
    user: String(userId),
    agent_id: agent.id,
    isTemporary: { $ne: true },
    updatedAt: { $gte: since },
  })
    .sort({ updatedAt: -1 })
    .select('conversationId')
    .lean();
  if (recent) return { conversationId: recent.conversationId, created: false };
  const fresh = uuidv4();
  await db().saveConvo(
    { userId: String(userId), isTemporary: false },
    {
      conversationId: fresh,
      endpoint: 'agents',
      agent_id: agent.id,
      model: agent.model,
      title: String(title || agent.name || 'A message').slice(0, 120),
    },
    { context: 'kadeCharacterTurn.post new conversation' },
  );
  return { conversationId: fresh, created: true };
}

/**
 * Write `text` into the person's conversation as the character's message.
 * @returns {Promise<{ conversationId: string, messageId: string, created: boolean }>}
 */
async function post({ userId, agentId, text, conversationId, title, kind = 'post' }) {
  const agent = await step('agent', agentBasics(agentId));
  if (!agent) throw new Error('no such character');
  const picked = await step('pick-conversation', pickConversation({ userId, agent, conversationId, title }));
  const Message = require('mongoose').models.Message;
  const leaf = await step(
    'leaf',
    Message.findOne({ conversationId: picked.conversationId, user: String(userId) })
      .sort({ createdAt: -1 })
      .select('messageId')
      .lean(),
  );
  const messageId = uuidv4();
  const clean = String(text).trim();
  await step('save-message', db().saveMessage(
    { userId: String(userId), isTemporary: false },
    {
      messageId,
      conversationId: picked.conversationId,
      parentMessageId: leaf ? leaf.messageId : Constants.NO_PARENT,
      sender: agent.name || 'Character',
      isCreatedByUser: false,
      endpoint: 'agents',
      model: agent.model,
      text: clean,
      content: [{ type: 'text', text: clean }],
      unfinished: false,
      error: false,
      metadata: { kadePost: { kind, at: new Date().toISOString(), agentId } },
    },
    { context: 'kadeCharacterTurn.post' },
  ));
  await step(
    'touch-conversation',
    require('mongoose').models.Conversation.updateOne(
      { conversationId: picked.conversationId, user: String(userId) },
      { $set: { updatedAt: new Date() } },
    ),
  );
  return { conversationId: picked.conversationId, messageId, created: picked.created, agentName: agent.name || '' };
}

/** The first sentence or so, without voice directions, for the lock screen. */
function pushPreview(text) {
  const plain = String(text || '')
    .replace(/%%%[^%\n]{0,160}%%%/g, ' ')
    .replace(/\[[^\]\n]{0,40}\]/g, ' ')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= 180) return plain;
  const cut = plain.slice(0, 180);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return stop > 60 ? cut.slice(0, stop + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
}

/** Push that opens the conversation. `requested` = the person asked for this work. */
async function notifyPost({ userId, agentId, agentName, text, conversationId, requested = false }) {
  const bridgeUrl = (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
  const secret = process.env.BRIDGE_SECRET || '';
  if (!secret) return { ok: false, blocked: 'no bridge secret' };
  logger.info(`[kadeCharacterTurn] push starting to ${bridgeUrl.replace(/^https?:\/\//, '')}`);
  try {
    const r = await fetch(`${bridgeUrl}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        secret,
        agentId,
        agentName,
        title: String(agentName || 'A character').slice(0, 40),
        body: pushPreview(text) || 'Sent you a message.',
        userId: String(userId),
        requested: requested === true,
        route: 'conversation',
        conversationId,
      }),
      /* Oct 16 2026: a bridge mid-redeploy held the first live test for five minutes. */
      signal: AbortSignal.timeout(20000),
    });
    return await r.json().catch(() => ({ ok: r.ok }));
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * The whole move: compose as the person, post into their conversation, push.
 * `note` is the platform's instruction for this one message (never shown).
 */
async function speakFirst({
  userId,
  agentId,
  note,
  conversationId,
  title,
  kind = 'post',
  platformPaid = false,
  requested = false,
  steps,
  push = true,
  timezone,
  timeoutMs,
  onStart,
  beforePost,
  onPosted,
}) {
  const framed =
    `[PLATFORM NOTE, not something they typed: ${String(note).trim()}\n` +
    'Write only the message you are sending them now, in your own voice. They will read or hear it later in your conversation with them, ' +
    'so it has to make sense on its own. Use your usual voice directions if you use them. Do not mention this note. ' +
    'Never make up something that happened to you: if you mention your own day, use only what is in your own days above, or say nothing about it.]';
  const composed = await compose({
    userId,
    agentId,
    note: framed,
    platformPaid,
    steps,
    timezone,
    onStart,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  if (typeof beforePost === 'function' && !(await beforePost(composed))) {
    return { posted: false, text: composed.text, toolCalls: composed.toolCalls, composeConversationId: composed.composeConversationId };
  }
  const placed = await post({ userId, agentId, text: composed.text, conversationId, title, kind });
  logger.info(
    `[kadeCharacterTurn] posted ${kind} agent=${agentId} user=${String(userId).slice(0, 8)} convo=${placed.conversationId.slice(0, 8)} ` +
      `created=${placed.created} tools=${composed.toolCalls}`,
  );
  /* The message is in the conversation: whatever happens to the push, the work is done. */
  if (typeof onPosted === 'function') {
    try {
      await onPosted(placed, composed);
    } catch (e) {
      logger.warn('[kadeCharacterTurn] onPosted failed: ' + e.message);
    }
  }
  let pushed = null;
  if (push) {
    /* Oct 17 2026: the push once never reached the bridge and held the whole call open; a
     * hard 25-second ceiling, and the outcome is logged either way. */
    pushed = await Promise.race([
      notifyPost({ userId, agentId, agentName: placed.agentName, text: composed.text, conversationId: placed.conversationId, requested }),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'push timed out after 25 s' }), 25000)),
    ]);
    logger.info(`[kadeCharacterTurn] push ${kind} convo=${placed.conversationId.slice(0, 8)} -> ${JSON.stringify(pushed).slice(0, 160)}`);
  }
  return { ...placed, posted: true, text: composed.text, toolCalls: composed.toolCalls, composeConversationId: composed.composeConversationId, pushed };
}

module.exports = { compose, post, notifyPost, speakFirst, pushPreview, finalText };
