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

module.exports = { publicKind, isPerson, sameGrammar, temperOf, TEMPERS, EVERY_PERSON, speakableIn };
