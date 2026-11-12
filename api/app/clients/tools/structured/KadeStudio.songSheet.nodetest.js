/* Nov 12 2026 (the lyric desk craft review): what a character is told about the song sheet it writes.
 * Songs made by talking go straight to YuE2 with no desk and no checks, so the tool's own words are
 * all the craft the character gets. The real KadeStudio.js is loaded under each setting of the
 * switch, and its words are held against the twin in packages/api/src/tools/registry/definitions.ts.
 * No database, no network, no model.
 *
 * Run: node --test api/app/clients/tools/structured/KadeStudio.songSheet.nodetest.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stubModules } = require('../../../../test/kadeFakeMongo.cjs');

stubModules({
  '@librechat/agents/langchain/tools': { Tool: class {} },
  '@librechat/data-schemas': { logger: { warn() {}, info() {}, error() {} } },
});

const FILE = path.join(__dirname, 'KadeStudio.js');
const TWIN = fs.readFileSync(path.join(__dirname, '../../../../../packages/api/src/tools/registry/definitions.ts'), 'utf8');

/** The tool as a character is handed it, with the switch set as given when the file loads. */
function toolUnder(value) {
  const old = process.env.KADE_LYRIC_CRAFT_NOV12;
  if (value === undefined) delete process.env.KADE_LYRIC_CRAFT_NOV12;
  else process.env.KADE_LYRIC_CRAFT_NOV12 = value;
  try {
    delete require.cache[require.resolve(FILE)];
    const KadeStudio = require(FILE);
    const tool = new KadeStudio({});
    return { description: tool.description, direction: tool.schema.properties.direction.description, lyrics: tool.schema.properties.lyrics.description };
  } finally {
    if (old === undefined) delete process.env.KADE_LYRIC_CRAFT_NOV12;
    else process.env.KADE_LYRIC_CRAFT_NOV12 = old;
    delete require.cache[require.resolve(FILE)];
  }
}

const CRAFT =
  'Write a song people can sing: a hook someone would say out loud, a chorus in plain words, verses in plain speech with end rhymes a listener can hear, and a second verse that says something the first did not. ';
const SHEET =
  "quote. The exact words to sing, laid out as a singer's sheet: [Verse 1], [Chorus] and [Bridge] tags alone on their own lines; one sung phrase per line, short enough for one breath; every chorus written out in full each time it is sung; words in (parentheses) are sung as backing vocals, so put no direction or repeat note there; numbers written as words. Leave out only for an instrumental.";
const DIRECTION =
  'quote. The music in one or two short sentences: the language, the genre, the rhythmic feel, a few instruments and the lead singing voice chosen for this song.';
const OLD_SHEET = 'quote. The exact words to sing, with [Verse] and [Chorus] tags on their own lines. Leave out only for an instrumental.';
const OLD_DIRECTION = 'quote. The music in a sentence or two: genre, instruments, tempo, and the singing voice (for example "warm female lead vocal").';

test('the character is told what a singable song and a singer\'s sheet look like, with no sample voice', () => {
  const tool = toolUnder(undefined);
  assert.ok(tool.description.includes(`read them back, change what they ask. ${CRAFT}Then the song is made in the background;`), 'the craft sentence follows the first one');
  assert.equal(tool.lyrics, SHEET);
  assert.equal(tool.direction, DIRECTION);
  assert.doesNotMatch(tool.direction, /warm female lead vocal|for example/, 'a sample voice in quotes becomes the house voice');
  assert.match(tool.description, /ALWAYS quote first, say the price in your reply in plain words, and call start only in a LATER reply after their own message says yes\./, 'the money rules are untouched');
  assert.match(tool.description, /If you are talking by voice or on a phone call, a song cannot be started/);
});

test('KADE_LYRIC_CRAFT_NOV12=0 puts the Nov 10 wording back, word for word', () => {
  const now = toolUnder(undefined);
  const before = toolUnder('0');
  assert.equal(before.lyrics, OLD_SHEET);
  assert.equal(before.direction, OLD_DIRECTION);
  assert.equal(before.description, now.description.replace(CRAFT, ''));
  assert.doesNotMatch(before.description, /Write a song people can sing/);
  assert.deepEqual(toolUnder('1'), now, 'any other value leaves the new wording on');
});

test('the twin in the tool registry carries the same words and the same switch', () => {
  for (const words of [CRAFT, DIRECTION, OLD_SHEET, OLD_DIRECTION, 'KADE_LYRIC_CRAFT_NOV12'])
    assert.ok(TWIN.includes(words), words.slice(0, 60));
  assert.ok(TWIN.includes(SHEET), 'the sheet layout');
  const mine = fs.readFileSync(FILE, 'utf8');
  for (const words of [CRAFT, DIRECTION, SHEET, OLD_SHEET, OLD_DIRECTION]) assert.ok(mine.includes(words), words.slice(0, 60));
});
