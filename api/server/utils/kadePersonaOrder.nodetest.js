/* THE PERSONA GOES LAST (Sep 21 2026) — the contract, held by a test.
 *
 * Kade: "You can fix the persona thing house voice etc. I care about prompt
 * caching more than safety presidence lol. There is only one single kid on my
 * platform right now and she's 12."
 *
 * The head in controllers/agents/client.js used to open with the persona and
 * put ~4,545 tokens of house machinery after it. It now opens with the house
 * block and ends with the persona, so the character is the thing closest to
 * the conversation.
 *
 * The audience notes ride INSIDE agent.instructions (build.js appends them
 * there), so they moved with it — from in front of the platform note to
 * behind it. That makes the child note later and therefore weighted harder.
 * The one thing that must stay true is that the platform note yields to it in
 * WORDS and never by position, because position is now the opposite of what
 * the old comment described. That is what these tests hold.
 *
 * Run: node --test api/server/utils/kadePersonaOrder.nodetest.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { KADE_PLATFORM_NOTE } = require('./kadePlatformNote');
const CLIENT = fs.readFileSync(
  path.join(__dirname, '..', 'controllers', 'agents', 'client.js'),
  'utf8',
);
const BUILD = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'Endpoints', 'agents', 'build.js'),
  'utf8',
);

test('the hard line still yields to an audience note, and does it in words', () => {
  assert.ok(
    /audience note outranks every word of this paragraph/.test(KADE_PLATFORM_NOTE),
    'the platform note stopped yielding to the audience note',
  );
  assert.ok(
    /wherever in these instructions it appears/.test(KADE_PLATFORM_NOTE),
    'the yield is not stated as position-independent, which it now has to be',
  );
  assert.ok(
    /nothing that sexualizes or harms a minor/.test(KADE_PLATFORM_NOTE),
    'the one hard line went missing',
  );
});

test('nothing in the platform note claims the audience note comes before it', () => {
  /* The old sentence was "that note is appended BEFORE this one". After the
   * reorder that is false, and a false claim in a safety paragraph is worse
   * than no claim. */
  const body = KADE_PLATFORM_NOTE;
  assert.ok(!/appended BEFORE this one/.test(body), body.slice(0, 80));
  assert.ok(!/(above|earlier|preceding)\s+audience note/i.test(body));
});

test('the audience notes still ride inside agent.instructions, so they move with the persona', () => {
  assert.ok(
    /agent\.instructions\s*=\s*agent\.instructions\s*\+\s*KADE_CHILD_NOTE/.test(BUILD),
    'the child note is no longer appended to agent.instructions; the ordering reasoning no longer holds',
  );
  assert.ok(/kadeAccountType === 'child'/.test(BUILD), 'the child gate moved');
});

test('the persona is pushed LAST and the house block is built first', () => {
  const declare = CLIENT.indexOf('const headParts = personaLast ? [] : [personaBlock];');
  const pushPersona = CLIENT.indexOf('headParts.push(personaBlock);');
  const join = CLIENT.indexOf('agent.instructions = headParts.filter(Boolean).join(');
  const platform = CLIENT.indexOf('headParts.push(KADE_PLATFORM_NOTE);');
  assert.ok(declare > -1, 'the persona-last head assembly is gone');
  assert.ok(platform > declare, 'the platform note is not pushed after the head starts');
  assert.ok(pushPersona > platform, 'the persona is pushed before the platform note');
  assert.ok(join > pushPersona, 'the head is joined before the persona is added');
});

test('there is a kill switch and it defaults to on', () => {
  assert.ok(
    /const personaLast = process\.env\.KADE_PERSONA_LAST !== '0';/.test(CLIENT),
    'KADE_PERSONA_LAST is missing or does not default to on',
  );
});

test('the guards that read agent.instructions still see the persona, not a rebuilt head', () => {
  /* isBareProbe and the double-append guard both test agent.instructions.
   * They run BEFORE the join, so they must still be looking at the untouched
   * persona. If the join ever moves above them they would silently stop
   * matching, and a bare probe would start carrying the whole wardrobe. */
  const join = CLIENT.indexOf('agent.instructions = headParts.filter(Boolean).join(');
  const bareProbe = CLIENT.indexOf("includes('KADE BARE PROBE')", CLIENT.indexOf('const personaLast'));
  /* Part 293: the guard is carriesPlatformNote now; the old 'PLATFORM (invisible'
   * check matched an opener the note had dropped, so it never fired. */
  const doubleGuard = CLIENT.indexOf('!carriesPlatformNote(agent.instructions)');
  assert.ok(bareProbe > -1 && bareProbe < join, 'the bare-probe guard now runs after the head is rebuilt');
  assert.ok(doubleGuard > -1 && doubleGuard < join, 'the double-append guard now runs after the head is rebuilt');
});

test('the head still composes to every part, in the new order', () => {
  /* A stand-in for the assembly, so the contract is asserted rather than
   * described: same filter(Boolean), same join, persona last. */
  const compose = (persona, house, personaLast) => {
    const parts = personaLast ? [] : [persona];
    parts.push(...house);
    if (personaLast) {
      parts.push(persona);
    }
    return parts.filter(Boolean).join('\n\n');
  };
  const house = ['PLATFORM', 'WORLD', 'MEMORY'];
  const on = compose('PERSONA', house, true);
  const off = compose('PERSONA', house, false);
  assert.strictEqual(on, 'PLATFORM\n\nWORLD\n\nMEMORY\n\nPERSONA');
  assert.strictEqual(off, 'PERSONA\n\nPLATFORM\n\nWORLD\n\nMEMORY');
  /* Every part survives either way -- a reorder that drops something is the
   * failure that would be hardest to notice. */
  for (const head of [on, off]) {
    for (const part of ['PERSONA', ...house]) {
      assert.ok(head.includes(part), part);
    }
  }
  /* An empty persona must not leave a hanging separator. */
  assert.strictEqual(compose('', house, true), 'PLATFORM\n\nWORLD\n\nMEMORY');
});
