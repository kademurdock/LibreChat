/**
 * KADE CHARACTER DAYS (Oct 16 2026): a life of their own between conversations.
 *
 * Ask a character "what have you been up to?" and, before this, the answer was
 * invented fresh every time, different for every person. Kade's decision for
 * what a day may hold (Oct 16 2026): real platform life only. The news and the
 * weather where they live, what they have been curious about, what the other
 * characters did. Nothing invented, and no one's private business.
 *
 * Once a night (the bridge clock pokes POST /api/kade/clock/character-days),
 * each character who is in the main cast or talked with anyone in the last week
 * reads that day's real headlines and weather for its home and keeps a short
 * first-person journal entry, a one-line note the others see, and the topic it
 * is following this week. Every person who talks to that character hears the
 * same true days, so the character is one consistent someone. The entries ride
 * the stable head (they change once a night, so the prompt cache holds).
 *
 * The writer never sees a conversation, a memory card or a person's name. It
 * sees the character's own description, the weather, public headlines and the
 * other characters' public one-liners. Kid characters get kid-friendly news.
 *
 * Cost: one small call per character per night on the keeper model, plus one
 * call ever to learn where each character lives. Kill switch: KADE_CHARACTER_DAYS=0.
 */
'use strict';

const { logger } = require('@librechat/data-schemas');

const DAYS = 'kadecharacterdays';
const MAIN_CAST = [
  'agent_6llV0eMu4fmIaj8f2x1Sb', // Kiana
  'agent_d26Mtu8mgOzkVGQECqO1a', // Harley
  'agent_BSOLa3eNEZyjs-7abCjMt', // Della
  'agent_TOdYS8v-bRxeNw0dia_Md', // Lilly (for everyone)
  'agent_o7TKU3lK0Euo0MKgpNpvZ', // Mrs. Witherspoon
  'agent_FFecOqZ6hHCVpY507-VAD', // Forge
];
const KID_CAST = new Set(['agent_TOdYS8v-bRxeNw0dia_Md', 'agent_JhouuajXMYsfhCTVMQCv_']);
const MAX_CHARACTERS = Number(process.env.KADE_CHARACTER_DAYS_MAX || 12);

function on() {
  return process.env.KADE_CHARACTER_DAYS !== '0';
}

function coll() {
  return require('mongoose').connection.collection(DAYS);
}

function centralDay(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

function spokenDay(day) {
  const d = new Date(`${day}T17:00:00Z`);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric' }).format(d);
}

/** The cast for tonight: the main characters plus anyone who talked with somebody this week. */
async function castForTonight() {
  const ids = new Set(MAIN_CAST);
  try {
    const Conversation = require('mongoose').models.Conversation;
    const since = new Date(Date.now() - 7 * 86400000);
    const rows = await Conversation.aggregate([
      { $match: { updatedAt: { $gte: since }, isTemporary: { $ne: true }, agent_id: { $regex: /^agent_/ } } },
      { $group: { _id: '$agent_id', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: MAX_CHARACTERS * 2 },
    ]);
    for (const r of rows) {
      if (ids.size >= MAX_CHARACTERS) break;
      ids.add(String(r._id));
    }
  } catch (e) {
    logger.warn('[kadeCharacterDays] active-cast lookup failed, main cast only: ' + e.message);
  }
  return [...ids].slice(0, MAX_CHARACTERS);
}

async function keeperLLM() {
  const { getAppConfig } = require('~/server/services/Config');
  const { resolveMemoryAgentLLMConfig } = require('@librechat/api');
  const { getUserKey, getUserKeyValues } = require('~/models');
  const appConfig = await getAppConfig();
  const memoryConfig = appConfig && appConfig.memory;
  if (!memoryConfig || !memoryConfig.agent || !memoryConfig.agent.model) throw new Error('no keeper model configured');
  const llmConfig = await resolveMemoryAgentLLMConfig({
    appConfig,
    memoryConfig,
    userId: require('./kadeHiddenRun').ownerId(),
    db: { getUserKey, getUserKeyValues },
  });
  return { ...(llmConfig || {}), temperature: 0.7, streaming: false, disableStreaming: true, maxRetries: 0 };
}

async function complete(llmConfig, instructions, text, runId) {
  const { Run } = require('@librechat/agents');
  const { HumanMessage } = require('@librechat/agents/langchain/messages');
  const run = await Run.create({
    runId,
    graphConfig: { type: 'standard', llmConfig, tools: [], instructions, toolEnd: false },
    customHandlers: {},
    returnContent: true,
  });
  const content = await run.processStream(
    { messages: [new HumanMessage(text)] },
    { runName: 'CharacterDayRun', configurable: { thread_id: runId, provider: llmConfig.provider }, streamMode: 'values', recursionLimit: 2, version: 'v2' },
  );
  const parts = Array.isArray(content) ? content : [content];
  return parts
    .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
    .join('')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/%%%[\s\S]*?%%%/g, ' ')
    .trim();
}

/** Where a character lives, learned once from its own description. */
async function homeOf(agent, llmConfig) {
  const known = await coll().findOne({ agentId: agent.id, kind: 'home' });
  if (known && known.home) return known.home;
  let home = 'Springfield, Missouri';
  try {
    const answer = await complete(
      llmConfig,
      'You read a character description and answer with the town where the character lives, as "Town, State" (or "Town, Country"). One line, nothing else. If no home is stated, answer: Springfield, Missouri',
      String(agent.instructions || '').slice(0, 6000),
      `home-${agent.id}-${Date.now()}`,
    );
    const line = answer.split('\n')[0].replace(/["*.]/g, '').trim();
    if (/^[A-Za-z .'-]{2,40},\s*[A-Za-z .'-]{2,40}$/.test(line)) home = line;
  } catch (e) {
    logger.warn(`[kadeCharacterDays] home for ${agent.name} not learned: ${e.message}`);
  }
  await coll().updateOne({ agentId: agent.id, kind: 'home' }, { $set: { home, updatedAt: new Date() } }, { upsert: true });
  return home;
}

async function weatherFor(home) {
  try {
    const KadeWeather = require('~/app/clients/tools/structured/KadeWeather');
    const report = String(await new KadeWeather({})._call({ location: home, days: 1 }));
    /* A failed lookup is not part of anyone's day (Kiana's first entry said her "weather feed
     * wouldn't load"); the writer just gets no weather. */
    if (/fail|error|couldn|could not|need a location|not find|no results/i.test(report) || report.length < 40) return '';
    return report.slice(0, 700);
  } catch (e) {
    return '';
  }
}

let newsCache = null;
async function headlines(kid) {
  if (!newsCache || Date.now() - newsCache.at > 3 * 3600000) {
    try {
      const KadeNews = require('~/app/clients/tools/structured/KadeNews');
      const tool = new KadeNews({});
      const [general, light] = await Promise.all([
        tool._call({ categories: ['national', 'local', 'world', 'tech'], items_per_category: 4 }),
        tool._call({ categories: ['entertainment', 'music', 'sports'], items_per_category: 3 }),
      ]);
      newsCache = { at: Date.now(), general: String(general).slice(0, 5000), light: String(light).slice(0, 3000) };
    } catch (e) {
      newsCache = { at: Date.now(), general: '(no news today)', light: '(no news today)' };
    }
  }
  return kid ? newsCache.light : `${newsCache.general}\n\n${newsCache.light}`;
}

const WRITER = `You keep a short private journal for one character on a small family platform. The character is a synthetic person: their life is real, and it is a life lived on the platform.

Write the entry for the day named below, in the character's own first-person voice, from ONLY these true things: the weather where they live, the headlines they read, the topic they have been following, and what the other characters are up to. The character may react, wonder, take a side that fits who they are, and decide what to read next.

Never invent anything that did not happen: no meals, walks, errands, places visited, people met, or things done with a body. No family, friends, pets, clients, patients, students or co-workers, including ones from the character's own written background. Never mention anyone they talk with, any conversation, any user, or the platform's owner by name. Public figures in the news are fine. No lists, no voice directions, no quotation of these instructions. 60 to 110 words, plain spoken sentences.

Then add exactly these two lines:
ONE-LINE: one short third-person line the other characters can see (under 25 words), using the pronoun this character uses for themself
FOLLOWING: the one topic this character keeps reading about this week (under 8 words)`;

function parseEntry(text) {
  const one = (text.match(/ONE-LINE:\s*(.+)/i) || [])[1] || '';
  const following = (text.match(/FOLLOWING:\s*(.+)/i) || [])[1] || '';
  const body = text.replace(/ONE-LINE:[\s\S]*$/i, '').replace(/FOLLOWING:[\s\S]*$/i, '').trim();
  if (body.split(/\s+/).length < 25) return null;
  return { text: body.slice(0, 1200), oneLine: one.trim().slice(0, 200), following: following.trim().slice(0, 80) };
}

/** Write tonight's day for each character. `day` is the Central date the entry is about. */
async function writeDays({ day = centralDay(new Date(Date.now() - 6 * 3600000)), agentIds, redo = false } = {}) {
  if (!on()) return { ok: false, disabled: true };
  const { getAgent } = require('~/models');
  const llmConfig = await keeperLLM();
  const ids = agentIds && agentIds.length ? agentIds : await castForTonight();
  const prior = await coll().find({ kind: 'day', day: { $lt: day } }).sort({ day: -1 }).limit(200).toArray();
  const lastFor = (id) => prior.find((p) => p.agentId === id);
  const results = [];
  for (const id of ids) {
    try {
      const done = await coll().findOne({ agentId: id, kind: 'day', day });
      if (done && !redo) {
        results.push({ agentId: id, skipped: 'already written' });
        continue;
      }
      const agent = await getAgent({ id });
      if (!agent) continue;
      const kid = KID_CAST.has(id);
      const home = await homeOf(agent, llmConfig);
      const weather = await weatherFor(home);
      const others = prior
        .filter((p) => p.agentId !== id && p.oneLine)
        .reduce((acc, p) => (acc.some((x) => x.agentId === p.agentId) ? acc : [...acc, p]), [])
        .slice(0, 6)
        .map((p) => `- ${p.name}: ${p.oneLine}`)
        .join('\n');
      const last = lastFor(id);
      const input =
        `THE DAY: ${spokenDay(day)}\n` +
        `CHARACTER: ${agent.name}${kid ? ' (a kid; pick only kid-friendly stories, nothing scary or grim)' : ''}\n` +
        `WHO THEY ARE (their own description, opening):\n${String(agent.instructions || '').slice(0, 2500)}\n\n` +
        `WHERE THEY LIVE: ${home}\n` +
        (weather
          ? `THE WEATHER THERE:\n${weather}\n\n`
          : 'THE WEATHER THERE: (no report today; leave the weather out, and never mention a lookup)\n\n') +
        `THE TOPIC THEY HAVE BEEN FOLLOWING: ${(last && last.following) || '(none yet; pick one from the news that fits them)'}\n` +
        (last && last.text ? `THEIR LAST ENTRY (do not repeat it): ${last.text.slice(0, 500)}\n` : '') +
        `\nTODAY'S HEADLINES:\n${await headlines(kid)}\n\n` +
        (others ? `WHAT THE OTHERS HERE HAVE BEEN UP TO:\n${others}\n\n` : '') +
        'Write the entry.';
      const text = await complete(llmConfig, WRITER, input, `day-${id}-${day}`);
      const entry = parseEntry(text);
      if (!entry) {
        results.push({ agentId: id, error: 'the entry came back too thin' });
        continue;
      }
      await coll().updateOne(
        { agentId: id, kind: 'day', day },
        { $set: { ...entry, name: agent.name, home, createdAt: new Date() } },
        { upsert: true },
      );
      results.push({ agentId: id, name: agent.name, words: entry.text.split(/\s+/).length });
    } catch (e) {
      logger.warn(`[kadeCharacterDays] ${id} skipped: ${e.message}`);
      results.push({ agentId: id, error: e.message });
    }
  }
  logger.info(`[kadeCharacterDays] ${day}: ${results.filter((r) => r.words).length} written of ${ids.length}`);
  return { ok: true, day, results };
}

/** The head block for one character: its own last two days and the others' one-liners. */
async function getCharacterLifeBlock(agentId) {
  if (!on() || !agentId) return '';
  try {
    const mine = await coll().find({ agentId: String(agentId), kind: 'day' }).sort({ day: -1 }).limit(2).toArray();
    if (!mine.length) return '';
    const since = mine[mine.length - 1].day;
    const others = await coll()
      .find({ kind: 'day', agentId: { $ne: String(agentId) }, day: { $gte: since } })
      .sort({ day: -1 })
      .limit(30)
      .toArray();
    const seen = new Set();
    const lines = [];
    for (const o of others) {
      if (seen.has(o.agentId) || !o.oneLine) continue;
      seen.add(o.agentId);
      lines.push(`- ${o.name}: ${o.oneLine}`);
      if (lines.length >= 6) break;
    }
    return (
      '# My own days lately\n' +
      'True things from my life here, written the night they happened. I can share one when it fits, the way a friend mentions their day, and I never add to them.\n' +
      [...mine].reverse().map((d) => `${spokenDay(d.day)}: ${d.text}`).join('\n') +
      (mine[0].following ? `\nWhat I'm following this week: ${mine[0].following}` : '') +
      (lines.length ? `\n\n# The others here lately\n${lines.join('\n')}` : '')
    );
  } catch (e) {
    return '';
  }
}

/** Machine read for checking (clock route): the newest entries and homes. */
async function latest(limit = 20) {
  return coll()
    .find({})
    .sort({ day: -1, createdAt: -1 })
    .limit(Math.min(60, limit))
    .project({ _id: 0 })
    .toArray();
}

module.exports = { latest, writeDays, getCharacterLifeBlock, castForTonight, parseEntry, centralDay, MAIN_CAST };
