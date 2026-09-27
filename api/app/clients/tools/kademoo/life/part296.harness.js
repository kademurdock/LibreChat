/* Part 296 regression harness: wants and life goals, rewards, build mode,
 * the five new places, painting and the gallery, the greeting clock, the
 * creation fix and the ear-line repair. Real engine, real models, a disposable
 * MongoDB, no model calls.
 *   node --require api/test/reverie-bootstrap.cjs api/app/clients/tools/kademoo/life/part296.harness.js */
const assert = require('node:assert/strict');
const path = require('node:path');
require('module-alias').addAlias('~', path.resolve(__dirname, '../../../../..'));
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
process.env.REVERIE_FAST = '1';

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  let checks = 0;
  const check = (ok, message) => { assert.ok(ok, message); checks++; console.log('PASS', message); };
  try {
    const { runCommand } = require('./index');
    const { MooChar, MooRoom, MooItem } = require('~/models/kadeMoo');
    const wants = require('./wants');
    const overhear = require('../overhear');
    const run = (command, userId = 'p296-a', extra = {}) => runCommand({ userId, displayName: 'Test Person', command, isWizard: false, ...extra });
    const born = async (userId, first, extra = {}) => {
      let r = await run('look', userId, extra);
      for (const c of [first, 'Tester', '1', '2', '1', '1', '1', '1', '1', '2', '1', 'yes']) r = await run(c, userId, extra);
      return r;
    };

    /* the creation fix */
    let r = await run('look', 'p296-new');
    r = await run('orient', 'p296-new');
    check(r.mode === 'create' && r.step === 'first' && r.lines.some((l) => /works once you are in the city/.test(l)), 'a quick button during creation is not taken as a name');
    r = await run('places', 'p296-new');
    check(r.step === 'first', 'the name question is asked again after a quick button');

    /* the carve: places, links, keepers, ear lines */
    r = await born('p296-a', 'Wanda');
    check(r.ok && r.mode === 'play', 'a new person enters the city');
    for (const [room, street, dir] of [['the_bijou', 'tanglefoot_line_street', 'ne'], ['starlite_arcade', 'millrace_channel', 'se'], ['early_bird_bakery', 'patch_gully_road', 'nw'], ['sweetwater_bathhouse', 'sweetwater_park', 'sw'], ['the_easel', 'fairlawn_ave', 'nw']]) {
      const v = await MooRoom.findOne({ roomId: room }).lean();
      const s = await MooRoom.findOne({ roomId: street }).lean();
      check(v && s.exits[dir] === room && Object.values(v.exits).includes(street), `${room} is carved and linked both ways`);
    }
    for (const id of ['flo', 'teddy', 'mabel', 'roz', 'anselm']) {
      const c = await MooChar.findOne({ userId: 'npc:' + id }).lean();
      check(c && c.attrs.pronouns && c.attrs.desc, `${id} is on the census with pronouns and a description`);
    }
    const pats = await MooRoom.findOne({ roomId: 'pats_diner' }).lean();
    check(!!pats.props.listenLine && /flat-top hisses/.test(pats.props.listenLine), 'Pat’s ear line sits where "listen" reads it');

    /* wants: drawn, stable, completed, replaced */
    let ch = await MooChar.findOne({ userId: 'p296-a', active: true }).lean();
    const w0 = ch.attrs.life.wants;
    check(w0 && w0.list.length === 3 && w0.day, 'three wants are drawn for today');
    r = await run('wants');
    check(r.ok && r.choices.length >= 3, 'the wants verb lists them with choices');
    ch = await MooChar.findOne({ userId: 'p296-a', active: true }).lean();
    check(JSON.stringify(ch.attrs.life.wants.list.map((e) => e.id)) === JSON.stringify(w0.list.map((e) => e.id)), 'the draw is stable within the day');
    await MooChar.updateOne({ userId: 'p296-a', active: true }, { $set: { 'attrs.life.wants.list': [{ id: 'movie', n: 0, need: 1, done: false }, { id: 'build_room', n: 0, need: 1, done: false }, { id: 'chat3', n: 0, need: 3, done: false }], 'attrs.coin': 500 } });
    await run('go to the_bijou');
    r = await run('watch a movie');
    ch = await MooChar.findOne({ userId: 'p296-a', active: true }).lean();
    check(!ch.attrs.life.wants.list.find((e) => e.id === 'movie').done, 'reading the bill does not count as seeing a picture');
    r = await run('watch a movie 1');
    ch = await MooChar.findOne({ userId: 'p296-a', active: true }).lean();
    check(r.ok && ch.attrs.coin === 496 && ch.attrs.life.wants.list.find((e) => e.id === 'movie').done, 'a ticket is $4 and seeing a picture fulfils the want');
    check(ch.attrs.life.satisfaction === 30 && r.kinds.includes('ui.want.done'), 'satisfaction is paid and the chime plays');
    check(ch.attrs.life.wants.list.filter((e) => !e.done).length === 3, 'a fresh want takes the finished one’s place');
    await MooChar.updateOne({ userId: 'npc:flo' }, { $set: { roomId: 'the_bijou' } });
    r = await run('chat flo');
    ch = await MooChar.findOne({ userId: 'p296-a', active: true }).lean();
    check(ch.attrs.life.wants.list.find((e) => e.id === 'chat3').n === 1 && r.lines.some((l) => /1 of 3/.test(l)), 'a counted want reports its progress');

    /* the daily cap */
    const s = wants.stateOf({ ch, life: ch.attrs.life, userId: 'p296-a', isChild: false });
    const pool = wants.eligible(s, []);
    check(pool.length > 20, 'the pool offers plenty of eligible wants');
    const kid = wants.eligible({ ...s, isChild: true }, []).map((w) => w.id);
    check(!kid.includes('date') && !kid.includes('flirt') && !kid.includes('scratch') && !kid.includes('cards'), 'a child seat never draws romance, cards or scratch tickets');

    /* rewards */
    r = await run('rewards telescope');
    check(!r.ok, 'a reward you cannot afford is refused');
    await MooChar.updateOne({ userId: 'p296-a', active: true }, { $set: { 'attrs.life.satisfaction': 400 } });
    r = await run('rewards telescope');
    ch = await MooChar.findOne({ userId: 'p296-a', active: true }).lean();
    check(r.ok && ch.attrs.life.satisfaction === 140 && (await MooItem.countDocuments({ 'location.id': 'p296-a', 'props.furniture': 'telescope' })) === 1, 'a telescope costs 260 satisfaction and arrives in your pockets');

    /* goals: family step one */
    const rel = require('./relationships');
    await rel.adjust('p296-a', 'npc:flo', { friendship: 40 }, { names: { 'p296-a': 'Wanda Tester', 'npc:flo': 'Flo Abernathy' } });
    await MooChar.updateOne({ userId: 'npc:flo' }, { $set: { roomId: 'the_bijou' } });
    r = await run('hug flo');
    ch = await MooChar.findOne({ userId: 'p296-a', active: true }).lean();
    check(((ch.attrs.life.goals || {}).done || {}).family?.length === 1 && r.lines.some((l) => /Life goal reached: A real friend/.test(l)), 'the first family goal lands with a real friend');
    r = await run('aspiration peace');
    ch = await MooChar.findOne({ userId: 'p296-a', active: true }).lean();
    check(ch.attrs.life.aspirationKey === 'peace' && ch.attrs.life.goals.done.family.length === 1, 'changing the life goal keeps finished steps');

    /* build mode */
    await run('go to front street');
    r = await run('rent room over pats');
    check(r.ok, 'rent a place');
    await run('home');
    r = await run('build room');
    ch = await MooChar.findOne({ userId: 'p296-a', active: true }).lean();
    check(r.ok && r.choices.length === 8 && !ch.attrs.life.wants.list.find((e) => e.id === 'build_room').done, 'the build menu lists eight kinds and does not count as building');
    r = await run('build room bedroom');
    const home = ch.attrs.life.home;
    const bed = await MooRoom.findOne({ 'props.home.parent': home }).lean();
    const main = await MooRoom.findOne({ roomId: home }).lean();
    check(r.ok && bed && main.exits.u === bed.roomId && bed.exits.d === home, 'a bedroom is built upstairs and joined both ways');
    ch = await MooChar.findOne({ userId: 'p296-a', active: true }).lean();
    check(ch.attrs.life.wants.list.find((e) => e.id === 'build_room').done, 'building a room fulfils the want');
    check((await require('./housing').homesOf('p296-a')).length === 1, 'a built room is part of the home, not a second home');
    r = await run('paint walls robin’s egg blue');
    let here = await MooRoom.findOne({ roomId: home }).lean();
    check(r.ok && here.props.style.walls === 'robin’s egg blue' && /^#|^hsl/.test(here.props.style.wallHex), 'walls take any color, with a color for the picture');
    r = await run('floor black and white checkered tile');
    here = await MooRoom.findOne({ roomId: home }).lean();
    check(r.ok && here.props.surface === 'linoleum' && here.props.style.floorKind === 'checker', 'a checkered floor changes the footsteps and the picture');
    r = await run('look');
    check(r.room.desc.includes('The walls are robin’s egg blue and the floor is black and white checkered tile.') && r.room.style.floorKind === 'checker', 'the room reads its colors and floor aloud');
    await run('door locked');
    const locked = await MooRoom.find({ $or: [{ roomId: home }, { 'props.home.parent': home }] }).select('props.home.door').lean();
    check(locked.every((x) => x.props.home.door === 'locked'), 'the door policy covers the whole house');
    await run('door friends');
    await MooItem.create({ itemId: 'p296bed', name: 'a bed', location: { type: 'char', id: 'p296-a' }, portable: true, props: { furniture: 'bed', effect: 'Sleep.' } });
    await run('u');
    r = await run('place bed');
    check(r.ok, 'furniture goes into a built room');
    r = await run('sleep');
    check(r.ok && r.lines.some((l) => /own bed/.test(l)), 'a bed in the built bedroom is your own bed');
    r = await run('rooms');
    check(r.ok && r.lines.some((l) => /2 rooms/.test(l) && /bedroom, up from the front room: a bed/.test(l)), 'the house tour names every room and what is in it');

    /* keepsakes at home */
    await run('place telescope');
    r = await run('stargaze');
    check(r.ok || /still light out|Clouds tonight/.test(r.lines.join(' ')), 'the telescope works at home, with the sky deciding');

    /* the Starlite Arcade */
    await run('go to starlite_arcade');
    r = await run('play pinball wild');
    ch = await MooChar.findOne({ userId: 'p296-a', active: true }).lean();
    check(r.ok && r.lines.some((l) => /^Final score: /.test(l)) && (ch.attrs.life.games || {}).pinball === 1, 'pinball plays three balls and keeps a count');
    check((await require('~/models/kadeMooLife').MooBoard.countDocuments({ board: 'pinball' })) === 1, 'the pinball board records the game');
    await MooChar.updateOne({ userId: 'p296-a', active: true }, { $set: { 'attrs.life.tickets': 18 } });
    r = await run('prizes kazoo');
    check(!r.ok, 'a prize needs enough tickets');
    r = await run('prizes rubber duck');
    ch = await MooChar.findOne({ userId: 'p296-a', active: true }).lean();
    check(r.ok && ch.attrs.life.tickets === 3 && (await MooItem.countDocuments({ 'location.id': 'p296-a', name: 'a rubber duck' })) === 1, 'a prize spends exactly its tickets');
    r = await run('claw machine');
    check(r.ok && (r.kinds.includes('game.claw.win') || r.kinds.includes('game.claw.drop')), 'the claw machine either wins or drops, with its sound');

    /* the Early Bird Bakery */
    await run('go to early_bird_bakery');
    r = await run('bake');
    check(r.ok && (await MooItem.countDocuments({ 'location.id': 'p296-a', 'props.baked': true })) === 1, 'baking makes something you can carry');

    /* the Sweetwater Bathhouse */
    await run('go to sweetwater_bathhouse');
    for (const c of ['swim laps', 'cannonball', 'sauna', 'soak']) { r = await run(c); check(r.ok, `${c} works at the bathhouse`); }
    check(!(await run('go to front street').then(() => run('sauna'))).ok, 'the sauna is only at the bathhouse');

    /* the Easel and the gallery */
    await run('go to the_easel');
    r = await run('paint');
    check(r.ok && r.freeText && !(await MooItem.countDocuments({ 'props.painting': { $exists: true } })), 'paint alone asks what to paint and makes nothing');
    r = await run('paint "the ferry at night"');
    const painting = await MooItem.findOne({ 'location.id': 'p296-a', 'props.painting': { $exists: true } }).lean();
    check(r.ok && painting && painting.props.painting.title === 'the ferry at night' && painting.props.furniture === 'painting', 'a painting carries its title in the painter’s own words');
    r = await run('sell painting');
    const hung = await MooItem.findOne({ _id: painting._id }).lean();
    check(r.ok && hung.location.id === 'the_easel' && hung.props.gallery && hung.props.price > 0, 'a sold painting hangs on the gallery wall with a price');
    r = await born('p296-b', 'Bert');
    await MooChar.updateOne({ userId: 'p296-b', active: true }, { $set: { 'attrs.coin': 100 } });
    await run('go to the_easel', 'p296-b');
    r = await run('gallery', 'p296-b');
    check(r.ok && r.lines.some((l) => /the ferry at night/.test(l)), 'another person sees the painting in the gallery');
    r = await run('buy painting ferry', 'p296-b');
    const bought = await MooItem.findOne({ _id: painting._id }).lean();
    check(r.ok && bought.location.id === 'p296-b' && !bought.props.gallery, 'another person can buy it and take it home');

    /* the greeting clock */
    check(!overhear.fitsHour('"Morning. Pole\'s in the barrel."', 20) && overhear.fitsHour('"Morning. Pole\'s in the barrel."', 8), 'a morning greeting only in the morning');
    check(!overhear.fitsHour('"Sergeant Vann. Evening."', 9) && overhear.fitsHour('"Sergeant Vann. Evening."', 19), 'an evening greeting only in the evening');
    check(overhear.fitsHour('"Pier Seven before the sun\'s all the way up."', 22), 'a line that merely mentions a time is never filtered');

    /* moving out takes the whole house down cleanly */
    await run('home');
    r = await run('move out');
    check(r.ok && !(await MooRoom.countDocuments({ roomId: new RegExp('^' + home) })), 'moving out removes the home and every room built onto it');
    check((await MooItem.countDocuments({ 'location.id': 'p296-a', 'props.furniture': 'bed' })) === 1, 'the furniture from the built rooms comes along');

    /* the pulse of a room: a director that always answers "nobody" can no
     * longer hold a room silent for more than a minute */
    const { MooEvent, nextSeq } = require('~/models/kadeMoo');
    const reverie = require('../reverie');
    const judges = path.resolve(__dirname, '../../../../../server/services/kadeJevJudges.js');
    const realJudges = require.cache[judges];
    let asked = 0;
    let watch = null;
    require.cache[judges] = { id: judges, filename: judges, loaded: true, exports: { directRoom: async (scene) => { if (scene && scene.place === watch) asked++; return { answered: true, pick: null, fresh: false, costUSD: 0 }; } } };
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    try {
      shift += 120000;
      await MooChar.updateMany({ userId: { $in: ['p296-b', 'p296-new'] } }, { $set: { lastActiveAt: new Date(realNow() - 3600000) } });
      await reverie.tickWorld();
      const citizen = await MooChar.findOne({ userId: /^npc:/, roomId: { $nin: [null, 'city_gate'] } }).lean();
      watch = citizen.roomId;
      await MooChar.updateOne({ userId: 'p296-a', active: true }, { $set: { roomId: citizen.roomId, lastActiveAt: new Date(Date.now()) } });
      await MooEvent.create({ seq: await nextSeq(), roomId: citizen.roomId, actorUserId: 'p296-a', actorName: 'Wanda Tester', kind: 'say', text: 'Wanda Tester: "hello"', at: new Date(Date.now()) });
      let mark = (await MooEvent.findOne({}).sort({ seq: -1 }).lean()).seq;
      shift += 60000; asked = 0;
      await MooEvent.create({ seq: await nextSeq(), roomId: citizen.roomId, actorUserId: 'p296-a', actorName: 'Wanda Tester', kind: 'emote', text: 'Wanda Tester looks around.', at: new Date(Date.now() - 2000) });
      mark = (await MooEvent.findOne({}).sort({ seq: -1 }).lean()).seq;
      await reverie.tickWorld();
      const breath = await MooEvent.countDocuments({ roomId: citizen.roomId, seq: { $gt: mark }, actorUserId: /^npc:/, kind: 'emote' });
      check(breath === 0 && asked === 0, 'right after something happens, the room takes a breath and the director is not asked');
      shift += 60000; asked = 0;
      await MooEvent.create({ seq: await nextSeq(), roomId: citizen.roomId, actorUserId: 'p296-a', actorName: 'Wanda Tester', kind: 'emote', text: 'Wanda Tester sits still.', at: new Date(Date.now() - 30000) });
      mark = (await MooEvent.findOne({}).sort({ seq: -1 }).lean()).seq;
      await reverie.tickWorld();
      const chosen = await MooEvent.countDocuments({ roomId: citizen.roomId, seq: { $gt: mark }, actorUserId: /^npc:/, kind: 'emote' });
      check(asked >= 1 && chosen === 0, 'half a minute of quiet: the director is asked, and its silence stands');
      shift += 60000; asked = 0;
      await MooEvent.create({ seq: await nextSeq(), roomId: citizen.roomId, actorUserId: 'p296-a', actorName: 'Wanda Tester', kind: 'emote', text: 'Wanda Tester waits.', at: new Date(Date.now() - 75000) });
      mark = (await MooEvent.findOne({}).sort({ seq: -1 }).lean()).seq;
      await reverie.tickWorld();
      const pulse = await MooEvent.find({ roomId: citizen.roomId, seq: { $gt: mark }, actorUserId: /^npc:/, kind: 'emote' }).lean();
      check(pulse.length >= 1, `a minute of quiet: somebody there does something anyway (${pulse.map((e) => e.text).join(' / ')})`);
    } finally {
      Date.now = realNow;
      if (realJudges) require.cache[judges] = realJudges; else delete require.cache[judges];
    }

    console.log(`Part 296: ${checks} checks passed.`);
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
