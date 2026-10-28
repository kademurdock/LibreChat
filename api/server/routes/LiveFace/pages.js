const fs = require('node:fs');
const path = require('node:path');
const { SHARED_HEAD } = require('../kadePages');

// Assembled once at startup, scripts inline, served no-store (the
// Clubhouse engine's lesson: a cached page replays old bugs on new phones).
const html = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8');
const liveFaceHtml = html
  .replace('<!-- KADE_SHARED_HEAD -->', () => SHARED_HEAD)
  .replace('<!-- KADE_CLIENT_SCRIPT -->', () => script);

module.exports = { liveFaceHtml };
