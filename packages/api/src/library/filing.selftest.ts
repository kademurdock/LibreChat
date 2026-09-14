import assert from 'node:assert/strict';
import { classifyMediaTitle as classify, commercialPath, filingCategory, refineMediaFiling } from './filing';
const cases: [string, string | null][] = [
 ['My Scene Chillin Out Commercial (2003)', 'Commercials/Toys & Video Games/My Scene'],
 ['Bratz The Movie Making Set Commercial (2007)', 'Commercials/Toys & Video Games/Bratz'],
 ['My Scene Goes Hollywood DVD Commercial (2005)', 'Commercials/Movies & Home Entertainment'],
 ['Kasey the Kinderbot ad, 2002', 'Commercials/Toys & Video Games/Learning Toys'],
 ['Kacey the Kinderbot commercial', 'Commercials/Toys & Video Games/Learning Toys'],
 ['Pledge ad, 1975', 'Commercials/Cleaning & Household'],
 ['Shout ad, 1998', 'Commercials/Cleaning & Household'],
 ['Hallmark Pledge | Television Commercial | 1989', 'Commercials/Greeting Cards & Gifts'],
 ['Tripledge Wipers commercial', 'Commercials/Gas, Oil & Auto Care'],
 ['Lincoln Logs ad, 1976', 'Commercials/Toys & Video Games'],
 ['ERA Real Estate commercial', 'Commercials/Real Estate'],
 ['Time Life Home Repair Books commercial', 'Commercials/Newspapers, Magazines & Books'],
 ['Care Free Sugarless Gum (1988) Retro Television Commercial', 'Commercials/Candy, Gum & Chocolate'],
 ['Bob Holden for MO governor ad 2000 (anti-Talent)', 'Missouri/Political Ads'],
 ['Matt Blunt for secretary of state ad 2000 mo anti Gaw', 'Missouri/Political Ads'],
 ['Local Branson furniture ad 1998', 'Missouri/Local Commercials'],
 ['Local Springfield MA furniture ad', null],
 ['All-Star Junior Pyramid disclaimer & commercial bumper, 1979', 'TV Shows/Game Shows/All-Star Junior Pyramid/Bumpers'],
 ['Alvin and the Chipmunks commercial bumpers 1989', 'TV Shows/Alvin and the Chipmunks/Bumpers'],
 ['WJW Movie Special Cinema 8 Commercial Bumper 11/1986', 'Channels/WJW/Bumpers'],
 ['Nickelodeon station ID', 'Channels/Nickelodeon/Station IDs & Sign-offs'],
 ['Hidalgo Movie Feature Film Television Commercial', 'Movies & Studios/Trailers & Previews'],
 ['Godfather’s Pizza ad Smartest Women In The Trailer Park', 'Commercials/Restaurants & Fast Food'],
 ['Unisom radio ad 1988', 'Radio/Radio Commercials/Medicine & Pharmacy'],
 ['Unknown product radio commercial 1991', 'Radio/Radio Commercials/Unidentified Products'],
 ['Radio aircheck 1995', 'Radio/Airchecks & Broadcasts'],
 ['Found cassette 1981', 'Audio Tapes/Home & Found Recordings'],
 ['Sermon cassette tape 1990', 'Audio Tapes/Spoken Word'],
 ['Music mixtape cassette', 'Audio Tapes/Music'],
 ['Unlabeled cassette', 'Audio Tapes/Unidentified Recordings'],
 ['Cassette audiobook', 'Audiobooks'],
 ['Maxell cassette commercial', 'Commercials/Electronics & Tech'],
 ['Unisom and Eggo compilation', null],
 ['Pledge and Shout commercial compilation', 'Commercials/Commercial Breaks'],
 ['Unknown movie name ad', null],
 ['All My Children promo', null],
];
for (const [title, expected] of cases) assert.equal(classify(title), expected, title);
assert.equal(commercialPath('Video/Commercials/Other Commercials/2000s', cases[0][0]), 'Video/Commercials/Toys & Video Games/My Scene/2000s');
assert.equal(commercialPath('Videos/My custom shelf', 'Unisom ad'), null);
assert.equal(commercialPath('Audio', 'Unisom radio ad'), 'Audio/Radio/Radio Commercials/Medicine & Pharmacy');
assert.equal(commercialPath('Audio/Radio/Radio Commercials/1990s', 'Unisom radio ad'), 'Audio/Radio/Radio Commercials/Medicine & Pharmacy/1990s');
assert.equal(commercialPath('Audio/Audio Tapes/Undated', 'Unlabeled cassette'), 'Audio/Audio Tapes/Unidentified Recordings/Undated');
assert.equal(commercialPath('Videos', 'My Scene story'), null);
assert.equal(filingCategory('Audio/Audio Tapes/Spoken Word', 'audio'), 'cassette');
assert.equal(filingCategory('Videos/Movies & Studios/Trailers & Previews'), 'movie');
assert.equal(filingCategory('Video/Missouri/Political Ads'), 'commercials');
assert.equal(filingCategory('Videos/TV Shows/Finders Keepers/Bumpers'), 'tv');
assert.equal(refineMediaFiling({ kind: 'text', title: 'Unisom ad', path: 'Videos' }), null);
const first = refineMediaFiling({ kind: 'audio', title: 'Unisom radio ad', path: 'Audio' })!;
assert.equal(refineMediaFiling({ kind: 'audio', title: 'Unisom radio ad', ...first }), null);
console.log(`${cases.length + 10} media filing regression cases passed.`);

assert.equal(classify('Olympus ad, 2003'), 'Commercials/Photography & Film');
assert.equal(classify('Shrek The Third Out Of Control Triplets + Laugh With Me Baby Commercial (2007)'), 'Commercials/Toys & Video Games');
assert.equal(classify('McDonalds Happy Meal Commercial: My Scene (2007)'), 'Commercials/Restaurants & Fast Food');
assert.equal(classify('Milk-Bone ad, 1975'), 'Commercials/Pet Products');
assert.equal(refineMediaFiling({ kind: 'video', title: 'Milk-Bone ad, 1975', path: 'Video/Commercials/Drinks (Non-Alcoholic)/1970s', meta: { type: 'commercial' } }, true)?.path, 'Videos/Commercials/Pet Products/1970s');
assert.equal(refineMediaFiling({ kind: 'video', title: 'Milk-Bone ad, 1975', path: 'Videos/Favorites', meta: { type: 'custom' } }, true), null);
assert.equal(refineMediaFiling({ kind: 'video', title: 'Sabrina the Teenage Witch ABC Family episode 2005', path: 'Video/Channels/ABC Family/2000s', meta: { type: 'network' } }, true)?.path, 'Videos/TV Shows/Sabrina the Teenage Witch/2000s');
assert.equal(refineMediaFiling({ kind: 'video', title: 'Sabrina the Teenage Witch ABC Family episode 2005', path: 'Videos/Favorites', meta: { type: 'custom' } }, true), null);
console.log('Whole collection product, program and custom-folder regressions passed.');
