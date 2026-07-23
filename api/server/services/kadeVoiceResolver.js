/**
 * KADE July 17 2026 — UNIFIED VOICE RESOLVER (overnight proposal A, approved).
 *
 * ONE place that answers "what voice does this user hear for this agent?",
 * so the precedence chain can never drift between surfaces again (the July 16
 * "builder voice didn't take on the web call" bug was exactly this class:
 * kadeWebVoice.js and the bridge each re-implemented the chain).
 *
 * Precedence (same order the July 12 personal-picks feature defined):
 *   1. personal  — the user's own kadeVoicePref row for this agent
 *   2. builder   — agent.tts.voiceId (what the agent builder saved)
 *   3. name-match— a proxy voice alias equal to the agent's name (e.g. the
 *                  "Zadiana" voice for agent Zadiana). Only possible when the
 *                  proxy's /voices.json exposes an `aliases` list; skipped
 *                  silently otherwise.
 *   4. default   — env KADE_DEFAULT_VOICE, falling back to the platform
 *                  default the bridge has always used.
 *
 * Every candidate is validated against the LIVE catalog (voiceCatalog.js,
 * last-known-good semantics): a numbered label ("Voice N") that the live list
 * doesn't know is rejected and the chain moves on. Non-numbered labels
 * (legacy named aliases) are only rejected when the catalog explicitly
 * publishes an alias list that doesn't contain them — the proxy resolves
 * names at synth time, so unknown-shape labels pass through (fail-soft).
 *
 * Consumers: GET /api/kade/resolve-voice (bridge, server-to-server) and
 * kadeWebVoice.js's ticket mint (in-process). Both keep their old chains as
 * fallbacks — this module being unreachable must never break a call.
 */
const { logger } = require('@librechat/data-schemas');
const db = require('~/models');
const { getUserVoicePref } = require('~/models/kadeVoicePref');
const { fetchLiveVoices } = require('~/server/services/Files/Audio/voiceCatalog');

const DEFAULT_VOICE = process.env.KADE_DEFAULT_VOICE || 'Kiana (Comedian)';
const PROXY_URL = (
  process.env.KADE_TTS_PROXY_URL || 'https://inworld-tts-proxy-production.up.railway.app'
).replace(/\/$/, '');

/** Aliases (named voice labels) — separate 5-min cache; /voices.json may not
 * expose them yet (proxy-side addition rides the catalog-integrity commit). */
let _aliasCache = { at: 0, aliases: null, hidden: null };
async function fetchAliases() {
  try {
    if (_aliasCache.aliases && Date.now() - _aliasCache.at < 5 * 60 * 1000) {
      return _aliasCache;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const r = await fetch(`${PROXY_URL}/voices.json`, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    });
    clearTimeout(timer);
    if (!r.ok) return _aliasCache;
    const d = await r.json();
    if (Array.isArray(d?.aliases)) {
      // `hidden` (July 23 2026): old picker spellings — the graduated
      // beta-era labels — still resolvable at synth, never shown in pickers.
      _aliasCache = {
        at: Date.now(),
        aliases: d.aliases,
        hidden: Array.isArray(d?.hidden) ? d.hidden : null,
      };
    }
    return _aliasCache;
  } catch {
    return _aliasCache;
  }
}

/**
 * A label is INVALID only when we positively know better:
 *  - "Voice N" not present in the live numbered list, or
 *  - a named label when the proxy publishes aliases and it isn't one of them.
 * No catalog reachable -> everything passes (current pre-resolver behavior).
 */
function isValidLabel(label, liveVoices, aliases, hidden) {
  if (!label) return false;
  const l = String(label);
  const inHidden = Array.isArray(hidden) && hidden.includes(l);
  // KADE July 23 2026, two fixes in one:
  // (1) the numbered test is now SUFFIX-TOLERANT (\b instead of $). Display
  //     labels like "Voice 434 (Beta)" / "Voice 327 Kade calm and casual"
  //     failed the old exact ^Voice \d+$ match, fell into the named-label
  //     branch, missed the aliases list (which only has legacy NAMES), and
  //     got REJECTED — so every agent cast onto a suffixed voice was silently
  //     losing its builder voice on the call lane and falling to
  //     name-match/default. Found July 23 while graduating the beta labels;
  //     it had been live since the fish wave shipped.
  // (2) `hidden` — old spellings the proxy still resolves — validate too, so
  //     stored beta-era picks keep working forever after the rename.
  if (/^Voice \d+\b/i.test(l)) {
    return !Array.isArray(liveVoices) || liveVoices.includes(l) || inHidden;
  }
  return !Array.isArray(aliases) || aliases.includes(l) || inHidden;
}

/**
 * @param {Object} p
 * @param {string} [p.userId]  resolved LibreChat user id (personal-pick lookup)
 * @param {string} p.agentId
 * @param {Object} [p.agent]   preloaded agent record (skips the DB fetch)
 * @param {string} [p.surface] 'web' | 'phone' | … (logging only)
 * @returns {Promise<{voice: string, source: string, rate: number|null, agentName: string|null}>}
 */
async function resolveVoice({ userId, agentId, agent, surface }) {
  let a = agent || null;
  if (!a && agentId) {
    try {
      a = await db.getAgent({ id: String(agentId) });
    } catch (err) {
      logger.warn('[kadeVoiceResolver] agent fetch failed: ' + err.message);
    }
  }
  const agentName = (a && a.name) || null;
  const r = a && a.tts && Number(a.tts.speakingRate);
  const rate = Number.isFinite(r) && r > 0 ? r : null;

  let liveVoices = null;
  let aliases = null;
  let hidden = null;
  try {
    liveVoices = await fetchLiveVoices(`${PROXY_URL}/v1/audio/speech`);
    const aliasInfo = await fetchAliases();
    aliases = aliasInfo && aliasInfo.aliases;
    hidden = aliasInfo && aliasInfo.hidden;
  } catch { /* validation degrades to pass-through */ }

  /* 1. personal */
  if (userId && agentId) {
    try {
      const personal = await getUserVoicePref(String(userId), String(agentId));
      if (personal && isValidLabel(personal, liveVoices, aliases, hidden)) {
        return { voice: personal, source: 'personal', rate, agentName };
      }
      if (personal) {
        logger.warn(
          `[kadeVoiceResolver] personal pick "${personal}" not in live catalog — skipping (user ${userId}, agent ${agentId}, surface ${surface || '?'})`,
        );
      }
    } catch (err) {
      logger.warn('[kadeVoiceResolver] personal lookup failed: ' + err.message);
    }
  }

  /* 2. builder */
  const builder = (a && a.tts && a.tts.voiceId) || null;
  if (builder && isValidLabel(builder, liveVoices, aliases, hidden)) {
    return { voice: builder, source: 'builder', rate, agentName };
  }
  if (builder) {
    logger.warn(
      `[kadeVoiceResolver] builder voice "${builder}" not in live catalog — skipping (agent ${agentId})`,
    );
  }

  /* 3. name-match (needs the proxy's alias list) */
  if (agentName && Array.isArray(aliases)) {
    const n = agentName.toLowerCase().trim();
    const hit =
      aliases.find((al) => al.toLowerCase() === n) ||
      aliases.find((al) => al.toLowerCase().includes(n)) ||
      null;
    if (hit) {
      return { voice: hit, source: 'name-match', rate, agentName };
    }
  }

  /* 4. platform default */
  return { voice: DEFAULT_VOICE, source: 'default', rate, agentName };
}

module.exports = { resolveVoice, isValidLabel };
