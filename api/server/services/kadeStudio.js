'use strict';
/**
 * KADE STUDIO (Nov 10 2026): any character can make a YuE2 song by conversation.
 *
 * The engine behind the kade_studio tool (tools/structured/KadeStudio.js). It does not copy the
 * Sound Booth. Every action goes to the booth's own routes on this server, signed in as the
 * person being served (never the service seat a call runs under), so every rule the booth has
 * still decides: the 12 cent charge and its refund (services/kadeSongCharge.js, in the booth's
 * /render), trained styles only with the Family feature pack, the booth's own input checks, one
 * YuE2 request in progress per person with one to four takes in it, and the lyric desk's clean
 * songs for the child account and the App Review seat.
 *
 * Money (her words: no limit on who or how many; 12 cents from their own balance; free for her):
 *   The price is 12 cents for each take (services/kadeSongCharge.js): one take 12, four takes 48.
 *   quote  works out the price and keeps the song exactly as it will be made. Nothing is spent.
 *   start  is refused unless the price was said in an EARLIER reply and the person's own latest
 *          message is a plain yes (services/kadeSpendGate.js: the same rules, the same collection
 *          and the same after-reply stamp as the fal song gate, so a regenerate, a page that says
 *          "start it", or a second call in the same reply cannot buy anything). The quote is
 *          claimed in one atomic write, then the booth is asked, and the answer comes straight
 *          back: nothing waits on a GPU.
 *   The administrator is told it is free for her, with the GPU estimate, and still says yes.
 *
 * Lanes:
 *   text chat          everything.
 *   a phone call       identity is caller ID only, so nothing that spends and nothing about the
 *                      account: no start, no cancel, no lyric draft, no status, no list (review fix:
 *                      a borrowed or spoofed number must not hear someone's song titles).
 *   signed-in app voice built, and off: the fork cannot yet tell it from a phone call. It is taken
 *                      as app voice only when KADE_STUDIO_APP_VOICE=1 AND the service seat's
 *                      request says kadeCallerSignedIn: true, which the bridge does not send yet.
 *
 * When the song is finished the booth's notify hook calls deliver(): code, no model, posts the
 * link in the conversation that asked as the character, and pushes. One atomic claim per job.
 *
 * The lyric desk (draft, draft_read) is OFF from a conversation (review fix): a desk draft is paid
 * from the person's balance by the booth, about as much as the song, and here it had no price said
 * and no yes. The character writes the words with the person instead, which costs nothing extra.
 * KADE_STUDIO_DRAFT=1 opens it for the administrator's own conversations only (her real cost).
 *
 * Switches: KADE_STUDIO=0 (the tool is not offered and refuses), KADE_STUDIO_DELIVER=0 (the
 * finished song is announced by the Sound Booth's own push only, as before),
 * KADE_STUDIO_APP_VOICE=1 (see above; off unless set), KADE_STUDIO_DRAFT=1 (see above; off unless set).
 *
 * No '~' requires at load time, so node --test loads it.
 */

const crypto = require('crypto');
const spend = require('./kadeSpendGate');
const charge = require('./kadeSongCharge');

const DRAFTS = 'kadestudiodrafts';
const QUOTE_MINUTES = 60;
const VOICE_QUOTE_MINUTES = 10;
const ONCE = 'kade_studio_start';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function on(env = process.env) {
  return String((env && env.KADE_STUDIO) ?? '') !== '0';
}
function deliverOn(env = process.env) {
  return on(env) && String((env && env.KADE_STUDIO_DELIVER) ?? '') !== '0';
}
function draftOn(env = process.env) {
  return String((env && env.KADE_STUDIO_DRAFT) ?? '') === '1';
}
function appVoiceOn(env = process.env) {
  return String((env && env.KADE_STUDIO_APP_VOICE) ?? '') === '1';
}

/** What Kade is told a song costs her in GPU time (she hears real cost, never "free" alone). */
function gpuEstimate(env = process.env) {
  const said = String((env && env.KADE_STUDIO_GPU_ESTIMATE) || '').trim();
  return said || 'about 5 cents of GPU time for each take, or 10 to 15 cents for a song when the GPU has to wake up first';
}

/* ----------------------------------------------------------------- the booth */

/** The Sound Booth's own routes on this server, called as the person (a short-lived token of theirs). */
function defaultBooth() {
  const base = () => `http://127.0.0.1:${process.env.PORT || 3080}/api/kade/sound-booth`;
  async function call(userId, method, path, body, timeoutMs) {
    const models = require('~/models');
    const user = await models.getUserById(String(userId), '_id username email provider role name');
    if (!user) throw new Error('no such person');
    const token = await models.generateToken(user, 5 * 60 * 1000);
    const r = await fetch(base() + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': UA },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let data = null;
    try {
      data = await r.json();
    } catch (_) {
      data = null;
    }
    return { status: r.status, ok: r.ok, data: data || {} };
  }
  const id = (v) => encodeURIComponent(String(v));
  return {
    render: (uid, body) => call(uid, 'POST', '/render', body, body && body.estimateOnly ? 20000 : 150000),
    status: (uid, jobId) => call(uid, 'GET', `/status/${id(jobId)}`, null, 45000),
    cancel: (uid, jobId) => call(uid, 'POST', `/cancel/${id(jobId)}`, {}, 60000),
    projects: (uid) => call(uid, 'GET', '/projects', null, 30000),
    project: (uid, projectId) => call(uid, 'GET', `/projects/${id(projectId)}`, null, 30000),
    script: (uid, body) => call(uid, 'POST', '/script', body, 30000),
    scriptJob: (uid, jobId) => call(uid, 'GET', `/script/job/${id(jobId)}`, null, 20000),
  };
}

function booth(deps) {
  return (deps && deps.booth) || defaultBooth();
}
let quotesIndexed = false;
function quotes(deps) {
  if (deps && deps.quotes) return deps.quotes;
  const c = require('mongoose').connection.collection(spend.SONG_QUOTES);
  if (!quotesIndexed) {
    quotesIndexed = true;
    /* A studio price row holds the song's words. It goes by itself a few days on (expireAt is only on studio rows). */
    Promise.resolve()
      .then(() => c.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }))
      .catch(() => {});
  }
  return c;
}
const QUOTE_KEEP_DAYS = 3;
function drafts(deps) {
  return (deps && deps.drafts) || require('mongoose').connection.collection(DRAFTS);
}
function chargeDeps(deps) {
  return { ...(deps && deps.charge ? deps.charge : {}), env: (deps && deps.env) || process.env };
}
async function accountOf(userId, deps) {
  if (deps && typeof deps.account === 'function') return deps.account(userId);
  const { PAYER_FIELDS } = require('./kadeRealCost');
  const u = await require('~/models').getUserById(String(userId), `kadeAccountType ${PAYER_FIELDS}`);
  return u ? { ...(typeof u.toObject === 'function' ? u.toObject() : u), id: String(userId) } : null;
}
/** 'clean' for the child account, the App Review seat and anyone unknown (utils/kadeSongAudience). */
async function audienceOf(account, deps) {
  if (deps && typeof deps.audience === 'function') return deps.audience(account);
  try {
    return await require('../utils/kadeSongAudience').songAudience(account);
  } catch (_) {
    return 'clean';
  }
}
function explicitIn(text, deps) {
  if (deps && typeof deps.explicit === 'function') return deps.explicit(text);
  try {
    return require('../utils/kadeSongAudience').hasExplicitWords(text);
  } catch (_) {
    return true; /* cannot check: a clean song is never let through unchecked */
  }
}
function unwrap(found) {
  const doc = found && (found.value !== undefined ? found.value : found);
  return doc && doc._id !== undefined ? doc : null;
}

/* ------------------------------------------------------------ who is asking */

/**
 * The person this turn is for, and the lane it came in on.
 * @returns {{ ok: true, userId: string, lane: 'text' | 'phone' | 'app-voice' } | { ok: false, why: string }}
 */
function actor(req, env = process.env) {
  if (!on(env)) return { ok: false, why: 'off' };
  if (!req || !req.user || !req.user.id) return { ok: false, why: 'unavailable' };
  if (req.kadeHiddenRun === true) return { ok: false, why: 'hidden' };
  if (req.kadeOnBehalfOfUnresolved === true) return { ok: false, why: 'unknown-caller' };
  const behalf = req.kadeOnBehalfOf;
  const body = req.body || {};
  if (behalf && behalf.id) {
    const signedIn =
      appVoiceOn(env) && String(req.user.role || '').toUpperCase() === 'ADMIN' && body.kadeCallerSignedIn === true;
    return { ok: true, userId: String(behalf.id), lane: signedIn ? 'app-voice' : 'phone' };
  }
  /* A caller was named but not resolved to an account (or named by a seat that may not): nobody. */
  if (body.kadeOnBehalfOf) return { ok: false, why: 'unknown-caller' };
  if (spend.latestWords(body.text).folded) return { ok: true, userId: String(req.user.id), lane: 'phone' };
  return { ok: true, userId: String(req.user.id), lane: 'text' };
}

const WHY = {
  off: 'songs by conversation are switched off right now. The Sound Booth page still works',
  unavailable: 'this is not available here',
  hidden: 'a background job cannot make a song',
  'unknown-caller': 'the person on the line could not be matched to an account, so nothing can be made for them here',
};

/* What the character is told when a start is refused. Each begins "Not started:" in the tool. */
const REFUSED = {
  phone:
    'a song cannot be started while you are talking by voice or on a phone call, because the yes to the price cannot be trusted here. ' +
    'Say that kindly in one short sentence, do not write the song now, and ask them to ask you again in the text chat',
  noQuote: 'there is no price waiting for a yes here. Call quote first, tell them the price in your reply and ask',
  sameTurn:
    'the price was only just worked out in this same reply, so they have not heard it yet. Tell them the price now and ask. ' +
    'Start it in a later reply, after their own message says yes',
  noYes: 'their last message is not a plain yes to the price. Say the price again and ask for a plain yes, and start only after they say it',
  notSaid:
    'that price was worked out but never said to them in your own words, so their yes was not a yes to it. ' +
    'Quote again, say the price in your reply and ask. Start in a later reply, after their own message says yes',
  replay:
    'this reply is a retry of an earlier one, so their message is an old one sent again and cannot count as a new yes. ' +
    'Say the price again and ask for a fresh yes',
  oncePerTurn: 'one song per reply, and this reply already tried to start one',
  taken: 'that price was already used or has closed. Quote again, tell them the price and ask',
  newConversation: 'this conversation is too new to hold a price yet. Tell them the price now, and call quote again on their next message',
};

function cleanTitle(s) {
  return String(s || '')
    .replace(/[[\]()<>`*_#\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** The booth request for this song, exactly as the booth page would send it. */
function songBody(input) {
  const direction = String((input && input.direction) || '').trim();
  const lyrics = String((input && input.lyrics) || '').trim();
  const instrumental = (input && input.instrumental) === true;
  const takes = Math.max(1, Math.min(4, Math.round(Number(input && input.takes) || 1)));
  const title = cleanTitle(input && input.title);
  const style = String((input && input.style) || '').trim().toLowerCase();
  const body = { engine: 'yue2', script: direction, count: takes };
  if (title) body.title = title;
  if (instrumental) body.singing = 'Instrumental, no singing';
  else body.lyrics = lyrics;
  if (style && style !== 'none') body.band = style;
  return body;
}

/* --------------------------------------------------------------------- quote */

/**
 * Work out the price and keep the song as it will be made. Spends nothing. The booth is asked
 * for its own estimate first, so every refusal it would make at start is heard now.
 */
async function quote({ req, agentId, agentName, input }, deps = {}) {
  const env = deps.env || process.env;
  const who = actor(req, env);
  if (!who.ok) return { ok: false, error: WHY[who.why] || WHY.unavailable };
  const account = await accountOf(who.userId, deps);
  if (!account) return { ok: false, error: WHY['unknown-caller'] };
  const body = songBody(input);
  if (body.script.length < 3) return { ok: false, error: 'describe the music first: the style, the instruments and the singing voice, in a sentence or two (direction)' };
  if (!body.singing && !body.lyrics) return { ok: false, error: 'the song needs its words (lyrics), with [Verse] and [Chorus] tags, or instrumental set to true' };

  /* The lyric desk holds a clean song to clean in code; words that come from a conversation are held the same way. */
  if ((await audienceOf(account, deps)) === 'clean' && explicitIn([body.title, body.script, body.lyrics].filter(Boolean).join('\n'), deps)) {
    return {
      ok: false,
      soft: true,
      error: 'these words have language this song cannot have. Rewrite those lines clean, keep everything else, and quote again. Do not mention any rule to them',
    };
  }

  const checked = await booth(deps).render(who.userId, { ...body, estimateOnly: true });
  if (!checked.ok) {
    return { ok: false, error: `the Sound Booth says: ${String((checked.data && checked.data.error) || 'it cannot take this song right now').slice(0, 400)}` };
  }
  const takes = body.count;
  const price = charge.priceFor(account, env, takes);
  const title = body.title || 'your song';
  const each = charge.sayCents(price.unitCents);
  const priceLine = price.admin
    ? `Free for you. It will use ${gpuEstimate(env)}, on the RunPod bill.`
    : price.free
      ? 'This song is free.'
      : price.perTake && takes > 1
        ? `This takes ${charge.sayCents(price.cents)} from their balance: ${each} for each of ${takes} takes. A take that fails gets its ${each} back.`
        : `This song takes ${charge.sayCents(price.cents)} from their balance, for ${takes} take${takes === 1 ? '' : 's'}. If it fails, the ${charge.sayCents(price.cents)} goes back.`;

  if (who.lane === 'phone') {
    return { ok: true, quoteId: null, title, takes, tellThem: `${priceLine} ${REFUSED.phone[0].toUpperCase()}${REFUSED.phone.slice(1)}.` };
  }
  const convo = who.lane === 'text' ? spend.conversationOf(req) : null;
  if (who.lane === 'text' && !convo) return { ok: true, quoteId: null, title, takes, tellThem: `${priceLine} ${REFUSED.newConversation[0].toUpperCase()}${REFUSED.newConversation.slice(1)}.` };

  const quoteId = `y${crypto.randomBytes(6).toString('hex')}`;
  await quotes(deps).insertOne({
    quoteId,
    kind: 'studio',
    engine: 'yue2',
    userId: who.userId,
    agentId: String(agentId || ''),
    conversationId: convo,
    lane: who.lane,
    body,
    title,
    free: price.free,
    cents: price.cents,
    estUSD: price.usd,
    turnId: spend.turnId(req),
    createdAt: new Date(),
    expireAt: new Date(Date.now() + QUOTE_KEEP_DAYS * 86400000),
  });
  spend.markQuoted(req, spend.SONG_QUOTES);
  return {
    ok: true,
    quoteId,
    title,
    takes,
    tellThem:
      `${priceLine} Say that in your reply, in plain words with the amount, and ask if they want it made. ` +
      'Do not start it in this reply. Call start in a later reply, only after their own message says yes.',
  };
}

/* --------------------------------------------------------------------- start */

async function findQuote({ who, req, agentId, quoteId, tid }, deps) {
  const c = quotes(deps);
  const minutes = who.lane === 'app-voice' ? VOICE_QUOTE_MINUTES : QUOTE_MINUTES;
  const base = {
    kind: 'studio',
    engine: 'yue2',
    userId: who.userId,
    usedAt: { $exists: false },
    createdAt: { $gte: new Date(Date.now() - minutes * 60000) },
    ...(who.lane === 'text' ? { conversationId: spend.conversationOf(req) } : { lane: 'app-voice', agentId: String(agentId || '') }),
    ...(quoteId ? { quoteId: String(quoteId) } : {}),
  };
  const earlier = await c.findOne({ ...base, turnId: { $ne: tid } }, { sort: { createdAt: -1 } });
  if (earlier) return { q: earlier };
  const mine = await c.findOne({ ...base, turnId: tid });
  return { q: null, sameTurn: Boolean(mine) };
}

/**
 * Start the song a quote holds. Returns as soon as the booth has accepted the job.
 */
async function start({ req, agentId, agentName, quoteId }, deps = {}) {
  const env = deps.env || process.env;
  const who = actor(req, env);
  if (!who.ok) return { ok: false, error: WHY[who.why] || WHY.unavailable };
  if (who.lane === 'phone') return { ok: false, error: REFUSED.phone };
  if (who.lane === 'text' && !spend.conversationOf(req)) return { ok: false, error: REFUSED.newConversation };
  const tid = spend.turnId(req);
  const said = spend.latestWords(req.body && req.body.text);

  let found = await findQuote({ who, req, agentId, quoteId, tid }, deps);
  /* A wrong or stale id from the model: the newest open price here is the one they heard. */
  if (!found.q && quoteId) found = await findQuote({ who, req, agentId, quoteId: null, tid }, deps);
  if (!found.q) return { ok: false, error: found.sameTurn ? REFUSED.sameTurn : REFUSED.noQuote };
  const q = found.q;

  if (!said.ok) return { ok: false, error: REFUSED.noYes };
  if (spend.on('KADE_SPEND_NO_REPLAY', env) && spend.isReplay(req)) return { ok: false, error: REFUSED.replay };
  /* A free song has no amount that must be said, but the reply that offered it must have ended. */
  const heard = spend.priceWasSaid(q, env) || (q.free === true && q.heardAt !== undefined);
  if (!heard) return { ok: false, error: REFUSED.notSaid };
  if (!spend.approvesPrice(said.words, { names: [agentName], topic: spend.SONG_TOPIC })) return { ok: false, error: REFUSED.noYes };
  if (!spend.claimOnce(req, ONCE)) return { ok: false, error: REFUSED.oncePerTurn };

  const c = quotes(deps);
  const now = new Date();
  let claimed;
  try {
    claimed = unwrap(
      await c.findOneAndUpdate({ _id: q._id, usedAt: { $exists: false } }, { $set: { usedAt: now, usedTurnId: tid } }, { returnDocument: 'after' }),
    );
  } catch (e) {
    spend.releaseOnce(req, ONCE);
    throw e;
  }
  if (!claimed) return { ok: false, error: REFUSED.taken };
  /* One yes buys one song: other unanswered prices for a song here are closed with it. */
  await c
    .updateMany(
      { kind: 'studio', userId: who.userId, conversationId: q.conversationId, usedAt: { $exists: false }, turnId: { $ne: tid } },
      { $set: { usedAt: now, superseded: true } },
    )
    .catch(() => {});
  const giveBack = async () => {
    spend.releaseOnce(req, ONCE);
    await c.updateOne({ _id: q._id, usedTurnId: tid }, { $unset: { usedAt: 1, usedTurnId: 1 } }).catch(() => {});
  };

  let answer;
  try {
    answer = await booth(deps).render(who.userId, { ...q.body });
  } catch (e) {
    /* No answer at all: it is not known whether the booth took it. Never retried by itself. */
    return {
      ok: false,
      uncertain: true,
      error:
        'the Sound Booth did not answer, so it is not known whether the song started. Call status to find out before anything else. Do not start it again in this reply',
    };
  }
  const data = answer.data || {};
  if (answer.status === 200 && data.jobId && data.ok !== false) {
    const account = await accountOf(who.userId, deps).catch(() => null);
    const price = charge.priceFor(account, env, q.body.count);
    try {
      await charge.attach(
        { jobId: data.jobId, userId: who.userId, projectId: data.projectId, agentId, agentName, conversationId: q.conversationId, lane: who.lane, title: q.title },
        chargeDeps(deps),
      );
    } catch (e) {
      /* The song is running and paid for; only the message in this conversation is lost. */
      data.deliveryLost = true;
    }
    const where = who.lane === 'app-voice' ? 'in their chat with you' : 'in this conversation';
    return {
      ok: true,
      jobId: data.jobId,
      title: q.title,
      takes: q.body.count,
      charged: price.free ? 'nothing' : charge.sayCents(price.cents),
      tellThem:
        `The song is being made now. Say so in a sentence or two: it usually takes a few minutes, and when it is ready a message from you will say so ${where}` +
        (data.deliveryLost ? ' (if no message comes, it will be in their Sound Booth library)' : ', with a notification on their phone') +
        '. It plays from their Sound Booth library; on the website the message also has a play link. ' +
        (price.free
          ? ''
          : `${charge.sayCents(price.cents)} was taken from their balance, and ${price.perTake && price.takes > 1 ? 'each take that fails gets its share back' : 'it goes back if the song fails'}. `) +
        'Do not say it is finished, and do not wait for it.',
    };
  }
  const boothSays = String(data.error || 'it could not start the song').slice(0, 400);
  if (answer.status === 502 || data.jobId) {
    return { ok: false, uncertain: true, error: `the Sound Booth says: ${boothSays} Nothing was charged. Do not try again in this reply` };
  }
  /* A plain refusal before anything was sent (balance too low, a request already running, an input the booth will not take). */
  await giveBack();
  return { ok: false, lowBalance: answer.status === 402, error: `the Sound Booth says: ${boothSays}` };
}

/* ------------------------------------------------------- status, list, cancel */

function takeLinks(project) {
  const takes = Array.isArray(project && project.takes) ? project.takes : [];
  return takes
    .filter((t) => t && t.url)
    .slice(0, 4)
    .map((t, i) => ({ take: i + 1, url: t.url, seconds: t.seconds || null }));
}

const PHONE_ACCOUNT = 'songs cannot be looked up from a phone call. Ask them to ask you in the text chat, or to open the Sound Booth';

/** What went back to them for this song, in cents (all of it, or the takes that were not saved). */
function backCents(row) {
  if (!row) return 0;
  if (Number(row.refundedCents) > 0) return Number(row.refundedCents);
  return row.state === 'refunded' ? Number(row.cents) || 0 : 0;
}

async function status({ req, jobId }, deps = {}) {
  const who = actor(req, deps.env || process.env);
  if (!who.ok) return { ok: false, error: WHY[who.why] || WHY.unavailable };
  if (who.lane === 'phone') return { ok: false, error: PHONE_ACCOUNT };
  const row = jobId ? await charge.byJob(jobId, who.userId, chargeDeps(deps)) : await charge.latest(who.userId, chargeDeps(deps));
  const id = (row && row.jobId) || jobId;
  if (!id) return { ok: true, none: true, tellThem: 'They have no song in the making that was started here. Songs made on the Sound Booth page are in their library there.' };
  const s = await booth(deps).status(who.userId, id);
  if (!s.ok) return { ok: false, error: `the Sound Booth says: ${String((s.data && s.data.error) || 'it could not find that song').slice(0, 300)}` };
  const d = s.data || {};
  const out = { ok: true, jobId: id, title: (row && row.title) || '', state: d.state, takesReady: d.completed, takesAsked: d.total, boothSays: d.spoken };
  if (d.state === 'done' && d.projectId) {
    const p = await booth(deps).project(who.userId, d.projectId).catch(() => null);
    out.play = takeLinks(p && p.ok && p.data && p.data.project);
    out.tellThem = out.play.length
      ? 'It is ready and in their Sound Booth library, which is where it plays on the phone app. For the website, also give them the play link as a markdown link, [Play the song](url), exactly as given.'
      : 'It is ready and in their Sound Booth library.';
  }
  if (backCents(row)) out.refunded = charge.sayCents(backCents(row));
  return out;
}

async function list({ req }, deps = {}) {
  const who = actor(req, deps.env || process.env);
  if (!who.ok) return { ok: false, error: WHY[who.why] || WHY.unavailable };
  if (who.lane === 'phone') return { ok: false, error: PHONE_ACCOUNT };
  const r = await booth(deps).projects(who.userId);
  if (!r.ok) return { ok: false, error: 'the Sound Booth could not list their songs just now' };
  const songs = (Array.isArray(r.data && r.data.projects) ? r.data.projects : [])
    .filter((p) => p && p.engine === 'yue2')
    .slice(0, 8)
    .map((p) => ({ title: p.title, state: p.state, takes: Array.isArray(p.takes) ? p.takes.length : 0 }));
  return { ok: true, songs };
}

async function cancel({ req, jobId }, deps = {}) {
  const who = actor(req, deps.env || process.env);
  if (!who.ok) return { ok: false, error: WHY[who.why] || WHY.unavailable };
  if (who.lane === 'phone') return { ok: false, error: 'a song cannot be stopped from a phone call. Ask them to stop it in the text chat or on the Sound Booth page' };
  const row = jobId ? await charge.byJob(jobId, who.userId, chargeDeps(deps)) : await charge.latest(who.userId, chargeDeps(deps));
  const id = (row && row.jobId) || jobId;
  if (!id) return { ok: false, error: 'there is no song of theirs in the making to stop' };
  const r = await booth(deps).cancel(who.userId, id);
  if (!r.ok) return { ok: false, error: `the Sound Booth says: ${String((r.data && r.data.error) || 'it could not stop that song').slice(0, 300)}` };
  const after = await charge.byJob(id, who.userId, chargeDeps(deps)).catch(() => null);
  return {
    ok: true,
    jobId: id,
    boothSays: (r.data && r.data.spoken) || 'Stop requested.',
    refunded: backCents(after) ? charge.sayCents(backCents(after)) : null,
    tellThem:
      backCents(after)
        ? `It was stopped before it rendered, so the ${charge.sayCents(backCents(after))} went back to their balance.`
        : 'Stop requested. Finished takes are kept. If rendering had already begun, the charge stands.',
  };
}

/* ------------------------------------------------------------ the lyric desk */

/** "direction, then Lyrics:" as the desk hands it back, split into the two boxes. */
function splitDraft(script) {
  const text = String(script || '');
  const at = text.search(/^\s*lyrics\s*:/im);
  if (at === -1) return { direction: text.trim(), lyrics: '' };
  const rest = text.slice(at).replace(/^\s*lyrics\s*:[ \t]*/i, '');
  const stop = rest.search(/^\s*READBACK:/im);
  return { direction: text.slice(0, at).trim(), lyrics: (stop === -1 ? rest : rest.slice(0, stop)).trim() };
}

function draftResult(result) {
  const r = result || {};
  const parts = splitDraft(r.script);
  return {
    ok: true,
    state: 'done',
    title: r.title || '',
    direction: parts.direction,
    lyrics: parts.lyrics,
    note: r.problem || r.note || null,
    tellThem:
      'The draft is ready. Read the words back if they want to hear them. To change a line, change it yourself and keep the rest. ' +
      'When they are happy, call quote with this title, direction and the lyrics as they now stand.',
  };
}

const DESK_OFF =
  'the lyric desk is not used from a conversation. Write the words yourself, with them: ask what the song is about, write the lyrics with [Verse] and [Chorus] tags on their own lines, ' +
  'read them back, change what they ask, and when they are happy call quote with the title, the direction and the lyrics';

/**
 * May this turn use the booth's lyric desk? Off unless KADE_STUDIO_DRAFT=1, and then only for the
 * administrator's own conversation: a desk draft is charged to the person by the booth, and nobody
 * else may be charged without a price they heard and a yes.
 */
async function deskAllowed(who, deps) {
  const env = deps.env || process.env;
  if (!draftOn(env)) return false;
  const account = await accountOf(who.userId, deps).catch(() => null);
  return Boolean(account) && charge.priceFor(account, env).admin === true;
}

/** Ask the booth's lyric desk for a draft. It writes in the background; draft_read fetches it. */
async function draft({ req, agentId, idea, instrumental }, deps = {}) {
  const who = actor(req, deps.env || process.env);
  if (!who.ok) return { ok: false, error: WHY[who.why] || WHY.unavailable };
  if (who.lane === 'phone') return { ok: false, error: REFUSED.phone };
  if (!(await deskAllowed(who, deps))) return { ok: false, soft: true, error: DESK_OFF };
  const text = String(idea || '').trim();
  if (text.length < 3) return { ok: false, error: 'say what the song is about first (idea)' };
  const r = await booth(deps).script(who.userId, { engine: 'yue2', mode: 'write', text: text.slice(0, 6000), background: true, notify: false, ...(instrumental === true ? { instrumental: true } : {}) });
  const d = r.data || {};
  if (r.status === 202 && d.job) {
    await drafts(deps)
      .insertOne({ draftId: String(d.job), userId: who.userId, agentId: String(agentId || ''), createdAt: new Date() })
      .catch(() => {});
    return {
      ok: true,
      state: 'working',
      draftId: String(d.job),
      tellThem: 'The lyric desk is writing it. That takes a minute or more. Tell them so, and call draft_read when they ask for it; do not wait in this reply.',
    };
  }
  if (r.ok && typeof d.script === 'string') return draftResult(d);
  return { ok: false, error: `the Sound Booth says: ${String(d.error || 'the lyric desk could not take that').slice(0, 300)}` };
}

async function draftRead({ req, draftId }, deps = {}) {
  const who = actor(req, deps.env || process.env);
  if (!who.ok) return { ok: false, error: WHY[who.why] || WHY.unavailable };
  if (who.lane === 'phone') return { ok: false, error: REFUSED.phone };
  if (!(await deskAllowed(who, deps))) return { ok: false, soft: true, error: DESK_OFF };
  let id = draftId ? String(draftId) : '';
  if (!id) {
    const row = await drafts(deps).findOne({ userId: who.userId }, { sort: { createdAt: -1 } });
    id = row ? row.draftId : '';
  }
  if (!id) return { ok: false, error: 'there is no draft of theirs being written. Call draft with their idea first' };
  const r = await booth(deps).scriptJob(who.userId, id);
  const d = r.data || {};
  if (!r.ok) return { ok: false, error: `the Sound Booth says: ${String(d.error || 'that draft is gone').slice(0, 300)}` };
  if (d.state === 'working') return { ok: true, state: 'working', draftId: id, tellThem: 'Still writing. Tell them it needs a little longer.' };
  if (d.state === 'failed') return { ok: false, error: `the lyric desk says: ${String(d.error || 'the draft did not finish').slice(0, 300)}` };
  return { ...draftResult(d.result), draftId: id };
}

/* ------------------------------------------------------------------ delivery */

/**
 * The finished song comes back to the conversation that asked, as the character, with a push
 * that opens it. Called from the booth's notify hook, which the queue runs once per job; the
 * claim here makes that once hold across two servers as well. No model call.
 *
 * @param {{ job: { id: string, user: string, state: string }, title: string, completed: number, total: number, urls?: string[] | (() => Promise<string[]>) }} p
 *   urls may be a function: it is only called once the claim is won, so a booth-page song costs no lookup.
 * @returns {Promise<{ at: Date, accepted: number, blocked?: string } | null>} null = not a
 *   character's song (or already announced, or it could not be posted): the booth's own push runs.
 */
async function deliver({ job, title, completed, total, urls = [] }, deps = {}) {
  const env = deps.env || process.env;
  if (!deliverOn(env) || !job || !job.id) return null;
  /* A song they stopped themselves with nothing saved: they know. The booth's push says the rest. */
  if (!(completed > 0) && job.state === 'cancelled') return null;
  const cd = chargeDeps(deps);
  const row = await charge.claimDelivery(job.id, cd);
  if (!row || String(row.userId) !== String(job.user)) return null;
  const name = cleanTitle(title || row.title) || 'your song';
  let text;
  let pushText;
  if (completed > 0) {
    let found = [];
    try {
      found = typeof urls === 'function' ? await urls() : urls;
    } catch (_) {
      found = [];
    }
    const links = (Array.isArray(found) ? found : []).filter(Boolean).slice(0, 4);
    const first = links[0] ? ` [Play ${name}](${links[0]})` : '';
    const more = links
      .slice(1)
      .map((u, i) => ` [Play take ${i + 2}](${u})`)
      .join('');
    /* Review fix: the phone apps show a link as its label only and cannot open it, so the library
     * comes first and the links are said to be for the website. A signed link also runs out. */
    const back = backCents(row);
    text =
      `Your song "${name}" is ready. It is in your Sound Booth library: on the phone app, open the Sound Booth and then your library to play it.` +
      (total > 1 ? ` ${completed} of ${total} takes were saved.` : '') +
      (back ? ` The ${charge.sayCents(back)} for what was not saved went back to your balance.` : '') +
      (first ? ` On the website you can also play it from here:${first}${more} If a link here stops working, the song is still in your library.` : '');
    pushText = `Your song "${name}" is ready. It is in your Sound Booth library.`;
  } else {
    text =
      `Your song "${name}" did not finish, so there is nothing to play.` +
      (backCents(row) ? ` The ${charge.sayCents(backCents(row))} went back to your balance.` : '') +
      ' Ask me if you want to try it again.';
    pushText = `Your song "${name}" did not finish.`;
  }
  const turn = deps.turn || require('./kadeCharacterTurn');
  let placed;
  try {
    placed = await turn.post({ userId: row.userId, agentId: row.agentId, text, conversationId: row.conversationId || undefined, title: `Song: ${name}`, kind: 'song' });
  } catch (e) {
    await charge.noteDelivery(job.id, { error: String((e && e.message) || e).slice(0, 200) }, cd);
    return null;
  }
  let pushed = null;
  try {
    pushed = await turn.notifyPost({
      userId: row.userId,
      agentId: row.agentId,
      agentName: placed.agentName || row.agentName,
      text: pushText,
      conversationId: placed.conversationId,
      requested: true,
    });
  } catch (e) {
    pushed = { ok: false, error: String((e && e.message) || e) };
  }
  await charge.noteDelivery(job.id, { conversationId: placed.conversationId, messageId: placed.messageId, pushed: Boolean(pushed && pushed.ok !== false) }, cd);
  const accepted = Number(pushed && pushed.sent) || (pushed && pushed.ok ? 1 : 0);
  const blocked = pushed && (pushed.blocked || pushed.error);
  return { at: new Date(), accepted, deferred: Boolean(pushed && pushed.deferred), ...(blocked ? { blocked: String(blocked).slice(0, 160) } : {}) };
}

module.exports = {
  on,
  deliverOn,
  appVoiceOn,
  draftOn,
  actor,
  songBody,
  quote,
  start,
  status,
  list,
  cancel,
  draft,
  draftRead,
  splitDraft,
  deliver,
  REFUSED,
  DRAFTS,
};
