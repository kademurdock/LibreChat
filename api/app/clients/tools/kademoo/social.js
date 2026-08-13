/* ── SOCIAL INFRASTRUCTURE (2026-08-13, round 9) ──────────────────────────
 *
 * WHERE THIS CAME FROM. Her instruction was to stop inventing and go read what
 * the MOOs already solved: LambdaCore, Miriani's E2, the Tale and LIMA mudlib
 * souls. Read with the space stripped out, the shared answer is that a social
 * system is four things, and Reverie had one and a half of them:
 *
 *   1. A SOUL — a table of gestures with a first-person and a third-person
 *      form. Reverie had this (20 emotes). Everybody has this.
 *   2. ADVERBS — one modifier slot turns 20 gestures into thousands. Tale
 *      ships 2200 adverbs against 250 emotes and prefix-matches them so you
 *      never type one out in full. This is the cheapest vocabulary in all of
 *      MUD design: no new content, no model call, and it is the thing that
 *      keeps two people typing `nod` at each other from READING as two people
 *      typing `nod`.
 *   3. A POSE — persistent standing state, printed after your name in the
 *      room. Miriani calls them room poses. THIS IS THE BIG ONE FOR US, and
 *      the reason is the whole premise of this game: a blind player's `look`
 *      IS the visual field. Before poses it returned a list of names, which is
 *      a chat window's user list. After poses it returns what every person in
 *      the room is DOING, which is a room.
 *   4. REFERENCE — naming a person or thing inside a free emote, with pronouns
 *      filled in. Miriani's E2: `*` is you, `-fred` is Fred, `%he/%his/%him`
 *      resolve off the referenced person.
 *
 * WHAT WE DELIBERATELY DID NOT COPY:
 *   · Command piping (`| collapse fred`). It exists because Miriani has a
 *     hundred coded commands whose output you'd want to override. We have a
 *     handful, and a pipe character in an emote is a parser hazard for a
 *     screen-reader user typing fast. Skipped.
 *   · Grouped room poses. Solves an object-display problem we don't have.
 *   · Walk styles as separate movement verbs (STALK <place> instead of GO).
 *     Most of the value comes free — see WALK_STYLES — but binding a dozen new
 *     top-level verbs collides with our own movement grammar, so the style is
 *     a setting and `go` stays `go`.
 *
 * PRONOUNS. E2 needs them and we had none. Default is they/them, which is also
 * the correct default for a stranger nobody has told you about, so the grammar
 * and the manners agree for once.
 */

/* ── ADVERBS ───────────────────────────────────────────────────────────────
 * Curated, not exhaustive. Tale's 2200 is every -ly word in English and most
 * of them read as a thesaurus accident inside a room. These are the ones a
 * person in this city would actually use about a gesture. Prefix matching
 * means `nod sl` reaches `slowly` and nobody types four syllables. */
const ADVERBS = [
  'absently', 'admiringly', 'affectionately', 'agreeably', 'amiably', 'angrily', 'anxiously',
  'apologetically', 'appreciatively', 'awkwardly', 'bashfully', 'bitterly', 'blankly',
  'bravely', 'briefly', 'brightly', 'briskly', 'calmly', 'carefully', 'carelessly',
  'casually', 'cautiously', 'cheerfully', 'coldly', 'coolly', 'crookedly', 'curiously',
  'darkly', 'defiantly', 'deliberately', 'dryly', 'dubiously', 'eagerly', 'easily',
  'evenly', 'faintly', 'fiercely', 'firmly', 'flatly', 'fondly', 'gently', 'gladly',
  'gracefully', 'grimly', 'grudgingly', 'gruffly', 'guiltily', 'happily', 'helplessly',
  'hesitantly', 'honestly', 'hopefully', 'hungrily', 'impatiently', 'innocently',
  'kindly', 'knowingly', 'lazily', 'loudly', 'meaningfully', 'mildly', 'miserably',
  'mournfully', 'nervously', 'nonchalantly', 'noncommittally', 'openly', 'patiently',
  'peacefully', 'plainly', 'politely', 'pointedly', 'proudly', 'quickly', 'quietly',
  'ruefully', 'sadly', 'sagely', 'sharply', 'sheepishly', 'shyly', 'silently',
  'slightly', 'slowly', 'slyly', 'smugly', 'softly', 'solemnly', 'sourly', 'steadily',
  'sternly', 'stiffly', 'stubbornly', 'suddenly', 'sweetly', 'tenderly', 'tersely',
  'thoughtfully', 'tightly', 'tiredly', 'uncertainly', 'uneasily', 'vaguely', 'warily',
  'warmly', 'weakly', 'wearily', 'wickedly', 'wildly', 'wistfully', 'wryly',
];

/** Prefix match. Exact wins over prefix so a future list containing both `sad`
 *  and `sadly` never resolves the wrong one. Ambiguity resolves to the
 *  shortest match, which is the one a person typing fast meant. */
function matchAdverb(word) {
  if (!word) return null;
  const w = String(word).toLowerCase().trim();
  if (!w || /\s/.test(w)) return null;
  if (ADVERBS.includes(w)) return w;
  const hits = ADVERBS.filter((a) => a.startsWith(w));
  if (!hits.length) return null;
  return hits.sort((a, b) => a.length - b.length)[0];
}

/* ── PRONOUNS ──────────────────────────────────────────────────────────────
 * Sets, not genders. The engine never asks what somebody IS; it asks what
 * words to use about them, which is the only thing a sentence needs. */
const PRONOUN_SETS = {
  they: { sub: 'they', obj: 'them', pos: 'their', poss: 'theirs', self: 'themselves', plural: true },
  she: { sub: 'she', obj: 'her', pos: 'her', poss: 'hers', self: 'herself', plural: false },
  he: { sub: 'he', obj: 'him', pos: 'his', poss: 'his', self: 'himself', plural: false },
  it: { sub: 'it', obj: 'it', pos: 'its', poss: 'its', self: 'itself', plural: false },
};
const PRONOUN_ALIASES = {
  'they/them': 'they', they: 'they', them: 'they', neutral: 'they',
  'she/her': 'she', she: 'she', her: 'she',
  'he/him': 'he', he: 'he', him: 'he',
  'it/its': 'it', it: 'it',
};
function pronounsOf(charLike) {
  const key = (charLike && charLike.attrs && charLike.attrs.pronouns) || 'they';
  return PRONOUN_SETS[key] || PRONOUN_SETS.they;
}

/* ── ROOM POSES ────────────────────────────────────────────────────────────
 * A pose is a fragment that continues your name. `pose is leaning on the
 * counter` reads back as "Ruby is leaning on the counter." We do NOT force it
 * to start with a verb, because half the good ones don't ("pose has both hands
 * around a coffee").
 *
 * THE ONE RULE THAT ISN'T MIRIANI'S: a pose dies when you leave the room.
 * Miriani keeps it until cleared, which is fine where you set it once a
 * session and stay put. Here `leaning against the counter` follows you out
 * onto the pier and becomes a lie — and a lie in a room description costs more
 * in this game than in any other, because the description IS the picture. The
 * engine clears attrs.pose on every successful move. */
const POSE_MAX = 120;

function sanitizePose(raw) {
  let p = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!p) return { error: 'Pose what? Try: pose is leaning on the counter, nursing a coffee.' };
  if (/[\n\r]/.test(p)) return { error: 'One line, please.' };
  if (p.length > POSE_MAX) p = p.slice(0, POSE_MAX).trim();
  /* A pose ending in a period reads as two sentences jammed together when the
   * room prints it inside a list. Strip terminal punctuation, keep internal. */
  p = p.replace(/[.!?]+$/, '');
  return { pose: p };
}

/* ── WALK STYLES ───────────────────────────────────────────────────────────
 * What it buys: the ENTER and LEAVE lines other people read. In a world where
 * you meet most people by hearing them arrive, HOW somebody arrives is
 * characterisation at the price of one attribute and zero model calls. */
/* THREE forms, not two. The first version stored only the third-person stems
 * the room reads, and then used them in the second-person confirmation the
 * player reads: "From here on you STALKS out of rooms." Caught by walking the
 * live world rather than by any test, which is the argument for walking it. */
const WALK_STYLES = {
  walk: { leave: 'walks', enter: 'walks in', you: 'walk', youIn: 'walk in' },
  amble: { leave: 'ambles', enter: 'ambles in', you: 'amble', youIn: 'amble in' },
  stride: { leave: 'strides', enter: 'strides in', you: 'stride', youIn: 'stride in' },
  stroll: { leave: 'strolls', enter: 'strolls in', you: 'stroll', youIn: 'stroll in' },
  shuffle: { leave: 'shuffles', enter: 'shuffles in', you: 'shuffle', youIn: 'shuffle in' },
  limp: { leave: 'limps', enter: 'limps in', you: 'limp', youIn: 'limp in' },
  march: { leave: 'marches', enter: 'marches in', you: 'march', youIn: 'march in' },
  slip: { leave: 'slips', enter: 'slips in quietly', you: 'slip', youIn: 'slip in quietly' },
  stalk: { leave: 'stalks', enter: 'stalks in', you: 'stalk', youIn: 'stalk in' },
  hurry: { leave: 'hurries', enter: 'hurries in', you: 'hurry', youIn: 'hurry in' },
  wander: { leave: 'wanders', enter: 'wanders in', you: 'wander', youIn: 'wander in' },
  trudge: { leave: 'trudges', enter: 'trudges in', you: 'trudge', youIn: 'trudge in' },
  saunter: { leave: 'saunters', enter: 'saunters in', you: 'saunter', youIn: 'saunter in' },
  pad: { leave: 'pads', enter: 'pads in', you: 'pad', youIn: 'pad in' },
  bustle: { leave: 'bustles', enter: 'bustles in', you: 'bustle', youIn: 'bustle in' },
};
function walkStyleOf(charLike) {
  const k = charLike && charLike.attrs && charLike.attrs.walkStyle;
  return WALK_STYLES[k] || null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ── EXTENDED EMOTES (E2, the parts worth having) ──────────────────────────
 *
 * All optional — a plain `emote nods` works exactly as it did before:
 *
 *   *          your full name. No * anywhere and your name is prepended,
 *              which is how every emote in every MUD has always worked.
 *   *1 / *2    your first / last name.
 *   -name      somebody or something in this room. `-ruth` finds Ruth-Ann.
 *              Capitalise (`-Ruth`) to capitalise the substitution, which
 *              matters for items whose names start with "a" or "the".
 *   ~name      same, with a leading "a "/"an "/"the " stripped.
 *   %he %him %his %himself %their %theirs …
 *              resolve off the FIRST referenced person; %he2 the second, and
 *              so on. Bare (no digit) means you.
 *   %{a,b,c}   pick one at random. No spaces inside the braces.
 *
 * WHY THE FIRST TOKEN CANNOT BE A REFERENCE (Miriani's rule, and they are
 * right): "-merle hands * a crate" printed to the room begins with Merle's
 * name, and every reader — eye or screen reader — takes the first name in an
 * emote as the actor. You would be putting words in somebody else's mouth by
 * accident. Refused with an explanation rather than silently mangled.
 */

/** Resolve one -token against the room. `pool` is
 *  [{ name, kind:'char'|'item', attrs? }]. Shortest match wins, because the
 *  shortest name containing your prefix is the one you meant. */
function findRef(token, pool) {
  const t = String(token).toLowerCase();
  const byLen = (a, b) => a.name.length - b.name.length;
  const exact = pool.find((p) => p.name.toLowerCase() === t);
  if (exact) return exact;
  const first = pool.filter((p) => p.name.toLowerCase().split(/[\s-]+/)[0] === t);
  if (first.length) return first.sort(byLen)[0];
  const starts = pool.filter((p) => p.name.toLowerCase().startsWith(t));
  if (starts.length) return starts.sort(byLen)[0];
  const words = pool.filter((p) => p.name.toLowerCase().split(/[\s-]+/).some((w) => w.startsWith(t)));
  if (words.length) return words.sort(byLen)[0];
  return null;
}

const STRIP_ARTICLE = /^(a|an|the)\s+/i;

/**
 * Parse an extended emote into a finished third-person line.
 * @param {string} text  what the player typed after `emote`
 * @param {object} self  { name, attrs } of the emoter
 * @param {Array}  pool  [{ name, kind, attrs? }] — everything referenceable here
 * @returns {{ text?: string, error?: string, refs?: Array }}
 */
function renderEmote(text, self, pool) {
  let src = String(text || '').trim();
  if (!src) return { error: 'Emote what?' };
  if (src.length > 500) src = src.slice(0, 500);

  if (/^[-~]\S/.test(src)) {
    return { error: "An emote can't start with somebody else's name — the room would read it as them doing it. Put yourself first, or use * where you want your name." };
  }

  const refs = [];
  const unknown = [];

  /* Pass 1: -thing / ~thing, before pronouns so %he2 can count them.
   * A sigil only counts at a word boundary, so Ruth-Ann and twenty-one are
   * left alone. */
  src = src.replace(/(^|[\s(“"'])([-~])([A-Za-z][A-Za-z0-9']*)/g, (whole, lead, sigil, token) => {
    const hit = findRef(token, pool);
    if (!hit) { unknown.push(token); return whole; }
    if (!refs.includes(hit)) refs.push(hit);
    let name = hit.name;
    if (sigil === '~') name = name.replace(STRIP_ARTICLE, '');
    if (/^[A-Z]/.test(token)) name = name.charAt(0).toUpperCase() + name.slice(1);
    else if (hit.kind === 'item') name = name.charAt(0).toLowerCase() + name.slice(1);
    return lead + name;
  });

  if (unknown.length) {
    return { error: `No "${unknown[0]}" here to point at. (-name reaches somebody in the room; a hyphen inside a word is left alone.)` };
  }

  /* Pass 2: pronouns. Bare = you; a digit picks the Nth reference. */
  const KEYS = {
    he: 'sub', she: 'sub', they: 'sub',
    him: 'obj', them: 'obj',
    his: 'pos', hers: 'poss', their: 'pos', theirs: 'poss',
    himself: 'self', herself: 'self', themselves: 'self',
    hiss: 'poss',
  };
  /* NUMBERING, stated once so nobody has to guess: bare %he is YOU. %he1 is
   * the first person or thing you pointed at with -name, %he2 the second, in
   * the order they appear in the line. Miriani's own example is ambiguous on
   * this point (their emoter references himself with -albori, so their %he is
   * simultaneously "the emoter" and "reference one"); ours is not.
   *
   * An out-of-range number is an ERROR, not a passthrough. `%he2` with one
   * reference used to slide into the room as the literal characters %he2, and
   * a broken emote in front of other people is a worse outcome than being
   * told to fix it. A % in front of a word we don't know (`50% off`) is left
   * alone, because that is a person typing, not a person mis-referencing. */
  let pronounError = null;
  src = src.replace(/%([A-Za-z]+)(\d*)/g, (whole, word, digit) => {
    const slot = KEYS[word.toLowerCase()];
    if (!slot) return whole;
    let who = self;
    if (digit) {
      who = refs[parseInt(digit, 10) - 1];
      if (!who) {
        pronounError = refs.length
          ? `${whole} points at reference ${digit}, and you only named ${refs.length} (${refs.map((r) => r.name).join(', ')}). Bare %${word.toLowerCase()} means you.`
          : `${whole} points at a reference you didn't make. Name somebody with -name first, or drop the number — bare %${word.toLowerCase()} means you.`;
        return whole;
      }
    }
    let out = pronounsOf(who)[slot];
    if (/^[A-Z]/.test(word)) out = out.charAt(0).toUpperCase() + out.slice(1);
    return out;
  });
  if (pronounError) return { error: pronounError };

  /* Pass 3: %{a,b,c} */
  src = src.replace(/%\{([^}]*)\}/g, (whole, body) => {
    const opts = body.split(',').map((s) => s.trim()).filter(Boolean);
    return opts.length ? opts[Math.floor(Math.random() * opts.length)] : '';
  });

  /* Pass 4: your own name. */
  const full = self.name;
  const parts = full.split(/\s+/);
  src = src.replace(/\*1/g, parts[0] || full)
    .replace(/\*2/g, parts.length > 1 ? parts[parts.length - 1] : full)
    .replace(/\*/g, full);

  if (!new RegExp(escapeRe(full) + '|' + escapeRe(parts[0])).test(src)) {
    src = `${full} ${src}`;
  }
  if (!/[.!?"]$/.test(src)) src += '.';
  return { text: src, refs };
}

/* ── THE SOUL ──────────────────────────────────────────────────────────────
 * [first-person, third-person stem, soundId]
 * The stem carries NO trailing period, so an adverb or a target follows it
 * without surgery. Round 7 did `.replace('.', '')` on every targeted emote,
 * which would also have eaten the period inside a name like "Mr. Hock". Fixed
 * by never putting one there in the first place. */
const SOCIALS = {
  laugh: ['You laugh', 'laughs', 'social.laugh'],
  giggle: ['You giggle', 'giggles', 'social.laugh'],
  chuckle: ['You chuckle', 'chuckles', 'social.laugh'],
  smile: ['You smile', 'smiles', null],
  grin: ['You grin', 'grins', null],
  smirk: ['You smirk', 'smirks', null],
  frown: ['You frown', 'frowns', null],
  scowl: ['You scowl', 'scowls', null],
  nod: ['You nod', 'nods', null],
  shake: ['You shake your head', 'shakes their head', null],
  wave: ['You wave', 'waves', null],
  salute: ['You salute', 'salutes', null],
  bow: ['You bow', 'bows', null],
  sigh: ['You sigh', 'sighs', 'social.sigh'],
  groan: ['You groan', 'groans', 'social.sigh'],
  shrug: ['You shrug', 'shrugs', null],
  clap: ['You clap', 'claps', 'social.clap'],
  snap: ['You snap your fingers', 'snaps their fingers', 'social.snap'],
  dance: ['You bust a little move', 'busts a little move', null],
  yawn: ['You yawn', 'yawns', null],
  hum: ['You hum a few bars of something', 'hums a few bars of something', 'social.hum'],
  whistle: ['You whistle', 'whistles', 'social.whistle'],
  cough: ['You cough', 'coughs', 'social.cough'],
  stretch: ['You stretch', 'stretches', null],
  pace: ['You pace', 'paces', null],
  lean: ['You lean against something solid', 'leans against something solid', null],
  wince: ['You wince', 'winces', null],
  flinch: ['You flinch', 'flinches', null],
  cry: ['You cry', 'cries', 'social.cry'],
  blink: ['You blink', 'blinks', null],
  stare: ['You stare', 'stares', null],
  glance: ['You glance around', 'glances around', null],
  ponder: ['You look thoughtful', 'looks thoughtful', null],
  fidget: ['You fidget', 'fidgets', null],
  shiver: ['You shiver', 'shivers', null],
  point: ['You point', 'points', null],
};

/* Targeted phrasing. Most gestures take "at"; some want another preposition,
 * and reading `waves at you` where `waves to you` belongs is the kind of small
 * wrongness that accumulates into a place feeling written by a machine. */
const TARGET_PREP = {
  wave: 'to', bow: 'to', nod: 'to', salute: 'to', shake: 'at',
  clap: 'for', dance: 'with', lean: 'toward', cry: 'to', point: 'at',
};
function prepFor(verb) {
  return TARGET_PREP[verb] || 'at';
}

/** Render one social. Returns { first, third, sound }. */
function renderSocial(verb, opts) {
  const s = SOCIALS[verb];
  if (!s) return null;
  const { adverb = null, targetName = null, selfName } = opts || {};
  let first = s[0];
  let third = `${selfName} ${s[1]}`;
  if (adverb) { first += ` ${adverb}`; third += ` ${adverb}`; }
  if (targetName) {
    const p = prepFor(verb);
    first += ` ${p} ${targetName}`;
    third += ` ${p} ${targetName}`;
  }
  return { first: first + '.', third: third + '.', sound: s[2] };
}

/** `socials` / `socials <pattern>` — the discoverability verb. A sighted
 *  player finds this list on a wiki. A blind player finds it here or not at
 *  all, which is why it ships in the same commit as the feature. */
function listSocials(pattern) {
  const keys = Object.keys(SOCIALS).sort();
  if (!pattern) {
    return [
      `The ${keys.length} gestures: ${keys.join(', ')}.`,
      'Any of them takes an adverb and a target: `nod slowly`, `smile at Ruth-Ann`, `wave warmly to Merle`.',
      `Adverbs (${ADVERBS.length}) prefix-match, so \`nod thou\` gets you \`nod thoughtfully\`. Type \`adverbs\` for the whole list.`,
    ];
  }
  const p = String(pattern).toLowerCase();
  const hits = keys.filter((k) => k.includes(p));
  const advHits = ADVERBS.filter((a) => a.includes(p));
  const out = [];
  out.push(hits.length ? `Gestures matching "${pattern}": ${hits.join(', ')}.` : `No gesture matching "${pattern}".`);
  if (advHits.length) out.push(`Adverbs matching "${pattern}": ${advHits.slice(0, 25).join(', ')}${advHits.length > 25 ? ', …' : ''}.`);
  return out;
}

module.exports = {
  ADVERBS, matchAdverb,
  PRONOUN_SETS, PRONOUN_ALIASES, pronounsOf,
  WALK_STYLES, walkStyleOf,
  sanitizePose, POSE_MAX,
  renderEmote, findRef,
  SOCIALS, renderSocial, listSocials, prepFor,
};
