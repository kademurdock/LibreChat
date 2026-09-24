(function () {
  'use strict';
  window.createLibraryReader = function (options) {
    var dialog = document.createElement('dialog');
    dialog.id = 'libraryReader';
    dialog.setAttribute('aria-labelledby', 'readerTitle');
    dialog.innerHTML =
      '<header><h2 id="readerTitle">Reading view</h2><button type="button" id="readerClose">Close reading view</button></header>' +
      '<details><summary>Reading appearance</summary><div class="readerSettings">' +
      '<label>Text size <select id="readerSize"><option value="1">Standard</option><option value="1.25">Large</option><option value="1.5">Larger</option><option value="2">Extra large</option><option value="3">Huge</option><option value="4">Largest</option></select></label>' +
      '<label>Colors <select id="readerTheme"><option value="light">Black on white</option><option value="dark">White on black</option><option value="sepia">Warm paper</option><option value="contrast">Yellow on black</option></select></label>' +
      '<label>Line spacing <select id="readerSpacing"><option value="1.5">Comfortable</option><option value="1.8">Roomy</option><option value="2.2">Very roomy</option></select></label>' +
      '<label>Line width <select id="readerWidth"><option value="38">Narrow</option><option value="60">Medium</option><option value="80">Wide</option></select></label>' +
      '<label>Typeface <select id="readerFont"><option value="sans-serif">Sans serif</option><option value="serif">Serif</option></select></label></div></details>' +
      '<nav aria-label="Reading and narration controls"><button type="button" id="readerPlay">Play narration</button><button type="button" id="readerCurrent">Go to narration position</button>' +
      '<label><input type="checkbox" id="readerFollow"> Follow narration passages</label>' +
      '<label>Chapter <select id="readerChapter"></select></label>' +
      '<button type="button" id="readerPrevious">Previous reading page</button><button type="button" id="readerNext">Next reading page</button></nav>' +
      '<p id="readerStatus" role="status"></p><article id="readerText" tabindex="0" aria-label="Book text"></article>';
    document.body.appendChild(dialog);
    var style = document.createElement('style');
    style.textContent =
      '#libraryReader{box-sizing:border-box;position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:clamp(.75rem,3vw,2rem);border:0;background:var(--reader-bg,#fff);color:var(--reader-fg,#111);overflow:auto}#libraryReader::backdrop{background:#0009}#libraryReader header,#libraryReader nav,.readerSettings{display:flex;flex-wrap:wrap;align-items:center;gap:.65rem}#libraryReader header{justify-content:space-between}#libraryReader label{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem}#libraryReader select,#libraryReader button{font:inherit;min-height:48px;padding:.6rem;border:1px solid currentColor;border-radius:.5rem;background:var(--reader-bg,#fff);color:var(--reader-fg,#111);max-width:100%;width:auto}#libraryReader button:disabled{opacity:.55}#libraryReader :focus-visible{outline:3px solid var(--reader-fg,#111);outline-offset:3px}#libraryReader article{max-width:var(--reader-width,60ch);margin:1.5rem auto;font-family:var(--reader-font,sans-serif);font-size:var(--reader-size,1.25rem);line-height:var(--reader-spacing,1.8);overflow-wrap:anywhere;white-space:pre-wrap}#libraryReader article p{margin:0 0 1em}#libraryReader h2{overflow-wrap:anywhere}#libraryReader nav{margin-top:1rem}#libraryReader input{min-width:24px;min-height:24px}';
    document.head.appendChild(style);
    var get = function (id) {
      return document.getElementById(id);
    };
    var page = null,
      after = null,
      generation = 0,
      opener = null,
      oldOverflow = '';
    var prefs = {
      Size: '1.25',
      Theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      Spacing: '1.8',
      Width: '60',
      Font: 'sans-serif',
    };
    try {
      var saved = JSON.parse(localStorage.getItem('kade.library.readingAppearance') || '{}');
      Object.keys(prefs).forEach(function (key) {
        if (saved[key]) prefs[key] = saved[key];
      });
    } catch (_) {
      /* Browser storage may be disabled. */
    }
    function appearance() {
      var themes = {
        light: ['#fff', '#111'],
        dark: ['#000', '#fff'],
        sepia: ['#f6ecd6', '#302719'],
        contrast: ['#000', '#fff176'],
      };
      var colors = themes[get('readerTheme').value] || themes.light;
      dialog.style.setProperty('--reader-bg', colors[0]);
      dialog.style.setProperty('--reader-fg', colors[1]);
      dialog.style.setProperty('--reader-size', get('readerSize').value + 'rem');
      dialog.style.setProperty('--reader-spacing', get('readerSpacing').value);
      dialog.style.setProperty('--reader-width', get('readerWidth').value + 'ch');
      dialog.style.setProperty('--reader-font', get('readerFont').value);
      Object.keys(prefs).forEach(function (key) {
        prefs[key] = get('reader' + key).value;
      });
      try {
        localStorage.setItem('kade.library.readingAppearance', JSON.stringify(prefs));
      } catch (_) {
        /* Preferences still work for this visit. */
      }
    }
    Object.keys(prefs).forEach(function (key) {
      var control = get('reader' + key);
      if (
        Array.from(control.options).some(function (option) {
          return option.value === prefs[key];
        })
      )
        control.value = prefs[key];
      control.onchange = appearance;
    });
    appearance();
    function playback() {
      get('readerPlay').textContent = options.isPlaying() ? 'Pause narration' : 'Play narration';
    }
    async function show(position, moveFocus) {
      var book = options.book();
      if (!book || book.kind !== 'text') return;
      var chapter = book.chapters[position.s];
      if (!chapter) return;
      var token = ++generation;
      get('readerStatus').textContent = 'Loading book text…';
      get('readerText').setAttribute('aria-busy', 'true');
      try {
        var start = Math.floor(position.c / 12) * 12;
        var count = Math.min(12, chapter.chunks - start);
        var passages = await Promise.all(
          Array.from({ length: count }, function (_, offset) {
            return options.api('/book/' + book.id + '/text/' + position.s + '/' + (start + offset));
          }),
        );
        if (token !== generation || !dialog.open || options.book().id !== book.id) return;
        page = { s: position.s, c: start, end: start + count };
        after =
          start + count < chapter.chunks
            ? { s: position.s, c: start + count }
            : position.s + 1 < book.chapters.length
              ? { s: position.s + 1, c: 0 }
              : null;
        get('readerText').replaceChildren();
        passages.forEach(function (passage) {
          var paragraph = document.createElement('p');
          paragraph.textContent = passage.text;
          get('readerText').appendChild(paragraph);
        });
        get('readerChapter').value = String(position.s);
        get('readerPrevious').disabled = !page.s && !page.c;
        get('readerNext').disabled = !after;
        get('readerStatus').textContent =
          'Chapter ' +
          (position.s + 1) +
          ': ' +
          chapter.title +
          '. Passages ' +
          (start + 1) +
          '–' +
          (start + count) +
          ' of ' +
          chapter.chunks +
          '.';
        if (moveFocus) get('readerText').focus();
      } catch (error) {
        if (token === generation)
          get('readerStatus').textContent = 'Could not load this reading page. ' + error.message;
      } finally {
        if (token === generation) get('readerText').removeAttribute('aria-busy');
      }
    }
    function manual(position) {
      get('readerFollow').checked = false;
      return show(position, true);
    }
    get('readerNext').onclick = function () {
      if (after) manual(after);
    };
    get('readerPrevious').onclick = function () {
      if (!page) return;
      manual(
        page.c
          ? { s: page.s, c: Math.max(0, page.c - 12) }
          : { s: page.s - 1, c: Math.max(0, options.book().chapters[page.s - 1].chunks - 1) },
      );
    };
    get('readerChapter').onchange = function () {
      manual({ s: Number(this.value), c: 0 });
    };
    get('readerPlay').onclick = function () {
      options.isPlaying() ? options.pause() : options.play();
      playback();
    };
    get('readerCurrent').onclick = function () {
      show(options.position(), true);
    };
    get('readerFollow').onchange = function () {
      if (this.checked) show(options.position(), false);
    };
    get('readerClose').onclick = function () {
      dialog.close();
    };
    dialog.addEventListener('close', function () {
      generation++;
      document.body.style.overflow = oldOverflow;
      if (opener && opener.isConnected) opener.focus();
    });
    return {
      isOpen: function () {
        return dialog.open;
      },
      playback: playback,
      narrationChanged: function (position) {
        playback();
        if (
          dialog.open &&
          get('readerFollow').checked &&
          (!page || page.s !== position.s || position.c < page.c || position.c >= page.end)
        )
          show(position, false);
      },
      open: function () {
        var book = options.book();
        if (!book || book.kind !== 'text') return;
        opener = document.activeElement;
        oldOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        get('readerTitle').textContent = book.title;
        get('readerChapter').replaceChildren();
        book.chapters.forEach(function (chapter, index) {
          var option = document.createElement('option');
          option.value = String(index);
          option.textContent = index + 1 + '. ' + chapter.title;
          get('readerChapter').appendChild(option);
        });
        dialog.showModal();
        get('readerClose').focus();
        playback();
        show(options.position(), false);
      },
    };
  };
})();
