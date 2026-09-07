const fs = require('node:fs');
const path = require('node:path');
const { SHARED_HEAD } = require('../kadePages');

// Assemble once at startup. Scripts stay inline: no new network request or
// cached client bundle can drift from the HTML served with no-store.
function page(stem) {
  const html = fs.readFileSync(path.join(__dirname, stem + '.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, stem + '.js'), 'utf8');
  return html.replace('<!-- KADE_SHARED_HEAD -->', () => SHARED_HEAD)
    .replace('<!-- KADE_CLIENT_SCRIPT -->', () => script);
}
module.exports = { loungeHtml: page('lounge'), engineHtml: page('engine') };
