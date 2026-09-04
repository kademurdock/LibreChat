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


/* ---------- THE PREVIEW EXCERPT (Part 122.1, Sep 4 2026) --------------------
 * "What voice is it sampling because that sounded nothing like my description,
 * and it just said some weird sample sentence."
 *
 * It said a HARDCODED sentence — "Here is how I sound. I can be gentle, I can
 * be sharp…" — which is nobody's words and tells her nothing about her own
 * piece. Her pick: perform the OPENING OF HER SCRIPT instead, so a fifteen
 * second audition is fifteen seconds of the actual thing.
 *
 * Whole sentences only. A preview that stops mid-clause sounds like a fault in
 * the voice rather than the end of a sample, and she would be judging an actor
 * on it. Tag blocks that fall inside the excerpt are KEPT — an <action> is a
 * direction to the performer, so dropping it changes the reading she is
 * auditioning. The <speak> attributes are carried whole, exactly as the
 * splitter does, or the sample is a different person than the render.
 */
function previewExcerpt(script, { maxWords = 40, fallback = 'This is the voice you described, reading a line or two so you can hear it before you spend anything.' } = {}) {
  const raw = String(script || '').trim();
  const open = raw.match(/^<speak\b[^>]*>/i);
  const openTag = open ? open[0] : '';
  const body = openTag ? raw.slice(openTag.length).replace(/<\/speak>\s*$/i, '').trim() : raw;
  const rewrap = (b) => (openTag ? `${openTag}\n${b.trim()}\n</speak>` : b.trim());

  /* Same atomising as the splitter: a tag block is indivisible, prose breaks at
   * paragraph then sentence. */
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

  const spokenWords = (t) =>
    String(t)
      .replace(/<action>[\s\S]*?<\/action>/gi, ' ')
      .replace(/<sound>[\s\S]*?<\/sound>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .split(/\s+/)
      .filter(Boolean).length;

  const taken = [];
  let words = 0;
  for (const a of atoms) {
    const w = spokenWords(a);
    /* Always take the first spoken atom even if it alone is over budget — a
     * long opening sentence is still the right thing to audition, and cutting
     * it would put us back to a fragment. */
    if (words > 0 && words + w > maxWords) break;
    taken.push(a);
    words += w;
  }
  const useFallback = !taken.length || words === 0;
  return {
    prompt: rewrap(useFallback ? fallback : taken.join('\n')),
    words: useFallback ? spokenWords(fallback) : words,
    fromScript: !useFallback,
    /* Said before it spends, so she is never surprised by what it performs. */
    text: (useFallback ? fallback : taken.join(' '))
      .replace(/<action>[\s\S]*?<\/action>/gi, ' ')
      .replace(/<sound>[\s\S]*?<\/sound>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  };
}

module.exports = { splitSpeakScript, softSplit, saySplit, previewExcerpt };
