/**
 * KADE July 16 2026 — SPOTTER routes + builder page.
 *
 *   GET  /api/kade/spotter            (JWT) -> { spotter|null, voices }
 *   POST /api/kade/spotter            (JWT) -> save { name, voice, persona } (or { reset: true })
 *   POST /api/kade/spotter/generate   (JWT) -> { persona } — one cheap LLM call
 *   GET  /spotter                     (page) — the builder: free text OR quiz
 *                                     OR generate-for-me, name generator,
 *                                     voice picker with real samples.
 *
 * Design notes: the Spotter is per-ACCOUNT (one each). Voices are Google's 8
 * prebuilt Live voices — samples pre-generated once and committed under
 * client/public/assets/spotter-voices/ (served same as game sounds). The
 * generate endpoint goes through reframe-proxy with the cheapest non-thinking
 * model; it writes NOTHING — the user still has to press Save.
 */
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { getSpotter, setSpotter, deleteSpotter } = require('~/models/kadeSpotter');
const { ensureSpotterAgent } = require('~/models/kadeSpotterAgent');

const router = express.Router();

const SPOTTER_VOICES = [
  { id: 'Puck',   blurb: 'Upbeat and playful — masculine' },
  { id: 'Charon', blurb: 'Deep and steady — masculine' },
  { id: 'Kore',   blurb: 'Firm and confident — feminine' },
  { id: 'Fenrir', blurb: 'Excitable, big energy — masculine' },
  { id: 'Aoede',  blurb: 'Breezy and easygoing — feminine' },
  { id: 'Leda',   blurb: 'Youthful and bright — feminine' },
  { id: 'Orus',   blurb: 'Calm and grounded — masculine' },
  { id: 'Zephyr', blurb: 'Bright and friendly — feminine' },
];
const VOICE_IDS = new Set(SPOTTER_VOICES.map((v) => v.id));

router.get('/', requireJwtAuth, async (req, res) => {
  try {
    const uid = String(req.user.id || req.user._id);
    const spotter = await getSpotter(uid);
    // Session 21i: lazily back-fill the textable Spotter agent for anyone who
    // set up a Spotter before this existed. Fire-and-forget so the page never
    // waits on it; it self-links the agentId on first run.
    if (spotter && spotter.name && !spotter.agentId) {
      ensureSpotterAgent(uid, spotter).catch(() => {});
    }
    return res.json({ spotter, voices: SPOTTER_VOICES });
  } catch (err) {
    logger.error('[kadeSpotter] get failed', err);
    return res.status(500).json({ error: 'spotter lookup failed' });
  }
});

router.post('/', requireJwtAuth, async (req, res) => {
  try {
    const uid = String(req.user.id || req.user._id);
    if (req.body && req.body.reset === true) {
      await deleteSpotter(uid);
      return res.json({ spotter: null });
    }
    const name = String((req.body && req.body.name) || '').trim().slice(0, 40);
    const voice = String((req.body && req.body.voice) || '').trim();
    const persona = String((req.body && req.body.persona) || '').trim().slice(0, 12000);
    if (!name) return res.status(400).json({ error: 'Your Spotter needs a name.' });
    if (!VOICE_IDS.has(voice)) return res.status(400).json({ error: 'Pick one of the eight voices.' });
    const spotter = await setSpotter(uid, { name, voice, persona });
    // Create or update this account's textable Spotter agent to match. Awaited
    // so the returned spotter carries the agentId, but fail-soft inside.
    const agentId = await ensureSpotterAgent(uid, spotter);
    return res.json({ spotter: { ...spotter, agentId: agentId || (spotter && spotter.agentId) || null } });
  } catch (err) {
    logger.error('[kadeSpotter] save failed', err);
    return res.status(500).json({ error: 'spotter save failed' });
  }
});

/** One cheap non-thinking LLM call to draft a persona. Seed = free text
 *  and/or quiz answers; works with neither (pure surprise-me). */
router.post('/generate', requireJwtAuth, async (req, res) => {
  try {
    const key = process.env.REFRAME_PROXY_SECRET;
    if (!key) return res.status(503).json({ error: 'generator not configured' });
    const seed = String((req.body && req.body.seed) || '').slice(0, 1200);
    const axios = require('axios');
    const prompt =
      'Write a personality brief for a "Spotter" — someone\'s personal live video companion who watches ' +
      'through their camera and talks to them in real time (many users are blind or low-vision; some are ' +
      'sighted people who need a second pair of eyes on wiring, labels, screens). Write 4-7 sentences, second ' +
      'person ("You are..."), covering: overall vibe/energy, how chatty they are when something appears, blunt ' +
      'vs gentle, formal vs slangy, sense of humor, and how they handle not being sure of what they see. Plain ' +
      'text only, no headings, no name (the user names them separately), no mention of AI or Gemini.' +
      (seed ? ' Build it around what the user asked for: "' + seed.replace(/"/g, "'") + '"' : ' Invent a distinctive, likable one — surprise them.');
    const r = await axios.post(
      (process.env.REFRAME_PROXY_URL || 'https://reframe-proxy-production.up.railway.app') + '/chat/completions',
      {
        model: 'google/gemini-2.5-flash-lite',
        stream: false,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      },
      { timeout: 25000, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' } },
    );
    const text = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content;
    if (!text) return res.status(502).json({ error: 'generator returned nothing' });
    return res.json({ persona: String(text).trim().slice(0, 4000) });
  } catch (err) {
    logger.error('[kadeSpotter] generate failed: ' + (err && err.message));
    return res.status(502).json({ error: 'generator unavailable right now' });
  }
});

/* ------------------------------- the page ------------------------------- */

const SPOTTER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Your Spotter — build your live companion</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: calc(1.25rem + env(safe-area-inset-top,0px)) 1.25rem calc(2rem + env(safe-area-inset-bottom,0px));
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.55; color: #16181d; background: #f6f7f9; max-width: 760px; margin-left: auto; margin-right: auto; }
  @media (prefers-color-scheme: dark) {
    body { color: #e7e9ee; background: #14161a; }
    .card, fieldset { background: #1e2127 !important; border-color: #2c2f37 !important; }
    label.opt { border-color: #3a3e47 !important; }
    textarea, input[type=text] { background:#14161a; color:#e7e9ee; border-color:#3a3e47 !important; }
  }
  h1 { font-size: 1.7rem; margin: 0 0 .2rem; }
  .muted { opacity: .75; }
  a.back { display:inline-block; margin:0 0 .5rem; font-weight:600; text-decoration:none; color:#2f6fed; }
  a.back:focus-visible, button:focus-visible, label.opt:focus-within, textarea:focus-visible, input:focus-visible { outline: 3px solid #ffbf47; outline-offset: 2px; }
  .card, fieldset { background:#fff; border:1px solid #e3e6ea; border-radius:14px; padding:1.1rem 1.2rem; margin:1rem 0; }
  fieldset legend { font-weight:700; font-size:1.05rem; padding:0 .4rem; }
  label.opt { display:flex; gap:.6rem; align-items:flex-start; padding:.65rem .7rem; border:1px solid #dfe3e8; border-radius:10px; margin:.45rem 0; cursor:pointer; font-size:1rem; }
  label.opt input { margin-top:.2rem; width:1.15rem; height:1.15rem; flex:none; }
  textarea { width:100%; min-height:9rem; font: inherit; border:1px solid #dfe3e8; border-radius:10px; padding:.7rem; }
  input[type=text] { width:100%; font: inherit; border:1px solid #dfe3e8; border-radius:10px; padding:.7rem; }
  button.go { display:block; width:100%; background:#2f8f5b; color:#fff; border:0; border-radius:12px; font-size:1.15rem; font-weight:700; padding:1rem; cursor:pointer; margin:1.2rem 0; }
  button.lite { background:transparent; color:#2f6fed; border:1px solid #2f6fed; border-radius:10px; padding:.6rem 1rem; font-weight:600; cursor:pointer; margin:.3rem .5rem .3rem 0; }
  button.play { background:#2f6fed; color:#fff; border:0; border-radius:8px; padding:.45rem .8rem; font-weight:600; cursor:pointer; flex:none; }
  .status { padding:.75rem 1rem; border-radius:10px; background:#fff6da; color:#6b5500; margin:.75rem 0; }
  .ok { background:#e2f6e9; color:#1c5c34; }
  .err { background:#ffe3e3; color:#8a1f1f; }
  .vrow { display:flex; align-items:center; gap:.7rem; }
  .vrow .vtext { flex:1; }
</style>
<script defer src="/kade-tabbar.js"></script></head>
<body>
<a class="back" href="/c/new">&larr; Back to chat</a>
<h1>Your Spotter</h1>
<p class="muted">Your Spotter is your personal live companion — the one who takes over when you go live on a video call: instant back-and-forth, continuous sight, speaks up on their own. You get one, you design them, and they're the same person no matter which character you were talking to. Blind or low vision? They're your eyes — the world described as it moves, labels and screens read out loud, the thing you dropped found. Sighted? They're the second pair of eyes you always wanted: double-check the wiring before you flip the breaker, watch the driveway while your hands are full, read the tiny print without hunting for glasses.</p>
<div id="status" class="status" role="status">Loading&hellip;</div>

<form id="builder" hidden>
  <div class="card">
    <label for="sname" style="font-weight:700">1. Name your Spotter</label>
    <p class="muted" style="margin:.3rem 0 .6rem">Can't decide? Roll the dice.</p>
    <div class="vrow">
      <input type="text" id="sname" maxlength="40" autocomplete="off" required aria-describedby="namehelp">
      <button type="button" class="lite" id="randname">Random name</button>
    </div>
    <span id="namehelp" class="muted" hidden></span>
  </div>

  <div class="card">
    <p style="font-weight:700;margin:0 0 .3rem">2. Give them a personality &mdash; three ways, pick your favorite:</p>
    <p class="muted" style="margin:.2rem 0 .6rem">Write it yourself in the box, press <strong>Generate for me</strong> (uses whatever you typed as a hint, or invents from scratch), or answer the quick quiz below and press <strong>Build from my answers</strong>. You can always edit the result.</p>
    <textarea id="persona" maxlength="12000" aria-label="Your Spotter's personality, in your own words or generated"></textarea>
    <button type="button" class="lite" id="genbtn">Generate for me</button>
  </div>

  <details class="card">
    <summary style="font-weight:700;cursor:pointer">Prefer a quiz? Eight quick questions</summary>
    <fieldset><legend>Overall energy</legend>
      <label class="opt"><input type="radio" name="q_energy" value="calm and unhurried"> Calm and unhurried</label>
      <label class="opt"><input type="radio" name="q_energy" value="upbeat and lively"> Upbeat and lively</label>
      <label class="opt"><input type="radio" name="q_energy" value="cool and deadpan"> Cool and deadpan</label>
      <label class="opt"><input type="radio" name="q_energy" value="pure sunshine"> Pure sunshine</label>
    </fieldset>
    <fieldset><legend>How chatty?</legend>
      <label class="opt"><input type="radio" name="q_chat" value="speaks only when asked or when something matters"> Mostly quiet — speak when it matters</label>
      <label class="opt"><input type="radio" name="q_chat" value="offers a running comment when things change"> Comment as things change</label>
      <label class="opt"><input type="radio" name="q_chat" value="keeps easy company, chats freely"> Chatty — keep me company</label>
    </fieldset>
    <fieldset><legend>Blunt or gentle?</legend>
      <label class="opt"><input type="radio" name="q_blunt" value="tells it completely straight"> Tell it straight</label>
      <label class="opt"><input type="radio" name="q_blunt" value="honest but gentle about it"> Honest but gentle</label>
    </fieldset>
    <fieldset><legend>How do they talk?</legend>
      <label class="opt"><input type="radio" name="q_talk" value="plain and proper"> Plain and proper</label>
      <label class="opt"><input type="radio" name="q_talk" value="casual, everyday talk"> Casual, everyday</label>
      <label class="opt"><input type="radio" name="q_talk" value="loose and slangy"> Loose and slangy</label>
    </fieldset>
    <fieldset><legend>Humor</legend>
      <label class="opt"><input type="radio" name="q_humor" value="dry, quick wit"> Dry and quick</label>
      <label class="opt"><input type="radio" name="q_humor" value="silly and playful"> Silly and playful</label>
      <label class="opt"><input type="radio" name="q_humor" value="warm, easy humor"> Warm and easy</label>
      <label class="opt"><input type="radio" name="q_humor" value="keeps it serious"> Mostly serious</label>
    </fieldset>
    <fieldset><legend>Detail level</legend>
      <label class="opt"><input type="radio" name="q_detail" value="quick headlines first, detail on request"> Headlines first</label>
      <label class="opt"><input type="radio" name="q_detail" value="rich detail up front"> Rich detail up front</label>
    </fieldset>
    <fieldset><legend>What will they mostly do for you?</legend>
      <label class="opt"><input type="radio" name="q_job" value="describing the world for a blind or low-vision user"> Be my eyes — describe everything</label>
      <label class="opt"><input type="radio" name="q_job" value="reading labels, screens, and small print"> Read labels and small print</label>
      <label class="opt"><input type="radio" name="q_job" value="helping find things and check work"> Find things, check my work</label>
      <label class="opt"><input type="radio" name="q_job" value="keeping company and watching the world go by"> Company and people-watching</label>
    </fieldset>
    <fieldset><legend>When they're not sure what they see</legend>
      <label class="opt"><input type="radio" name="q_unsure" value="says plainly they are not sure and what would help"> Say so, plainly</label>
      <label class="opt"><input type="radio" name="q_unsure" value="gives their best guess and flags it as a guess"> Best guess, flagged</label>
    </fieldset>
    <button type="button" class="lite" id="quizbtn">Build from my answers</button>
  </details>

  <div class="card">
    <p style="font-weight:700;margin:0 0 .3rem">3. Pick their voice</p>
    <p class="muted" style="margin:.2rem 0 .6rem">Eight to choose from — press Play to hear each one introduce itself.</p>
    <div id="voices" role="radiogroup" aria-label="Spotter voice"></div>
  </div>

  <button type="submit" class="go" id="savebtn">Save my Spotter</button>
  <p class="muted">Change any of this anytime — come back here whenever. On a video call, the radio-tower button (or saying their name) hands the call to your Spotter; say "live off" to get your character back.</p>
</form>

<script>
(function () {
  var statusEl = document.getElementById('status');
  var form = document.getElementById('builder');
  var TOKEN = null;
  var VOICES = [];
  var NAMES = ['Scout','Hawk','Birdie','Iris','Echo','Moxie','Ziggy','Blue','Ace','Lark','Sonny','Vega','Juniper','Frankie','Pepper','Dash','Ivory','Cricket','Reya','Marlow','Onyx','Sable','Fable','Wren','Koda','Ember','Sage','Arrow','Dovie','Jett','Opal','Rook','Tally','Bexley','Cato','Della','Flint','Gwen','Harlow','Indy','Jules','Kit','Lumen','Nyx','Piper','Quill','Remy','True'];

  function setStatus(msg, cls) { statusEl.hidden = false; statusEl.className = 'status' + (cls ? ' ' + cls : ''); statusEl.textContent = msg; }

  function getToken() {
    return fetch('/api/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('auth ' + r.status)); })
      .then(function (j) { return j && j.token; });
  }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, opts.headers || {});
    return fetch('/api/kade/spotter' + path, opts).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
    });
  }

  var player = new Audio();
  function renderVoices(current) {
    var wrap = document.getElementById('voices');
    wrap.innerHTML = '';
    VOICES.forEach(function (v) {
      var row = document.createElement('label');
      row.className = 'opt vrow';
      var radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'voice'; radio.value = v.id; radio.required = true;
      if (current === v.id) radio.checked = true;
      var text = document.createElement('span');
      text.className = 'vtext';
      text.innerHTML = '<strong>' + v.id + '</strong> — ' + v.blurb;
      var play = document.createElement('button');
      play.type = 'button'; play.className = 'play'; play.textContent = 'Play';
      play.setAttribute('aria-label', 'Play a sample of ' + v.id);
      play.addEventListener('click', function (e) {
        e.preventDefault();
        player.pause();
        player.src = '/assets/spotter-voices/' + v.id + '.wav';
        player.play().catch(function () { setStatus('Could not play the sample — try again.', 'err'); });
      });
      row.appendChild(radio); row.appendChild(text); row.appendChild(play);
      wrap.appendChild(row);
    });
  }

  document.getElementById('randname').addEventListener('click', function () {
    document.getElementById('sname').value = NAMES[Math.floor(Math.random() * NAMES.length)];
  });

  function quizSeed() {
    var picks = [];
    ['q_energy','q_chat','q_blunt','q_talk','q_humor','q_detail','q_job','q_unsure'].forEach(function (n) {
      var el = document.querySelector('input[name="' + n + '"]:checked');
      if (el) picks.push(el.value);
    });
    return picks.join('; ');
  }

  function generate(seed, btn) {
    btn.disabled = true; var was = btn.textContent; btn.textContent = 'Thinking…';
    setStatus('Writing a personality…');
    api('/generate', { method: 'POST', body: JSON.stringify({ seed: seed }) })
      .then(function (j) {
        document.getElementById('persona').value = j.persona || '';
        setStatus('Draft ready — edit anything you like, then save.', 'ok');
      })
      .catch(function (e) { setStatus('Generator hiccup: ' + e.message, 'err'); })
      .then(function () { btn.disabled = false; btn.textContent = was; });
  }
  document.getElementById('genbtn').addEventListener('click', function () {
    generate(document.getElementById('persona').value.trim(), this);
  });
  document.getElementById('quizbtn').addEventListener('click', function () {
    var seed = quizSeed();
    if (!seed) { setStatus('Answer at least one quiz question first.', 'err'); return; }
    generate(seed, this);
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = document.getElementById('sname').value.trim();
    var voiceEl = document.querySelector('input[name="voice"]:checked');
    if (!name) { setStatus('Give your Spotter a name (or roll a random one).', 'err'); return; }
    if (!voiceEl) { setStatus('Pick a voice — press Play on a few first.', 'err'); return; }
    var btn = document.getElementById('savebtn'); btn.disabled = true;
    api('', { method: 'POST', body: JSON.stringify({ name: name, voice: voiceEl.value, persona: document.getElementById('persona').value.trim() }) })
      .then(function () { setStatus(name + ' is saved. Next video call, the radio-tower button (or asking for ' + name + ' by name) brings them on the line.', 'ok'); window.scrollTo(0, 0); })
      .catch(function (e2) { setStatus('Save failed: ' + e2.message, 'err'); })
      .then(function () { btn.disabled = false; });
  });

  getToken().then(function (t) {
    TOKEN = t;
    return api('', {});
  }).then(function (j) {
    VOICES = j.voices || [];
    renderVoices(j.spotter && j.spotter.voice);
    if (j.spotter) {
      document.getElementById('sname').value = j.spotter.name || '';
      document.getElementById('persona').value = j.spotter.persona || '';
      setStatus('This is ' + (j.spotter.name || 'your Spotter') + ' as saved today — change anything and save again.', 'ok');
    } else {
      setStatus("Right now you have Scout — the starter Spotter everyone gets: friendly, quick, honest about what they see. Keep Scout, or make this one yours: new name, new voice, your kind of personality.", '');
    }
    form.hidden = false;
  }).catch(function (e) {
    setStatus('Could not load — make sure you are signed in, then reload. (' + e.message + ')', 'err');
  });
})();
</script>
</body>
</html>`;

router.page = (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(SPOTTER_HTML);
};

module.exports = router;
