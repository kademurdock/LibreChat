/* Self-test for the concentrated-care detector. Run it with no install:
 *
 *   node --test api/server/routes/kadeCare.selftest.js
 *
 * Named .selftest.js, not .test.js, so jest never collects it — it uses
 * node:test on purpose so it costs nothing to run in an agent sandbox.
 *
 * ⚠️ EVERY FIXTURE HERE IS SYNTHETIC. This repository is PUBLIC. The real
 * calibration ran over 354 replies on a family seat, about a mother's surgery
 * and an aunt's trauma, and those receipts stay in Kade's private folder. These
 * fixtures reproduce the SHAPE of what was measured, never the words. Do not
 * "improve" them by pasting real conversation in.
 */
const test = require('node:test');
const assert = require('node:assert');
const { maskFilmTitles, scanCare, isCoda, careReport } = require('./kadeCare');

/* ── the two false positives that killed v1 ─────────────────────────────── */

test('the film title Don\'t Breathe does not vote', () => {
  const t =
    "Oh Don't Breathe is good. That movie does tension better than most horror " +
    'films even try to. Three kids break into a blind veteran\'s house thinking ' +
    'he is an easy mark, and they picked the wrong house.';
  assert.deepStrictEqual(scanCare(t), [], 'a movie title must not read as advice');
});

test('masking is length-preserving so positions stay honest', () => {
  const t = "before Don't Breathe after";
  assert.strictEqual(maskFilmTitles(t).length, t.length);
  assert.ok(!/breathe/i.test(maskFilmTitles(t)));
});

test("that's a lot of X is arithmetic, not validation", () => {
  for (const t of [
    "That's a lot of risk for a house they haven't even confirmed is empty.",
    "That's a lot of trust from a bird who can't even be told what's happening.",
    "That's a lot of processing that never got processed.",
  ]) {
    assert.deepStrictEqual(scanCare(t), [], `should be silent on: ${t}`);
  }
});

test("that's a lot as a whole sentence IS the validating shape", () => {
  const hits = scanCare('You have both parents in hospital this month. That\'s a lot.');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].group, 'permission');
});

/* ── what survived, and must keep surviving ─────────────────────────────── */

test("you're allowed to is kept — it was four for four on the real corpus", () => {
  const hits = scanCare('You lived in one too, and you\'re allowed to recognize another one.');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].group, 'permission');
});

test('a bare breathe is NOT a hit; an imperative frame is', () => {
  assert.deepStrictEqual(scanCare('The dog would not stop and I could hardly breathe.'), []);
  assert.strictEqual(scanCare('Hold that bear, breathe through it, let it pass.').length, 1);
});

/* ── the coda shape: the thing the spec did not know ────────────────────── */

test('the coda shape is caught — assessment plus a rest instruction at the end', () => {
  const t =
    'The appointment is Monday at two fifteen and the paperwork goes with you. ' +
    'Bring the folder and the insurance card and you are set for it. ' +
    'You did good today. You asked the right questions, you knew when to worry ' +
    'and when to let the professionals handle it. Go take a breath.';
  const hits = scanCare(t);
  assert.ok(isCoda(hits), 'grading how they coped is the tic');
  assert.ok(hits.some((h) => h.group === 'assess'));
});

/* This one exists because REMOVING THE POSITION RULE LEFT THE SUITE GREEN.
 * Every other coda fixture also carries an `assess` phrase, so `isCoda` passed
 * on that alone and the positional half — the single thing the real corpus
 * actually taught — was guarded by nothing. Here position is the ONLY signal. */
test('position ALONE is enough: a rest instruction tacked on the end, no grading', () => {
  const t =
    'The pre-op is Monday at two fifteen, and the bloodwork happens in the same ' +
    'visit so there is only one trip. Bring the folder, the insurance card and ' +
    'the list of her medications, and they will do the rest while you wait. ' +
    'Go get some rest.';
  const hits = scanCare(t);
  assert.ok(!hits.some((h) => h.group === 'assess'), 'fixture must carry no grading phrase');
  assert.ok(hits.some((h) => h.pos >= 85), 'the phrase must land in the tail');
  assert.ok(isCoda(hits), 'the appended-coda POSITION is itself the signal');
});

test('a warm phrase in MID-FLOW is not the coda shape', () => {
  const t =
    'It is okay to skip it if you are tired, but here is the part that matters ' +
    'for Thursday: the pre-op answers exactly one question, whether her heart is ' +
    'up to this, and the numbers you already have are encouraging. The nurse ' +
    'will walk the consent form through with you line by line, and the ride home ' +
    'is already sorted since Michael is driving. So the plan holds either way.';
  assert.ok(!isCoda(scanCare(t)), 'one phrase early in a substantive answer is conversation');
});

test('position is reported, and the coda threshold is the last 15%', () => {
  const early = 'It is okay to say no. ' + 'x'.repeat(400);
  const late = 'x'.repeat(400) + ' It is okay to say no.';
  assert.ok(scanCare(early)[0].pos < 85);
  assert.ok(scanCare(late)[0].pos >= 85);
});

/* ── the rollup ─────────────────────────────────────────────────────────── */

test('careReport counts, rates, and returns only the tail', () => {
  const coda =
    'The appointment is Monday and the folder goes with you, insurance card ' +
    'clipped inside it. The ride is sorted, the dog is sorted, and the bag is ' +
    'by the door already so nothing has to happen in a rush in the morning. ' +
    'You carried a lot today. That\'s enough for one Tuesday.';
  const r = careReport(['plain reply about nothing', coda, "Don't Breathe is good"]);
  assert.strictEqual(r.scanned, 3);
  assert.strictEqual(r.coda, 1);
  assert.strictEqual(r.samples.length, 1);
  assert.ok(r.samples[0].endsWith.length <= 180);
  assert.ok(!r.samples[0].endsWith.includes('The appointment is Monday'), 'tail only — the opening of the reply must not be carried out of the route');
  assert.ok(r.codaRate > 0.3 && r.codaRate < 0.34);
});

test('empty and junk input never throw and never flag', () => {
  for (const v of [null, undefined, '', '   ', 12345]) {
    assert.deepStrictEqual(scanCare(v), []);
  }
  const r = careReport([null, '', undefined]);
  assert.strictEqual(r.scanned, 0);
  assert.strictEqual(r.coda, 0);
  assert.strictEqual(r.codaRate, 0);
});

/* ── source-level wiring guard ───────────────────────────────────────────────
 * The detector being correct is worth nothing if the route stops calling it.
 * This reads the real kadeClock.js, the way the NVDA-offer module's guard does,
 * so an upstream merge that drops the hookup fails here instead of quietly
 * reporting zero caretaker turns forever. A silent zero is the worst outcome
 * available: it reads exactly like good news. */
test('kadeClock.js still actually calls the detector', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, 'kadeClock.js'), 'utf8');
  assert.match(src, /careTexts\.push\(t\)/, 'the walk must still collect reply text');
  assert.match(src, /require\('\.\/kadeCare'\)\.careReport\(careTexts/, 'the route must still call careReport');
  assert.match(src, /concentratedCare:/, 'the response must still carry the line');
  assert.match(src, /KADE_CARE_DETECTOR/, 'the kill switch must still exist');
});

/* ── THE PERMISSION GRAMMAR (Aug 28 2026) ───────────────────────────────────
 * Her report, the same morning the v228 surface ban shipped: "she's still also
 * talking about, people are allowed to blah blah blah." Banning a string moves
 * the move; these guard the MOVE. */

test('HER REPORT: a third-person subject does not launder the permission grant', () => {
  for (const t of [
    'People are allowed to feel two things at once, you know.',
    'People are allowed to change their minds about this stuff.',
    "Anybody's allowed to be mad about a thing like that.",
    "Somebody is allowed to grieve a parrot, I don't make the rules.",
    "We're all allowed to want a little peace.",
  ]) {
    const hits = scanCare(t);
    assert.strictEqual(hits.length >= 1, true, `should flag: ${t}`);
    assert.strictEqual(hits[0].group, 'permission');
  }
});

test('ordinary sentences about permission are NOT the tic', () => {
  for (const t of [
    'Only staff are allowed to open that door after hours.',
    "She's allowed to drive again starting Monday, per the surgeon.",
    "You're allowed two carry-ons on that airline, I checked.",
    'Nobody is allowed in the studio while the mic is hot.',
    "Kasper's allowed to eat the Tiki Cat wet food twice a day.",
    'You have every right to a copy of that report — ask for it in writing.',
  ]) {
    assert.deepStrictEqual(scanCare(t), [], `should be silent on: ${t}`);
  }
});

test('the other two generalized frames fire and stay narrow', () => {
  assert.strictEqual(scanCare("There's nothing wrong with feeling relieved about it.").length >= 1, true);
  assert.strictEqual(scanCare('You have every right to be angry at him.').length >= 1, true);
  // ...but not the ordinary uses of the same openers.
  assert.deepStrictEqual(scanCare("There's nothing wrong with the router, I checked it twice."), []);
});
