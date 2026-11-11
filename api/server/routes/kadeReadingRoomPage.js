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

/* PICTURES (Sep 25 2026 art batch: plan Pictures 44 and 50, plus the old
 * reading-alcove banner). Her rule: a picture's words are real alt text on
 * the <img> itself, read in the picture's own place, and nothing more: no
 * aria-hidden, no extra heading, no live region, no focus stop, no sound, no
 * motion. Each alt is the blind-checked sentence in client/public/assets/art/
 * art-manifest.json, word for word (kadeArtManifest.nodetest.js holds them
 * together). A picture with no source yet, one that failed to load, and one a
 * screen hides are all display:none, so a screen reader never meets a missing
 * picture. Shelf crops are 16:9 so everything an alt names stays in the
 * frame. All art ships in client/public/assets/art (inside dist) and is
 * linked as /assets/art/<file>. */
const ALCOVE_ART = {
  src: '/assets/library/reading-alcove.webp',
  alt: 'A cozy reading room at dusk: dark blue bookshelves holding books, film reels and a cassette radio, a lit lamp, a green armchair with an orange pillow and knit throw, and a window onto a lake at sunset.',
};
const SHELF_ART = {
  radio: {
    file: 'shelf-radio',
    alt: 'An old wooden cathedral radio glowing on a kitchen table with a red checked runner, beside an enamel coffee pot, a mug, daisies and an oil lamp, with a full moon over the lake outside.',
  },
  music: {
    file: 'shelf-music',
    alt: 'A cabin music corner at dusk: a fiddle, a banjo and a mandolin hang above a record player and two crates of records, with a fringed lamp, a rocking chair and a lake sunset through the window.',
  },
};
const ART_DIR = '/assets/art/';
/* When a picture steps aside: contrast settings, a narrow or zoomed window
 * (em-based, so a larger default text size trips it sooner), short landscape
 * phones, and data saving. The CSS hides the picture box under this query and
 * the script never starts a download while it matches. Data Saver
 * (navigator.connection.saveData) and very large default text (root font size
 * over 20px) are checked by the tiny head script, which marks <html> with
 * kade-art-off before the body is laid out. A picture that steps aside is
 * silent on that screen; where it shows, its alt is read in its place. */
const ART_HIDDEN_WHEN = '(forced-colors: active), (prefers-contrast: more), (max-width: 22.5em), (max-height: 30em), (prefers-reduced-data: reduce)';
const ART_OFF_SCRIPT = "(function(){try{var d=document.documentElement,c=navigator.connection,off=!!(c&&c.saveData);if(parseFloat(getComputedStyle(d).fontSize)>20)off=true;if(off)d.classList.add('kade-art-off')}catch(e){}})();";

/* THE LIBRARY'S PAGES (Nov 10 2026 redesign). /library is a short front desk; each row opens its
 * own small page at /library/<name>. All of them are this one document: the address picks which
 * blocks show. Old addresses keep landing in the right place: ?book= is an item, ?collection= a
 * playlist, ?request= or #libraryRequests the requests page, and a search or folder written on
 * the bare /library address opens the search or the folders. */
const LIBRARY_VIEWS = ['continue', 'local', 'search', 'folders', 'playlists', 'family', 'requests', 'add', 'librarian'];
const VIEW_SCRIPT = "function kadeLibraryView(loc){var q=new URLSearchParams(loc.search);if(q.get('book'))return 'item';if(q.get('collection'))return 'playlist';var name=loc.pathname.split('/').filter(Boolean)[1]||'';if(" + JSON.stringify(LIBRARY_VIEWS) + ".indexOf(name)!==-1)return name;if(q.get('request')||loc.hash==='#libraryRequests')return 'requests';if(q.has('folder'))return 'folders';if(['q','kind','type','decade','under','page','sort','scope'].some(function(k){return q.has(k);}))return 'search';return 'desk';}";
const VIEW_CSS = ['desk', ...LIBRARY_VIEWS].map((view) => `html[data-view="${view}"] [data-views]:not([data-views~="${view}"])`).join(', ') + ', html[data-view="item"] [data-views], html[data-view="playlist"] [data-views] { display:none !important; }';

const readingRoomHtml = `<!doctype html><html lang="en"><head><title>The Library — Kade-AI</title>${SHARED_HEAD}
<style>
  .hidden { display:none !important; }
  .row { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
  button.act, a.act { font:inherit; font-weight:700; padding:.8rem 1.1rem; border-radius:12px; border:1px solid #1d55d0; background:#fff; color:#1d55d0; cursor:pointer; min-height:48px; }
  a.act { display:inline-block; text-decoration:none; }
  button.act.primary, a.act.primary { background:#1f7a49; border-color:#1f7a49; color:#fff; }
  button.act.quiet, a.act.quiet { border-color:#7d8490; color:inherit; font-weight:600; }
  button.act.big { font-size:1.25rem; padding:1rem 1.4rem; min-width:9rem; }
  button.act[disabled] { opacity:.55; cursor:default; }
  button.act:focus-visible, a.act:focus-visible, select:focus-visible, input:focus-visible { outline:3px solid #ffbf47; outline-offset:2px; }
  .controls { display:grid; grid-template-columns:1fr 1fr 1fr; gap:.5rem; margin:.8rem 0; }
  .controls .wide { grid-column:1 / -1; }
  label.field { display:block; font-weight:600; margin:.7rem 0 .25rem; }
  select, input[type=text], input[type=file], textarea { width:100%; font:inherit; padding:.6rem .7rem; border-radius:10px; border:1px solid #6b7280; background:#fff; color:inherit; }
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
  summary { cursor:pointer; font-weight:600; padding:.65rem 0; min-height:44px; }
  /* The ring on borderless things (box rows, crumbs, focused headings) is dark on the light page and yellow on the dark one, so it shows on both. */
  summary:focus-visible, nav.crumbs button:focus-visible, a.skip:focus, [tabindex="-1"]:focus-visible { outline:3px solid #1d55d0; outline-offset:2px; }
  /* Nov 10 2026. The skip link is off screen until it has focus, then it is a real button-sized link.
     It goes straight to the Results heading; the next Tab is the first result. The search form is
     the first thing after the page title, the local start-here buttons sit under the results, and
     nothing else stands between, so the first result is at most the 11th Tab stop even without it. */
  a.skip { position:absolute; left:-999rem; top:0; }
  a.skip:focus { position:static; display:inline-block; padding:.7rem 1rem; margin:0 0 .5rem; border-radius:12px; background:#1d55d0; color:#fff; font-weight:700; }
  /* The one status line. It keeps its place in the page (so nothing jumps and a screen reader
     finds it where it always was), shows no empty yellow strip, and for a few seconds after it
     changes it stays in view at the top of the window, so a sighted person far down the page
     sees the same words a screen reader says. */
  #live { min-height:3rem; margin:.6rem 0; }
  #live:empty { background:transparent; }
  #live.fresh { position:sticky; top:calc(.5rem + env(safe-area-inset-top, 0px)); z-index:55; box-shadow:0 4px 14px rgba(0,0,0,.28); pointer-events:none; }
  /* While it is held at the top of a scrolled window it shows two lines at most, so it never grows past
     the room the page leaves for it (scroll-padding-top) and never covers the thing focus just moved to.
     All of its words stay in the page for a screen reader. With very large text it does not stick at all. */
  #live.fresh.held { max-height:4.5rem; overflow:hidden; }
  html.kade-art-off #live.fresh { position:static; box-shadow:none; max-height:none; }
  html { scroll-padding-top:5rem; }
  input[type=checkbox] { width:1.25rem; height:1.25rem; vertical-align:-.2rem; margin-right:.35rem; }
  #timeLine { font-variant-numeric:tabular-nums; font-weight:600; margin:.4rem 0; }
  /* Nov 10 2026 (redesign): the player. Large, plainly worded controls; a state line that says in
     words what the player is doing (plain text, never spoken by itself); one labelled position
     slider for audio and video alike. */
  #player .controls button.act { min-height:56px; font-size:1.05rem; }
  #playState { font-weight:700; margin:.5rem 0 .2rem; }
  #seekBar { display:block; width:100%; height:44px; margin:0; padding:0; accent-color:#1d55d0; }
  #seekBar:focus-visible { outline:3px solid #1d55d0; outline-offset:2px; }
  .pager span { font-weight:600; }
  h2.results { font-size:1.05rem; margin:1rem 0 .2rem; }
  /* Nov 10 2026 (redesign): one page of markup, many small pages. Each block says which pages it
     belongs to; the head script names the page before anything is drawn, so nothing flashes. */
  ${VIEW_CSS}
  /* A feature that is part of the Family feature pack is always there, marked in words and with a
     dashed edge (never by colour alone), not hidden. */
  a.hubitem.locked { border-style:dashed; }
  a.hubitem .tag { display:inline-block; margin-top:.3rem; padding:.1rem .5rem; border:1px solid currentColor; border-radius:999px; font-size:.82rem; font-weight:700; }
  ul.plain li a.shelf { flex:1 1 12rem; font-weight:700; padding:.75rem .2rem; min-height:44px; display:inline-flex; align-items:center; color:#1d55d0; }
  @media (prefers-color-scheme: dark) { ul.plain li a.shelf { color:#93c5fd; } }
  a.hubitem:focus-visible, ul.plain li a.shelf:focus-visible { outline:3px solid #1d55d0; outline-offset:2px; }
  @media (prefers-color-scheme: dark) { a.hubitem:focus-visible, ul.plain li a.shelf:focus-visible { outline-color:#ffbf47; } }
  @media (prefers-color-scheme: dark) {
    button.act, a.act { background:#1e2127; color:#9ec2ff; border-color:#4a78d8; }
    button.act.primary, a.act.primary { background:#1f7a49; color:#fff; border-color:#1f7a49; }
    select, input[type=text], input[type=file], textarea, .now { background:#1e2127; color:inherit; border-color:#2c2f37; }
    select, input[type=text], input[type=file], textarea { border-color:#8a919c; }
    #live { background:#3a3206; color:#ffe9a8; }
    #live:empty { background:transparent; }
    #seekBar { accent-color:#8fbcff; }
    #seekBar:focus-visible { outline-color:#ffbf47; }
    summary:focus-visible, nav.crumbs button:focus-visible, a.skip:focus, [tabindex="-1"]:focus-visible { outline-color:#ffbf47; }
  }
  @media (max-width: 480px) { .controls { grid-template-columns:1fr 1fr; } }
  video.player { width:100%; max-height:60vh; background:#000; border-radius:14px; margin:.6rem 0; }
  video.player.audioonly { height:2px; min-height:0; opacity:0; margin:0; }
  nav.crumbs { display:flex; flex-wrap:wrap; gap:.3rem; align-items:center; margin:.4rem 0; }
  nav.crumbs button { font:inherit; background:none; border:none; color:#1d55d0; text-decoration:underline; cursor:pointer; padding:.6rem .35rem; min-height:44px; }
  @media (prefers-color-scheme: dark) { nav.crumbs button { color:#93c5fd; } }
  ul.plain li.folder span.t { font-weight:600; }
  ol.scenes { padding-left:1.2rem; } ol.scenes li { margin:.3rem 0; }
  ol.scenes li.now { font-weight:700; }
  .pager { display:flex; gap:.5rem; align-items:center; margin:.5rem 0; }
  .kade-art { display:block; position:relative; overflow:hidden; border-radius:18px; background:linear-gradient(160deg,#1c2640,#33304a 55%,#5a4330); pointer-events:none; -webkit-user-select:none; user-select:none; -webkit-touch-callout:none; }
  .kade-art img { position:absolute; top:0; left:0; width:100%; height:100%; object-fit:cover; display:block; color:transparent; }
  .kade-art.art-failed img, .kade-art img:not([src]) { display:none; }
  .kade-art[hidden] { display:none !important; }
  .alcove-art { width:100%; aspect-ratio:1440 / 481; max-height:220px; margin:0 0 .6rem; }
  .shelf-art { width:100%; max-width:392px; width:min(100%, calc(min(220px, 25vh) * 16 / 9)); aspect-ratio:16 / 9; margin:.8rem auto .3rem; }
  @media ${ART_HIDDEN_WHEN} { .kade-art { display:none !important; } }
  .kade-art-off .kade-art { display:none !important; }
  /* Depth for the paintings (Oct 2 2026): each one sits in a shallow window,
     a fine warm edge along the top and its corners falling into shadow, and
     on the reading-alcove banner the lamp's light spills warm over the room.
     Still layers drawn by CSS over the picture: no words, no focus, nothing
     new for a screen reader (the img's alt is read as before), no motion.
     They appear only over a picture that has loaded (art-shown), so a missing
     one keeps its plain gradient, and step aside under Reduce Transparency. */
  .kade-art { box-shadow:0 10px 26px rgba(14,18,44,.22); }
  .kade-art::before, .kade-art::after { content:""; position:absolute; top:0; right:0; bottom:0; left:0; z-index:1; border-radius:inherit; pointer-events:none; display:none; }
  .kade-art.art-shown::after { display:block; background:radial-gradient(ellipse 120% 112% at 50% 40%, rgba(8,10,26,0) 58%, rgba(8,10,26,.42) 100%), linear-gradient(180deg, rgba(255,228,186,.10), rgba(255,228,186,0) 16%, rgba(6,8,20,0) 76%, rgba(6,8,20,.32)); box-shadow:inset 0 0 0 1px rgba(255,238,210,.16), inset 0 2px 0 rgba(255,238,210,.18), inset 0 -14px 26px -14px rgba(0,0,0,.5); }
  .alcove-art.art-shown::before { display:block; mix-blend-mode:screen; background:radial-gradient(ellipse 30% 82% at 67.5% 22%, rgba(255,186,104,.48), rgba(255,170,90,.16) 42%, rgba(255,170,90,0) 70%); }
  @media (prefers-reduced-transparency: reduce) { .kade-art::before, .kade-art::after { display:none !important; } }
</style>
<script>${ART_OFF_SCRIPT}</script>
<script>${VIEW_SCRIPT}try{document.documentElement.setAttribute('data-view',kadeLibraryView(location))}catch(e){}</script></head>
<body>
  <a class="skip" href="#h-results" id="skipLink" hidden>Skip to results</a>
  <p><a class="back" href="/home" id="backLink" aria-label="Back to Home">&larr; Home</a></p>
  <main id="main">
  <h1 id="pageTitle" tabindex="-1">The Library</h1>
  <p id="familyLibraryNotice" hidden>Your own uploads are here. The family's shared collection is part of the Family feature pack, which Kade turns on for family members. Ask Kade if you should have it.</p>
  <p id="live" class="status" role="status" aria-live="polite"></p>

  <section id="shelf">
    <!-- THE FRONT DESK (Nov 10 2026 redesign): the phone's map. A short list of rows; each opens its
         own small page with its own address and title. The catalogue only loads when it is asked for. -->
    <div data-views="desk continue">
    <section id="continueBox" hidden>
      <h2 id="h-continue">Pick up where you left off</h2>
      <ul class="plain" id="continueList" aria-labelledby="h-continue"></ul>
    </section>
    </div>
    <div data-views="desk">
    <h2 id="h-desk">Around the Library</h2>
    <nav class="hublist" id="deskNav" aria-labelledby="h-desk">
      <a class="hubitem" href="/library/continue" id="row-continue" aria-label="Continue and your shelf" aria-describedby="rowhint-continue"><span class="hicon" aria-hidden="true">🔖</span><span><strong>Continue and your shelf</strong><small id="rowhint-continue">Everything you have opened or uploaded, and where you left off in each.</small></span></a>
      <a class="hubitem" href="/library/local" id="row-local" aria-label="Springfield and the Ozarks" aria-describedby="rowhint-local"><span class="hicon" aria-hidden="true">📍</span><span><strong>Springfield and the Ozarks</strong><small id="rowhint-local">Local television and radio, hometown businesses and Missouri memories.</small></span></a>
      <a class="hubitem" href="/library/search" id="row-search" aria-label="Browse and search" aria-describedby="rowhint-search"><span class="hicon" aria-hidden="true">🔍</span><span><strong>Browse and search</strong><small id="rowhint-search">Search the whole collection, or narrow it by format, type and decade.</small></span></a>
      <a class="hubitem" href="/library/folders" id="row-folders" aria-label="Folders" aria-describedby="rowhint-folders"><span class="hicon" aria-hidden="true">📁</span><span><strong>Folders</strong><small id="rowhint-folders">Walk the shelves: Videos, Audio and Books, then the category, then the decade.</small></span></a>
      <a class="hubitem" href="/library/playlists" id="row-playlists" aria-label="Playlists" aria-describedby="rowhint-playlists"><span class="hicon" aria-hidden="true">🎵</span><span><strong>Playlists</strong><small id="rowhint-playlists">Collections you put together from anything in the library.</small></span></a>
      <a class="hubitem" href="/library/family" id="row-family" aria-label="Family shelves" aria-describedby="rowhint-family"><span class="hicon" aria-hidden="true">👪</span><span><strong>Family shelves</strong><small id="rowhint-family">The family&#39;s shared collection and the family history.</small></span></a>
      <a class="hubitem" href="/library/requests" id="row-requests" aria-label="Requests" aria-describedby="rowhint-requests"><span class="hicon" aria-hidden="true">✉️</span><span><strong>Requests</strong><small id="rowhint-requests">Ask for something for the library, or send in a link you found.</small></span></a>
      <a class="hubitem" href="/library/add" id="row-add" aria-label="Add to the Library" aria-describedby="rowhint-add"><span class="hicon" aria-hidden="true">➕</span><span><strong>Add to the Library</strong><small id="rowhint-add">Donate a book, a recording or a video.</small></span></a>
      <a class="hubitem" href="${require('@librechat/api').librarianGuide.chatUrl}" id="row-librarian" aria-label="Talk to the Librarian" aria-describedby="rowhint-librarian"><span class="hicon" aria-hidden="true">🦉</span><span><strong>Talk to the Librarian</strong><small id="rowhint-librarian">Mrs. Witherspoon finds books, shows and tapes on the shelves for you.</small></span></a>
      <a class="hubitem" href="/library/librarian" id="row-desk" aria-label="The librarian&#39;s desk" aria-describedby="rowhint-desk" hidden><span class="hicon" aria-hidden="true">🗂️</span><span><strong>The librarian&#39;s desk</strong><small id="rowhint-desk">Submissions waiting for you, the sorting, and who has the family library.</small></span></a>
    </nav>
    <div class="kade-art alcove-art"><img id="alcoveArt" alt="${ALCOVE_ART.alt}" width="1440" height="481" loading="lazy" decoding="async" draggable="false"></div>
    <p class="muted">The family library: books read aloud by a voice you choose, the archive of television, commercials, tapes and radio, recordings and videos the family has donated, and playlists. Your uploads stay yours. Shared items are available to members with the Family feature pack.</p>
    </div>

    <div data-views="continue">
    <h2 id="h-mine" tabindex="-1">Your shelf</h2>
    <p class="hint">Everything you have donated and everything you have opened, together. Removing something from your shelf never removes it from the library.</p>
    <div id="mineList"><p class="muted">Loading…</p></div>
    <ul class="plain hidden" id="borrowedList"></ul>
    </div>

    <div data-views="local">
    <p class="hint">Start here for home. Each row opens the real shelf, where the folders go by kind and then by decade.</p>
    <nav class="hublist" id="localNav" aria-labelledby="pageTitle">
      <a class="hubitem" href="/library/folders?folder=Videos%2FOzarks%20(Springfield%20Area)"><span class="hicon" aria-hidden="true">📺</span><span><strong>Local television</strong><small>Springfield stations: local news, local commercials, station sign-offs, weather and sports, by kind and then by decade.</small></span></a>
      <a class="hubitem" href="/library/folders?folder=Audio%2FOzarks%20(Springfield%20Area)"><span class="hicon" aria-hidden="true">📻</span><span><strong>Local radio and audio</strong><small>Springfield and Ozarks radio, airchecks and tapes.</small></span></a>
      <a class="hubitem" href="/library/folders?folder=Videos%2FMissouri"><span class="hicon" aria-hidden="true">🗺️</span><span><strong>Missouri</strong><small>St. Louis, Kansas City, Jefferson City and the rest of the state.</small></span></a>
      <a class="hubitem" href="/library/search?q=Springfield"><span class="hicon" aria-hidden="true">🔍</span><span><strong>Everything that mentions Springfield</strong><small>A search of the whole collection for Springfield, newest first.</small></span></a>
    </nav>
    <h2 id="h-elsewhere">From everywhere</h2>
    <nav class="hublist" aria-labelledby="h-elsewhere">
      <a class="hubitem" href="/library/folders?folder=Videos%2FCommercials"><span class="hicon" aria-hidden="true">🛒</span><span><strong>Commercials by subject</strong><small>Ads from everywhere, shelved by what they sell.</small></span></a>
      <a class="hubitem" href="/library/folders?folder=Videos%2FTV%20Shows"><span class="hicon" aria-hidden="true">📼</span><span><strong>TV shows and familiar bumpers</strong><small>Shows, promos and the bits between them.</small></span></a>
      <a class="hubitem" href="/library/folders?folder=Audio"><span class="hicon" aria-hidden="true">🎧</span><span><strong>Radio, tapes and audio</strong><small>Everything to listen to.</small></span></a>
    </nav>
    </div>

    <div data-views="search">
    <p class="hint">One shelf for books, newspapers, recordings and videos. Choose a type or decade, or search across the collection.</p>
    <form id="browseForm" role="search" aria-label="Search and filter the library">
      <label class="field" for="searchBox">Search the library</label>
      <div class="row"><input type="text" id="searchBox" style="flex:1 1 14rem" placeholder="A title, a place, a brand, a year…"><button class="act" id="searchBtn" type="submit">Search</button></div>
      <div class="controls">
        <div><label class="field" for="libraryScope">Collection</label><select id="libraryScope"><option value="public">Family library</option><option value="mine">Your uploads</option></select></div>
        <div><label class="field" for="browseKind">Format</label><select id="browseKind"><option value="">All formats</option><option value="text">Text</option><option value="audio">Audio</option><option value="video">Video</option></select></div>
        <div><label class="field" for="browseType">Type</label><select id="browseType"><option value="">All types</option></select></div>
        <div><label class="field" for="browseDecade">Decade</label><select id="browseDecade"><option value="">All decades</option></select></div>
        <div><label class="field" for="browseSort">Order</label><select id="browseSort"><option value="recent">Recently added</option><option value="title">Title</option></select></div>
        <div style="align-self:end"><button class="act quiet" id="browseClear" type="button">Clear filters</button></div>
      </div>
      <input id="browsePath" type="hidden" value="">
    </form>
    <p id="browseLocation" hidden><span id="browseLocationName"></span> <button class="act quiet" id="browsePathClear" type="button">All subjects</button></p>
    <h2 id="h-results" class="results" tabindex="-1">Results</h2>
    <p id="browseCount" class="hint">Loading…</p>
    <ul class="plain" id="browseList" aria-labelledby="h-results"></ul>
    <nav class="pager" id="browsePager" aria-label="Result pages" hidden><button class="act quiet" id="browsePrev" type="button">Previous page</button><span id="browsePageInfo"></span><button class="act quiet" id="browseNext" type="button">Next page</button></nav>
    <label class="field"><input type="checkbox" id="shortRows"> Short rows: leave the folder line off every result</label>
    </div>

    <div data-views="folders">
    <div><label class="field" for="folderScope">Collection</label><select id="folderScope" style="width:auto"><option value="public">Family library</option><option value="mine">Your uploads</option></select></div>
    <div class="kade-art shelf-art" id="shelfArtBox" hidden><img id="shelfArt" alt="" width="1152" height="648" loading="lazy" fetchpriority="low" decoding="async" draggable="false"></div>
    <nav class="crumbs" id="crumbs" aria-label="Where you are in the archive"></nav>
    <ul class="plain" id="archiveList" aria-labelledby="pageTitle"><li class="muted">Loading…</li></ul>
    <div class="pager" id="archivePager" hidden><button class="act quiet" id="pagePrev" type="button">Previous page</button><span id="pageInfo"></span><button class="act quiet" id="pageNext" type="button">Next page</button></div>
    </div>

    <div data-views="playlists">
    <p class="hint">Playlists (collections) you put together from anything in the library — yours until you share them.</p>
    <ul class="plain" id="collectionList" aria-labelledby="pageTitle"><li class="muted">Loading…</li></ul>
    <div class="row"><input type="text" id="newCollTitle" style="flex:1 1 12rem" placeholder="New collection name" aria-label="New collection name"><button class="act" id="newCollBtn" type="button">Make it</button></div>
    </div>

    <div data-views="family">
    <p class="muted" id="familyBlurb">The shelves the family shares: the archive of television, commercials, tapes and radio, the books, and what family members have donated. Pick a shelf to walk its folders.</p>
    <ul class="plain" id="familyList" aria-labelledby="pageTitle"></ul>
    <p><a class="act quiet" id="familyHistoryLink" href="/family-history" hidden>Family history, photos and records</a></p>
    </div>

    <div data-views="requests">
    <section id="libraryRequests" aria-labelledby="requestsHeading" hidden>
      <h2 id="requestsHeading" tabindex="-1">Library requests</h2>
      <p>Ask for any book, recording, video or anything else for the family library, even if you only remember a little about it. You can also just tell Mrs. Witherspoon. The library owner reviews every request, and you get an alert with a link when yours is filled. Only you and the library owner see your requests.</p>
      <p id="requestSummary"></p>
      <details id="requestFormWrap"><summary>Make a request</summary>
        <form id="requestForm">
          <label class="field" for="requestTitle">Title, or a few words about it</label><input id="requestTitle" type="text" maxlength="240" autocomplete="off">
          <label class="field" for="requestMedia">Kind of media or format (optional)</label><input id="requestMedia" type="text" maxlength="60" autocomplete="off" aria-describedby="requestMediaHint">
          <p class="hint" id="requestMediaHint">For example: book, audiobook, radio show, commercial, movie or music.</p>
          <label class="field" for="requestClues">What do you remember? (optional)</label><textarea id="requestClues" rows="4" maxlength="4000"></textarea>
          <button id="requestSubmit" class="act primary" type="submit">Save request</button>
        </form>
      </details>
      <div id="requestScopeWrap" hidden><label class="field" for="requestScope">Show</label><select id="requestScope"><option value="open">Everyone's open requests</option><option value="all">Everyone's requests</option><option value="mine">My requests</option></select></div>
      <h3 id="requestListHeading">Your requests</h3>
      <ul class="plain" id="requestList" aria-labelledby="requestListHeading"></ul>
      <button id="requestMore" class="act quiet" type="button" hidden>More requests</button>
      <section id="requestDetail" aria-labelledby="requestDetailHeading" hidden></section>
    </section>
    <p id="requestsLink" hidden>You can also ask Mrs. Witherspoon to save a library request from whatever you remember. <a href="${require('@librechat/api').librarianGuide.chatUrl}">Talk to the Librarian</a></p>
    <h2 id="h-submit">Submit something for the library</h2>
    <div class="card">
      <p class="hint">Found a YouTube video, an archive.org recording, or anything else the family should have? Paste the link. The librarian looks at every submission and you are told when it is approved or declined. To submit a FILE, add it on the <a href="/library/add">Add to the Library</a> page first (it lands on your shelf), then use "Submit this for the library" on its page.</p>
      <label class="field" for="subUrl">Link</label><input type="text" id="subUrl" placeholder="https://www.youtube.com/watch?v=…">
      <label class="field" for="subTitle">What is it (optional)</label><input type="text" id="subTitle" placeholder="KY3 commercials, 1994">
      <label class="field" for="subNote">Why it belongs (optional)</label><textarea id="subNote" rows="2"></textarea>
      <button class="act primary" id="subBtn" type="button">Submit for consideration</button>
    </div>
    <h2 id="h-mysubs" tabindex="-1">Your submissions</h2>
    <ul class="plain" id="mySubs" aria-labelledby="h-mysubs"><li class="muted">Loading…</li></ul>
    </div>

    <div data-views="librarian">
    <p id="reviewNo" hidden>This page is the librarian's desk. Only the librarian's account can use it. <a href="/library">Back to the Library</a></p>
    <section id="reviewWrap" hidden>
      <h2 id="h-sort">The librarian's sorting</h2>
      <p class="hint" id="sortStatus">Books arrive without folders; the librarian files them under Books and a shelf (Romance, Urban fiction, Humor and jokes, Self-help…) on her own, a batch every few minutes. Press to do a batch now.</p>
      <button class="act" id="sortBtn" type="button">Sort the books now</button>
      <h2 id="h-review" tabindex="-1">Waiting for the librarian</h2>
      <p class="hint">You are the librarian. Approve a link and it is fetched into the collection from TubeVault's Cloud tab; approve a file and it goes into the library at once. The person who submitted it is told either way.</p>
      <ul class="plain" id="reviewList" aria-labelledby="h-review"></ul>
      <section id="familyAccess" aria-labelledby="h-family-access" hidden></section>
    </section>
    </div>

    <div data-views="add">
    <h2 id="h-donate">Donate a book</h2>
    <div class="card">
      <p class="hint">An audiobook ZIP containing MP3 or M4B recordings (up to 4 GB), Bookshare's DAISY zip (text or recorded audio), an EPUB, a text file, a Word file or an HTML page. Audio recordings stay together as one audiobook; text-book imports support up to 256 MB. It lands on your shelf first; the Bookshare notice at the front is skipped automatically and the book opens with its jacket.</p>
      <label class="field" for="bookFile">Book file</label>
      <input type="file" id="bookFile" accept=".zip,.epub,.txt,.docx,.html,.htm,.xhtml,.xml,application/zip,application/epub+zip,text/plain">
      <label class="field"><input type="checkbox" id="bookPrivate"> Keep this upload private</label><label class="field"><input type="checkbox" id="bookGrownUps"> Grown-ups only (hidden from the kids' accounts)</label>
      <button class="act primary" id="bookUploadBtn" type="button">Add this book to my shelf</button>
    </div>

    <h2 id="h-donate-audio">Add audio or video</h2>
    <div class="card">
      <p class="hint">An audiobook, the audio from a described movie, a cassette side, old radio or commercials — MP3, M4A, M4B, AAC, WAV, OGG or FLAC. Give it a name, then add one or more parts. Audio and video files upload directly to storage, up to 20 GB per recording.</p>
      <label class="field" for="auTitle">Title</label><input type="text" id="auTitle" placeholder="The Little Mermaid (described audio)">
      <label class="field" for="auAuthor">Who made it (optional)</label><input type="text" id="auAuthor" placeholder="Author, narrator, studio, or station">
      <label class="field" for="auYear">Year (optional)</label><input type="text" id="auYear" placeholder="1989">
      <label class="field" for="auCategory">Shelf</label>
      <select id="auCategory"><option value="other">Audio or video</option><option value="audiobook">Audiobook</option><option value="movie">Movie or described audio</option><option value="cassette">Cassette</option><option value="radio">Radio</option><option value="commercials">Commercials</option><option value="music">Music</option><option value="other">Other</option></select>
      <label class="field" for="auDesc">About it (optional)</label><textarea id="auDesc" rows="3" placeholder="What it is, where it came from, anything a listener should know."></textarea>
      <label class="field"><input type="checkbox" id="auPrivate"> Keep this upload private</label><label class="field"><input type="checkbox" id="auGrownUps"> Grown-ups only</label>
      <button class="act primary" id="auStartBtn" type="button">Start this donation</button>
      <div id="auTracks" class="hidden">
        <p class="hint" id="auTracksHint"></p>
        <label class="field" for="auFile">Add an audio or video file</label>
        <input type="file" id="auFile" accept="audio/*,video/*,.mp3,.m4a,.m4b,.aac,.wav,.ogg,.flac,.mp4,.mov,.m4v,.webm">
        <label class="field" for="auTrackTitle">Name for this part (optional)</label><input type="text" id="auTrackTitle" placeholder="Side A, Part 2, Episode 3…">
        <button class="act" id="auAddBtn" type="button">Upload this part</button>
        <ul class="plain" id="auTrackList"></ul>
        <button class="act quiet" id="auDoneBtn" type="button">Done: go to my shelf</button>
      </div>

    </div>
  </section>

  <section id="collection" class="hidden">
    <p><button class="act quiet" id="collBack" type="button">&larr; Back to playlists</button></p>
    <h2 id="collTitle" tabindex="-1"></h2>
    <p class="meta" id="collMeta"></p>
    <div class="row"><button class="act primary" id="collPlayAll" type="button">Play all, in order</button><button class="act quiet" id="collShareBtn" type="button" hidden></button><button class="act quiet" id="collDeleteBtn" type="button" hidden>Delete this collection</button></div>
    <ol class="plain" id="collItems"></ol>
  </section>

  <section id="player" class="hidden">
    <p><button class="act quiet" id="backToShelf" type="button">&larr; Back to the shelf</button></p>
    <h2 id="bookTitle" tabindex="-1"></h2>
    <p><a class="act quiet" id="askLibrarian" href="${require('@librechat/api').librarianGuide.chatUrl}">Ask Mrs. Witherspoon about this item</a></p>
    <p class="meta" id="bookMeta"></p>
    <p class="hint" id="jacketLine"></p>
    <div class="controls" role="group" aria-label="Playback">
      <button class="act big primary wide" id="playBtn" type="button">Play</button>
      <button class="act" id="backBtn" type="button">Back 15 seconds</button>
      <button class="act" id="fwdBtn" type="button">Forward 15 seconds</button>
      <button class="act" id="markBtn" type="button">Bookmark here</button>
      <button class="act quiet" id="prevSecBtn" type="button">Previous chapter</button>
      <button class="act quiet" id="nextSecBtn" type="button">Next chapter</button>
      <button class="act quiet" id="startBtn" type="button">From the beginning</button>
    </div>
    <p id="playState"></p>
    <div id="seekWrap" hidden><label class="field" for="seekBar">Position</label><input type="range" id="seekBar" min="0" max="0" step="1" value="0"></div>
    <p id="timeLine" hidden></p>
    <div class="row" id="accessRow" role="group" aria-label="Captions and description" hidden>
      <button class="act" id="captionsBtn" type="button" hidden>Captions: off</button>
      <button class="act" id="descToggleBtn" type="button" hidden>Spoken description: off</button>
      <button class="act quiet" id="descFindBtn" type="button" hidden>Get a spoken description</button>
    </div>
    <video id="fileMedia" class="player audioonly" playsinline preload="metadata" x-webkit-airplay="allow" aria-label="The recording" tabindex="-1"></video>
    <div class="row" id="castRow" hidden>
      <button class="act quiet" id="airplayBtn" type="button" hidden>AirPlay</button>
      <button class="act quiet" id="castBtn" type="button" hidden>Cast to a TV</button>
      <button class="act quiet" id="addCollBtn" type="button">Add to a playlist</button>
      <button class="act quiet" id="reportBtn" type="button">Suggest a different shelf</button>
    </div>
    <div id="addCollPanel" role="group" aria-labelledby="addCollLabel" hidden>
      <label class="field" for="addCollSel" id="addCollLabel">Add to which playlist?</label>
      <select id="addCollSel"></select>
      <div id="addCollNewWrap"><label class="field" for="addCollNew">Name for the new playlist</label><input type="text" id="addCollNew" maxlength="120" autocomplete="off"></div>
      <div class="row" style="margin-top:.6rem"><button class="act primary" id="addCollGo" type="button">Add it</button><button class="act quiet" id="addCollCancel" type="button">Cancel</button></div>
    </div>
    <div class="now" id="nowText" aria-label="Now reading"></div>
    <button class="act" id="readingViewBtn" type="button" style="margin-top:.6rem" hidden>Open reading view</button>
    <details id="descWrap" hidden><summary id="descSummary">Video description</summary>
      <p class="hint" id="descHint">A described-video track written by the library's eyes: what is on screen, scene by scene. One run serves everyone.</p>
      <div class="row">
        <button class="act" id="descBtn" type="button">Describe this video</button>
        <button class="act quiet" id="descReadBtn" type="button" hidden>Read the description</button>
        <label class="field" style="margin:0" id="descModeWrap" hidden><input type="checkbox" id="descMode"> Play with descriptions (pauses to describe each scene)</label>
      </div>
      <p id="descStatus" class="hint"></p>
      <p class="hint" id="descCopyWrap" hidden><a id="descCopy" href="/described-video">Make a described copy: narration mixed into the video, with the audio to download</a></p>
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

    <div id="chapterWrap">
    <label class="field" for="chapterSel" id="chapterLabel">Chapter</label>
    <select id="chapterSel"></select>
    <button class="act" id="goChapterBtn" type="button">Go to this chapter</button>
    </div>

    <p class="hint" id="keysHint">Keys: Space play or pause, Left and Right back or forward, Shift with Left or Right for chapters, B for a bookmark.</p>
    <label class="field"><input type="checkbox" id="keysOn" checked> Keyboard shortcuts for this player</label>

    <div id="voiceWrap">
      <label class="field" for="voiceSel">Voice</label>
      <select id="voiceSel"></select>
      <button class="act" id="hearVoiceBtn" type="button" aria-describedby="hearVoiceHint">Hear this voice</button>
      <span id="hearVoiceHint" class="muted">Plays the part you are on in the voice chosen above, so you can try a few before you settle.</span>
      <label class="field" for="deliverySel">Delivery</label>
      <select id="deliverySel"><option value="STABLE">Steady</option><option value="BALANCED">Balanced</option><option value="CREATIVE">Lively</option></select>
      <label class="field"><input type="checkbox" id="followAlong"> Highlight the current passage</label>
      <label class="field" for="speedSel">Speed</label>
      <select id="speedSel"><option value="0.75" aria-label="0.75 times">0.75x</option><option value="0.8" aria-label="0.8 times">0.8x</option><option value="0.9" aria-label="0.9 times">0.9x</option><option value="1" aria-label="Normal" selected>1x</option><option value="1.1" aria-label="1.1 times">1.1x</option><option value="1.2" aria-label="1.2 times">1.2x</option><option value="1.3" aria-label="1.3 times">1.3x</option><option value="1.4" aria-label="1.4 times">1.4x</option><option value="1.5" aria-label="1.5 times">1.5x</option></select>
    </div>

    <details><summary id="bookmarkSummary">Bookmarks</summary>
      <ul class="plain" id="bookmarkList"><li class="muted">None yet.</li></ul>
    </details>
    <details id="skippedWrap"><summary id="skippedSummary">Skipped parts</summary>
      <p class="hint">Front matter the library skips on its own: the copyright page, the contents list, publisher sign-up pages. Play any of them here.</p>
      <ul class="plain" id="skippedList"></ul>
    </details>
    <details id="editWrap" class="hidden"><summary>Edit this item</summary>
      <label class="field" for="edTitle">Title</label><input type="text" id="edTitle">
      <label class="field" for="edAuthor">Who made it</label><input type="text" id="edAuthor">
      <label class="field" for="edYear">Year</label><input type="text" id="edYear">
      <label class="field" for="edCategory">Shelf</label>
      <select id="edCategory"><option value="other">Audio or video</option><option value="audiobook">Audiobook</option><option value="movie">Movie or described audio</option><option value="tv">TV</option><option value="commercials">Commercials</option><option value="psa">PSA</option><option value="vhs">VHS / home video</option><option value="cassette">Cassette</option><option value="radio">Radio</option><option value="music">Music</option><option value="other">Other</option></select>
      <label class="field" for="edPath">Folder in the archive (blank = not in the archive)</label><input type="text" id="edPath" placeholder="Video/Commercials/Coffee & Tea">
      <label class="field" for="edDesc">About it</label><textarea id="edDesc" rows="2"></textarea>
      <button class="act primary" id="edSaveBtn" type="button">Save changes</button>
    </details>
    <details id="ownerWrap" class="hidden"><summary>Where it sits</summary>
      <div class="row">
        <button class="act" id="shareBtn" type="button"></button>
        <button class="act quiet" id="grownBtn" type="button"></button>
        <button class="act quiet hidden" id="submitItemBtn" type="button">Submit this for the library</button>
        <button class="act quiet" id="deleteBtn" type="button">Withdraw it from the room</button>
      </div>
    </details>
    <details id="borrowWrap" class="hidden"><summary>Checked out</summary>
      <button class="act quiet" id="returnBtn" type="button">Return it to the library</button>
    </details>

  </section>
  </main>

<script src="/assets/library/browse.js?v=20261110b"></script>
<script src="/assets/library/requests.js?v=20260924b"></script>
<script src="/assets/library/reader.js?v=20260924"></script>
<script src="/assets/library/access.js?v=20260928"></script>
<script>
(function(){
  var token = null;
  var API = '/api/kade/reading-room';
  var TTS_BASE = 'https://inworld-tts-proxy-production.up.railway.app';
  var librarianChatUrl = ${JSON.stringify(require('@librechat/api').librarianGuide.chatUrl)};
  var $ = function(id){ return document.getElementById(id); };
  /* Nov 10 2026 (redesign): which of the Library's small pages this is (the front desk, search,
     folders, ...). Blocks that belong to other pages are taken out before anything loads, the
     heading and the browser title name the page, and the link at the top goes back to the front
     desk (from the front desk it goes Home). */
  ${VIEW_SCRIPT}
  var VIEW = kadeLibraryView(location), BASE = '/library';
  try { document.documentElement.setAttribute('data-view', VIEW); } catch(e) {}
  [].forEach.call(document.querySelectorAll('[data-views]'), function(el){ el.hidden = el.getAttribute('data-views').split(' ').indexOf(VIEW) === -1; });
  var PAGE_NAMES = { desk: 'The Library', continue: 'Continue and your shelf', local: 'Springfield and the Ozarks', search: 'Browse and search', folders: 'Folders', playlists: 'Playlists', family: 'Family shelves', requests: 'Requests', add: 'Add to the Library', librarian: "The librarian's desk" };
  if (PAGE_NAMES[VIEW]) $('pageTitle').textContent = PAGE_NAMES[VIEW];
  if (PAGE_NAMES[VIEW] && VIEW !== 'desk') document.title = PAGE_NAMES[VIEW] + ' — The Library — Kade-AI';
  if (VIEW !== 'desk') { $('backLink').href = BASE; $('backLink').setAttribute('aria-label', 'Back to the Library'); $('backLink').textContent = '← The Library'; }
  // the reading-alcove picture belongs to the front desk; on every other page its box is hidden, so it is never downloaded
  if (VIEW !== 'desk') $('alcoveArt').parentNode.hidden = true;
  var live = $('live');
  // While the reading view (a modal dialog) is open, #live is inert; the reader says it instead.
  var freshTimer = null;
  function say(t){
    if (libraryReader && libraryReader.say(t)) return;
    live.textContent = ''; setTimeout(function(){ live.textContent = t; }, 30);
    // Nov 10 2026: sighted people far down the page see the same words for eight seconds; the text itself stays.
    var held = false; try { held = live.classList.contains('fresh') ? live.classList.contains('held') : live.getBoundingClientRect().top < 0; } catch(e) {}
    live.classList.toggle('held', held);
    live.classList.add('fresh'); clearTimeout(freshTimer); freshTimer = setTimeout(function(){ live.classList.remove('fresh'); live.classList.remove('held'); }, 8000);
  }
  /* Nov 10 2026: focus never falls off the page. After a list is redrawn the button that was
     pressed is gone, so focus goes to a named place beside the new list. */
  function focusOn(el){ if (!el) return; try { el.focus(); } catch(e) {} }
  /* Every move inside the Library goes to the bare path plus a query, never carrying a #fragment
     along, so a fragment from an alert link does not follow the person from page to page. */
  function visit(query){ location.href = BASE + (query || ''); }
  /* Nov 10 2026 (redesign): the address holds the search, the filters, the folder and the page
     number. An Open button notes the address it was pressed on, so "Back to the shelf" returns to
     that very list and page, where the row is waiting for focus. Without a note it is the plain
     Library. Only an address inside the Library is ever followed. */
  var address = window.kadeLibraryAddress || { params: function(){ return new URLSearchParams(location.search); }, set: function(){ return false; } };
  function leave(){
    var note = returnNote(), from = note && typeof note.from === 'string' ? note.from : '';
    var inside = (from.indexOf('/library') === 0 || from.indexOf('/reading-room') === 0) && from.indexOf('book=') === -1 && from.indexOf('//') === -1;
    location.href = inside ? from : BASE;
  }
  /* Coming back from an item: the place it was opened from gets focus again. The note is made
     when an Open or Continue button is pressed and is good for one try: the first time the list
     it names is drawn, the row gets focus if it is there, and the note is thrown away either way
     (a row beyond the first 60 is not there). It is also dropped as soon as the person presses a
     key, touches, clicks or scrolls the page, so it never pulls focus away from them later.
     lists: the ids of the lists just drawn. A note for a list not drawn yet is left for that list.
     missOnly: use the note up without moving focus (the person moved the list themselves). */
  var RETURN_KEY = 'library-return';
  function noteReturn(li, id){ try { var host = li.parentNode && li.parentNode.closest ? li.parentNode.closest('[id]') : null; sessionStorage.setItem(RETURN_KEY, JSON.stringify({ id: id, host: host ? host.id : '', at: Date.now(), from: location.pathname + location.search })); } catch(e) {} }
  function dropReturn(){ try { sessionStorage.removeItem(RETURN_KEY); } catch(e) {} }
  var RETURN_LISTS = ['browseList', 'archiveList', 'mineList', 'continueList'];
  function returnNote(){ try { return JSON.parse(sessionStorage.getItem(RETURN_KEY) || 'null'); } catch(e) { return null; } }
  function restoreReturn(lists, missOnly){
    var note = returnNote();
    if (!note) return false;
    if (!note.id || !note.host || RETURN_LISTS.indexOf(note.host) === -1) { dropReturn(); return false; }
    if (!(Date.now() - note.at < 7200000) || location.hash === '#libraryRequests' || /[?&]request=/.test(location.search)) { dropReturn(); return false; }
    if (!lists || lists.indexOf(note.host) === -1) return false;
    dropReturn();
    var host = $(note.host); if (!host || missOnly) return false;
    var rows = host.querySelectorAll('li[data-book]'), button = null;
    for (var i = 0; i < rows.length; i++) { if (rows[i].getAttribute('data-book') === note.id) { button = rows[i].querySelector('button'); break; } }
    if (!button) return false;
    var box = button.closest('details'); if (box && !box.open) box.open = true;
    focusOn(button);
    try { button.scrollIntoView({ block: 'center' }); } catch(e) {}
    return true;
  }
  /* click is here because a screen reader's own "activate" sends a click with no key or pointer
     event before it; it runs before the button's own handler, so an Open button still writes its
     new note afterwards. wheel and touchmove are here for a sighted person already scrolling. */
  ['keydown', 'pointerdown', 'click', 'wheel', 'touchmove'].forEach(function(kind){ document.addEventListener(kind, function(ev){ if (ev.isTrusted && !$('shelf').classList.contains('hidden')) dropReturn(); }, { capture: true, passive: true }); });
  /* Leaving an item or a playlist by a link (Home, Ask Mrs. Witherspoon, the tab bar) is not
     coming back to the shelf, so the note is not kept for a later visit. */
  document.addEventListener('click', function(ev){ var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null; if (a && $('shelf').classList.contains('hidden') && (a.getAttribute('href') || '').charAt(0) !== '#') dropReturn(); }, true);
  /* The skip link moves focus itself and writes no #fragment into the address. Its href stays a
     real fragment, so it still reads as a link and still says where it goes. */
  $('skipLink').addEventListener('click', function(ev){
    var target = $((this.getAttribute('href') || '').slice(1));
    ev.preventDefault();
    if (!target) return;
    for (var node = target; node && node.nodeType === 1; node = node.parentNode) { if (node.hidden || node.classList.contains('hidden')) return; }
    focusOn(target);
    try { target.scrollIntoView({ block: 'start' }); } catch(e) {}
  });
  function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function catName(c){ return {book:'Book', audiobook:'Audiobook', movie:'Movie', cassette:'Cassette', radio:'Radio', commercials:'Commercials', music:'Music', tv:'TV', vhs:'VHS', psa:'Public service announcement', other:'Other'}[c] || c; }
  /* Part 296, her Sep 27 word: a described MP3 said "Movie" because the word came from the shelf's
     category. The server now sends the one word for what an item is ("Described audio episode",
     "Movie trailer"); an older answer without it falls back to the category. */
  function typeWord(b){ return (b && b.typeLabel) || (b && b.kind !== 'text' ? catName(b.category) : 'Book'); }
  async function api(path, opts){
    opts = opts || {};
    var h = opts.headers || {}; h['Authorization'] = 'Bearer ' + token;
    if (opts.json) { h['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
    var r = await fetch(API + path, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: h, body: opts.body, signal: opts.signal });
    var j = null; try { j = await r.json(); } catch(e) {}
    if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j;
  }

  /* ── shelf ─────────────────────────────────────────────────────────── */
  var shelfData = null, me = '', librarian = false, describedVideo = false, filesRule = '';
  function canManage(b){ return b && (librarian || (me && b.owner === me)); }
  function bookLi(b, where){
    var li = document.createElement('li');
    li.setAttribute('data-book', b.id);
    var kind = typeWord(b);
    var by = b.author ? ' by ' + b.author : '';
    var prog = b.progress && b.progress.where ? (b.kind !== 'text' ? ' · Part ' : ' · Chapter ') + b.progress.where : '';
    var donor = where === 'library' || where === 'borrowed' ? ' · Donated by ' + esc(b.ownerName || 'someone') : '';
    if (where === 'archive') { var m = b.meta || {}; donor = [m.year, m.network || m.cableChannel || m.callSign, m.brand, m.market].filter(Boolean).map(esc).join(' · '); donor = donor ? ' · ' + donor : ''; if (b.described && !/described/i.test(kind)) donor += ' · described'; }
    var len = b.listen ? ' · ' + b.listen : '';
    var pending = b.state === 'pending' ? ' · no recordings yet' : '';
    li.innerHTML = '<span class="t book"><strong>' + esc(b.title) + '</strong><span class="meta">' + esc(kind + by) + len + prog + donor + pending + (b.shared && where === 'mine' ? ' · in the library' : '') + '</span></span>';
    var open = document.createElement('button'); open.className = 'act'; open.type = 'button';
    open.textContent = where === 'library' ? 'Check out' : (b.progress && !b.progress.finished && (b.progress.s || b.progress.c || b.progress.pos) ? 'Continue' : 'Open');
    open.setAttribute('aria-label', open.textContent + ' ' + b.title);
    open.onclick = function(){ noteReturn(li, b.id); visit('?book=' + b.id); };
    li.appendChild(open);
    if (where === 'mine' && b.kind !== 'text') {
      var add = document.createElement('button'); add.className = 'act quiet'; add.type = 'button'; add.textContent = 'Add parts';
      add.setAttribute('aria-label', 'Add parts to ' + b.title);
      add.onclick = function(){ location.href = BASE + '/add?parts=' + encodeURIComponent(b.id); };
      li.appendChild(add);
    }
    return li;
  }
  function renderList(id, items, where, empty){
    var ul = $(id); ul.innerHTML = '';
    if (!items.length) { ul.innerHTML = '<li class="muted">' + empty + '</li>'; return; }
    items.forEach(function(b){ ul.appendChild(bookLi(b, where)); });
  }
  /* Nov 10 2026 (redesign): the shelf holds everything a person ever opened, which for the
     librarian is thousands of rows. It is drawn 60 at a time, with a count and a "Show 60 more"
     button; the new rows get focus. Coming back from an item further down, enough rows are drawn
     for that item to be there. */
  var SHELF_PAGE = 60, shelfShown = SHELF_PAGE;
  function renderShelf(mine, borrowed, focusFrom){
    var box = $('mineList'); box.innerHTML = '';
    var all = mine.map(function(b){ return {book:b, where:'mine'}; }).concat(borrowed.map(function(b){ return {book:b, where:'borrowed'}; }));
    if (!all.length) { box.innerHTML = '<p class="muted">Nothing on your shelf yet. Open something in the library, or add a file from the Add to the Library page.</p>'; return; }
    var note = returnNote();
    if (note && note.host === 'mineList') { for (var at = 0; at < all.length; at++) { if (all[at].book.id === note.id) { if (at >= shelfShown) shelfShown = (Math.floor(at / SHELF_PAGE) + 1) * SHELF_PAGE; break; } } }
    var showing = Math.min(shelfShown, all.length);
    var count = document.createElement('p'); count.className = 'hint'; count.id = 'mineCount';
    count.textContent = all.length + ' item' + (all.length === 1 ? '' : 's') + (showing < all.length ? ' · showing the first ' + showing : '');
    box.appendChild(count);
    var ul = document.createElement('ul'); ul.className = 'plain'; ul.setAttribute('aria-labelledby', 'h-mine');
    all.slice(0, showing).forEach(function(entry){
      var b = entry.book, li = bookLi(b, entry.where);
      if (entry.where === 'borrowed') {
        var rm = document.createElement('button'); rm.className = 'act quiet'; rm.type = 'button'; rm.textContent = 'Remove from my shelf'; rm.setAttribute('aria-label', 'Remove ' + b.title + ' from my shelf');
        rm.onclick = async function(){ try { await api('/book/' + b.id + '/return', { method: 'POST' }); say('Removed from your shelf. It stays in the library.'); await loadShelf(); focusOn($('h-mine')); } catch(e) { say(e.message); } };
        li.appendChild(rm);
      }
      ul.appendChild(li);
    });
    box.appendChild(ul);
    if (showing < all.length) {
      var left = all.length - showing, more = document.createElement('button'); more.className = 'act quiet'; more.type = 'button'; more.id = 'mineMore';
      more.textContent = 'Show ' + Math.min(SHELF_PAGE, left) + ' more'; more.setAttribute('aria-label', 'Show ' + Math.min(SHELF_PAGE, left) + ' more from your shelf, ' + left + ' not shown yet');
      more.onclick = function(){ var first = shelfShown; shelfShown += SHELF_PAGE; renderShelf(mine, borrowed, first); };
      box.appendChild(more);
    }
    if (focusFrom != null) {
      var row = ul.children[focusFrom], button = row && row.querySelector('button');
      focusOn(button || $('h-mine'));
      say('Showing ' + showing + ' of ' + all.length + '.');
    }
  }
  /* Nov 10 2026: the three things most recently left unfinished, right under the front desk's
     title (on the Continue page, every unfinished thing, up to 30). They are the same rows the
     shelf holds (Continue plus the title), so nothing new to learn; the section is absent when
     there is nothing to continue. */
  function unfinished(mine, borrowed){
    var all = mine.map(function(b){ return {book:b, where:'mine'}; }).concat(borrowed.map(function(b){ return {book:b, where:'borrowed'}; }));
    all = all.filter(function(entry){ var p = entry.book.progress; return entry.book.state !== 'pending' && p && !p.finished && (p.s || p.c || p.pos); });
    var when = function(entry){ var t = Date.parse(entry.book.progress.updatedAt || ''); return isNaN(t) ? 0 : t; };
    all.sort(function(a, b){ return when(b) - when(a); });
    return all.slice(0, VIEW === 'continue' ? 30 : 3);
  }
  function renderContinue(mine, borrowed){
    var rows = unfinished(mine, borrowed), ul = $('continueList');
    ul.innerHTML = '';
    // An own upload keeps its Add parts button under Your shelf; here every row is one stop, Continue.
    rows.forEach(function(entry){ ul.appendChild(bookLi(entry.book, entry.where === 'mine' ? 'continue' : entry.where)); });
    /* The box arrives after the page is already drawn and sits above almost everything. Where the
       browser does not hold the view steady by itself (Safari), a scrolled page is moved by the
       same amount, so what the person was looking at, or the row they came back to, stays put. */
    var box = $('continueBox'), hide = !rows.length || !$('player').classList.contains('hidden') || !$('collection').classList.contains('hidden');
    var anchored = false; try { anchored = !!(window.CSS && CSS.supports && CSS.supports('overflow-anchor', 'auto')); } catch(e) {}
    var mark = document.activeElement && document.activeElement !== document.body && !box.contains(document.activeElement) ? document.activeElement : $('h-desk');
    var before = 0; try { before = mark.getBoundingClientRect().top; } catch(e) {}
    box.hidden = hide;
    try { var moved = mark.getBoundingClientRect().top - before; if (moved && !anchored && (window.pageYOffset || 0) > 0) window.scrollBy(0, moved); } catch(e) {}
  }
  async function loadShelf(){
    try {
      shelfData = await api('/shelf');
      if (VIEW === 'continue') renderShelf(shelfData.mine, shelfData.borrowed);
      if (VIEW === 'desk' || VIEW === 'continue') { renderContinue(shelfData.mine, shelfData.borrowed); restoreReturn(['mineList', 'continueList']); }
      me = shelfData.me || me; librarian = !!shelfData.librarian; describedVideo = !!shelfData.describedVideo; filesRule = shelfData.filesMode || '';
      // the folders page uses who you are (for Move and Delete) without asking for the whole shelf again
      try { sessionStorage.setItem('library-who', JSON.stringify({ me: me, librarian: librarian })); } catch(e) {}
      $('familyLibraryNotice').hidden = !(shelfData.familyLibrary === false && (VIEW === 'desk' || VIEW === 'family'));
      if (librarian && VIEW === 'librarian' && window.setupLibraryAccess) window.setupLibraryAccess(api, say);
      $('familyHistoryLink').hidden = shelfData.familyLibrary !== true;
      $('row-desk').hidden = !librarian;
      /* Her rule for the Family feature pack: a door a person cannot use yet is still there, marked
         in words, never hidden. The row still opens its page, which says how to get the pack. */
      var family = $('row-family');
      if (shelfData.familyLibrary === false && !family.classList.contains('locked')) {
        family.classList.add('locked');
        var tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = 'Family feature pack';
        $('rowhint-family').appendChild(document.createTextNode(' ')); $('rowhint-family').appendChild(tag);
      }
    } catch(e) { restoreReturn(['mineList', 'continueList'], true); say('Could not load the shelf: ' + e.message); }
  }
  /* Family shelves: the top shelves of the family's shared collection, each a link into the
     folders. Without the Family feature pack the page says so and lists nothing. */
  async function loadFamily(){
    var ul = $('familyList'); ul.innerHTML = '';
    /* false: no Family feature pack (the notice above says how to get it). Anything but true:
       nothing is said about a family collection (the App Review seat), and the shelves listed are
       whatever that account can open. */
    if (shelfData && shelfData.familyLibrary !== true) $('familyBlurb').hidden = true;
    if (shelfData && shelfData.familyLibrary === false) return;
    ul.innerHTML = '<li class="muted">Loading…</li>';
    try {
      var j = await api('/archive?path=&page=0&scope=public');
      ul.innerHTML = '';
      if (!j.folders.length) { ul.innerHTML = '<li class="muted">Nothing is on the family shelves yet.</li>'; return; }
      j.folders.forEach(function(f){
        var li = document.createElement('li'), a = document.createElement('a');
        a.className = 'shelf'; a.href = BASE + '/folders?folder=' + encodeURIComponent(f.path);
        a.textContent = f.name + ' (' + Number(f.count).toLocaleString('en-US') + ' item' + (f.count === 1 ? '' : 's') + ')';
        li.appendChild(a); ul.appendChild(li);
      });
    } catch(e) { ul.innerHTML = '<li class="muted">' + esc(e.message) + '</li>'; say(e.message); }
  }
  /* the archive */
  var archivePath = '', archivePage = 0, archiveRun = 0;

  /* pictures (Sep 25 2026 art batch): the reading-alcove banner on the shelf
     screen, and a still picture over the Radio and Music shelves that changes
     only when the folder view changes, in the same step as the list; its alt
     changes with its source. Nothing here moves focus or speaks: the alt is
     read only when a screen reader reaches the picture. A picture steps aside,
     and never starts a download, under the contrast, zoom, landscape,
     data-saving and large-text rules; one that fails to load keeps its box and
     shows the plain dusk gradient behind it, and the CSS takes the img itself
     away so no missing picture is announced. */
  var SHELF_ART = ${JSON.stringify(SHELF_ART)};
  var ART_DIR = ${JSON.stringify(ART_DIR)};
  var artHiddenWhen = null;
  try { artHiddenWhen = window.matchMedia ? window.matchMedia(${JSON.stringify(ART_HIDDEN_WHEN)}) : null; } catch(e) {}
  var shelfArtKey = '';
  function artAllowed(){
    try { if (document.documentElement.classList.contains('kade-art-off')) return false; } catch(e) {}
    try { if (navigator.connection && navigator.connection.saveData) return false; } catch(e) {}
    return !(artHiddenWhen && artHiddenWhen.matches);
  }
  /* start a download only while the picture may show; tried again when the screen changes */
  function fillArt(img){
    var want = img.getAttribute('data-src');
    if (!want || img.getAttribute('src') === want || img.parentNode.hidden || !artAllowed()) return;
    var set = img.getAttribute('data-srcset');
    if (set) img.srcset = set;
    img.src = want;
  }
  function watchArt(img){
    img.addEventListener('error', function(){ if (this.getAttribute('src')) { this.parentNode.classList.add('art-failed'); this.parentNode.classList.remove('art-shown'); } });
    img.addEventListener('load', function(){ this.parentNode.classList.remove('art-failed'); this.parentNode.classList.add('art-shown'); });
  }
  function shelfArtFor(path){
    var parts = String(path || '').split('/');
    if (String(parts[0]).toLowerCase() !== 'audio' || !parts[1]) return '';
    var words = parts[1].toLowerCase().split(/[^a-z0-9]+/);
    if (words.indexOf('radio') !== -1) return 'radio';
    if (words.indexOf('music') !== -1) return 'music';
    return '';
  }
  function showShelfArt(path){
    var key = shelfArtFor(path);
    if (key === shelfArtKey) return;
    shelfArtKey = key;
    var img = $('shelfArt'), box = $('shelfArtBox');
    box.classList.remove('art-failed'); box.classList.remove('art-shown');
    img.removeAttribute('srcset'); img.removeAttribute('src');
    if (key) {
      var f = ART_DIR + SHELF_ART[key].file;
      img.alt = SHELF_ART[key].alt;
      img.sizes = '(max-width: 480px) calc(100vw - 2.5rem), 392px';
      img.setAttribute('data-srcset', f + '-768.webp 768w, ' + f + '-1152.webp 1152w');
      img.setAttribute('data-src', f + '-768.webp');
      box.hidden = false;
      fillArt(img);
    } else {
      img.removeAttribute('data-srcset'); img.removeAttribute('data-src');
      img.alt = '';
      box.hidden = true;
    }
  }
  function refillArt(){ fillArt($('alcoveArt')); fillArt($('shelfArt')); }
  watchArt($('alcoveArt')); watchArt($('shelfArt'));
  $('alcoveArt').setAttribute('data-src', ${JSON.stringify(ALCOVE_ART.src)});
  fillArt($('alcoveArt'));
  if (artHiddenWhen) { if (artHiddenWhen.addEventListener) artHiddenWhen.addEventListener('change', refillArt); else if (artHiddenWhen.addListener) artHiddenWhen.addListener(refillArt); }
  /* Nov 10 2026 (redesign): the folders are their own page. The folder you are in, its page number
     and the collection (the family library or your uploads) are in the address (folder, fpage,
     scope), so Back walks up out of a folder and a link opens the same folder. */
  function folderPlace(){ var params = address.params(), page = parseInt(params.get('fpage'), 10); return { path: params.get('folder') || '', page: page > 1 ? page - 1 : 0, scope: params.get('scope') === 'mine' ? 'mine' : 'public' }; }
  async function startFolders(){
    var was = folderPlace();
    $('libraryScope').value = was.scope; $('folderScope').value = was.scope;
    var who = null; try { who = JSON.parse(sessionStorage.getItem('library-who') || 'null'); } catch(e) {}
    if (who && who.me) { me = who.me; librarian = !!who.librarian; } else await loadShelf();
    loadArchive(was.path, was.page, false, true);
  }
  $('folderScope').onchange = function(){
    $('libraryScope').value = this.value;
    address.set({ scope: this.value === 'mine' ? 'mine' : '', folder: '', fpage: '' }, 'push');
    loadArchive('', 0, false, false, 'none');
  };
  window.addEventListener('popstate', function(){
    if (VIEW !== 'folders') return;
    var now = folderPlace(), changed = now.scope !== $('libraryScope').value;
    $('libraryScope').value = now.scope; $('folderScope').value = now.scope;
    if (changed || now.path !== archivePath || now.page !== archivePage) loadArchive(now.path, now.page, true, false, 'none');
  });
  /* focus: true after the person moved (opened a folder, a crumb, moved or deleted an item): the
     button they pressed is destroyed by the redraw, so focus lands on the crumb for where they
     now are, just above the new list. For a page turn, focus is the Previous or Next page button
     that was pressed: those two sit outside the list and survive, so focus stays on it and the
     page number is spoken; only when that button has just gone dead (first or last page) does
     focus move, to the other one, or to the crumb.
     quiet: true when the page itself reopens a remembered folder, so nothing is spoken.
     If the folder cannot be loaded the reason is spoken, and focus that fell off the page with
     the old list goes to the page heading.
     how: 'none' when the address already says where this is (Back, Forward, a reload); otherwise
     a move the person made is a new step in the address that Back can return to. */
  async function loadArchive(path, page, focus, quiet, how){
    var run = ++archiveRun, scope = $('libraryScope').value;
    archivePath = path || ''; archivePage = page || 0;
    if (focus && how !== 'none') address.set({ folder: archivePath, fpage: archivePage ? archivePage + 1 : '' }, 'push');
    var ul = $('archiveList'); ul.innerHTML = '<li class="muted">Loading…</li>';
    try {
      var j = await api('/archive?path=' + encodeURIComponent(archivePath) + '&page=' + archivePage + '&scope=' + scope);
      if (run !== archiveRun || scope !== $('libraryScope').value) return;
      var crumbs = $('crumbs'); crumbs.innerHTML = '';
      var home = document.createElement('button'); home.type = 'button'; home.textContent = 'All folders'; if (!archivePath) home.setAttribute('aria-current', 'location'); home.onclick = function(){ loadArchive('', 0, true); }; crumbs.appendChild(home);
      var here = home;
      var parts = archivePath ? archivePath.split('/') : [];
      // Part 296: each shelf reads under its display name ("Described audio TV"); it still opens its real path
      var named = j.crumbs && j.crumbs.length === parts.length ? j.crumbs : null;
      parts.forEach(function(seg, i){
        var sep = document.createElement('span'); sep.textContent = ' › '; sep.setAttribute('aria-hidden', 'true'); crumbs.appendChild(sep);
        var b = document.createElement('button'); b.type = 'button'; b.textContent = named ? named[i].name : seg; var target = parts.slice(0, i + 1).join('/');
        if (i === parts.length - 1) { b.setAttribute('aria-current', 'location'); here = b; }
        b.onclick = function(){ loadArchive(target, 0, true); }; crumbs.appendChild(b);
      });
      // the browser tab and the history list name the folder, so two folders can be told apart
      document.title = (parts.length ? (named ? named[parts.length - 1].name : parts[parts.length - 1]) + ' — ' : '') + 'Folders — The Library — Kade-AI';
      showShelfArt(archivePath);
      ul.innerHTML = '';
      if (!j.folders.length && !j.items.length) { ul.innerHTML = '<li class="muted">' + (archivePath ? 'This folder is empty.' : 'No items in this collection yet. Choose the other collection above, or add a file from the Add to the Library page.') + '</li>'; }
      j.folders.forEach(function(f){
        var li = document.createElement('li'); li.className = 'folder';
        li.innerHTML = '<span class="t">📁 ' + esc(f.name) + ' <span class="muted">(' + f.count + ')</span></span>';
        var open = document.createElement('button'); open.className = 'act quiet'; open.type = 'button'; open.textContent = 'Open folder';
        open.setAttribute('aria-label', 'Open folder ' + f.name + ', ' + f.count + ' item' + (f.count === 1 ? '' : 's'));
        open.onclick = function(){ loadArchive(f.path, 0, true); };
        li.appendChild(open); ul.appendChild(li);
      });
      j.items.forEach(function(b){
        var li = bookLi(b, 'archive');
        if (canManage(b)) {
          var mv = document.createElement('button'); mv.className = 'act quiet'; mv.type = 'button'; mv.textContent = 'Move'; mv.setAttribute('aria-label', 'Move ' + b.title + ' to another folder');
          mv.onclick = async function(){ var to = prompt('Move "' + b.title + '" to which folder?', b.path || archivePath); if (to === null) return; try { await api('/archive/batch', { json: { ids: [b.id], action: 'move', to: to } }); say('Moved.'); loadArchive(archivePath, archivePage, true); } catch(e) { say(e.message); } };
          var del = document.createElement('button'); del.className = 'act quiet'; del.type = 'button'; del.textContent = 'Delete'; del.setAttribute('aria-label', 'Delete ' + b.title + ' from the library');
          del.onclick = async function(){ if (!confirm('Delete "' + b.title + '" from the library for everyone?')) return; try { await api('/book/' + b.id, { method: 'DELETE' }); say('Deleted.'); loadArchive(archivePath, archivePage, true); } catch(e) { say(e.message); } };
          li.appendChild(mv); li.appendChild(del);
        }
        ul.appendChild(li);
      });
      if (archivePath && (librarian || j.items.some(canManage))) {
        var tools = document.createElement('li'); tools.className = 'folder';
        var mvf = document.createElement('button'); mvf.className = 'act quiet'; mvf.type = 'button'; mvf.textContent = 'Move or rename this folder';
        mvf.onclick = async function(){ var to = prompt('New name or place for the folder "' + archivePath + '"', archivePath); if (to === null || to === archivePath) return; try { var r = await api('/archive/move-folder', { json: { from: archivePath, to: to } }); say('Moved ' + r.moved + ' item' + (r.moved === 1 ? '' : 's') + ' to ' + r.to + '.'); loadArchive(r.to, 0, true); } catch(e) { say(e.message); } };
        tools.appendChild(mvf); ul.appendChild(tools);
      }
      var pages = Math.ceil(j.total / j.limit);
      $('archivePager').hidden = pages <= 1;
      $('pageInfo').textContent = 'Page ' + (j.page + 1) + ' of ' + pages + ' (' + j.total + ' items here)';
      $('pagePrev').disabled = j.page <= 0; $('pageNext').disabled = j.page + 1 >= pages;
      // Part 296: the shelf is said by its display names ("Audio, Described audio movies and TV, Described audio movies")
      var turned = focus && focus !== true;
      if (focus === true) focusOn(here);
      else if (turned && (focus.disabled || $('archivePager').hidden)) { var other = focus === $('pageNext') ? $('pagePrev') : $('pageNext'); focusOn($('archivePager').hidden || other.disabled ? here : other); }
      restoreReturn(['archiveList'], !quiet);
      if (quiet) return;
      if (turned && pages > 1) { say($('pageInfo').textContent + '.'); return; }
      if (path !== undefined) say((named && named.length ? named.map(function(c){ return c.name; }).join(', ') : (archivePath || 'The archive')) + ': ' + j.folders.length + ' folder' + (j.folders.length === 1 ? '' : 's') + ', ' + j.total + ' clip' + (j.total === 1 ? '' : 's') + '.');
    } catch(e) {
      if (run !== archiveRun) return;
      ul.innerHTML = '<li class="muted">' + esc(e.message) + '</li>';
      restoreReturn(['archiveList'], true);
      if (!quiet) say(e.message);
      if (focus && (!document.activeElement || document.activeElement === document.body)) focusOn($('pageTitle'));
    }
  }
  $('pagePrev').onclick = function(){ loadArchive(archivePath, archivePage - 1, this); };
  $('pageNext').onclick = function(){ loadArchive(archivePath, archivePage + 1, this); };

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
        open.onclick = function(){ visit('?collection=' + c.id); };
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
    if (sb.type === 'report') what = 'Wrong shelf: ' + what + (sb.suggestedPath ? ' → ' + esc(sb.suggestedPath) : '') + (sb.suggestedCategory ? ' (' + esc(sb.suggestedCategory) + ')' : '');
    li.innerHTML = '<span class="t book"><strong>' + what + '</strong><span class="meta">' + (review ? 'from ' + esc(sb.userName) + ' · ' : '') + esc(state) + (when ? ' · ' + when : '') + (sb.url ? ' · <a href="' + esc(sb.url) + '" target="_blank" rel="noopener">open the link</a>' : '') + (sb.note ? ' · ' + esc(sb.note) : '') + (sb.decisionNote ? ' · librarian: ' + esc(sb.decisionNote) : '') + (sb.fetchedAt ? ' · fetched' : '') + '</span></span>';
    if (review && sb.status === 'pending') {
      var ok = document.createElement('button'); ok.className = 'act primary'; ok.type = 'button'; ok.textContent = sb.type === 'report' ? 'Move it there' : 'Approve'; ok.setAttribute('aria-label', 'Approve ' + (sb.title || sb.url || 'this file'));
      ok.onclick = async function(){ var note = prompt('A word for ' + sb.userName + '? (optional)') || ''; try { await api('/submissions/' + sb.id + '/decide', { json: { status: 'approved', note: note } }); say('Approved.'); await loadSubmissions(); focusOn($('h-review')); } catch(e) { say(e.message); } };
      var no = document.createElement('button'); no.className = 'act quiet'; no.type = 'button'; no.textContent = sb.type === 'report' ? 'Leave it' : 'Decline'; no.setAttribute('aria-label', 'Decline ' + (sb.title || sb.url || 'this file'));
      no.onclick = async function(){ var note = prompt('Tell ' + sb.userName + ' why? (optional)') || ''; try { await api('/submissions/' + sb.id + '/decide', { json: { status: 'rejected', note: note } }); say('Declined.'); await loadSubmissions(); focusOn($('h-review')); } catch(e) { say(e.message); } };
      li.appendChild(ok); li.appendChild(no);
    } else if (!review && sb.status === 'pending') {
      var rm = document.createElement('button'); rm.className = 'act quiet'; rm.type = 'button'; rm.textContent = 'Withdraw'; rm.setAttribute('aria-label', 'Withdraw ' + (sb.title || sb.url || 'this submission'));
      rm.onclick = async function(){ try { await api('/submissions/' + sb.id, { method: 'DELETE' }); say('Withdrawn.'); await loadSubmissions(); focusOn($('h-mysubs')); } catch(e) { say(e.message); } };
      li.appendChild(rm);
    }
    if (sb.book) { var open = document.createElement('button'); open.className = 'act quiet'; open.type = 'button'; open.textContent = 'Open the file'; open.onclick = function(){ visit('?book=' + sb.book); }; li.appendChild(open); }
    return li;
  }
  async function loadSubmissions(){
    try {
      var mine = await api('/submissions?all=0');
      if (VIEW !== 'librarian') {
        var ul = $('mySubs'); ul.innerHTML = '';
        if (!mine.submissions.length) ul.innerHTML = '<li class="muted">Nothing submitted yet.</li>';
        mine.submissions.forEach(function(sb){ ul.appendChild(subLi(sb, false)); });
        return;
      }
      $('reviewNo').hidden = !!mine.librarian;
      if (mine.librarian) {
        var all = await api('/submissions?status=pending'); var rl = $('reviewList'); rl.innerHTML = '';
        $('reviewWrap').hidden = false;
        try { var ss = await api('/librarian/sort-status'); $('sortStatus').textContent = (ss.unsorted ? ss.unsorted + ' book' + (ss.unsorted === 1 ? '' : 's') + ' still without a shelf. ' : 'Every book has a shelf. ') + 'The librarian files a batch every few minutes on her own; press to do one now.'; } catch(e) {}
        if (!all.submissions.length) rl.innerHTML = '<li class="muted">Nothing waiting.</li>';
        all.submissions.forEach(function(sb){ rl.appendChild(subLi(sb, true)); });
      }
    } catch(e) { $(VIEW === 'librarian' ? 'reviewList' : 'mySubs').innerHTML = '<li class="muted">' + esc(e.message) + '</li>'; }
  }
  $('sortBtn').onclick = async function(){
    this.disabled = true; say('Sorting a batch…');
    try { var r = await api('/librarian/sort-books', { method: 'POST' }); say('Filed ' + r.filed + ' book' + (r.filed === 1 ? '' : 's') + '. ' + r.unsorted + ' still to go.'); loadSubmissions(); } catch(e) { say(e.message); }
    this.disabled = false;
  };
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
  async function openCollection(id, focus){
    try {
      var c = await api('/collections/' + id);
      $('shelf').classList.add('hidden'); $('collection').classList.remove('hidden');
      $('collTitle').textContent = c.title;
      document.title = c.title + ' — playlist — The Library — Kade-AI';
      $('collMeta').textContent = c.items.length + ' item' + (c.items.length === 1 ? '' : 's') + (c.mine ? (c.shared ? ' · shared with the family' : ' · private') : ' · by ' + c.ownerName) + (c.description ? ' · ' + c.description : '');
      var ol = $('collItems'); ol.innerHTML = '';
      c.items.forEach(function(it, i){
        var li = document.createElement('li');
        li.innerHTML = '<span class="t book"><strong>' + (i + 1) + '. ' + esc(it.title) + '</strong><span class="meta">' + esc((it.book.author ? it.book.author + ' · ' : '') + typeWord(it.book) + (it.seconds ? ' · ' + clock(it.seconds) : '')) + '</span></span>';
        var play = document.createElement('button'); play.className = 'act'; play.type = 'button'; play.textContent = 'Play'; play.setAttribute('aria-label', 'Play ' + it.title);
        play.onclick = function(){ queue = c.items.slice(i + 1).map(function(x){ return x.book.id; }); try { sessionStorage.setItem(RETURN_KEY, JSON.stringify({ id: it.book.id, host: 'collItems', at: Date.now(), from: BASE + '?collection=' + encodeURIComponent(id) })); } catch(e) {} visit('?book=' + it.book.id + '&track=' + it.track + '&q=' + encodeURIComponent(queue.join(','))); };
        li.appendChild(play);
        if (c.mine) { var rm = document.createElement('button'); rm.className = 'act quiet'; rm.type = 'button'; rm.textContent = 'Remove'; rm.setAttribute('aria-label', 'Remove ' + it.title + ' from this collection'); rm.onclick = async function(){ try { await api('/collections/' + id + '/edit', { json: { remove: it.n } }); say('Removed.'); openCollection(id, true); } catch(e) { say(e.message); } }; li.appendChild(rm); }
        ol.appendChild(li);
      });
      $('collPlayAll').onclick = function(){ if (!c.items.length) { say('It is empty.'); return; } $('collItems').querySelector('button').click(); };
      $('collShareBtn').hidden = !c.mine; $('collDeleteBtn').hidden = !c.mine;
      $('collShareBtn').textContent = c.shared ? 'Make it private' : 'Share it with the family';
      $('collShareBtn').onclick = async function(){ try { await api('/collections/' + id + '/edit', { json: { shared: !c.shared } }); openCollection(id, true); say(c.shared ? 'Private now.' : 'Shared with the family.'); } catch(e) { say(e.message); } };
      $('collDeleteBtn').onclick = async function(){ if (!confirm('Delete the collection "' + c.title + '"? The items themselves stay in the library.')) return; try { await api('/collections/' + id, { method: 'DELETE' }); visit('/playlists'); } catch(e) { say(e.message); } };
      if (focus) focusOn($('collTitle')); else say('Collection ' + c.title + ', ' + c.items.length + ' items.');
    } catch(e) { say(e.message); visit('/playlists'); }
  }
  $('collBack').onclick = function(){ visit('/playlists'); };
  $('reportBtn').onclick = async function(){
    if (!book) return;
    var to = prompt('Where does "' + book.title + '" belong? A folder like Books/Fiction — Romance or Video/Commercials/Coffee & Tea (leave blank to just leave a note).', book.path || '');
    if (to === null) return;
    var note = prompt('Anything else the librarian should know? (optional)') || '';
    try { var r = await api('/book/' + book.id + '/report', { json: { path: to, note: note } }); say(r.applied ? 'Moved.' : 'Sent to the librarian. You will be told when it is moved.'); } catch(e) { say(e.message); }
  };
  /* Nov 10 2026: adding to a playlist is a menu of your playlists (with "A new playlist" last) and
     an Add button, in the page. It was a browser prompt that read out a numbered list and asked
     for a number to be typed. Focus goes to the menu when it opens and back to the button after. */
  $('addCollBtn').onclick = async function(){
    if (!book) return;
    try {
      collections = await api('/collections');
      var sel = $('addCollSel'); sel.innerHTML = '';
      collections.mine.forEach(function(c){ var o = document.createElement('option'); o.value = c.id; o.textContent = c.title + ' (' + c.count + ' item' + (c.count === 1 ? '' : 's') + ')'; sel.appendChild(o); });
      var fresh = document.createElement('option'); fresh.value = ''; fresh.textContent = 'A new playlist'; sel.appendChild(fresh);
      sel.onchange = function(){ $('addCollNewWrap').hidden = sel.value !== ''; };
      sel.onchange();
      $('addCollPanel').hidden = false; focusOn(sel);
    } catch(e) { say(e.message); }
  };
  $('addCollCancel').onclick = function(){ $('addCollPanel').hidden = true; focusOn($('addCollBtn')); };
  $('addCollGo').onclick = async function(){
    if (!book) return;
    try {
      var sel = $('addCollSel'), target = null;
      if (sel.value) target = collections.mine.filter(function(c){ return c.id === sel.value; })[0];
      else {
        var name = $('addCollNew').value.trim();
        if (!name) { say('Give the new playlist a name first.'); focusOn($('addCollNew')); return; }
        var made = await api('/collections', { json: { title: name } }); target = made.collection;
      }
      if (!target) { say('Choose a playlist first.'); return; }
      await api('/collections/' + target.id + '/items', { json: { book: book.id, track: pos.s } });
      $('addCollPanel').hidden = true; $('addCollNew').value = ''; focusOn($('addCollBtn'));
      say('Added to ' + target.title + '.');
    } catch(e) { say(e.message); }
  };

  $('bookUploadBtn').onclick = async function(){
    var f = $('bookFile').files[0];
    if (!f) { say('Pick a book file first.'); return; }
    var btn = this; btn.disabled = true; say('Reading ' + f.name + '… large audiobooks can take several minutes. Keep this page open.');
    try {
      if (!me) { var who = await api('/shelf'); me = who.me; filesRule = who.filesMode || ''; }
      if (!me) throw new Error('Could not identify your account. Reload before uploading.');
      var keepPrivate = $('bookPrivate').checked, grown = $('bookGrownUps').checked;
      var recoveryKey = 'library-import:' + JSON.stringify([me, f.name, f.size, f.lastModified, keepPrivate, grown]);
      var requestId = localStorage.getItem(recoveryKey);
      if (!requestId) { requestId = crypto.randomUUID(); localStorage.setItem(recoveryKey, requestId); }
      var sha256 = await fileSha256(f);
      var job = await api('/imports', { json: { requestId: requestId, fileName: f.name, bytes: f.size, private: keepPrivate, grownUpsOnly: grown, sha256: sha256 || undefined } });
      if (job.uploadRequired) {
        say('Sending ' + f.name + ' directly to storage…');
        var lastBookPercent = -1;
        await putDirect(job.url, f, job.mime, function(p){ var n = Math.floor(p * 10) * 10; if(n !== lastBookPercent) { lastBookPercent = n; say('Book upload: ' + n + ' percent.'); } });
      }
      if (job.state !== 'ready') job = await api('/imports/' + job.id + '/commit', { json: {} });
      if (job.state !== 'ready') say('The file is stored. Preparing the book… You can return and select this same file to check it.');
      while (job.state !== 'ready') {
        if (job.state === 'failed') throw new Error(job.error || 'Import failed. Retry this same file to recover the saved job.');
        await new Promise(function(resolve){ setTimeout(resolve, 8500); });
        job = await api('/imports/' + job.id);
      }
      var j = job.result;
      if (!j || !j.book) throw new Error('The import receipt is incomplete. Select the same file to check it again.');
      if (j.duplicate) say(j.message || (j.same === 'file'
        ? 'Already in the library: ' + j.book.title + '. It is exactly the same file, so it is kept once.'
        : 'Already in the library: ' + j.book.title + (j.book.author ? ' by ' + j.book.author : '') + '. It has exactly the same text, so nothing new was added.'));
      else say('Added: ' + j.book.title + (j.book.author ? ' by ' + j.book.author : '') + '. ' + (j.book.kind === 'text' ? j.book.sections : j.book.tracks) + ' sections, about ' + j.book.listen + '. ' + (j.skipped.length ? j.skipped.length + ' front-matter parts skipped.' : ''));
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
      var j = await api('/media/new', { json: { title: title, author: $('auAuthor').value, year: $('auYear').value, category: $('auCategory').value, description: $('auDesc').value, grownUpsOnly: $('auGrownUps').checked, private: $('auPrivate').checked } });
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
      x.onload = function(){ (x.status >= 200 && x.status < 300) ? resolve(x.getResponseHeader('ETag')) : reject(new Error('storage answered ' + x.status)); };
      x.onerror = function(){ reject(new Error('direct upload blocked')); };
      x.send(file);
    });
  }
  /* The one-file rule (Sep 25 2026): the file's SHA-256, so the server can say before anything is
     sent that exactly this file is already a copy you can open. Only when the server's rule is 'on'
     (the only mode that uses it) and only up to 200 MB: the browser holds the whole file in memory
     to hash it, which a phone may not survive. Otherwise no hash is sent and the server compares
     the stored bytes after the upload. */
  async function fileSha256(file){
    try {
      if (filesRule !== 'on' || !file || file.size > 200 * 1024 * 1024 || !window.crypto || !crypto.subtle) return '';
      say('Checking whether this exact file is already in the library…');
      var digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      return Array.prototype.map.call(new Uint8Array(digest), function(b){ return ('0' + b.toString(16)).slice(-2); }).join('');
    } catch(e) { return ''; }
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
      if (!me) { var who = await api('/shelf'); me = who.me; filesRule = who.filesMode || ''; }
      if (!me) throw new Error('Could not identify your account. Reload before uploading.');
      var pendingKey = 'library-track-pending:' + me + ':' + auItem.id;
      var pending = localStorage.getItem(pendingKey);
      if (pending) {
        var recovered = await api('/media/' + auItem.id + '/track/done', { json: JSON.parse(pending) });
        localStorage.removeItem(pendingKey); auItem = recovered.item;
        say('The previous recording is saved. Select the next file when ready.');
        $('auFile').value = ''; btn.disabled = false; loadShelf(); return;
      }
      var seconds = await fileSeconds(f);
      var lastPct = -1;
      var onProgress = function(p){ var pct = Math.round(p * 10) * 10; if (pct !== lastPct && pct % 20 === 0) { lastPct = pct; say('Uploading… ' + pct + ' percent.'); } };
      var sha256 = await fileSha256(f);
      var pre = await api('/media/' + auItem.id + '/track/presign', { json: { fileName: f.name, mime: f.type, bytes: f.size, multipart: true, sha256: sha256 || undefined } });
      if (pre.duplicate) {
        $('auFile').value = ''; btn.disabled = false;
        if (pre.removed) {
          /* The empty item she had just started is gone (nothing was uploaded): close the part adder
             and put focus somewhere real before the message is read. */
          $('auTracks').classList.add('hidden'); auItem = null;
          focusOn($('pageTitle'));
        }
        say(pre.message || ('Nothing was uploaded: this exact file is already in the library as "' + (pre.existing || pre.book || {}).title + '".'));
        return;
      }
      say('Uploading ' + f.name + ' straight to storage…');
      var receipt = { key: pre.key, title: title, bytes: f.size, seconds: seconds, originalName: f.name };
      if (pre.multipart) {
        var completed = [];
        for (var part of pre.multipart.parts) {
          var from = (part.partNumber - 1) * pre.multipart.partBytes;
          var blob = f.slice(from, Math.min(f.size, from + pre.multipart.partBytes));
          var etag = await putDirect(part.url, blob, pre.mime, function(p){ onProgress((from + blob.size * p) / f.size); });
          if (!etag) throw new Error('Storage did not return a part receipt. Retry the upload; no server-upload fallback was used.');
          completed.push({ partNumber: part.partNumber, etag: etag });
        }
        receipt.multipart = { uploadId: pre.multipart.uploadId, parts: completed };
      } else await putDirect(pre.url, f, pre.mime, onProgress);
      // A lost final receipt can be retried with this exact key and part list.
      localStorage.setItem('library-track-pending:' + me + ':' + auItem.id, JSON.stringify(receipt));
      var done = await api('/media/' + auItem.id + '/track/done', { json: receipt });
      localStorage.removeItem('library-track-pending:' + me + ':' + auItem.id);
      auItem = done.item;
      var li = document.createElement('li'); li.textContent = (title || ('Part ' + auItem.tracks)) + ' — uploaded'; $('auTrackList').appendChild(li);
      $('auTracksHint').textContent = '"' + auItem.title + '" — ' + auItem.tracks + ' part' + (auItem.tracks === 1 ? '' : 's') + ' so far.';
      $('auFile').value = ''; $('auTrackTitle').value = '';
      say('Part ' + auItem.tracks + ' added to ' + auItem.title + '. Add another, or press Done.');
      loadShelf();
    } catch(e) { say(e.message); }
    btn.disabled = false;
  };
  $('auDoneBtn').onclick = function(){ location.href = BASE + '/continue'; };
  /* "Add parts" on a shelf row comes here with the item named in the address. */
  async function startAdd(){
    var parts = new URLSearchParams(location.search).get('parts');
    if (!parts) return;
    try { var it = await api('/book/' + parts); if (it.kind === 'text') return; openTrackAdder({ id: it.id, title: it.title, tracks: (it.tracks || []).length }); say('Add a part to ' + it.title + '.'); }
    catch(e) { say('Could not open that item: ' + e.message); }
  }

  /* ── player ────────────────────────────────────────────────────────── */
  var book = null, pos = { s: 0, c: 0 }, playing = false, voice = '', speed = 1;
  /* Oct 30 2026: the audio route lets the browser keep a clip for an hour, keyed by its URL, and
   * the same speed number now sounds different. This makes old clips unreachable. */
  var AUDIO_PACING = '&pacing=4';
  var ctx = null, gainNode = null, scheduled = [], nextStart = 0, cache = {}, fetching = {}, ended = false, playToken = 0;
  var delivery = localStorage.getItem('kade.library.delivery') || 'STABLE';
  var fileAudio = $('fileMedia');
  var isAudio = function(){ return book && book.kind !== 'text'; };
  var isVideoTrack = function(){ return book && book.tracks && book.tracks[pos.s] && /^video\\//.test(book.tracks[pos.s].mime || ''); };
  var queue = []; // collection playback: item ids still to play
  var autoplayNext = false;
  /* Sep 24 2026: the reading view (client/public/assets/library/reader.js) reads the
     same book beside the narration; it keeps its own place and marks the narrated passage. */
  // A missing reader.js costs the reading view, never the whole page (its button stays hidden).
  var libraryReader = window.createLibraryReader
    ? window.createLibraryReader({ api: api, book: function(){ return book; }, position: function(){ return pos; }, isPlaying: function(){ return playing; }, play: play, pause: pause, person: function(){ return me; } })
    : { open: function(){}, narrationChanged: function(){}, playback: function(){}, isOpen: function(){ return false; }, say: function(){ return false; } };
  $('readingViewBtn').onclick = function(){ libraryReader.open(); };

  function chapterTitle(s){ var ch = isAudio() ? book.tracks[s] : book.chapters[s]; return ch ? ch.title : ''; }
  function announcePosition(prefix){
    var t = chapterTitle(pos.s);
    say((prefix ? prefix + ' ' : '') + (isAudio() ? 'Part ' : 'Chapter ') + (pos.s + 1) + ' of ' + (isAudio() ? book.tracks.length : book.chapters.length) + (t ? ': ' + t : ''));
  }
  var saveTimer = null;
  function saveProgress(now){
    clearTimeout(saveTimer);
    var body = { s: pos.s, c: pos.c, voice: voice, speed: speed };
    if (isAudio()) body.pos = trackPosition();
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
    var requestedBook = book.id;
    libraryReader.narrationChanged(p);
    try { var j = await api('/book/' + requestedBook + '/text/' + p.s + '/' + p.c); if (requestedBook === book.id && p.s === pos.s && p.c === pos.c) $('nowText').textContent = j.text; } catch(e) {}
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
    streamAbort = new AbortController();
    var r = await fetch(API + '/book/' + book.id + '/audio/' + p.s + '/' + p.c + '?voice=' + encodeURIComponent(voice) + '&speed=' + speed + AUDIO_PACING + '&delivery=' + encodeURIComponent(delivery), { signal: streamAbort.signal, headers: { 'Authorization': 'Bearer ' + token_() } });
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
  var cursorTimer = null, streamAbort = null;
  function updateCursor(){
    if (!pipe || !playing || !ctx) return;
    while (pipe.markers.length && ctx.currentTime >= pipe.markers[0].at) {
      var m = pipe.markers.shift();
      if (m.end) { finishBook(); return; }
      if (m.pos) { var changed = m.pos.s !== pos.s; pos = m.pos; showText(pos); saveProgress(); updateSession(); if (changed && !libraryReader.isOpen()) announcePosition(''); }
    }
  }
  function stopScheduled(){
    playToken++;
    clearInterval(cursorTimer); cursorTimer = null;
    if (streamAbort) { streamAbort.abort(); streamAbort = null; }
    if (ctx && ctx.state === 'running') ctx.suspend();
    if (pipe) { pipe.sources.forEach(function(src){ try { src.onended = null; src.stop(); } catch(e) {} }); }
    pipe = null;
  }
  function finishBook(){ stopScheduled(); playing = false; finished = true; showState(); $('playBtn').textContent = 'Play'; libraryReader.playback(); say('The end. ' + book.title + ' is finished.'); api('/book/' + book.id + '/progress', { json: { s: pos.s, c: pos.c, finished: true } }).catch(function(){}); }
  function play(){
    if (!book) return;
    finished = false;
    if (isAudio()) { fileAudio.play().then(function(){ playing = true; $('playBtn').textContent = 'Pause'; updateSession(); }).catch(function(e){ say('Could not play: ' + e.message); }); return; }
    stopScheduled();
    ensureCtx();
    playing = true; ended = false; $('playBtn').textContent = 'Pause'; libraryReader.playback();
    var t = playToken;
    showText(pos);
    cursorTimer = setInterval(updateCursor, 200);
    runPipeline(t);
    updateSession();
  }
  function pause(){
    playing = false; $('playBtn').textContent = 'Play';
    libraryReader.playback();
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
    var setTime = function(){ try { fileAudio.currentTime = (t.clipBegin || 0) + (at || 0); } catch(e) {} };
    if (fileAudio.readyState >= 1) setTime(); else fileAudio.addEventListener('loadedmetadata', setTime, { once: true });
    fileAudio.playbackRate = speed;
    $('nowText').textContent = t.title + (t.seconds ? ' — ' + clock(t.seconds) : '');
    /* A recording with no picture is played through this element but is not a place to stop: it
       has no controls of its own, takes no focus and is hidden from screen readers. The buttons
       and the position slider above are its controls. A video keeps the browser's own controls. */
    var hasPicture = (t.mime || '').indexOf('video/') === 0;
    fileAudio.classList.toggle('audioonly', !hasPicture);
    fileAudio.controls = hasPicture;
    if (hasPicture) { fileAudio.removeAttribute('tabindex'); fileAudio.removeAttribute('aria-hidden'); }
    else { fileAudio.setAttribute('tabindex', '-1'); fileAudio.setAttribute('aria-hidden', 'true'); }
    seekShown = -1; $('seekWrap').hidden = true; showSeek(true);
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
  function finishTrack(){
    if (descPausedFor) return;
    if (pos.s + 1 < book.tracks.length) { loadTrack(pos.s + 1, 0, true); announcePosition(''); }
    else if (queue.length) { var nextId = queue.shift(); say('Next in the collection.'); autoplayNext = true; try { history.replaceState(null, '', '?book=' + nextId + (queue.length ? '&q=' + queue.join(',') : '')); } catch(e) {} openBook(nextId); }
    else finishBook();
  }
  fileAudio.addEventListener('ended', finishTrack);
  function trackPosition(){ var t = book && book.tracks[pos.s]; return Math.max(0, fileAudio.currentTime - (t && t.clipBegin || 0)); }
  fileAudio.addEventListener('timeupdate', function(){ var t = book && book.tracks[pos.s]; if (playing && t && t.clipEnd != null && fileAudio.currentTime >= t.clipEnd) { finishTrack(); return; } if (playing && Math.floor(trackPosition()) % 10 === 0) saveProgress(); });
  fileAudio.addEventListener('pause', function(){ if (playing && !fileAudio.ended) { playing = false; $('playBtn').textContent = 'Play'; } showState(); showSeek(true); });

  function back(){ if (isAudio()) { fileAudio.currentTime = Math.max(book.tracks[pos.s].clipBegin || 0, fileAudio.currentTime - 15); say('Back 15 seconds.'); return; } var p = prevPos(pos); if (p) seekTo(p, false); else say('This is the beginning.'); }
  function forward(){ if (isAudio()) { fileAudio.currentTime = Math.min(book.tracks[pos.s].clipEnd || fileAudio.duration || 1e9, fileAudio.currentTime + 15); say('Forward 15 seconds.'); return; } var p = nextPos(pos); if (p) seekTo(p, false); else say('This is the end.'); }
  function partWord(){ return isAudio() ? 'part' : 'chapter'; }
  function prevSection(){ var target = pos.s; if (isAudio() ? trackPosition() < 5 : pos.c === 0) target = pos.s - 1; if (target < 0) { say('This is the first ' + partWord() + '.'); return; } seekTo({ s: target, c: 0, pos: 0 }, true); }
  function nextSection(){ var n = pos.s + 1; var count = isAudio() ? book.tracks.length : book.chapters.length; if (n >= count) { say('This is the last ' + partWord() + '.'); return; } seekTo({ s: n, c: 0, pos: 0 }, true); }
  /* Nov 10 2026: a recording shows where it is ("0:40 of 2:05"). Plain text, not a live region:
     it is there to be looked at or read on purpose, and is never spoken by itself. */
  var timeShown = '';
  function showTime(){
    var t = book && book.tracks && book.tracks[pos.s]; if (!t || !isAudio()) return;
    var total = t.seconds || (t.clipEnd != null ? t.clipEnd - (t.clipBegin || 0) : fileAudio.duration) || 0;
    var text = clock(trackPosition()) + (isFinite(total) && total > 0 ? ' of ' + clock(total) : '');
    if (text !== timeShown) { timeShown = text; $('timeLine').textContent = text; }
  }
  fileAudio.addEventListener('timeupdate', showTime); fileAudio.addEventListener('seeked', showTime); fileAudio.addEventListener('loadedmetadata', showTime);
  /* Nov 10 2026 (redesign): the position slider. One labelled control for audio and video: a seek
     bar for the eye, and for a screen reader a slider that says "40 seconds of 2 minutes 5 seconds".
     Arrow keys on it move 5 seconds (1 second in a clip under two minutes). While playing it moves
     in five-second hops, and it holds still while it has keyboard focus, so a screen reader resting
     on it is not told the time over and over; the clock line beside it keeps running. */
  function spokenTime(sec){
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), r = sec % 60, out = [];
    if (h) out.push(h + (h === 1 ? ' hour' : ' hours'));
    if (m) out.push(m + (m === 1 ? ' minute' : ' minutes'));
    if (r || !out.length) out.push(r + (r === 1 ? ' second' : ' seconds'));
    return out.join(' ');
  }
  function trackLength(){
    var t = book && book.tracks && book.tracks[pos.s]; if (!t) return 0;
    var total = t.seconds || (t.clipEnd != null ? t.clipEnd - (t.clipBegin || 0) : fileAudio.duration) || 0;
    return isFinite(total) && total > 0 ? total : 0;
  }
  var seekBar = $('seekBar'), seekShown = -1;
  function showSeek(force){
    if (!book || !isAudio()) return;
    var total = Math.floor(trackLength()), at = Math.min(Math.floor(trackPosition()), total || 0);
    $('seekWrap').hidden = !total;
    if (!total) return;
    if (String(total) !== seekBar.max) { seekBar.max = String(total); seekBar.step = total > 120 ? '5' : '1'; force = true; }
    var held = false; try { held = playing && document.activeElement === seekBar && seekBar.matches(':focus-visible'); } catch(e) {}
    if (!force && (held || (playing && Math.abs(at - seekShown) < 5))) return;
    seekShown = at; seekBar.value = String(at);
    seekBar.setAttribute('aria-valuetext', spokenTime(at) + ' of ' + spokenTime(total));
    try { if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) navigator.mediaSession.setPositionState({ duration: total, playbackRate: fileAudio.playbackRate || 1, position: Math.min(at, total) }); } catch(e) {}
  }
  fileAudio.addEventListener('timeupdate', function(){ showSeek(false); });
  fileAudio.addEventListener('seeked', function(){ showSeek(true); });
  fileAudio.addEventListener('loadedmetadata', function(){ showSeek(true); showCaptions(); });
  seekBar.addEventListener('input', function(){
    var at = Number(this.value) || 0, total = Number(this.max) || 0;
    this.setAttribute('aria-valuetext', spokenTime(at) + ' of ' + spokenTime(total));
    timeShown = clock(at) + ' of ' + clock(total); $('timeLine').textContent = timeShown;
  });
  seekBar.addEventListener('change', function(){
    if (!book || !isAudio()) return;
    var t = book.tracks[pos.s], at = Number(this.value) || 0;
    try { fileAudio.currentTime = (t.clipBegin || 0) + at; } catch(e) {}
    seekShown = at; saveProgress();
  });
  /* Captions and spoken description, in one plain row right under the controls.
     Captions: the button is there when the file carries a caption or subtitle track, and the choice
     is remembered. Spoken description: when this video has a description, one button turns
     "pause and describe each scene" on or off (the same switch as the box further down); when it
     has none yet, one button goes to where a description is made. */
  var captionsOn = localStorage.getItem('kade.library.captions') === '1';
  function captionTracks(){ var out = []; try { for (var i = 0; i < fileAudio.textTracks.length; i++) { var kind = fileAudio.textTracks[i].kind; if (kind === 'captions' || kind === 'subtitles') out.push(fileAudio.textTracks[i]); } } catch(e) {} return out; }
  function showAccessRow(){ $('accessRow').hidden = $('captionsBtn').hidden && $('descToggleBtn').hidden && $('descFindBtn').hidden; }
  function showCaptions(){
    var tracks = captionTracks();
    $('captionsBtn').hidden = !tracks.length;
    tracks.forEach(function(track, i){ try { track.mode = captionsOn && i === 0 ? 'showing' : 'disabled'; } catch(e) {} });
    $('captionsBtn').textContent = 'Captions: ' + (captionsOn ? 'on' : 'off');
    showAccessRow();
  }
  $('captionsBtn').onclick = function(){ captionsOn = !captionsOn; localStorage.setItem('kade.library.captions', captionsOn ? '1' : '0'); showCaptions(); say(captionsOn ? 'Captions on.' : 'Captions off.'); };
  function showDescToggle(){
    var t = book && book.tracks && book.tracks[pos.s], video = !!(t && (t.mime || '').indexOf('video/') === 0);
    var done = !!(video && t.description && t.description.state === 'done');
    $('descToggleBtn').hidden = !done;
    $('descToggleBtn').textContent = 'Spoken description: ' + ($('descMode').checked ? 'on' : 'off');
    $('descFindBtn').hidden = !video || done;
    showAccessRow();
  }
  $('descToggleBtn').onclick = function(){ $('descMode').checked = !$('descMode').checked; $('descMode').onchange(); };
  $('descFindBtn').onclick = function(){ $('descWrap').open = true; focusOn($('descBtn')); try { $('descWrap').scrollIntoView({ block: 'nearest' }); } catch(e) {} };
  if ('mediaSession' in navigator) { try { navigator.mediaSession.setActionHandler('seekto', function(d){ if (!book || !isAudio() || !d || typeof d.seekTime !== 'number') return; var t = book.tracks[pos.s]; fileAudio.currentTime = (t.clipBegin || 0) + d.seekTime; }); } catch(e) {} }

  /* The state line, in words for the eye: Playing or Paused, which part, and the speed when it is
     not normal. It is plain text beside the controls (not a live region): the Play button's own
     name and the one status line already tell a screen reader what changed. */
  var finished = false;
  function showState(){
    if (!book) return;
    var count = isAudio() ? book.tracks.length : book.chapters.length, t = chapterTitle(pos.s);
    var where = count > 1 || (t && t !== book.title) ? (isAudio() ? 'Part ' : 'Chapter ') + (pos.s + 1) + ' of ' + count + (t ? ': ' + t : '') : '';
    $('playState').textContent = (playing ? 'Playing' : (finished ? 'Finished' : 'Paused')) + (where ? ' · ' + where : '') + (speed !== 1 ? ' · ' + speed + ' times speed' : '');
  }
  function updateSession(){
    showState();
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
      var j = await api('/book/' + book.id + '/bookmarks', { json: { s: pos.s, c: pos.c, pos: isAudio() ? trackPosition() : 0 } });
      book.bookmarks.unshift(j.bookmark); renderBookmarks();
      say('Bookmark placed at ' + (isAudio() ? 'part ' : 'chapter ') + (pos.s + 1) + (isAudio() ? ', ' + clock(trackPosition()) : '') + '.');
    } catch(e) { say(e.message); }
  };
  /* Sep 12 2026, her word: "the voice picker doesn't have a way for you to
     preview which voice you're picking to read your audiobook". One button:
     the chunk she is on, in the voice the select shows, through a plain
     Audio element so it never tangles with the streamed reading pipe. */
  var previewAudio = null;
  $('hearVoiceBtn').onclick = async function(){
    if (!book || isAudio()) return;
    var sel = $('voiceSel'); var v = sel.value || voice;
    var name = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : v;
    if (previewAudio) { try { previewAudio.pause(); } catch(e) {} previewAudio = null; }
    if (playing) pause();
    say('A taste of ' + name + '. One moment.');
    try {
      var r = await fetch(API + '/book/' + book.id + '/audio/' + pos.s + '/' + pos.c + '?voice=' + encodeURIComponent(v) + '&speed=' + speed + AUDIO_PACING + '&delivery=' + encodeURIComponent(delivery), { signal: streamAbort.signal, headers: { 'Authorization': 'Bearer ' + token_() } });
      if (!r.ok) throw new Error('voice answered ' + r.status);
      var blob = await r.blob(); var url = URL.createObjectURL(blob);
      previewAudio = new Audio(url);
      previewAudio.onended = function(){ URL.revokeObjectURL(url); previewAudio = null; say('That was ' + name + '. Pick it, or try another.'); };
      await previewAudio.play();
    } catch(e) { say('That voice did not answer. Try another one.'); }
  };
  $('voiceSel').onchange = function(){ voice = this.value; cache = {}; var was = playing; if (was) { pause(); } saveProgress(true); say('Voice: ' + this.options[this.selectedIndex].text); if (was) play(); };
  $('deliverySel').value = delivery;
  $('deliverySel').onchange = function(){ delivery = this.value; localStorage.setItem('kade.library.delivery', delivery); cache = {}; var was = playing; if (was) { pause(); play(); } };
  $('followAlong').checked = localStorage.getItem('kade.library.followAlong') === '1';
  function followStyle(){ $('nowText').style.fontSize = $('followAlong').checked ? '1.5rem' : ''; $('nowText').style.lineHeight = $('followAlong').checked ? '1.9' : ''; $('nowText').style.border = $('followAlong').checked ? '3px solid #bb8800' : ''; }
  $('followAlong').onchange = function(){ localStorage.setItem('kade.library.followAlong', this.checked ? '1' : '0'); followStyle(); };
  followStyle();
  /* Oct 30 2026: a saved number off this list (another device's 1.2) shows as itself, never blank,
   * and keeps playing at that number until the reader changes it. */
  function showSpeed(n){
    var sel = $('speedSel'), opts = Array.prototype.slice.call(sel.options);
    if (!opts.some(function(o){ return parseFloat(o.value) === n; })) {
      var o = document.createElement('option');
      o.value = String(n); o.textContent = n + 'x'; o.setAttribute('aria-label', n + ' times');
      sel.insertBefore(o, opts.filter(function(x){ return parseFloat(x.value) > n; })[0] || null);
    }
    sel.value = String(n);
  }
  $('speedSel').onchange = function(){ speed = parseFloat(this.value) || 1; showState(); if (isAudio()) fileAudio.playbackRate = speed; else { cache = {}; var was = playing; if (was) pause(); if (was) play(); } saveProgress(true); };
  /* Keyboard shortcuts (Nov 10 2026 redesign), made so they never get in a screen reader's way:
     - they are only the player's while focus is in the player or nowhere, never in a text box, a
       menu or the position slider, and never on the video's own controls;
     - a key held with Ctrl, Alt or the Windows or Command key is left alone (Alt+Left is the
       browser's Back; screen readers build their commands on those keys);
     - Space on a button, a link or a box row still presses that thing;
     - one checkbox turns them all off, and every one is also a button.
     In NVDA's or JAWS's browse mode the screen reader takes plain keys itself, so nothing here
     clashes with its own single-letter keys. */
  var keysOn = localStorage.getItem('kade.library.keys') !== '0';
  $('keysOn').checked = keysOn;
  $('keysOn').onchange = function(){ keysOn = this.checked; localStorage.setItem('kade.library.keys', keysOn ? '1' : '0'); say(keysOn ? 'Keyboard shortcuts on.' : 'Keyboard shortcuts off.'); };
  document.addEventListener('keydown', function(ev){
    if (!keysOn || libraryReader.isOpen()) return;
    if (!book || $('player').classList.contains('hidden')) return;
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
    var target = ev.target, tag = (target && target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'VIDEO' || (target && target.isContentEditable)) return;
    if (target && target !== document.body && target !== document.documentElement && !$('player').contains(target)) return;
    // Space presses the focused button, link or summary; the arrows still move through the book
    if (ev.code === 'Space' && (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY')) return;
    if (ev.code === 'Space' || (!ev.shiftKey && (ev.key === 'k' || ev.key === 'K'))) { ev.preventDefault(); playing ? pause() : play(); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); ev.shiftKey ? prevSection() : back(); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); ev.shiftKey ? nextSection() : forward(); }
    else if (!ev.shiftKey && (ev.key === 'b' || ev.key === 'B')) { $('markBtn').click(); }
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
      rm.onclick = async function(){ try { await api('/book/' + book.id + '/bookmarks/' + b.id, { method: 'DELETE' }); book.bookmarks = book.bookmarks.filter(function(x){ return x.id !== b.id; }); renderBookmarks(); focusOn($('bookmarkSummary')); say('Bookmark removed.'); } catch(e) { say(e.message); } };
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
      var why = { 'bookshare-notice': 'accessibility notice', 'accessibility-notice': 'accessibility notice', copyright: 'copyright page', contents: 'contents list', publisher: 'publisher page', 'front-matter': 'front matter', 'back-matter': 'back matter' }[sk.reason] || sk.reason;
      li.innerHTML = '<span class="t">' + esc(sk.title) + ' <span class="muted">(' + esc(why) + ')</span></span>';
      var b = document.createElement('button'); b.className = 'act quiet'; b.type = 'button'; b.textContent = 'Play it';
      b.setAttribute('aria-label', 'Play the skipped part: ' + sk.title);
      b.onclick = async function(){
        pause(); ensureCtx();
        say('Reading the skipped part: ' + sk.title);
        for (var c = 0; c < sk.chunks; c++) {
          var r = await fetch(API + '/book/' + book.id + '/audio/' + sk.k + '/' + c + '?skipped=1&voice=' + encodeURIComponent(voice) + '&speed=' + speed + AUDIO_PACING + '&delivery=' + encodeURIComponent(delivery), { headers: { 'Authorization': 'Bearer ' + token } });
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
    var renames = {};
    try {
      var r = await fetch(TTS_BASE + '/voices.json'); var j = await r.json();
      var cats = j.categories || [];
      var hidden = j.hidden || [];
      var describe = j.describe || {};
      renames = j.renames || {};
      cats.forEach(function(c){
        var og = document.createElement('optgroup'); og.label = c.name;
        (c.voices || []).forEach(function(v){ if (hidden.indexOf(v) !== -1) return; var o = document.createElement('option'); o.value = v; o.textContent = describe[v] ? v + ' — ' + describe[v] : v; og.appendChild(o); });
        if (og.children.length) sel.appendChild(og);
      });
    } catch(e) {}
    var listed = function(v){ return [].some.call(sel.options, function(o){ return o.value === v; }); };
    /* Oct 16 2026: a book saved under a voice's old name shows that voice under its new
       name (both names speak with the same voice; nothing is saved until a new pick). */
    var shown = !listed(voice) && typeof renames[voice] === 'string' && listed(renames[voice]) ? renames[voice] : voice;
    if (!sel.options.length || !listed(shown)) {
      var o = document.createElement('option'); o.value = voice; o.textContent = voice; sel.insertBefore(o, sel.firstChild);
    }
    sel.value = shown;
  }
  /* the library's eyes */
  var descPausedFor = null, descTimer = null, descSpoken = {}, descAudio = null;
  function renderDescription(){
    var t = book && book.tracks && book.tracks[pos.s];
    var wrap = $('descWrap');
    if (!t || !/^video\\//.test(t.mime || '')) { wrap.hidden = true; showDescToggle(); return; }
    wrap.hidden = false;
    $('descCopyWrap').hidden = !describedVideo;
    $('descCopy').href = '/described-video?book=' + encodeURIComponent(book.id) + '&track=' + pos.s;
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
    showDescToggle();
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
  $('descMode').onchange = function(){ say(this.checked ? 'Descriptions on: the video pauses to describe each scene.' : 'Descriptions off.'); showDescToggle(); };

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
    var ed = $('editWrap');
    if (book.mine || librarian) {
      ed.classList.remove('hidden');
      $('edTitle').value = book.title || ''; $('edAuthor').value = book.author || ''; $('edYear').value = book.copyrightYear || ''; $('edDesc').value = book.description || '';
      $('edCategory').value = book.category || 'other'; $('edCategory').disabled = book.kind === 'text'; $('edPath').value = book.path || '';
    } else ed.classList.add('hidden');
    if (book.mine || librarian) {
      ow.classList.remove('hidden'); bw.classList.add('hidden');
      $('shareBtn').textContent = book.shared ? 'Take it out of the library' : (librarian ? 'Put it in the family library' : 'Submit this for the library');
      $('grownBtn').textContent = book.grownUpsOnly ? 'Grown-ups only: on (tap to allow kids)' : 'Grown-ups only: off (tap to hide from kids)';
    } else { ow.classList.add('hidden'); bw.classList.remove('hidden'); }
  }
  $('edSaveBtn').onclick = async function(){
    if (!book) return;
    try {
      var body = { title: $('edTitle').value, author: $('edAuthor').value, year: $('edYear').value, description: $('edDesc').value, path: $('edPath').value };
      if (book.kind !== 'text') body.category = $('edCategory').value;
      var r = await api('/book/' + book.id + '/edit', { json: body });
      book.title = r.item.title; book.author = r.item.author; book.copyrightYear = r.item.copyrightYear; book.category = r.item.category; book.path = r.item.path; book.description = r.item.description;
      $('bookTitle').textContent = book.title; say('Saved.');
    } catch(e) { say(e.message); }
  };
  $('shareBtn').onclick = async function(){ try { var j = await api('/book/' + book.id + '/share', { json: { shared: !book.shared } }); book.shared = j.book.shared; renderOwner(); say(j.pending ? 'Submitted for the library. The librarian will look at it and you will be told.' : (book.shared ? 'It is in the family library now. Family library members will see "Donated by ' + (book.ownerName || 'you') + '".' : 'Back on your private shelf.')); } catch(e) { say(e.message); } };
  $('grownBtn').onclick = async function(){ try { var j = await api('/book/' + book.id + '/share', { json: { grownUpsOnly: !book.grownUpsOnly } }); book.grownUpsOnly = j.book.grownUpsOnly; renderOwner(); say(book.grownUpsOnly ? 'Hidden from the kids.' : 'The kids can see it.'); } catch(e) { say(e.message); } };
  $('deleteBtn').onclick = async function(){ if (!confirm('Withdraw "' + book.title + '" from the Reading Room for everyone? This cannot be undone.')) return; try { pause(); await api('/book/' + book.id, { method: 'DELETE' }); leave(); } catch(e) { say(e.message); } };
  $('returnBtn').onclick = async function(){ try { pause(); await api('/book/' + book.id + '/return', { method: 'POST' }); say('Returned. Your place in it is forgotten.'); leave(); } catch(e) { say(e.message); } };
  $('backToShelf').onclick = function(){ pause(); leave(); };
  window.addEventListener('pagehide', function(){ if (book) saveProgress(true); });

  async function openBook(id){
    try {
      book = await api('/book/' + id);
      if (!me) { try { var sh = await api('/shelf'); me = sh.me || ''; librarian = !!sh.librarian; describedVideo = !!sh.describedVideo; } catch(e2) {} }
    } catch(e) { say('Could not open that: ' + e.message); visit(''); return; }
    $('shelf').classList.add('hidden'); $('player').classList.remove('hidden');
    $('pageTitle').textContent = 'The Library';
    $('bookTitle').textContent = book.title;
    document.title = book.title + ' — The Library — Kade-AI';
    $('askLibrarian').href = librarianChatUrl + '&prompt=' + encodeURIComponent('Tell me about the Library item with catalog ID ' + book.id + '.');
    var bits = [];
    if (book.author) bits.push('by ' + book.author);
    if (book.kind !== 'text') bits.push(typeWord(book));
    if (book.listen) bits.push(book.listen);
    if (book.ownerName && !book.mine) bits.push('donated by ' + book.ownerName);
    $('bookMeta').textContent = bits.join(' · ');
    $('jacketLine').textContent = book.kind !== 'text' ? (book.description || '') : '';
    $('readingViewBtn').hidden = isAudio() || !window.createLibraryReader;
    var sel = $('chapterSel'); sel.innerHTML = '';
    var list = isAudio() ? book.tracks : book.chapters;
    list.forEach(function(ch, i){ var o = document.createElement('option'); o.value = i; o.textContent = (i + 1) + '. ' + ch.title + (isAudio() && ch.seconds ? ' (' + clock(ch.seconds) + ')' : ''); sel.appendChild(o); });
    /* Nov 10 2026: a recording has parts, a book has chapters, and a one-part clip (most of the
       archive) does not offer four controls that can only answer "this is the last one". */
    var many = list.length > 1, word = partWord();
    $('prevSecBtn').hidden = !many; $('nextSecBtn').hidden = !many; $('chapterWrap').hidden = !many;
    $('prevSecBtn').textContent = 'Previous ' + word; $('nextSecBtn').textContent = 'Next ' + word;
    $('chapterLabel').textContent = isAudio() ? 'Part' : 'Chapter'; $('goChapterBtn').textContent = 'Go to this ' + word;
    $('backBtn').textContent = isAudio() ? 'Back 15 seconds' : 'Previous passage'; $('fwdBtn').textContent = isAudio() ? 'Forward 15 seconds' : 'Next passage';
    $('keysHint').textContent = 'Keys, while you are in the player: Space or K to play or pause, Left and Right to go back or forward' + (many ? ', Shift with Left or Right for ' + word + 's' : '') + ', B for a bookmark. None of them uses Ctrl or Alt, and every one is also a button above.';
    finished = false; $('seekWrap').hidden = true; $('accessRow').hidden = true;
    $('timeLine').hidden = !isAudio(); $('timeLine').textContent = ''; timeShown = '';
    var p = book.progress || {};
    voice = p.voice || book.defaultVoice; speed = p.speed || 1;
    showSpeed(speed);
    var wantTrack = parseInt(new URLSearchParams(location.search).get('track'), 10);
    if (isAudio()) { $('voiceWrap').classList.add('hidden'); pos = { s: Number.isInteger(wantTrack) ? wantTrack : (p.s || 0), c: 0 }; loadTrack(pos.s, Number.isInteger(wantTrack) ? 0 : (p.pos || 0), autoplayNext); autoplayNext = false; }
    else { $('voiceWrap').classList.remove('hidden'); await loadVoices(); pos = { s: p.s || 0, c: p.c || 0 }; showText(pos); }
    sel.value = String(pos.s);
    sel.onchange = function(){ };
    renderBookmarks(); renderSkipped(); renderOwner(); renderLibrarian(); updateSession();
    var resume = (pos.s || pos.c || p.pos) && !p.finished;
    showState();
    say((resume ? 'Resuming ' : 'Opened ') + book.title + (resume && isAudio() && p.pos >= 1 && !Number.isInteger(wantTrack) ? ' at ' + spokenTime(p.pos) : '') + '. ' + (isAudio() ? 'Part ' : 'Chapter ') + (pos.s + 1) + ' of ' + list.length + (chapterTitle(pos.s) ? ': ' + chapterTitle(pos.s) : '') + '. Press Play.');
    $('playBtn').focus();
  }

  /* An item or a playlist never has the shelf behind it, and its skip link goes to its title.
     The search page's skip link goes to the results. The short pages have none to offer. */
  (function(){ var skip = $('skipLink'); if (VIEW === 'item' || VIEW === 'playlist') { $('shelf').classList.add('hidden'); skip.href = VIEW === 'item' ? '#bookTitle' : '#collTitle'; skip.textContent = VIEW === 'item' ? 'Skip to the item' : 'Skip to the playlist'; skip.hidden = false; } else if (VIEW === 'search') skip.hidden = false; })();
  (async function(){
    token = await getToken();
    if (!token) { say('Please sign in first.'); location.href = '/login?redirect_to=' + encodeURIComponent(location.pathname + location.search + location.hash); return; }
    var qs = new URLSearchParams(location.search);
    var id = qs.get('book'); var coll = qs.get('collection');
    if (id && qs.get('q')) queue = qs.get('q').split(',').filter(Boolean); // on an item, q is the playlist queue; on the search page it is the search
    if (id) { openBook(id); return; }
    if (coll) { openCollection(coll); return; }
    /* A return note belongs to one list. On a page that does not hold that list it is dropped,
       so it can never pull focus somewhere on a later visit. */
    var lists = { search: ['browseList'], folders: ['archiveList'], continue: ['mineList', 'continueList'], desk: ['continueList'] }[VIEW] || [];
    var note = returnNote(); if (note && lists.indexOf(note.host) === -1) dropReturn();
    /* Each page asks only for what it shows: the front desk makes one small call. */
    if (VIEW === 'desk' || VIEW === 'continue') loadShelf();
    else if (VIEW === 'search') window.setupLibraryBrowse(api, say, bookLi, null, function(){ restoreReturn(['browseList']); });
    else if (VIEW === 'folders') startFolders();
    else if (VIEW === 'playlists') loadCollections();
    else if (VIEW === 'family') { await loadShelf(); loadFamily(); }
    else if (VIEW === 'requests') { loadSubmissions(); if (window.setupLibraryRequests) window.setupLibraryRequests(api, say); }
    else if (VIEW === 'librarian') { loadShelf(); loadSubmissions(); }
    else if (VIEW === 'add') startAdd();
  })();
})();
</script>
</body></html>`;

module.exports = { readingRoomHtml, ALCOVE_ART, SHELF_ART, ART_DIR, ART_HIDDEN_WHEN, LIBRARY_VIEWS };
