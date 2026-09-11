/* ----------------------------------------------------------------------------
 * THE READING ROOM, ON THE WEB (Part 181, Sep 11 2026)
 *
 * One page, two screens: the SHELF (your books, what you have checked out,
 * the library, and the donate forms) and the PLAYER (?book=<id>).
 *
 * SCREEN-READER SHAPE (her rule): real labelled buttons, ONE aria-live region
 * that speaks only what changed (a chapter title, "bookmark placed", an
 * error), never the text being read. Nothing auto-plays; the first Play tap
 * is what unlocks audio on iPhone Safari.
 *
 * TEXT BOOKS: each chunk is fetched as WAV from /audio/:s/:c, decoded with
 * Web Audio and scheduled to start exactly when the previous one ends
 * (gapless); two chunks are always fetched ahead. Back and Forward move a
 * chunk (about half a minute); Previous/Next chapter move a section.
 * AUDIO DONATIONS: a plain <audio> element on the signed B2 URL; Back and
 * Forward move 15 seconds; Previous/Next move a track.
 * Both wire the Media Session API so lock-screen and headphone buttons work.
 * -------------------------------------------------------------------------- */
const { SHARED_HEAD } = require('./kadePages');

const readingRoomHtml = `<!doctype html><html lang="en"><head><title>The Reading Room — Kade-AI</title>${SHARED_HEAD}
<style>
  .hidden { display:none !important; }
  .row { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
  button.act { font:inherit; font-weight:700; padding:.8rem 1.1rem; border-radius:12px; border:1px solid #1d55d0; background:#fff; color:#1d55d0; cursor:pointer; min-height:48px; }
  button.act.primary { background:#1f7a49; border-color:#1f7a49; color:#fff; }
  button.act.quiet { border-color:#8a919c; color:inherit; font-weight:600; }
  button.act.big { font-size:1.25rem; padding:1rem 1.4rem; min-width:9rem; }
  button.act[disabled] { opacity:.55; cursor:default; }
  button.act:focus-visible, select:focus-visible, input:focus-visible { outline:3px solid #ffbf47; outline-offset:2px; }
  .controls { display:grid; grid-template-columns:1fr 1fr 1fr; gap:.5rem; margin:.8rem 0; }
  .controls .wide { grid-column:1 / -1; }
  label.field { display:block; font-weight:600; margin:.7rem 0 .25rem; }
  select, input[type=text], input[type=file], textarea { width:100%; font:inherit; padding:.6rem .7rem; border-radius:10px; border:1px solid #b9bfc9; background:#fff; color:inherit; }
  .hint { font-size:.9rem; opacity:.82; margin:.15rem 0 .35rem; }
  .book { display:flex; flex-direction:column; gap:.25rem; }
  .book strong { font-size:1.08rem; }
  .book .meta { opacity:.8; font-size:.92rem; }
  .now { font-size:1.15rem; line-height:1.55; padding:1rem 1.1rem; border-radius:14px; background:#fff; border:1px solid #e3e6ea; min-height:5rem; }
  .status { margin:.6rem 0; }
  ul.plain { list-style:none; padding:0; margin:.5rem 0; display:grid; gap:.5rem; }
  ul.plain li { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }
  ul.plain li span.t { flex:1 1 12rem; }
  details { margin:.8rem 0; }
  summary { cursor:pointer; font-weight:600; padding:.3rem 0; }
  @media (prefers-color-scheme: dark) {
    button.act { background:#1e2127; color:#9ec2ff; border-color:#4a78d8; }
    button.act.primary { background:#1f7a49; color:#fff; border-color:#1f7a49; }
    select, input[type=text], input[type=file], textarea, .now { background:#1e2127; color:inherit; border-color:#2c2f37; }
  }
  @media (max-width: 480px) { .controls { grid-template-columns:1fr 1fr; } }
</style></head>
<body>
  <p><a class="back" href="/home" aria-label="Back to Home">&larr; Home</a></p>
  <h1 id="pageTitle">The Reading Room</h1>
  <p id="live" class="status" role="status" aria-live="polite"></p>

  <section id="shelf">
    <p class="muted">Books read aloud by a voice you choose, and recordings the family has donated. Your shelf is yours; put something in the library and everyone can check it out.</p>

    <h2 id="h-mine">Your shelf</h2>
    <ul class="plain" id="mineList" aria-labelledby="h-mine"><li class="muted">Loading…</li></ul>

    <h2 id="h-borrowed">Checked out</h2>
    <ul class="plain" id="borrowedList" aria-labelledby="h-borrowed"><li class="muted">Nothing checked out yet.</li></ul>

    <h2 id="h-library">The library</h2>
    <div class="row" role="group" aria-label="Show only">
      <label class="field" for="catFilter" style="margin:0">Show</label>
      <select id="catFilter" style="width:auto"><option value="">Everything</option></select>
    </div>
    <ul class="plain" id="libraryList" aria-labelledby="h-library"><li class="muted">Loading…</li></ul>

    <h2 id="h-donate">Donate a book</h2>
    <div class="card">
      <p class="hint">Bookshare's DAISY zip (the "text only" download), an EPUB, a text file, a Word file or an HTML page. It lands on your shelf first; the Bookshare notice at the front is skipped automatically and the book opens with its jacket.</p>
      <label class="field" for="bookFile">Book file</label>
      <input type="file" id="bookFile" accept=".zip,.epub,.txt,.docx,.html,.htm,.xhtml,.xml,application/zip,application/epub+zip,text/plain">
      <label class="field"><input type="checkbox" id="bookGrownUps"> Grown-ups only (hidden from the kids' accounts)</label>
      <button class="act primary" id="bookUploadBtn" type="button">Add this book to my shelf</button>
    </div>

    <h2 id="h-donate-audio">Donate a recording</h2>
    <div class="card">
      <p class="hint">An audiobook, the audio from a described movie, a cassette side, old radio or commercials — MP3, M4A, M4B, AAC, WAV, OGG or FLAC. Give it a name, then add one or more parts. Files over 80 MB go through the phone app or need splitting here.</p>
      <label class="field" for="auTitle">Title</label><input type="text" id="auTitle" placeholder="The Little Mermaid (described audio)">
      <label class="field" for="auAuthor">Who made it (optional)</label><input type="text" id="auAuthor" placeholder="Author, narrator, studio, or station">
      <label class="field" for="auYear">Year (optional)</label><input type="text" id="auYear" placeholder="1989">
      <label class="field" for="auCategory">Shelf</label>
      <select id="auCategory"><option value="audiobook">Audiobook</option><option value="movie">Movie</option><option value="cassette">Cassette</option><option value="radio">Radio</option><option value="commercials">Commercials</option><option value="music">Music</option><option value="other">Other</option></select>
      <label class="field" for="auDesc">About it (optional)</label><textarea id="auDesc" rows="3" placeholder="What it is, where it came from, anything a listener should know."></textarea>
      <label class="field"><input type="checkbox" id="auGrownUps"> Grown-ups only</label>
      <button class="act primary" id="auStartBtn" type="button">Start this donation</button>
      <div id="auTracks" class="hidden">
        <p class="hint" id="auTracksHint"></p>
        <label class="field" for="auFile">Add a part (audio file)</label>
        <input type="file" id="auFile" accept="audio/*,.mp3,.m4a,.m4b,.aac,.wav,.ogg,.flac">
        <label class="field" for="auTrackTitle">Name for this part (optional)</label><input type="text" id="auTrackTitle" placeholder="Side A, Part 2, Episode 3…">
        <button class="act" id="auAddBtn" type="button">Upload this part</button>
        <ul class="plain" id="auTrackList"></ul>
        <button class="act quiet" id="auDoneBtn" type="button">Done — back to my shelf</button>
      </div>
    </div>
  </section>

  <section id="player" class="hidden">
    <p><button class="act quiet" id="backToShelf" type="button">&larr; Back to the shelf</button></p>
    <h2 id="bookTitle"></h2>
    <p class="meta" id="bookMeta"></p>
    <p class="hint" id="jacketLine"></p>
    <div class="controls" role="group" aria-label="Playback">
      <button class="act big primary wide" id="playBtn" type="button">Play</button>
      <button class="act" id="backBtn" type="button">Back</button>
      <button class="act" id="fwdBtn" type="button">Forward</button>
      <button class="act" id="markBtn" type="button">Bookmark here</button>
      <button class="act quiet" id="prevSecBtn" type="button">Previous chapter</button>
      <button class="act quiet" id="nextSecBtn" type="button">Next chapter</button>
      <button class="act quiet" id="startBtn" type="button">From the beginning</button>
    </div>
    <p class="hint">Keys: Space play or pause, Left and Right back or forward, Shift with Left or Right for chapters, B for a bookmark.</p>
    <div class="now" id="nowText" aria-label="Now reading"></div>

    <label class="field" for="chapterSel">Chapter</label>
    <select id="chapterSel"></select>
    <button class="act" id="goChapterBtn" type="button">Go to this chapter</button>

    <div id="voiceWrap">
      <label class="field" for="voiceSel">Voice</label>
      <select id="voiceSel"></select>
      <label class="field" for="speedSel">Speed</label>
      <select id="speedSel"><option value="0.8">Slower</option><option value="0.9">A little slower</option><option value="1" selected>Normal</option><option value="1.15">A little faster</option><option value="1.3">Faster</option><option value="1.5">Fastest</option></select>
    </div>

    <details><summary>Bookmarks</summary>
      <ul class="plain" id="bookmarkList"><li class="muted">None yet.</li></ul>
    </details>
    <details id="skippedWrap"><summary id="skippedSummary">Skipped parts</summary>
      <p class="hint">Front matter the room skips on its own: the Bookshare notice, the copyright page, the contents list, publisher sign-up pages. Play any of them here.</p>
      <ul class="plain" id="skippedList"></ul>
    </details>
    <details id="ownerWrap" class="hidden"><summary>This is your donation</summary>
      <div class="row">
        <button class="act" id="shareBtn" type="button"></button>
        <button class="act quiet" id="grownBtn" type="button"></button>
        <button class="act quiet" id="deleteBtn" type="button">Withdraw it from the room</button>
      </div>
    </details>
    <details id="borrowWrap" class="hidden"><summary>Checked out</summary>
      <button class="act quiet" id="returnBtn" type="button">Return it to the library</button>
    </details>
    <audio id="fileAudio" preload="auto" class="hidden"></audio>
  </section>

<script>
(function(){
  var token = null;
  var API = '/api/kade/reading-room';
  var TTS_BASE = 'https://inworld-tts-proxy-production.up.railway.app';
  var $ = function(id){ return document.getElementById(id); };
  var live = $('live');
  function say(t){ live.textContent = ''; setTimeout(function(){ live.textContent = t; }, 30); }
  function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function catName(c){ return {book:'Book', audiobook:'Audiobook', movie:'Movie', cassette:'Cassette', radio:'Radio', commercials:'Commercials', music:'Music', other:'Other'}[c] || c; }
  async function api(path, opts){
    opts = opts || {};
    var h = opts.headers || {}; h['Authorization'] = 'Bearer ' + token;
    if (opts.json) { h['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
    var r = await fetch(API + path, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: h, body: opts.body });
    var j = null; try { j = await r.json(); } catch(e) {}
    if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j;
  }

  /* ── shelf ─────────────────────────────────────────────────────────── */
  var shelfData = null;
  function bookLi(b, where){
    var li = document.createElement('li');
    var kind = b.kind === 'audio' ? catName(b.category) : 'Book';
    var by = b.author ? ' by ' + b.author : '';
    var prog = b.progress && b.progress.where ? (b.kind === 'audio' ? ' · Part ' : ' · Chapter ') + b.progress.where : '';
    var donor = where === 'library' || where === 'borrowed' ? ' · Donated by ' + esc(b.ownerName || 'someone') : '';
    var len = b.listen ? ' · ' + b.listen : '';
    var pending = b.state === 'pending' ? ' · no recordings yet' : '';
    li.innerHTML = '<span class="t book"><strong>' + esc(b.title) + '</strong><span class="meta">' + esc(kind + by) + len + prog + donor + pending + (b.shared && where === 'mine' ? ' · in the library' : '') + '</span></span>';
    var open = document.createElement('button'); open.className = 'act'; open.type = 'button';
    open.textContent = where === 'library' ? 'Check out' : (b.progress && !b.progress.finished && (b.progress.s || b.progress.c || b.progress.pos) ? 'Continue' : 'Open');
    open.setAttribute('aria-label', open.textContent + ' ' + b.title);
    open.onclick = function(){ location.search = '?book=' + b.id; };
    li.appendChild(open);
    if (where === 'mine' && b.kind === 'audio') {
      var add = document.createElement('button'); add.className = 'act quiet'; add.type = 'button'; add.textContent = 'Add parts';
      add.setAttribute('aria-label', 'Add parts to ' + b.title);
      add.onclick = function(){ openTrackAdder(b); };
      li.appendChild(add);
    }
    return li;
  }
  function renderList(id, items, where, empty){
    var ul = $(id); ul.innerHTML = '';
    if (!items.length) { ul.innerHTML = '<li class="muted">' + empty + '</li>'; return; }
    items.forEach(function(b){ ul.appendChild(bookLi(b, where)); });
  }
  function renderLibrary(){
    var cat = $('catFilter').value;
    var items = (shelfData.library || []).filter(function(b){ return !cat || (b.kind === 'audio' ? b.category : 'book') === cat; });
    renderList('libraryList', items, 'library', cat ? 'Nothing on that shelf yet.' : 'The library is empty — donate something from your shelf.');
  }
  async function loadShelf(){
    try {
      shelfData = await api('/shelf');
      renderList('mineList', shelfData.mine, 'mine', 'Nothing on your shelf yet. Donate a book or a recording below.');
      renderList('borrowedList', shelfData.borrowed, 'borrowed', 'Nothing checked out yet.');
      var sel = $('catFilter'); var cur = sel.value; sel.innerHTML = '<option value="">Everything</option>';
      var present = {}; (shelfData.library || []).forEach(function(b){ present[b.kind === 'audio' ? b.category : 'book'] = 1; });
      Object.keys(present).forEach(function(c){ var o = document.createElement('option'); o.value = c; o.textContent = catName(c); sel.appendChild(o); });
      sel.value = cur;
      renderLibrary();
    } catch(e) { say('Could not load the shelf: ' + e.message); }
  }
  $('catFilter').onchange = renderLibrary;

  $('bookUploadBtn').onclick = async function(){
    var f = $('bookFile').files[0];
    if (!f) { say('Pick a book file first.'); return; }
    var btn = this; btn.disabled = true; say('Reading ' + f.name + '… this takes a few seconds.');
    try {
      var fd = new FormData(); fd.append('book', f); fd.append('grownUpsOnly', $('bookGrownUps').checked ? '1' : '0');
      var r = await fetch(API + '/upload', { method:'POST', headers:{ 'Authorization':'Bearer ' + token }, body: fd });
      var j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Upload failed');
      say('Added: ' + j.book.title + (j.book.author ? ' by ' + j.book.author : '') + '. ' + j.book.sections + ' sections, about ' + j.book.listen + '. ' + (j.skipped.length ? j.skipped.length + ' front-matter parts skipped.' : ''));
      $('bookFile').value = '';
      loadShelf();
    } catch(e) { say(e.message); }
    btn.disabled = false;
  };

  /* audio donation: create, then add parts (direct-to-storage, server fallback) */
  var auItem = null;
  function openTrackAdder(item){
    auItem = item;
    $('auTracks').classList.remove('hidden');
    $('auTracksHint').textContent = '"' + item.title + '" — ' + (item.tracks || 0) + ' part' + (item.tracks === 1 ? '' : 's') + ' so far.';
    $('auFile').focus();
    window.scrollTo(0, $('auTracks').offsetTop - 20);
  }
  $('auStartBtn').onclick = async function(){
    var title = $('auTitle').value.trim();
    if (!title) { say('Give the recording a title first.'); $('auTitle').focus(); return; }
    this.disabled = true;
    try {
      var j = await api('/media/new', { json: { title: title, author: $('auAuthor').value, year: $('auYear').value, category: $('auCategory').value, description: $('auDesc').value, grownUpsOnly: $('auGrownUps').checked } });
      say('Started. Now add the first part.');
      openTrackAdder(j.item);
    } catch(e) { say(e.message); }
    this.disabled = false;
  };
  async function putDirect(url, file, mime, onProgress){
    return new Promise(function(resolve, reject){
      var x = new XMLHttpRequest();
      x.open('PUT', url, true);
      x.setRequestHeader('Content-Type', mime);
      x.upload.onprogress = function(ev){ if (ev.lengthComputable && onProgress) onProgress(ev.loaded / ev.total); };
      x.onload = function(){ (x.status >= 200 && x.status < 300) ? resolve() : reject(new Error('storage answered ' + x.status)); };
      x.onerror = function(){ reject(new Error('direct upload blocked')); };
      x.send(file);
    });
  }
  function fileSeconds(file){
    return new Promise(function(resolve){
      try {
        var a = document.createElement('audio'); var u = URL.createObjectURL(file);
        a.preload = 'metadata';
        a.onloadedmetadata = function(){ resolve(isFinite(a.duration) ? a.duration : 0); URL.revokeObjectURL(u); };
        a.onerror = function(){ resolve(0); URL.revokeObjectURL(u); };
        a.src = u;
        setTimeout(function(){ resolve(0); }, 8000);
      } catch(e) { resolve(0); }
    });
  }
  $('auAddBtn').onclick = async function(){
    if (!auItem) return;
    var f = $('auFile').files[0];
    if (!f) { say('Pick an audio file first.'); return; }
    var btn = this; btn.disabled = true;
    var title = $('auTrackTitle').value.trim();
    try {
      var seconds = await fileSeconds(f);
      var lastPct = -1;
      var onProgress = function(p){ var pct = Math.round(p * 10) * 10; if (pct !== lastPct && pct % 20 === 0) { lastPct = pct; say('Uploading… ' + pct + ' percent.'); } };
      var done = null;
      try {
        var pre = await api('/media/' + auItem.id + '/track/presign', { json: { fileName: f.name, mime: f.type, bytes: f.size } });
        say('Uploading ' + f.name + ' straight to storage…');
        await putDirect(pre.url, f, pre.mime, onProgress);
        done = await api('/media/' + auItem.id + '/track/done', { json: { key: pre.key, title: title, bytes: f.size, seconds: seconds, originalName: f.name } });
      } catch(e) {
        if (f.size > 80 * 1024 * 1024) throw new Error('The direct upload did not go through and the file is over 80 MB. ' + e.message);
        say('Direct upload did not go through (' + e.message + '); sending it through the server instead…');
        var fd = new FormData(); fd.append('track', f); fd.append('title', title); fd.append('seconds', String(seconds));
        var r = await fetch(API + '/media/' + auItem.id + '/track/upload', { method:'POST', headers:{ 'Authorization':'Bearer ' + token }, body: fd });
        done = await r.json(); if (!r.ok) throw new Error(done.error || 'Upload failed');
      }
      auItem = done.item;
      var li = document.createElement('li'); li.textContent = (title || ('Part ' + auItem.tracks)) + ' — uploaded'; $('auTrackList').appendChild(li);
      $('auTracksHint').textContent = '"' + auItem.title + '" — ' + auItem.tracks + ' part' + (auItem.tracks === 1 ? '' : 's') + ' so far.';
      $('auFile').value = ''; $('auTrackTitle').value = '';
      say('Part ' + auItem.tracks + ' added to ' + auItem.title + '. Add another, or press Done.');
      loadShelf();
    } catch(e) { say(e.message); }
    btn.disabled = false;
  };
  $('auDoneBtn').onclick = function(){ $('auTracks').classList.add('hidden'); auItem = null; say('Back on your shelf. Open the item to play it, or put it in the library from its page.'); window.scrollTo(0, 0); $('h-mine').focus && $('h-mine').setAttribute('tabindex','-1'); $('h-mine').focus(); };

  /* ── player ────────────────────────────────────────────────────────── */
  var book = null, pos = { s: 0, c: 0 }, playing = false, voice = '', speed = 1;
  var ctx = null, gainNode = null, scheduled = [], nextStart = 0, cache = {}, fetching = {}, ended = false, playToken = 0;
  var fileAudio = $('fileAudio');
  var isAudio = function(){ return book && book.kind === 'audio'; };

  function chapterTitle(s){ var ch = isAudio() ? book.tracks[s] : book.chapters[s]; return ch ? ch.title : ''; }
  function announcePosition(prefix){
    var t = chapterTitle(pos.s);
    say((prefix ? prefix + ' ' : '') + (isAudio() ? 'Part ' : 'Chapter ') + (pos.s + 1) + ' of ' + (isAudio() ? book.tracks.length : book.chapters.length) + (t ? ': ' + t : ''));
  }
  var saveTimer = null;
  function saveProgress(now){
    clearTimeout(saveTimer);
    var body = { s: pos.s, c: pos.c, voice: voice, speed: speed };
    if (isAudio()) body.pos = fileAudio.currentTime || 0;
    var go = function(){ api('/book/' + book.id + '/progress', { json: body }).catch(function(){}); };
    if (now) go(); else saveTimer = setTimeout(go, 1500);
  }

  /* text books: Web Audio scheduling */
  function ensureCtx(){
    if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); gainNode = ctx.createGain(); gainNode.connect(ctx.destination); }
    if (ctx.state === 'suspended') ctx.resume();
  }
  function key(s, c){ return s + '/' + c; }
  function nextPos(p){ var ch = book.chapters[p.s]; if (!ch) return null; if (p.c + 1 < ch.chunks) return { s: p.s, c: p.c + 1 }; if (p.s + 1 < book.chapters.length) return { s: p.s + 1, c: 0 }; return null; }
  function prevPos(p){ if (p.c > 0) return { s: p.s, c: p.c - 1 }; if (p.s > 0) { var ch = book.chapters[p.s - 1]; return { s: p.s - 1, c: Math.max(0, ch.chunks - 1) }; } return null; }
  async function fetchChunk(p){
    var k = key(p.s, p.c);
    if (cache[k]) return cache[k];
    if (fetching[k]) return fetching[k];
    fetching[k] = (async function(){
      var r = await fetch(API + '/book/' + book.id + '/audio/' + p.s + '/' + p.c + '?voice=' + encodeURIComponent(voice) + '&speed=' + speed, { headers: { 'Authorization': 'Bearer ' + token } });
      if (r.status === 204) { cache[k] = { buffer: null, text: '' }; return cache[k]; }
      if (!r.ok) throw new Error('The voice did not answer (' + r.status + ').');
      var ab = await r.arrayBuffer();
      var buffer = await new Promise(function(res, rej){ ctx.decodeAudioData(ab, res, rej); });
      cache[k] = { buffer: buffer };
      var keys = Object.keys(cache); if (keys.length > 12) delete cache[keys[0]];
      return cache[k];
    })();
    try { return await fetching[k]; } finally { delete fetching[k]; }
  }
  async function showText(p){
    try { var j = await api('/book/' + book.id + '/text/' + p.s + '/' + p.c); $('nowText').textContent = j.text; } catch(e) {}
  }
  function stopScheduled(){
    playToken++;
    scheduled.forEach(function(src){ try { src.onended = null; src.stop(); } catch(e) {} });
    scheduled = []; nextStart = 0;
  }
  async function pump(myToken){
    // keep two chunks scheduled ahead of the one playing
    while (playing && myToken === playToken && scheduled.length < 3) {
      var target = scheduled.length ? scheduled[scheduled.length - 1]._pos : pos;
      var p = scheduled.length ? nextPos(target) : pos;
      if (!p) { ended = scheduled.length === 0; if (ended) finishBook(); return; }
      var got;
      try { got = await fetchChunk(p); } catch(e) { say(e.message + ' Press Play to try again.'); pause(); return; }
      if (myToken !== playToken) return;
      if (!got.buffer) { // unspeakable chunk (rare): skip it
        if (scheduled.length) { scheduled[scheduled.length - 1]._pos = p; } else { pos = p; }
        continue;
      }
      var src = ctx.createBufferSource(); src.buffer = got.buffer; src.connect(gainNode);
      var startAt = Math.max(ctx.currentTime + 0.05, nextStart || 0);
      src._pos = p; src._startAt = startAt;
      src.onended = (function(s){ return function(){
        if (myToken !== playToken) return;
        scheduled = scheduled.filter(function(x){ return x !== s; });
        var nxt = scheduled[0];
        if (nxt) { var changed = nxt._pos.s !== pos.s; pos = nxt._pos; showText(pos); saveProgress(); updateSession(); if (changed) announcePosition(''); }
        else if (!nextPos(s._pos)) { finishBook(); return; }
        pump(myToken);
      }; })(src);
      src.start(startAt);
      nextStart = startAt + got.buffer.duration + 0.12;
      scheduled.push(src);
      if (scheduled.length === 1 && p.s === pos.s && p.c === pos.c) { showText(pos); }
    }
  }
  function finishBook(){ playing = false; $('playBtn').textContent = 'Play'; say('The end. ' + book.title + ' is finished.'); api('/book/' + book.id + '/progress', { json: { s: pos.s, c: pos.c, finished: true } }).catch(function(){}); }
  function play(){
    if (!book) return;
    if (isAudio()) { fileAudio.play().then(function(){ playing = true; $('playBtn').textContent = 'Pause'; updateSession(); }).catch(function(e){ say('Could not play: ' + e.message); }); return; }
    ensureCtx();
    playing = true; ended = false; $('playBtn').textContent = 'Pause';
    stopScheduled();
    var t = playToken;
    pump(t);
    updateSession();
  }
  function pause(){
    playing = false; $('playBtn').textContent = 'Play';
    if (isAudio()) { fileAudio.pause(); saveProgress(true); updateSession(); return; }
    stopScheduled(); saveProgress(true); updateSession();
  }
  function seekTo(p, announce){
    if (isAudio()) { loadTrack(p.s, p.pos || 0, playing); if (announce) announcePosition(''); return; }
    var was = playing;
    stopScheduled(); playing = false;
    pos = { s: p.s, c: p.c };
    showText(pos); saveProgress();
    if (announce) announcePosition('');
    if (was) play();
    else fetchChunk(pos).catch(function(){});
  }
  function loadTrack(s, at, andPlay){
    var t = book.tracks[s]; if (!t) return;
    pos = { s: s, c: 0 };
    if (fileAudio.dataset.s !== String(s)) { fileAudio.src = t.url; fileAudio.dataset.s = String(s); fileAudio.load(); }
    var setTime = function(){ try { fileAudio.currentTime = at || 0; } catch(e) {} };
    if (fileAudio.readyState >= 1) setTime(); else fileAudio.addEventListener('loadedmetadata', setTime, { once: true });
    fileAudio.playbackRate = speed;
    $('nowText').textContent = t.title + (t.seconds ? ' — ' + clock(t.seconds) : '');
    saveProgress();
    if (andPlay) play();
  }
  function clock(sec){ sec = Math.floor(sec || 0); var m = Math.floor(sec / 60), s = sec % 60; var h = Math.floor(m / 60); m = m % 60; return (h ? h + ':' + String(m).padStart(2,'0') : m) + ':' + String(s).padStart(2,'0'); }
  fileAudio.addEventListener('ended', function(){ if (pos.s + 1 < book.tracks.length) { loadTrack(pos.s + 1, 0, true); announcePosition(''); } else finishBook(); });
  fileAudio.addEventListener('timeupdate', function(){ if (playing && Math.floor(fileAudio.currentTime) % 10 === 0) saveProgress(); });
  fileAudio.addEventListener('pause', function(){ if (playing && !fileAudio.ended) { playing = false; $('playBtn').textContent = 'Play'; } });

  function back(){ if (isAudio()) { fileAudio.currentTime = Math.max(0, fileAudio.currentTime - 15); say('Back 15 seconds.'); return; } var p = prevPos(pos); if (p) seekTo(p, false); else say('This is the beginning.'); }
  function forward(){ if (isAudio()) { fileAudio.currentTime = Math.min(fileAudio.duration || 1e9, fileAudio.currentTime + 15); say('Forward 15 seconds.'); return; } var p = nextPos(pos); if (p) seekTo(p, false); else say('This is the end.'); }
  function prevSection(){ var target = pos.s; if (isAudio() ? fileAudio.currentTime < 5 : pos.c === 0) target = pos.s - 1; if (target < 0) { say('This is the first chapter.'); return; } seekTo({ s: target, c: 0, pos: 0 }, true); }
  function nextSection(){ var n = pos.s + 1; var count = isAudio() ? book.tracks.length : book.chapters.length; if (n >= count) { say('This is the last chapter.'); return; } seekTo({ s: n, c: 0, pos: 0 }, true); }

  function updateSession(){
    if (!('mediaSession' in navigator) || !book) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: book.title, artist: book.author || (book.ownerName ? 'Donated by ' + book.ownerName : 'Kade-AI'), album: chapterTitle(pos.s) || 'The Reading Room' });
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    } catch(e) {}
  }
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', play);
      navigator.mediaSession.setActionHandler('pause', pause);
      navigator.mediaSession.setActionHandler('seekbackward', back);
      navigator.mediaSession.setActionHandler('seekforward', forward);
      navigator.mediaSession.setActionHandler('previoustrack', prevSection);
      navigator.mediaSession.setActionHandler('nexttrack', nextSection);
    } catch(e) {}
  }

  $('playBtn').onclick = function(){ playing ? pause() : play(); };
  $('backBtn').onclick = back; $('fwdBtn').onclick = forward;
  $('prevSecBtn').onclick = prevSection; $('nextSecBtn').onclick = nextSection;
  $('startBtn').onclick = function(){ seekTo({ s: 0, c: 0, pos: 0 }, true); };
  $('goChapterBtn').onclick = function(){ seekTo({ s: parseInt($('chapterSel').value, 10) || 0, c: 0, pos: 0 }, true); };
  $('markBtn').onclick = async function(){
    try {
      var j = await api('/book/' + book.id + '/bookmarks', { json: { s: pos.s, c: pos.c, pos: isAudio() ? fileAudio.currentTime : 0 } });
      book.bookmarks.unshift(j.bookmark); renderBookmarks();
      say('Bookmark placed at ' + (isAudio() ? 'part ' : 'chapter ') + (pos.s + 1) + (isAudio() ? ', ' + clock(fileAudio.currentTime) : '') + '.');
    } catch(e) { say(e.message); }
  };
  $('voiceSel').onchange = function(){ voice = this.value; cache = {}; var was = playing; if (was) { pause(); } saveProgress(true); say('Voice: ' + this.options[this.selectedIndex].text); if (was) play(); };
  $('speedSel').onchange = function(){ speed = parseFloat(this.value) || 1; if (isAudio()) fileAudio.playbackRate = speed; else { cache = {}; var was = playing; if (was) pause(); if (was) play(); } saveProgress(true); };
  document.addEventListener('keydown', function(ev){
    if (!book || $('player').classList.contains('hidden')) return;
    var tag = (ev.target && ev.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (ev.code === 'Space') { ev.preventDefault(); playing ? pause() : play(); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); ev.shiftKey ? prevSection() : back(); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); ev.shiftKey ? nextSection() : forward(); }
    else if (ev.key === 'b' || ev.key === 'B') { $('markBtn').click(); }
  });

  function renderBookmarks(){
    var ul = $('bookmarkList'); ul.innerHTML = '';
    if (!book.bookmarks.length) { ul.innerHTML = '<li class="muted">None yet.</li>'; return; }
    book.bookmarks.forEach(function(b){
      var li = document.createElement('li');
      var label = (isAudio() ? 'Part ' : 'Chapter ') + (b.s + 1) + (b.sectionTitle ? ', ' + b.sectionTitle : '') + (isAudio() ? ', ' + clock(b.pos) : '') + (b.snippet ? ' — "' + b.snippet + '"' : '');
      li.innerHTML = '<span class="t">' + esc(label) + '</span>';
      var go = document.createElement('button'); go.className = 'act'; go.type = 'button'; go.textContent = 'Go'; go.setAttribute('aria-label', 'Go to bookmark: ' + label);
      go.onclick = function(){ seekTo({ s: b.s, c: b.c, pos: b.pos }, true); };
      var rm = document.createElement('button'); rm.className = 'act quiet'; rm.type = 'button'; rm.textContent = 'Remove'; rm.setAttribute('aria-label', 'Remove bookmark: ' + label);
      rm.onclick = async function(){ try { await api('/book/' + book.id + '/bookmarks/' + b.id, { method: 'DELETE' }); book.bookmarks = book.bookmarks.filter(function(x){ return x.id !== b.id; }); renderBookmarks(); say('Bookmark removed.'); } catch(e) { say(e.message); } };
      li.appendChild(go); li.appendChild(rm); ul.appendChild(li);
    });
  }
  var skippedPlayer = null;
  function renderSkipped(){
    var ul = $('skippedList'); ul.innerHTML = '';
    if (isAudio() || !book.skipped.length) { $('skippedWrap').classList.add('hidden'); return; }
    $('skippedWrap').classList.remove('hidden');
    $('skippedSummary').textContent = 'Skipped parts (' + book.skipped.length + ')';
    book.skipped.forEach(function(sk){
      var li = document.createElement('li');
      var why = { 'bookshare-notice': 'Bookshare notice', copyright: 'copyright page', contents: 'contents list', publisher: 'publisher page', 'front-matter': 'front matter', 'back-matter': 'back matter' }[sk.reason] || sk.reason;
      li.innerHTML = '<span class="t">' + esc(sk.title) + ' <span class="muted">(' + esc(why) + ')</span></span>';
      var b = document.createElement('button'); b.className = 'act quiet'; b.type = 'button'; b.textContent = 'Play it';
      b.setAttribute('aria-label', 'Play the skipped part: ' + sk.title);
      b.onclick = async function(){
        pause(); ensureCtx();
        say('Reading the skipped part: ' + sk.title);
        for (var c = 0; c < sk.chunks; c++) {
          var r = await fetch(API + '/book/' + book.id + '/audio/' + sk.k + '/' + c + '?skipped=1&voice=' + encodeURIComponent(voice) + '&speed=' + speed, { headers: { 'Authorization': 'Bearer ' + token } });
          if (!r.ok) break;
          var buf = await new Promise(function(res, rej){ r.arrayBuffer().then(function(ab){ ctx.decodeAudioData(ab, res, rej); }).catch(rej); }).catch(function(){ return null; });
          if (!buf) continue;
          await new Promise(function(res){ var src = ctx.createBufferSource(); src.buffer = buf; src.connect(gainNode); src.onended = res; src.start(); skippedPlayer = src; });
          if (playing) break;
        }
      };
      li.appendChild(b); ul.appendChild(li);
    });
  }
  async function loadVoices(){
    var sel = $('voiceSel'); sel.innerHTML = '';
    try {
      var r = await fetch(TTS_BASE + '/voices.json'); var j = await r.json();
      var cats = j.categories || [];
      var hidden = j.hidden || [];
      var describe = j.describe || {};
      cats.forEach(function(c){
        var og = document.createElement('optgroup'); og.label = c.name;
        (c.voices || []).forEach(function(v){ if (hidden.indexOf(v) !== -1) return; var o = document.createElement('option'); o.value = v; o.textContent = describe[v] ? v + ' — ' + describe[v] : v; og.appendChild(o); });
        if (og.children.length) sel.appendChild(og);
      });
    } catch(e) {}
    if (!sel.options.length || ![].some.call(sel.options, function(o){ return o.value === voice; })) {
      var o = document.createElement('option'); o.value = voice; o.textContent = voice; sel.insertBefore(o, sel.firstChild);
    }
    sel.value = voice;
  }
  function renderOwner(){
    var ow = $('ownerWrap'); var bw = $('borrowWrap');
    if (book.mine) {
      ow.classList.remove('hidden'); bw.classList.add('hidden');
      $('shareBtn').textContent = book.shared ? 'Take it out of the library' : 'Put it in the library for everyone';
      $('grownBtn').textContent = book.grownUpsOnly ? 'Grown-ups only: on (tap to allow kids)' : 'Grown-ups only: off (tap to hide from kids)';
    } else { ow.classList.add('hidden'); bw.classList.remove('hidden'); }
  }
  $('shareBtn').onclick = async function(){ try { var j = await api('/book/' + book.id + '/share', { json: { shared: !book.shared } }); book.shared = j.book.shared; renderOwner(); say(book.shared ? 'It is in the library now. Everyone will see "Donated by ' + (book.ownerName || 'you') + '".' : 'Back on your private shelf.'); } catch(e) { say(e.message); } };
  $('grownBtn').onclick = async function(){ try { var j = await api('/book/' + book.id + '/share', { json: { grownUpsOnly: !book.grownUpsOnly } }); book.grownUpsOnly = j.book.grownUpsOnly; renderOwner(); say(book.grownUpsOnly ? 'Hidden from the kids.' : 'The kids can see it.'); } catch(e) { say(e.message); } };
  $('deleteBtn').onclick = async function(){ if (!confirm('Withdraw "' + book.title + '" from the Reading Room for everyone? This cannot be undone.')) return; try { pause(); await api('/book/' + book.id, { method: 'DELETE' }); location.search = ''; } catch(e) { say(e.message); } };
  $('returnBtn').onclick = async function(){ try { pause(); await api('/book/' + book.id + '/return', { method: 'POST' }); say('Returned. Your place in it is forgotten.'); location.search = ''; } catch(e) { say(e.message); } };
  $('backToShelf').onclick = function(){ pause(); location.search = ''; };
  window.addEventListener('pagehide', function(){ if (book) saveProgress(true); });

  async function openBook(id){
    try {
      book = await api('/book/' + id);
    } catch(e) { say('Could not open that: ' + e.message); location.search = ''; return; }
    $('shelf').classList.add('hidden'); $('player').classList.remove('hidden');
    $('pageTitle').textContent = 'The Reading Room';
    $('bookTitle').textContent = book.title;
    var bits = [];
    if (book.author) bits.push('by ' + book.author);
    if (book.kind === 'audio') bits.push(catName(book.category));
    if (book.listen) bits.push(book.listen);
    if (book.ownerName && !book.mine) bits.push('donated by ' + book.ownerName);
    $('bookMeta').textContent = bits.join(' · ');
    $('jacketLine').textContent = book.kind === 'audio' ? (book.description || '') : '';
    var sel = $('chapterSel'); sel.innerHTML = '';
    var list = isAudio() ? book.tracks : book.chapters;
    list.forEach(function(ch, i){ var o = document.createElement('option'); o.value = i; o.textContent = (i + 1) + '. ' + ch.title + (isAudio() && ch.seconds ? ' (' + clock(ch.seconds) + ')' : ''); sel.appendChild(o); });
    var p = book.progress || {};
    voice = p.voice || book.defaultVoice; speed = p.speed || 1;
    $('speedSel').value = String(speed);
    if (isAudio()) { $('voiceWrap').classList.add('hidden'); pos = { s: p.s || 0, c: 0 }; loadTrack(pos.s, p.pos || 0, false); }
    else { $('voiceWrap').classList.remove('hidden'); await loadVoices(); pos = { s: p.s || 0, c: p.c || 0 }; showText(pos); }
    sel.value = String(pos.s);
    sel.onchange = function(){ };
    renderBookmarks(); renderSkipped(); renderOwner(); updateSession();
    var resume = (pos.s || pos.c || p.pos) && !p.finished;
    say((resume ? 'Resuming ' : 'Opened ') + book.title + '. ' + (isAudio() ? 'Part ' : 'Chapter ') + (pos.s + 1) + ' of ' + list.length + (chapterTitle(pos.s) ? ': ' + chapterTitle(pos.s) : '') + '. Press Play.');
    $('playBtn').focus();
  }

  (async function(){
    token = await getToken();
    if (!token) { say('Please sign in first.'); location.href = '/login?redirect=' + encodeURIComponent(location.pathname + location.search); return; }
    var id = new URLSearchParams(location.search).get('book');
    if (id) openBook(id); else loadShelf();
  })();
})();
</script>
</body></html>`;

module.exports = { readingRoomHtml };
