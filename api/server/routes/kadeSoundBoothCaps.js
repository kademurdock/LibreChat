'use strict';
/* Character caps on the Sound Booth's text boxes (Nov 17 2026, her ask: "if someone is going to write
 * 5000 chars and it only accepts 2000 on a model, the textbox needs to reflect that").
 *
 * Both page scripts (the booth and its Open voices panel) run this very function: CAPS_SOURCE is its
 * source, spliced in by interpolation, so no template-literal escaping touches it. The limits come from
 * the server (the guide's scriptMax and maxChars, the open-voices engine list), never from here.
 *
 * What it does for one box, given { max, who, label, cut, measure, measureNote, reads }:
 * - maxlength is the limit, so typing and pasting stop there. maxlength never cuts text that is
 *   already in the box, and nothing here does either.
 * - A count under the box ("120 of 2,500 characters."), tied to it by aria-describedby. It is not a
 *   live region, so it is never read on its own while she types.
 * - Said once in the status line: when the box reaches the limit (again only after it drops well
 *   under it, or she leaves the box), when a paste was cut to fit, when a paste had no room at all, and
 *   when a picker change (or a filled-in draft) leaves more in the box than the engine takes. That last
 *   one keeps her words and says how many characters are over.
 * - The page's say() calls notes() before it writes, so an over-limit note found while the page is
 *   saying something else goes out in that one sentence: the live region changes once, not twice.
 * - measure: the server counts only part of the box (Lyria's brief, not a Lyrics: part under it). The
 *   count and the over note use it, and there is no maxlength, since the box may rightly hold more.
 * - reads: the engine reads only this many characters, though the server takes up to max (ACE's 512).
 *   The count says so past it, and the status says it once each time the box goes past it.
 * max 0 shows the count with no limit; a null cap takes the count and the limit away. */
function boothCaps(opts) {
  var say = opts.say;
  var recs = {}, pending = {}, timer = null, paste = null;
  function fmt(n) { return Number(n).toLocaleString('en-US'); }
  function hiddenNow(box) { return !box.isConnected || !!box.closest('[hidden]'); }
  /* A box's own label, read as the start of a sentence: no "(without a reference)", no closing "?" or ":". */
  function plain(label) { return String(label || 'This box').replace(/\s*\([^)]*\)/g, '').replace(/[\s?:.!]+$/, '') || 'This box'; }
  function forWho(r) { return r.who ? ' for ' + r.who : ''; }
  function size(r) { return r.measure ? r.measure(r.box.value) : r.box.value.length; }
  function countBox(box, make) {
    var id = box.id + '_count', c = document.getElementById(id);
    var d = (box.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
    if (!make) {
      if (c) c.remove();
      if (d.indexOf(id) >= 0) box.setAttribute('aria-describedby', d.filter(function (x) { return x !== id; }).join(' '));
      return null;
    }
    if (!c) { c = document.createElement('p'); c.className = 'hint'; c.id = id; box.insertAdjacentElement('afterend', c); }
    if (d.indexOf(id) < 0) { d.push(id); box.setAttribute('aria-describedby', d.join(' ')); }
    return c;
  }
  function line(r) {
    var n = size(r), t;
    if (!r.max) t = fmt(n) + (n === 1 ? ' character.' : ' characters.');
    else t = fmt(n) + ' of ' + fmt(r.max) + ' characters' + (n > r.max ? ', ' + fmt(n - r.max) + ' over.' : '.');
    if (r.measure && r.measureNote && n !== r.box.value.length) t += ' ' + r.measureNote;
    if (r.reads && n > r.reads) t += ' ' + (r.who || 'This engine') + ' reads about the first ' + fmt(r.reads) + '.';
    return t;
  }
  function overNote(r) {
    var over = size(r) - r.max;
    return plain(r.label) + ': ' + fmt(over) + ' character' + (over === 1 ? '' : 's') + ' over the limit of ' + fmt(r.max) + forWho(r) + '. Your words are kept. ' +
      (r.cut ? 'Anything past ' + fmt(r.max) + ' will be cut off.' : 'It will be refused until it is shorter.');
  }
  /* The over-limit notes waiting to be said, taken now. The page's say() adds them to its own sentence. */
  function notes() {
    var out = Object.keys(pending).map(function (id) { return recs[id]; }).filter(function (r) {
      return r && r.max && size(r) > r.max && !hiddenNow(r.box);
    }).map(overNote);
    pending = {};
    return out.join(' ');
  }
  /* Nothing else was said in the same moment: the notes go out on their own. */
  function flush() { timer = null; var t = notes(); if (t) say(t); }
  function queue(r) { pending[r.box.id] = true; if (!timer) timer = setTimeout(flush, 0); }
  function show(r) {
    var c = countBox(r.box, true);
    c.textContent = line(r);
    c.hidden = !!r.box.hidden;
    /* A hidden box over its limit is said when it is shown again (the next set or refresh), not lost. */
    var over = !!r.max && size(r) > r.max, seen = !hiddenNow(r.box);
    if (over && !r.over && seen) queue(r);
    r.over = over && (r.over || seen);
  }
  function hard(r) { return r.measure ? 0 : r.max; }
  function wire(box) {
    if (box.dataset.capWired) return;
    box.dataset.capWired = '1';
    box.addEventListener('paste', function (e) {
      var r = recs[box.id];
      if (!r || r.box !== box || !hard(r)) return;
      var t = e.clipboardData && e.clipboardData.getData ? String(e.clipboardData.getData('text') || '') : '';
      t = t.replace(/\r\n?/g, '\n');
      if (box.tagName !== 'TEXTAREA') t = t.replace(/\n/g, '');
      var picked = Math.abs((box.selectionEnd || 0) - (box.selectionStart || 0));
      var p = paste = { box: box, event: e, before: box.value, cut: !!t && box.value.length - picked + t.length > r.max };
      /* A paste with no room at all changes nothing, so no input event comes: it is said here. */
      setTimeout(function () {
        if (paste === p) paste = null;
        var now = recs[box.id];
        if (p.done || !p.cut || p.event.defaultPrevented || box.value !== p.before || !now || !hard(now)) return;
        say('Nothing was pasted. The box is at the limit: ' + fmt(now.max) + ' characters' + forWho(now) + '.');
      }, 0);
    });
    box.addEventListener('input', function () {
      var r = recs[box.id];
      if (!r || r.box !== box) return;
      var was = r.len, n = box.value.length, p = paste && paste.box === box ? paste : null;
      if (p) p.done = true;
      paste = null; r.len = n;
      show(r);
      if (!r.max) return;
      var out = [];
      if (hard(r)) {
        /* At the limit is said once, and again only after the box drops well under it: fixing a typo in a full box says nothing. */
        if (n < r.max - 20) r.atSaid = false;
        if (p && p.cut) { r.atSaid = true; out.push('Cut to fit the limit: ' + fmt(r.max) + ' characters' + forWho(r) + '.'); }
        else if (n >= r.max && was < r.max && !r.atSaid) { r.atSaid = true; out.push('That is the limit: ' + fmt(r.max) + ' characters' + forWho(r) + '.'); }
      }
      if (r.reads) {
        if (size(r) <= r.reads) r.readsSaid = false;
        else if (!r.readsSaid) { r.readsSaid = true; out.push((r.who || 'This engine') + ' reads only about the first ' + fmt(r.reads) + ' characters of this. The rest is left out.'); }
      }
      if (out.length) say(out.join(' '));
    });
    box.addEventListener('blur', function () { var r = recs[box.id]; if (r && r.box === box) r.atSaid = false; });
  }
  /* Sets one box's cap. Called again whenever a picker may have changed it; a box drawn afresh keeps
   * what was known about the one it replaced (same id), so redrawing says nothing new. */
  function set(box, cap) {
    if (!box || !box.id) return;
    var old = recs[box.id];
    if (!cap) {
      box.removeAttribute('maxlength'); countBox(box, false); delete recs[box.id]; return;
    }
    var max = cap.max > 0 ? Math.floor(cap.max) : 0;
    var same = !!(old && old.max === max);
    var r = recs[box.id] = { box: box, max: max, who: cap.who == null ? 'this engine' : cap.who, label: cap.label || 'This box', cut: !!cap.cut, len: box.value.length,
      measure: typeof cap.measure === 'function' ? cap.measure : null, measureNote: cap.measureNote || '', reads: cap.reads > 0 ? Math.floor(cap.reads) : 0,
      over: same && !!old.over, atSaid: same && !!old.atSaid, readsSaid: !!(old && old.readsSaid) };
    if (hard(r)) box.maxLength = max; else box.removeAttribute('maxlength');
    wire(box);
    show(r);
  }
  /* Recounts every box, after the page fills one in by itself (a draft, an undo, a restored tab). */
  function refresh() {
    Object.keys(recs).forEach(function (id) {
      var r = recs[id];
      if (!r.box.isConnected) { var now = document.getElementById(id); if (!now) return; r.box = now; wire(now); if (hard(r)) now.maxLength = r.max; }
      r.len = r.box.value.length; show(r);
    });
  }
  /* For the page's say(): recount, then hand back what is newly over, to be said in the same sentence. */
  function sayNotes() { refresh(); return notes(); }
  return { set: set, refresh: refresh, notes: sayNotes, line: function (id) { return recs[id] ? line(recs[id]) : ''; } };
}

const CAPS_SOURCE = String(boothCaps) + '\n';

module.exports = { boothCaps, CAPS_SOURCE };
