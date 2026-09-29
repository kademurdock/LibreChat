const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
require('./community-load.cjs');
const root = path.resolve(__dirname, '..');
const { createCommunityRouter } = require('../packages/api/src/community/router.ts');
const { createCommunityModels } = require('../packages/data-schemas/src/models/community.ts');
(async () => {
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60000 } });
  await mongoose.connect(mongo.getUri());
  const models = createCommunityModels(mongoose);
  const Book = mongoose.model('PreviewBook', new mongoose.Schema({ title: String, kind: String, shared: Boolean, state: String, owner: mongoose.Schema.Types.ObjectId, tracks: [{ key: String, title: String, mime: String, seconds: Number }] }));
  const host = { id: new mongoose.Types.ObjectId().toString(), role: 'ADMIN', name: 'Preview Host', email: 'preview@example.invalid' };
  const guest = { id: new mongoose.Types.ObjectId().toString(), role: 'USER', name: 'Preview Guest', kadeLibraryAccess: 'family' };
  const previewBook = await Book.create({ title: 'Preview recording (test fixture)', kind: 'video', state: 'ready', shared: true, owner: host.id, tracks: [{ key: 'preview.mp4', title: 'Silent sample', mime: 'video/mp4', seconds: 30 }] });
  const reader = { id: new mongoose.Types.ObjectId().toString(), role: 'USER', name: 'Preview Reader', kadeLibraryAccess: 'none' };
  await models.releases.create({ _id: 'sample-release', book: String(previewBook._id), track: 0, key: 'preview.mp4', publisher: host.id, title: 'Synthetic test recording', description: 'A silent local sample, not real published content.', active: true, publishedAt: new Date() });
  const app = express();
  app.use('/assets', express.static(path.join(root, 'client/public/assets')));
  app.get('/preview.mp4', (_req, res) => res.sendFile(path.join(__dirname, 'preview.mp4')));
  const actor = req => ({ 'Bearer guest': guest, 'Bearer reader': reader, 'Bearer host': host })[req.get('Authorization')];
  app.post('/api/auth/refresh', (req, res) => req.get('Cookie')?.includes('previewSignedOut=1') ? res.sendStatus(401) : res.json({ token: 'reader' }));
  app.get('/preview/sign-out', (_req, res) => res.set('Set-Cookie', 'previewSignedOut=1; Path=/; SameSite=Lax').redirect('/watch/sample-release'));
  app.get('/preview/sign-in', (_req, res) => res.set('Set-Cookie', 'previewSignedOut=0; Path=/; SameSite=Lax').redirect('/watch/sample-release'));
  app.get('/request-access', (_req, res) => res.type('html').send(require('../api/server/routes/kadePages').requestAccessHtml));
  app.get('/api/user', (_req, res) => res.json(host));
  app.get('/api/kade/app-banner', (_req, res) => res.json({}));
  app.get('/kade-tabbar.js', (_req, res) => res.type('js').send(''));
  app.get('/usage-dashboard', (_req, res) => res.type('html').send(require('../api/server/routes/kadePages').dashboardHtml));
  app.get('/api/kade/usage', (_req, res) => res.json({ windowDays: 30, totals: { llmSpendUSD: { allTime: 0 }, extraSpendUSD: { allTime: 0 }, grandSpendUSD: { allTime: 0 }, balanceUSD: 0 }, perUser: [], perService: [] }));
  app.get(['/api/kade/books', '/api/kade/funding/ledger', '/api/kade/funding'], (_req, res) => res.json({ entries: [], people: [] }));
  app.use('/api/kade/reading-room/membership', express.json(), require('../packages/api/src/library/access.ts').libraryMembershipRouter({
    auth: (req, _res, next) => { req.user = host; next(); }, owner: (_req, _res, next) => next(),
    accounts: async () => [host, guest], account: async id => id === guest.id ? guest : host,
    setAccess: async (_id, access) => { guest.kadeLibraryAccess = access; return guest; },
    approveUploads: async () => { throw new Error('Not part of this preview'); },
  }));
  app.use(createCommunityRouter({ ...models, books: Book, auth: (req, res, next) => actor(req) ? next() : res.sendStatus(401), actor, child: async () => false, room: req => req.get('X-Clubhouse-Token') === 'preview-room' ? 'preview-room' : null,
    openBook: async (_req, id) => Book.findById(id).lean(), sign: async key => 'http://localhost:4179/' + key, log: console.error }));
  app.get('/home', (_req, res) => res.type('html').send(require('../api/server/routes/kadeHome').homeHtml));
  app.get('/publish', (_req, res) => res.sendFile(path.join(root, 'client/public/assets/community/publish.html')));
  app.get('/clubhouse', (req, res) => {
    const { SHARED_HEAD } = require('../api/server/routes/kadePages');
    const html = fs.readFileSync(path.join(root, 'api/server/routes/Clubhouse/lounge.html'), 'utf8');
    const script = `document.getElementById('room').hidden=false; document.getElementById('room-title').textContent='Preview room (synthetic test)'; window.previewPlayer=new ClubLibraryPlayer({token:()=>${JSON.stringify(req.query.guest ? 'guest' : 'host')},pauseJukebox:()=>{},changed:()=>{}}); previewPlayer.start('preview-room');`;
    res.type('html').send(html.replace('<!-- KADE_SHARED_HEAD -->', () => SHARED_HEAD).replace('<!-- KADE_CLIENT_SCRIPT -->', () => script));
  });
  app.listen(4179, '127.0.0.1', () => console.log('Synthetic community preview http://localhost:4179'));
})();
