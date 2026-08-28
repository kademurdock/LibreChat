/* ── kadeCare.js — THE CONCENTRATED-CARE DETECTOR ────────────────────────────
 * Part 92.7 (Aug 24 2026). Reporting only. It counts and it shows; it never
 * blocks, rewrites, or refuses anything.
 *
 * WHY IT IS ITS OWN FILE: the logic that decides whether Kiana is slipping into
 * caretaker register is worth a test against the real thing rather than a copy
 * of it — the same reason compaction.js and modelbudget.js exist in reframe. It
 * has zero requires on purpose, so `node --test` can run it with no install.
 *
 * WHAT IT LOOKS FOR, and the story is in KIANA_CARETAKER_MODE_2026-08-23.md:
 * on the night Kade's father was in cardiac care, Kiana granted her permission
 * to feel, told her to breathe, and INVENTED A SCENE. The tic is rare — a
 * handful of turns — so no per-thousand-words rate across every seat could see
 * it. Hence a per-REPLY count.
 *
 * ⚠️ THE WORD LIST IN THAT DOCUMENT DOES NOT SURVIVE CONTACT WITH THE CORPUS,
 * AND THAT IS WHY "CALIBRATE FIRST" WAS WRITTEN NEXT TO IT. Run verbatim over
 * 354 real Kiana replies from one family seat it flagged 18 — 5.1% — for a tic
 * described as a handful of turns a week. TEN WERE NOISE, from two causes:
 *
 *   1. `\bbreathe\b` MATCHES THE FILM TITLE "DON'T BREATHE". Six of eight
 *      `breathe` hits were a conversation about a horror movie whose lead is a
 *      blind veteran — which she raised BECAUSE he is blind. A bare verb is not
 *      a detector. Hence maskFilmTitles(): the film cannot vote.
 *   2. `that's a lot` MATCHES PLAIN QUANTITY — "that's a lot of risk", "that's
 *      a lot of processing", "that's a lot of trust from a bird who can't even
 *      be told what's happening." The spec meant `that's a lot.` as a whole
 *      validating sentence and wrote a substring that catches arithmetic.
 *
 * WHAT SURVIVED IS BETTER THAN WHAT DIED: `you're allowed to` was FOUR FOR FOUR
 * — every occurrence in 354 replies a genuine permission-grant, zero innocent
 * uses. And the corpus taught the spec the thing it did not know:
 *
 *   ⭐ THE TIC IS POSITIONAL, NOT LEXICAL. Every genuine body-instruction hit
 *   sat at 60%, 70%, 92% and 98% of its reply — an appended CODA that grades
 *   how she handled her day and then prescribes rest, bolted onto a reply that
 *   had already answered the question. That shape is the signal. A single warm
 *   phrase mid-flow is not.
 *
 * v1 18/354 (5.1%) → v2 any-phrase 8 (2.3%) → v2 CODA 3 (0.8%).
 *
 * ⚠️ WHY IT REPORTS AND DOES NOT GUARD: one of those three final hits reads as
 * GOOD — affirming a family member's right to her own experience of something
 * she actually lived, no invented scene, no prescription. The detector finds the
 * SHAPE reliably. Whether an instance is the tic or plain warmth is Kade's call,
 * and a guard that made it would be wrong about a third of the time. It shows
 * her the replies and blocks nothing.
 *
 * ⚠️ AND THE STANDARD IT STILL DOES NOT MEET, said plainly rather than papered
 * over: the record demands ZERO HITS ON APPROVED REPLIES as a positive control,
 * and the voice bank holds only ~2 KEEP labels, which is too small to be one.
 * ~8 more labels is the unlock. Until then this is a measurement, not a verdict.
 *
 * ⚠️ UNCONTRACTED FORMS ARE INCLUDED, AND THE SELF-TEST IS WHY. A fixture
 * written as "It is okay to say no" did not match `it'?s okay to` and the test
 * went red — a real hole, found by a typo. Every phrase now accepts both the
 * contraction and the long form. The broadening was RE-MEASURED against the
 * same 354-reply corpus rather than assumed safe: it moved nothing (8 / 3, the
 * identical replies), so it costs no precision and closes the variant.
 *
 * ⚠️ THE FIXTURES IN THE SELF-TEST ARE SYNTHETIC AND MUST STAY THAT WAY. This
 * repository is PUBLIC. The calibration ran on real conversations about a
 * mother's surgery and an aunt's trauma; those receipts live in Kade's private
 * folder (reports/concentrated_care_calibration_run_2026-08-24.txt) and in the
 * private memory repo. The platform's usual law is "reproduce the live shape
 * verbatim" — here privacy outranks it, and a future session should not
 * "improve" these fixtures by pasting the real ones in.
 * ────────────────────────────────────────────────────────────────────────────*/

/* Titles that contain a word the detector cares about. Masked to '#' so the
 * position arithmetic downstream stays honest — same length, no shift. */
const FILM_TITLES = [/don'?t\s+breathe/gi];

const GROUPS = {
  /* Permission-granting. `that's a lot` is here only as a whole sentence or
   * followed by an explicit burden — never bare. */
  permission: [
    /you(?:'?re| are) allowed to/i,
    /* ⭐⭐⭐ AUG 28 2026 — DETECT THE MOVE, NOT THE STRING.
     *
     * Her report the SAME MORNING the v228 ban shipped: "she's still also
     * talking about, people are allowed to blah blah blah." The persona banned
     * "you're allowed to". The model kept the MOVE and changed the SUBJECT.
     *
     * THIRD PROOF OF THE PATTERN on this platform: the reframe tic was banned
     * and came back as the inverted negation; "you're allowed" was banned and
     * came back as "people are allowed." A banned SURFACE STRING teaches the
     * model to reroute the same behaviour through new words, so a detector
     * built from the banned string measures compliance with the WORDING and
     * reports zero on a tic that never stopped.
     *
     * So this matches the GRAMMAR: any third-person subject + a permission
     * verb + a FEELING or STATE complement. The complement requirement is what
     * keeps it honest — "only staff are allowed to open that door" and "she's
     * allowed to drive again Monday" are ordinary sentences about permission
     * and must never flag.
     *
     * CALIBRATED BEFORE SHIPPING, as the record demands after five dead
     * matchers: 10/10 on constructed positives (including her two reported
     * forms verbatim), 12/12 clean on constructed negatives built to trip it,
     * and ZERO hits on 71 real Kiana replies pulled from 13 live conversations.
     * ⚠️ Said plainly: 71 is SMALLER than the 354-reply corpus this file's own
     * header sets as the standard, so the false-positive claim is weaker than
     * the one above it. It should be re-run on a full corpus at the next
     * measurement pass. The positive side does not depend on corpus size —
     * her own words are two of the fixtures. */
    /\b(?:people|folks|anybody|anyone|somebody|someone|everyone|everybody|nobody|we|they|a person|humans?|most people)\b(?:'?s|'?re|\s+(?:is|are|was|were))?\s+(?:all|also|still|totally|absolutely|always)?\s*(?:allowed|entitled|permitted|free)\s+to\s+(?:\w+\s+){0,3}?\b(?:feel(?:ing)?|felt|be|being|not\s+be|sit|griev(?:e|ing)|cry|mourn|rest|struggl(?:e|ing)|hurt|ache|want|need|miss|chang(?:e|ing)|say|walk|quit|stop|ask|sad|mad|angry|tired|exhausted|scared|upset|overwhelmed|numb|done|human|okay|ok)\b/i,
    /\bthere(?:'?s| is) nothing wrong with (?:\w+\s+){0,2}?(?:feel(?:ing)?|want(?:ing)?|need(?:ing)?|cry(?:ing)?|griev(?:e|ing)|rest(?:ing)?|say(?:ing)? no|being)\b/i,
    /\b(?:you|they|people) (?:have|has) every right to (?:\w+\s+){0,2}?(?:feel|be|being|cry|grieve|want|need|say)\b/i,
    /you (?:don'?t|do not) have to be\b/i,
    /it(?:'?s| is) okay to\b/i,
    /no shame in\b/i,
    /i(?:'?m| am) here for you\b/i,
    /that(?:'?s| is) a lot\s*[.!]/i,
    /that(?:'?s| is) a lot to (?:carry|sit with|hold|take|process|be holding)\b/i,
  ],
  /* Body instructions. Imperative frames only — a bare `breathe` was the whole
   * false-positive problem. */
  body: [
    /* Added Aug 24 2026 after the detector MISSED a live one on the day it
     * shipped. Her build-241 reply, on her own seat at 3am, closed with "Go to
     * bed when the episode's over, though — the moon'll still be there tomorrow
     * and so will I." Textbook coda; zero hits from the shipped list, because
     * "get some rest" was in it and "go to bed" was not.
     * CALIBRATED BEFORE ADDING, as always: `go to bed` is 3 for 3 on the real
     * corpus and every one sits at 91-95% of its reply. The sleep variants are
     * clean (no hits, no risk).
     * ⚠️ AND ONE WAS REJECTED, which is the more useful half: /(will|'ll) still
     * be (there|here)/ — the phrase that JUMPED OUT of her report — takes 4
     * hits and they are ordinary reassurance about real objects ("the movie
     * will still be there", "it'll still be there, you're not locking yourself
     * out of it"). The most distinctive-sounding phrase was the wolf-crier. */
    /\bgo to bed\b/i,
    /\bget to bed\b/i,
    /\bget some sleep\b/i,
    /\bgo to sleep\b/i,
    /\bcall it a night\b/i,
    /\bput (?:the|your) phone down\b/i,
    /\btake a breath\b/i,
    /\bbreathe through\b/i,
    /\bjust breathe\b/i,
    /when to breathe\b/i,
    /get some rest\b/i,
    /let your shoulders\b/i,
    /be gentle with yourself\b/i,
    /give yourself grace\b/i,
  ],
  /* Claimed shared experience — she is not a person and has not been through it. */
  shared: [/i know what that(?:'?s| is) like\b/i, /i know something about that\b/i],
  /* The coda vocabulary the spec never had: unsolicited assessment of how the
   * person coped. This is the group the corpus actually convicted. */
  assess: [
    /you (?:processed|handled) (?:it|that|them)\b/i,
    /you knew when to\b/i,
    /you carried (?:a lot|so much|all)\b/i,
    /(?:don'?t|do not) let it (?:all )?stack up\b/i,
    /that(?:'?s| is) enough for one (?:day|night|week|\w+day)\b/i,
    /you did (?:good|well|enough)\b/i,
  ],
};

/** Blank out known titles so a film cannot cast a vote. Length-preserving. */
function maskFilmTitles(text) {
  let out = String(text == null ? '' : text);
  for (const re of FILM_TITLES) {
    out = out.replace(re, (m) => '#'.repeat(m.length));
  }
  return out;
}

/**
 * Every care-register phrase in one reply, with where it falls.
 * @returns {Array<{group:string, phrase:string, pos:number}>} pos = percent
 *   through the reply, which is what makes the coda visible.
 */
function scanCare(text) {
  const masked = maskFilmTitles(text);
  const len = masked.length || 1;
  const hits = [];
  for (const group of Object.keys(GROUPS)) {
    for (const re of GROUPS[group]) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let m;
      while ((m = g.exec(masked)) !== null) {
        hits.push({ group, phrase: m[0].trim(), pos: Math.round((100 * m.index) / len) });
        if (m.index === g.lastIndex) g.lastIndex++;
      }
    }
  }
  return hits;
}

/* A hit is the tic's SHAPE when it grades how they coped, or when it lands in
 * the last 15% of the reply — the appended-coda position the corpus showed at
 * 60/70/92/98%. 85 is deliberately generous toward silence: a warm phrase in
 * mid-flow is conversation, not caretaking. */
const CODA_FROM_PCT = 85;

function isCoda(hits) {
  return (hits || []).some((h) => h.group === 'assess' || h.pos >= CODA_FROM_PCT);
}

/**
 * Roll a window of replies into the line /voice-report prints.
 * Excerpts are the TAIL only — the coda itself is what she needs to judge, and
 * the rest of the reply is somebody's private conversation.
 */
function careReport(texts, opts) {
  const limit = (opts && opts.samples) || 5;
  const tail = (opts && opts.tailChars) || 180;
  let flagged = 0;
  const coda = [];
  const phrases = {};
  for (const raw of texts || []) {
    const t = String(raw == null ? '' : raw).trim();
    if (!t) continue;
    const hits = scanCare(t);
    if (!hits.length) continue;
    flagged++;
    for (const h of hits) {
      const k = h.phrase.toLowerCase();
      phrases[k] = (phrases[k] || 0) + 1;
    }
    if (isCoda(hits)) {
      coda.push({
        groups: Array.from(new Set(hits.map((h) => h.group))).sort(),
        phrases: Array.from(new Set(hits.map((h) => h.phrase.toLowerCase()))).sort(),
        endsWith: t.slice(-tail),
      });
    }
  }
  const scanned = (texts || []).filter((x) => String(x == null ? '' : x).trim()).length;
  return {
    scanned,
    anyPhrase: flagged,
    coda: coda.length,
    codaRate: scanned ? Math.round((coda.length / scanned) * 1000) / 1000 : 0,
    topPhrases: Object.entries(phrases)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([phrase, count]) => ({ phrase, count })),
    samples: coda.slice(0, limit),
  };
}

module.exports = { maskFilmTitles, scanCare, isCoda, careReport, CODA_FROM_PCT };
