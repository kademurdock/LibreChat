/* THE VEIL — the one place that decides what a player is allowed to learn about
 * another person in the city.
 *
 * KADE'S LAW, Sep 21 2026, in her words: "as well as it being a visual sim and
 * a text/sound based moo, the twist is, I had the idea that synth players would
 * inhabit the world alongside soul players. And nobody should ever be able to
 * tell whether the person behind the player is a synth or a soul. With canned
 * responses, people are obviously gonna tell what is who. I don't want players
 * to know who or what is on the other end of that keyboard."
 *
 * WHAT WAS ACTUALLY HAPPENING. Before this file there was no Veil at all —
 * there was a labelled census standing next to a labelled player list, and at
 * least six separate things gave the game away inside the first minute:
 *
 *   1. view.js shipped `kind: 'citizen' | 'player'` to the client, in words.
 *   2. A citizen's people-line was always `Name (doing something)` and an
 *      active human's was always the bare `Name`, because npcDoingNow can
 *      never return empty and nothing ever writes a doing onto a human. That
 *      parenthesis was a perfect oracle sitting in `look` — the most-read line
 *      in the game, and the whole visual field for a blind player.
 *   3. Tapping a name opened a DIFFERENT MENU: a citizen offered "Say hello"
 *      and "Talk to", a human offered Kiss, Fight, Whisper to and Give $5.
 *   4. Ten social verbs in relationships.js read `kind === 'citizen' ? react(…)
 *      : 'one hardcoded sentence'`, so a synth reacted with variety and a soul
 *      got the same sentence forever. `chat` even paid 4 friendship for a
 *      citizen and 5 for a player — measurable with a notepad.
 *   5. `who` answered "just you and 26 citizens going about their day",
 *      partitioning the population out loud and handing you the subtraction.
 *   6. `look <name>` printed a citizen's whole census biography; a human got a
 *      single line.
 *
 * The cruel part is the direction of it: the synths had the reaction banks, the
 * biographies, the schedules, the ambient presence and both speaking verbs, and
 * the souls had none of it. The world told you which was which by making the
 * imaginary people the interesting ones.
 *
 * WHAT THIS FILE DOES. It is deliberately small and boring. It holds the four
 * decisions that have to come out the same for everybody, so that a later edit
 * to one branch cannot quietly reopen the gap:
 *
 *   publicKind   — what the wire is allowed to say a person is
 *   sameGrammar  — the one shape a people-line may take
 *   temperOf     — a temperament for ANYBODY, so reactions vary for souls too
 *   speakableIn  — who the speaking verbs are allowed to find (everyone)
 *
 * WHAT IT DOES NOT HIDE. A stray is a stray, a pet is a pet and a child is a
 * child; those are not Veil questions and the client needs them to draw the
 * scene. The Veil is only ever about the two kinds of PERSON.
 */

/** The only person-kind the wire may carry. Animals and children pass through:
 *  the client draws them differently and nobody is pretending a cat is a soul. */
function publicKind(kind) {
  return kind === 'citizen' || kind === 'player' ? 'person' : kind;
}

/** True if this is one of the two kinds the Veil covers. */
function isPerson(kind) {
  return kind === 'citizen' || kind === 'player' || kind === 'person';
}

/** One line, one grammar, for everybody.
 *
 * The rule that closes the parenthesis tell: a tag is shown when there IS one
 * and left off when there is not, for souls and synths alike. Before this, a
 * citizen always had one and a human never did. */
function sameGrammar(name, tag, { pose = false } = {}) {
  if (!tag) return name;
  return pose ? `${name}, ${tag}` : `${name} (${tag})`;
}

/* A soul has no TEMPER row in relationships.js, which is why every social verb
 * fell back to a hardcoded sentence for humans. A person's manner does not need
 * to be authored to be consistent — it needs to be the SAME every time you meet
 * them. Hashing the id gives exactly that: stable for the life of the
 * character, evenly spread across the four voices, and free. */
/* The four voices relationships.js REACT is actually keyed on. */
const TEMPERS = ['warm', 'gruff', 'cool', 'formal'];
function temperOf(userId, authored) {
  if (authored) return authored;
  const u = String(userId || '');
  let h = 2166136261;
  for (let i = 0; i < u.length; i++) {
    h ^= u.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return TEMPERS[Math.abs(h) % TEMPERS.length];
}

/* The two speaking verbs both filtered `userId: /^npc:/`, so you could only
 * talk to synths — which meant that finding out whether somebody was a soul
 * took one command and no cleverness. This is the query they should use. */
const EVERY_PERSON = { $not: /^(stray|kid|pet):/ };
function speakableIn(roomId, exceptUserId) {
  const q = { roomId, userId: EVERY_PERSON };
  if (exceptUserId) q.userId = { $not: /^(stray|kid|pet):/, $ne: exceptUserId };
  return q;
}

/* ── THE SEVENTH LEAK: EVERY CITIZEN WAS "THEY" ────────────────────────────
 *
 * A player answers `pronouns she|he|they|it` in the creation wizard and the
 * answer lands in attrs.pronouns. The census never had the field, because the
 * census was written before there were two kinds of person to keep apart. So
 * `attrs.pronouns || 'they'` — which is the right default and the right
 * fallback — quietly meant that in the emote substitutions, in the children's
 * roster, and anywhere else the city speaks ABOUT somebody, a synth was always
 * they/them and a soul was whatever they chose. Two `%he` emotes and you knew.
 *
 * The prose already knew. Twenty-four of the twenty-six say it plainly in
 * their own descriptions and ambient lines — "Doc washes HER hands out of
 * habit", "Boone checks HIS watch against the schedule" — and this table is
 * read off that text, not guessed from names. Ilse Marsh and Cass Delaney are
 * they/them because the city has never once said otherwise about them, and
 * that is the author's answer rather than a gap to fill in.
 *
 * It lives here rather than inline in the census because it is a Veil rule and
 * not a fact about any one person: what matters is that the question "what
 * does the city call this person" gets answered the same way for both kinds.
 * The carve writes it onto the MooChar rows so everything downstream reads one
 * field and never has to ask which kind it is holding.
 */
const CITIZEN_PRONOUNS = {
  nell: 'she', pat: 'she', merle: 'he', ines: 'she', dez: 'he',
  ruthann: 'she', levi: 'he', doc: 'she', hock: 'he', boone: 'he',
  marsh: 'they', reed: 'she', odessa: 'she', wendell: 'he', opal: 'she',
  constance: 'she', oleander: 'he', pham: 'she', littleray: 'he', cass: 'they',
  chike: 'he', marva: 'she', royce: 'he', birdie: 'she', emmett: 'he',
  junie: 'she',
};

/** What the city calls this citizen. Accepts 'nell' or 'npc:nell'. */
function pronounsOf(id) {
  return CITIZEN_PRONOUNS[String(id || '').replace(/^npc:/, '')] || null;
}

/* ── THE EIGHTH LEAK: LOOKING AT SOMEBODY HANDED YOU A DOSSIER ─────────────
 *
 * `look <a citizen>` printed their whole census row: five or six sentences
 * covering not only what they are wearing but where their sister lives, what
 * their mother taught them, and what they are quietly afraid of. `look <a
 * soul>` printed the one sentence the creation wizard wrote — build, hair,
 * what they had on. Length alone answered the question, every time, from
 * across the room, for free.
 *
 * Trimming the citizens is the wrong instinct and it is not what this does.
 * The biography is good and the speaking lane needs every word of it. What is
 * wrong is that STRANGERS could read it. You do not learn where somebody's
 * sister lives by looking at them; you learn it by knowing them a while.
 *
 * So what you can see grows with where you stand. A stranger gets what a
 * stranger gets — these descriptions all open with the visible part, because
 * whoever wrote them wrote them in the right order — and the rest arrives as
 * you get to know somebody, which is both the honest rule and a reason to
 * bother. A soul's one line is unaffected, and the two now read alike.
 */
const CLOSE = new Set(['friends', 'close friends', 'like family', 'family', 'partners', 'married']);
const WARM = new Set(['acquaintances', 'exes']);
function visibleDesc(desc, tier) {
  const text = String(desc || '').trim();
  if (!text) return text;
  if (CLOSE.has(tier)) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g);
  if (!sentences || sentences.length <= 2) return text;
  return sentences.slice(0, WARM.has(tier) ? 3 : 2).join('').trim();
}

module.exports = {
  publicKind, isPerson, sameGrammar, temperOf, TEMPERS, EVERY_PERSON, speakableIn,
  CITIZEN_PRONOUNS, pronounsOf, visibleDesc,
};
