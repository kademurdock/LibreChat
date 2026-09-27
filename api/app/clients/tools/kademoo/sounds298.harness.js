/* Part 298 harness: the sound pass. Re-made old sounds move their rows (and a
 * row pointed elsewhere by hand stays put), rooms get their tones, the weather
 * and the work are heard, drinks pour. A disposable MongoDB, no network.
 *   node --require api/test/reverie-bootstrap.cjs api/app/clients/tools/kademoo/sounds298.harness.js */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('module-alias').addAlias('~', path.resolve(__dirname, '../../../..'));
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
process.env.REVERIE_FAST = '1';
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'harness';
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'harness';
process.env.AWS_ENDPOINT_URL = process.env.AWS_ENDPOINT_URL || 'https://s3.harness.invalid';

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  let checks = 0;
  const check = (ok, message) => { assert.ok(ok, message); checks++; console.log('PASS', message); };
  try {
    const LIFE_SOUNDS = require('./lifeSounds.json');
    const REMADE = require('./remade298.json');
    const assets = path.resolve(__dirname, '../../../../../client/public/assets/sounds/reverie/places298');
    const manifest = JSON.parse(fs.readFileSync(path.join(assets, 'manifest.json'), 'utf8'));
    const provenance = JSON.parse(fs.readFileSync(path.join(assets, 'provenance.json'), 'utf8'));

    /* the files */
    const ids = Object.keys(manifest);
    check(ids.length >= 40, `${ids.length} Part 298 sounds are installed`);
    check(ids.every((id) => fs.statSync(path.join(assets, `${id}.m4a`)).size > 2000), 'every Part 298 file is on disk');
    check(provenance.length === ids.length && provenance.every((p) => p.prompt && p.sha256 && p.blindEar && p.blindEar.confirmation && p.blindEar.confirmation.length === 2), 'every Part 298 sound carries its prompt, hash and both confirmation listens');
    check(provenance.every((p) => p.reviewers.confirmation.passed >= 2), 'every Part 298 sound passed its confirmation reviewers');
    const districts = new Set(['amb.bellward', 'amb.fairlawn', 'amb.gate', 'amb.gravewalk', 'amb.longacre', 'amb.millrace', 'amb.sweetwater', 'amb.tanglefoot']);
    check(ids.filter((id) => !districts.has(id)).every((id) => LIFE_SOUNDS[id] === manifest[id]), 'lifeSounds points every new event sound at its places298 file');
    check(ids.filter((id) => districts.has(id)).every((id) => !LIFE_SOUNDS[id]), 'district beds are district rows, not event sounds');
    check(REMADE.every((r) => ids.includes(r.url.split('/').pop().replace(/\.m4a$/, ''))), 'every row move points at an installed file');

    /* the live database as it is today */
    const { MooSound, MooChar, MooRoom } = require('~/models/kadeMoo');
    const signed = (key) => `https://s3.us-east-005.backblazeb2.com/Kademurdockchat/reverie-sounds/${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=604800`;
    for (const r of REMADE) {
      const url = r.was.startsWith('/reverie-sounds/') ? signed(r.was.slice('/reverie-sounds/'.length)) : `https://kademurdock.com${r.was}`;
      await MooSound.create({ scopeType: r.scopeType, scopeId: r.scopeId, url, addedBy: 'seed' });
    }
    await MooSound.create({ scopeType: 'event', scopeId: 'fish.cast.plop', url: 'https://kademurdock.com/her-own-plop.m4a', addedBy: 'kade' });
    const { seedSounds } = require('./seedSounds');
    await seedSounds();
    for (const r of REMADE) {
      const row = await MooSound.findOne({ scopeType: r.scopeType, scopeId: r.scopeId }).lean();
      check(row.url === r.url, `${r.scopeType} ${r.scopeId} moved to its Part 298 recording`);
    }
    const plop = await MooSound.findOne({ scopeType: 'event', scopeId: 'fish.cast.plop' }).lean();
    check(plop.url === 'https://kademurdock.com/her-own-plop.m4a', 'a row pointed elsewhere by hand is left alone');
    const kettle = await MooSound.findOne({ scopeType: 'room', scopeId: 'the_kettle' }).lean();
    check(!!LIFE_SOUNDS['amb.kettle.room'] === !!kettle && (!kettle || kettle.url === LIFE_SOUNDS['amb.kettle.room']), 'the Kettle gets its own cafe tone when it passed');
    const bank = await MooSound.findOne({ scopeType: 'room', scopeId: 'the_bank' }).lean();
    check(!!bank === !!LIFE_SOUNDS['amb.bank.room'], 'a room whose tone did not pass gets no row');
    const door = await MooSound.findOne({ scopeType: 'event', scopeId: 'door' }).lean();
    check(!LIFE_SOUNDS.door || (door && door.url === LIFE_SOUNDS.door), 'new event kinds are seeded (door)');

    /* the weather */
    const { weatherSound } = require('./reverie');
    check(weatherSound('storm', 'clear', 'bellward') === 'wx.thunder.far', 'a storm arrives with thunder');
    check(weatherSound('fog', 'clear', 'hook') === 'wx.fog.horn' && weatherSound('fog', 'clear', 'longacre') === 'wx.fog.horn.far', 'fog brings the near horn by the water and the far horn inland');
    check(weatherSound('clear', 'rain', 'patch') === 'wx.rain.stop' && weatherSound('overcast', 'clear', 'patch') === null, 'rain leaving drips away; other changes stay the plain notice');

    /* surfaces */
    const { reverieSenses } = require('@librechat/api');
    const senses = (roomId, props, weather = 'clear') => reverieSenses({ roomId, props }, weather, false);
    check(senses('ring_road', { outdoor: true }).footstep === 'move.step.asphalt.dry', 'the ring road is blacktop underfoot');
    check(senses('ring_road', { outdoor: true }, 'rain').footstep === 'move.step.asphalt.wet', 'blacktop is wet in the rain');
    check(senses('the_bandshell', { outdoor: true }).footstep === 'move.step.grass.dry', 'the bandshell lawn is grass underfoot');
    check(senses('the_kettle', {}).ambience !== 'amb.diner.quiet' && senses('pats_diner', {}).ambience === 'amb.diner.quiet', 'the Kettle is no longer the diner');

    /* the work and the drinks, through the real engine */
    const { runCommand } = require('./life');
    const run = (command, userId = 'p298-a') => runCommand({ userId, displayName: 'Test Person', command, isWizard: false });
    let r = await run('look');
    for (const c of ['Sadie', 'Tester', '1', '2', '1', '1', '1', '1', '1', '2', '1', 'yes']) r = await run(c);
    check(r.ok && r.mode === 'play', 'a new person enters the city');
    const put = async (roomId) => MooChar.updateOne({ userId: 'p298-a', active: true }, { $set: { roomId, 'attrs.busyUntil': 0, 'attrs.coin': 200 } });
    await put('pats_diner');
    const sink = await MooRoom.findOne({ 'props.job.name': /sink/ }).lean();
    await put(sink.roomId);
    r = await run('work');
    check(r.ok && r.kinds.includes('work.dishes.sink') && r.kinds.indexOf('work.dishes.sink') < r.kinds.indexOf('coin'), 'a shift at the sink is heard before the pay');
    const dock = await MooRoom.findOne({ 'props.job.name': 'dock crew' }).lean();
    await put(dock.roomId);
    r = await run('work');
    check(r.ok && r.kinds.includes('coin') && !r.kinds.some((k) => /^work\.dock/.test(k)), 'a job whose take did not pass keeps the coin alone');
    await put('dezs_bar');
    r = await run('eat');
    check(r.ok && r.kinds.includes('obj.bottle.pour') && !r.kinds.includes('eat'), 'a drink at Dez’s pours');
    await put('pats_diner');
    r = await run('eat');
    check(r.ok && r.kinds.includes('eat'), 'a meal at Pat’s sounds like eating');
    console.log(`${checks} checks passed`);
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
