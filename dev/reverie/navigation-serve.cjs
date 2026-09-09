const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
require(path.join(root, 'api/test/reverie-bootstrap.cjs'));
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MooChar, MooRoom } = require(path.join(root, 'api/models/kadeMoo'));
const old = require(path.join(root, 'api/app/clients/tools/kademoo/engine'));
const users = { alex: { id: 'browser-alex', name: 'Alex Example', role: 'ADMIN' }, mira: { id: 'browser-mira', name: 'Mira Example', role: 'ADMIN' }, closed: { id: 'browser-closed', name: 'Closed Seat', role: 'USER' } };
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === '~/server/middleware') return { requireJwtAuth(req, res, next) { req.user = users[(req.headers.authorization || '').replace('Bearer ', '')]; if (!req.user) return res.status(401).end(); next(); } };
  return load.call(this, id, ...args);
};
(async () => {
  const db = await MongoMemoryServer.create(); await mongoose.connect(db.getUri());
  for (const [key, user] of Object.entries(users)) {
    if (key === 'closed') continue;
    const ch = await old.getOrCreateChar(user.id, user.name);
    await MooChar.updateOne({ _id: ch._id }, { $set: { roomId: key === 'alex' ? 'nav_court' : 'nav_lane', 'attrs.life': { created: true, look: { hair: key === 'alex' ? 'locs' : 'a bun' }, needsAt: Date.now() } } });
  }
  for (const room of [
    { roomId: 'nav_court', name: 'Test Court', exits: { e: 'nav_lane' }, props: { indoor: true } },
    { roomId: 'nav_lane', name: 'Test Lane', exits: { w: 'nav_court', n: 'nav_garden' }, props: { outdoor: true } },
    { roomId: 'nav_garden', name: 'Test Garden', exits: { s: 'nav_lane' }, props: { outdoor: true } },
  ]) await MooRoom.create({ ...room, desc: 'A disposable place for two-client exploration checks.', district: 'gate' });
  const app = express(); app.use(express.json());
  app.get('/world', (_, res) => res.type('html').send(require(path.join(root, 'api/server/routes/kadePages')).worldHtml));
  app.use('/assets', express.static(path.join(root, 'client/public/assets')));
  app.get('/favicon.ico', (_, res) => res.status(204).end());
  app.post('/api/auth/refresh', (req, res) => { const key = /fixture=(mira|closed)/.exec(req.headers.cookie || '')?.[1] || 'alex'; res.json({ token: key }); });
  app.get('/api/world/sounds', (_, res) => res.json({ event: {}, room: {}, district: {} }));
  app.use('/api/world', require(path.join(root, 'api/server/routes/world')));
  const server = app.listen(Number(process.env.REVERIE_PORT || 8174), '127.0.0.1', () => console.log('Actual World routes, isolated users/Mongo: http://127.0.0.1:' + server.address().port + '/world'));
  const stop = async () => { server.closeAllConnections(); server.close(); await mongoose.disconnect(); await db.stop(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
})().catch(e => { console.error(e); process.exitCode = 1; });
