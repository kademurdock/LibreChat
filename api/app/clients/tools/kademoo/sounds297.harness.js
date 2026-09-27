/* Part 297 harness: sounds re-made on fal move their MooSound rows to the new
 * places297 url, and nothing else moves. A disposable MongoDB, no network.
 *   node --require api/test/reverie-bootstrap.cjs api/app/clients/tools/kademoo/sounds297.harness.js */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('module-alias').addAlias('~', path.resolve(__dirname, '../../../..'));
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

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
    const { MooSound } = require('~/models/kadeMoo');
    const { seedSounds } = require('./seedSounds');
    const assets = path.resolve(__dirname, '../../../../../client/public/assets/sounds/reverie');

    const remade = Object.entries(LIFE_SOUNDS).filter(([, u]) => u.includes('/places297/'));
    const kept = Object.entries(LIFE_SOUNDS).filter(([, u]) => u.includes('/places296/'));
    check(remade.length > 0, `${remade.length} Part 296 sounds point at their Part 297 recordings`);
    for (const [id, url] of remade) {
      const file = path.join(assets, 'places297', `${id}.m4a`);
      check(fs.existsSync(file) && fs.statSync(file).size > 2000, `${id}: the new file is in places297`);
      check(url === `https://kademurdock.com/assets/sounds/reverie/places297/${id}.m4a`, `${id}: the url is the places297 address`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(assets, 'places297', 'manifest.json'), 'utf8'));
    const provenance = JSON.parse(fs.readFileSync(path.join(assets, 'places297', 'provenance.json'), 'utf8'));
    check(Object.keys(manifest).sort().join() === remade.map(([id]) => id).sort().join(), 'places297 manifest lists exactly the re-made sounds');
    check(provenance.every((p) => p.model && p.prompt && p.sha256 && p.blindEar && p.blindEar.final), 'every re-made sound carries its model, prompt, hash and blind-ear record');

    /* A live database from last night: rows on the places296 urls, plus one
     * sound Kade replaced herself. */
    const [firstId, firstUrl] = remade[0];
    const old = (u) => u.replace('/places297/', '/places296/');
    await MooSound.create({ scopeType: 'event', scopeId: firstId, url: old(firstUrl), addedBy: 'seed' });
    const bed = remade.find(([id]) => id.startsWith('amb.'));
    const room = { 'amb.bijou.room': 'the_bijou', 'amb.arcade.room': 'starlite_arcade', 'amb.bakery.room': 'early_bird_bakery', 'amb.bathhouse.pool': 'sweetwater_bathhouse', 'amb.easel.room': 'the_easel' };
    if (bed) await MooSound.create({ scopeType: 'room', scopeId: room[bed[0]], url: old(bed[1]), addedBy: 'seed153' });
    let mine = null;
    if (remade[1]) {
      mine = remade[1][0];
      await MooSound.create({ scopeType: 'event', scopeId: mine, url: 'https://kademurdock.com/her-own-upload.m4a', addedBy: 'kade' });
    }
    if (kept[0]) await MooSound.create({ scopeType: 'event', scopeId: kept[0][0], url: kept[0][1], addedBy: 'seed' });

    await seedSounds();

    const row = await MooSound.findOne({ scopeType: 'event', scopeId: firstId }).lean();
    check(row.url === firstUrl, `${firstId}: the row moved to the new recording`);
    if (bed) {
      const r = await MooSound.findOne({ scopeType: 'room', scopeId: room[bed[0]] }).lean();
      check(r.url === bed[1], `${room[bed[0]]}: the room bed moved to the new recording`);
    }
    if (mine) {
      const r = await MooSound.findOne({ scopeType: 'event', scopeId: mine }).lean();
      check(r.url === 'https://kademurdock.com/her-own-upload.m4a', `${mine}: a sound Kade installed herself is left alone`);
    }
    if (kept[0]) {
      const r = await MooSound.findOne({ scopeType: 'event', scopeId: kept[0][0] }).lean();
      check(r.url === kept[0][1], `${kept[0][0]}: a sound that was not re-made stays on places296`);
    }
    const untouched = remade.find(([id]) => id !== firstId && id !== mine);
    if (untouched) {
      const fresh = await MooSound.findOne({ scopeType: 'event', scopeId: untouched[0] }).lean();
      check(fresh && fresh.url === untouched[1], `${untouched[0]}: a fresh database seeds the new recording directly`);
    }
    console.log(`${checks} checks passed`);
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
