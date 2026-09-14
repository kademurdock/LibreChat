import assert from 'node:assert/strict';
import { broadcastShelf } from './broadcast';
import { refineMediaFiling } from './filing';

assert.equal(broadcastShelf('Sabrina the Teenage Witch ABC Family episode 2005'), 'TV Shows/Sabrina the Teenage Witch');
assert.equal(broadcastShelf('Drake & Josh Promos (August 2007)', 'Drake & Josh'), 'TV Shows/Drake & Josh/Promos & Previews');
assert.equal(broadcastShelf('Guiding Light & CBS Evening News promos, 1980'), 'TV Shows/Program Lineups');
assert.equal(broadcastShelf('ALF & Amazing Stories promo, 1986', 'ALF'), 'TV Shows/Program Lineups');
assert.equal(broadcastShelf('CSI & Joan of Arcadia promos, 2003'), 'TV Shows/Program Lineups');
assert.equal(broadcastShelf('PAX Life Today & Day of Discovery promos, 2003'), null);
assert.equal(broadcastShelf('Scrabble board game demo 1987'), null);
assert.equal(broadcastShelf('WMDT ABC commercial breaks August 25, 1999'), null);
assert.equal(refineMediaFiling({ kind: 'video', title: 'Burger King (1988) Television Commercial - Alf Puppets - Alien Invasion Coming Soon', path: 'Video/TV Shows/ALF/1980s', meta: { type: 'show' } }, true)?.path, 'Videos/Commercials/Restaurants & Fast Food/1980s');
console.log('Program, mixed lineup, product endorsement and false-match checks passed.');
