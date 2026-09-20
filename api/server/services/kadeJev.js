'use strict';
/* Part 236 (Sep 20 2026). Jev is TypeSafe's decision model: it takes state
 * plus typed questions (choice / noul) and returns probabilities, no prose.
 * It never writes a word anybody reads or hears. The gateway got it first
 * (reframe-proxy/jev.js), then the bridge (kade-ai-bridge/jev.js); this is
 * the fork's copy, same shape, same contract. The judges that use it live
 * next door in kadeJevJudges.js.
 *
 * THE CONTRACT, and every caller in this repo keeps it: Jev is a first
 * opinion, never the only road. ask() THROWS on any failure (no key, killed,
 * HTTP error, timeout, malformed answer) and the caller falls back to exactly
 * what it did before Jev existed. A Jev verdict alone never deletes anything,
 * never hides content from someone, never sends anything.
 *
 * Jev is weak at counting, numbers and dates, so nothing here asks it to
 * count. The version is pinned; jev-latest moves under you.
 *
 * No dependencies on purpose (global fetch, Node 24 in the Dockerfile), so the
 * trial scripts and the node:test file can load it without the app.
 *
 * Kill: KADE_JEV=0, or unset TYPESAFE_API_KEY (unset = nothing changes at
 * all). Per feature: KADE_JEV_LIBRARY, KADE_JEV_KEEPER_SHADOW,
 * KADE_JEV_TOOLS_SHADOW (=0 turns that one off). All read per call, so a
 * kill switch never needs a restart to be believed. */
const URL = process.env.KADE_JEV_URL || 'https://api.typesafe.ai/v1/systemone';
const MODEL = process.env.KADE_JEV_MODEL || 'jev-1.13.0';
const counts = { ok: 0, failed: 0 };
let lastError = null;

function key() {
  return process.env.TYPESAFE_API_KEY || '';
}

function enabled(flag) {
  return !!key() && process.env.KADE_JEV !== '0' && (!flag || process.env[flag] !== '0');
}

async function ask(state, questions, timeoutMs = 1500) {
  if (!enabled()) throw new Error('jev disabled');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        Authorization: `Bearer ${key()}`,
        'Content-Type': 'application/json',
        'User-Agent': 'kade-ai-librechat/1.0',
      },
      body: JSON.stringify({ state, model: MODEL, questions }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j || !j.answers || typeof j.answers !== 'object') throw new Error('no answers');
    counts.ok++;
    return { answers: j.answers, usage: j.usage || null, model: j.model || MODEL };
  } catch (e) {
    counts.failed++;
    lastError = e && e.name === 'AbortError' ? `timeout ${timeoutMs}ms` : String((e && e.message) || e);
    throw new Error(lastError);
  } finally {
    clearTimeout(timer);
  }
}

function noulOf(answers, id) {
  const p = answers && answers[id] && answers[id].noul;
  if (typeof p !== 'number' || !(p >= 0 && p <= 1)) throw new Error(`bad ${id} answer`);
  return p;
}

/** For a status route: is it on, which switches, how it has been doing. Never the key. */
function health() {
  return {
    configured: !!key(),
    model: MODEL,
    on: enabled(),
    library: enabled('KADE_JEV_LIBRARY'),
    keeperShadow: enabled('KADE_JEV_KEEPER_SHADOW'),
    toolsShadow: enabled('KADE_JEV_TOOLS_SHADOW'),
    ok: counts.ok,
    failed: counts.failed,
    lastError,
  };
}

module.exports = { enabled, ask, noulOf, health, counts, MODEL };
