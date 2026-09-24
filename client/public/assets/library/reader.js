/* ----------------------------------------------------------------------------
 * THE LIBRARY'S READING VIEW (Sep 24 2026)
 *
 * Kade: "Make sure the reading view is appropriate for low vision and full
 * vision users if they want to read along with their book as it is narrated.
 * Doesn't have to be synced up ... We have a reading view for agent
 * messages."
 *
 * It follows the chat's reading view (client KadeReadingView.tsx): full
 * screen, plain text in large type, Escape or Close hands focus back to the
 * button that opened it, and the site's own low-vision choices
 * (kadeA11yHighContrast, kadeA11yFont, kadeA11yLineSpacing, set in the chat's
 * Settings) are where it starts. Beyond that it lets a reader set text size,
 * colors, line and letter spacing, line width and typeface, remembered for
 * that person on that device.
 *
 * A native <dialog>, built the first time someone opens it: a screen-reader
 * user who never opens it meets one button on the player and nothing else.
 *
 * Reading and narration stay independent. A page is up to PAGE passages of
 * one chapter and the narrated passage is marked. With "Turn pages with the
 * narration" on, the view moves with the narration only while the reader is
 * at the narrated passage; someone who pages or scrolls away is never pulled
 * back. Nothing is announced on its own except errors: a page the reader asks
 * for moves focus to its heading (the screen reader reads that), a page the
 * narration turns is quiet.
 * -------------------------------------------------------------------------- */
(function () {
  'use strict';

  /** Passages a page: about 18,000 characters, some 18 minutes of narration. */
  var PAGE = 40;
  var STORE = 'kade.library.readingView';
  var SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  var SETTINGS = [
    { key: 'size', label: 'Text size', options: [['1', 'Small'], ['1.25', 'Standard'], ['1.5', 'Large'], ['2', 'Larger'], ['2.5', 'Very large'], ['3', 'Huge'], ['4', 'Largest']] },
    { key: 'colors', label: 'Colors', options: [['page', 'Match this device'], ['light', 'Black on white'], ['dark', 'White on black'], ['yellow', 'Yellow on black'], ['cream', 'Dark brown on cream'], ['blue', 'Black on pale blue']] },
    { key: 'lines', label: 'Line spacing', options: [['1.5', 'Standard'], ['1.8', 'Roomy'], ['2.2', 'Very roomy'], ['2.6', 'Widest']] },
    { key: 'letters', label: 'Letter and word spacing', options: [['0', 'Standard'], ['1', 'Wide'], ['2', 'Wider']] },
    { key: 'width', label: 'Line width', options: [['40', 'Narrow'], ['60', 'Medium'], ['80', 'Wide'], ['0', 'Full width']] },
    { key: 'font', label: 'Typeface', options: [['page', 'Match the page'], ['serif', 'Serif, like a printed book'], ['lexend', 'Lexend, easy to read'], ['opendyslexic', 'OpenDyslexic']] },
  ];
  var DEFAULTS = { size: '1.25', colors: 'page', lines: '1.8', letters: '0', width: '60', font: 'page', follow: true };
  /* [background, text, marker, highlight] — text on both backgrounds is 9:1 or better */
  var THEMES = {
    light: ['#ffffff', '#111111', '#1d55d0', '#fff4c2'],
    dark: ['#000000', '#ffffff', '#93c5fd', '#2a2f3a'],
    yellow: ['#000000', '#ffe94d', '#ffffff', '#333333'],
    cream: ['#f7efdc', '#3b2f1e', '#8a4b08', '#efdcae'],
    blue: ['#dcebf7', '#111111', '#1d3f8a', '#fff6c8'],
    pageLight: ['#f6f7f9', '#16181d', '#1d55d0', '#fff4c2'],
    pageDark: ['#14161a', '#e7e9ee', '#93c5fd', '#2a2f3a'],
  };
  var FONTS = {
    page: SANS,
    serif: 'Georgia, "Iowan Old Style", "Palatino Linotype", "Times New Roman", serif',
    lexend: '"Lexend", ' + SANS,
    opendyslexic: '"OpenDyslexic", ' + SANS,
  };
  var LETTERS = { 0: ['normal', 'normal'], 1: ['.05em', '.1em'], 2: ['.12em', '.16em'] };

  function allowed(key, value) {
    var setting = SETTINGS.filter(function (s) { return s.key === key; })[0];
    return !!setting && setting.options.some(function (o) { return o[0] === value; });
  }
  /** Saved choices, with anything unknown or missing back at its default. */
  function normalize(saved, base) {
    var out = {};
    base = base || DEFAULTS;
    Object.keys(DEFAULTS).forEach(function (key) {
      var value = saved && saved[key];
      if (key === 'follow') out.follow = typeof value === 'boolean' ? value : base.follow !== false;
      else out[key] = typeof value === 'string' && allowed(key, value) ? value : base[key];
    });
    return out;
  }
  /** First visit: start from what this person already chose for the chat,
   * then from what the device asks for (more contrast). */
  function seed(site) {
    site = site || {};
    var out = normalize({});
    if (site.highContrast || site.moreContrast) out.colors = site.dark ? 'dark' : 'light';
    if (site.font === 'lexend' || site.font === 'opendyslexic') out.font = site.font;
    if (site.spacing === 'relaxed') out.lines = '2.2';
    if (site.spacing === 'loose') out.lines = '2.6';
    return out;
  }
  function pageStart(c) { return Math.floor(Math.max(0, c) / PAGE) * PAGE; }
  /** The heading already spoken as the chapter's first passage ("Chapter One."). */
  function isTitlePassage(passage, title) {
    var norm = function (t) { return String(t || '').replace(/\s+/g, ' ').replace(/[\s.]+$/, '').trim().toLowerCase(); };
    return !!title && norm(passage) === norm(title);
  }
  function pageHeading(title, from, total) {
    var pages = Math.max(1, Math.ceil(total / PAGE));
    return (title || 'Untitled section') + (pages > 1 ? ', page ' + (Math.floor(from / PAGE) + 1) + ' of ' + pages : '');
  }

  function readJson(key) {
    try { var raw = localStorage.getItem(key); return raw == null ? null : JSON.parse(raw); } catch (_) { return null; }
  }
  function sitePrefs() {
    var media = function (q) { try { return window.matchMedia(q).matches; } catch (_) { return false; } };
    return {
      highContrast: readJson('kadeA11yHighContrast') === true,
      font: readJson('kadeA11yFont'),
      spacing: readJson('kadeA11yLineSpacing'),
      moreContrast: media('(prefers-contrast: more)'),
      dark: media('(prefers-color-scheme: dark)'),
    };
  }

  var CSS =
    '@font-face{font-family:"Lexend";font-style:normal;font-display:swap;font-weight:400;src:url("https://cdn.jsdelivr.net/npm/@fontsource/lexend/files/lexend-latin-400-normal.woff2") format("woff2")}' +
    '@font-face{font-family:"Lexend";font-style:normal;font-display:swap;font-weight:700;src:url("https://cdn.jsdelivr.net/npm/@fontsource/lexend/files/lexend-latin-700-normal.woff2") format("woff2")}' +
    '@font-face{font-family:"OpenDyslexic";font-style:normal;font-display:swap;font-weight:400;src:url("https://cdn.jsdelivr.net/npm/open-dyslexic@1.0.3/woff/OpenDyslexic-Regular.woff") format("woff")}' +
    '@font-face{font-family:"OpenDyslexic";font-style:normal;font-display:swap;font-weight:700;src:url("https://cdn.jsdelivr.net/npm/open-dyslexic@1.0.3/woff/OpenDyslexic-Bold.woff") format("woff")}' +
    'dialog.lr{position:fixed;inset:0;box-sizing:border-box;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;overflow:auto;overscroll-behavior:contain;background:var(--lr-bg);color:var(--lr-fg);font-family:' + SANS + ';font-size:clamp(1rem,calc(var(--lr-size) * .8rem),1.5rem);line-height:1.5}' +
    'dialog.lr::backdrop{background:var(--lr-bg)}' +
    '.lr *{box-sizing:border-box}' +
    '.lr-inner{min-height:100%;padding:calc(1rem + env(safe-area-inset-top,0px)) clamp(1rem,4vw,3rem) calc(3rem + env(safe-area-inset-bottom,0px))}' +
    '.lr-bar,.lr-nav,.lr-jump{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem}' +
    '.lr-bar h2{flex:1 1 12rem;margin:0;font-size:1.2em;line-height:1.3;overflow-wrap:anywhere}' +
    '.lr button,.lr select{font:inherit;min-height:48px;max-width:100%;padding:.5rem .9rem;border:1px solid currentColor;border-radius:.6rem;background:var(--lr-bg);color:var(--lr-fg);cursor:pointer}' +
    '.lr button:disabled{opacity:.55;cursor:default}' +
    '.lr input[type=checkbox]{width:1.4em;height:1.4em;margin:0;accent-color:var(--lr-mark)}' +
    '.lr :focus-visible{outline:3px solid var(--lr-mark);outline-offset:3px}' +
    '.lr h2:focus,.lr h3:focus,.lr-text p:focus{outline-offset:6px}' +
    '.lr details{margin:1rem 0}.lr summary{cursor:pointer;font-weight:600;padding:.4rem 0;min-height:44px}' +
    '.lr-settings{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr));gap:.8rem 1.2rem;margin-top:.6rem}' +
    '.lr-settings label{display:block;font-weight:600;margin-bottom:.25rem}.lr-settings select{width:100%}' +
    '.lr-forced{display:none}' +
    '.lr-status{min-height:1.5em;margin:.6rem 0}' +
    '.lr-page{max-width:var(--lr-width);margin:1.5rem auto 2rem;font-family:var(--lr-font);font-size:calc(var(--lr-size) * 1rem);line-height:var(--lr-lines);letter-spacing:var(--lr-letter);word-spacing:var(--lr-word);overflow-wrap:break-word;text-align:start}' +
    '.lr-page h3{font-size:max(1em,min(1.3em,10vw));line-height:1.3;margin:0 0 1em;padding:0 .35em}' +
    '.lr-text p{margin:0 0 calc((var(--lr-lines) - .5) * 1em);padding:0 .35em}' +
    '.lr .lr-now{background:var(--lr-hl);box-shadow:-.3em 0 0 var(--lr-mark);border-radius:.15em}' +
    '.lr-busy{opacity:.6}' +
    '.lr-nav,.lr-jump{margin:1rem auto;max-width:var(--lr-width)}' +
    '.lr-jump label{font-weight:600}.lr-follow{display:flex;align-items:center;gap:.6rem;min-height:48px}' +
    /* Play and Close stay in reach on a roomy screen; on a small or zoomed one the bar scrolls away so it never covers the text */
    '@media (min-width:40rem) and (min-height:30rem){.lr-bar{position:sticky;top:0;z-index:1;margin:0 -.5rem;padding:.5rem;background:var(--lr-bg);box-shadow:0 1px 0 var(--lr-fg)}.lr-page h3,.lr-text p{scroll-margin-top:7rem}}' +
    '@media (prefers-contrast:more){.lr button,.lr select{border-width:2px}.lr :focus-visible{outline-width:4px}.lr-busy{opacity:1}}' +
    '@media (forced-colors:active){.lr-forced{display:block}.lr .lr-now{box-shadow:none;outline:3px solid Highlight;forced-color-adjust:none;background:Canvas;color:CanvasText}.lr :focus-visible{outline-color:Highlight}}' +
    '@media (prefers-reduced-motion:reduce){dialog.lr{scroll-behavior:auto}}';

  function build() {
    var style = document.createElement('style');
    style.id = 'libraryReaderStyle';
    style.textContent = CSS;
    document.head.appendChild(style);
    var dialog = document.createElement('dialog');
    dialog.className = 'lr';
    dialog.id = 'libraryReader';
    // named for what it is; focus then lands on the book's title, so neither is said twice
    dialog.setAttribute('aria-label', 'Reading view');
    dialog.innerHTML =
      '<div class="lr-inner">' +
      '<div class="lr-bar"><h2 id="lrTitle" tabindex="-1"></h2>' +
      '<button type="button" id="lrPlay">Play narration</button>' +
      '<button type="button" id="lrClose">Close reading view</button></div>' +
      '<details id="lrLook"><summary>Text size, colors and spacing</summary><div class="lr-settings" id="lrSettings"></div>' +
      '<p class="lr-forced">Your computer\'s contrast theme is choosing the colors.</p>' +
      '<p><button type="button" id="lrReset">Reset reading settings</button></p></details>' +
      '<p id="lrStatus" class="lr-status" role="status"></p>' +
      '<div class="lr-page"><h3 id="lrHeading" tabindex="-1"></h3><div class="lr-text" id="lrText"></div></div>' +
      '<div class="lr-nav"><button type="button" id="lrPrevious">Previous page</button><button type="button" id="lrNext">Next page</button>' +
      '<button type="button" id="lrCurrent">Show where the narration is</button></div>' +
      '<div class="lr-jump"><label class="lr-follow"><input type="checkbox" id="lrFollow"> Turn pages with the narration</label></div>' +
      '<div class="lr-jump"><label for="lrChapter">Chapter</label><select id="lrChapter"></select><button type="button" id="lrGoChapter">Show chapter</button></div>' +
      '</div>';
    var settings = dialog.querySelector('#lrSettings');
    SETTINGS.forEach(function (setting) {
      var field = document.createElement('div');
      var label = document.createElement('label');
      label.setAttribute('for', 'lr-' + setting.key);
      label.textContent = setting.label;
      var select = document.createElement('select');
      select.id = 'lr-' + setting.key;
      setting.options.forEach(function (o) {
        var option = document.createElement('option');
        option.value = o[0];
        option.textContent = o[1];
        select.appendChild(option);
      });
      field.appendChild(label);
      field.appendChild(select);
      settings.appendChild(field);
    });
    document.body.appendChild(dialog);
    return dialog;
  }

  window.createLibraryReader = function (options) {
    var dialog = null, $ = function (id) { return dialog.querySelector('#' + id); };
    var prefs = null, prefsKey = '', opener = null, oldOverflow = '';
    var page = null; // { id, s, from, total, rows: { c: element } }
    var marked = null, following = false, generation = 0;

    function media(q) { try { return window.matchMedia(q).matches; } catch (_) { return false; } }
    function save() { try { localStorage.setItem(prefsKey, JSON.stringify(prefs)); } catch (_) { /* this visit only */ } }
    function apply() {
      var theme = prefs.colors === 'page' ? (media('(prefers-color-scheme: dark)') ? 'pageDark' : 'pageLight') : prefs.colors;
      var colors = THEMES[theme] || THEMES.pageLight;
      var letters = LETTERS[prefs.letters] || LETTERS[0];
      var set = function (name, value) { dialog.style.setProperty(name, value); };
      set('--lr-bg', colors[0]); set('--lr-fg', colors[1]); set('--lr-mark', colors[2]); set('--lr-hl', colors[3]);
      set('--lr-size', prefs.size); set('--lr-lines', prefs.lines);
      set('--lr-letter', letters[0]); set('--lr-word', letters[1]);
      set('--lr-width', prefs.width === '0' ? 'none' : prefs.width + 'ch');
      set('--lr-font', FONTS[prefs.font] || FONTS.page);
      SETTINGS.forEach(function (s) { $('lr-' + s.key).value = prefs[s.key]; });
      $('lrFollow').checked = prefs.follow;
    }
    function loadPrefs() {
      var person = String((options.person && options.person()) || 'anyone');
      prefsKey = STORE + ':' + person;
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem(prefsKey) || 'null'); } catch (_) { saved = null; }
      prefs = saved ? normalize(saved, seed(sitePrefs())) : seed(sitePrefs());
      apply();
    }
    function say(text) {
      var status = $('lrStatus');
      status.textContent = '';
      setTimeout(function () { status.textContent = text; }, 30);
    }
    function playLabel() {
      if (dialog) $('lrPlay').textContent = options.isPlaying() ? 'Pause narration' : 'Play narration';
    }
    function viewHeight() { return window.innerHeight || document.documentElement.clientHeight || 0; }
    function visible(el) {
      if (!el) return false;
      var r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < viewHeight();
    }
    /** Bring a passage to the middle of the screen, unless it already sits
     * comfortably in view: text moves only when the reader would run out. */
    function reveal(el) {
      if (!el || !el.scrollIntoView) return;
      var r = el.getBoundingClientRect(), h = viewHeight();
      var bar = dialog.querySelector('.lr-bar');
      var covered = bar && getComputedStyle(bar).position === 'sticky' ? bar.getBoundingClientRect().bottom : 0;
      if (r.top >= Math.max(h * 0.1, covered) && r.bottom <= h * 0.85) return;
      el.scrollIntoView({ block: 'center', behavior: media('(prefers-reduced-motion: reduce)') ? 'auto' : 'smooth' });
    }
    /** Mark the narrated passage when it is on this page. */
    function mark(position) {
      var book = options.book();
      if (marked) { marked.classList.remove('lr-now'); marked.removeAttribute('aria-current'); marked = null; }
      if (!page || !book || page.id !== book.id || position.s !== page.s) return null;
      var el = page.rows[position.c] || null;
      if (el) { el.classList.add('lr-now'); el.setAttribute('aria-current', 'true'); marked = el; }
      return el;
    }
    function updateNav() {
      var book = options.book();
      var last = book.chapters.length - 1;
      $('lrPrevious').disabled = page.s === 0 && page.from === 0;
      $('lrNext').disabled = page.s >= last && page.from + PAGE >= page.total;
    }
    /** Show the page holding passage c of chapter s. `focus`: 'heading' when
     * the reader asked for a page, 'passage' to land on c itself; otherwise
     * (opening, or the narration turning the page) focus stays put and the
     * narrated passage is brought into view. */
    async function show(s, c, focus) {
      var book = options.book();
      if (!book || !book.chapters || !book.chapters[s]) return;
      var token = ++generation;
      var from = pageStart(c);
      var section = $('lrText').parentNode;
      section.setAttribute('aria-busy', 'true');
      $('lrText').classList.add('lr-busy');
      try {
        var j = await options.api('/book/' + book.id + '/passages/' + s + '?from=' + from + '&count=' + PAGE);
        if (token !== generation || !dialog.open || options.book() !== book) return;
        var title = j.title || book.chapters[s].title;
        var heading = $('lrHeading');
        var text = $('lrText');
        heading.textContent = pageHeading(title, from, j.total);
        text.replaceChildren();
        if (book.language) text.lang = book.language; else text.removeAttribute('lang');
        var rows = {};
        j.passages.forEach(function (passage, i) {
          var at = from + i;
          if (at === 0 && isTitlePassage(passage, title)) { rows[at] = heading; return; }
          if (!passage) return;
          var p = document.createElement('p');
          p.textContent = passage;
          p.tabIndex = -1;
          text.appendChild(p);
          rows[at] = p;
        });
        page = { id: book.id, s: s, from: from, total: j.total, rows: rows };
        $('lrChapter').value = String(s);
        updateNav();
        var here = mark(options.position());
        following = !!here;
        if (focus === 'passage' && rows[c]) { rows[c].focus({ preventScroll: true }); rows[c].scrollIntoView({ block: 'center' }); }
        else if (focus === 'heading') { heading.focus({ preventScroll: true }); heading.scrollIntoView({ block: 'start' }); }
        else if (here) reveal(here);
      } catch (_) {
        if (token === generation) say('This page did not load. Check your connection, then try again.');
      } finally {
        if (token === generation) { section.removeAttribute('aria-busy'); $('lrText').classList.remove('lr-busy'); }
      }
    }
    function previous() {
      var book = options.book();
      if (!page) return;
      if (page.from > 0) show(page.s, page.from - PAGE, 'heading');
      else if (page.s > 0) show(page.s - 1, Math.max(0, book.chapters[page.s - 1].chunks - 1), 'heading');
    }
    function next() {
      if (!page) return;
      if (page.from + PAGE < page.total) show(page.s, page.from + PAGE, 'heading');
      else if (page.s + 1 < options.book().chapters.length) show(page.s + 1, 0, 'heading');
    }

    function wire() {
      SETTINGS.forEach(function (s) {
        $('lr-' + s.key).addEventListener('change', function () { prefs[s.key] = this.value; apply(); save(); });
      });
      // takes effect from the next passage; "Show where the narration is" rejoins it
      $('lrFollow').addEventListener('change', function () { prefs.follow = this.checked; save(); });
      $('lrReset').addEventListener('click', function () {
        var follow = prefs.follow;
        prefs = seed(sitePrefs()); prefs.follow = follow;
        apply(); save();
        say('Reading settings are back to where they started.');
      });
      $('lrPlay').addEventListener('click', function () {
        if (options.isPlaying()) options.pause(); else options.play();
        playLabel();
      });
      $('lrClose').addEventListener('click', function () { dialog.close(); });
      $('lrPrevious').addEventListener('click', previous);
      $('lrNext').addEventListener('click', next);
      $('lrCurrent').addEventListener('click', function () { var p = options.position(); show(p.s, p.c, 'passage'); });
      $('lrGoChapter').addEventListener('click', function () { show(Number($('lrChapter').value) || 0, 0, 'heading'); });
      dialog.addEventListener('close', function () {
        generation++;
        document.body.style.overflow = oldOverflow;
        if (opener && opener.isConnected && opener.focus) opener.focus();
      });
    }

    return {
      isOpen: function () { return !!dialog && dialog.open; },
      /** Narration's play state changed. */
      playback: playLabel,
      /** The narration moved to `position` (the player calls this for every passage). */
      narrationChanged: function (position) {
        if (!dialog || !dialog.open || !page) return;
        playLabel();
        // an emptied passage has nothing to mark; the reader is where they were
        var withIt = marked ? visible(marked) : following;
        following = withIt;
        var onPage = position.s === page.s && position.c >= page.from && position.c < page.from + PAGE;
        if (onPage) {
          var el = mark(position);
          if (prefs.follow && withIt && el) reveal(el);
        } else {
          mark(position);
          // turn the page only for someone who was at the narrated passage
          if (prefs.follow && withIt) show(position.s, position.c, 'follow');
        }
      },
      open: function () {
        var book = options.book();
        if (!book || book.kind !== 'text' || !book.chapters || !book.chapters.length) return;
        if (!dialog) { dialog = build(); wire(); }
        loadPrefs();
        $('lrTitle').textContent = book.title || 'Reading view';
        var select = $('lrChapter');
        select.replaceChildren();
        book.chapters.forEach(function (chapter, i) {
          var option = document.createElement('option');
          option.value = String(i);
          option.textContent = (i + 1) + '. ' + chapter.title;
          select.appendChild(option);
        });
        $('lrStatus').textContent = '';
        $('lrHeading').textContent = '';
        $('lrText').replaceChildren();
        page = null; marked = null; following = false;
        opener = document.activeElement;
        oldOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        dialog.showModal();
        $('lrTitle').focus();
        playLabel();
        var p = options.position();
        show(p.s, p.c, '');
      },
    };
  };

  /* For the selftest (kadeReadingRoomReader.selftest.js); the page does not use it. */
  window.libraryReaderCore = { PAGE: PAGE, SETTINGS: SETTINGS, DEFAULTS: DEFAULTS, THEMES: THEMES, normalize: normalize, seed: seed, pageStart: pageStart, isTitlePassage: isTitlePassage, pageHeading: pageHeading };
})();
