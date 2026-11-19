/* The Voice Changer page (/voice-changer), Oct 22 2026. A classic script spliced into
 * page.html by pages.js; it reaches the engine with dynamic import() from the versioned
 * engine folder (/vc-engine/<version>/), which GET /api/kade/voice-changer/config names
 * (or, signed out, the meta tag pages.js filled in from the engine's manifest).
 *
 * Screen-reader rules (Kade's): real labelled controls; exactly ONE live region (#status),
 * written only through say(); never a word per slider step; an error moves focus to the
 * thing to fix; nothing plays on page load. A preview plays only after the person moves
 * to a voice with "Play each voice as I move to it" on, or presses a play key.
 *
 * Sound: one AudioContext (made and resumed on the person's own gesture), one sound at a
 * time (every new sound stops the last), the engine only through host/client.js (its
 * Worker does the work). Saving goes to POST /save as a WAV.
 *
 * Nov 18 2026, the effects rack and the Sound Booth hand-off:
 * - The Rack is its own part of the page. Every effect is a group under a level-three
 *   heading; every numeric setting is a slider with its value in words (aria-valuetext
 *   from the engine's speakValue) and a number box for an exact value; effects move with
 *   Move up and Move down buttons, are switched off with Bypass, and can all be removed
 *   (an empty rack plays the plain voice). After a move the same button keeps focus; after
 *   a remove, focus goes to the heading of the effect now in that place. Each change is
 *   said once through the one live region.
 * - /voice-changer?src=<https link>&bed=<https link>&title=<words> opens src as the take
 *   and bed as the backing track (see handoff() below). A backing track is the engine's
 *   sound-file bed with sync on: lined up with the take from the start, never looped,
 *   mixed under the changed voice at a level in decibels compared with the voice. */
(function () {
  'use strict';

  var API = '/api/kade/voice-changer';
  var MAX_SECONDS = 180;
  var MAX_FILE_SECONDS = 480; /* an opened file or a handed-over take: a whole song */
  var BACK_ID = 'backing'; /* the backing track's sound-file bed id in the engine */
  var BACK_LEVEL = { name: 'Backing track level', min: -40, max: 6, step: 0.5, def: -3, unit: 'db' };
  var PREFS_KEY = 'kadeVoiceChanger.prefs.v1';
  var MAX_STAGES = 12;
  var SEARCH_LIMIT = 150;

  var $ = function (id) { return document.getElementById(id); };
  var statusEl = $('status');

  /* ---------------------------------------------------------------- state */
  var S = {
    token: null,
    cfg: null,
    base: '',
    vc: null,
    P: null, /* core/params.js */
    L: null, /* core/loudness.js */
    W: null, /* core/wav.js */
    catalog: null,
    entries: new Map(), /* id -> {id,name,cat,sub,about,tags} for every browsable preset */
    catName: new Map(),
    lists: [],
    modules: [],
    modById: new Map(),
    beds: [],
    bedById: new Map(),
    soundBeds: [],
    soundBedGroups: [],
    soundBedById: new Map(),
    samples: [],
    mine: [],
    shared: [],
    userById: new Map(),
    full: new Map(), /* preset id -> full preset with chain */
    prefs: { favorites: [], recent: [], settings: { autoPreview: true, previewSeconds: 6, previewDelayMs: 450, whole: false }, updatedAt: null },
    take: null, takeSeconds: 0, takeFrom: '', takeKey: 0,
    back: null, /* the backing track: { audio, seconds, label, key } */
    backOn: false, backLevel: -3,
    side: { kind: 'none', key: '', label: '' },
    sideLoaded: '',
    bedLoaded: new Set(),
    cur: null, /* { id, name, base, chain, custom } */
    macros: { pitch: 0, timbre: 0, speed: 1, amount: 100, width: 100, volume: 0 },
    bed: null, /* null = none, else { b | file, level, p } */
    history: [], future: [], lastHistTag: '', lastHistAt: 0,
    listValue: '',
    searching: false,
    selGen: 0,
    pvTimer: 0, pvReq: null, pvGen: 0, lastPv: null, lastNoted: '',
    making: false, makeReq: null, made: null, wavCache: null,
    titleTyped: false,
    ctx: null, playing: null,
    rec: null,
  };

  /* ---------------------------------------------------------------- speaking */
  var lastSaid = '';
  /** The one live region. Same words twice still get read (a trailing space toggles). */
  function say(msg, isErr) {
    var m = String(msg || '');
    if (m === lastSaid) m = m + ' ';
    lastSaid = m;
    statusEl.className = 'status' + (isErr ? ' err' : '');
    statusEl.textContent = m;
  }
  /** Say what went wrong and put focus on the thing to fix. */
  function problem(msg, el) {
    say(msg, true);
    if (el && typeof el.focus === 'function') {
      try {
        if (el.disabled) el = null;
        if (el) {
          var d = el.closest && el.closest('details');
          while (d) { d.open = true; d = d.parentElement && d.parentElement.closest('details'); }
          el.focus();
        }
      } catch (e) { /* focus is a courtesy */ }
    }
  }
  function plural(n, one, many) { return Number(n).toLocaleString('en-US') + ' ' + (n === 1 ? one : many); }
  function secondsWords(s) {
    var n = Math.max(0, Math.round(s));
    if (n < 60) return plural(n, 'second', 'seconds');
    var m = Math.floor(n / 60), r = n % 60;
    return plural(m, 'minute', 'minutes') + (r ? ' ' + plural(r, 'second', 'seconds') : '');
  }
  function clock(s) { var n = Math.floor(s); return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0'); }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------------------------------------------------------------- server */
  async function refreshToken() {
    try { S.token = await getToken(); } catch (e) { S.token = null; }
    return S.token;
  }
  async function api(method, path, body, isForm) {
    for (var attempt = 0; attempt < 2; attempt++) {
      var headers = {};
      if (S.token) headers.Authorization = 'Bearer ' + S.token;
      if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
      var r;
      try {
        r = await fetch(path, { method: method, headers: headers, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) });
      } catch (e) {
        return { ok: false, status: 0, data: { error: 'The connection dropped, so nothing was changed. Check your internet and try again.' } };
      }
      if (r.status === 401 && attempt === 0 && S.token) { await refreshToken(); if (S.token) continue; }
      var j = null;
      try { j = await r.json(); } catch (e) { j = null; }
      return { ok: r.ok, status: r.status, data: j || {} };
    }
    return { ok: false, status: 401, data: { error: 'You are signed out now. Sign in again, then try once more.' } };
  }

  /* ---------------------------------------------------------------- sound out */
  function ac() {
    if (!S.ctx) {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) throw new Error('This browser cannot play sound from a page.');
      S.ctx = new C();
    }
    if (S.ctx.state === 'suspended') { try { S.ctx.resume(); } catch (e) { /* resumes on the next gesture */ } }
    return S.ctx;
  }
  /* The first press or key anywhere makes and wakes the one AudioContext, inside a gesture. */
  function wake() { try { ac(); } catch (e) { /* no Web Audio: playing will say so */ } }
  document.addEventListener('pointerdown', wake, { capture: true });
  document.addEventListener('keydown', wake, { capture: true });

  function beep(kind) {
    try {
      var c = ac();
      var o = c.createOscillator(), g = c.createGain();
      o.connect(g); g.connect(c.destination);
      o.frequency.value = kind === 'start' ? 660 : 440;
      g.gain.setValueAtTime(0.0001, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.25, c.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.18);
      o.start(); o.stop(c.currentTime + 0.2);
    } catch (e) { /* the earcon is a courtesy */ }
  }
  /** { sr, ch } from the engine as an AudioBuffer for the one context. */
  function toAudio(b) {
    var c = ac();
    var n = Math.max(1, b.ch[0] ? b.ch[0].length : 1);
    var a = c.createBuffer(Math.max(1, b.ch.length), n, b.sr);
    for (var i = 0; i < b.ch.length; i++) a.copyToChannel(b.ch[i].length === n ? b.ch[i] : padTo(b.ch[i], n), i);
    return a;
  }
  function padTo(s, n) { var y = new Float32Array(n); y.set(s.subarray(0, n)); return y; }
  function stopAudio() {
    if (S.playing) {
      var p = S.playing;
      S.playing = null;
      try { p.src.onended = null; p.src.stop(); } catch (e) { /* already ended */ }
    }
    showPlaying();
  }
  function play(buf, what) {
    stopAudio();
    var c;
    try { c = ac(); } catch (e) { problem(e.message); return; }
    var src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    var entry = { src: src, what: what };
    src.onended = function () { if (S.playing === entry) { S.playing = null; showPlaying(); } };
    src.start();
    S.playing = entry;
    showPlaying();
  }
  function isPlaying(what) { return !!(S.playing && S.playing.what === what); }
  function showPlaying() {
    $('playTake').textContent = isPlaying('take') ? 'Stop your recording' : 'Play your recording';
    $('fullPlay').textContent = isPlaying('full') ? 'Stop' : 'Play';
    $('backPlay').textContent = isPlaying('back') ? 'Stop the backing track' : 'Play the backing track';
  }
  /** Escape anywhere: every sound stops, and a preview still being made is dropped. */
  function stopEverything() {
    clearTimeout(S.pvTimer);
    if (S.pvReq !== null && S.vc) { S.vc.cancel(S.pvReq); S.pvReq = null; }
    S.pvGen++;
    stopAudio();
  }

  /* ---------------------------------------------------------------- preferences */
  function readLocal() {
    try {
      var raw = window.localStorage.getItem(PREFS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function writeLocal() {
    try { window.localStorage.setItem(PREFS_KEY, JSON.stringify({ favorites: S.prefs.favorites, recent: S.prefs.recent, settings: S.prefs.settings })); } catch (e) { /* private window */ }
  }
  function okIds(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (id) {
      if (typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,99}$/.test(id) && out.indexOf(id) < 0) out.push(id);
    });
    return out;
  }
  function takeSettings(s) {
    if (!s || typeof s !== 'object') return;
    var t = S.prefs.settings;
    if (typeof s.autoPreview === 'boolean') t.autoPreview = s.autoPreview;
    if (typeof s.previewSeconds === 'number' && s.previewSeconds >= 2 && s.previewSeconds <= 20) t.previewSeconds = s.previewSeconds;
    if (typeof s.previewDelayMs === 'number' && s.previewDelayMs >= 0 && s.previewDelayMs <= 2000) t.previewDelayMs = s.previewDelayMs;
    if (typeof s.whole === 'boolean') t.whole = s.whole;
  }
  async function loadPrefs() {
    var local = readLocal();
    if (local) {
      S.prefs.favorites = okIds(local.favorites);
      S.prefs.recent = okIds(local.recent);
      takeSettings(local.settings);
    }
    if (!S.token) return;
    var r = await api('GET', API + '/prefs');
    if (!r.ok) return;
    var d = r.data;
    var whole = S.prefs.settings.whole;
    if (d.updatedAt) {
      S.prefs.favorites = okIds(d.favorites);
      S.prefs.recent = okIds(d.recent);
      takeSettings(d.settings);
      S.prefs.settings.whole = whole;
    } else if (S.prefs.favorites.length || S.prefs.recent.length) {
      savePrefsSoon(); /* first time signed in here: this browser's lists go up */
    }
    S.prefs.updatedAt = d.updatedAt || null;
    writeLocal();
  }
  var prefsTimer = 0;
  function savePrefsSoon() {
    writeLocal();
    if (!S.token) return;
    clearTimeout(prefsTimer);
    prefsTimer = setTimeout(async function () {
      var st = S.prefs.settings;
      var body = {
        favorites: S.prefs.favorites.slice(0, 2000),
        recent: S.prefs.recent.slice(0, 100),
        settings: { autoPreview: !!st.autoPreview, previewSeconds: st.previewSeconds, previewDelayMs: st.previewDelayMs },
      };
      var r = await api('PUT', API + '/prefs', body);
      if (r.ok) S.prefs.updatedAt = r.data.updatedAt || S.prefs.updatedAt;
    }, 1500);
  }
  function addRecent(id) {
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,99}$/.test(id)) return;
    var r = S.prefs.recent.filter(function (x) { return x !== id; });
    r.unshift(id);
    S.prefs.recent = r.slice(0, 100);
    savePrefsSoon();
    refreshListCounts();
  }

  /* ---------------------------------------------------------------- catalog */
  var FAMILY_NAMES = {
    pitch: 'Pitch and voice', time: 'Time and speed', synth: 'Synths and robots', spec: 'Sound shaping',
    mod: 'Wobble and movement', lofi: 'Low quality and broken', device: 'Devices and gadgets', tone: 'Tone and distortion',
    echo: 'Echoes', stereo: 'Stereo and 3D', space: 'Rooms and spaces',
  };
  var BED_GROUPS = { vehicles: 'On the move', places: 'Places', nature: 'Nature', fire: 'Fire', weather: 'Weather', water: 'Water', spooky: 'Spooky' };
  function capital(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  function userPreset(p, kind) {
    var id = kind + ':' + p.id;
    return {
      id: id,
      name: p.name,
      cat: kind,
      sub: kind === 'mine' ? 'My presets' : 'Shared by ' + (p.by || 'someone'),
      about: p.about || (kind === 'mine' ? 'One of your own presets.' : 'Shared by ' + (p.by || 'someone') + '.'),
      tags: [],
      chain: Array.isArray(p.chain) ? p.chain : [],
      bed: p.bed || undefined,
      side: p.side || undefined,
      seed: p.seed === null || p.seed === undefined ? undefined : p.seed,
      macros: p.macros || null,
      cleanup: p.cleanup === false ? false : undefined,
      serverId: p.id,
    };
  }
  async function loadUserPresets() {
    if (!S.token) return;
    var r = await api('GET', API + '/presets');
    if (!r.ok) return;
    S.mine = (r.data.mine || []).map(function (p) { return userPreset(p, 'mine'); });
    S.shared = (r.data.shared || []).map(function (p) { return userPreset(p, 'shared'); });
    indexUserPresets();
  }
  function indexUserPresets() {
    S.userById = new Map();
    S.mine.concat(S.shared).forEach(function (p) { S.userById.set(p.id, p); });
    searchIndex = null;
  }
  function entryOf(id) { return S.userById.get(id) || S.entries.get(id) || null; }

  async function fullPreset(id) {
    if (S.userById.has(id)) return S.userById.get(id);
    if (S.full.has(id)) return S.full.get(id);
    var p = await S.vc.getPreset(id);
    if (p) S.full.set(id, p);
    return p;
  }

  /* search: the engine catalog's own ranking (catalog.js), run here over catalog.json */
  var FIELD_WEIGHTS = { name: 5, tags: 3, sub: 2.5, cat: 2, about: 1 };
  var searchIndex = null;
  function words(text) {
    var s = String(text || '').toLowerCase();
    var parts = s.split(/[^a-z0-9]+/).filter(Boolean);
    var joined = s.split(/\s+/).map(function (w) { return w.replace(/[^a-z0-9]/g, ''); }).filter(function (w) { return w && parts.indexOf(w) < 0; });
    return parts.concat(joined);
  }
  function variants(t) {
    var v = [t];
    if (t.length > 3 && t.slice(-1) === 's') v.push(t.slice(0, -1));
    if (t.length > 4 && t.slice(-2) === 'es') v.push(t.slice(0, -2));
    return v;
  }
  function tokenScore(fieldWords, token) {
    var best = 0;
    var vs = variants(token);
    for (var a = 0; a < vs.length; a++) {
      var t = vs[a];
      for (var i = 0; i < fieldWords.length; i++) {
        var w = fieldWords[i], s = 0;
        if (w === t) s = 1;
        else if (w.indexOf(t) === 0) s = 0.7;
        else if (t.length > 3 && w.length > t.length && w.slice(-1) === 's' && w.slice(0, -1) === t) s = 0.95;
        else if (t.length >= 4 && w.indexOf(t) >= 0) s = 0.3;
        if (s > best) best = s;
        if (best === 1) return 1;
      }
    }
    return best;
  }
  function buildSearchIndex() {
    var all = S.mine.concat(S.shared).concat(S.catalog ? S.catalog.presets : []);
    searchIndex = all.map(function (p) {
      return {
        p: p,
        f: {
          name: words(p.name),
          tags: words((p.tags || []).join(' ')),
          sub: words(p.sub),
          cat: words((S.catName.get(p.cat) || p.cat) + ' ' + p.cat),
          about: words(p.about),
        },
        low: String(p.name || '').toLowerCase(),
      };
    });
  }
  function catOrder(cat) {
    var i = S.catalog ? S.catalog.categories.findIndex(function (c) { return c.id === cat; }) : -1;
    return i < 0 ? 99 : i;
  }
  function search(query) {
    if (!searchIndex) buildSearchIndex();
    var q = String(query || '').toLowerCase().trim();
    var tokens = q.split(/[^a-z0-9]+/).filter(function (t, i, a) { return t && a.indexOf(t) === i; });
    if (!tokens.length) return [];
    var hits = [];
    for (var e = 0; e < searchIndex.length; e++) {
      var en = searchIndex[e], score = 0, ok = true;
      for (var k = 0; k < tokens.length; k++) {
        var best = 0;
        for (var f in FIELD_WEIGHTS) {
          var s = tokenScore(en.f[f], tokens[k]) * FIELD_WEIGHTS[f];
          if (s > best) best = s;
        }
        if (best <= 0) { ok = false; break; }
        score += best;
      }
      if (!ok) continue;
      if (en.low === q) score += 10;
      else if (en.low.indexOf(q) === 0) score += 4;
      if (en.p.cat !== 'mix') score += 2;
      hits.push({ p: en.p, score: score });
    }
    hits.sort(function (a, b) {
      return b.score - a.score || catOrder(a.p.cat) - catOrder(b.p.cat) || (a.p.name < b.p.name ? -1 : a.p.name > b.p.name ? 1 : 0);
    });
    return hits.map(function (h) { return h.p; });
  }

  /* ---------------------------------------------------------------- lists */
  function listIds(v) {
    if (v === 'fav') return S.prefs.favorites.filter(function (id) { return !!entryOf(id); });
    if (v === 'recent') return S.prefs.recent.filter(function (id) { return !!entryOf(id); });
    if (v === 'mine') return S.mine.map(function (p) { return p.id; });
    if (v === 'shared') return S.shared.map(function (p) { return p.id; });
    var l = S.lists.find(function (x) { return 'cat:' + x.id === v; });
    return l ? l.ids.slice() : [];
  }
  function listName(v) {
    if (v === 'fav') return 'Favorites';
    if (v === 'recent') return 'Recently used';
    if (v === 'mine') return 'My presets';
    if (v === 'shared') return 'Shared presets';
    if (v === 'search') return 'Search results';
    var l = S.lists.find(function (x) { return 'cat:' + x.id === v; });
    return l ? l.name : '';
  }
  function buildListSelect() {
    var sel = $('listSel');
    var keep = S.listValue;
    sel.textContent = '';
    if (S.searching) {
      var so = document.createElement('option');
      so.value = 'search';
      so.textContent = 'Search results (' + lastResults.length.toLocaleString('en-US') + ')';
      sel.appendChild(so);
    }
    [['fav', 'Favorites'], ['recent', 'Recently used'], ['mine', 'My presets'], ['shared', 'Shared presets']].forEach(function (x) {
      var o = document.createElement('option');
      o.value = x[0];
      o.textContent = x[1] + ' (' + listIds(x[0]).length.toLocaleString('en-US') + ')';
      sel.appendChild(o);
    });
    var g = document.createElement('optgroup');
    g.label = 'Every voice, by kind';
    S.lists.forEach(function (l) {
      var o = document.createElement('option');
      o.value = 'cat:' + l.id;
      o.textContent = l.name + ' (' + l.count.toLocaleString('en-US') + ')';
      g.appendChild(o);
    });
    sel.appendChild(g);
    sel.value = S.searching ? 'search' : keep;
    if (sel.value !== (S.searching ? 'search' : keep)) sel.selectedIndex = 0;
    sel.disabled = false;
  }
  /** New counts on the List options, changed in place so nothing under the person's focus moves.
   *  Favorites refill (the change came from the button); Recently used never reorders under them. */
  function refreshListCounts(refill) {
    if (!S.catalog) return;
    var sel = $('listSel');
    [['fav', 'Favorites'], ['recent', 'Recently used'], ['mine', 'My presets'], ['shared', 'Shared presets']].forEach(function (x) {
      var o = sel.querySelector('option[value="' + x[0] + '"]');
      if (o) o.textContent = x[1] + ' (' + listIds(x[0]).length.toLocaleString('en-US') + ')';
    });
    if (refill && !S.searching && S.listValue === refill) fillPresetList(listIds(refill), true);
  }
  /** Fill the listbox with these ids, grouped by group (sub), keeping the current voice selected. */
  function fillPresetList(ids, byCategory) {
    var box = $('presetList');
    var keep = S.cur && S.cur.id;
    box.textContent = '';
    if (!ids.length) {
      var e = document.createElement('option');
      e.disabled = true;
      e.value = '';
      e.textContent = emptyText();
      box.appendChild(e);
      box.disabled = false;
      return;
    }
    var groups = new Map();
    ids.forEach(function (id) {
      var p = entryOf(id);
      if (!p) return;
      var label = byCategory ? (S.catName.get(p.cat) || (p.cat === 'mine' ? 'My presets' : p.cat === 'shared' ? 'Shared presets' : capital(p.cat))) : p.sub || 'Other';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(p);
    });
    groups.forEach(function (list, label) {
      var g = document.createElement('optgroup');
      g.label = label;
      list.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.name;
        g.appendChild(o);
      });
      box.appendChild(g);
    });
    box.disabled = false;
    if (keep) box.value = keep;
  }
  function emptyText() {
    var v = S.searching ? 'search' : S.listValue;
    if (v === 'fav') return 'No favorites yet. Pick a voice and press Add to favorites.';
    if (v === 'recent') return 'Nothing used yet. Voices you hear land here.';
    if (v === 'mine') return S.token ? 'No presets of your own yet. Save one under Rack.' : 'Sign in to keep presets of your own.';
    if (v === 'shared') return S.token ? 'Nobody has shared a preset yet.' : 'Sign in to see presets other people share.';
    if (v === 'search') return 'No voices found.';
    return 'This list is empty.';
  }
  function showList(v, announce) {
    S.listValue = v;
    var ids = listIds(v);
    fillPresetList(ids, v === 'fav' || v === 'recent');
    if (announce) say(listName(v) + ': ' + plural(ids.length, 'voice', 'voices') + '.');
  }

  var lastResults = [];
  var searchTimer = 0, searchSayTimer = 0;
  function onSearchInput() {
    clearTimeout(searchTimer);
    clearTimeout(searchSayTimer);
    var q = $('search').value;
    searchTimer = setTimeout(function () {
      if (!S.catalog) return;
      if (!q.trim()) {
        if (S.searching) {
          S.searching = false;
          buildListSelect();
          showList(S.listValue, false);
        }
        return;
      }
      lastResults = search(q);
      S.searching = true;
      buildListSelect();
      fillPresetList(lastResults.slice(0, SEARCH_LIMIT).map(function (p) { return p.id; }), true);
    }, 150);
    searchSayTimer = setTimeout(function () {
      if (!S.catalog || !q.trim()) return;
      var n = lastResults.length;
      if (!n) say('No voices found for ' + q.trim() + '.');
      else if (n > SEARCH_LIMIT) say(plural(n, 'voice', 'voices') + ' found. The first ' + SEARCH_LIMIT + ' are in the list.');
      else say(plural(n, 'voice', 'voices') + ' found.');
    }, 800);
  }

  /* ---------------------------------------------------------------- the current voice */
  function setCurrent(p, opts) {
    opts = opts || {};
    S.cur = { id: p.id || null, name: p.name || 'Custom voice', base: p, chain: clone(p.chain || []), custom: !!opts.custom };
    S.history = [];
    S.future = [];
    S.lastHistTag = '';
    resetTweaks(p, true);
    showCurrent();
    renderChain();
  }
  function showCurrent() {
    var c = S.cur;
    if (!c) return;
    var about = c.custom && !c.base.blank ? 'Custom, based on ' + (c.base.name || 'a voice') + '. ' : '';
    $('about').textContent = (c.custom && !c.base.blank ? about : c.name + '. ') + (c.base.about || '');
    $('chainName').textContent = c.chain.length
      ? 'In the rack now: ' + c.name + ', ' + plural(c.chain.length, 'effect', 'effects') + '.'
      : 'In the rack now: ' + c.name + '. It is empty, so the voice plays plain. Add an effect below.';
    if (!S.titleTyped) $('title').value = c.name;
    var fav = $('favBtn');
    var canFav = !c.custom && !!c.id && !!entryOf(c.id);
    fav.disabled = !canFav;
    fav.setAttribute('aria-pressed', canFav && S.prefs.favorites.indexOf(c.id) >= 0 ? 'true' : 'false');
    if (!$('presetName').value || $('presetName').dataset.auto === '1') {
      $('presetName').value = c.name.slice(0, 60);
      $('presetName').dataset.auto = '1';
    }
    showSideState();
    $('undoBtn').disabled = !S.history.length;
    $('redoBtn').disabled = !S.future.length;
  }
  function markCustom() {
    if (S.cur.custom) return;
    S.cur.custom = true;
    S.cur.name = 'Custom, based on ' + (S.cur.base.name || 'a voice');
    S.cur.id = null;
    showCurrent();
    say('Now a custom voice, based on ' + (S.cur.base.name || 'a voice') + '.');
  }

  async function pickPreset(id, how) {
    if (!id) return;
    var gen = ++S.selGen;
    var p;
    try { p = await fullPreset(id); } catch (e) { p = null; }
    if (gen !== S.selGen) return;
    if (!p) { say('That voice could not be found. It may have been removed.', true); return; }
    setCurrent(p);
    if (how === 'move') {
      if (S.prefs.settings.autoPreview && S.take) schedulePreview(S.prefs.settings.previewDelayMs);
    } else if (how === 'play') {
      previewNow(true);
    }
  }

  /* ---------------------------------------------------------------- fine-tune */
  var MACROS = {
    pitch: { name: 'Pitch', min: -24, max: 24, step: 0.5, def: 0, unit: 'semitones' },
    timbre: { name: 'Timbre', min: -12, max: 12, step: 0.5, def: 0, unit: 'semitones' },
    speed: { name: 'Speed', min: 0.5, max: 2, step: 0.05, def: 1, unit: 'x' },
    amount: { name: 'Effect strength', min: 0, max: 100, step: 1, def: 100, unit: 'percent' },
    width: { name: 'Stereo width', min: 0, max: 200, step: 5, def: 100, unit: 'percent' },
    volume: { name: 'Volume', min: -12, max: 6, step: 0.5, def: 0, unit: 'db' },
  };
  var BED_LEVEL = { name: 'Background level', min: -40, max: 0, step: 1, def: -20, unit: 'db' };
  function speak(param, v) {
    try { return S.P ? S.P.speakValue(param, v) : String(v); } catch (e) { return String(v); }
  }
  function showSlider(el, param) {
    var words = speak(param, Number(el.value));
    el.setAttribute('aria-valuetext', words);
    var val = el.parentNode.querySelector('.val');
    if (val) val.textContent = words;
  }
  function clampTo(param, v) {
    v = Number(v);
    if (!Number.isFinite(v)) return param.def;
    return Math.min(param.max, Math.max(param.min, v));
  }
  /** Tweaks back to the voice's own: macros at rest (or a saved preset's own), its background, its other sound. */
  function resetTweaks(p, quiet) {
    var m = { pitch: 0, timbre: 0, speed: 1, amount: 100, width: 100, volume: 0 };
    if (p && p.macros && typeof p.macros === 'object') {
      Object.keys(MACROS).forEach(function (k) { if (typeof p.macros[k] === 'number') m[k] = clampTo(MACROS[k], p.macros[k]); });
    }
    S.macros = m;
    var bed = p && p.macros && p.macros.bed !== undefined ? p.macros.bed : p ? p.bed : null;
    S.bed = bed && (bed.b || bed.file) ? { b: bed.b, file: bed.file, level: typeof bed.level === 'number' ? bed.level : BED_LEVEL.def, p: bed.p } : null;
    if (S.bed) S.bed.level = clampTo(BED_LEVEL, S.bed.level);
    /* the person's own other sound wins over a preset's named one */
    if (S.side.kind !== 'rec' && S.side.kind !== 'file' && S.side.kind !== 'rec-wait' && S.side.kind !== 'file-wait') {
      if (p && typeof p.side === 'string' && S.soundBedById.has(p.side)) S.side = { kind: 'lib', key: 'lib:' + p.side, label: S.soundBedById.get(p.side).name };
      else if (S.side.kind === 'lib') S.side = { kind: 'none', key: '', label: '' };
    }
    syncFineTune();
    if (!quiet) say('Tweaks reset to how ' + (S.cur ? S.cur.base.name || 'this voice' : 'this voice') + ' comes.');
  }
  function syncFineTune() {
    Object.keys(MACROS).forEach(function (k) {
      var el = $('m-' + k);
      el.value = String(S.macros[k]);
      showSlider(el, MACROS[k]);
    });
    var bs = $('bedSel');
    var bv = S.bed ? (S.bed.file ? 'file:' + S.bed.file : 'b:' + S.bed.b) : 'none';
    bs.value = bv;
    if (bs.value !== bv) bs.value = 'none';
    var lv = $('bedLevel');
    lv.value = String(S.bed ? S.bed.level : BED_LEVEL.def);
    var backing = backingActive();
    bs.disabled = backing;
    lv.disabled = !S.bed || backing;
    $('bedNote').hidden = !backing;
    showSlider(lv, BED_LEVEL);
    var ss = $('sideSel');
    var sv = S.side.kind === 'lib' ? S.side.key : S.side.kind === 'rec' || S.side.kind === 'rec-wait' ? 'rec' : S.side.kind === 'file' || S.side.kind === 'file-wait' ? 'file' : 'none';
    ss.value = sv;
    if (ss.value !== sv) ss.value = 'none';
    showSideState();
  }
  function backingActive() { return !!(S.back && S.backOn); }
  function macrosNow() {
    var m = {};
    Object.keys(MACROS).forEach(function (k) { m[k] = S.macros[k]; });
    /* the engine mixes one sound under the voice: the backing track when it is on, else the
     * background. sync lines the backing track up with the take instead of looping it. */
    m.bed = backingActive() ? { file: BACK_ID, level: S.backLevel, sync: true } : S.bed ? bedSpec(S.bed) : null;
    return m;
  }
  function bedSpec(b) {
    var o = b.file ? { file: b.file, level: b.level } : { b: b.b, level: b.level };
    if (!b.file && b.p && typeof b.p === 'object' && Object.keys(b.p).length) o.p = clone(b.p);
    return o;
  }
  function tweaked() { schedulePreview(Math.max(300, S.prefs.settings.previewDelayMs), true); }

  /* ---------------------------------------------------------------- the other sound */
  function sideStages() {
    if (!S.cur) return [];
    return S.cur.chain.filter(function (st) { var m = S.modById.get(st.m); return m && m.side && !st.off; });
  }
  function sideUsers() { return S.modules.filter(function (m) { return m.side; }).map(function (m) { return m.name; }); }
  function sideActive() { return S.side.kind === 'rec' || S.side.kind === 'file' || S.side.kind === 'lib'; }
  function showSideState() {
    var users = sideStages();
    var on = users.length > 0;
    var list = sideUsers();
    var names = users.map(function (st) { return S.modById.get(st.m).name; });
    $('sideNote').textContent = on
      ? 'In this voice, ' + joinWords(names) + ' can use another sound. Pick one and your words come out of it, mixed with a storm, a song or a guitar.'
      : 'None of the effects in this voice uses another sound. These do: ' + joinWords(list) + '. Add one in the Rack to mix your voice with a storm, a song or a guitar.';
    $('sideSel').disabled = !on;
    $('sideRecBtn').disabled = !on;
    $('sideFile').disabled = !on;
    $('sideRecRow').hidden = !(S.side.kind === 'rec' || S.side.kind === 'rec-wait');
    $('sideFileRow').hidden = !(S.side.kind === 'file' || S.side.kind === 'file-wait');
    var line = 'No other sound.';
    if (S.side.kind === 'rec-wait') line = 'No second sound recorded yet. Press Record the other sound.';
    else if (S.side.kind === 'file-wait') line = 'No second file chosen yet.';
    else if (sideActive()) line = 'Other sound: ' + S.side.label + '.' + (on ? '' : ' It is used once an effect that takes it is in the rack.');
    $('sideLine').textContent = line;
  }
  function joinWords(a) {
    if (a.length <= 1) return a.join('');
    return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
  }
  /** The chain to send: while an other sound is chosen, every stage that can take one plays it. */
  function chainToSend() {
    var chain = clone(S.cur.chain);
    if (!sideActive()) return chain;
    return chain.map(function (st) {
      var m = S.modById.get(st.m);
      if (!m || !m.side || st.off) return st;
      var p = st.p ? st.p : {};
      (m.params || []).forEach(function (pr) {
        if (pr.type === 'choice' && (pr.options || []).some(function (o) { return o.v === 'side'; })) p[pr.id] = 'side';
      });
      st.p = p;
      return st;
    });
  }
  async function decodeBlob(blob) {
    var ab = await blob.arrayBuffer();
    var c = ac();
    return await new Promise(function (resolve, reject) {
      var done = false;
      var p = c.decodeAudioData(ab, function (b) { if (!done) { done = true; resolve(b); } }, function (e) { if (!done) { done = true; reject(e || new Error('decode')); } });
      if (p && typeof p.then === 'function') p.then(function (b) { if (!done) { done = true; resolve(b); } }, function (e) { if (!done) { done = true; reject(e || new Error('decode')); } });
    });
  }
  function trimmed(buf, maxSec) {
    if (buf.duration <= maxSec + 0.05) return buf;
    var c = ac();
    var n = Math.floor(maxSec * buf.sampleRate);
    var out = c.createBuffer(buf.numberOfChannels, n, buf.sampleRate);
    for (var i = 0; i < buf.numberOfChannels; i++) out.copyToChannel(buf.getChannelData(i).subarray(0, n), i);
    return out;
  }
  async function setSideSound(audio, kind, label) {
    var b = trimmed(audio, MAX_SECONDS);
    await S.vc.load(b, 'side');
    S.side = { kind: kind, key: kind + ':' + Date.now(), label: label };
    S.sideLoaded = S.side.key;
    S.lastPv = null;
    showSideState();
  }
  async function onSideChoice() {
    var v = $('sideSel').value;
    S.lastPv = null;
    if (v === 'none') {
      S.side = { kind: 'none', key: '', label: '' };
      if (S.vc) S.vc.unload('side');
      S.sideLoaded = '';
      showSideState();
      tweaked();
      return;
    }
    if (v === 'rec') { S.side = { kind: 'rec-wait', key: '', label: '' }; showSideState(); return; }
    if (v === 'file') { S.side = { kind: 'file-wait', key: '', label: '' }; showSideState(); return; }
    var id = v.replace(/^lib:/, '');
    var sb = S.soundBedById.get(id);
    if (!sb) return;
    S.side = { kind: 'lib', key: 'lib:' + id, label: sb.name };
    showSideState();
    tweaked();
  }
  async function ensureSounds() {
    if (S.side.kind === 'lib' && S.sideLoaded !== S.side.key) {
      var id = S.side.key.slice(4);
      var sb = S.soundBedById.get(id);
      var r = await fetch(sb.url);
      if (!r.ok) throw new Error('The sound ' + sb.name + ' could not be fetched.');
      var a = await decodeBlob(await r.blob());
      await S.vc.load(a, 'side');
      S.sideLoaded = S.side.key;
    }
    if (!sideActive() && S.sideLoaded) { S.vc.unload('side'); S.sideLoaded = ''; }
    if (S.bed && S.bed.file && !S.bedLoaded.has(S.bed.file)) {
      var bd = S.soundBedById.get(S.bed.file);
      if (!bd) throw new Error('That recorded background is not on this server.');
      var rr = await fetch(bd.url);
      if (!rr.ok) throw new Error('The background ' + bd.name + ' could not be fetched.');
      var ba = await decodeBlob(await rr.blob());
      await S.vc.load(ba, 'bed:' + S.bed.file);
      S.bedLoaded.add(S.bed.file);
    }
  }

  /* ---------------------------------------------------------------- your voice */
  /** The take. A recording keeps 3 minutes; an opened file or a handed-over sound keeps maxSec (8 minutes). */
  async function setTake(audio, from, maxSec) {
    var cap = maxSec || MAX_SECONDS;
    var long = audio.duration > cap + 0.05;
    var b = trimmed(audio, cap);
    stopAudio();
    await S.vc.load(b);
    S.take = b;
    S.takeSeconds = b.duration;
    S.takeFrom = from;
    S.takeKey++;
    S.lastPv = null;
    $('takeLine').textContent = 'Your recording: ' + secondsWords(b.duration) + ' ' + from + '.' + (long ? ' ' + keptWords(cap) : '');
    $('playTake').disabled = false;
    return long;
  }
  function keptWords(cap) { return 'Only the first ' + Math.round(cap / 60) + ' minutes are kept.'; }

  /* ---------------------------------------------------------------- the backing track */
  function showBacking() {
    var has = !!S.back;
    $('backOn').disabled = !has;
    $('backOn').checked = backingActive();
    var lv = $('backLevel'), num = $('backLevelNum');
    lv.disabled = !has;
    num.disabled = !has;
    lv.value = String(S.backLevel);
    num.value = String(S.backLevel);
    showSlider(lv, BACK_LEVEL);
    $('backPlay').disabled = !has;
    $('backRemove').disabled = !has;
    $('backLine').textContent = has
      ? 'Backing track: ' + S.back.label + ', ' + secondsWords(S.back.seconds) + (S.backOn ? ', playing under the voice.' : ', switched off.')
      : 'No backing track.';
    syncFineTune();
  }
  /** Keep a decoded sound as the backing track and switch it on. Returns true when it was cut to 8 minutes. */
  async function setBacking(audio, label) {
    var long = audio.duration > MAX_FILE_SECONDS + 0.05;
    var b = trimmed(audio, MAX_FILE_SECONDS);
    await S.vc.load(b, 'bed:' + BACK_ID);
    S.back = { audio: b, seconds: b.duration, label: label, key: 'back:' + Date.now() };
    S.backOn = true;
    S.lastPv = null;
    showBacking();
    return long;
  }
  function removeBacking() {
    if (!S.back) return;
    if (isPlaying('back')) stopAudio();
    var label = S.back.label;
    S.back = null;
    S.backOn = false;
    S.lastPv = null;
    if (S.vc) S.vc.unload('bed:' + BACK_ID);
    $('backFile').value = '';
    showBacking();
    say('Removed the backing track, ' + label + '.');
    $('backFile').focus();
    tweaked();
  }
  function setBackLevel(v, fromBox) {
    var x = clampTo(BACK_LEVEL, v);
    x = Math.round(x / BACK_LEVEL.step) * BACK_LEVEL.step;
    var changed = fromBox && x !== Number(v);
    S.backLevel = x;
    $('backLevel').value = String(x);
    if (fromBox || document.activeElement !== $('backLevelNum')) $('backLevelNum').value = String(x);
    showSlider($('backLevel'), BACK_LEVEL);
    if (changed) say('Backing track level set to ' + speak(BACK_LEVEL, x) + ', the nearest it goes.');
    S.lastPv = null;
    if (backingActive()) tweaked();
  }
  async function onBackFile() {
    var input = $('backFile');
    var f = input.files && input.files[0];
    if (!f) return;
    if (f.size > 400 * 1024 * 1024) { problem('That file is too big to open here. Pick one under 400 megabytes.', input); return; }
    stopEverything();
    say('Opening ' + f.name + ' as the backing track.');
    try {
      var audio = await decodeBlob(f);
      var long = await setBacking(audio, f.name);
      say('Backing track ready: ' + f.name + ', ' + secondsWords(S.back.seconds) + '.' + (long ? ' ' + keptWords(MAX_FILE_SECONDS) : '') + ' It plays under the voice in every preview and in the full version.');
      tweaked();
    } catch (e) {
      problem('That file could not be read as sound. Try a different file: most sound files and videos work.', input);
    }
  }
  function pickMime() {
    var opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < opts.length; i++) {
      try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(opts[i])) return opts[i]; } catch (e) { /* keep looking */ }
    }
    return '';
  }
  async function startRec(target) {
    var btn = target === 'side' ? $('sideRecBtn') : $('recBtn');
    if (S.rec) { if (S.rec.target === target) stopRec(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      problem('This browser cannot record here. Upload a file instead.', target === 'side' ? $('sideFile') : $('fileIn'));
      return;
    }
    stopEverything();
    var stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) {
      problem('The microphone is blocked or missing. Allow the microphone for this site, then press ' + btn.textContent + ' again.', btn);
      return;
    }
    beep('start');
    await wait(240); /* the earcon is over before the recording starts, so it is not in it */
    var mime = pickMime();
    var mr;
    try { mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); } catch (e) { mr = new MediaRecorder(stream); }
    var rec = { target: target, mr: mr, stream: stream, chunks: [], started: Date.now(), timer: 0, tick: 0, capped: false, btn: btn };
    S.rec = rec;
    mr.ondataavailable = function (ev) { if (ev.data && ev.data.size) rec.chunks.push(ev.data); };
    mr.onstop = function () { recStopped(rec); };
    mr.start(1000);
    btn.setAttribute('aria-pressed', 'true');
    var el = target === 'side' ? $('sideElapsed') : $('recElapsed');
    el.textContent = '0:00';
    rec.tick = setInterval(function () { el.textContent = clock((Date.now() - rec.started) / 1000); }, 500);
    rec.timer = setTimeout(function () { rec.capped = true; stopRec(); }, MAX_SECONDS * 1000);
    say('Recording');
  }
  function stopRec() {
    var rec = S.rec;
    if (!rec) return;
    clearTimeout(rec.timer);
    clearInterval(rec.tick);
    rec.btn.setAttribute('aria-pressed', 'false');
    try { rec.mr.stop(); } catch (e) { recStopped(rec); }
    beep('stop');
  }
  async function recStopped(rec) {
    if (rec.done) return;
    rec.done = true;
    if (S.rec === rec) S.rec = null;
    try { rec.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* already stopped */ }
    (rec.target === 'side' ? $('sideElapsed') : $('recElapsed')).textContent = '';
    if (!rec.chunks.length) { problem('No sound was caught. Check the microphone and press Record again.', rec.btn); return; }
    var blob = new Blob(rec.chunks, { type: (rec.mr && rec.mr.mimeType) || rec.chunks[0].type || 'audio/webm' });
    try {
      var audio = await decodeBlob(blob);
      if (rec.target === 'side') {
        await setSideSound(audio, 'rec', 'your second recording, ' + secondsWords(Math.min(audio.duration, MAX_SECONDS)));
        say((rec.capped ? 'Stopped at the 3-minute limit, ' : 'Stopped, ') + secondsWords(Math.min(audio.duration, MAX_SECONDS)) + '. That is now the other sound.');
        tweaked();
      } else {
        await setTake(audio, 'from your microphone');
        say((rec.capped ? 'Stopped at the 3-minute limit, ' : 'Stopped, ') + secondsWords(S.takeSeconds) + '.');
      }
    } catch (e) {
      problem('The recording could not be read. Press Record and try again.', rec.btn);
    }
  }
  async function onUpload(input, target) {
    var f = input.files && input.files[0];
    if (!f) return;
    if (f.size > 400 * 1024 * 1024) { problem('That file is too big to open here. Pick one under 400 megabytes.', input); return; }
    stopEverything();
    say('Opening ' + f.name + '.');
    try {
      var audio = await decodeBlob(f);
      if (target === 'side') {
        await setSideSound(audio, 'file', f.name);
        say('The other sound is now ' + f.name + ', ' + secondsWords(Math.min(audio.duration, MAX_SECONDS)) + '.');
        tweaked();
      } else {
        var long = await setTake(audio, 'from ' + f.name, MAX_FILE_SECONDS);
        say('Opened ' + f.name + ', ' + secondsWords(S.takeSeconds) + '.' + (long ? ' ' + keptWords(MAX_FILE_SECONDS) : ''));
      }
    } catch (e) {
      problem('That file could not be read as sound. Try a different file: most sound files and videos work.', input);
    }
  }
  /* ---------------------------------------------------------------- hand-off from the Sound Booth
   * /voice-changer?src=<link>&bed=<link>&title=<words>
   *   src    the sound to change: an https link, or a path on this site that starts with one slash
   *   bed    optional: the backing track, the same kinds of link
   *   title  optional: what to call it; it is shown, said, and used as the title of the result
   * The page fetches each link itself first. When the browser may not read it (the storage
   * sends no CORS header), a signed-in page asks GET /api/kade/voice-changer/fetch?url=, which
   * only reads the site's own storage. Anything that cannot be opened is said in a sentence,
   * and the page still works for recording and uploading. Nothing plays by itself. */
  function handLink(raw) {
    var v = String(raw || '').trim();
    if (!v) return null;
    if (v.length > 4096) return { bad: true };
    if (v.charAt(0) === '/') return v.charAt(1) === '/' || v.indexOf('\\') >= 0 ? { bad: true } : { url: v, own: true };
    var u;
    try { u = new URL(v); } catch (e) { return { bad: true }; }
    if (u.protocol !== 'https:' || u.username || u.password) return { bad: true };
    if (u.origin === window.location.origin) return { url: u.pathname + u.search, own: true };
    return { url: u.href, own: false };
  }
  async function fetchSound(link) {
    var r = null;
    try {
      r = await fetch(link.url, link.own ? { credentials: 'same-origin' } : { mode: 'cors', credentials: 'omit' });
    } catch (e) { r = null; }
    if (r && r.ok) return await r.blob();
    if (link.own) throw new Error(r ? 'It is not there any more.' : 'It could not be reached.');
    if (!S.token) throw new Error('Its storage does not let this page read it while you are signed out. Sign in, then open the link again.');
    var viaServer = API + '/fetch?url=' + encodeURIComponent(link.url);
    var p;
    try {
      p = await fetch(viaServer, { headers: { Authorization: 'Bearer ' + S.token } });
      if (p.status === 401) {
        await refreshToken();
        if (S.token) p = await fetch(viaServer, { headers: { Authorization: 'Bearer ' + S.token } });
      }
    } catch (e) {
      throw new Error('The connection dropped while opening it. Check your internet and open the link again.');
    }
    if (!p.ok) {
      var j = null;
      try { j = await p.json(); } catch (e) { j = null; }
      throw new Error((j && j.error) || 'It could not be opened just now.');
    }
    return await p.blob();
  }
  async function openLinked(link) {
    var blob = await fetchSound(link);
    try { return await decodeBlob(blob); } catch (e) { throw new Error('It could not be read as sound.'); }
  }
  /** Opens ?src= as the take and ?bed= as the backing track. Returns true when the address asked for either. */
  async function handoff() {
    var q;
    try { q = new URLSearchParams(window.location.search); } catch (e) { return false; }
    var src = handLink(q.get('src'));
    var bed = handLink(q.get('bed'));
    if (!src && !bed) return false;
    var title = String(q.get('title') || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    var said = [];
    var failed = false;
    if (src) {
      var name = title || 'the sound from the link';
      if (src.bad) { failed = true; said.push('The link to the sound cannot be used here: it has to be an https link.'); }
      else {
        say('Opening ' + name + '.');
        try {
          var audio = await openLinked(src);
          var long = await setTake(audio, title ? 'from ' + title : 'from the link', MAX_FILE_SECONDS);
          if (title) { $('title').value = title; S.titleTyped = true; }
          said.push('Opened ' + name + ', ' + secondsWords(S.takeSeconds) + '.' + (long ? ' ' + keptWords(MAX_FILE_SECONDS) : ''));
        } catch (e) {
          failed = true;
          said.push(capital(name) + ' could not be opened. ' + ((e && e.message) || ''));
        }
      }
    }
    if (bed) {
      if (bed.bad) { failed = true; said.push('The link to the backing track cannot be used here: it has to be an https link.'); }
      else {
        if (!src || failed) say('Opening the backing track.');
        try {
          var audio2 = await openLinked(bed);
          var long2 = await setBacking(audio2, title ? 'the music for ' + title : 'the sound from the link');
          said.push('Backing track ready, ' + secondsWords(S.back.seconds) + '.' + (long2 ? ' ' + keptWords(MAX_FILE_SECONDS) : ''));
        } catch (e) {
          failed = true;
          said.push('The backing track could not be opened. ' + ((e && e.message) || ''));
        }
      }
    }
    said.push(S.take ? 'Pick a preset or build a rack, then press Preview.' : 'You can still record, or upload a file.');
    say(said.join(' '), failed);
    return true;
  }

  function renderSamples() {
    var box = $('samples');
    box.textContent = '';
    S.samples.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'act quiet';
      b.textContent = String(s.name || 'Sample voice').replace(/^Sample voice:\s*/i, '');
      b.setAttribute('aria-label', s.name);
      b.addEventListener('click', function () { useSample(s, b); });
      box.appendChild(b);
    });
  }
  async function useSample(s, btn) {
    stopEverything();
    say('Opening the sample voice.');
    try {
      var r = await fetch(s.url);
      if (!r.ok) throw new Error('fetch');
      var audio = await decodeBlob(await r.blob());
      await setTake(audio, 'from the sample voice, ' + String(s.name).replace(/^Sample voice:\s*/i, ''));
      say('Sample voice ready, ' + secondsWords(S.takeSeconds) + '. Move through the voices to hear it changed.');
    } catch (e) {
      problem('The sample voice could not be opened. Try again in a moment.', btn);
    }
  }

  /* ---------------------------------------------------------------- previews */
  function previewSeconds() { return S.prefs.settings.whole ? null : S.prefs.settings.previewSeconds; }
  function presetToSend() {
    var b = S.cur.base;
    var o = { id: S.cur.custom ? null : b.id && !S.userById.has(b.id) ? b.id : null, name: S.cur.name, chain: chainToSend() };
    if (b.seed !== undefined && b.seed !== null) o.seed = b.seed;
    // mastering presets keep the low end: render.js skips its 70 Hz high pass only when preset.cleanup is false
    if (b.cleanup === false) o.cleanup = false;
    return o;
  }
  function previewKey() {
    return JSON.stringify([S.takeKey, presetToSend(), macrosNow(), S.side.kind, S.side.key, previewSeconds(), S.back ? S.back.key : '']);
  }
  function schedulePreview(delay, onlyIfAuto) {
    clearTimeout(S.pvTimer);
    if (!S.take || !S.cur) return;
    if (onlyIfAuto && !S.prefs.settings.autoPreview) return;
    S.pvTimer = setTimeout(function () { previewNow(false); }, Math.max(0, delay || 0));
  }
  async function previewNow(explicit) {
    clearTimeout(S.pvTimer);
    if (!S.cur) { if (explicit) problem('Pick a voice first.', $('presetList')); return; }
    if (!S.take) {
      if (explicit) problem('There is no recording yet. Record, upload a file or use a sample voice first.', $('recBtn'));
      return;
    }
    stopAudio();
    if (S.pvReq !== null) { S.vc.cancel(S.pvReq); S.pvReq = null; }
    var gen = ++S.pvGen;
    var key = previewKey();
    if (S.lastPv && S.lastPv.key === key) { play(S.lastPv.audio, 'preview'); return; }
    try { await ensureSounds(); } catch (e) { if (gen === S.pvGen) problem(e.message || 'A sound this voice needs could not be fetched.'); return; }
    if (gen !== S.pvGen) return;
    var secs = previewSeconds();
    var job = S.vc.preview(presetToSend(), { macros: macrosNow(), start: 0, seconds: secs || S.takeSeconds + 1 });
    S.pvReq = job.req;
    /* a preview that is asked for and takes more than a moment says so once; a quick one just plays */
    var slow = explicit ? setTimeout(function () { if (gen === S.pvGen) say('Making the preview.'); }, 1200) : 0;
    var r;
    try {
      r = await job;
    } catch (e) {
      clearTimeout(slow);
      if (S.pvReq === job.req) S.pvReq = null;
      if (gen === S.pvGen && e.code !== 'cancelled') say(e.message || 'The preview could not be made.', true);
      return;
    }
    clearTimeout(slow);
    if (S.pvReq === job.req) S.pvReq = null;
    if (gen !== S.pvGen) return;
    var audio;
    try { audio = toAudio(r); } catch (e) { problem(e.message); return; }
    S.lastPv = { key: key, audio: audio, lufs: r.report && typeof r.report.lufs === 'number' ? r.report.lufs : -16 };
    var noted = showNotes(r.report);
    /* a note from the engine (an effect fell back, the backing track no longer lines up) is
     * said once when it is new, on a preview the person asked for; it stays on the page too */
    if (explicit && noted && noted !== S.lastNoted) say(noted);
    S.lastNoted = noted;
    if (S.cur.id) addRecent(S.cur.id);
    play(audio, 'preview');
  }
  /** Shows the engine's notes under the preset; returns them as one string ('' when none). */
  function showNotes(report) {
    var notes = report && Array.isArray(report.notes) ? report.notes : [];
    var el = $('notes');
    el.textContent = notes.join(' ');
    el.hidden = !notes.length;
    return notes.join(' ');
  }
  function togglePreview() {
    if (isPlaying('preview')) { stopEverything(); return; }
    previewNow(true);
  }
  /** The original, the same stretch as the preview, at the preview's loudness, so A and B are fair. */
  function hearOriginal() {
    if (!S.take) { problem('There is no recording yet. Record, upload a file or use a sample voice first.', $('recBtn')); return; }
    stopEverything();
    var b = S.take;
    var secs = previewSeconds() || S.takeSeconds;
    var n = Math.min(b.length, Math.max(1, Math.floor(secs * b.sampleRate)));
    var ch = [];
    for (var i = 0; i < Math.min(2, b.numberOfChannels); i++) ch.push(new Float32Array(b.getChannelData(i).subarray(0, n)));
    var target = S.lastPv && S.lastPv.key === previewKey() ? S.lastPv.lufs : -16 + S.macros.volume;
    var L = -200;
    try { L = S.L.lufs({ sr: b.sampleRate, ch: ch }); } catch (e) { L = -200; }
    var g = L > -70 && target > -70 ? Math.pow(10, (target - L) / 20) : 1;
    var pk = 0;
    ch.forEach(function (s) { for (var k = 0; k < s.length; k++) { var a = Math.abs(s[k]); if (a > pk) pk = a; } });
    if (pk * g > 0.98) g = 0.98 / pk;
    ch.forEach(function (s) { for (var k = 0; k < s.length; k++) s[k] *= g; });
    play(toAudio({ sr: b.sampleRate, ch: ch }), 'original');
  }

  /* ---------------------------------------------------------------- effect chain editor */
  function histTag(tag) {
    var now = Date.now();
    if (tag && tag === S.lastHistTag && now - S.lastHistAt < 1500) { S.lastHistAt = now; return; }
    S.history.push({ chain: clone(S.cur.chain), custom: S.cur.custom, name: S.cur.name, id: S.cur.id });
    if (S.history.length > 100) S.history.shift();
    S.future = [];
    S.lastHistTag = tag || '';
    S.lastHistAt = now;
    $('undoBtn').disabled = false;
    $('redoBtn').disabled = true;
  }
  function restore(snap) {
    S.cur.chain = snap.chain;
    S.cur.custom = snap.custom;
    S.cur.name = snap.name;
    S.cur.id = snap.id;
    S.lastHistTag = '';
    renderChain();
    showCurrent();
  }
  function undo() {
    if (!S.history.length) return;
    S.future.push({ chain: clone(S.cur.chain), custom: S.cur.custom, name: S.cur.name, id: S.cur.id });
    restore(S.history.pop());
    say('Undone. ' + plural(S.cur.chain.length, 'effect', 'effects') + ' in the rack.');
    tweaked();
  }
  function redo() {
    if (!S.future.length) return;
    S.history.push({ chain: clone(S.cur.chain), custom: S.cur.custom, name: S.cur.name, id: S.cur.id });
    restore(S.future.pop());
    say('Redone. ' + plural(S.cur.chain.length, 'effect', 'effects') + ' in the rack.');
    tweaked();
  }
  function paramValue(st, pr) {
    var raw = st.p && Object.prototype.hasOwnProperty.call(st.p, pr.id) ? st.p[pr.id] : undefined;
    try { return S.P.resolveValue(pr, raw); } catch (e) { return raw === undefined ? pr.def : raw; }
  }
  function setParam(i, pr, v) {
    var st = S.cur.chain[i];
    if (!st) return;
    histTag('p:' + i + ':' + pr.id);
    st.p = st.p || {};
    if (v === pr.def) delete st.p[pr.id];
    else st.p[pr.id] = v;
    if (!Object.keys(st.p).length) delete st.p;
    markCustom();
    tweaked();
  }
  function controlFor(st, i, pr) {
    var id = 'st' + i + '-' + pr.id;
    var wrap = document.createElement('div');
    var v = paramValue(st, pr);
    if (pr.type === 'bool') {
      var lab = document.createElement('label');
      lab.className = 'check';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = id;
      cb.checked = !!v;
      cb.addEventListener('change', function () { setParam(i, pr, cb.checked); });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(' ' + pr.name));
      wrap.appendChild(lab);
      return wrap;
    }
    if (pr.type === 'choice') {
      var l2 = document.createElement('label');
      l2.className = 'field';
      l2.htmlFor = id;
      l2.textContent = pr.name;
      var sel = document.createElement('select');
      sel.id = id;
      (pr.options || []).forEach(function (o) {
        var op = document.createElement('option');
        op.value = String(o.v);
        op.textContent = o.name || String(o.v);
        sel.appendChild(op);
      });
      sel.value = String(v);
      sel.addEventListener('change', function () {
        var o = (pr.options || []).find(function (x) { return String(x.v) === sel.value; });
        setParam(i, pr, o ? o.v : pr.def);
      });
      wrap.appendChild(l2);
      wrap.appendChild(sel);
      return wrap;
    }
    /* a number: the slider (its value said in words) and, beside it, a box for an exact value */
    wrap.className = 'slider exact';
    var l3 = document.createElement('label');
    l3.htmlFor = id;
    l3.textContent = pr.name;
    var r = document.createElement('input');
    r.type = 'range';
    r.id = id;
    r.min = String(pr.min);
    r.max = String(pr.max);
    r.step = String(pr.step > 0 ? pr.step : 'any');
    r.value = String(v);
    var nb = document.createElement('input');
    nb.type = 'number';
    nb.className = 'num';
    nb.id = id + '-n';
    nb.min = String(pr.min);
    nb.max = String(pr.max);
    nb.step = String(pr.step > 0 ? pr.step : 'any');
    nb.value = String(v);
    nb.setAttribute('aria-label', pr.name + ', exact value' + unitWords(pr.unit) + ', from ' + pr.min + ' to ' + pr.max);
    var val = document.createElement('span');
    val.className = 'val';
    val.setAttribute('aria-hidden', 'true');
    wrap.appendChild(l3);
    wrap.appendChild(r);
    wrap.appendChild(nb);
    wrap.appendChild(val);
    showSlider(r, pr);
    r.addEventListener('input', function () {
      var x;
      try { x = S.P.resolveValue(pr, Number(r.value)); } catch (e) { x = Number(r.value); }
      showSlider(r, pr);
      nb.value = String(x);
      setParam(i, pr, x);
    });
    /* the box commits on Enter or on leaving it, never per keystroke; a value outside the
     * range or off the step is moved to the nearest allowed one, and that is said */
    nb.addEventListener('change', function () {
      var typed = Number(nb.value);
      if (nb.value.trim() === '' || !Number.isFinite(typed)) {
        nb.value = r.value;
        say(pr.name + ' needs a number from ' + pr.min + ' to ' + pr.max + '. It stays at ' + speak(pr, Number(r.value)) + '.', true);
        return;
      }
      var x;
      try { x = S.P.resolveValue(pr, typed); } catch (e) { x = clampTo(pr, typed); }
      r.value = String(x);
      nb.value = String(x);
      showSlider(r, pr);
      setParam(i, pr, x);
      say(pr.name + ': ' + speak(pr, x) + (x !== typed ? ', the nearest it goes.' : '.'));
    });
    return wrap;
  }
  var UNIT_WORDS = { semitones: 'semitones', cents: 'cents', percent: 'percent', ms: 'milliseconds', seconds: 'seconds', hz: 'hertz', db: 'decibels', bits: 'bits', degrees: 'degrees', meters: 'meters', bpm: 'beats per minute', steps: 'steps' };
  function unitWords(u) { return UNIT_WORDS[u] ? ' in ' + UNIT_WORDS[u] : ''; }
  function stageButton(text, cls, fn, pressed) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'act small ' + (cls || 'quiet');
    b.textContent = text;
    if (pressed !== undefined) b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    b.addEventListener('click', fn);
    return b;
  }
  function renderChain(focus) {
    var ol = $('chainList');
    ol.textContent = '';
    if (!S.cur) return;
    var n = S.cur.chain.length;
    if (!n) {
      var none = document.createElement('li');
      none.className = 'empty';
      none.textContent = 'The rack is empty. Pick an effect under Add an effect, just below, and press Add.';
      ol.appendChild(none);
    }
    S.cur.chain.forEach(function (st, i) {
      var m = S.modById.get(st.m);
      var li = document.createElement('li');
      if (st.off) li.className = 'off';
      /* a group named by its legend; the heading inside the legend lets a screen reader
       * jump from effect to effect with its heading key */
      var fs = document.createElement('fieldset');
      var lg = document.createElement('legend');
      var h = document.createElement('h3');
      h.id = 'st' + i + '-h';
      h.tabIndex = -1;
      h.textContent = 'Effect ' + (i + 1) + ' of ' + n + ': ' + (m ? m.name : st.m) + (st.off ? ', bypassed' : '');
      lg.appendChild(h);
      fs.appendChild(lg);
      if (m && m.about) {
        var ab = document.createElement('p');
        ab.className = 'stageabout';
        ab.textContent = m.about;
        fs.appendChild(ab);
      }
      if (m) (m.params || []).forEach(function (pr) { fs.appendChild(controlFor(st, i, pr)); });
      else {
        var miss = document.createElement('p');
        miss.textContent = 'This effect is not in this version of the Voice Changer. Remove it to use the rest.';
        fs.appendChild(miss);
      }
      var row = document.createElement('div');
      row.className = 'btnrow';
      /* each button says which effect it acts on, so a list of buttons makes sense on its own;
       * the words on the button come first in its name, for people who speak commands */
      var nm = m ? m.name : st.m;
      var up = stageButton('Move up', '', function () { moveStage(i, -1); });
      up.disabled = i === 0;
      up.dataset.act = 'up';
      up.setAttribute('aria-label', 'Move up, ' + nm);
      var down = stageButton('Move down', '', function () { moveStage(i, 1); });
      down.disabled = i === n - 1;
      down.dataset.act = 'down';
      down.setAttribute('aria-label', 'Move down, ' + nm);
      var by = stageButton('Bypass', '', function () { bypassStage(i); }, !!st.off);
      by.dataset.act = 'bypass';
      by.setAttribute('aria-label', 'Bypass ' + nm);
      var rm = stageButton('Remove', '', function () { removeStage(i); });
      rm.dataset.act = 'remove';
      rm.setAttribute('aria-label', 'Remove ' + nm);
      [up, down, by, rm].forEach(function (b) { row.appendChild(b); });
      fs.appendChild(row);
      li.appendChild(fs);
      ol.appendChild(li);
    });
    if (focus) {
      /* where focus lands after a change: the same button after a move or a bypass (so it
       * can be pressed again), the first setting of a new effect, and after a remove the
       * heading of the effect now in that place, never its Remove button */
      var li2 = n ? ol.children[focus.i] : null;
      var target = null;
      if (li2 && focus.act === 'heading') target = li2.querySelector('h3');
      else if (li2) {
        target = li2.querySelector('button[data-act="' + focus.act + '"]');
        if (target && target.disabled) target = li2.querySelector('button[data-act="' + (focus.act === 'up' ? 'down' : 'up') + '"]:not([disabled])') || li2.querySelector('h3');
        if (focus.first) target = li2.querySelector('input, select') || li2.querySelector('h3');
      }
      if (!target) target = $('addSel');
      if (target) target.focus();
    }
    showSideState();
  }
  function stageName(st) { var m = S.modById.get(st.m); return m ? m.name : st.m; }
  function moveStage(i, d) {
    var j = i + d;
    var ch = S.cur.chain;
    if (j < 0 || j >= ch.length) return;
    histTag('');
    var t = ch[i]; ch[i] = ch[j]; ch[j] = t;
    markCustom();
    renderChain({ i: j, act: d < 0 ? 'up' : 'down' });
    showCurrent();
    say('Moved ' + stageName(t) + (d < 0 ? ' up' : ' down') + ', now effect ' + (j + 1) + ' of ' + ch.length + '.');
    tweaked();
  }
  function bypassStage(i) {
    var st = S.cur.chain[i];
    histTag('');
    if (st.off) delete st.off; else st.off = true;
    markCustom();
    renderChain({ i: i, act: 'bypass' });
    say(stageName(st) + (st.off ? ' bypassed.' : ' back on.'));
    tweaked();
  }
  function removeStage(i) {
    var ch = S.cur.chain;
    histTag('');
    var st = ch.splice(i, 1)[0];
    markCustom();
    renderChain({ i: Math.min(i, ch.length - 1), act: 'heading' });
    showCurrent();
    var next = ch.length ? ' Now on ' + stageName(ch[Math.min(i, ch.length - 1)]) + ', effect ' + (Math.min(i, ch.length - 1) + 1) + ' of ' + ch.length + '.' : ' The rack is empty, so the voice plays plain. Undo brings it back.';
    say('Removed ' + stageName(st) + '.' + next);
    tweaked();
  }
  /** Customize: the preset as it stands becomes a rack of your own, and focus goes to its first effect. */
  function customizePreset() {
    if (!S.cur) { problem('Pick a preset first.', $('presetList')); return; }
    var was = S.cur.base.name || 'this preset';
    if (!S.cur.custom) {
      S.cur.custom = true;
      S.cur.name = 'Custom, based on ' + was;
      S.cur.id = null;
      showCurrent();
    }
    renderChain({ i: 0, act: 'heading' });
    var n = S.cur.chain.length;
    say('Customizing ' + was + ': ' + plural(n, 'effect', 'effects') + ' in the rack. Each effect is under its own heading, with its settings, then Move up, Move down, Bypass and Remove.');
  }
  /** A rack with nothing in it, to build from scratch. */
  function newRack() {
    S.selGen++;
    stopEverything();
    setCurrent({ id: null, name: 'My rack', about: 'A rack you are building yourself.', chain: [], blank: true }, { custom: true });
    $('presetList').selectedIndex = -1;
    say('Started an empty rack. Pick an effect under Add an effect and press Add.');
    $('addSel').focus();
  }
  function addStage() {
    var id = $('addSel').value;
    var m = S.modById.get(id);
    if (!m) { problem('Pick an effect to add first.', $('addSel')); return; }
    if (!S.cur) { problem('Pick a voice first.', $('presetList')); return; }
    if (S.cur.chain.length >= MAX_STAGES) { problem('A rack can hold up to ' + MAX_STAGES + ' effects. Remove one to add another.', $('addSel')); return; }
    histTag('');
    S.cur.chain.push({ m: id });
    markCustom();
    renderChain({ i: S.cur.chain.length - 1, act: 'remove', first: true });
    showCurrent();
    say('Added ' + m.name + ' as effect ' + S.cur.chain.length + ' of ' + S.cur.chain.length + '. Its settings come next.');
    tweaked();
  }
  function buildAddSelect() {
    var sel = $('addSel');
    sel.textContent = '';
    var fams = new Map();
    S.modules.forEach(function (m) {
      if (!fams.has(m.family)) fams.set(m.family, []);
      fams.get(m.family).push(m);
    });
    var order = Object.keys(FAMILY_NAMES);
    var keys = Array.from(fams.keys()).sort(function (a, b) {
      var x = order.indexOf(a), y = order.indexOf(b);
      return (x < 0 ? 99 : x) - (y < 0 ? 99 : y);
    });
    keys.forEach(function (f) {
      var g = document.createElement('optgroup');
      g.label = FAMILY_NAMES[f] || capital(f);
      fams.get(f).slice().sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; }).forEach(function (m) {
        var o = document.createElement('option');
        o.value = m.id;
        o.textContent = m.name;
        g.appendChild(o);
      });
      sel.appendChild(g);
    });
    showAddAbout();
  }
  function showAddAbout() {
    var m = S.modById.get($('addSel').value);
    $('addAbout').textContent = m ? m.about : '';
  }
  function exportObject() {
    var o = { name: S.cur.name, about: S.cur.base.about || '', chain: clone(S.cur.chain) };
    var mac = {};
    Object.keys(MACROS).forEach(function (k) { if (S.macros[k] !== MACROS[k].def) mac[k] = S.macros[k]; });
    if (Object.keys(mac).length) o.macros = mac;
    o.bed = S.bed ? bedSpec(S.bed) : null;
    if (S.side.kind === 'lib') o.side = S.side.key.slice(4);
    if (S.cur.base.seed !== undefined && S.cur.base.seed !== null) o.seed = S.cur.base.seed;
    if (S.cur.base.cleanup === false) o.cleanup = false;
    return o;
  }
  function copyChain() {
    if (!S.cur) return;
    var text = JSON.stringify(exportObject(), null, 2);
    var done = function () { say('Copied the rack as text. ' + plural(S.cur.chain.length, 'effect', 'effects') + '.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { $('ioText').value = text; problem('The clipboard is not available here, so the rack is in the Preset as text box instead.', $('ioText')); });
    } else {
      $('ioText').value = text;
      problem('The clipboard is not available here, so the rack is in the Preset as text box instead.', $('ioText'));
    }
  }
  function exportBox() {
    if (!S.cur) return;
    $('ioText').value = JSON.stringify(exportObject(), null, 2);
    say('The current rack is in the Preset as text box.');
  }
  function importBox() {
    var box = $('ioText');
    var text = box.value.trim();
    if (!text) { problem('The Preset as text box is empty. Paste a preset there first.', box); return; }
    var o;
    try { o = JSON.parse(text); } catch (e) { problem('That text is not a preset: it could not be read. Paste the whole preset, from the first brace to the last.', box); return; }
    if (Array.isArray(o)) o = { chain: o };
    if (!o || typeof o !== 'object' || !Array.isArray(o.chain) || !o.chain.length) { problem('That preset has no list of effects.', box); return; }
    if (o.chain.length > MAX_STAGES) { problem('That preset has ' + o.chain.length + ' effects; a voice can hold up to ' + MAX_STAGES + '.', box); return; }
    var chain = [];
    for (var i = 0; i < o.chain.length; i++) {
      var st = o.chain[i];
      var m = st && S.modById.get(st.m);
      if (!m) { problem('Effect ' + (i + 1) + ' in that preset is not one the Voice Changer has.', box); return; }
      var p = {};
      var probs = [];
      var src = st.p && typeof st.p === 'object' ? st.p : {};
      for (var k in src) {
        var pr = (m.params || []).find(function (x) { return x.id === k; });
        if (!pr) { problem('Effect ' + (i + 1) + ', ' + m.name + ', has no setting called ' + k + '.', box); return; }
        p[k] = S.P.resolveValue(pr, src[k], probs);
      }
      if (probs.length) { problem('Effect ' + (i + 1) + ', ' + m.name + ': ' + probs.join(' '), box); return; }
      var out = { m: m.id };
      if (Object.keys(p).length) out.p = p;
      if (st.off === true) out.off = true;
      chain.push(out);
    }
    var name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 60) : 'Imported voice';
    var bed = o.bed && typeof o.bed === 'object' && ((o.bed.b && S.bedById.has(o.bed.b)) || (o.bed.file && S.soundBedById.has(o.bed.file))) ? o.bed : null;
    var p2 = { id: null, name: name, about: typeof o.about === 'string' ? o.about.slice(0, 160) : '', chain: chain, bed: bed || undefined, seed: typeof o.seed === 'number' ? o.seed : undefined, macros: o.macros && typeof o.macros === 'object' ? o.macros : null, side: typeof o.side === 'string' ? o.side : undefined, cleanup: o.cleanup === false ? false : undefined };
    if (!bed && p2.macros) p2.macros = Object.assign({}, p2.macros, { bed: null });
    setCurrent(p2, { custom: false });
    S.cur.name = name;
    showCurrent();
    say('Imported ' + name + ', ' + plural(chain.length, 'effect', 'effects') + '.');
    tweaked();
  }
  async function savePreset() {
    if (!S.token) { problem('Saving presets needs you to be signed in.', $('presetSave')); return; }
    if (!S.cur) { problem('Pick a voice first.', $('presetList')); return; }
    var nameEl = $('presetName');
    var name = nameEl.value.replace(/\s+/g, ' ').trim();
    if (!name) { problem('Give the preset a name first.', nameEl); return; }
    if (!S.cur.chain.length) { problem('A preset needs at least one effect. Add one to the rack first.', $('addSel')); return; }
    var o = exportObject();
    var body = { name: name, about: (S.cur.custom ? 'Based on ' + (S.cur.base.name || 'a voice') + '.' : o.about || '').slice(0, 160), chain: o.chain, bed: o.bed, shared: $('presetShare').checked };
    if (o.macros) body.macros = o.macros;
    if (o.side) body.side = o.side;
    if (o.seed !== undefined) body.seed = o.seed;
    $('presetSave').disabled = true;
    say('Saving the preset.');
    var r = await api('POST', API + '/presets', body);
    $('presetSave').disabled = false;
    if (!r.ok) { problem(r.data.error || 'The preset could not be saved. Try again.', nameEl); return; }
    var up = userPreset(r.data, 'mine');
    S.mine.unshift(up);
    indexUserPresets();
    S.cur.id = up.id;
    S.cur.name = up.name;
    S.cur.base = up;
    S.cur.custom = false;
    nameEl.dataset.auto = '1';
    refreshListCounts('mine');
    showCurrent();
    say('Saved ' + up.name + ' to My presets.' + (body.shared ? ' Everyone can use it now.' : ''));
  }

  /* ---------------------------------------------------------------- surprise */
  function findListFor(id) {
    var l = S.lists.find(function (x) { return x.ids.indexOf(id) >= 0; });
    return l ? 'cat:' + l.id : '';
  }
  async function surpriseMe() {
    if (!S.catalog || !S.catalog.presets.length) return;
    var all = S.catalog.presets;
    var p = all[Math.floor(Math.random() * all.length)];
    if (S.cur && p.id === S.cur.id && all.length > 1) p = all[(all.indexOf(p) + 1) % all.length];
    var lv = findListFor(p.id);
    if (S.searching) { $('search').value = ''; S.searching = false; }
    if (lv) { S.listValue = lv; buildListSelect(); showList(lv, false); }
    $('presetList').value = p.id;
    say('Surprise: ' + p.name + ', from ' + listName(lv) + '.' + (S.take ? '' : ' Record or use a sample voice to hear it.'));
    await pickPreset(p.id, S.take ? 'play' : 'none');
  }
  var catalogModule = null;
  async function freshVoice() {
    say('Making a brand new random voice.');
    try {
      if (!catalogModule) catalogModule = await import(S.base + 'catalog.js');
      var seed = Math.floor(Math.random() * 1e9);
      var p = catalogModule.surprise(seed, { fresh: true });
      if (!p) throw new Error('none');
      S.selGen++;
      setCurrent(clone(p), { custom: false });
      S.cur.id = null;
      showCurrent();
      say(p.name + '. ' + p.about + (S.take ? '' : ' Record or use a sample voice to hear it.'));
      if (S.take) previewNow(true);
    } catch (e) {
      problem('A random voice could not be made just now. Try again.', $('freshBtn'));
    }
  }
  function toggleFavorite() {
    var c = S.cur;
    if (!c || c.custom || !c.id) return;
    var f = S.prefs.favorites;
    var i = f.indexOf(c.id);
    if (i >= 0) { f.splice(i, 1); say('Removed ' + c.name + ' from favorites.'); }
    else { f.unshift(c.id); say('Added ' + c.name + ' to favorites. ' + plural(f.length, 'favorite', 'favorites') + '.'); }
    $('favBtn').setAttribute('aria-pressed', i >= 0 ? 'false' : 'true');
    savePrefsSoon();
    refreshListCounts('fav');
  }

  /* ---------------------------------------------------------------- make it */
  async function makeFull() {
    if (S.making) return;
    if (!S.cur) { problem('Pick a voice first.', $('presetList')); return; }
    if (!S.take) { problem('There is no recording yet. Record, upload a file or use a sample voice first.', $('recBtn')); return; }
    stopEverything();
    S.making = true;
    $('makeBtn').disabled = true;
    $('makeCancel').hidden = false;
    var prog = $('makeProg');
    prog.value = 0;
    var step = 0;
    say('Making the full version, ' + secondsWords(S.takeSeconds) + ' of sound' + (backingActive() ? ', with the backing track' : '') + '.');
    var info = { presetId: S.cur.id || '', presetName: S.cur.name, macros: macrosNow(), chain: chainToSend() };
    try {
      await ensureSounds();
      var job = S.vc.render(presetToSend(), {
        macros: info.macros,
        onProgress: function (f) {
          var pct = Math.round(Math.max(0, Math.min(1, f)) * 100);
          prog.value = pct;
          /* a short take says the quarters; a long one (a song) says every ten percent */
          var every = S.takeSeconds > 45 ? 10 : 25;
          var s = Math.floor(pct / every);
          if (s > step && s * every < 100) { step = s; say('Making it, ' + s * every + ' percent.'); }
        },
      });
      S.makeReq = job.req;
      var r = await job;
      var secs = r.ch[0] ? r.ch[0].length / r.sr : 0;
      S.made = { buf: r, audio: toAudio(r), seconds: secs, info: info };
      S.wavCache = null;
      prog.value = 100;
      var noted = showNotes(r.report);
      $('fullLine').textContent = 'Full version: ' + info.presetName + ', ' + secondsWords(secs) + (info.macros.bed && info.macros.bed.file === BACK_ID ? ', with the backing track' : '') + '.';
      $('fullPlay').disabled = false;
      $('dlBtn').disabled = false;
      /* My Creations keeps up to the server's limit (a little over 3 minutes); anything longer downloads */
      var tooLong = secs > saveMaxSeconds();
      $('saveBtn').disabled = !S.token || tooLong;
      if (S.token) {
        $('saveNote').hidden = !tooLong;
        if (tooLong) $('saveNote').textContent = 'This is longer than My Creations keeps from the Voice Changer, which is ' + secondsWords(saveMaxSeconds()) + '. Download it instead.';
      }
      $('savedLine').hidden = true;
      if (info.presetId) addRecent(info.presetId);
      say('Done, ' + secondsWords(secs) + '. Press Play to hear it' + (tooLong ? ', or Download to keep it. It is too long to save to My Creations.' : '.') + (noted ? ' ' + noted : ''));
    } catch (e) {
      prog.value = 0;
      if (e && e.code === 'cancelled') say('Stopped. Nothing was made.');
      else problem((e && e.message) || 'The full version could not be made.', $('makeBtn'));
    } finally {
      S.making = false;
      S.makeReq = null;
      $('makeBtn').disabled = false;
      $('makeCancel').hidden = true;
    }
  }
  function saveMaxSeconds() { return S.cfg && typeof S.cfg.saveMaxSeconds === 'number' ? S.cfg.saveMaxSeconds : 190; }
  function cancelMake() {
    if (!S.making) return;
    if (S.makeReq !== null) S.vc.cancel(S.makeReq);
    $('makeBtn').focus();
  }
  function wavBlob() {
    if (!S.made) return null;
    if (!S.wavCache) S.wavCache = new Blob([S.W.encodeWav({ sr: S.made.buf.sr, ch: S.made.buf.ch }, 16)], { type: 'audio/wav' });
    return S.wavCache;
  }
  function titleNow() {
    var t = $('title').value.replace(/\s+/g, ' ').trim();
    return (t || (S.made ? S.made.info.presetName : 'Voice Changer recording')).slice(0, 80);
  }
  function fileName(t) { return (t.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Voice Changer recording') + '.wav'; }
  async function saveCreation() {
    if (!S.token) { problem('Saving to My Creations needs you to be signed in. Download still works.', $('dlBtn')); return; }
    if (!S.made) { problem('Make the full version first.', $('makeBtn')); return; }
    var title = titleNow();
    var fd = new FormData();
    fd.append('title', title);
    if (S.made.info.presetId) fd.append('presetId', S.made.info.presetId);
    fd.append('presetName', S.made.info.presetName.slice(0, 80));
    fd.append('macros', JSON.stringify(S.made.info.macros));
    fd.append('chain', JSON.stringify(S.made.info.chain));
    fd.append('seconds', String(Math.round(S.made.seconds * 100) / 100));
    fd.append('audio', wavBlob(), fileName(title));
    $('saveBtn').disabled = true;
    say('Saving ' + title + ' to My Creations.');
    var r = await api('POST', API + '/save', fd, true);
    $('saveBtn').disabled = false;
    if (!r.ok) { problem(r.data.error || 'It could not be saved just now. Try again.', $('saveBtn')); return; }
    var line = $('savedLine');
    line.textContent = 'Saved as ' + title + '. ';
    var a = document.createElement('a');
    a.href = '/my-creations';
    a.textContent = 'Open My Creations';
    line.appendChild(a);
    line.hidden = false;
    say('Saved to My Creations as ' + title + '. The link to open it is just below the Save button.');
  }
  function download() {
    if (!S.made) { problem('Make the full version first.', $('makeBtn')); return; }
    var name = fileName(titleNow());
    var url = URL.createObjectURL(wavBlob());
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    say('Downloading ' + name + '.');
  }

  /* ---------------------------------------------------------------- settings */
  function showSettings() {
    var st = S.prefs.settings;
    $('autoPv').checked = !!st.autoPreview;
    var lv = st.whole ? 'whole' : String(st.previewSeconds);
    $('pvLen').value = lv;
    if ($('pvLen').value !== lv) $('pvLen').value = '6';
    var dv = String(st.previewDelayMs);
    $('pvDelay').value = dv;
    if ($('pvDelay').value !== dv) {
      var near = [0, 250, 450, 800].reduce(function (a, b) { return Math.abs(b - st.previewDelayMs) < Math.abs(a - st.previewDelayMs) ? b : a; }, 450);
      $('pvDelay').value = String(near);
      st.previewDelayMs = near; /* the wait used is the one the menu shows */
    }
  }

  /* ---------------------------------------------------------------- wiring */
  function wire() {
    $('recBtn').addEventListener('click', function () { startRec('take'); });
    $('sideRecBtn').addEventListener('click', function () { startRec('side'); });
    $('fileIn').addEventListener('change', function () { onUpload($('fileIn'), 'take'); });
    $('sideFile').addEventListener('change', function () { onUpload($('sideFile'), 'side'); });
    $('playTake').addEventListener('click', function () {
      if (isPlaying('take')) { stopAudio(); return; }
      if (!S.take) { problem('There is no recording yet.', $('recBtn')); return; }
      stopEverything();
      play(S.take, 'take');
    });
    $('search').addEventListener('input', onSearchInput);
    $('search').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var box = $('presetList');
        if (box.options.length && !box.options[0].disabled) {
          if (box.selectedIndex < 0) { box.selectedIndex = 0; pickPreset(box.value, 'move'); }
          box.focus();
        }
      }
    });
    $('listSel').addEventListener('change', function () {
      var v = $('listSel').value;
      if (v === 'search') return;
      if (S.searching) { $('search').value = ''; S.searching = false; buildListSelect(); $('listSel').value = v; }
      showList(v, true);
    });
    var box = $('presetList');
    var lastPicked = '';
    function moved() {
      var v = box.value;
      if (!v || v === lastPicked) return;
      lastPicked = v;
      pickPreset(v, 'move');
    }
    box.addEventListener('change', moved);
    box.addEventListener('input', moved);
    box.addEventListener('keydown', function (e) {
      if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); if (box.value && box.value !== lastPicked) moved(); togglePreview(); }
      else if (e.key === 'Enter') { e.preventDefault(); makeFull(); }
    });
    $('pvPlay').addEventListener('click', function () { previewNow(true); });
    $('pvStop').addEventListener('click', stopEverything);
    $('surpriseBtn').addEventListener('click', surpriseMe);
    $('freshBtn').addEventListener('click', freshVoice);
    $('favBtn').addEventListener('click', toggleFavorite);
    $('origBtn').addEventListener('click', hearOriginal);
    $('autoPv').addEventListener('change', function () { S.prefs.settings.autoPreview = $('autoPv').checked; savePrefsSoon(); });
    $('pvLen').addEventListener('change', function () {
      var v = $('pvLen').value;
      if (v === 'whole') S.prefs.settings.whole = true;
      else { S.prefs.settings.whole = false; S.prefs.settings.previewSeconds = Number(v); }
      S.lastPv = null;
      savePrefsSoon();
    });
    $('pvDelay').addEventListener('change', function () { S.prefs.settings.previewDelayMs = Number($('pvDelay').value); savePrefsSoon(); });
    Object.keys(MACROS).forEach(function (k) {
      var el = $('m-' + k);
      el.addEventListener('input', function () {
        S.macros[k] = clampTo(MACROS[k], el.value);
        showSlider(el, MACROS[k]);
        tweaked();
      });
    });
    $('bedSel').addEventListener('change', function () {
      var v = $('bedSel').value;
      var level = S.bed ? S.bed.level : Number($('bedLevel').value);
      if (v === 'none') S.bed = null;
      else if (v.indexOf('file:') === 0) S.bed = { file: v.slice(5), level: level };
      else {
        var id = v.slice(2);
        var keepP = S.cur && S.cur.base.bed && S.cur.base.bed.b === id ? S.cur.base.bed.p : undefined;
        S.bed = { b: id, level: level, p: keepP };
      }
      $('bedLevel').disabled = !S.bed;
      tweaked();
    });
    $('bedLevel').addEventListener('input', function () {
      var el = $('bedLevel');
      showSlider(el, BED_LEVEL);
      if (S.bed) { S.bed.level = clampTo(BED_LEVEL, el.value); tweaked(); }
    });
    $('sideSel').addEventListener('change', onSideChoice);
    $('resetBtn').addEventListener('click', function () {
      if (!S.cur) return;
      if (S.side.kind === 'rec' || S.side.kind === 'file' || S.side.kind === 'rec-wait' || S.side.kind === 'file-wait') {
        S.side = { kind: 'none', key: '', label: '' };
        if (S.vc) S.vc.unload('side');
        S.sideLoaded = '';
      }
      resetTweaks(S.cur.base, false);
      S.lastPv = null;
      tweaked();
    });
    $('backFile').addEventListener('change', onBackFile);
    $('backOn').addEventListener('change', function () {
      S.backOn = $('backOn').checked && !!S.back;
      S.lastPv = null;
      showBacking();
      say(S.backOn ? 'The backing track plays under the voice, at ' + speak(BACK_LEVEL, S.backLevel) + '.' : 'The backing track is switched off.');
      tweaked();
    });
    $('backLevel').addEventListener('input', function () { setBackLevel($('backLevel').value, false); });
    $('backLevelNum').addEventListener('change', function () {
      var el = $('backLevelNum');
      if (el.value.trim() === '' || !Number.isFinite(Number(el.value))) {
        el.value = String(S.backLevel);
        say('Backing track level needs a number from ' + BACK_LEVEL.min + ' to ' + BACK_LEVEL.max + '. It stays at ' + speak(BACK_LEVEL, S.backLevel) + '.', true);
        return;
      }
      var typed = Number(el.value);
      setBackLevel(typed, true);
      if (S.backLevel === typed) say('Backing track level: ' + speak(BACK_LEVEL, S.backLevel) + '.');
    });
    $('backPlay').addEventListener('click', function () {
      if (isPlaying('back')) { stopAudio(); return; }
      if (!S.back) return;
      stopEverything();
      play(S.back.audio, 'back');
    });
    $('backRemove').addEventListener('click', removeBacking);
    $('customBtn').addEventListener('click', customizePreset);
    $('newRackBtn').addEventListener('click', newRack);
    $('rackPreview').addEventListener('click', function () { previewNow(true); });
    $('rackStop').addEventListener('click', stopEverything);
    $('resPreview').addEventListener('click', function () { previewNow(true); });
    $('undoBtn').addEventListener('click', undo);
    $('redoBtn').addEventListener('click', redo);
    $('copyBtn').addEventListener('click', copyChain);
    $('addSel').addEventListener('change', showAddAbout);
    $('addBtn').addEventListener('click', addStage);
    $('presetName').addEventListener('input', function () { $('presetName').dataset.auto = '0'; });
    $('presetSave').addEventListener('click', savePreset);
    $('exportBtn').addEventListener('click', exportBox);
    $('importBtn').addEventListener('click', importBox);
    $('makeBtn').addEventListener('click', makeFull);
    $('makeCancel').addEventListener('click', cancelMake);
    $('fullPlay').addEventListener('click', function () {
      if (isPlaying('full')) { stopAudio(); return; }
      if (!S.made) return;
      stopEverything();
      play(S.made.audio, 'full');
    });
    $('title').addEventListener('input', function () { S.titleTyped = !!$('title').value.trim(); });
    $('saveBtn').addEventListener('click', saveCreation);
    $('dlBtn').addEventListener('click', download);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        if (S.playing || S.pvReq !== null || S.pvTimer) stopEverything();
      }
    });
  }

  function engineProblem(msg) {
    say(msg, true);
    $('about').textContent = 'The voices are not available just now.';
  }

  async function boot() {
    wire();
    showSettings();
    var meta = document.querySelector('meta[name="vc-engine-base"]');
    var metaBase = meta ? meta.getAttribute('content') || '' : '';
    if (!/^\/vc-engine\/[A-Za-z0-9._-]+\/$/.test(metaBase)) metaBase = '';
    await refreshToken();
    if (S.token) {
      var r = await api('GET', API + '/config');
      if (r.ok && r.data && r.data.engineBase) S.cfg = r.data;
    }
    S.base = (S.cfg && S.cfg.engineBase) || metaBase;
    if (!S.token) {
      $('signedOut').hidden = false;
      $('saveNote').hidden = false;
      $('presetSaveNote').hidden = false;
      $('presetSave').disabled = true;
      $('presetShare').disabled = true;
    } else {
      $('saveNote').hidden = true;
      $('presetSaveNote').hidden = true;
    }
    if (!S.base) { engineProblem('The Voice Changer engine could not be found on the server. Please try again a little later.'); return; }
    S.samples = S.cfg && Array.isArray(S.cfg.samples) && S.cfg.samples.length ? S.cfg.samples : [
      { id: 'sample-woman', name: 'Sample voice: a woman talking', url: S.base + 'samples/sample-woman.wav' },
      { id: 'sample-man', name: 'Sample voice: a man talking', url: S.base + 'samples/sample-man.wav' },
    ];
    renderSamples();
    S.soundBeds = S.cfg && Array.isArray(S.cfg.soundBeds) ? S.cfg.soundBeds : [];
    S.soundBedGroups = S.cfg && Array.isArray(S.cfg.soundBedGroups) ? S.cfg.soundBedGroups : [];
    S.soundBeds.forEach(function (b) { S.soundBedById.set(b.id, b); });
    var mods;
    try {
      mods = await Promise.all([
        import(S.base + 'host/client.js'),
        import(S.base + 'core/params.js'),
        import(S.base + 'core/loudness.js'),
        import(S.base + 'core/wav.js'),
      ]);
    } catch (e) {
      engineProblem('The Voice Changer engine could not be loaded. Reload the page to try again.');
      return;
    }
    S.P = mods[1];
    S.L = mods[2];
    S.W = mods[3];
    syncFineTune();
    S.vc = mods[0].createEngine({ base: S.base });
    var got;
    try {
      got = await Promise.all([
        S.vc.catalog(),
        fetch(S.base + 'modules.json').then(function (r) { if (!r.ok) throw new Error('modules'); return r.json(); }),
        fetch(S.base + 'beds.json').then(function (r) { if (!r.ok) throw new Error('beds'); return r.json(); }),
        loadPrefs(),
        loadUserPresets(),
      ]);
    } catch (e) {
      engineProblem('The list of voices could not be loaded. Reload the page to try again.');
      return;
    }
    S.catalog = got[0];
    S.modules = got[1];
    S.beds = got[2];
    S.modules.forEach(function (m) { S.modById.set(m.id, m); });
    S.beds.forEach(function (b) { S.bedById.set(b.id, b); });
    (S.catalog.categories || []).forEach(function (c) { S.catName.set(c.id, c.name); });
    (S.catalog.presets || []).forEach(function (p) { S.entries.set(p.id, p); });
    S.lists = (S.catalog.lists || []).filter(function (l) { return l.count > 0; });
    buildBedSelect();
    buildSideSelect();
    buildAddSelect();
    showSettings();
    S.listValue = S.prefs.favorites.some(function (id) { return !!entryOf(id); }) ? 'fav' : S.lists.length ? 'cat:' + S.lists[0].id : 'fav';
    buildListSelect();
    showList(S.listValue, false);
    var box = $('presetList');
    if (box.options.length && !box.options[0].disabled) {
      box.selectedIndex = 0;
      await pickPreset(box.value, 'none');
    }
    var total = S.catalog.presets.length;
    showBacking();
    /* a link from the Sound Booth (?src=, ?bed=, ?title=) is opened once everything is ready */
    var handed = false;
    try { handed = await handoff(); } catch (e) { handed = false; }
    if (!handed) say('Ready: ' + plural(total, 'voice', 'voices') + ' in ' + plural(S.lists.length, 'list', 'lists') + ', and ' + plural(S.modules.length, 'effect', 'effects') + ' for the rack. Record, upload a file or use a sample voice, then move through the presets.');
  }
  function buildBedSelect() {
    var sel = $('bedSel');
    sel.textContent = '';
    var none = document.createElement('option');
    none.value = 'none';
    none.textContent = 'None';
    sel.appendChild(none);
    var groups = new Map();
    S.beds.forEach(function (b) {
      if (!groups.has(b.group)) groups.set(b.group, []);
      groups.get(b.group).push(b);
    });
    groups.forEach(function (list, gid) {
      var g = document.createElement('optgroup');
      g.label = BED_GROUPS[gid] || capital(gid);
      list.forEach(function (b) {
        var o = document.createElement('option');
        o.value = 'b:' + b.id;
        o.textContent = b.name;
        g.appendChild(o);
      });
      sel.appendChild(g);
    });
    var rg = new Map();
    S.soundBeds.forEach(function (b) {
      if (!rg.has(b.group)) rg.set(b.group, []);
      rg.get(b.group).push(b);
    });
    rg.forEach(function (list, gid) {
      var gname = (S.soundBedGroups.find(function (x) { return x.id === gid; }) || {}).name || capital(gid);
      var g = document.createElement('optgroup');
      g.label = gname + ', recorded';
      list.forEach(function (b) {
        var o = document.createElement('option');
        o.value = 'file:' + b.id;
        o.textContent = b.name + ' (recorded)';
        g.appendChild(o);
      });
      sel.appendChild(g);
    });
    syncFineTune();
  }
  function buildSideSelect() {
    var sel = $('sideSel');
    if (!S.soundBeds.length) return;
    var g = document.createElement('optgroup');
    g.label = 'Recorded sounds from the library';
    S.soundBeds.forEach(function (b) {
      var o = document.createElement('option');
      o.value = 'lib:' + b.id;
      o.textContent = b.name;
      g.appendChild(o);
    });
    sel.appendChild(g);
  }

  boot().catch(function (e) {
    engineProblem('Something went wrong while starting the Voice Changer: ' + ((e && e.message) || e) + '. Reload the page to try again.');
  });
})();
