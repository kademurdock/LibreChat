/* Family history words (Sep 29 2026, docs/FAMILY_HISTORY.md): every visible and spoken sentence
 * the app shows is written on the server, so these builders are checked one by one.
 * THE REPOSITORY IS PUBLIC: every name and place here is made up.
 * Run from the repo root:
 * node --require <tsx cjs register> --test packages/api/src/family/words.test.ts */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FAMILY_HISTORY_EVENTS,
  familyChain,
  familyCleanTerm,
  familyDescendantName,
  familyGenerationName,
  familyLadder,
  familyList,
  familyListenTime,
  familyLivedThrough,
  familyNutshell,
  familyOrdinal,
  familyPageSpoken,
  familyPercent,
  familyProof,
  familyShare,
  familySideText,
  familySpoken,
  familySpokenPerson,
  familySpokenProblems,
  familyTermText,
  familyVoice,
  familyYearsText,
} from './words';
import { familyDate, familyFirstName, familyInitials, familyInt, familyRandom, familyShuffle } from './util';
import { familyBirthPlace, familyDayGap, familyIsoWeek, familyRegion } from './derive';

const mine = familyVoice('Ada', 'F', false);
const borrowed = familyVoice('Ada', 'F', true);

test('spoken text: no dashes, dots, arrows or shouted words; numbers and abbreviations read right', () => {
  assert.equal(familySpoken('1850–1921 · Mom’s side'), '1850 to 1921, Mom’s side');
  assert.equal(familySpoken('your father -> his father'), 'your father, then his father');
  assert.equal(familySpoken('EXAMPLE family in the USA, 95% sure ▶'), 'Example family in the USA, 95 percent sure');
  assert.equal(familySpoken('A — B'), 'A, B');
  assert.deepEqual(familySpokenProblems('Fine words, DNA and USA.'), []);
  assert.deepEqual(familySpokenProblems('1850–1921'), ['symbol']);
  assert.deepEqual(familySpokenProblems('YOU are NOT'), ['YOU', 'NOT']);
});

test('terms: said from the viewer, or in the owner\'s words for a guest; view files lose their years', () => {
  assert.equal(familyTermText('grandmother', 'ancestor', mine), 'your grandmother');
  assert.equal(familyTermText('grandmother', 'ancestor', borrowed), 'Ada’s grandmother');
  assert.equal(familyTermText('you', 'self', mine), 'you');
  assert.equal(familyTermText('you', 'self', borrowed), 'Ada');
  assert.equal(familyTermText('wife of your uncle, Ned Example (1958-2018)', 'marriage', mine), 'wife of your uncle, Ned Example');
  assert.equal(familyTermText('wife of your uncle, Ned Example (Living)', 'marriage', borrowed), 'wife of Ada’s uncle, Ned Example');
  assert.equal(familyTermText('', 'blood', mine), null);
  assert.equal(familyCleanTerm('husband of your daughter, Ada Example (born 1990)'), 'husband of your daughter, Ada Example');
});

test('sides and proof: always in words, one proof scale', () => {
  assert.equal(familySideText('mother', mine), 'Mom’s side');
  assert.equal(familySideText('father', borrowed), 'Ada’s dad’s side');
  assert.equal(familySideText('both', mine), 'Both sides');
  assert.equal(familySideText('marriage', mine), 'By marriage');
  assert.equal(familySideText(null, mine), null);
  assert.deepEqual(familyProof('records'), { level: 'records', text: 'Proven by records', spoken: 'Proven by records' });
  assert.deepEqual(familyProof('dna', 'about 90 to 95% sure'), {
    level: 'dna',
    text: 'Strong DNA evidence (about 90 to 95% sure)',
    spoken: 'Research finding, strong DNA evidence, about 90 to 95 percent sure, not proven by records',
  });
  assert.equal(familyProof('dna', 'strong').text, 'Strong DNA evidence', 'a band with no figure adds nothing');
  assert.equal(familyProof('guess').spoken, 'Research finding, a best guess, not proven by records');
  for (const level of ['records', 'dna', 'guess'] as const) {
    const proof = familyProof(level, 'about 1 to 2%');
    assert.deepEqual(familySpokenProblems(proof.spoken), []);
    assert.doesNotMatch(proof.text, /\b(confirmed|not proven)\b/i, 'the proof scale never says those words alone');
  }
});

test('years, spoken people, chains and ladders', () => {
  assert.deepEqual(familyYearsText(familyDate('1850'), familyDate('abt 1921'), false), { years: '1850–about 1921', spoken: '1850 to about 1921' });
  assert.deepEqual(familyYearsText(familyDate('1990'), familyDate(null), true), { years: 'born 1990', spoken: 'born 1990' });
  assert.deepEqual(familyYearsText(familyDate(null), familyDate('1920'), false), { years: 'died 1920', spoken: 'died 1920' });
  assert.deepEqual(familyYearsText(familyDate(null), familyDate(null), false), { years: null, spoken: null });
  assert.equal(
    familySpokenPerson({ name: 'Ada Example', term: 'your 2nd great-grandmother', yearsSpoken: '1850 to 1921', sideText: 'Mom’s side', proof: familyProof('dna', 'about 90 to 95% sure') }),
    'Your 2nd great-grandmother, Ada Example, 1850 to 1921, Mom’s side. Research finding, strong DNA evidence, about 90 to 95 percent sure, not proven by records.',
  );
  const up = (sex: string) => ({ up: true, sex });
  assert.equal(familyChain([up('F'), up('F'), up('M')], mine), 'your mom’s mom’s dad');
  assert.equal(familyChain([up('F'), up('M')], borrowed), 'Ada’s mom’s dad');
  assert.equal(familyChain([up('F')], mine), null, 'one step needs no chain');
  assert.equal(familyChain([up('F'), up('F'), up('F'), up('F')], mine), null, 'four steps: the ladder instead');
  assert.equal(familyChain([up('F'), { up: false, sex: 'M' }], mine), null, 'not a straight line');
  assert.deepEqual(familyLadder([up('F'), up('F'), up('M'), up('M')], mine), ['You', 'Mom', 'Grandma', 'Her dad', 'His dad']);
  assert.deepEqual(familyLadder([{ up: false, sex: 'F' }, { up: false, sex: 'M' }], mine), ['You', 'Daughter', 'Grandson']);
});

test('a life in a nutshell and what they lived through', () => {
  assert.equal(
    familyNutshell({
      birth: { year: 1850, approx: false, place: 'Invented Town' },
      death: { year: 1918, approx: false, place: 'Invented City' },
      living: false,
      marriedAt: 21,
      children: 7,
      moved: { place: 'Invented City', year: 1880 },
    }),
    'Born in 1850 in Invented Town. Married at 21 and raised 7 children. Moved to Invented City by 1880 and died there at 68.',
  );
  assert.equal(
    familyNutshell({ birth: { year: 1990, approx: false, place: null }, death: null, living: true, marriedAt: null, children: 1, moved: null }),
    'Born in 1990. Had a child.',
  );
  assert.equal(familyNutshell({ birth: null, death: null, living: false, marriedAt: null, children: 0, moved: null }), null);
  assert.equal(familyLivedThrough(familyDate('1805'), familyDate('1870'), false, 2026), 'Born 1805; lived through the War of 1812, the Gold Rush and the Civil War.');
  assert.equal(familyLivedThrough(familyDate('2001'), familyDate(null), true, 2026), null);
  assert.equal(familyLivedThrough(familyDate(null), familyDate('1900'), false, 2026), null);
  for (const event of FAMILY_HISTORY_EVENTS) {
    assert.ok(event.from <= event.to, event.key);
    assert.deepEqual(familySpokenProblems(event.line(12, 'your')), [], event.key);
    assert.match(event.line(1, 'your'), /^1 of your ancestors was /);
  }
});

test('counts, generations, pages and shares', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(familyOrdinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
  assert.deepEqual([1, 2, 3, 4, 7].map(familyGenerationName), ['Parents', 'Grandparents', 'Great-grandparents', '2nd great-grandparents', '5th great-grandparents']);
  assert.deepEqual([1, 2, 3, 4].map(familyDescendantName), ['Children', 'Grandchildren', 'Great-grandchildren', '2nd great-grandchildren']);
  assert.equal(familyPageSpoken(48, 48, 250), 'Showing 49 to 96 of 250');
  assert.equal(familyPageSpoken(0, 0, 0), 'Nothing to show yet');
  assert.equal(familyShare(3), '1 in 8');
  assert.deepEqual([0.5, 0.125, 0.03125, 0.0078125].map(familyPercent), ['about 50%', 'about 12.5%', 'about 3%', 'less than 1%']);
  assert.equal(familyListenTime(18000), 'About 18 minutes');
  assert.equal(familyListenTime(400), 'Under a minute');
  assert.equal(familyListenTime(95000), 'About 1 hour and 35 minutes');
  assert.equal(familyList(['A', 'B', 'C']), 'A, B and C');
});

test('dates, names, places and small helpers', () => {
  assert.deepEqual(familyDate('3 Mar 1960'), { year: 1960, month: 3, day: 3, approx: false });
  assert.deepEqual(familyDate('abt 1900'), { year: 1900, month: null, day: null, approx: true });
  assert.deepEqual(familyDate('12/25/1899'), { year: 1899, month: 12, day: 25, approx: false });
  assert.deepEqual(familyDate('Bet 1850 and 1855'), { year: 1850, month: null, day: null, approx: true });
  assert.deepEqual(familyDate('unknown'), { year: null, month: null, day: null, approx: false });
  assert.equal(familyFirstName('  Ada Mae Example '), 'Ada');
  assert.equal(familyFirstName(''), 'Someone');
  assert.equal(familyInitials('Ada Mae Example'), 'AE');
  assert.equal(familyInitials(''), '?');
  assert.equal(familyInt('7', 5, 1, 10), 7);
  assert.equal(familyInt('99', 5, 1, 10), 10);
  assert.equal(familyInt(undefined, 5, 1, 10), 5);
  assert.deepEqual(familyRegion('Invented Town, Invented County, Vermont, USA'), { name: 'Vermont', abroad: false });
  assert.deepEqual(familyRegion('Invented Village, Finland'), { name: 'Finland', abroad: true });
  assert.deepEqual(familyRegion('Invented Town, VT'), { name: 'Vermont', abroad: false });
  assert.equal(familyRegion('Invented Town'), null);
  assert.equal(familyBirthPlace({ id: 'x', name: 'X', label: 'X', facts: [{ type: 'CHR', place: 'Invented Church, Ohio' }] }), 'Invented Church, Ohio');
  assert.equal(familyIsoWeek(Date.parse('2026-09-29T12:00:00Z')), '2026-W40');
  assert.equal(familyDayGap({ month: 12, day: 30 }, { month: 1, day: 2 }), 3, 'the short way round the new year');
  const a = familyShuffle([1, 2, 3, 4, 5], familyRandom(7));
  assert.deepEqual(familyShuffle([1, 2, 3, 4, 5], familyRandom(7)), a, 'the same seed, the same order');
  assert.deepEqual([...a].sort(), [1, 2, 3, 4, 5]);
});
