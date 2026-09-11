'use strict';
/* ----------------------------------------------------------------------------
 * THE LIBRARIAN, and "what just happened?" (Part 181 continued, Sep 11 2026)
 *
 * Her words: "a cheap flash model being a librarian of sorts and keeping
 * track of media … if I upload a children's cassette called laugh and play,
 * she could look that up … doesn't have to be presented as total fact … any
 * interesting info the librarian could dig up." And: "we're fifty minutes in
 * … a button that will kinda pause the movie and explain the past however
 * many minutes visually, so if you had questions you could ask."
 *
 * Three small things:
 *   librarianNotes(item)  — two or three web searches (Tavily, the key the
 *                           chat's search tool already uses) about the title,
 *                           maker and year, then a cheap model writes a short
 *                           note in the voice of a librarian who is clear
 *                           about what is known and what is a guess. Sources
 *                           are kept. Costs about a cent.
 *   recap(range)          — the describe pipeline over the last N minutes
 *                           only, returned as scenes + a summary, cached on
 *                           the track (last five ranges).
 *   ask(question)         — the model answers from the recap text, the full
 *                           description if there is one, and the librarian's
 *                           notes. Nothing else; it says so when it does not
 *                           know.
 * Model: KADE_LIBRARIAN_MODEL (default google/gemini-3.1-flash-lite) through
 * OpenRouter. Kill: KADE_LIBRARIAN=0.
 * -------------------------------------------------------------------------- */
const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { logKadeUsage } = require('~/models/kadeUsage');

const MODEL = () => process.env.KADE_LIBRARIAN_MODEL || 'google/gemini-3.1-flash-lite';
const ENABLED = () => process.env.KADE_LIBRARIAN !== '0';
const IN_USD_PER_M = () => Number(process.env.KADE_DESCRIBE_IN_USD_PER_M || 0.1);
const OUT_USD_PER_M = () => Number(process.env.KADE_DESCRIBE_OUT_USD_PER_M || 0.4);

async function chat(messages, maxTokens = 900, json = false) {
  const key = process.env.OPENROUTER_KEY;
  if (!key) throw new Error('OPENROUTER_KEY not configured');
  const r = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    { model: MODEL(), max_tokens: maxTokens, messages, usage: { include: true }, ...(json ? { response_format: { type: 'json_object' } } : {}) },
    { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 120000 },
  );
  const text = r.data?.choices?.[0]?.message?.content;
  const usage = r.data?.usage || {};
  const est = ((Number(usage.prompt_tokens) || 0) * IN_USD_PER_M() + (Number(usage.completion_tokens) || 0) * OUT_USD_PER_M()) / 1e6;
  return { text: typeof text === 'string' ? text.trim() : '', costUSD: typeof usage.cost === 'number' && usage.cost >= 0 ? usage.cost : est };
}

async function tavily(query, maxResults = 5) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return { results: [], answer: '' };
  try {
    const r = await axios.post('https://api.tavily.com/search', { api_key: key, query, max_results: maxResults, include_answer: true, search_depth: 'basic' }, { timeout: 30000 });
    return { results: (r.data?.results || []).map((x) => ({ title: x.title, url: x.url, content: String(x.content || '').slice(0, 800) })), answer: r.data?.answer || '' };
  } catch (e) {
    logger.warn(`[librarian] search failed for "${query}": ${e.message}`);
    return { results: [], answer: '' };
  }
}

/** Web-dug notes about an item: what it is, who made it, when, anything fun. */
async function librarianNotes(item) {
  if (!ENABLED()) throw new Error('The librarian is switched off on this server.');
  const bits = [item.title, item.author, item.copyrightYear, item.meta && (item.meta.network || item.meta.cableChannel || item.meta.callSign || item.meta.brand)].filter(Boolean);
  const kindWord = item.kind === 'text' ? 'book' : item.category === 'cassette' ? 'audio cassette' : item.category === 'commercials' ? 'television commercial' : item.category === 'tv' ? 'television recording' : item.category === 'radio' ? 'radio recording' : item.category === 'vhs' ? 'home video / VHS tape' : item.category === 'movie' ? 'film' : (item.kind === 'video' ? 'video' : 'recording');
  const queries = [`${bits.join(' ')} ${kindWord}`, `"${item.title}" ${item.author || ''} ${item.copyrightYear || ''}`.trim()];
  if (item.category === 'cassette' || item.category === 'audiobook' || item.kind === 'text') queries.push(`${item.title} ${item.author || ''} release history label`);
  const searches = [];
  let searchCount = 0;
  for (const q of queries.slice(0, 3)) {
    const r = await tavily(q, 5);
    searchCount++;
    searches.push({ q, ...r });
  }
  const evidence = searches.map((s) => `SEARCH: ${s.q}\n${s.answer ? 'summary: ' + s.answer + '\n' : ''}${s.results.map((x) => `- ${x.title} (${x.url}): ${x.content}`).join('\n')}`).join('\n\n').slice(0, 14000);
  const prompt = `You are the librarian of a small family media library. A ${kindWord} was just added:\n` +
    `title: ${item.title}\n${item.author ? 'maker/author/channel: ' + item.author + '\n' : ''}${item.copyrightYear ? 'year on the file: ' + item.copyrightYear + '\n' : ''}${item.path ? 'filed under: ' + item.path + '\n' : ''}${item.description ? 'donor says: ' + item.description + '\n' : ''}${item.synopsis && item.synopsis !== item.description ? 'synopsis: ' + item.synopsis.slice(0, 600) + '\n' : ''}` +
    `\nHere is what a web search turned up (may be irrelevant or about something else with a similar name):\n${evidence || '(nothing)'}\n\n` +
    `Write the librarian's note for people browsing: 3 to 8 short sentences, spoken aloud to a blind listener, about what this is, who made it, when it came out, what it was part of (a series, a label, a station, a campaign), and anything genuinely interesting (packaging, a toy it came with, a jingle's history, an actor). Be honest about certainty: say "this looks like", "probably", or "I could not find much" when that is the truth, and never invent specifics. If the search results are clearly about something else, say the title is a common one and give only what can be said safely. Do not start with "This".\n` +
    `Answer ONLY with JSON: {"note": "...", "confidence": "high|medium|low", "identified": "what you think it is, in one line, or empty"}`;
  const r = await chat([{ role: 'user', content: prompt }], 700, true);
  let j = null;
  try { j = JSON.parse(r.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch (_) { j = { note: r.text.slice(0, 1500), confidence: 'low', identified: '' }; }
  const sources = searches.flatMap((s) => s.results.slice(0, 3).map((x) => ({ title: x.title, url: x.url }))).slice(0, 8);
  return { note: String(j.note || '').slice(0, 2000), confidence: String(j.confidence || 'low'), identified: String(j.identified || '').slice(0, 200), sources, model: MODEL(), costUSD: r.costUSD + searchCount * 0.008, searches: searchCount, at: new Date() };
}

/** A question about what has been happening, answered from what the library knows. */
async function ask({ item, track, question, recap, fromSeconds, toSeconds }) {
  if (!ENABLED()) throw new Error('The librarian is switched off on this server.');
  const d = track && track.description && track.description.state === 'done' ? track.description : null;
  const clock = (s) => { const t = Math.floor(s || 0); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`; };
  const context = [];
  if (item.librarian && item.librarian.note) context.push(`LIBRARIAN'S NOTE about the whole item: ${item.librarian.note}`);
  if (recap) context.push(`WHAT WAS ON SCREEN from ${clock(fromSeconds)} to ${clock(toSeconds)} (audio description, most recent):\n${recap.summary}\n` + recap.scenes.map((s) => `${clock(s.t)}: ${s.text}`).join('\n'));
  if (d) context.push(`FULL AUDIO DESCRIPTION of the whole ${item.kind} (${d.scenes.length} scenes):\n${d.summary}\n` + d.scenes.filter((s) => toSeconds ? s.t <= toSeconds + 5 : true).map((s) => `${clock(s.t)}: ${s.text}`).join('\n').slice(0, 12000));
  if (!context.length) throw new Error('Nothing to answer from yet — press "What just happened?" or "Describe this video" first.');
  const prompt = `You are helping a blind viewer who is ${toSeconds ? clock(toSeconds) + ' into' : 'watching'} "${item.title}"${item.author ? ' (' + item.author + ')' : ''}. Answer their question in two to five spoken sentences using ONLY the notes below. If the notes do not say, say you cannot tell from what was described. Do not reveal anything from later in the video than where they are.\n\n${context.join('\n\n')}\n\nQUESTION: ${String(question).slice(0, 500)}`;
  const r = await chat([{ role: 'user', content: prompt }], 400);
  return { answer: r.text, costUSD: r.costUSD, model: MODEL() };
}

module.exports = { librarianNotes, ask, ENABLED, MODEL };
