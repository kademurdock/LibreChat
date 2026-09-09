const assert = require('node:assert/strict');
const { test } = require('node:test');
const { leveledReverieUrl, presignReverieUrl } = require('./seedSounds');
test('original B2 ward keys resolve to cache-distinct playback copies', async () => {
  for (const ward of ['bellward','fairlawn','gate','gravewalk','hook','longacre','millrace','patch','sweetwater','tanglefoot']) {
    const old = `https://s3.us-east-005.backblazeb2.com/Kademurdockchat/reverie-sounds/amb.${ward}.m4a?X-Amz-Signature=expired`;
    const expected = `https://kademurdock.com/assets/sounds/reverie/levels173/amb.${ward}.m4a`;
    assert.equal(leveledReverieUrl(old), expected);
    assert.equal(await presignReverieUrl(old), expected);
  }
});
test('room tones, owner replacement keys, other hosts and malformed URLs stay unchanged', () => {
  for (const url of [
    'https://s3.us-east-005.backblazeb2.com/Kademurdockchat/reverie-sounds/amb.tanglefoot.v2.m4a',
    'https://s3.us-east-005.backblazeb2.com/Kademurdockchat/reverie-sounds/amb.water.pier.dawn.m4a',
    'https://example.com/Kademurdockchat/reverie-sounds/amb.tanglefoot.m4a',
    'https://kademurdock.com/assets/sounds/reverie/levels173/amb.tanglefoot.m4a',
    'bad-url'
  ]) assert.equal(leveledReverieUrl(url), null);
});
