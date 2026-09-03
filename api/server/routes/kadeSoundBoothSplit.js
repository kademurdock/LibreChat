'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * kadeSoundBoothSplit.js — cutting a script the engine cannot swallow whole.
 *
 * Its own file, with NO dependencies, for one reason: this is the part that
 * must be right before anything spends her money, and a module that requires
 * nothing can be tested by itself in a second rather than by booting the whole
 * app. `kadeSoundBoothSplit.selftest.js` next door is the proof.
 * ───────────────────────────────────────────────────────────────────────── */

/* ---------- SPLITTING A SCRIPT THAT IS TOO LONG (Part 122, Sep 3 2026) -------
 * Her ask, in her words: "If files are too long, we need a thing that cuts
 * them off or something auto." Until now a script over the cap was REFUSED
 * with a sentence telling her to split it by hand, which is work handed back
 * to the person least able to do it by eye.
 *
 * Three rules this obeys, each one a way it could go wrong:
 *
 * 1. EVERY PART CARRIES THE SAME <speak> ATTRIBUTES. The voice description,
 *    gender, scene, shot and pace live on that tag. Re-wrapping a part without
 *    them would make part two a DIFFERENT PERSON than part one, and the only
 *    way to discover that is to listen to something already paid for.
 * 2. A TAG IS NEVER CUT IN HALF. <action> and <sound> blocks are atomic --
 *    half an <action> is malformed XML, and an unclosed tag is content the
 *    engine reads ALOUD (the %%% scar, one floor up, is the same lesson).
 * 3. IT BREAKS WHERE A READER WOULD BREATHE. Paragraph first, then sentence
 *    end, and only if a single sentence is itself over the cap does it fall
 *    back to a word boundary -- because a seam mid-sentence is audible and a
 *    seam between sentences mostly is not.
 */
function splitSpeakScript(script, maxChars) {
  const raw = String(script || '').trim();
  const open = raw.match(/^<speak\b[^>]*>/i);
  const openTag = open ? open[0] : '';
  const body = openTag
    ? raw.slice(openTag.length).replace(/<\/speak>\s*$/i, '').trim()
    : raw;
  const overhead = openTag ? openTag.length + '</speak>'.length + 2 : 0;
  const room = Math.max(200, maxChars - overhead);
  const rewrap = (b) => (openTag ? `${openTag}\n${b.trim()}\n</speak>` : b.trim());

  if (raw.length <= maxChars) return [raw];

  /* Atoms: the smallest thing that may never be cut. A whole tag block is one
   * atom; everything else splits at paragraph, then sentence, then word. */
  const atoms = [];
  const tagBlock = /<(action|sound)\b[^>]*>[\s\S]*?<\/\1>/gi;
  let cursor = 0;
  let m;
  while ((m = tagBlock.exec(body)) !== null) {
    if (m.index > cursor) atoms.push(...softSplit(body.slice(cursor, m.index)));
    atoms.push(m[0]);
    cursor = m.index + m[0].length;
  }
  if (cursor < body.length) atoms.push(...softSplit(body.slice(cursor)));

  /* Any atom still over the cap can only be a single enormous sentence with no
   * tag in it; cut that one at word boundaries and accept the seam. */
  const sized = [];
  for (const a of atoms) {
    if (a.length <= room) { sized.push(a); continue; }
    let rest = a;
    while (rest.length > room) {
      let cut = rest.lastIndexOf(' ', room);
      if (cut < room * 0.5) cut = room; // a word longer than half the cap: hard cut
      sized.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) sized.push(rest);
  }

  const parts = [];
  let cur = '';
  for (const a of sized) {
    if (!a) continue;
    const joined = cur ? `${cur}\n${a}` : a;
    if (joined.length > room && cur) { parts.push(cur); cur = a; }
    else cur = joined;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(rewrap);
}

/* Paragraph, then sentence. Keeps the terminator with the sentence it ends. */
function softSplit(chunk) {
  const out = [];
  for (const para of String(chunk).split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    const sentences = p.match(/[^.!?\n]+(?:[.!?]+["')\]]*|\n|$)/g);
    if (!sentences) { out.push(p); continue; }
    for (const sn of sentences) {
      const t = sn.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/** The split as a sentence, because it is read aloud before anything spends. */
function saySplit(parts, engineName) {
  if (parts.length <= 1) return '';
  return `That script is longer than ${engineName} can make in one go, so I am rendering it in ${parts.length} parts and joining them into one recording. You will be charged for each part, and you get one file at the end.`;
}

module.exports = { splitSpeakScript, softSplit, saySplit };
