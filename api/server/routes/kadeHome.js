/* ─────────────────────────────────────────────────────────────────────────────
 * KADE HOME — the web learns the iPhone app's map (Part 116.3, Sep 2 2026)
 *
 * Her words, tonight: "I hate mainly the sidebar where there's some stuff on a
 * page, then different stuff on the page depending on where the sidebar is
 * flipped… it's hard to find things. …when there are features on web I forgot
 * to port to native, the fallback is the web, and it's annoying that the web
 * is so annoying."
 *
 * Her call on scope: a HOME LAYER on top of LibreChat, not a rewrite, and it
 * MIRRORS THE NATIVE APP EXACTLY — same section names, same order, same
 * spoken labels and hints — so a feature learned on the phone is in the same
 * place on the web. Source of truth for the order and the words is
 * kade-ai-native ContentView.swift `signedInSection` (Your account → Talk →
 * Tools, six rows of two → Settings and help → Admin → Sign out). When native
 * changes its home, this file changes to match; never the other way round.
 *
 * Built the July-18 way (NAV_UNIFY): server-rendered pages off SHARED_HEAD,
 * zero React risk, one stable URL per destination. Where the web has no
 * stable URL for a native destination (Agent Builder lives in a side panel,
 * Settings is a modal, Bookmarks is a sidebar section) the tile SAYS SO in
 * its hint instead of pretending — the gap is visible, which is how it gets
 * closed. Two destinations native has and the web did not: a flat
 * /conversations list and a /announcements page. Both are here.
 * ───────────────────────────────────────────────────────────────────────── */

const { SHARED_HEAD } = require('./kadePages');

/* One tile. `spoken` is the accessible name (pinned to native's spoken
 * label); `title` is the visible short text; `hint` is native's
 * accessibilityHint, rendered as visible small text AND aria-describedby so
 * sighted and screen-reader users get the same sentence. */
function tile({ href, title, spoken, hint, icon, id }) {
  const hid = `h-${id}`;
  return `  <a class="hubitem" href="${href}" aria-label="${esc(spoken || title)}" aria-describedby="${hid}"><span class="hicon" aria-hidden="true">${icon}</span><span><strong>${esc(title)}</strong><small id="${hid}">${esc(hint)}</small></span></a>`;
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function section(title, tiles, extraAttrs = '') {
  return `<h2 id="sec-${title.toLowerCase().replace(/[^a-z]+/g, '-')}"${extraAttrs}>${esc(title)}</h2>\n<nav class="hublist" aria-labelledby="sec-${title.toLowerCase().replace(/[^a-z]+/g, '-')}">\n${tiles.join('\n')}\n</nav>`;
}

/* ── THE MAP, verbatim from native ─────────────────────────────────────── */
const TALK = [
  { id: 'spotter', href: '/spotter', title: 'Call your Spotter', spoken: 'Call your Spotter', icon: '👁️',
    hint: 'Starts a live call with your visual companion straight away, without picking anyone first.' },
  { id: 'chat', href: '/c/new', title: 'Talk to your companion', spoken: 'Talk to your companion', icon: '💬',
    hint: 'A fresh chat with your main companion. Same as the Chats tab.' },
  { id: 'convos', href: '/conversations', title: 'Your conversations', spoken: 'Your conversations', icon: '🗂️',
    hint: 'Opens your conversation list.' },
  { id: 'alerts', href: '/notifications', title: 'Alerts', spoken: 'Alerts', icon: '🔔',
    hint: 'Your recent reminders and check-ins, and how they reach you.' },
  { id: 'announce', href: '/announcements', title: 'Announcements', spoken: 'Announcements', icon: '📣',
    hint: "What's New announcements from Kade-AI, full text, newest first." },
];

// Six rows of two on native; one flat list here reads in the identical order.
const TOOLS = [
  { id: 'transcribe', href: '/transcribe', title: 'Transcribe', spoken: 'Transcribe a voice memo', icon: '🎙️',
    hint: 'Records what you say and turns it into text you can edit, tidy up and share.' },
  { id: 'describe', href: '/describe', title: 'Describe', spoken: 'Describe a photo, video, or document', icon: '🖼️',
    hint: 'Take or choose a photo or video, or pick a document, and get it described or read back to you.' },
  { id: 'matchmaker', href: '/matchmaker', title: 'Matchmaker', spoken: 'Matchmaker', icon: '💘',
    hint: 'Five quick questions, then three companions who might be a good fit.' },
  { id: 'parlor', href: '/parlor', title: 'The Parlor', spoken: 'The Parlor', icon: '🎲',
    hint: 'Every game on a menu — play your own cards with buttons, seat characters if you want company, and a house narrator calls the table.' },
  { id: 'clubhouse', href: '/clubhouse', title: "Kade's Clubhouse", spoken: "Kade's Clubhouse", icon: '🔊',
    hint: 'Live family voice rooms with a shared jukebox anyone can drive, private Hotel rooms with passcodes, and companion guests you can invite in.' },
  { id: 'debate', href: '/debate-room', title: 'Debate Room', spoken: 'Debate Room', icon: '🗣️',
    hint: 'Set a topic, cast 2 to 6 companions, and let them go back and forth. Also reaches the Conversation Hall.' },
  { id: 'builder', href: '/agent-builder', title: 'Agent Builder', spoken: 'Agent Builder', icon: '🛠️',
    hint: 'Create or edit your own companions.' },
  { id: 'marketplace', href: '/agents', title: 'Marketplace', spoken: 'The Marketplace', icon: '🏪',
    hint: "Browse every published character by category, hear who's who, start talking to anyone — and publish your own creations." },
  { id: 'bookmarks', href: '/bookmarks', title: 'Bookmarks', spoken: 'Bookmarks', icon: '🔖',
    hint: 'Your tagged conversations, gathered by bookmark — tag any conversation from the conversation list.' },
  { id: 'prompts', href: '/prompts/new', title: 'Prompts', spoken: 'The Prompt Library', icon: '⭐',
    hint: 'Saved prompts you can drop into a fresh chat pre-typed, plus a form to save new ones.' },
  { id: 'creations', href: '/my-creations', title: 'My Creations', spoken: 'My Creations', icon: '🎨',
    hint: "Every picture, video, and song you've made — play them, save them, or put them on the family Wall of Fame." },
  { id: 'wall', href: '/wall-of-fame', title: 'Wall of Fame', spoken: 'Wall of Fame', icon: '🏆',
    hint: 'Creations the whole family chose to share, newest first.' },
];

const SETTINGS = [
  { id: 'settings', href: '/settings', title: 'Settings', spoken: 'Settings', icon: '⚙️',
    hint: 'Speech, accessibility, and pronunciation dictionary settings.' },
  { id: 'help', href: '/help', title: 'Help', spoken: 'Help', icon: '❓',
    hint: 'How everything in the app works, section by section.' },
  { id: 'app', href: 'https://testflight.apple.com', title: 'Get the iPhone app', spoken: 'Get the iPhone app', icon: '📱',
    hint: 'The native Kade-AI app is the main way to use all of this. Ask Kade for a TestFlight invite if you do not have one.' },
];

/* Her call (Sep 2 2026): mirror native EXACTLY, and where the web has
 * something native lacks, put it on a "Web only" shelf at the bottom so the
 * gap is visible instead of hidden. Everything here is a candidate for a
 * native port; when one ships, its tile moves up into the native order. */
const WEB_ONLY = [
  { id: 'you', href: '/you', title: 'You', spoken: 'You: notifications, logbook, morning brief, your data', icon: '👤',
    hint: 'Notifications and reminders, your logbook, the morning brief, the pronunciation dictionary, and a download of everything that is yours.' },
  { id: 'memories', href: '/memories', title: 'Memories', spoken: 'Memories', icon: '🧠',
    hint: 'The cards your companions keep about you. Read, edit, or delete any of them.' },
  { id: 'files', href: '/files', title: 'Files', spoken: 'Files', icon: '📎',
    hint: 'Everything you have uploaded, and what each companion can read.' },
  { id: 'hall', href: '/conversation-hall', title: 'Conversation Hall', spoken: 'Conversation Hall', icon: '🏛️',
    hint: 'The greatest hits people have shared from the Debate Room.' },
  { id: 'gameroom', href: '/game-room', title: 'Game Room', spoken: 'Game Room', icon: '🎮',
    hint: 'The older game room, kept for the trivia nights that started here.' },
  { id: 'calls', href: '/calls', title: 'Calls', spoken: 'Calls', icon: '📞',
    hint: 'Your phone-call history with your companions, and the numbers registered to call in.' },
  { id: 'spottersetup', href: '/spotter', title: 'Set up your Spotter', spoken: 'Set up your Spotter', icon: '👁️',
    hint: 'Name your live visual companion, pick their voice, and give them a personality.' },
  { id: 'skills', href: '/skills', title: 'Skills', spoken: 'Skills', icon: '📜',
    hint: 'Reusable instructions your companions can be handed. Power-user feature.' },
  { id: 'projects', href: '/projects', title: 'Projects', spoken: 'Projects', icon: '🗃️',
    hint: 'Group conversations and files around one piece of work. Power-user feature.' },
  { id: 'feed', href: '/feed-the-server', title: 'Feed the Server', spoken: 'Feed the Server', icon: '💳',
    hint: 'See your usage and balance, and chip in to keep this running.' },
];

const ADMIN = [
  { id: 'usage', href: '/usage-dashboard', title: 'Admin dashboard', spoken: 'Admin dashboard', icon: '📊',
    hint: 'Usage and spending, feedback reports, and activity logs. Only admin accounts see this.' },
  { id: 'feedback', href: '/feedback-dashboard', title: 'Feedback reports', spoken: 'Feedback reports', icon: '📝',
    hint: 'Bug reports and suggestions from the family, with their status.' },
  { id: 'logs', href: '/logs', title: 'Activity logs', spoken: 'Activity logs', icon: '🧾',
    hint: 'Who talked to whom, read-only, for support.' },
  { id: 'access', href: '/access-requests', title: 'Access requests', spoken: 'Access requests', icon: '🚪',
    hint: 'People asking to join. Approve or deny.' },
];

const homeHtml = `<!doctype html><html lang="en"><head><title>Home — Kade-AI</title>${SHARED_HEAD}
<style>
  .acct { margin: .25rem 0 0; }
  #adminSec, #adminNav { display: none; }
  button.signout { font: inherit; font-weight: 600; color: #8a1f1f; background: #fff; border: 1px solid #c0392b; border-radius: 10px; padding: .8rem 1.3rem; margin-top: 1.25rem; cursor: pointer; }
  button.signout:focus-visible { outline: 3px solid #ffbf47; outline-offset: 2px; }
  @media (prefers-color-scheme: dark) { button.signout { background: #1e2127; color: #ff8f80; border-color: #7a2c22; } }
</style>
</head>
<body>
<main>
<h1>Home</h1>
<p class="muted">Same map as the iPhone app: everything is here, in the same order, every time.</p>

<h2 id="sec-account">Your account</h2>
<p class="acct" id="acctEmail" aria-live="polite">Checking who you are…</p>

${section('Talk', TALK.map(tile))}

${section('Tools', TOOLS.map(tile))}

${section('Settings and help', SETTINGS.map(tile))}

${section('Web only', WEB_ONLY.map(tile))}
<p class="muted" style="margin-top:-.25rem;font-size:.9rem">These are on the website and not in the iPhone app yet. When one comes to the app, it moves up into the list above.</p>

<h2 id="adminSec">Admin</h2>
<nav class="hublist" id="adminNav" aria-labelledby="adminSec">
${ADMIN.map(tile).join('\n')}
</nav>

<button class="signout" id="signout" aria-describedby="signoutHint">Sign out</button>
<p class="muted" id="signoutHint" style="font-size:.85rem">Signs you out and clears your saved session on this device.</p>
</main>
<footer class="muted">— Kade-AI</footer>
<script>
(async function(){
  var t = await getToken();
  if(!t){ document.getElementById('acctEmail').textContent = 'Not signed in. '; var a=document.createElement('a'); a.href='/login'; a.textContent='Sign in'; document.getElementById('acctEmail').appendChild(a); return; }
  try{
    var r = await apiGet('/api/user', t); if(r.ok){ var u = await r.json();
      document.getElementById('acctEmail').textContent = u.email || u.username || 'Signed in';
      if(u.role === 'ADMIN'){ document.getElementById('adminSec').style.display=''; document.getElementById('adminNav').style.display=''; }
    }
  }catch(e){}
  document.getElementById('signout').addEventListener('click', async function(){
    this.disabled = true; this.textContent = 'Signing out…';
    try{ await fetch('/api/auth/logout', {method:'POST', credentials:'include', headers:{'Authorization':'Bearer '+t}}); }catch(e){}
    location.href = '/login';
  });
})();
</script>
</body></html>`;

/* ── /conversations — the flat list native has and the web did not ──────── */
const conversationsHtml = `<!doctype html><html lang="en"><head><title>Your conversations — Kade-AI</title>${SHARED_HEAD}
<style>
  ul.convos { list-style: none; padding: 0; margin: 1rem 0; display: grid; gap: .5rem; }
  ul.convos a { display: block; background: #fff; border: 1px solid #e3e6ea; border-radius: 12px; padding: .9rem 1.1rem; text-decoration: none; color: inherit; }
  ul.convos a:focus-visible { outline: 3px solid #ffbf47; outline-offset: 2px; }
  ul.convos strong { display: block; font-size: 1.05rem; }
  ul.convos small { display: block; opacity: .7; margin-top: .15rem; }
  @media (prefers-color-scheme: dark) { ul.convos a { background: #1e2127; border-color: #2c2f37; } }
  button.more { font: inherit; font-weight: 600; padding: .8rem 1.3rem; border-radius: 10px; border: 1px solid #b9bfc9; background: #fff; cursor: pointer; }
  @media (prefers-color-scheme: dark) { button.more { background: #242830; color: #e7e9ee; border-color: #3a3f49; } }
  button.more:focus-visible { outline: 3px solid #ffbf47; outline-offset: 2px; }
</style>
</head>
<body>
<main>
<a class="back" href="/home">&larr; Home</a>
<h1>Your conversations</h1>
<p class="muted">Newest first. Open one to keep talking. <a href="/c/new">Start a new one</a>.</p>
<div id="status" class="muted" aria-live="polite">Loading…</div>
<ul class="convos" id="list" aria-label="Conversations"></ul>
<button class="more" id="more" style="display:none">Load more</button>
</main>
<footer class="muted">— Kade-AI</footer>
<script>
(async function(){
  var t = await getToken();
  var status = document.getElementById('status'), list = document.getElementById('list'), more = document.getElementById('more');
  if(!t){ status.textContent = 'Not signed in.'; return; }
  var cursor = null, total = 0;
  function when(s){ try{ var d = new Date(s); var now = new Date(); var diff = (now - d)/36e5; if(diff < 24) return d.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}) + ' today'; if(diff < 48) return 'yesterday'; return d.toLocaleDateString([], {month:'short', day:'numeric'}); }catch(e){ return ''; } }
  async function page(){
    more.disabled = true;
    var url = '/api/convos?limit=30' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    var r = await apiGet(url, t);
    if(!r.ok){ status.textContent = 'Could not load your conversations (server said ' + r.status + ').'; return; }
    var j = await r.json();
    var rows = j.conversations || [];
    for (var i=0;i<rows.length;i++){ var c = rows[i]; var li = document.createElement('li'); var a = document.createElement('a'); a.href = '/c/' + encodeURIComponent(c.conversationId);
      var s = document.createElement('strong'); s.textContent = c.title || 'Untitled'; var sm = document.createElement('small'); sm.textContent = when(c.updatedAt || c.createdAt); a.appendChild(s); a.appendChild(sm); li.appendChild(a); list.appendChild(li); }
    total += rows.length; cursor = j.nextCursor || null;
    status.textContent = total ? (total + ' conversation' + (total===1?'':'s') + (cursor ? ' so far' : '')) : 'No conversations yet.';
    more.style.display = cursor ? '' : 'none'; more.disabled = false;
  }
  more.addEventListener('click', page);
  await page();
})();
</script>
</body></html>`;

/* ── /announcements — native's Announcements screen, on the web ─────────── */
const announcementsHtml = `<!doctype html><html lang="en"><head><title>Announcements — Kade-AI</title>${SHARED_HEAD}</head>
<body>
<main>
<a class="back" href="/home">&larr; Home</a>
<h1>Announcements</h1>
<p class="muted">What's New notes sent to the family, full text, newest first.</p>
<div id="status" class="muted" aria-live="polite">Loading…</div>
<div id="list"></div>
</main>
<footer class="muted">— Kade-AI</footer>
<script>
(async function(){
  var t = await getToken(); var status = document.getElementById('status'), list = document.getElementById('list');
  if(!t){ status.textContent = 'Not signed in.'; return; }
  try{
    var r = await apiGet('/api/kade/announcements?limit=50', t);
    if(!r.ok){ status.textContent = 'Could not load announcements (server said ' + r.status + ').'; return; }
    var j = await r.json(); var rows = j.broadcasts || j.rows || j.items || (Array.isArray(j) ? j : []);
    if(!rows.length){ status.textContent = 'Nothing yet.'; return; }
    status.textContent = rows.length + ' announcement' + (rows.length===1?'':'s') + '.';
    rows.forEach(function(b){ var card = document.createElement('article'); card.className = 'card'; var h = document.createElement('h2'); h.style.marginTop = '0';
      var d = b.ts || b.at || b.createdAt; h.textContent = (b.title || 'Kade-AI') + (d ? ' — ' + new Date(d).toLocaleString([], {dateStyle:'medium', timeStyle:'short'}) : '');
      var p = document.createElement('p'); p.textContent = b.body || b.text || b.message || ''; card.appendChild(h); card.appendChild(p); list.appendChild(card); });
  }catch(e){ status.textContent = 'Could not load announcements.'; }
})();
</script>
</body></html>`;

module.exports = { homeHtml, conversationsHtml, announcementsHtml };
