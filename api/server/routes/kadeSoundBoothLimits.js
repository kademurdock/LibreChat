'use strict';
/* The Sound Booth's character limits, in one place (Nov 17 2026). kadeSoundBooth.js checks text against
 * these, and /health hands the same numbers to the page inside the guide (withTextLimits), so the
 * maxlength on a box and the server's refusal can never drift apart.
 *
 * The YuE2, ACE-Step XL and Stable Audio routes check their own limits in packages/api (yue.ts, ace.ts,
 * audio/effects.ts). Those are mirrored here; kadeSoundBoothLimits.nodetest.js reads those sources and
 * fails if a number there changes without this file. */
const { MAX_TEXT: WORDS_MAX } = require('./kadeSoundBoothWords');
const { MAX_DESCRIPTION: FIX_DESCRIPTION_MAX } = require('./kadeSoundBoothTasks');

const LIMITS = Object.freeze({
  scenemaPart: 4000, // AuK HQ: the bridge's cap on one part's prompt (scenema.js MAX_PROMPT); also its edit instruction
  seed: 2048, // Seed Audio's hard cap per clip; a longer script is cut to fit (fitSeed)
  lyriaBrief: 3000, // Lyria's brief, not its lyrics (checkMusic counts a Lyrics: part under the brief as lyrics)
  lyriaLyrics: 8000,
  musicDirection: 3000, // yue.ts, ace.ts and effects.ts refuse a direction over 3000
  yueLyrics: 8000, // yue.ts
  yueAbc: 40000, // yue.ts
  aceLyrics: 4096, // ace.ts LYRICS_LIMIT (it counts code points, so maxlength is never looser)
  aceCaption: 512, // ace.ts CAPTION_LIMIT: ACE reads about this much of the direction; the rest is trimmed at a word
  desk: 6000, // the script desk (/script) reads at most this much of her text
  aukVoice: 600, // Describe a new voice: anything longer is cut
  wordsText: WORDS_MAX, // Change words: each box
  fixDescription: FIX_DESCRIPTION_MAX, // Clean up or change, New voice
});

/* The script box (Performance script, Music direction, Sound description) per engine. AuK HQ speech has
 * no single number: a long script is made in parts of 4,000 characters of engine code each, so the page
 * shows a count and no limit. cut: the server cuts a longer one instead of refusing it. lyricsApart: the
 * server measures only the brief above a "Lyrics:" heading (checkMusic), so the page does too, with no maxlength.
 * reads: the engine reads only this much, though the route takes up to max. */
const SCRIPT_MAX = {
  seed: { max: LIMITS.seed, cut: true },
  lyria: { max: LIMITS.lyriaBrief, lyricsApart: true },
  yue2: { max: LIMITS.musicDirection },
  ace: { max: LIMITS.musicDirection, reads: LIMITS.aceCaption },
  stable: { max: LIMITS.musicDirection },
};

/* Typed settings per engine and key. */
const SETTING_MAX = {
  scenema: {
    instruction: { max: LIMITS.scenemaPart },
    voice_description: { max: LIMITS.aukVoice, cut: true },
    old_text: { max: LIMITS.wordsText },
    new_text: { max: LIMITS.wordsText },
    fix_description: { max: LIMITS.fixDescription },
  },
  yue2: { lyrics: { max: LIMITS.yueLyrics }, abc: { max: LIMITS.yueAbc } },
  lyria: { lyrics: { max: LIMITS.lyriaLyrics } },
  ace: { lyrics: { max: LIMITS.aceLyrics } },
};

/* A copy of the guide with the limits on it: engines[e].scriptMax (and scriptCut, scriptLyricsApart, scriptReads), settings[i].maxChars
 * (and maxCut), and deskMax for the writing desk. The guide passed in is never changed. */
function withTextLimits(guide) {
  if (!guide || !guide.engines) return guide;
  const engines = {};
  for (const [key, engine] of Object.entries(guide.engines)) {
    const script = SCRIPT_MAX[key];
    const own = SETTING_MAX[key] || {};
    engines[key] = {
      ...engine,
      ...(script ? {
        scriptMax: script.max,
        ...(script.cut ? { scriptCut: true } : {}),
        ...(script.lyricsApart ? { scriptLyricsApart: true } : {}),
        ...(script.reads ? { scriptReads: script.reads } : {}),
      } : {}),
      ...(Array.isArray(engine.settings) ? {
        settings: engine.settings.map((s) => (own[s.key] ? { ...s, maxChars: own[s.key].max, ...(own[s.key].cut ? { maxCut: true } : {}) } : s)),
      } : {}),
    };
  }
  return { ...guide, engines, deskMax: LIMITS.desk };
}

module.exports = { LIMITS, SCRIPT_MAX, SETTING_MAX, withTextLimits };
