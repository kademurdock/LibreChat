/**
 * Library consultation (agents asking Mrs. Witherspoon). Run from the fork root:
 *   node --import tsx --test packages/api/src/library/consultation.test.ts
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { MAX_SUBAGENTS } from 'librechat-data-provider';
import {
  CONSULTATION_MAX_TURNS,
  CONSULTATION_TOOLS,
  _resetConsultationForTests,
  consultationDescription,
  consultationInstructions,
  consultationToolsFor,
  isLibraryConsultant,
  libraryConsultation,
  libraryShapedTurn,
  wantsLibraryConsultation,
  withoutPerformance,
} from './consultation';
import type { ConsultationTurn } from './consultation';

const LIBRARIAN = 'agent_o7TKU3lK0Euo0MKgpNpvZ';
const KIANA = 'agent_kiana';
const env: Record<string, string | undefined> = {};

const turn = (overrides: Partial<ConsultationTurn> = {}): ConsultationTurn => ({
  agentId: KIANA,
  text: 'Can you ask the librarian for old books by Catherine Applegate?',
  conversationId: 'convo-1',
  env,
  ...overrides,
});

beforeEach(() => _resetConsultationForTests());

test('library, book and media turns bring the librarian along', () => {
  const asks = [
    'What old books do you have by Catherine Applegate?',
    'Can you ask Mrs. Witherspoon about the making out books?',
    'Is there an audiobook of Holes in the library?',
    'Recommend me a good book for a rainy night',
    'Who wrote Where the Red Fern Grows?',
    'I remember an old commercial with dancing raisins',
    'that old radio show about a haunted lighthouse',
    'Do we have any VHS tapes from the 90s?',
    'any cassettes of KWTO airchecks?',
    "I can't remember the name of a cartoon from when I was little",
    "I'm looking for an old movie with a talking car",
    'Do we have that movie about the dog who plays basketball?',
    'Did my library request get filled yet?',
    'Could you add Animorphs to the library?',
    'Is there a Bookshare book I could listen to?',
    '%%%curious%%% any 80s ads on the shelves?',
  ];
  for (const text of asks) {
    assert.equal(libraryShapedTurn(text), true, text);
  }
});

test('ordinary chat does not carry the consultation', () => {
  const chat = [
    'Good night Kiana, love you',
    'Tell me a joke',
    "What's the weather tomorrow?",
    'Can you book a table for two at seven?',
    'I booked the flight to Tulsa',
    'I saw it on Facebook this morning',
    'my notebook died again',
    'Do you have any plans this weekend?',
    'Remind me to call Mom at five',
    'Play blackjack with me',
    'What do you think of the new iPhone?',
    'I need a feature request filed for the app',
    '',
  ];
  for (const text of chat) {
    assert.equal(libraryShapedTurn(text), false, text);
  }
  assert.deepEqual(wantsLibraryConsultation(turn({ text: 'Tell me a joke' })), {
    attach: false,
    reason: 'off-topic',
  });
});

test('never on the librarian herself, and every opt-out is honoured', () => {
  assert.equal(isLibraryConsultant(LIBRARIAN), true);
  assert.equal(isLibraryConsultant(KIANA), false);
  const cases: Array<[Partial<ConsultationTurn>, string]> = [
    [{ agentId: LIBRARIAN }, 'librarian'],
    [{ env: { KADE_LIBRARY_CONSULTATION: '0' } }, 'off'],
    [{ ephemeral: true }, 'ephemeral'],
    [{ toolless: true }, 'no-tools-model'],
    [{ morningBrief: true }, 'morning-brief'],
    [{ instructions: 'KADE BARE PROBE: answer one sentence' }, 'bare-probe'],
    [{ configured: { enabled: false } }, 'disabled-in-builder'],
    [{ env: { KADE_LIBRARY_CONSULTATION_AGENTS: 'agent_other' } }, 'not-listed'],
    [{ env: { KADE_LIBRARY_CONSULTATION_SKIP_AGENTS: `x, ${KIANA}` } }, 'skip-listed'],
  ];
  for (const [overrides, reason] of cases) {
    assert.deepEqual(wantsLibraryConsultation(turn(overrides)), { attach: false, reason }, reason);
  }
  assert.deepEqual(
    wantsLibraryConsultation(turn({ env: { KADE_LIBRARY_CONSULTATION_AGENTS: KIANA } })),
    { attach: true, reason: 'topic' },
  );
});

test('once asked in a conversation, the consultation stays for its follow-ups', () => {
  const start = 1_000_000;
  assert.deepEqual(wantsLibraryConsultation(turn({ now: start })), { attach: true, reason: 'topic' });
  assert.deepEqual(wantsLibraryConsultation(turn({ text: 'The second one please', now: start + 1 })), {
    attach: true,
    reason: 'sticky',
  });
  /* regenerate or edit: no text, still the same conversation */
  assert.equal(wantsLibraryConsultation(turn({ text: undefined, now: start + 2 })).attach, true);
  /* another conversation, another agent in the same conversation, and a placeholder id */
  assert.equal(
    wantsLibraryConsultation(turn({ text: 'The second one', conversationId: 'convo-2', now: start })).attach,
    false,
  );
  assert.equal(
    wantsLibraryConsultation(turn({ agentId: 'agent_forge', text: 'The second one', now: start })).attach,
    false,
  );
  wantsLibraryConsultation(turn({ conversationId: 'new', now: start }));
  assert.equal(
    wantsLibraryConsultation(turn({ conversationId: 'new', text: 'The second one', now: start })).attach,
    false,
  );
  /* 48 hours later the conversation has to ask again */
  const later = start + 48 * 60 * 60 * 1000 + 1;
  assert.equal(wantsLibraryConsultation(turn({ text: 'The second one', now: later })).attach, false);
});

test('the consultation joins configured specialists instead of replacing them', () => {
  assert.equal(libraryConsultation(LIBRARIAN, undefined), undefined);
  assert.deepEqual(libraryConsultation(KIANA, undefined), {
    enabled: true,
    allowSelf: false,
    agent_ids: [LIBRARIAN],
  });
  assert.deepEqual(libraryConsultation(KIANA, { enabled: false }), { enabled: false });
  assert.deepEqual(
    libraryConsultation(KIANA, { enabled: true, allowSelf: false, agent_ids: ['agent_forge'] }),
    { enabled: true, allowSelf: false, agent_ids: ['agent_forge', LIBRARIAN] },
  );
  const already = { enabled: true, agent_ids: [LIBRARIAN] };
  assert.equal(libraryConsultation(KIANA, already), already);
  const full = {
    enabled: true,
    agent_ids: Array.from({ length: MAX_SUBAGENTS }, (_, i) => `agent_${i}`),
  };
  assert.equal(libraryConsultation(KIANA, full), full);
  /* a record that was never switched on is replaced, not merged */
  assert.deepEqual(libraryConsultation(KIANA, { agent_ids: ['agent_forge'] }), {
    enabled: true,
    allowSelf: false,
    agent_ids: [LIBRARIAN],
  });
});

test('voice and scene markup is removed; links and bracketed prose stay', () => {
  assert.equal(
    withoutPerformance(
      '%%%warm and bookish%%% I found [Holes](/library/item/1).\n\n[[chamomile]] %%%reset%%% It is [a handwritten note]. [sound: page turn]hidden',
    ),
    'I found [Holes](/library/item/1).\n\nIt is [a handwritten note].',
  );
  assert.equal(withoutPerformance('Stray %%% marker'), 'Stray marker');
  assert.equal(withoutPerformance(''), '');
});

test('the consulted librarian is told who asked and to answer in plain notes', () => {
  const persona = 'You are Mrs. Olivia Witherspoon.';
  const text = consultationInstructions(persona, 'Kiana');
  assert.ok(text.startsWith(persona));
  assert.match(text, /Kiana/);
  assert.match(text, /plain notes/);
  assert.match(text, /own library access/);
  assert.doesNotMatch(text, /%%%|\[\[/);
  assert.match(consultationInstructions(persona, ''), /another character/);
  assert.equal(CONSULTATION_MAX_TURNS, 6);
});

test('the calling agent sees one short description, not a standing instruction block', () => {
  const description = consultationDescription();
  assert.ok(description.length < 900, `${description.length} characters`);
  assert.match(description, /own library access/);
  assert.match(description, /exact Library links/);
  assert.match(description, /paid research/);
  assert.doesNotMatch(description, /%%%|\[\[/);
});

test('a consultation is read-only: catalog, details, background and help', () => {
  assert.deepEqual([...CONSULTATION_TOOLS].sort(), ['kade_help', 'kade_library', 'kade_wikipedia']);
  assert.deepEqual(
    consultationToolsFor([
      'kade_library',
      'kade_library_requests',
      'kade_research',
      'kade_wikipedia',
      'kade_help',
      'kade_call_me',
      'kade_message',
      'kade_feedback',
    ]),
    ['kade_library', 'kade_wikipedia', 'kade_help'],
  );
  assert.deepEqual(consultationToolsFor(undefined), []);
});
