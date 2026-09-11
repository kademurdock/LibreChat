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
 * TEXT BOOKS: each chunk is STREAMED as WAV from /audio/:s/:c and scheduled
 * on Web Audio as the bytes arrive (first words in under a second, gapless
 * between chunks, the next chunk fetched the moment this one has landed).
 * Back and Forward move a chunk (about half a minute); Previous/Next chapter
 * move a section.
 * AUDIO DONATIONS: a plain <audio> element on the signed B2 URL; Back and
 * Forward move 15 seconds; Previous/Next move a track.
 * Both wire the Media Session API so lock-screen and headphone buttons work.
 * -------------------------------------------------------------------------- */
const { SHARED_HEAD } = require('./kadePages');

const readingRoomHtml = `<!doctype html><html lang="en"><head><title>The Library — Kade-AI</title>${SHARED_HEAD}
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
  video.player { width:100%; max-height:60vh; background:#000; border-radius:14px; margin:.6rem 0; }
  video.player.audioonly { height:2px; min-height:0; opacity:0; margin:0; }
  nav.crumbs { display:flex; flex-wrap:wrap; gap:.3rem; align-items:center; margin:.4rem 0; }
  nav.crumbs button { font:inherit; background:none; border:none; color:#1d55d0; text-decoration:underline; cursor:pointer; padding:.2rem .1rem; }
  @media (prefers-color-scheme: dark) { nav.crumbs button { color:#93c5fd; } }
  ul.plain li.folder span.t { font-weight:600; }
  ol.scenes { padding-left:1.2rem; } ol.scenes li { margin:.3rem 0; }
  ol.scenes li.now { font-weight:700; }
  .pager { display:flex; gap:.5rem; align-items:center; margin:.5rem 0; }
</style></head>
<body>
  <p><a class="back" href="/home" aria-label="Back to Home">&larr; Home</a></p>
  <h1 id="pageTitle">The Library</h1>
  <p id="live" class="status" role="status" aria-live="polite"></p>

  <section id="shelf">
    <p class="muted">The family library: books read aloud by a voice you choose, the archive of television, commercials, tapes and radio, recordings and videos the family has donated, and playlists. Your shelf is yours; put something in the library and everyone can check it out.</p>

    <h2 id="h-search">Find something</h2>
    <div class="row">
      <label class="field" for="searchBox" style="margin:0">Search the library</label>
      <input type="text" id="searchBox" style="flex:1 1 14rem" placeholder="A title, a channel, a brand, a year…">
      <button class="act" id="searchBtn" type="button">Search</button>
    </div>
    <ul class="plain" id="searchList" aria-labelledby="h-search"></ul>

    <h2 id="h-archive">The archive</h2>
    <p class="hint">The family's television, commercials, tapes and radio, browsed the way the collection is filed. Open a folder, then a clip.</p>
    <nav class="crumbs" id="crumbs" aria-label="Where you are in the archive"></nav>
    <ul class="plain" id="archiveList" aria-labelledby="h-archive"><li class="muted">Loading…</li></ul>
    <div class="pager" id="archivePager" hidden><button class="act quiet" id="pagePrev" type="button">Previous page</button><span id="pageInfo"></span><button class="act quiet" id="pageNext" type="button">Next page</button></div>

    <h2 id="h-collections">Collections</h2>
    <p class="hint">Playlists you put together from anything in the library — yours until you share them.</p>
    <ul class="plain" id="collectionList" aria-labelledby="h-collections"><li class="muted">Loading…</li></ul>
    <div class="row"><input type="text" id="newCollTitle" style="flex:1 1 12rem" placeholder="New collection name" aria-label="New collection name"><button class="act" id="newCollBtn" type="button">Make it</button></div>

    <h2 id="h-mine">Your shelf (the Reading Room)</h2>
    <ul class="plain" id="mineList" aria-labelledby="h-mine"><li class="muted">Loading…</li></ul>

    <h2 id="h-borrowed">Checked out</h2>
    <ul class="plain" id="borrowedList" aria-labelledby="h-borrowed"><li class="muted">Nothing checked out yet.</li></ul>

    <h2 id="h-library">The library</h2>
    <div class="row" role="group" aria-label="Show only">
      <label class="field" for="catFilter" style="margin:0">Show</label>
      <select id="catFilter" style="width:auto"><option value="">Everything</option></select>
    </div>
    <ul class="plain" id="libraryList" aria-labelledby="h-library"><li class="muted">Loading…</li></ul>

    <h2 id="h-submit">Submit something for the library</h2>
    <div class="card">
      <p class="hint">Found a YouTube video, an archive.org recording, or anything else the family should have? Paste the link. The librarian looks at every submission and you are told when it is approved or declined. To submit a FILE, donate it below first (it lands on your shelf), then use "Submit this for the library" on its page.</p>
      <label class="field" for="subUrl">Link</label><input type="text" id="subUrl" placeholder="https://www.youtube.com/watch?v=…">
      <label class="field" for="subTitle">What is it (optional)</label><input type="text" id="subTitle" placeholder="KY3 commercials, 1994">
      <label class="field" for="subNote">Why it belongs (optional)</label><textarea id="subNote" rows="2"></textarea>
      <button class="act primary" id="subBtn" type="button">Submit for consideration</button>
    </div>
    <h2 id="h-mysubs">Your submissions</h2>
    <ul class="plain" id="mySubs" aria-labelledby="h-mysubs"><li class="muted">Loading…</li></ul>
    <section id="reviewWrap" hidden>
      <h2 id="h-review">Waiting for the librarian</h2>
      <p class="hint">You are the librarian. Approve a link and it is fetched into the collection from TubeVault's Cloud tab; approve a file and it goes into the library at once. The person who submitted it is told either way.</p>
      <ul class="plain" id="reviewList" aria-labelledby="h-review"></ul>
    </section>

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

  <section id="collection" class="hidden">
    <p><button class="act quiet" id="collBack" type="button">&larr; Back to the shelf</button></p>
    <h2 id="collTitle"></h2>
    <p class="meta" id="collMeta"></p>
    <div class="row"><button class="act primary" id="collPlayAll" type="button">Play all, in order</button><button class="act quiet" id="collShareBtn" type="button" hidden></button><button class="act quiet" id="collDeleteBtn" type="button" hidden>Delete this collection</button></div>
    <ol class="plain" id="collItems"></ol>
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
    <video id="fileMedia" class="player audioonly" controls playsinline preload="metadata" x-webkit-airplay="allow" aria-label="The recording"></video>
    <div class="row" id="castRow" hidden>
      <button class="act quiet" id="airplayBtn" type="button" hidden>AirPlay</button>
      <button class="act quiet" id="castBtn" type="button" hidden>Cast to a TV</button>
      <button class="act quiet" id="addCollBtn" type="button">Add to a collection</button>
    </div>
    <div class="now" id="nowText" aria-label="Now reading"></div>
    <details id="descWrap" hidden><summary id="descSummary">Video description</summary>
      <p class="hint" id="descHint">A described-video track written by the library's eyes: what is on screen, scene by scene. One run serves everyone.</p>
      <div class="row">
        <button class="act" id="descBtn" type="button">Describe this video</button>
        <button class="act quiet" id="descReadBtn" type="button" hidden>Read the description</button>
        <label class="field" style="margin:0" id="descModeWrap" hidden><input type="checkbox" id="descMode"> Play with descriptions (pauses to describe each scene)</label>
      </div>
      <p id="descStatus" class="hint"></p>
      <p id="descText"></p>
      <ol class="scenes" id="descScenes"></ol>
    </details>
    <details id="recapWrap" hidden><summary>What just happened?</summary>
      <p class="hint">Pauses the video and describes the last few minutes visually, so you can ask about it.</p>
      <div class="row">
        <label class="field" for="recapMins" style="margin:0">Last</label>
        <select id="recapMins" style="width:auto"><option value="2">2 minutes</option><option value="5" selected>5 minutes</option><option value="10">10 minutes</option><option value="20">20 minutes</option></select>
        <button class="act" id="recapBtn" type="button">Tell me what just happened</button>
      </div>
      <p id="recapStatus" class="hint"></p>
      <p id="recapText"></p>
      <ol class="scenes" id="recapScenes"></ol>
      <div class="row">
        <label class="field" for="askBox" style="margin:0">Ask</label>
        <input type="text" id="askBox" style="flex:1 1 14rem" placeholder="Who was the man in the hat? What did the sign say?">
        <button class="act" id="askBtn" type="button">Ask</button>
      </div>
      <p id="askAnswer"></p>
    </details>
    <details id="libWrap"><summary id="libSummary">The librarian's note</summary>
      <p class="hint">A short note the library's librarian digs up on the web about what this is, who made it and when. Honest about guesses.</p>
      <div class="row"><button class="act" id="libBtn" type="button">Ask the librarian to look this up</button><button class="act quiet" id="libReadBtn" type="button" hidden>Read the note</button></div>
      <p id="libStatus" class="hint"></p>
      <p id="libText"></p>
      <ul class="plain" id="libSources"></ul>
    </details>

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
        <button class="act quiet" id="submitItemBtn" type="button">Submit this for the library</button>
        <button class="act quiet" id="deleteBtn" type="button">Withdraw it from the room</button>
      </div>
    </details>
    <details id="borrowWrap" class="hidden"><summary>Checked out</summary>
      <button class="act quiet" id="returnBtn" type="button">Return it to the library</button>
    </details>

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
    if (where === 'archive') { var m = b.meta || {}; donor = [m.year, m.network || m.cableChannel || m.callSign, m.brand, m.market].filter(Boolean).map(esc).join(' · '); donor = donor ? ' · ' + donor : ''; if (b.described) donor += ' · described'; }
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

  /* search */
  async function doSearch(){
    var q = $('searchBox').value.trim(); var ul = $('searchList'); ul.innerHTML = '';
    if (!q) return;
    try {
      var j = await api('/search?q=' + encodeURIComponent(q));
      if (!j.items.length) { ul.innerHTML = '<li class="muted">Nothing matched.</li>'; say('Nothing matched ' + q + '.'); return; }
      j.items.forEach(function(b){ ul.appendChild(bookLi(b, b.path ? 'archive' : 'library')); });
      say(j.items.length + ' result' + (j.items.length === 1 ? '' : 's') + ' for ' + q + '.');
    } catch(e) { say(e.message); }
  }
  $('searchBtn').onclick = doSearch;
  $('searchBox').addEventListener('keydown', function(ev){ if (ev.key === 'Enter') { ev.preventDefault(); doSearch(); } });

  /* the archive */
  var archivePath = '', archivePage = 0;
  async function loadArchive(path, page){
    archivePath = path || ''; archivePage = page || 0;
    var ul = $('archiveList'); ul.innerHTML = '<li class="muted">Loading…</li>';
    try {
      var j = await api('/archive?path=' + encodeURIComponent(archivePath) + '&page=' + archivePage);
      var crumbs = $('crumbs'); crumbs.innerHTML = '';
      var home = document.createElement('button'); home.type = 'button'; home.textContent = 'Archive'; home.onclick = function(){ loadArchive('', 0); }; crumbs.appendChild(home);
      var parts = archivePath ? archivePath.split('/') : [];
      parts.forEach(function(seg, i){
        var sep = document.createElement('span'); sep.textContent = ' › '; sep.setAttribute('aria-hidden', 'true'); crumbs.appendChild(sep);
        var b = document.createElement('button'); b.type = 'button'; b.textContent = seg; var target = parts.slice(0, i + 1).join('/');
        if (i === parts.length - 1) { b.setAttribute('aria-current', 'location'); }
        b.onclick = function(){ loadArchive(target, 0); }; crumbs.appendChild(b);
      });
      ul.innerHTML = '';
      if (!j.folders.length && !j.items.length) { ul.innerHTML = '<li class="muted">' + (archivePath ? 'This folder is empty.' : 'Nothing has been pushed to the archive yet. On the PC, run "9 - PUSH TO LIBRARY" in the collection folder.') + '</li>'; }
      j.folders.forEach(function(f){
        var li = document.createElement('li'); li.className = 'folder';
        li.innerHTML = '<span class="t">📁 ' + esc(f.name) + ' <span class="muted">(' + f.count + ')</span></span>';
        var open = document.createElement('button'); open.className = 'act quiet'; open.type = 'button'; open.textContent = 'Open folder';
        open.setAttribute('aria-label', 'Open folder ' + f.name + ', ' + f.count + ' item' + (f.count === 1 ? '' : 's'));
        open.onclick = function(){ loadArchive(f.path, 0); };
        li.appendChild(open); ul.appendChild(li);
      });
      j.items.forEach(function(b){ ul.appendChild(bookLi(b, 'archive')); });
      var pages = Math.ceil(j.total / j.limit);
      $('archivePager').hidden = pages <= 1;
      $('pageInfo').textContent = 'Page ' + (j.page + 1) + ' of ' + pages + ' (' + j.total + ' clips here)';
      $('pagePrev').disabled = j.page <= 0; $('pageNext').disabled = j.page + 1 >= pages;
      if (path !== undefined) say((archivePath || 'The archive') + ': ' + j.folders.length + ' folder' + (j.folders.length === 1 ? '' : 's') + ', ' + j.total + ' clip' + (j.total === 1 ? '' : 's') + '.');
    } catch(e) { ul.innerHTML = '<li class="muted">' + esc(e.message) + '</li>'; }
  }
  $('pagePrev').onclick = function(){ loadArchive(archivePath, archivePage - 1); };
  $('pageNext').onclick = function(){ loadArchive(archivePath, archivePage + 1); };

  /* collections */
  var collections = { mine: [], shared: [] };
  async function loadCollections(){
    var ul = $('collectionList'); ul.innerHTML = '';
    try {
      collections = await api('/collections');
      var all = collections.mine.map(function(c){ c._mine = true; return c; }).concat(collections.shared);
      if (!all.length) { ul.innerHTML = '<li class="muted">No collections yet. Name one below, then use "Add to a collection" on anything you play.</li>'; return; }
      all.forEach(function(c){
        var li = document.createElement('li');
        li.innerHTML = '<span class="t book"><strong>' + esc(c.title) + '</strong><span class="meta">' + c.count + ' item' + (c.count === 1 ? '' : 's') + (c._mine ? (c.shared ? ' · shared' : ' · private') : ' · by ' + esc(c.ownerName)) + '</span></span>';
        var open = document.createElement('button'); open.className = 'act'; open.type = 'button'; open.textContent = 'Open'; open.setAttribute('aria-label', 'Open collection ' + c.title);
        open.onclick = function(){ location.search = '?collection=' + c.id; };
        li.appendChild(open); ul.appendChild(li);
      });
    } catch(e) { ul.innerHTML = '<li class="muted">' + esc(e.message) + '</li>'; }
  }
  /* submissions */
  function subLi(sb, review){
    var li = document.createElement('li');
    var what = esc(sb.title || sb.url || 'a file');
    var when = sb.createdAt ? new Date(sb.createdAt).toLocaleDateString() : '';
    var state = sb.status === 'pending' ? 'waiting' : sb.status;
    li.innerHTML = '<span class="t book"><strong>' + what + '</strong><span class="meta">' + (review ? 'from ' + esc(sb.userName) + ' · ' : '') + esc(state) + (when ? ' · ' + when : '') + (sb.url ? ' · <a href="' + esc(sb.url) + '" target="_blank" rel="noopener">open the link</a>' : '') + (sb.note ? ' · ' + esc(sb.note) : '') + (sb.decisionNote ? ' · librarian: ' + esc(sb.decisionNote) : '') + (sb.fetchedAt ? ' · fetched' : '') + '</span></span>';
    if (review && sb.status === 'pending') {
      var ok = document.createElement('button'); ok.className = 'act primary'; ok.type = 'button'; ok.textContent = 'Approve'; ok.setAttribute('aria-label', 'Approve ' + (sb.title || sb.url || 'this file'));
      ok.onclick = async function(){ var note = prompt('A word for ' + sb.userName + '? (optional)') || ''; try { await api('/submissions/' + sb.id + '/decide', { json: { status: 'approved', note: note } }); say('Approved.'); loadSubmissions(); } catch(e) { say(e.message); } };
      var no = document.createElement('button'); no.className = 'act quiet'; no.type = 'button'; no.textContent = 'Decline'; no.setAttribute('aria-label', 'Decline ' + (sb.title || sb.url || 'this file'));
      no.onclick = async function(){ var note = prompt('Tell ' + sb.userName + ' why? (optional)') || ''; try { await api('/submissions/' + sb.id + '/decide', { json: { status: 'rejected', note: note } }); say('Declined.'); loadSubmissions(); } catch(e) { say(e.message); } };
      li.appendChild(ok); li.appendChild(no);
    } else if (!review && sb.status === 'pending') {
      var rm = document.createElement('button'); rm.className = 'act quiet'; rm.type = 'button'; rm.textContent = 'Withdraw'; rm.setAttribute('aria-label', 'Withdraw ' + (sb.title || sb.url || 'this submission'));
      rm.onclick = async function(){ try { await api('/submissions/' + sb.id, { method: 'DELETE' }); say('Withdrawn.'); loadSubmissions(); } catch(e) { say(e.message); } };
      li.appendChild(rm);
    }
    if (sb.book) { var open = document.createElement('button'); open.className = 'act quiet'; open.type = 'button'; open.textContent = 'Open the file'; open.onclick = function(){ location.search = '?book=' + sb.book; }; li.appendChild(open); }
    return li;
  }
  async function loadSubmissions(){
    try {
      var mine = await api('/submissions?all=0'); var ul = $('mySubs'); ul.innerHTML = '';
      if (!mine.submissions.length) ul.innerHTML = '<li class="muted">Nothing submitted yet.</li>';
      mine.submissions.forEach(function(sb){ ul.appendChild(subLi(sb, false)); });
      if (mine.librarian) {
        var all = await api('/submissions?status=pending'); var rl = $('reviewList'); rl.innerHTML = '';
        $('reviewWrap').hidden = false;
        if (!all.submissions.length) rl.innerHTML = '<li class="muted">Nothing waiting.</li>';
        all.submissions.forEach(function(sb){ rl.appendChild(subLi(sb, true)); });
      }
    } catch(e) { $('mySubs').innerHTML = '<li class="muted">' + esc(e.message) + '</li>'; }
  }
  $('subBtn').onclick = async function(){
    var url = $('subUrl').value.trim(); if (!url) { say('Paste a link first.'); $('subUrl').focus(); return; }
    try { await api('/submissions', { json: { url: url, title: $('subTitle').value, note: $('subNote').value } }); $('subUrl').value = ''; $('subTitle').value = ''; $('subNote').value = ''; say('Submitted. The librarian will look at it and you will be told.'); loadSubmissions(); } catch(e) { say(e.message); }
  };
  $('submitItemBtn').onclick = async function(){
    if (!book) return;
    var note = prompt('Anything the librarian should know about "' + book.title + '"? (optional)'); if (note === null) return;
    try { await api('/submissions', { json: { book: book.id, title: book.title, note: note } }); say('Submitted for the library. You will be told when it is approved.'); } catch(e) { say(e.message); }
  };

  $('newCollBtn').onclick = async function(){
    var t = $('newCollTitle').value.trim(); if (!t) { say('Give the collection a name first.'); return; }
    try { await api('/collections', { json: { title: t } }); $('newCollTitle').value = ''; say('Made ' + t + '.'); loadCollections(); } catch(e) { say(e.message); }
  };
  async function openCollection(id){
    try {
      var c = await api('/collections/' + id);
      $('shelf').classList.add('hidden'); $('collection').classList.remove('hidden');
      $('collTitle').textContent = c.title;
      $('collMeta').textContent = c.items.length + ' item' + (c.items.length === 1 ? '' : 's') + (c.mine ? (c.shared ? ' · shared with the family' : ' · private') : ' · by ' + c.ownerName) + (c.description ? ' · ' + c.description : '');
      var ol = $('collItems'); ol.innerHTML = '';
      c.items.forEach(function(it, i){
        var li = document.createElement('li');
        li.innerHTML = '<span class="t book"><strong>' + (i + 1) + '. ' + esc(it.title) + '</strong><span class="meta">' + esc((it.book.author ? it.book.author + ' · ' : '') + catName(it.book.kind === 'text' ? 'book' : it.book.category) + (it.seconds ? ' · ' + clock(it.seconds) : '')) + '</span></span>';
        var play = document.createElement('button'); play.className = 'act'; play.type = 'button'; play.textContent = 'Play'; play.setAttribute('aria-label', 'Play ' + it.title);
        play.onclick = function(){ queue = c.items.slice(i + 1).map(function(x){ return x.book.id; }); location.search = '?book=' + it.book.id + '&track=' + it.track + '&q=' + encodeURIComponent(queue.join(',')); };
        li.appendChild(play);
        if (c.mine) { var rm = document.createElement('button'); rm.className = 'act quiet'; rm.type = 'button'; rm.textContent = 'Remove'; rm.setAttribute('aria-label', 'Remove ' + it.title + ' from this collection'); rm.onclick = async function(){ try { await api('/collections/' + id + '/edit', { json: { remove: it.n } }); say('Removed.'); openCollection(id); } catch(e) { say(e.message); } }; li.appendChild(rm); }
        ol.appendChild(li);
      });
      $('collPlayAll').onclick = function(){ if (!c.items.length) { say('It is empty.'); return; } $('collItems').querySelector('button').click(); };
      $('collShareBtn').hidden = !c.mine; $('collDeleteBtn').hidden = !c.mine;
      $('collShareBtn').textContent = c.shared ? 'Make it private' : 'Share it with the family';
      $('collShareBtn').onclick = async function(){ try { await api('/collections/' + id + '/edit', { json: { shared: !c.shared } }); openCollection(id); say(c.shared ? 'Private now.' : 'Shared with the family.'); } catch(e) { say(e.message); } };
      $('collDeleteBtn').onclick = async function(){ if (!confirm('Delete the collection "' + c.title + '"? The items themselves stay in the library.')) return; try { await api('/collections/' + id, { method: 'DELETE' }); location.search = ''; } catch(e) { say(e.message); } };
      say('Collection ' + c.title + ', ' + c.items.length + ' items.');
    } catch(e) { say(e.message); location.search = ''; }
  }
  $('collBack').onclick = function(){ location.search = ''; };
  $('addCollBtn').onclick = async function(){
    if (!book) return;
    try {
      if (!collections.mine.length) collections = await api('/collections');
      var names = collections.mine.map(function(c, i){ return (i + 1) + '. ' + c.title; });
      var pick = prompt('Add "' + book.title + '" to which collection?\\n' + (names.length ? names.join('\\n') + '\\nType a number, or a new name to make one.' : 'You have none yet — type a name to make one.'));
      if (pick == null || !pick.trim()) return;
      var n = parseInt(pick, 10); var target = (n >= 1 && collections.mine[n - 1]) ? collections.mine[n - 1] : null;
      if (!target) { var made = await api('/collections', { json: { title: pick.trim() } }); target = made.collection; }
      await api('/collections/' + target.id + '/items', { json: { book: book.id, track: pos.s } });
      say('Added to ' + target.title + '.');
    } catch(e) { say(e.message); }
  };

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
  var fileAudio = $('fileMedia');
  var isAudio = function(){ return book && book.kind !== 'text'; };
  var isVideoTrack = function(){ return book && book.tracks && book.tracks[pos.s] && /^video\\//.test(book.tracks[pos.s].mime || ''); };
  var queue = []; // collection playback: item ids still to play
  var autoplayNext = false;

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

  /* text books: STREAMED Web Audio scheduling.
   * The proxy streams a chunk's WAV as Inworld speaks it (~2x real time), so
   * waiting for the whole file meant ~14 s before the first word. Instead the
   * bytes are read as they arrive, turned into ~0.4 s AudioBuffers and
   * scheduled back to back; the next chunk's fetch starts the moment this one
   * has fully arrived (lookahead capped at ~60 s of audio). A marker at each
   * chunk's scheduled end advances the position, saves progress and announces
   * a chapter change. Pause stops every scheduled source and cancels the
   * stream; Play restarts from the position. */
  function ensureCtx(){
    if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); gainNode = ctx.createGain(); gainNode.connect(ctx.destination); }
    if (ctx.state === 'suspended') ctx.resume();
  }
  function nextPos(p){ var ch = book.chapters[p.s]; if (!ch) return null; if (p.c + 1 < ch.chunks) return { s: p.s, c: p.c + 1 }; if (p.s + 1 < book.chapters.length) return { s: p.s + 1, c: 0 }; return null; }
  function prevPos(p){ if (p.c > 0) return { s: p.s, c: p.c - 1 }; if (p.s > 0) { var ch = book.chapters[p.s - 1]; return { s: p.s - 1, c: Math.max(0, ch.chunks - 1) }; } return null; }
  async function showText(p){
    try { var j = await api('/book/' + book.id + '/text/' + p.s + '/' + p.c); if (p.s === pos.s && p.c === pos.c) $('nowText').textContent = j.text; } catch(e) {}
  }
  var pipe = null; // { nextStart, sources[], markers[] }
  function parseWavHeader(u8){
    if (u8.length < 12) return null;
    if (!(u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8[8] === 0x57 && u8[9] === 0x41 && u8[10] === 0x56 && u8[11] === 0x45)) return { bad: true };
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var off = 12, fmt = null;
    while (off + 8 <= u8.length) {
      var id = String.fromCharCode(u8[off], u8[off+1], u8[off+2], u8[off+3]);
      var size = dv.getUint32(off + 4, true);
      var body = off + 8;
      if (id === 'fmt ') {
        if (body + 16 > u8.length) return null;
        fmt = { channels: dv.getUint16(body + 2, true), sampleRate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
        off = body + size + (size % 2);
      } else if (id === 'data') {
        if (!fmt) return { bad: true };
        return { fmt: fmt, pcmStart: body };
      } else { off = body + size + (size % 2); }
    }
    return null;
  }
  function concatU8(a, b){ if (!a.length) return b; var o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }
  function schedulePcm(bytes, fmt){
    var bpf = fmt.channels * (fmt.bits / 8);
    var frames = Math.floor(bytes.length / bpf);
    if (frames <= 0) return;
    var ab = ctx.createBuffer(1, frames, fmt.sampleRate);
    var d = ab.getChannelData(0);
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (var f = 0; f < frames; f++) {
      var sum = 0;
      for (var ch = 0; ch < fmt.channels; ch++) {
        var i = (f * fmt.channels + ch) * (fmt.bits / 8);
        sum += fmt.bits === 16 ? dv.getInt16(i, true) / 32768 : (bytes[i] - 128) / 128;
      }
      d[f] = sum / fmt.channels;
    }
    var src = ctx.createBufferSource(); src.buffer = ab; src.connect(gainNode);
    var at = Math.max(ctx.currentTime + 0.02, pipe.nextStart || 0);
    src.start(at);
    pipe.nextStart = at + ab.duration;
    pipe.sources.push(src);
    src.onended = function(){ var i = pipe ? pipe.sources.indexOf(src) : -1; if (i !== -1) pipe.sources.splice(i, 1); };
  }
  async function streamChunk(p, token){
    var r = await fetch(API + '/book/' + book.id + '/audio/' + p.s + '/' + p.c + '?voice=' + encodeURIComponent(voice) + '&speed=' + speed, { headers: { 'Authorization': 'Bearer ' + token_() } });
    if (token !== playToken) return { cancelled: true };
    if (r.status === 204) return { skip: true };
    if (!r.ok) throw new Error('The voice did not answer (' + r.status + ').');
    var reader = r.body.getReader();
    var buf = new Uint8Array(0), fmt = null, any = false;
    while (true) {
      var step = await reader.read();
      if (token !== playToken) { try { reader.cancel(); } catch(e) {} return { cancelled: true }; }
      if (step.value) buf = concatU8(buf, step.value);
      if (!fmt) {
        var h = parseWavHeader(buf);
        if (h && h.bad) throw new Error('The voice sent something that is not audio.');
        if (!h) { if (step.done) break; continue; }
        fmt = h.fmt; buf = buf.subarray(h.pcmStart);
      }
      var bpf = fmt.channels * (fmt.bits / 8);
      var usable = buf.length - (buf.length % bpf);
      if (usable > 0 && (usable >= fmt.sampleRate * 0.4 * bpf || step.done)) { schedulePcm(buf.subarray(0, usable), fmt); buf = buf.subarray(usable); any = true; }
      if (step.done) break;
    }
    return { played: any };
  }
  function token_(){ return token; }
  async function runPipeline(myToken){
    ensureCtx();
    pipe = { nextStart: ctx.currentTime + 0.05, sources: [], markers: [] };
    var p = pos;
    while (p && myToken === playToken && playing) {
      // lookahead: do not fetch further than ~60 s ahead of what is playing
      while (pipe.nextStart - ctx.currentTime > 60 && myToken === playToken && playing) { await new Promise(function(res){ setTimeout(res, 500); }); }
      if (myToken !== playToken || !playing) return;
      var r;
      try { r = await streamChunk(p, myToken); } catch(e) { if (myToken === playToken) { say(e.message + ' Press Play to try again.'); pause(); } return; }
      if (r.cancelled) return;
      var n = nextPos(p);
      if (!r.skip) pipe.markers.push({ at: pipe.nextStart, pos: n, end: !n });
      else if (!n) pipe.markers.push({ at: pipe.nextStart, pos: null, end: true });
      p = n;
    }
  }
  setInterval(function(){
    if (!pipe || !playing || !ctx) return;
    while (pipe.markers.length && ctx.currentTime >= pipe.markers[0].at) {
      var m = pipe.markers.shift();
      if (m.end) { finishBook(); return; }
      if (m.pos) { var changed = m.pos.s !== pos.s; pos = m.pos; showText(pos); saveProgress(); updateSession(); if (changed) announcePosition(''); }
    }
  }, 200);
  function stopScheduled(){
    playToken++;
    if (pipe) { pipe.sources.forEach(function(src){ try { src.onended = null; src.stop(); } catch(e) {} }); }
    pipe = null;
  }
  function finishBook(){ stopScheduled(); playing = false; $('playBtn').textContent = 'Play'; say('The end. ' + book.title + ' is finished.'); api('/book/' + book.id + '/progress', { json: { s: pos.s, c: pos.c, finished: true } }).catch(function(){}); }
  function play(){
    if (!book) return;
    if (isAudio()) { fileAudio.play().then(function(){ playing = true; $('playBtn').textContent = 'Pause'; updateSession(); }).catch(function(e){ say('Could not play: ' + e.message); }); return; }
    ensureCtx();
    stopScheduled();
    playing = true; ended = false; $('playBtn').textContent = 'Pause';
    var t = playToken;
    showText(pos);
    runPipeline(t);
    updateSession();
  }
  function pause(){
    playing = false; $('playBtn').textContent = 'Play';
    if (descAudio) { try { descAudio.pause(); } catch(e) {} descAudio = null; descPausedFor = null; }
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
  }
  function loadTrack(s, at, andPlay){
    var t = book.tracks[s]; if (!t) return;
    pos = { s: s, c: 0 };
    if (fileAudio.dataset.s !== String(s)) { fileAudio.src = t.url; fileAudio.dataset.s = String(s); fileAudio.load(); }
    var setTime = function(){ try { fileAudio.currentTime = at || 0; } catch(e) {} };
    if (fileAudio.readyState >= 1) setTime(); else fileAudio.addEventListener('loadedmetadata', setTime, { once: true });
    fileAudio.playbackRate = speed;
    $('nowText').textContent = t.title + (t.seconds ? ' — ' + clock(t.seconds) : '');
    fileAudio.classList.toggle('audioonly', !/^video\\//.test(t.mime || ''));
    $('castRow').hidden = false;
    $('airplayBtn').hidden = !(window.WebKitPlaybackTargetAvailabilityEvent && fileAudio.webkitShowPlaybackTargetPicker);
    $('castBtn').hidden = !(fileAudio.remote && fileAudio.remote.prompt);
    renderDescription();
    $('recapWrap').hidden = !/^video\\//.test(t.mime || '');
    saveProgress();
    if (andPlay) play();
  }
  $('airplayBtn').onclick = function(){ try { fileAudio.webkitShowPlaybackTargetPicker(); } catch(e) { say('AirPlay is not available here.'); } };
  $('castBtn').onclick = function(){ try { fileAudio.remote.prompt().catch(function(e){ say('No TV to cast to was found.'); }); } catch(e) { say('Casting is not available here.'); } };
  function clock(sec){ sec = Math.floor(sec || 0); var m = Math.floor(sec / 60), s = sec % 60; var h = Math.floor(m / 60); m = m % 60; return (h ? h + ':' + String(m).padStart(2,'0') : m) + ':' + String(s).padStart(2,'0'); }
  fileAudio.addEventListener('ended', function(){
    if (descPausedFor) return;
    if (pos.s + 1 < book.tracks.length) { loadTrack(pos.s + 1, 0, true); announcePosition(''); }
    else if (queue.length) { var nextId = queue.shift(); say('Next in the collection.'); autoplayNext = true; try { history.replaceState(null, '', '?book=' + nextId + (queue.length ? '&q=' + queue.join(',') : '')); } catch(e) {} openBook(nextId); }
    else finishBook();
  });
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
  /* the library's eyes */
  var descPausedFor = null, descTimer = null, descSpoken = {}, descAudio = null;
  function renderDescription(){
    var t = book && book.tracks && book.tracks[pos.s];
    var wrap = $('descWrap');
    if (!t || !/^video\\//.test(t.mime || '')) { wrap.hidden = true; return; }
    wrap.hidden = false;
    var d = t.description;
    $('descScenes').innerHTML = ''; $('descText').textContent = ''; descSpoken = {};
    if (d && d.state === 'done') {
      $('descSummary').textContent = 'Video description (' + d.scenes.length + ' scenes)';
      $('descBtn').textContent = 'Describe it again'; $('descReadBtn').hidden = false; $('descModeWrap').hidden = false;
      $('descStatus').textContent = 'Described ' + (d.at ? new Date(d.at).toLocaleDateString() : '') + (d.costUSD ? ' for ' + money(d.costUSD) : '') + '.';
      $('descText').textContent = d.summary;
      d.scenes.forEach(function(sc, i){
        var li = document.createElement('li'); li.id = 'scene-' + i;
        li.innerHTML = '<span>' + esc(clock(sc.t)) + ' — ' + esc(sc.text) + '</span> ';
        var go = document.createElement('button'); go.className = 'act quiet'; go.type = 'button'; go.textContent = 'Go'; go.setAttribute('aria-label', 'Go to ' + clock(sc.t));
        go.onclick = function(){ fileAudio.currentTime = sc.t; play(); };
        li.appendChild(go); $('descScenes').appendChild(li);
      });
    } else if (d && d.state === 'working') {
      $('descSummary').textContent = 'Video description (working…)'; $('descStatus').textContent = 'Describing… this takes a few minutes for a long video.'; $('descBtn').textContent = 'Working…'; pollDescription();
    } else {
      $('descSummary').textContent = 'Video description'; $('descBtn').textContent = 'Describe this video'; $('descReadBtn').hidden = true; $('descModeWrap').hidden = true;
      $('descStatus').textContent = d && d.state === 'failed' ? 'The last try failed: ' + (d.error || 'unknown') : '';
    }
  }
  async function pollDescription(){
    clearTimeout(descTimer);
    try {
      var j = await api('/book/' + book.id + '/describe/' + pos.s);
      if (j.state === 'working') { $('descStatus').textContent = 'Describing… ' + (j.progress || ''); descTimer = setTimeout(pollDescription, 6000); return; }
      book.tracks[pos.s].description = j.description; renderDescription();
      if (j.state === 'done') say('The description is ready: ' + j.description.scenes.length + ' scenes.');
      else if (j.state === 'failed') say('The description failed: ' + (j.description && j.description.error));
    } catch(e) { descTimer = setTimeout(pollDescription, 10000); }
  }
  $('descBtn').onclick = async function(){
    if (!book) return;
    try {
      var est = await api('/book/' + book.id + '/describe/' + pos.s + '/estimate');
      if (!est.enabled) { say('Video descriptions are switched off on this server.'); return; }
      var mins = Math.round(est.seconds / 60);
      if (!confirm('Describe "' + book.tracks[pos.s].title + '"' + (est.hasSeconds ? ' (about ' + (mins || 1) + ' minute' + (mins === 1 ? '' : 's') + ')' : '') + '?\\nEstimated cost about ' + money(est.usd) + '. It takes a few minutes; the result is kept for everyone.')) return;
      var r = await api('/book/' + book.id + '/describe/' + pos.s + (book.tracks[pos.s].description && book.tracks[pos.s].description.state === 'done' ? '?again=1' : ''), { method: 'POST' });
      book.tracks[pos.s].description = { state: r.state === 'done' ? 'done' : 'working' };
      if (r.description) book.tracks[pos.s].description = r.description;
      renderDescription();
      say(r.state === 'done' ? 'Already described.' : 'Describing. I will say when it is ready.');
    } catch(e) { say(e.message); }
  };
  async function speak(text){
    return new Promise(async function(resolve){
      try {
        var r = await fetch('/api/files/speech/tts/manual', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ input: text, voice: voice || undefined }) });
        if (!r.ok) throw new Error('tts ' + r.status);
        var blob = await r.blob(); var url = URL.createObjectURL(blob);
        descAudio = new Audio(url); descAudio.onended = function(){ URL.revokeObjectURL(url); resolve(); }; descAudio.onerror = function(){ resolve(); };
        descAudio.play().catch(function(){ resolve(); });
      } catch(e) {
        try { var u = new SpeechSynthesisUtterance(text); u.onend = resolve; u.onerror = resolve; speechSynthesis.speak(u); } catch(e2) { resolve(); }
      }
    });
  }
  $('descReadBtn').onclick = async function(){
    var d = book && book.tracks[pos.s] && book.tracks[pos.s].description; if (!d || d.state !== 'done') return;
    pause(); say('Reading the description.');
    await speak(d.summary || 'No summary.');
    for (var i = 0; i < d.scenes.length; i++) { if (playing) break; await speak('At ' + clock(d.scenes[i].t) + '. ' + d.scenes[i].text); }
  };
  fileAudio.addEventListener('timeupdate', function(){
    if (!$('descMode').checked || descPausedFor || !book) return;
    var d = book.tracks[pos.s] && book.tracks[pos.s].description; if (!d || d.state !== 'done') return;
    var t = fileAudio.currentTime;
    for (var i = 0; i < d.scenes.length; i++) {
      var sc = d.scenes[i];
      if (!descSpoken[i] && t >= sc.t && t < sc.t + 1.5) {
        descSpoken[i] = true; descPausedFor = i;
        fileAudio.pause();
        var li = document.getElementById('scene-' + i); if (li) { [].forEach.call($('descScenes').children, function(x){ x.classList.remove('now'); }); li.classList.add('now'); }
        speak(sc.text).then(function(){ descPausedFor = null; if (playing) fileAudio.play().catch(function(){}); });
        break;
      }
    }
  });
  fileAudio.addEventListener('seeking', function(){ descSpoken = {}; var t = fileAudio.currentTime; var d = book && book.tracks[pos.s] && book.tracks[pos.s].description; if (d && d.scenes) d.scenes.forEach(function(sc, i){ if (sc.t < t - 1) descSpoken[i] = true; }); });
  $('descMode').onchange = function(){ say(this.checked ? 'Descriptions on: the video pauses to describe each scene.' : 'Descriptions off.'); };

  /* what just happened? */
  var recapTimer = null, lastRecap = null;
  function showRecap(r){
    lastRecap = r;
    $('recapText').textContent = r.summary || '';
    var ol = $('recapScenes'); ol.innerHTML = '';
    (r.scenes || []).forEach(function(sc){ var li = document.createElement('li'); li.textContent = clock(sc.t) + ' — ' + sc.text; ol.appendChild(li); });
    $('recapStatus').textContent = 'From ' + clock(r.from) + ' to ' + clock(r.to) + '.';
  }
  $('recapBtn').onclick = async function(){
    if (!book || !isVideoTrack()) return;
    var to = fileAudio.currentTime || 0; var mins = parseInt($('recapMins').value, 10) || 5;
    if (to < 20) { say('Play a little first — there is nothing to recap yet.'); return; }
    pause(); $('recapStatus').textContent = 'Looking back over the last ' + mins + ' minutes…'; say('Looking back over the last ' + mins + ' minutes. This takes a minute or two.');
    try {
      var r = await api('/book/' + book.id + '/recap/' + pos.s, { json: { to: to, minutes: mins } });
      if (r.state === 'done') { showRecap(r.recap); speak(r.recap.summary); return; }
      var from = r.from;
      var poll = async function(){
        try {
          var j = await api('/book/' + book.id + '/recap/' + pos.s + '?from=' + from + '&to=' + to);
          if (j.state === 'done' && j.recap) { showRecap(j.recap); say('Here is what happened.'); speak(j.recap.summary + ' ' + (j.recap.scenes || []).map(function(sc){ return sc.text; }).join(' ')); return; }
          $('recapStatus').textContent = 'Working… ' + (j.progress || '');
          recapTimer = setTimeout(poll, 6000);
        } catch(e) { $('recapStatus').textContent = e.message; }
      };
      recapTimer = setTimeout(poll, 8000);
    } catch(e) { say(e.message); $('recapStatus').textContent = e.message; }
  };
  $('askBtn').onclick = async function(){
    var q = $('askBox').value.trim(); if (!q || !book) return;
    try {
      $('askAnswer').textContent = 'Thinking…';
      var r = await api('/book/' + book.id + '/ask/' + pos.s, { json: { question: q, to: lastRecap ? lastRecap.to : (fileAudio.currentTime || 0), from: lastRecap ? lastRecap.from : 0 } });
      $('askAnswer').textContent = r.answer; say(r.answer); speak(r.answer);
    } catch(e) { $('askAnswer').textContent = e.message; say(e.message); }
  };
  $('askBox').addEventListener('keydown', function(ev){ if (ev.key === 'Enter') { ev.preventDefault(); $('askBtn').click(); } });

  /* the librarian */
  var libTimer = null;
  function renderLibrarian(){
    var l = book && book.librarian;
    $('libText').textContent = ''; $('libSources').innerHTML = ''; $('libReadBtn').hidden = true;
    if (l && l.state === 'done') {
      $('libSummary').textContent = 'The librarian\\'s note' + (l.identified ? ': ' + l.identified : '');
      $('libStatus').textContent = 'Confidence: ' + (l.confidence || 'low') + '.'; $('libText').textContent = l.note; $('libReadBtn').hidden = false; $('libBtn').textContent = 'Look it up again';
      (l.sources || []).forEach(function(src){ var li = document.createElement('li'); var a = document.createElement('a'); a.href = src.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = src.title || src.url; li.appendChild(a); $('libSources').appendChild(li); });
    } else if (l && l.state === 'working') { $('libStatus').textContent = 'The librarian is looking…'; libTimer = setTimeout(pollLibrarian, 6000); }
    else { $('libSummary').textContent = 'The librarian\\'s note'; $('libStatus').textContent = l && l.state === 'failed' ? 'The last try failed: ' + (l.error || '') : ''; $('libBtn').textContent = 'Ask the librarian to look this up'; }
  }
  async function pollLibrarian(){
    clearTimeout(libTimer);
    try { var j = await api('/book/' + book.id + '/librarian'); book.librarian = j.librarian; renderLibrarian(); if (j.librarian && j.librarian.state === 'done') say('The librarian has a note.'); else if (j.librarian && j.librarian.state === 'working') libTimer = setTimeout(pollLibrarian, 6000); } catch(e) {}
  }
  $('libBtn').onclick = async function(){
    if (!book) return;
    try { var again = book.librarian && book.librarian.state === 'done' ? '?again=1' : ''; var j = await api('/book/' + book.id + '/librarian' + again, { method: 'POST' }); book.librarian = j.librarian; renderLibrarian(); if (j.librarian.state !== 'done') say('The librarian is looking it up.'); } catch(e) { say(e.message); }
  };
  $('libReadBtn').onclick = function(){ if (book && book.librarian) { pause(); speak(book.librarian.note); } };

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
    $('pageTitle').textContent = 'The Library';
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
    var wantTrack = parseInt(new URLSearchParams(location.search).get('track'), 10);
    if (isAudio()) { $('voiceWrap').classList.add('hidden'); pos = { s: Number.isInteger(wantTrack) ? wantTrack : (p.s || 0), c: 0 }; loadTrack(pos.s, Number.isInteger(wantTrack) ? 0 : (p.pos || 0), autoplayNext); autoplayNext = false; }
    else { $('voiceWrap').classList.remove('hidden'); await loadVoices(); pos = { s: p.s || 0, c: p.c || 0 }; showText(pos); }
    sel.value = String(pos.s);
    sel.onchange = function(){ };
    renderBookmarks(); renderSkipped(); renderOwner(); renderLibrarian(); updateSession();
    var resume = (pos.s || pos.c || p.pos) && !p.finished;
    say((resume ? 'Resuming ' : 'Opened ') + book.title + '. ' + (isAudio() ? 'Part ' : 'Chapter ') + (pos.s + 1) + ' of ' + list.length + (chapterTitle(pos.s) ? ': ' + chapterTitle(pos.s) : '') + '. Press Play.');
    $('playBtn').focus();
  }

  (async function(){
    token = await getToken();
    if (!token) { say('Please sign in first.'); location.href = '/login?redirect=' + encodeURIComponent(location.pathname + location.search); return; }
    var qs = new URLSearchParams(location.search);
    var id = qs.get('book'); var coll = qs.get('collection');
    if (qs.get('q')) queue = qs.get('q').split(',').filter(Boolean);
    if (id) openBook(id); else if (coll) openCollection(coll); else { loadShelf(); loadArchive(undefined, 0); loadCollections(); loadSubmissions(); }
  })();
})();
</script>
</body></html>`;

module.exports = { readingRoomHtml };
