/* CARRYING A PIECE OF WORK TO ANOTHER ENGINE (Part 243, Sep 21 2026).
 *
 * Her ask, in her words: "if I'm working on something on yue2 music, and I
 * feel like switching over to lyria, which is also music, can you make my
 * lyrics and tags and stuff jump over? And similar if I'm working on a sound,
 * it should be transferable between sound programs in case I don't like what
 * something produced and want to try a different vender."
 *
 * THE SHAPE THIS TAKES, AND WHY.
 *
 * 1. IT NEVER TOUCHES THE ORIGINAL. Switching vendors is something you do
 *    BECAUSE you did not like what you got, so the thing you did not like has
 *    to still be there to compare against. A carry makes a NEW draft and
 *    leaves the old project, its takes and its receipts exactly as they were.
 *
 * 2. THE DATA MOVES FOR FREE AND THE PROSE DOES NOT HAVE TO. Lyrics, section
 *    tags, her own typed words, the seed, the imported clip and the title are
 *    DATA: they mean the same thing to every engine and they carry across
 *    losslessly, instantly, at no cost. The style paragraph is the only thing
 *    written in a grammar, and rewriting that is an optional second step she
 *    can take or skip. The common case -- "same song, other engine" -- is
 *    free and immediate.
 *
 * 3. IT SAYS WHAT DID NOT COME ACROSS. Every engine has knobs the others do
 *    not: YuE2's weirdness and its trained styles, Lyria's instrumental
 *    switch, Stable Audio's duration, AuK's pinned voice. Dropping them
 *    silently would be the sort of thing you only find out about after
 *    spending money on a render, so each carry returns plain sentences about
 *    what moved and what did not.
 *
 * Pure functions, no database, no model, no network -- so the whole of it is
 * testable, and the route on top of it stays a route.
 */

/** What each engine holds, and what its `script` field actually is. */
const ENGINES = {
  lyria: {
    label: 'Lyria',
    kind: 'music',
    script: 'brief',
    keeps: ['lyrics', 'instrumental', 'keep_lyrics', 'seed'],
  },
  yue2: {
    label: 'YuE2',
    kind: 'music',
    script: 'style',
    keeps: ['lyrics', 'seed', 'count', 'reference_voice_url'],
  },
  scenema: {
    label: 'AuK',
    kind: 'voice',
    script: 'speak',
    keeps: ['reference_voice_url', 'pace', 'language', 'vc_cfg_rate', 'vc_steps'],
  },
  seed: {
    label: 'Seed Audio',
    kind: 'voice',
    script: 'scene',
    keeps: ['audio_urls', 'reference_voice_url', 'background_sfx'],
  },
  stable: {
    label: 'Stable Audio',
    kind: 'effects',
    script: 'style',
    keeps: ['seed', 'count', 'duration', 'steps', 'soundModel'],
  },
};

const ENGINE_KEYS = Object.keys(ENGINES);

/** Which engines it makes sense to offer, given where she is now. Music and
 *  sound are separate trades; nothing useful comes of turning a song into a
 *  door slam, and pretending otherwise would be a menu full of wrong answers. */
function destinationsFor(engine) {
  const from = ENGINES[engine];
  if (!from) {
    return [];
  }
  const sound = new Set(['voice', 'effects']);
  return ENGINE_KEYS.filter((k) => {
    if (k === engine) {
      return false;
    }
    const to = ENGINES[k];
    return from.kind === 'music' ? to.kind === 'music' : sound.has(to.kind);
  }).map((k) => ({ engine: k, label: ENGINES[k].label }));
}

function canCarry(from, to) {
  if (!ENGINES[from]) {
    return { ok: false, why: 'That project was not made by an engine this can carry.' };
  }
  if (!ENGINES[to]) {
    return { ok: false, why: 'There is no engine by that name.' };
  }
  if (from === to) {
    return { ok: false, why: `That is already a ${ENGINES[to].label} project.` };
  }
  if (destinationsFor(from).some((d) => d.engine === to)) {
    return { ok: true };
  }
  const trade = (k) => (ENGINES[k].kind === 'music' ? 'music' : 'sound and speech');
  return {
    ok: false,
    why:
      `${ENGINES[from].label} makes ${trade(from)} and ${ENGINES[to].label} makes ${trade(to)}. ` +
      'Those do not carry: start a new project instead.',
  };
}

/* Lyria's brief keeps the words under a "Lyrics:" heading at the end; YuE2
 * keeps them in a field of their own. Splitting the two is most of the work of
 * carrying a song, and it is exact rather than clever. */
function splitLyricsBlock(brief) {
  const text = String(brief || '');
  const m = text.match(/\n[ \t]*lyrics[ \t]*:[ \t]*\n?/i);
  if (!m) {
    return { prose: text.trim(), lyrics: '' };
  }
  return {
    prose: text.slice(0, m.index).trim(),
    lyrics: text.slice(m.index + m[0].length).trim(),
  };
}

/* Sep 25 2026: a carry with "rewrite the description" ticked saved the
 * literal text "[object Object]" as a Lyria direction (the route handed a
 * model reply object where a string belonged). One saved row still holds it.
 * A script is read as text whatever shape it arrives in, and that string is
 * never treated as somebody's description. */
function isBrokenScript(text) {
  return /^\s*\[object \w+\]\s*$/.test(String(text || ''));
}

function scriptText(value) {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (value && typeof value === 'object' && typeof value.text === 'string') {
    text = value.text;
  }
  return isBrokenScript(text) ? '' : text;
}

/** True when this text carries section tags -- [Verse 1], [Chorus] and so on.
 *  Both music engines read them, which is why they move across untouched. */
const SECTION_TAG =
  /\[\s*(intro|verse|chorus|pre-?chorus|bridge|hook|outro|refrain|interlude|breakdown|solo|drop)[^\]]*\]/i;
function hasSectionTags(text) {
  return SECTION_TAG.test(String(text || ''));
}

function firstUrl(...values) {
  for (const v of values) {
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) {
      return v;
    }
    if (Array.isArray(v)) {
      const hit = v.find((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
      if (hit) {
        return hit;
      }
    }
  }
  return null;
}

/* Knobs whose meaning does not change when the engine does. Anything not on
 * this list is engine-private and is reported as left behind rather than
 * quietly reinterpreted: YuE2's `steps` and Stable Audio's `steps` are the
 * same word for different dials, which is exactly the kind of thing that
 * silently ruins a render. */
const SHARED_KNOBS = [
  'seed',
  'count',
  'duration',
  'soundModel',
  'instrumental',
  'keep_lyrics',
  'background_sfx',
  'pace',
  'language',
];

/**
 * Work out the new draft. Pure: takes a project-shaped object, returns what
 * the new one should hold plus plain sentences about the move.
 *
 * @param {object} project  { engine, title, sourceText, script, options, voiceSeed }
 * @param {string} to       the destination engine key
 * @param {object} helpers  { toScreenplay } -- AuK XML is unreadable to every
 *                          other engine and to a person, so the route hands in
 *                          the converter it already has rather than this file
 *                          growing an XML parser.
 */
function carryOver(project, to, helpers = {}) {
  const from = String((project && project.engine) || '');
  const check = canCarry(from, to);
  if (!check.ok) {
    return { ok: false, why: check.why };
  }

  const src = ENGINES[from];
  const dst = ENGINES[to];
  const oldOpts = project.options || {};
  const notes = [];
  const options = {};

  /* ---- the script ------------------------------------------------------ */
  let script = scriptText(project.script);
  if (!script && isBrokenScript(project.script)) {
    notes.push(
      'The description on that project was damaged by an old bug and read "[object Object]", so it was left empty. Write one, or ask the desk, before you generate.',
    );
  }
  let lyrics = typeof oldOpts.lyrics === 'string' ? oldOpts.lyrics.trim() : '';

  if (src.script === 'brief') {
    /* Lyria keeps the words inside the brief. Pull them out so the other
     * engine gets them in the field it actually reads. */
    const split = splitLyricsBlock(script);
    script = split.prose;
    if (!lyrics && split.lyrics) {
      lyrics = split.lyrics;
    }
  }
  if (src.script === 'speak' && typeof helpers.toScreenplay === 'function') {
    /* Nothing else on the platform reads AuK's XML, and neither does a
     * person. The screenplay is the same script in the interchange format. */
    script = helpers.toScreenplay(script) || script;
    notes.push(
      'The XML came across as a screenplay, which is the form the other engines and the script desk read.',
    );
  }

  /* ---- the words ------------------------------------------------------- */
  if (lyrics && dst.keeps.includes('lyrics')) {
    options.lyrics = lyrics.slice(0, 8000);
    notes.push(
      hasSectionTags(lyrics)
        ? 'Your lyrics and their section tags came across whole. Both engines read [Verse 1] and [Chorus] the same way.'
        : 'Your lyrics came across whole.',
    );
  } else if (lyrics && !dst.keeps.includes('lyrics')) {
    notes.push(`${dst.label} has no place for lyrics, so the words stayed in the ${src.label} draft.`);
  }
  if (to === 'yue2' && !options.lyrics) {
    notes.push('YuE2 will not sing without words, so put something in Lyrics before you generate.');
  }

  /* ---- the knobs that mean the same thing on both sides ---------------- */
  for (const key of SHARED_KNOBS) {
    if (oldOpts[key] === undefined) {
      continue;
    }
    if (dst.keeps.includes(key)) {
      options[key] = oldOpts[key];
    }
  }
  const clip = firstUrl(oldOpts.reference_voice_url, oldOpts.audio_urls);
  if (clip) {
    if (dst.keeps.includes('audio_urls')) {
      options.audio_urls = [clip];
    }
    if (dst.keeps.includes('reference_voice_url')) {
      options.reference_voice_url = clip;
    }
    notes.push(
      options.audio_urls || options.reference_voice_url
        ? 'The recording you imported came with it.'
        : `${dst.label} does not take an imported recording, so that stayed behind.`,
    );
  }

  /* ---- what was left behind, said out loud ------------------------------ */
  const dropped = [];
  if (oldOpts.band && oldOpts.band !== 'none' && to !== 'yue2') {
    dropped.push('trained style, which only YuE2 has');
  }
  if (oldOpts.abc && to !== 'yue2') {
    dropped.push('composition score');
  }
  if (oldOpts.weirdness !== undefined && to !== 'yue2') {
    dropped.push('weirdness');
  }
  if (oldOpts.guidance !== undefined && to !== 'yue2') {
    dropped.push('guidance');
  }
  if (oldOpts.instrumental && !dst.keeps.includes('instrumental')) {
    dropped.push('instrumental switch');
  }
  if (oldOpts.duration !== undefined && !dst.keeps.includes('duration')) {
    dropped.push('fixed length');
  }
  if (Number.isInteger(project.voiceSeed) && to !== 'scenema') {
    dropped.push('pinned voice, which is an AuK idea');
  }
  if (dropped.length) {
    notes.push(
      `${dst.label} has no ${dropped.join(', no ')}, so ${dropped.length === 1 ? 'that was' : 'those were'} left behind.`,
    );
  }

  /* ---- whether the style paragraph is worth rewriting ------------------- */
  let rewriteAdvised = false;
  if (src.script !== dst.script) {
    rewriteAdvised = true;
    if (dst.script === 'brief') {
      notes.push(
        'Lyria wants a brief -- genre with an era, the instruments, the structure, who sings and a BPM line. What came across is shorter than that, so ask the desk to write it up before you generate.',
      );
    } else if (dst.script === 'style' && src.script === 'brief') {
      notes.push(
        'YuE2 reads a short style direction rather than a full brief, so the description came across long. Trim it, or let the desk shorten it.',
      );
    } else if (dst.script === 'scene') {
      notes.push(
        'Seed Audio performs a whole scene at once -- setting, cast, effects and exact lines. The script came across as it was, so have the desk lay it out that way before you spend.',
      );
    } else if (dst.script === 'speak') {
      notes.push(
        'AuK performs one actor. If more than one person speaks in this script, keep the one you want and drop the rest.',
      );
    } else if (dst.kind === 'effects') {
      notes.push(
        'Stable Audio makes sound and no speech at all. Describe the sound you want to hear; any dialogue in here will not be spoken.',
      );
    }
  }

  /* Lineage, so a draft can say where it came from. */
  options.carriedFrom = { project: String(project._id || project.id || ''), engine: from };

  const baseTitle = String(project.title || 'Untitled').replace(/\s*\(on [^)]+\)\s*$/, '');
  return {
    ok: true,
    rewriteAdvised,
    draft: {
      engine: to,
      title: `${baseTitle} (on ${dst.label})`.slice(0, 80),
      /* Her own typed words are the one thing that must survive every hop. */
      sourceText: String(project.sourceText || '').slice(0, 8000),
      script,
      options,
      mode: project.mode === 'advanced' ? 'advanced' : 'easy',
      state: 'draft',
    },
    notes,
  };
}

module.exports = {
  ENGINES,
  ENGINE_KEYS,
  destinationsFor,
  canCarry,
  carryOver,
  splitLyricsBlock,
  scriptText,
  isBrokenScript,
  hasSectionTags,
  SHARED_KNOBS,
};
