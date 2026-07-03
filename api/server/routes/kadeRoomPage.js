/* Debate & Roleplay Room page (July 3 2026). Same self-contained pattern as
 * kadePages.js: static HTML, client JS self-authenticates via
 * /api/auth/refresh then calls the gated /api/kade/room APIs. Screen-reader
 * first: real labels, role="log" transcript, status announcements. */

const roomHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Debate &amp; Roleplay Room — Kade-AI</title>
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
    .card, #log { background: #1e2127 !important; border-color: #2c2f37 !important; }
    button.btn { background: #2f8f5b !important; }
    textarea, input[type=text] { background: #14161a; color: #e7e9ee; border-color: #2c2f37; }
    .line.user { background: #24303f !important; }
  }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.15rem; margin: 1.25rem 0 .5rem; }
  .muted { opacity: .75; }
  .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 14px; padding: 1.1rem 1.2rem; margin: 1rem 0; }
  a.back { display:inline-block; margin:0 0 .25rem; font-weight:600; text-decoration:none; color:#2f6fed; }
  a.back:focus-visible, button:focus-visible, textarea:focus-visible, input:focus-visible { outline:3px solid #ffbf47; outline-offset:2px; }
  label { display:block; font-weight:600; margin:.8rem 0 .25rem; }
  textarea { width:100%; border:1px solid #c9ced6; border-radius:10px; padding:.6rem .7rem; font: inherit; }
  fieldset { border:1px solid #c9ced6; border-radius:10px; margin:.9rem 0 0; padding:.6rem .9rem .9rem; }
  legend { font-weight:600; padding:0 .3rem; }
  .agent-row { display:flex; align-items:flex-start; gap:.55rem; padding:.35rem 0; }
  .agent-row input { margin-top:.3rem; width:1.15rem; height:1.15rem; flex:none; }
  .agent-row .desc { display:block; font-size:.85rem; opacity:.75; font-weight:400; }
  .agent-row label { margin:0; font-weight:600; }
  button { font:inherit; border-radius:10px; border:1px solid #c9ced6; background:#fff; color:inherit; padding:.6rem 1rem; cursor:pointer; }
  @media (prefers-color-scheme: dark){ button { background:#24272f; border-color:#2c2f37; } }
  button.btn { background:#2f8f5b; border-color:#2f8f5b; color:#fff; font-weight:600; }
  button.danger { color:#b42318; border-color:#b42318; background:transparent; }
  button[disabled] { opacity:.5; cursor:default; }
  .controls { display:flex; flex-wrap:wrap; gap:.5rem; margin:.7rem 0 0; }
  #log { border:1px solid #e3e6ea; border-radius:14px; background:#fff; padding: .9rem 1rem; max-height:60vh; overflow-y:auto; margin:.75rem 0; }
  .line { margin:.55rem 0; padding:.55rem .7rem; border-radius:10px; }
  .line.user { background:#e8f1ff; }
  .line .who { font-weight:700; }
  .status { padding:.75rem 1rem; border-radius:10px; background:#fff6da; color:#6b5500; margin:.75rem 0; }
  .err { background:#ffe3e3; color:#8a1f1f; }
  @media (prefers-color-scheme: dark){ .status { background:#3a3520; color:#ffe9a8; } .status.err { background:#402024; color:#ffc9c9; } }
  ul.rooms { list-style:none; margin:.25rem 0 0; padding:0; }
  ul.rooms li { display:flex; flex-wrap:wrap; align-items:center; gap:.5rem; padding:.55rem 0; border-bottom:1px solid #e3e6ea; }
  ul.rooms .info { flex:1 1 14rem; min-width:0; }
  ul.rooms .topic { font-weight:600; }
  footer { margin-top:2rem; font-size:.85rem; }
</style>
</head>
<body>
  <a class="back" href="/">&larr; Back to chat</a>
  <h1>Debate &amp; Roleplay Room</h1>
  <p class="muted">Drop two or more characters into a room, hand them a topic or a scene, and jump in whenever you feel like it. They will argue, agree, and everything in between.</p>

  <div id="status" class="status" role="status" hidden></div>

  <main id="lobby" hidden>
    <section class="card" aria-labelledby="newroom-h">
      <h2 id="newroom-h" style="margin-top:0">Start a new room</h2>
      <label for="topic">Topic or scene (required)</label>
      <textarea id="topic" rows="2" placeholder="e.g. Pineapple belongs on pizza — settle it."></textarea>
      <label for="goals">Ground rules, goals, or roleplay setup (optional)</label>
      <textarea id="goals" rows="3" placeholder="e.g. Nova argues FOR and cites history. Doug argues AGAINST and takes it way too personally. Keep it PG."></textarea>
      <fieldset>
        <legend>Pick your cast (2 to 6 characters)</legend>
        <p id="cast-status" class="muted" role="status">Loading characters&hellip;</p>
        <div id="cast"></div>
      </fieldset>
      <div class="controls">
        <button id="create" class="btn">Create room</button>
      </div>
      <p class="muted" style="margin-top:.9rem">Each character turn costs a fraction of a cent and shows up on your <a href="/feed-the-server">Feed the Server</a> tab.</p>
    </section>

    <section class="card" aria-labelledby="rooms-h">
      <h2 id="rooms-h" style="margin-top:0">Your rooms</h2>
      <ul id="rooms" class="rooms"></ul>
      <p id="norooms" class="muted" hidden>No rooms yet — start one above.</p>
    </section>
  </main>

  <main id="roomview" hidden>
    <h2 id="rv-topic" tabindex="-1"></h2>
    <p id="rv-cast" class="muted"></p>
    <div id="log" role="log" aria-live="polite" aria-label="Room conversation"></div>
    <p id="thinking" class="muted" role="status" aria-live="polite"></p>
    <label for="saybox">Say something in the room (after you speak, each character gets a turn)</label>
    <textarea id="saybox" rows="2"></textarea>
    <div class="controls">
      <button id="send" class="btn">Send</button>
      <button id="next">Next speaker</button>
      <button id="round">Run a round</button>
      <button id="auto">Let them cook (3 rounds)</button>
      <button id="stopBtn" hidden>Stop</button>
    </div>
    <div class="controls" style="margin-top:1rem">
      <button id="backBtn">Back to your rooms</button>
      <button id="delBtn" class="danger">Delete this room</button>
    </div>
  </main>

  <footer class="muted">Kade-AI &middot; <a href="/">back to chat</a></footer>

<script>
(function(){
  var token = null, agents = [], room = null, busy = false, stopFlag = false;
  var $ = function(id){ return document.getElementById(id); };
  var statusEl = $('status');

  function setStatus(msg, isErr){
    if(!msg){ statusEl.hidden = true; statusEl.textContent=''; statusEl.className='status'; return; }
    statusEl.hidden = false; statusEl.textContent = msg;
    statusEl.className = 'status' + (isErr ? ' err' : '');
  }
  function esc(s){ var d=document.createElement('div'); d.textContent=String(s==null?'':s); return d.innerHTML; }

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
    if(opts.body && typeof opts.body !== 'string'){ opts.body = JSON.stringify(opts.body); opts.headers['Content-Type']='application/json'; }
    var r = await fetch('/api/kade/room'+path, opts);
    var j = null; try { j = await r.json(); } catch(e){}
    if(!r.ok){ throw new Error((j && j.message) || ('HTTP '+r.status)); }
    return j;
  }

  function setBusy(b){
    busy = b;
    ['send','next','round','auto','create','delBtn'].forEach(function(id){ var el=$(id); if(el) el.disabled = b; });
    $('stopBtn').hidden = !b;
  }

  /* ---------- lobby ---------- */
  function renderCast(){
    var box = $('cast');
    box.innerHTML = agents.map(function(a, i){
      return '<div class="agent-row">' +
        '<input type="checkbox" id="ag'+i+'" value="'+esc(a.id)+'">' +
        '<label for="ag'+i+'">'+esc(a.name) +
          (a.description ? '<span class="desc">'+esc(a.description)+'</span>' : '') +
        '</label></div>';
    }).join('');
    $('cast-status').textContent = agents.length + ' characters available. Check 2 to 6.';
  }
  function renderRooms(list){
    var ul = $('rooms');
    $('norooms').hidden = list.length > 0;
    ul.innerHTML = list.map(function(r){
      var cast = r.agents.map(function(a){ return a.name; }).join(', ');
      return '<li>' +
        '<span class="info"><span class="topic">'+esc(r.topic)+'</span><br>' +
        '<span class="muted">'+esc(cast)+' &middot; '+r.lines+' lines</span></span>' +
        '<button type="button" data-open="'+esc(r.id)+'">Open</button>' +
        '<button type="button" class="danger" data-del="'+esc(r.id)+'" aria-label="Delete room: '+esc(r.topic)+'">Delete</button>' +
      '</li>';
    }).join('');
  }
  async function loadLobby(){
    var rl = await api('');
    renderRooms(rl.rooms || []);
  }

  /* ---------- room view ---------- */
  function lineHtml(m){
    var mine = m.speaker === 'user';
    return '<p class="line'+(mine?' user':'')+'"><span class="who">'+esc(m.name)+':</span> '+esc(m.text)+'</p>';
  }
  function appendLine(m){
    var log = $('log');
    log.insertAdjacentHTML('beforeend', lineHtml(m));
    log.scrollTop = log.scrollHeight;
  }
  function whoIsNext(){
    if(!room || !room.agents.length) return '';
    return room.agents[room.nextIdx % room.agents.length].name;
  }
  function showRoom(r){
    room = r;
    $('rv-topic').textContent = r.topic;
    $('rv-cast').textContent = 'In the room: ' + r.agents.map(function(a){return a.name;}).join(', ') + ', and you.';
    $('log').innerHTML = (r.transcript||[]).map(lineHtml).join('');
    $('log').scrollTop = $('log').scrollHeight;
    $('lobby').hidden = true; $('roomview').hidden = false;
    setStatus('');
    $('rv-topic').focus();
  }
  async function openRoom(id){
    try{ setStatus('Opening room…'); var j = await api('/'+id); showRoom(j.room); }
    catch(e){ setStatus(e.message, true); }
  }

  async function oneTurn(){
    $('thinking').textContent = whoIsNext() + ' is thinking…';
    try{
      var j = await api('/'+room.id+'/next', {method:'POST', body:{}});
      room.nextIdx = j.nextIdx;
      appendLine(j.message);
      $('thinking').textContent = '';
      return true;
    }catch(e){
      $('thinking').textContent = '';
      setStatus(e.message, true);
      return false;
    }
  }
  async function runTurns(n){
    if(busy) return;
    setBusy(true); stopFlag = false; setStatus('');
    for(var i=0;i<n;i++){
      if(stopFlag) break;
      var ok = await oneTurn();
      if(!ok) break;
    }
    setBusy(false);
  }
  async function sendSay(){
    var text = $('saybox').value.trim();
    if(!text || busy) return;
    setBusy(true); stopFlag = false; setStatus('');
    try{
      var j = await api('/'+room.id+'/say', {method:'POST', body:{text:text}});
      appendLine(j.message);
      $('saybox').value = '';
      setBusy(false);
      await runTurns(room.agents.length); // everyone responds once
    }catch(e){
      setBusy(false);
      setStatus(e.message, true);
    }
  }

  /* ---------- wiring ---------- */
  $('create').addEventListener('click', async function(){
    var topic = $('topic').value.trim();
    var checked = Array.prototype.slice.call(document.querySelectorAll('#cast input:checked')).map(function(c){return c.value;});
    if(!topic){ setStatus('Give the room a topic or scene first.', true); $('topic').focus(); return; }
    if(checked.length < 2 || checked.length > 6){ setStatus('Pick between 2 and 6 characters.', true); return; }
    setBusy(true); setStatus('Creating room…');
    try{
      var j = await api('', {method:'POST', body:{topic:topic, goals:$('goals').value.trim(), agentIds:checked}});
      setBusy(false);
      showRoom(j.room);
    }catch(e){ setBusy(false); setStatus(e.message, true); }
  });
  $('rooms').addEventListener('click', async function(ev){
    var open = ev.target.closest('button[data-open]');
    var del = ev.target.closest('button[data-del]');
    if(open){ openRoom(open.getAttribute('data-open')); }
    if(del){
      if(!confirm('Delete this room and its whole conversation?')) return;
      try{ await api('/'+del.getAttribute('data-del'), {method:'DELETE'}); loadLobby(); }
      catch(e){ setStatus(e.message, true); }
    }
  });
  $('send').addEventListener('click', sendSay);
  $('saybox').addEventListener('keydown', function(ev){
    if(ev.key === 'Enter' && !ev.shiftKey){ ev.preventDefault(); sendSay(); }
  });
  $('next').addEventListener('click', function(){ runTurns(1); });
  $('round').addEventListener('click', function(){ runTurns(room.agents.length); });
  $('auto').addEventListener('click', function(){ runTurns(room.agents.length * 3); });
  $('stopBtn').addEventListener('click', function(){ stopFlag = true; $('stopBtn').textContent = 'Stopping…'; setTimeout(function(){ $('stopBtn').textContent='Stop'; }, 1500); });
  $('backBtn').addEventListener('click', async function(){
    stopFlag = true; room = null;
    $('roomview').hidden = true; $('lobby').hidden = false;
    try{ await loadLobby(); }catch(e){}
  });
  $('delBtn').addEventListener('click', async function(){
    if(!confirm('Delete this room and its whole conversation?')) return;
    try{ await api('/'+room.id, {method:'DELETE'}); $('roomview').hidden=true; $('lobby').hidden=false; loadLobby(); }
    catch(e){ setStatus(e.message, true); }
  });

  (async function init(){
    setStatus('Signing you in…');
    token = await getToken();
    if(!token){ setStatus('You need to be signed in to use the room. Open the main site, sign in, then come back.', true); return; }
    try{
      var aj = await api('/agents');
      agents = aj.agents || [];
      renderCast();
      await loadLobby();
      $('lobby').hidden = false;
      setStatus('');
    }catch(e){ setStatus(e.message, true); }
  })();
})();
</script>
</body></html>`;

module.exports = { roomHtml };
