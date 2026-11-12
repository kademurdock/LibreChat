/* Nov 12 2026 (audit SEC-8): a day's paid slot is taken before the first await and given back
 * when that attempt fails, so requests fired together cannot all pass the daily cap. The real
 * takeSlot runs here, cut from the route file; nothing paid is called.
 * Run: node --test api/server/routes/kadeCreateCharacter.slots.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'kadeCreateCharacter.js'), 'utf8');
function load(now = () => new Date('2026-11-12T18:00:00Z')) {
  const start = source.indexOf('const centralDay = ');
  const end = source.indexOf('const takePortraitSlot', start);
  assert.ok(start > 0 && end > start, 'takeSlot is where the test expects it');
  const clock = { now };
  const c = {
    Intl,
    Map,
    String,
    Math,
    Date: class extends Date {
      constructor(...a) {
        super(...(a.length ? a : [clock.now()]));
      }
    },
  };
  vm.runInNewContext(source.slice(start, end) + '\nthis.takeSlot = takeSlot; this.easel = easel;', c);
  return { takeSlot: c.takeSlot, clock };
}

test('ten takers at once against a cap of eight: eight slots, two refusals, count eight', async () => {
  const { takeSlot } = load();
  const desk = { day: '', counts: new Map() };
  const answers = await Promise.all(
    Array.from({ length: 10 }, async () => {
      const slot = takeSlot(desk, 'u1', 8);
      await new Promise((r) => setTimeout(r, 5)); // the long picture wait
      return slot ? 200 : 429;
    }),
  );
  assert.equal(answers.filter((a) => a === 200).length, 8);
  assert.equal(answers.filter((a) => a === 429).length, 2);
  assert.equal(desk.counts.get('u1'), 8);
});

test('failures give their slot back; a double release drops once; left() counts down', () => {
  const { takeSlot } = load();
  const desk = { day: '', counts: new Map() };
  for (let i = 0; i < 10; i++) takeSlot(desk, 'u1', 12).release();
  assert.equal(desk.counts.get('u1'), 0);
  const a = takeSlot(desk, 'u1', 12);
  const b = takeSlot(desk, 'u1', 12);
  assert.equal(b.left(), 10);
  a.release();
  a.release();
  assert.equal(desk.counts.get('u1'), 1);
  assert.equal(b.left(), 11);
});

test('a day change between take and release leaves the new day alone', () => {
  const { takeSlot, clock } = load();
  const desk = { day: '', counts: new Map() };
  const slot = takeSlot(desk, 'u1', 8);
  clock.now = () => new Date('2026-11-13T18:00:00Z');
  const fresh = takeSlot(desk, 'u1', 8);
  assert.equal(desk.counts.get('u1'), 1, 'the new day starts from zero');
  slot.release();
  assert.equal(desk.counts.get('u1'), 1, "yesterday's slot does not come off today's count");
  assert.ok(fresh);
});

test('both portrait doors share one easel, and no stale counter is left in the route file', () => {
  assert.doesNotMatch(source, /genCounts|genDayStamp|personaCounts|personaDayStamp/);
  assert.match(source, /slot = takePortraitSlot\(req\.user\.id\);/);
  assert.match(source, /slot = takeSlot\(writingDesk, req\.user\.id, PERSONA_DAILY_CAP\);/);
  assert.match(source, /remainingToday: slot\.left\(\),/);
  const kade = fs.readFileSync(path.join(__dirname, 'kade.js'), 'utf8');
  const at = kade.indexOf("router.post('/avatar-generate'");
  assert.match(kade.slice(at, at + 2000), /slot = takePortraitSlot\(uid\);/);
  const face = fs.readFileSync(path.join(__dirname, 'kadeLiveFace.js'), 'utf8');
  assert.match(face, /held\.forEach\(\(k\) => building\.delete\(k\)\)/);
});
