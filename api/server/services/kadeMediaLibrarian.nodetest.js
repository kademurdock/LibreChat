'use strict';
/* node --test api/server/services/kadeMediaLibrarian.nodetest.js
 * The media librarian's rules, held still. Every case here is one her own
 * catalog produced in the Part 270 trial (1,269 items, live Jev). */
const test = require('node:test');
const assert = require('node:assert');
const L = require('./kadeMediaLibrarian');

const ans = (o) => {
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = Array.isArray(v) ? { choice: v[0], confidence: v[1] } : { noul: v };
  return out;
};
const video = (title, path, extra = {}) => ({ _id: 'x', kind: 'video', title, path, description: '', ...extra });

test('folder facts: described movies and cassettes leave Needs Filing by rule, keeping her sub-folders', () => {
  const d = L.decide({ kind: 'audio', title: 'Ali', path: 'Audio/Needs Filing/described movies and TV/Movies/A' }, {});
  assert.strictEqual(d.to, 'Audio/Described Movies & TV/Movies/A');
  assert.strictEqual(L.decide({ kind: 'audio', title: 'Bambi', path: 'Audio/Needs Filing/Cassette tapes/Story tapes' }, {}).to, 'Audio/Cassettes/Story tapes');
  assert.strictEqual(L.questionsFor({ kind: 'audio', title: 'Ali', path: 'Audio/Needs Filing/described movies and TV/Movies/A' }), null, 'Jev is never asked about a folder fact');
  assert.strictEqual(L.categoryOf('Audio/Described Movies & TV/Movies/A', 'audio'), 'movie');
  assert.strictEqual(L.categoryOf('Audio/Cassettes/Story tapes', 'audio'), 'cassette');
});

test('zones: intake, local shelves, filed, and books skipped', () => {
  assert.strictEqual(L.zoneOf(video('a', 'Videos/Needs Filing/Archive Intake')), 'intake');
  assert.strictEqual(L.zoneOf(video('a', 'Videos/Advertising/Show Promos (Review)')), 'intake');
  assert.strictEqual(L.zoneOf(video('a', '')), 'intake');
  assert.strictEqual(L.zoneOf(video('a', 'Video/Ozarks (Springfield Area)/Local News/1990s')), 'local');
  assert.strictEqual(L.zoneOf(video('a', 'Video/Missouri/Kansas City (Local)/1990s')), 'local');
  assert.strictEqual(L.zoneOf(video('a', 'Video/Commercials/Toys & Video Games/1990s')), 'filed');
  assert.strictEqual(L.zoneOf({ kind: 'text', title: 'a', path: 'Books/Poetry' }), 'skip');
});

test('networks come off the title by rule, longest name first', () => {
  assert.strictEqual(L.networkOf('Nick jr on CBS commercial breaks 2005'), 'Nickelodeon');
  assert.strictEqual(L.networkOf('ABC Family promo 2003'), 'ABC Family');
  assert.strictEqual(L.networkOf('Teennick degrassi promo 2013'), 'TeenNick');
  assert.strictEqual(L.networkOf('Teenick Sabrina commercial breaks 2003'), 'TeenNick', 'her own spelling, one n');
  assert.strictEqual(L.networkOf('Toon Disney bumper'), 'Toon Disney');
  assert.strictEqual(L.networkOf('Playhouse Disney sign on 2007'), 'Disney Channel');
  assert.strictEqual(L.networkOf('Sprout tape commercial breaks 2015'), 'Sprout');
  assert.strictEqual(L.networkOf('1999 Dodge commercial'), null);
});

test('decades come off the folder, then the title, never from Jev', () => {
  assert.strictEqual(L.decadeOf(video('x 1999', 'Video/PSAs/1980s')), '1980s');
  assert.strictEqual(L.decadeOf(video('Noggin commercial breaks 2004', 'Videos/Needs Filing/Archive Intake')), '2000s');
  assert.strictEqual(L.decadeOf(video('March', 'Videos/Needs Filing/Archive Intake')), 'Undated');
});

test('intake: Jev decides the shelf; the network and decade come from rules', () => {
  const brk = L.decide(video('Noggin commercial breaks 2004', 'Videos/Needs Filing/Archive Intake'), ans({ kind: ['Block of several commercials', 1] }));
  assert.strictEqual(brk.to, 'Video/Commercials/Commercial Breaks/Noggin/2000s');
  const ad = L.decide(video('1999 Jeep Cherokee commercial', 'Videos/Needs Filing/Archive Intake'), ans({ kind: ['One product advert', 1], category: ['Cars and Trucks', 0.98] }));
  assert.strictEqual(ad.to, 'Video/Commercials/Cars and Trucks/1990s');
  const unsure = L.decide(video('Playhouse Disney clay role polie olie intro', 'Videos/Needs Filing/Archive Intake'), ans({ kind: ['Promo for a TV programme or channel', 0.44] }));
  assert.strictEqual(unsure.to, null, 'under the floor it stays for a person');
  const promo = L.decide(video('Nick jr backyardigans is next 2012', 'Videos/Needs Filing/Archive Intake'), ans({ kind: ['Promo for a TV programme or channel', 0.95] }));
  assert.strictEqual(promo.to, 'Video/Channels/Nickelodeon/2010s');
  const show = L.decide(video('Bear in the big blue house intro 2001', 'Videos/Needs Filing/Archive Intake'), ans({ kind: ['Episode or clip of a TV programme', 0.9] }), { broadcastShelf: () => 'TV Shows/Bear in the Big Blue House/Intros & Credits' });
  assert.strictEqual(show.to, 'Video/TV Shows/Bear in the Big Blue House/Intros & Credits/2000s');
  const brandless = L.decide(video('Mystery spot 1988', 'Videos/Needs Filing/Archive Intake'), ans({ kind: ['One product advert', 0.9], category: ['Toys & Video Games', 0.4] }));
  assert.strictEqual(brandless.to, 'Video/Commercials/Other Commercials/1980s', 'an advert with no sure shelf still leaves intake');
});

test('Missouri comes first, to the right local shelf, with tags', () => {
  const item = video('September 13, 1990 KSDK partial 6 p.m', 'Videos/Needs Filing/Archive Intake');
  const d = L.decide(item, ans({ kind: ['News or special report', 0.96], recorded: 0.95, madefor: 0.9, local: 0.92, area: ['St. Louis', 0.97] }));
  assert.strictEqual(d.to, 'Video/Missouri/St. Louis (Local)/1990s');
  assert.deepStrictEqual(d.tags, ['Missouri', 'St. Louis']);
  const oz = L.decide(video('KOLR 10 Commercials Meeks 1988', 'Video/Commercials/Home Improvement/1980s'),
    ans({ kind: ['One product advert', 0.9], recorded: 0.9, madefor: 0.9, local: 0.9, area: ['Springfield and the Ozarks', 0.95], localKind: ['Local Commercials', 0.93] }));
  assert.strictEqual(oz.to, 'Video/Ozarks (Springfield Area)/Local Commercials/1980s');
  const unsure = L.decide(video('EyeMasters 2004', 'Video/Commercials/Other Commercials/2000s'), ans({ recorded: 0.8, madefor: 0.5, local: 0.65, area: ['Kansas City', 0.9] }));
  assert.strictEqual(unsure.to, null);
  assert.ok(unsure.flags[0].startsWith('Jev review: Missouri (Kansas City), unsure if local (0.65)'), unsure.flags[0]);
});

test('local shelves are never moved from, only flagged', () => {
  const d = L.decide(video('KY3 promo 1994 from a UK tape', 'Video/Ozarks (Springfield Area)/Show Promos/1990s'), ans({ kind: ['One product advert', 1], category: ['Toys & Video Games', 1], foreign: 0.95 }));
  assert.strictEqual(d.to, null);
  assert.deepStrictEqual(d.flags, ['Jev review: made outside the US (0.95).']);
});

test('audit: a store stays a store; a re-shelving needs near-certainty', () => {
  const kmart = L.decide(video('Kmart ad w/Martha Stewart, 1997', 'Video/Commercials/Stores & Retail/1990s'), ans({ kind: ['One product advert', 1], category: ['Clothing & Shoes', 0.99] }));
  assert.strictEqual(kmart.to, null);
  const buns = L.decide(video('Cinnamon Mini-Buns ad, 1993', 'Video/Commercials/Food & Grocery/1990s'), ans({ kind: ['One product advert', 1], category: ['Breakfast Cereal', 1] }));
  assert.strictEqual(buns.to, 'Video/Commercials/Breakfast Cereal/1990s');
  const middling = L.decide(video('Cinnamon Mini-Buns ad, 1993', 'Video/Commercials/Food & Grocery/1990s'), ans({ kind: ['One product advert', 1], category: ['Breakfast Cereal', 0.92] }));
  assert.strictEqual(middling.to, null);
  const psa = L.decide(video('Missing Children | 1-800-The-Lost | 2002', 'Video/Commercials/Sweepstakes & Direct Response/2000s'), ans({ kind: ['Public service announcement', 0.9], category: ['Charities & Nonprofits', 0.6] }));
  assert.strictEqual(psa.to, 'Video/PSAs/2000s');
});

test('audit: a single advert filed under a channel goes to its product shelf', () => {
  const d = L.decide(video('Budweiser | Television Commercial | 1988 | USA Olympics', 'Video/Channels/USA Network/1980s'), ans({ kind: ['One product advert', 1], category: ['Beer, Wine & Spirits', 0.99] }));
  assert.strictEqual(d.to, 'Video/Commercials/Beer, Wine & Spirits/1980s');
  const promo = L.decide(video('ABC Fall Preview 1989', 'Video/Channels/ABC/1980s'), ans({ kind: ['Promo for a TV programme or channel', 1], category: ['Movies & Home Entertainment', 0.9] }));
  assert.strictEqual(promo.to, null);
});

test('Other Commercials is not re-guessed, and costs no Jev question without a flag to raise', () => {
  assert.strictEqual(L.questionsFor(video("Mueller's ad, 1978", 'Video/Commercials/Other Commercials/1970s')), null);
  assert.strictEqual(L.decide(video("Mueller's ad, 1978", 'Video/Commercials/Other Commercials/1970s'), ans({ kind: ['One product advert', 1], category: ['Medicine & Pharmacy', 0.94] })).to, null);
});

test('VHS tapes get a kind shelf; home movies need 0.85 and are flagged', () => {
  const vhs = (t) => video(t, 'Video/Home Video (VHS)/1990s');
  assert.strictEqual(L.decide(vhs('Deep Cover (1992) VHS Trailer'), ans({ tape: ['Openings & Previews', 0.86] })).to, 'Video/Home Video (VHS)/Openings & Previews/1990s');
  const sears = L.decide(vhs('Sears Get A Picture Taken with ET 1991'), ans({ tape: ['Home Movies', 0.76] }));
  assert.strictEqual(sears.to, null);
  assert.deepStrictEqual(sears.flags, []);
  const family = L.decide(vhs('Safari, Carnival, Rides & Aquatic Show On April 3, 1991 Family Video'), ans({ tape: ['Home Movies', 1] }));
  assert.strictEqual(family.to, 'Video/Home Video (VHS)/Home Movies/1990s');
  assert.deepStrictEqual(family.flags, ['Space review: family or local home recording.']);
  assert.strictEqual(L.decide(vhs('Zondervan Video (VHS)'), ans({ tape: ['Other Tapes', 0.82] })).to, null);
});

test('full sports games are flagged, never moved; Missouri teams are left alone', () => {
  const game = video('Auburn Tigers at LSU Tigers | College Football | 1997', 'Video/Commercials/Education & Careers/1990s', { bytes: 1.2e9 });
  const d = L.decide(game, ans({ kind: ['Episode or clip of a TV programme', 0.6] }));
  assert.strictEqual(d.to, null);
  assert.deepStrictEqual(d.flags, ['Space review: full sports game broadcast.']);
  const cards = video('Chiefs @ Raiders NFL 1995', 'Video/Channels/NBC/1990s', { bytes: 1.2e9 });
  assert.deepStrictEqual(L.decide(cards, ans({})).flags, []);
});

test('questions: only what the item needs', () => {
  const q = L.questionsFor(video('Budweiser ad 1988', 'Video/Channels/USA Network/1980s'));
  assert.deepStrictEqual(Object.keys(q).sort(), ['category', 'kind']);
  const mo = L.questionsFor(video('KSDK news 1990', 'Videos/Needs Filing/Archive Intake'));
  assert.ok(mo.recorded && mo.madefor && mo.local && mo.area && mo.localKind);
  const uk = L.questionsFor(video('British Gas advert 1986', 'Video/Commercials/Gas, Oil & Auto Care/1980s'));
  assert.ok(uk.foreign);
  assert.strictEqual(L.questionsFor({ kind: 'audio', title: 'x', path: 'Audio/Radio Commercials/Banks & Insurance' }), null);
});

test('the description Jev reads drops headers, links and disclaimers', () => {
  const text = 'Source: https://www.youtube.com/watch?v=abc\nMatched by: TubeVault download history\nPublisher description (video):\nCommercial breaks from WGN, 1994.\nNo copyright infringement intended.\nhttp://x.y/z';
  assert.strictEqual(L.clean(text), 'Commercial breaks from WGN, 1994.');
});

test('fileMedia never throws: a failed item comes back with error and stays put', async () => {
  const items = [video('Noggin commercial breaks 2004', 'Videos/Needs Filing/Archive Intake', { _id: 'a' }), video('Boom 1999', 'Videos/Needs Filing/Archive Intake', { _id: 'b' })];
  const ask = async (state) => {
    if (state.title.startsWith('Boom')) throw new Error('timeout');
    return { answers: ans({ kind: ['Block of several commercials', 1] }), usage: { input_tokens: 1000 } };
  };
  const { decisions, costUSD } = await L.fileMedia(items, { ask });
  const byTitle = Object.fromEntries(decisions.map((d) => [d.item.title, d]));
  assert.strictEqual(byTitle['Noggin commercial breaks 2004'].to, 'Video/Commercials/Commercial Breaks/Noggin/2000s');
  assert.strictEqual(byTitle['Boom 1999'].to, null);
  assert.strictEqual(byTitle['Boom 1999'].error, 'timeout');
  assert.ok(costUSD > 0);
});
