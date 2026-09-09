const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const source = path.resolve(__dirname, '../../client/src/components/Chat/character');
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });
for (const name of fs.readdirSync(source)) {
  if (name.endsWith('.mjs') && !name.includes('.test.')) fs.copyFileSync(path.join(source, name), path.join(out, name));
}
for (const name of ['workshop.html', 'workshop.mjs', 'portrait.png', 'kiana-atlas-draft.png', 'character-sample.wav', 'windflower-preview.wav']) {
  fs.copyFileSync(path.join(__dirname, name), path.join(out, name));
}
fs.writeFileSync(path.join(out, 'playback-browser.mjs'), stripTypeScriptTypes(fs.readFileSync(path.join(source, 'playback.ts'), 'utf8')));
fs.copyFileSync(path.resolve(__dirname, '../../client/public/assets/characters/kiana/eyes-closed.png'), path.join(out, 'eyes-closed.png'));
console.log('Built ' + out + '\nServe this directory on loopback and open workshop.html.');
