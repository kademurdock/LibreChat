const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { ResourceType, PermissionBits } = require('librechat-data-provider');
const { requireJwtAuth } = require('~/server/middleware');
const { findPubliclyAccessibleResources } = require('~/server/services/PermissionService');
const db = require('~/models');

/*
 * THE MATCHMAKER (July 4 2026 overnight build — queued and Kade-approved
 * July 3: "character matchmaker: a few questions → character recommendations").
 *
 * A short, screen-reader-first quiz at /matchmaker that matches you with
 * marketplace characters. GET /api/kade/matchmaker returns the live roster
 * (published agents only) with match TAGS computed server-side from each
 * agent's name/description/category — so brand-new personas (tonight's
 * companions included) join the pool automatically with zero upkeep. A small
 * curated boost map keeps the flagship characters honest. Scoring happens
 * client-side; nothing is stored, nothing costs anything.
 */

const router = express.Router();

/* tag vocabulary: purposes (chat help laughs games stories deep), vibes
 * (calm bold witty warm mysterious), ages (elder adult peer young timeless),
 * topics (music food outdoors sports faith tech books gossip travel animals
 * art family), styles (straight gentle funny weird) */
const KEYWORD_TAGS = [
  [/(grandma|granny|nana|grandpa|granddad|retired|elder|old-timer|silver)/i, ['elder', 'warm']],
  [/(mom|dad|mother|father|auntie|aunt|uncle)/i, ['adult', 'warm', 'family']],
  [/(kid|teen|young|youth|junior|girl next|boy next)/i, ['young', 'peer']],
  [/(comedian|joke|funny|sass|roast|prank|witty|humor|comic|clown)/i, ['laughs', 'funny', 'witty']],
  [/(game|gamer|dealer|casino|quiz|trivia|player|arcade|d&d|dungeon master)/i, ['games']],
  [/(story|storytell|adventure|tale|fable|quest|narrat|fiction)/i, ['stories']],
  [/(cook|chef|recipe|baker|baking|kitchen|food|diner|bbq|barbecue)/i, ['food']],
  [/(fish|hunt|outdoor|garden|farm|nature|trail|camp|river|lake|woods)/i, ['outdoors']],
  [/(music|dj|sing|song|band|hip-hop|hip hop|rapper|country|blues|jazz|guitar|piano)/i, ['music']],
  [/(faith|church|preach|bible|gospel|pray)/i, ['faith']],
  [/(tech|computer|coder|robot|space|science|engineer|nerd|hacker)/i, ['tech']],
  [/(book|read|library|poem|poet|writer|literature)/i, ['books']],
  [/(calm|gentle|cozy|soft|soothing|patient|quiet|peaceful|kind)/i, ['calm', 'gentle']],
  [/(wild|loud|chaos|energy|hype|party|firecracker|bold|fierce)/i, ['bold']],
  [/(dry|sarcastic|deadpan|sharp tongue|snark)/i, ['witty', 'straight']],
  [/(mystery|noir|dark|vampire|goth|spooky|ghost|witch)/i, ['mysterious', 'weird']],
  [/(travel|world|globe|road trip|wander|voyage)/i, ['travel']],
  [/(animal|dog|cat|pet|critter|horse|bird)/i, ['animals']],
  [/(sport|coach|football|basketball|baseball|fitness|gym|wrestl)/i, ['sports']],
  [/(deep|philosoph|wisdom|advice|listener|listen|therap|heart-to-heart|counsel|comfort)/i, ['deep', 'gentle']],
  [/(gossip|tea|drama|celebrity|nosy)/i, ['gossip']],
  [/(art|paint|draw|design|photo|craft|quilt)/i, ['art']],
  [/(helper|assistant|organize|fix|build|handy|practical|errand)/i, ['help', 'straight']],
  [/(friend|companion|neighbor|buddy|pal|company|check in|checkin|lonely)/i, ['chat', 'warm']],
  [/(weird|odd|alien|strange|surreal|chaotic)/i, ['weird']],
  [/(flirt|romance|charming|smooth)/i, ['bold', 'warm']],
];

/* Curated boosts so the flagships land where they should. */
const NAME_BOOSTS = {
  kiana: ['chat', 'deep', 'warm', 'music', 'straight', 'funny', 'peer'],
  zadiana: ['chat', 'bold', 'funny', 'peer', 'music'],
  deuce: ['games', 'witty', 'adult', 'straight'],
  torch: ['stories', 'games', 'timeless'],
  forge: ['help', 'tech', 'straight', 'adult'],
  rio: ['art', 'bold', 'peer'],
  lux: ['art', 'calm', 'peer'],
  indie: ['art', 'weird', 'peer'],
  lilly: ['young', 'chat', 'gentle', 'warm'],
};

function tagsFor(agent) {
  const hay = `${agent.name || ''} ${agent.description || ''} ${agent.category || ''}`;
  const tags = new Set();
  for (const [re, ts] of KEYWORD_TAGS) {
    if (re.test(hay)) ts.forEach((t) => tags.add(t));
  }
  const boost = NAME_BOOSTS[String(agent.name || '').trim().toLowerCase().split(/\s+/)[0]];
  if (boost) boost.forEach((t) => tags.add(t));
  if (String(agent.category || '').toLowerCase() === 'companions') {
    ['chat', 'warm'].forEach((t) => tags.add(t));
  }
  if (tags.size === 0) tags.add('chat');
  return [...tags];
}

router.get('/', requireJwtAuth, async (req, res) => {
  try {
    /* "Published to the marketplace" here means ACL-public (the agent_viewer
     * public principal) — the SAME check the marketplace list uses. The old
     * projectIds check matched nothing on this instance (publishing goes
     * through PUT /api/permissions/agent/:id, not project shares) — caught
     * in tonight's live smoke: the roster came back empty. */
    const publicIds = await findPubliclyAccessibleResources({
      resourceType: ResourceType.AGENT,
      requiredPermissions: PermissionBits.VIEW,
    });
    const publicSet = new Set(publicIds.map((oid) => String(oid)));
    const all = (await db.getAgents({})) || [];
    const agents = all
      .filter((a) => a._id && publicSet.has(String(a._id)))
      .map((a) => ({
        id: a.id,
        name: a.name || 'Unnamed',
        description: String(a.description || '').slice(0, 220),
        category: a.category || '',
        avatar: (a.avatar && a.avatar.filepath) || '',
        tags: tagsFor(a),
      }));
    return res.json({ agents });
  } catch (error) {
    logger.error('[/api/kade/matchmaker] error:', error);
    return res.status(500).json({ error: 'Could not load the roster.' });
  }
});

/* ------------------------------- the page ------------------------------- */

const MATCH_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>The Matchmaker — find your people</title>
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
    label.opt:hover { background:#262a31 !important; }
  }
  h1 { font-size: 1.7rem; margin: 0 0 .2rem; }
  h2 { font-size: 1.2rem; }
  .muted { opacity: .75; }
  a.back { display:inline-block; margin:0 0 .5rem; font-weight:600; text-decoration:none; color:#1d55d0; }
  a.back:focus-visible, button:focus-visible, label.opt:focus-within { outline: 3px solid #ffbf47; outline-offset: 2px; }
  .card, fieldset { background:#fff; border:1px solid #e3e6ea; border-radius:14px; padding:1.1rem 1.2rem; margin:1rem 0; }
  fieldset legend { font-weight:700; font-size:1.05rem; padding:0 .4rem; }
  label.opt { display:flex; gap:.6rem; align-items:flex-start; padding:.65rem .7rem; border:1px solid #dfe3e8; border-radius:10px; margin:.45rem 0; cursor:pointer; font-size:1rem; }
  label.opt input { margin-top:.2rem; width:1.15rem; height:1.15rem; flex:none; }
  button.go { display:block; width:100%; background:#1f7a49; color:#fff; border:0; border-radius:12px; font-size:1.15rem; font-weight:700; padding:1rem; cursor:pointer; margin:1.2rem 0; }
  button.lite { background:transparent; color:#1d55d0; border:1px solid #1d55d0; border-radius:10px; padding:.6rem 1rem; font-weight:600; cursor:pointer; margin-right:.5rem; }
  .match { display:flex; gap:.9rem; align-items:flex-start; }
  .match img { width:56px; height:56px; border-radius:50%; object-fit:cover; flex:none; background:#dde2e8; }
  .match .ph { width:56px; height:56px; border-radius:50%; flex:none; background:#c9d2dd; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:1.3rem; color:#4a5563; }
  .why { margin:.3rem 0 .5rem; }
  a.talk { display:inline-block; background:#1d55d0; color:#fff; text-decoration:none; font-weight:700; padding:.7rem 1.1rem; border-radius:10px; }
  .status { padding:.75rem 1rem; border-radius:10px; background:#fff6da; color:#6b5500; }
  .err { background:#ffe3e3; color:#8a1f1f; }
  /* KADE session 22: press-down feedback on anything tappable. Motion only
     under prefers-reduced-motion: no-preference; static pages otherwise. */
  @media (prefers-reduced-motion: no-preference) {
    button, a.btn, [role="button"], input[type="submit"] {
      transition: transform .15s ease;
    }
    button:active, a.btn:active, [role="button"]:active, input[type="submit"]:active {
      transform: scale(.985);
    }
  }
</style>
<script defer src="/kade-tabbar.js"></script></head>
<body>
<a class="back" href="/c/new">&larr; Back to chat</a>
<h1>The Matchmaker</h1>
<p class="muted">Five quick questions, three friends on the other side. Nothing is saved, nothing costs anything, and you can retake it as many times as you like.</p>
<div id="status" class="status" role="status">Loading the roster…</div>

<form id="quiz" hidden>
  <fieldset>
    <legend>1. What are you in the mood for?</legend>
    <label class="opt"><input type="radio" name="purpose" value="chat" required> Good company — somebody to just talk with</label>
    <label class="opt"><input type="radio" name="purpose" value="laughs"> Laughs — make me cackle</label>
    <label class="opt"><input type="radio" name="purpose" value="games"> Games — deal me in</label>
    <label class="opt"><input type="radio" name="purpose" value="stories"> Stories and adventures</label>
    <label class="opt"><input type="radio" name="purpose" value="deep"> A real heart-to-heart</label>
    <label class="opt"><input type="radio" name="purpose" value="help"> Help getting something done</label>
  </fieldset>
  <fieldset>
    <legend>2. What energy fits you best right now?</legend>
    <label class="opt"><input type="radio" name="vibe" value="calm" required> Calm and gentle</label>
    <label class="opt"><input type="radio" name="vibe" value="warm"> Warm and nurturing</label>
    <label class="opt"><input type="radio" name="vibe" value="bold"> Big and loud</label>
    <label class="opt"><input type="radio" name="vibe" value="witty"> Dry and quick</label>
    <label class="opt"><input type="radio" name="vibe" value="mysterious"> A little mysterious</label>
  </fieldset>
  <fieldset>
    <legend>3. Whose company do you usually enjoy?</legend>
    <label class="opt"><input type="radio" name="age" value="elder" required> Grandparent energy — stories and no hurry</label>
    <label class="opt"><input type="radio" name="age" value="adult"> Steady grown-folks energy</label>
    <label class="opt"><input type="radio" name="age" value="peer"> Somebody on my level</label>
    <label class="opt"><input type="radio" name="age" value="young"> Youthful chaos</label>
    <label class="opt"><input type="radio" name="age" value="timeless"> Odd and timeless — surprise me</label>
  </fieldset>
  <fieldset>
    <legend>4. Pick anything you love talking about (as many as you like)</legend>
    <label class="opt"><input type="checkbox" name="topic" value="music"> Music</label>
    <label class="opt"><input type="checkbox" name="topic" value="food"> Food and cooking</label>
    <label class="opt"><input type="checkbox" name="topic" value="outdoors"> The outdoors — fishing, gardens, critter reports</label>
    <label class="opt"><input type="checkbox" name="topic" value="sports"> Sports</label>
    <label class="opt"><input type="checkbox" name="topic" value="faith"> Faith</label>
    <label class="opt"><input type="checkbox" name="topic" value="tech"> Tech and games</label>
    <label class="opt"><input type="checkbox" name="topic" value="books"> Books and stories</label>
    <label class="opt"><input type="checkbox" name="topic" value="gossip"> People and gossip</label>
    <label class="opt"><input type="checkbox" name="topic" value="travel"> Travel and far-off places</label>
    <label class="opt"><input type="checkbox" name="topic" value="animals"> Animals</label>
    <label class="opt"><input type="checkbox" name="topic" value="art"> Art and making things</label>
    <label class="opt"><input type="checkbox" name="topic" value="family"> Family life</label>
  </fieldset>
  <fieldset>
    <legend>5. How do you like people to talk to you?</legend>
    <label class="opt"><input type="radio" name="style" value="straight" required> Tell it to me straight</label>
    <label class="opt"><input type="radio" name="style" value="gentle"> Gentle with me</label>
    <label class="opt"><input type="radio" name="style" value="funny"> Keep it funny</label>
    <label class="opt"><input type="radio" name="style" value="weird"> The weirder the better</label>
  </fieldset>
  <button type="submit" class="go">Find my people</button>
</form>

<section id="results" aria-live="polite"></section>

<script>
(function () {
  var statusEl = document.getElementById('status');
  var quiz = document.getElementById('quiz');
  var results = document.getElementById('results');
  var roster = [];

  function esc(s) { return String(s || '').replace(/[&<>"]/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }

  function getToken() {
    return fetch('/api/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('auth ' + r.status)); })
      .then(function (j) { return j && j.token; });
  }

  getToken().then(function (token) {
    return fetch('/api/kade/matchmaker', { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  }).then(function (r) {
    if (!r.ok) throw new Error('roster ' + r.status);
    return r.json();
  }).then(function (j) {
    roster = (j && j.agents) || [];
    if (!roster.length) throw new Error('empty roster');
    statusEl.hidden = true;
    quiz.hidden = false;
  }).catch(function (e) {
    statusEl.className = 'status err';
    statusEl.textContent = 'Could not load the character roster (' + e.message + '). Make sure you are signed in, then reload this page.';
  });

  var WHY = {
    chat: 'good company', laughs: 'brings the jokes', games: 'always up for a game', stories: 'a born storyteller',
    deep: 'listens for real', help: 'gets things done', calm: 'calm and gentle', warm: 'warm as a porch light',
    bold: 'big energy', witty: 'quick and dry', mysterious: 'a little mysterious', elder: 'seasoned and unhurried',
    adult: 'steady grown-folks energy', peer: 'right on your level', young: 'youthful chaos', timeless: 'one of a kind',
    music: 'talks music', food: 'talks food and cooking', outdoors: 'lives for the outdoors', sports: 'talks sports',
    faith: 'talks faith', tech: 'into tech and games', books: 'loves books and stories', gossip: 'brings the tea',
    travel: 'full of far-off places', animals: 'an animal person', art: 'makes things', family: 'all about family',
    straight: 'tells it straight', gentle: 'gentle with you', funny: 'keeps it funny', weird: 'wonderfully weird'
  };

  function score(agent, picks) {
    var s = 0, hits = [];
    function hit(tag, w) { if (agent.tags.indexOf(tag) >= 0) { s += w; if (hits.indexOf(tag) < 0) hits.push(tag); } }
    hit(picks.purpose, 3);
    hit(picks.vibe, 2);
    hit(picks.age, 2);
    picks.topics.forEach(function (t) { hit(t, 1); });
    hit(picks.style, 1);
    return { s: s, hits: hits };
  }

  function render(list, picks) {
    var html = '<h2>Your matches</h2>';
    list.forEach(function (m, i) {
      var a = m.agent;
      var why = m.hits.slice(0, 3).map(function (t) { return WHY[t] || t; }).join(' · ');
      html += '<div class="card match">' +
        (a.avatar ? '<img alt="" src="' + esc(a.avatar) + '">' : '<span class="ph" aria-hidden="true">' + esc((a.name || '?')[0]) + '</span>') +
        '<div><h3 style="margin:.1rem 0">' + (i + 1) + '. ' + esc(a.name) + '</h3>' +
        (why ? '<p class="why">' + esc(why) + '</p>' : '') +
        (a.description ? '<p class="muted" style="margin:.2rem 0 .6rem">' + esc(a.description) + '</p>' : '') +
        '<a class="talk" href="/c/new?agent_id=' + encodeURIComponent(a.id) + '">Start talking to ' + esc(a.name.split(' ')[0]) + '</a>' +
        '</div></div>';
    });
    html += '<p><button type="button" class="lite" id="retake">Retake the quiz</button> ' +
      '<button type="button" class="lite" id="lucky">Surprise me with somebody random</button></p>';
    results.innerHTML = html;
    document.getElementById('retake').addEventListener('click', function () {
      results.innerHTML = '';
      quiz.hidden = false;
      quiz.querySelector('input').focus();
      window.scrollTo(0, 0);
    });
    document.getElementById('lucky').addEventListener('click', lucky);
    results.querySelector('h2').setAttribute('tabindex', '-1');
    results.querySelector('h2').focus();
  }

  function lucky() {
    var a = roster[Math.floor(Math.random() * roster.length)];
    results.innerHTML = '<h2 tabindex="-1">Fate says…</h2>' +
      '<div class="card match">' +
      (a.avatar ? '<img alt="" src="' + esc(a.avatar) + '">' : '<span class="ph" aria-hidden="true">' + esc((a.name || '?')[0]) + '</span>') +
      '<div><h3 style="margin:.1rem 0">' + esc(a.name) + '</h3>' +
      (a.description ? '<p class="muted">' + esc(a.description) + '</p>' : '') +
      '<a class="talk" href="/c/new?agent_id=' + encodeURIComponent(a.id) + '">Start talking to ' + esc(a.name.split(' ')[0]) + '</a>' +
      '</div></div>' +
      '<p><button type="button" class="lite" id="lucky">Spin again</button> <button type="button" class="lite" id="retake">Take the quiz instead</button></p>';
    document.getElementById('lucky').addEventListener('click', lucky);
    document.getElementById('retake').addEventListener('click', function () {
      results.innerHTML = ''; quiz.hidden = false; window.scrollTo(0, 0);
    });
    results.querySelector('h2').focus();
  }

  quiz.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var fd = new FormData(quiz);
    var picks = {
      purpose: fd.get('purpose'),
      vibe: fd.get('vibe'),
      age: fd.get('age'),
      topics: fd.getAll('topic'),
      style: fd.get('style'),
    };
    var scored = roster.map(function (a) {
      var r = score(a, picks);
      return { agent: a, s: r.s + Math.random() * 0.5, hits: r.hits };
    }).sort(function (x, y) { return y.s - x.s; });
    quiz.hidden = true;
    render(scored.slice(0, 3), picks);
  });
})();
</script>
</body>
</html>`;

router.page = (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(MATCH_HTML);
};

module.exports = router;
