const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MooChar, MooRoom, MooEvent } = require('../../../../api/models/kadeMoo');
const old = require('../../../../api/app/clients/tools/kademoo/engine');
const life = require('../../../../api/app/clients/tools/kademoo/life');
const { moveTo } = require('../../../../api/app/clients/tools/kademoo/life/ctx');
(async () => {
  const db = await MongoMemoryServer.create(); await mongoose.connect(db.getUri());
  let checks = 0;
  const check = (value, label) => { assert(value, label); checks++; console.log('PASS ' + label); };
  const run = (userId, command, expectedRoomId) => life.runCommand({ userId, displayName: userId, command, expectedRoomId, live: true });
  const names = { 'nav-alex': 'Alex Example', 'nav-mira': 'Mira Example', 'nav-secret': 'Private Resident' };
  try {
    for (const [userId, name] of Object.entries(names)) {
      const ch = await old.getOrCreateChar(userId, name);
      await MooChar.updateOne({ _id: ch._id }, { $set: { roomId: userId === 'nav-alex' ? 'nav_west' : userId === 'nav-mira' ? 'nav_east' : 'nav_home', 'attrs.life': { created: true, needsAt: Date.now(), needs: { fed: 80, rested: 80, clean: 80, fun: 80, company: 80 }, reading: { private: 'never show this' } } } });
    }
    for (const room of [
      { roomId: 'nav_west', name: 'Navigation Court', exits: { e: 'nav_east', cellar: 'nav_home', u: 'nav_missing' }, props: {} },
      { roomId: 'nav_east', name: 'Navigation Lane', exits: { w: 'nav_west', n: 'nav_north' }, props: {} },
      { roomId: 'nav_north', name: 'Navigation North', exits: { s: 'nav_east' }, props: {} },
      { roomId: 'nav_home', name: 'A private home', exits: { out: 'nav_west', secret: 'nav_hidden' }, props: { home: { owner: 'nav-secret', ownerName: 'Private Resident', door: 'locked', keys: [], tenants: [] } } },
      { roomId: 'nav_hidden', name: 'Unreachable Court', exits: {}, props: {} },
    ]) await MooRoom.create({ ...room, desc: 'An isolated navigation fixture.', district: 'gate' });
    let a = await run('nav-alex', 'orient');
    check(a.ok && a.lines.join(' ').includes('east to Navigation Lane'), 'orientation names actual destinations');
    check(a.lines.join(' ').includes('Nobody else'), 'orientation begins with actual local presence');
    check(!JSON.stringify(a.room).includes('Private Resident') && !JSON.stringify(a.room).includes('never show this'), 'adjacent occupants and private journals stay private');
    check(a.room.exitsDetail.find(e => e.dir === 'cellar').locked, 'home policy marks an unflagged exit locked');
    check(a.room.exitsDetail.find(e => e.dir === 'u').missing, 'missing destinations are unavailable');
    const changedExit = await life.runCommand({ userId: 'nav-alex', command: 'go east', live: true, expectedRoomId: 'nav_west', expectedExit: { dir: 'e', toId: 'nav_north' } });
    check(!changedExit.ok && changedExit.room.roomId === 'nav_west', 'changed exit destination is refused without moving');
    let r = await run('nav-alex', 'go cellar', 'nav_west');
    check(!r.ok && r.room === undefined && r.here.roomId === 'nav_west', 'direction cannot bypass home policy without an exit lock');
    r = await run('nav-alex', 'go to Unreachable Court');
    check(!r.ok && r.here.roomId === 'nav_west', 'autowalk cannot use a private home as a shortcut');
    r = await run('nav-alex', 'up');
    check(!r.ok && r.here.roomId === 'nav_west', 'missing destination cannot strand the character');
    r = await run('nav-mira', 'west', 'nav_east');
    check(r.ok && r.room.roomId === 'nav_west', 'second character reaches the first through an actual exit');
    a = await run('nav-alex', 'orient');
    check(a.people.some(p => p.id === 'nav-mira'), 'both characters share server presence');
    check(r.room.exitsDetail.find(e => e.dir === 'e').returning, 'return direction derives from saved last room');
    await run('nav-mira', 'say We met in the court.');
    check(await MooEvent.countDocuments({ roomId: 'nav_west', actorUserId: 'nav-mira', kind: 'say', text: /We met/ }) === 1, 'public speech is stored in the shared room');
    check((await run('nav-mira', 'whisper Alex A private greeting.')).ok, 'unique first name resolves a full-name resident');
    check((await run('nav-mira', 'whisper "Alex Example" Keep My CASE.')).lines.some(line => line.includes('Keep My CASE.')), 'quoted full name preserves message case');
    const twin = await old.getOrCreateChar('nav-twin', 'Alex Other');
    await MooChar.updateOne({ _id: twin._id }, { $set: { roomId: 'nav_west' } });
    check(!(await run('nav-mira', 'whisper Alex ambiguous words')).ok, 'ambiguous first names never guess the recipient');
    check(await MooEvent.countDocuments({ roomId: 'whisper:nav-alex', text: /A private greeting/ }) === 1, 'private words are stored only for their recipient');
    check(await MooEvent.countDocuments({ roomId: 'nav_west', text: /A private greeting/ }) === 0, 'whisper is absent from the public room chronicle');
    await run('nav-mira', 'east', 'nav_west');
    a = await run('nav-alex', 'orient');
    check(!a.people.some(p => p.id === 'nav-mira'), 'departed character disappears from current presence');
    const stale = await run('nav-mira', 'north', 'nav_west');
    check(!stale.ok && stale.room.roomId === 'nav_east', 'stale origin returns the current room without taking another exit');
    await run('nav-mira', 'say Words after leaving.');
    check(await MooEvent.countDocuments({ roomId: 'nav_west', text: /Words after leaving/ }) === 0, 'subsequent speech stays in the new room');
    await MooRoom.updateOne({ roomId: 'nav_east' }, { $set: { 'props.locks.w': 'fixture-key' } });
    r = await run('nav-mira', 'back');
    check(!r.ok && r.here.roomId === 'nav_east', 'back respects a door locked after departure');
    await MooChar.updateOne({ userId: 'nav-mira' }, { $set: { 'attrs.prevRoom': 'nav_home' } });
    r = await run('nav-mira', 'back');
    check(!r.ok && r.here.roomId === 'nav_east', 'back cannot teleport into a disconnected private home');
    const current = await MooChar.findOne({ userId: 'nav-alex' }).lean();
    const copies = [structuredClone(current), structuredClone(current)].map(c => ({ ...c, _id: current._id }));
    const attempts = await Promise.allSettled([
      moveTo(copies[0], 'nav_east', 'Concurrent departure.', 'Concurrent arrival.'),
      moveTo(copies[1], 'nav_north', 'Concurrent departure.', 'Concurrent arrival.'),
    ]);
    check(attempts.filter(r => r.status === 'fulfilled').length === 1, 'only one simultaneous move claims the original room');
    check(await MooEvent.countDocuments({ actorUserId: 'nav-alex', text: 'Concurrent departure.' }) === 1, 'losing movement emits no false departure');
    check(['nav_east', 'nav_north'].includes((await MooChar.findOne({ userId: 'nav-alex' })).roomId), 'winning location survives a fresh database read');
    console.log(`${checks} navigation checks passed; isolated Mongo, no provider requests.`);
  } finally { await mongoose.disconnect(); await db.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
