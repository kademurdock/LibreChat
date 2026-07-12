/* Calls & Conversations history page (July 5 2026). Same self-contained pattern
 * as kadeRoomPage.js: static HTML shell, client JS self-authenticates via
 * /api/auth/refresh then calls the gated /api/kade/calls APIs. Screen-reader
 * first: real headings and labels, each call is a button with a full aria-label,
 * a polite status line announces state, and the transcript uses focus movement
 * (NOT an aria-live region — that re-announce bug bit ConversationMode) so a
 * screen reader reads it once, cleanly, on demand. Transcript text only. */

const callsHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Calls &amp; Conversations — Kade-AI</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: calc(1.25rem + env(safe-area-inset-top, 0px)) 1.25rem calc(1.25rem + env(safe-area-inset-bottom, 0px));
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.5; color: #16181d; background: #f6f7f9;
    max-width: 880px; margin-left: auto; margin-right: auto;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e7e9ee; background: #14161a; }
    .card, #detail { background: #1e2127 !important; border-color: #2c2f37 !important; }
    .call { background: #1e2127 !important; border-color: #2c2f37 !important; }
    .call:hover { background: #24272f !important; }
    .line.user { background: #24303f !important; }
    .line.assistant { background: #1b2a20 !important; }
  }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.15rem; margin: 1.25rem 0 .5rem; }
  .muted { opacity: .75; }
  a.back { display:inline-block; margin:0 0 .5rem; font-weight:600; text-decoration:none; color:#2f6fed; }
  a.back:focus-visible, button:focus-visible, .call:focus-visible { outline:3px solid #ffbf47; outline-offset:2px; }
  .status { margin:.5rem 0; font-weight:600; min-height:1.25rem; }
  .status.err { color:#b42318; }
  .card { background:#fff; border:1px solid #e3e6ea; border-radius:14px; padding:1.1rem 1.2rem; margin:1rem 0; }
  ul.calls { list-style:none; margin:.5rem 0 0; padding:0; }
  li.call-item { margin:.5rem 0; }
  .call {
    display:block; width:100%; text-align:left; font:inherit; color:inherit; cursor:pointer;
    background:#fff; border:1px solid #e3e6ea; border-radius:12px; padding:.7rem .85rem;
  }
  .call:hover { background:#f0f2f5; }
  .call .top { font-weight:600; }
  .call .sub { font-size:.86rem; opacity:.75; margin-top:.15rem; }
  .call .prev { font-size:.9rem; margin-top:.3rem; opacity:.9; }
  .badge { display:inline-block; font-size:.72rem; font-weight:700; text-transform:uppercase; letter-spacing:.03em;
    padding:.1rem .4rem; border-radius:6px; margin-right:.4rem; vertical-align:.05em; }
  .badge.phone { background:#e4f0ff; color:#1b4fa0; }
  .badge.conversation { background:#e9f7ee; color:#1c6b3f; }
  @media (prefers-color-scheme: dark){
    .badge.phone { background:#1b3358; color:#bcd7ff; }
    .badge.conversation { background:#1b3a28; color:#b8ecc9; }
  }
  #detail { border:1px solid #e3e6ea; border-radius:14px; background:#fff; padding:1rem 1.1rem; margin:.75rem 0; }
  .line { margin:.5rem 0; padding:.55rem .7rem; border-radius:10px; background:#f2f4f7; }
  .line.user { background:#eaf1fb; }
  .line .who { font-weight:700; font-size:.8rem; text-transform:uppercase; letter-spacing:.03em; opacity:.7; display:block; margin-bottom:.15rem; }
  .controls { display:flex; flex-wrap:wrap; gap:.5rem; margin:.6rem 0 0; }
  button.btn { font:inherit; border-radius:10px; border:1px solid #c9ced6; background:#fff; color:inherit; padding:.5rem .9rem; cursor:pointer; }
  button.btn.primary { background:#2f8f5b; border-color:#2f8f5b; color:#fff; font-weight:600; }
  button.btn.danger { color:#b42318; border-color:#b42318; background:transparent; }
  button.btn[disabled] { opacity:.5; cursor:default; }
  .visually-hidden { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }
</style>
</head>
<body>
  <a class="back" href="/">&larr; Back to Kade-AI</a>
  <h1>Calls &amp; Conversations</h1>
  <p class="muted">Every phone call and voice conversation, saved as a readable transcript. Only you can see yours.</p>
  <p id="status" class="status" role="status" aria-live="polite">Loading your history…</p>

  <section id="listSection" aria-labelledby="listHead">
    <h2 id="listHead">Your calls</h2>
    <ul id="calls" class="calls" aria-label="Your calls and conversations, newest first"></ul>
  </section>

  <section id="detailSection" hidden aria-labelledby="detailHead">
    <h2 id="detailHead" tabindex="-1">Transcript</h2>
    <div class="controls">
      <button type="button" class="btn" id="backToList">&larr; Back to the list</button>
      <button type="button" class="btn danger" id="deleteCall">Delete this call</button>
    </div>
    <div id="detail" role="document"></div>
  </section>

<script>
(function(){
  var token = null, currentId = null;
  function $(id){ return document.getElementById(id); }
  /* July 13 2026 scrub audit: transcripts saved before today carry raw
   * %%%voice tags / [sound:] cues / citation escape-text — clean at render. */
  function scrubTag(x){ return String(x==null?'':x)
    .replace(/%{2,4}[a-zA-Z][^%\n]{0,80}%{2,4}/g,'')
    .replace(/\[(?:sound:[a-z0-9_]+|table:[a-z0-9]{1,12})\]/gi,'')
    .replace(/\[END CALL\]/gi,'')
    .replace(/[\uE000-\uF8FF]/g,'')
    .replace(/\\?u[eE]20[0-9a-fA-F]turn\d+[a-zA-Z]+\d+/g,'')
    .replace(/\\?u[eE]20[0-9a-fA-F]/g,'')
    .replace(/turn\d+(?:search|image|news|video|ref|file)\d+/g,'')
    .replace(/\\u00a0/gi,' ')
    .replace(/[ \t]{2,}/g,' ').trim(); }
  function setStatus(msg, err){ var s=$('status'); s.textContent=msg; s.className='status'+(err?' err':''); }

  async function getToken(){
    try{
      var r = await fetch('/api/auth/refresh', {method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body:'{}'});
      if(!r.ok) return null;
      var j = await r.json();
      return j && j.token ? j.token : null;
    }catch(e){ return null; }
  }
  async function api(path, opts){
    opts = opts || {};
    opts.headers = Object.assign({'Authorization':'Bearer '+token}, opts.headers||{});
    return fetch('/api/kade/calls'+path, opts);
  }

  function fmtWhen(iso){
    if(!iso) return '';
    var d = new Date(iso);
    if(isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, {month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'});
  }
  function fmtDur(sec){
    sec = Math.max(0, Math.round(sec||0));
    if(sec < 60) return sec + (sec===1?' second':' seconds');
    var m = Math.round(sec/60);
    return m + (m===1?' minute':' minutes');
  }
  function surfaceWord(s){ return s==='phone' ? 'Phone call' : 'Voice conversation'; }

  function renderList(calls){
    var ul = $('calls'); ul.innerHTML='';
    if(!calls.length){
      setStatus('No calls yet. Once you talk to a character by phone or in conversation mode, it shows up here.');
      return;
    }
    calls.forEach(function(c){
      var li = document.createElement('li'); li.className='call-item';
      var btn = document.createElement('button'); btn.type='button'; btn.className='call';
      var who = c.agentName || 'Kiana';
      var when = fmtWhen(c.startedAt);
      var dur = fmtDur(c.durationSec);
      var label = surfaceWord(c.surface)+' with '+who+', '+when+', '+dur+', '+c.turnCount+' turn'+(c.turnCount===1?'':'s')+'. Activate to read the transcript.';
      btn.setAttribute('aria-label', label);
      var badge = c.surface==='phone' ? 'phone' : 'conversation';
      btn.innerHTML =
        '<span class="top"><span class="badge '+badge+'">'+(c.surface==='phone'?'Phone':'Voice')+'</span>'+escapeHtml(who)+'</span>'+
        '<span class="sub">'+escapeHtml(when)+' &middot; '+escapeHtml(dur)+' &middot; '+c.turnCount+' turn'+(c.turnCount===1?'':'s')+'</span>'+
        (c.preview ? '<span class="prev">'+escapeHtml(scrubTag(c.preview))+'</span>' : '');
      btn.addEventListener('click', function(){ openCall(c.id); });
      li.appendChild(btn); ul.appendChild(li);
    });
    setStatus('Showing '+calls.length+' call'+(calls.length===1?'':'s')+', newest first.');
  }

  function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(ch){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]; }); }

  async function loadList(){
    setStatus('Loading your history…');
    var r = await api('');
    if(r.status===401 || r.status===403){ notSignedIn(); return; }
    if(!r.ok){ setStatus('Could not load your history. Try again in a moment.', true); return; }
    var j = await r.json();
    renderList(j.calls || []);
  }

  async function openCall(id){
    currentId = id;
    setStatus('Loading transcript…');
    var r = await api('/'+encodeURIComponent(id));
    if(!r.ok){ setStatus('Could not load that transcript.', true); return; }
    var d = await r.json();
    var who = d.agentName || 'Kiana';
    var head = surfaceWord(d.surface)+' with '+who;
    $('detailHead').textContent = head;
    var meta = fmtWhen(d.startedAt) + ' · ' + fmtDur(d.durationSec) + ' · ' + d.turnCount + ' turn'+(d.turnCount===1?'':'s');
    var html = '<p class="muted">'+escapeHtml(meta)+(d.from?(' · '+escapeHtml(d.from)):'')+'</p>';
    (d.turns||[]).forEach(function(t){
      var whoTurn = t.role==='user' ? (d.surface==='phone' ? (d.callerName||'Caller') : 'You') : who;
      html += '<div class="line '+(t.role==='user'?'user':'assistant')+'">'+
              '<span class="who">'+escapeHtml(whoTurn)+' said</span>'+escapeHtml(scrubTag(t.text))+'</div>';
    });
    if(!(d.turns||[]).length){ html += '<p class="muted">This call has no saved transcript text.</p>'; }
    $('detail').innerHTML = html;
    $('listSection').hidden = true;
    $('detailSection').hidden = false;
    setStatus('Transcript of '+head+', '+d.turnCount+' turns.');
    var h = $('detailHead'); h.focus();
  }

  function showList(){
    $('detailSection').hidden = true;
    $('listSection').hidden = false;
    currentId = null;
    var first = document.querySelector('.call');
    if(first) first.focus();
    setStatus('Back to your list of calls.');
  }

  async function deleteCurrent(){
    if(!currentId) return;
    if(!window.confirm('Delete this call from your history? This cannot be undone.')) return;
    var r = await api('/'+encodeURIComponent(currentId), {method:'DELETE'});
    if(!r.ok){ setStatus('Could not delete that call.', true); return; }
    setStatus('Call deleted.');
    await loadList();
    showList();
  }

  function notSignedIn(){
    setStatus('You need to be signed in to see your history. Open the main site, sign in, then come back to this page.', true);
    $('calls').innerHTML = '';
  }

  $('backToList').addEventListener('click', showList);
  $('deleteCall').addEventListener('click', deleteCurrent);

  (async function init(){
    token = await getToken();
    if(!token){ notSignedIn(); return; }
    await loadList();
  })();
})();
</script>
</body>
</html>`;

module.exports = { callsHtml };
