/* The errands are a PURE function, which is the whole reason they are allowed
 * to exist in a world whose law is that the referee is code. These tests hold
 * that line: same citizen, same day, same answer, in any process, forever.
 *
 * Run: node --test api/app/clients/tools/kademoo/life/errands.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const err = require('./errands.js');

/* The census, read out of reverie.js without loading its database imports. */
const src = fs.readFileSync(path.join(__dirname, '..', 'reverie.js'), 'utf8');
const CENSUS = new Function(
  src.slice(src.indexOf('const CENSUS = ['), src.indexOf('const CENSUS_BY_ID')) + ' return CENSUS;',
)();
const BY = Object.fromEntries(CENSUS.map((c) => ['npc:' + c.id, c]));
const DAY = '2026-9-22';

function whereEveryoneIs(hour, dayKey) {
  const rooms = {};
  for (const c of CENSUS) {
    const e = err.errandFor('npc:' + c.id, c, { h: hour, dayKey }, BY);
    const room = e ? e.room : err.postedAt(c, hour);
    (rooms[room] = rooms[room] || []).push(c.id);
  }
  return rooms;
}

test('the same citizen on the same day gets the same errand every time', () => {
  for (const c of CENSUS.slice(0, 8)) {
    for (let h = 0; h < 24; h++) {
      const a = err.errandFor('npc:' + c.id, c, { h, dayKey: DAY }, BY);
      const b = err.errandFor('npc:' + c.id, c, { h, dayKey: DAY }, BY);
      assert.deepStrictEqual(a, b, `${c.id} at ${h}:00 was not deterministic`);
    }
  }
});

test('nobody is away from their post for more than three hours a day', () => {
  for (const c of CENSUS) {
    let away = 0;
    for (let h = 0; h < 24; h++) if (err.errandFor('npc:' + c.id, c, { h, dayKey: DAY }, BY)) away++;
    assert.ok(away <= 3, `${c.id} was out ${away} hours`);
  }
});

test('an errand never sends anybody to a room that is not in the city', () => {
  /* Both room tables. CITY_ROOMS in reverie.js carved the wards; engine.js
   * still holds the original seed rooms the city grew out of, and the Kettle
   * is one of them -- which this test found out the hard way, correctly. */
  const engine = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
  const roomIds = new Set([...(src + engine).matchAll(/roomId: '([a-z0-9_]+)'/g)].map((m) => m[1]));
  for (const h of err.HANGOUTS) {
    assert.ok(roomIds.has(h.room), `${h.room} is not a room anywhere in the city`);
  }
});

test('an errand never sends anybody to the room they are already in', () => {
  for (const c of CENSUS) {
    for (let h = 0; h < 24; h++) {
      const e = err.errandFor('npc:' + c.id, c, { h, dayKey: DAY }, BY);
      if (e) assert.notStrictEqual(e.room, err.postedAt(c, h), `${c.id} walked to where they already were`);
    }
  }
});

test('somebody already posted somewhere sociable is left where they are', () => {
  /* Dez is at Dez's; that IS the evening. Pat is at Pat's. */
  for (const id of ['dez', 'pat', 'ruthann', 'levi']) {
    const c = BY['npc:' + id];
    for (let h = 0; h < 24; h++) {
      if (!err.HANGOUT_ROOMS.has(err.postedAt(c, h))) continue;
      assert.strictEqual(err.errandFor('npc:' + id, c, { h, dayKey: DAY }, BY), null,
        `${id} was sent out of a hangout at ${h}:00`);
    }
  }
});

test('the small hours stay quiet and the day does not', () => {
  const company = (hour) => {
    const rooms = whereEveryoneIs(hour, DAY);
    const withCompany = Object.values(rooms).filter((l) => l.length > 1).reduce((a, l) => a + l.length, 0);
    return withCompany / CENSUS.length;
  };
  /* 3am is a city asleep and should read as one. */
  assert.ok(company(3) < 0.3, 'three in the morning got busy');
  /* The hours a person would actually be about should beat it clearly. */
  for (const h of [8, 12, 19]) {
    assert.ok(company(h) > company(3), `${h}:00 was no livelier than 3am`);
  }
});

test('the evening puts a real crowd somewhere', () => {
  let biggest = 0;
  for (const d of ['2026-9-21', '2026-9-22', '2026-9-23', '2026-9-24']) {
    for (const h of [18, 19, 20]) {
      for (const l of Object.values(whereEveryoneIs(h, d))) biggest = Math.max(biggest, l.length);
    }
  }
  /* Before the errands the busiest room in the city, at any hour of any day,
   * held four people and that was Pat's at dinner. */
  assert.ok(biggest >= 5, `the busiest evening room held only ${biggest}`);
});

test('a different day is a different errand for somebody', () => {
  const a = err.windowsFor('npc:pat', '2026-9-22');
  const b = err.windowsFor('npc:pat', '2026-9-23');
  assert.notDeepStrictEqual(a, b, 'every day was identical');
});
