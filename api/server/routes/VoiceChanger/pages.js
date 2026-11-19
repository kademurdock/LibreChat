/* The Voice Changer's two pages, assembled once at startup (the Clubhouse pages.js way):
 *   voiceChangerHtml  /voice-changer         the website page (page.html + page.js)
 *   engineHostHtml    /voice-changer/engine  the iPhone's hidden engine host (engine.html + engine.js)
 * SHARED_HEAD and each script are spliced in with function replacers, so no template-literal
 * escaping touches the scripts. The engine folder's address, /vc-engine/<version>/, goes into
 * a meta tag in both pages: the version is serve.js engineVersion() (manifest.json), the same
 * one the engine is served under, so a page and its engine never drift apart. */
const fs = require('node:fs');
const path = require('node:path');
const { SHARED_HEAD } = require('../kadePages');

const VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** The engine version, or '' when it cannot be read (the website page then asks /config). */
function engineVersion() {
  try {
    const v = require('../../kadeVoiceChanger/serve').engineVersion();
    if (VERSION_RE.test(String(v))) return String(v);
  } catch (_) {
    /* serve.js missing or unhappy: read the manifest directly */
  }
  try {
    const file = path.join(__dirname, '..', '..', 'kadeVoiceChanger', 'engine', 'manifest.json');
    const v = String(JSON.parse(fs.readFileSync(file, 'utf8')).version || '').trim();
    return VERSION_RE.test(v) ? v : '';
  } catch (_) {
    return '';
  }
}

const VERSION = engineVersion();
const ENGINE_BASE = VERSION ? `/vc-engine/${VERSION}/` : '';

function page(stem) {
  const html = fs.readFileSync(path.join(__dirname, stem + '.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, stem + '.js'), 'utf8');
  return html
    .replace('<!-- KADE_SHARED_HEAD -->', () => SHARED_HEAD)
    .split('__VC_ENGINE_BASE__')
    .join(ENGINE_BASE)
    .replace('<!-- KADE_CLIENT_SCRIPT -->', () => script);
}

module.exports = {
  voiceChangerHtml: page('page'),
  engineHostHtml: page('engine'),
  engineVersion: VERSION,
  engineBase: ENGINE_BASE,
};
