/**
 * KADE July 18 2026 — VOICE MEMO TRANSCRIBER (Kade's ask: "a friend sends long
 * voice memos and I want to upload and get back a formatted transcript").
 *
 *   POST /api/kade/transcribe   (JWT) raw audio body -> { transcript, seconds, model }
 *   GET  /transcribe            (page) accessible upload page: pick a file,
 *                               hear progress, read/copy/download the result.
 *
 * Engine: Deepgram pre-recorded API (the same account the phone line's live
 * captions use — 45,000 free minutes/month, so this costs $0 in practice).
 * smart_format + paragraphs gives clean punctuated prose; diarization labels
 * speakers only when more than one voice is actually detected.
 *
 * Env: DEEPGRAM_API_KEY (required), KADE_DG_MODEL (default nova-3; set nova-2
 * if the account ever loses nova-3 access). Uploads capped at 150MB — a phone
 * voice memo runs ~1MB/min, so that's a comfortable 2+ hours.
 */
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { getUserDictionary } = require('~/models/kadePronunciation');

const router = express.Router();

const MAX_UPLOAD = '150mb';
const DG_URL = 'https://api.deepgram.com/v1/listen';

// Kade July 20 2026: same keyterm mechanism voice-stream.js uses for phone/
// web calls (Deepgram nova-3 + Flux, GA feature) -- biases recognition
// toward each name/word's correct SPELLING. `keyterms` is a plain array of
// strings; repeated `&keyterm=` params, never comma-joined (Deepgram's own
// syntax, not this codebase's convention).
function dgParams(keyterms) {
  const model = process.env.KADE_DG_MODEL || 'nova-3';
  let qs = `model=${encodeURIComponent(model)}&smart_format=true&punctuate=true&paragraphs=true&diarize=true`;
  for (const term of keyterms || []) {
    const t = String(term || '').trim();
    if (t) {
      qs += `&keyterm=${encodeURIComponent(t)}`;
    }
  }
  return qs;
}

/** Best-effort: a failed dictionary lookup should never break transcription. */
async function safeGetDictionaryTerms(userId) {
  if (!userId) {
    return [];
  }
  try {
    const entries = await getUserDictionary(userId);
    return entries.map((e) => e.term).filter(Boolean);
  } catch {
    return [];
  }
}

/** Turn a Deepgram response into readable text. Speaker labels only when the
 * audio really has multiple speakers — a solo voice memo reads as clean prose. */
function formatTranscript(dg) {
  try {
    const alt = dg.results.channels[0].alternatives[0];
    const para = alt.paragraphs;
    if (para && Array.isArray(para.paragraphs) && para.paragraphs.length) {
      const speakers = new Set(para.paragraphs.map((p) => p.speaker).filter((s) => s !== undefined));
      if (speakers.size > 1 && typeof para.transcript === 'string' && para.transcript.trim()) {
        return para.transcript.trim(); // Deepgram's own "Speaker 0: ..." layout
      }
      return para.paragraphs
        .map((p) => (p.sentences || []).map((s) => s.text).join(' '))
        .filter(Boolean)
        .join('\n\n');
    }
    return String(alt.transcript || '').trim();
  } catch {
    return '';
  }
}

/** Shared with the kade_transcribe agent tool. */
async function transcribeBuffer(buf, contentType, keyterms) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    throw new Error('Transcription is not configured on the server (no Deepgram key).');
  }
  if (!buf || !buf.length) {
    throw new Error('No audio received.');
  }
  const resp = await fetch(`${DG_URL}?${dgParams(keyterms)}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${key}`,
      'Content-Type': contentType && contentType.startsWith('audio') ? contentType : 'application/octet-stream',
    },
    body: buf,
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Deepgram ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const dg = await resp.json();
  const transcript = formatTranscript(dg);
  const seconds = Math.round((dg.metadata && dg.metadata.duration) || 0);
  if (!transcript) {
    throw new Error('No speech was found in that audio.');
  }
  return { transcript, seconds, model: process.env.KADE_DG_MODEL || 'nova-3' };
}

router.post(
  '/',
  requireJwtAuth,
  express.raw({ type: () => true, limit: MAX_UPLOAD }),
  async (req, res) => {
    try {
      const keyterms = await safeGetDictionaryTerms(req.user && req.user.id);
      const out = await transcribeBuffer(req.body, req.get('content-type') || '', keyterms);
      logger.info(`[kadeTranscribe] ${req.user?.email || req.user?.id}: ${out.seconds}s transcribed`);
      // KADE July 24 2026 — Clubhouse bot guests listen through this lane in
      // 15s cycles. Meter those minutes honestly (kadeusage 'clubhouse_ears',
      // Deepgram nova-3 ~$0.0043/min) so the real cost of a seated guest is
      // visible on the usage dashboard. Fail-soft: never breaks a transcript.
      if (req.get('x-kade-club') === '1') {
        try {
          const { logKadeUsage } = require('~/models/kadeUsage');
          logKadeUsage({
            userId: String(req.user.id),
            service: 'clubhouse_ears',
            quantity: out.seconds,
            unit: 'seconds',
            costUSD: (out.seconds * 0.0043) / 60,
            metadata: { kind: 'room_ears' },
          });
        } catch (_) {}
      }
      return res.json(out);
    } catch (e) {
      logger.warn('[kadeTranscribe] failed: ' + (e && e.message));
      return res.status(400).json({ error: e.message || 'Transcription failed.' });
    }
  },
);

// ---- Organize / clean the transcript with an LLM (notes or prose) ----------
// July 18 2026: the "organize your thoughts" mode. Runs the current transcript
// through OpenRouter (KADE_ORGANIZE_MODEL, default openai/gpt-4o-mini) and
// returns either structured notes or cleaned-up prose. Reads OPENROUTER_KEY.
async function organizeText(text, style) {
  const key = process.env.OPENROUTER_KEY;
  if (!key) {
    throw new Error("The note organizer is not configured on the server (no OpenRouter key).");
  }
  const clean = String(text || "").trim();
  if (!clean) {
    throw new Error("There is no transcript to organize yet.");
  }
  const model = process.env.KADE_ORGANIZE_MODEL || "openai/gpt-4o-mini";
  const NOTES = "You reorganize a person's dictated speech into tidy, well-structured notes. Output ONLY the notes and nothing else. Begin with a short title line in bold, then group the content into clear bullet points, adding brief bold sub-headers only if the material naturally splits into sections. Fix grammar, remove filler words and false starts, and tighten rambling. Never add facts, opinions, or details the speaker did not say, and keep their meaning intact.";
  const PROSE = "You clean up a person's dictated speech into smooth, readable prose. Keep everything they said and their full meaning: do not summarize, do not drop content, and do not convert it into bullet points. Only fix grammar and punctuation, remove filler words and false starts, improve the flow, and break it into sensible paragraphs. Output ONLY the cleaned text and nothing else.";
  const sys = style === "prose" ? PROSE : NOTES;
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: clean },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error("Organizer " + resp.status + ": " + t.slice(0, 200));
  }
  const j = await resp.json();
  const out = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  const result = String(out || "").trim();
  if (!result) {
    throw new Error("The organizer returned nothing. Please try again.");
  }
  return result;
}

router.post("/organize", requireJwtAuth, express.json({ limit: "1mb" }), async (req, res) => {
  try {
    const style = req.body && req.body.style === "prose" ? "prose" : "notes";
    const out = await organizeText(req.body && req.body.text, style);
    logger.info(`[kadeTranscribe] organize (${style}) for ${req.user?.email || req.user?.id}`);
    return res.json({ text: out, style });
  } catch (e) {
    logger.warn("[kadeTranscribe] organize failed: " + (e && e.message));
    return res.status(400).json({ error: e.message || "Could not organize the text." });
  }
});

router.organizeText = organizeText;


const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transcribe a voice memo — Kade-AI</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#0f1117; color:#e8eaf0; line-height:1.5; }
  main { max-width:680px; margin:0 auto; padding:24px 16px 64px; }
  h1 { font-size:1.5rem; }
  .card { background:#1a1e28; border-radius:16px; padding:20px; margin-top:16px; }
  label.file { display:block; border:2px dashed #3b4254; border-radius:12px; padding:28px 16px; text-align:center; cursor:pointer; }
  label.file:focus-within { outline:3px solid #7aa2ff; }
  input[type=file] { position:absolute; width:1px; height:1px; opacity:0; }
  button, a.btn { font-size:1rem; border:0; border-radius:10px; padding:12px 20px; cursor:pointer; background:#4466dd; color:#fff; text-decoration:none; display:inline-block; }
  button[disabled] { opacity:.5; cursor:default; }
  .row { display:flex; gap:12px; flex-wrap:wrap; margin-top:12px; }
  #status { margin-top:16px; min-height:1.5em; font-weight:600; }
  textarea { width:100%; min-height:320px; margin-top:12px; background:#12151d; color:#e8eaf0; border:1px solid #3b4254; border-radius:10px; padding:12px; font-size:1rem; line-height:1.6; box-sizing:border-box; }
  .hint { color:#9aa3b5; font-size:.92rem; }
  a.back { display:inline-block; margin:0 0 10px; font-weight:600; text-decoration:none; color:#7aa2ff; font-size:1rem; }
  a.back:focus-visible { outline:3px solid #ffbf47; outline-offset:2px; }
  .orbar { text-align:center; color:#9aa3b5; margin:18px 0 4px; font-size:.85rem; text-transform:uppercase; letter-spacing:.08em; }
  #rec { width:100%; margin-top:6px; background:#c0392b; font-size:1.15rem; padding:16px; font-weight:700; }
  #rec.on { background:#e74c3c; }
  /* KADE session 22: press-down feedback on anything tappable. Motion only
     under prefers-reduced-motion: no-preference; static pages otherwise. */
  @media (prefers-reduced-motion: no-preference) {
    button, a.btn, [role="button"], input[type="submit"] {
      transition: transform .15s ease;
    }
    button:active, a.btn:active, [role="button"]:active, input[type="submit"]:active {
      transform: scale(.985);
    }
  }
</style>
<script defer src="/kade-tabbar.js"></script></head>
<body>
<main>
  <a class="back" href="/">&larr; Back to Kade-AI</a>
  <h1>Transcribe a voice memo</h1>
  <p class="hint">Upload an audio file (voice memo, mp3, m4a, wav — up to about two hours), or record yourself live. You get back clean, punctuated text you can copy or download. Free to use.</p>
  <div class="card">
    <label class="file" id="drop">
      <span id="fileLabel">Choose an audio file</span>
      <input type="file" id="file" accept="audio/*,video/mp4,.m4a,.mp3,.wav,.ogg,.opus,.aac,.amr,.flac" aria-describedby="status">
    </label>
    <div class="row">
      <button id="go" disabled>Transcribe file</button>
    </div>

    <div class="orbar">or record live</div>
    <button id="rec" aria-pressed="false">Record now</button>
    <p class="hint">Tap Record, talk, tap again. Your words are added to the transcript below — great for quick dictation. The space bar starts and stops it too.</p>

    <div class="row">
      <button id="notesBtn" hidden>Organize into notes</button>
      <button id="proseBtn" hidden>Clean up text</button>
      <button id="undoBtn" hidden>Undo</button>
    </div>
    <div class="row">
      <button id="copy" hidden>Copy transcript</button>
      <a class="btn" id="dl" hidden download="transcript.txt">Download as text file</a>
    </div>
    <p id="status" role="status" aria-live="polite"></p>
    <textarea id="out" hidden aria-label="Transcript. Editable — fix any word before copying."></textarea>
  </div>
</main>
<script>
(function () {
  var TOKEN = null, FILE = null;
  var fileEl = document.getElementById('file');
  var goEl = document.getElementById('go');
  var recEl = document.getElementById('rec');
  var statusEl = document.getElementById('status');
  var outEl = document.getElementById('out');
  var copyEl = document.getElementById('copy');
  var dlEl = document.getElementById('dl');
  var notesBtn = document.getElementById('notesBtn');
  var proseBtn = document.getElementById('proseBtn');
  var undoBtn = document.getElementById('undoBtn');
  var lastText = null;
  var NL = String.fromCharCode(10);
  function setStatus(m) { statusEl.textContent = m; }
  function getToken() {
    return fetch('/api/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('Please sign in at kademurdock.com first, then come back.')); })
      .then(function (j) { TOKEN = j && j.token; if (!TOKEN) throw new Error('Please sign in at kademurdock.com first, then come back.'); });
  }
  function showResult(j, append) {
    if (append && outEl.value.trim()) { outEl.value = outEl.value + NL + NL + j.transcript; }
    else { outEl.value = j.transcript; }
    outEl.hidden = false; copyEl.hidden = false;
    try { dlEl.href = URL.createObjectURL(new Blob([outEl.value], { type: 'text/plain' })); dlEl.hidden = false; } catch (e) {}
    revealOrganize(); undoBtn.hidden = true;
  }
  function transcribe(body, contentType, append) {
    return getToken()
      .then(function () {
        return fetch('/api/kade/transcribe', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': contentType || 'application/octet-stream' },
          body: body,
        });
      })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
      .then(function (j) { showResult(j, append); return j; });
  }
  fileEl.addEventListener('change', function () {
    FILE = fileEl.files && fileEl.files[0];
    document.getElementById('fileLabel').textContent = FILE ? FILE.name : 'Choose an audio file';
    goEl.disabled = !FILE;
    if (FILE) setStatus('Ready — ' + FILE.name + ', ' + Math.round(FILE.size / 1048576) + ' megabytes. Press Transcribe file.');
  });
  goEl.addEventListener('click', function () {
    if (!FILE) return;
    goEl.disabled = true;
    setStatus('Uploading and transcribing — longer memos take a minute or two. Hang tight.');
    transcribe(FILE, FILE.type || 'application/octet-stream', false)
      .then(function (j) {
        var mins = Math.round(j.seconds / 60);
        setStatus('Done — about ' + (mins || 1) + ' minute' + (mins === 1 ? '' : 's') + ' of audio transcribed. The transcript is below.');
        outEl.focus();
      })
      .catch(function (e) { setStatus('Sorry — ' + e.message); })
      .then(function () { goEl.disabled = !FILE; });
  });
  copyEl.addEventListener('click', function () {
    navigator.clipboard.writeText(outEl.value).then(
      function () { setStatus('Copied to the clipboard.'); },
      function () { outEl.select(); document.execCommand('copy'); setStatus('Copied.'); }
    );
  });

  var mediaRec = null, chunks = [], stream = null, recording = false, busy = false, ac = null, maxTimer = null;
  function beep(kind) {
    try {
      if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
      var o = ac.createOscillator(), g = ac.createGain();
      o.connect(g); g.connect(ac.destination);
      o.frequency.value = kind === 'start' ? 660 : 440;
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.18);
      o.start(); o.stop(ac.currentTime + 0.2);
    } catch (e) {}
  }
  function pickMime() {
    var opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
    for (var i = 0; i < opts.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(opts[i])) return opts[i];
    }
    return '';
  }
  function startRec() {
    if (recording || busy) return;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then(function (s) {
        stream = s; chunks = [];
        var mime = pickMime();
        try { mediaRec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
        catch (e) { mediaRec = new MediaRecorder(stream); }
        mediaRec.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
        mediaRec.onstop = onRecStop;
        mediaRec.start();
        recording = true;
        recEl.classList.add('on'); recEl.setAttribute('aria-pressed', 'true'); recEl.textContent = 'Stop and transcribe';
        beep('start'); setStatus('Listening. Talk now.');
        clearTimeout(maxTimer); maxTimer = setTimeout(function () { if (recording) stopRec(); }, 120000);
      })
      .catch(function () { setStatus('Microphone blocked. Allow mic access for this site, then try again.'); });
  }
  function stopRec() {
    if (!recording) return;
    recording = false; clearTimeout(maxTimer);
    recEl.classList.remove('on'); recEl.setAttribute('aria-pressed', 'false'); recEl.textContent = 'Record now';
    beep('stop');
    try { mediaRec.stop(); } catch (e) {}
  }
  function onRecStop() {
    try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    if (!chunks.length) { setStatus('Did not catch any audio. Try again.'); return; }
    var type = (mediaRec && mediaRec.mimeType) || (chunks[0] && chunks[0].type) || 'audio/webm';
    var ct = type.split(';')[0] || 'audio/webm';
    var blob = new Blob(chunks, { type: type });
    busy = true; setStatus('Processing your recording...');
    transcribe(blob, ct, true)
      .then(function () { busy = false; setStatus('Added to the transcript below.'); outEl.focus(); })
      .catch(function (e) { busy = false; setStatus('Sorry — ' + e.message); });
  }
  recEl.addEventListener('click', function () { recording ? stopRec() : startRec(); });
  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space') {
      var tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'BUTTON') return;
      e.preventDefault(); recording ? stopRec() : startRec();
    }
  });
  function revealOrganize() {
    var has = !!outEl.value.trim();
    notesBtn.hidden = !has;
    proseBtn.hidden = !has;
  }
  function organize(style, label) {
    if (busy) return;
    if (!outEl.value.trim()) { setStatus('Nothing to organize yet.'); return; }
    busy = true; lastText = outEl.value;
    notesBtn.disabled = true; proseBtn.disabled = true;
    setStatus(label + ' - one moment.');
    getToken()
      .then(function () {
        return fetch('/api/kade/transcribe/organize', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: outEl.value, style: style }),
        });
      })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
      .then(function (j) {
        outEl.value = j.text;
        try { dlEl.href = URL.createObjectURL(new Blob([outEl.value], { type: 'text/plain' })); } catch (e) {}
        undoBtn.hidden = false;
        setStatus('Done. Your ' + label + ' is below. Press Undo to get your original words back.');
        outEl.focus();
      })
      .catch(function (e) { setStatus('Sorry - ' + e.message); })
      .then(function () { busy = false; notesBtn.disabled = false; proseBtn.disabled = false; });
  }
  notesBtn.addEventListener('click', function () { organize('notes', 'notes'); });
  proseBtn.addEventListener('click', function () { organize('prose', 'cleaned-up text'); });
  undoBtn.addEventListener('click', function () {
    if (lastText != null) {
      outEl.value = lastText;
      try { dlEl.href = URL.createObjectURL(new Blob([outEl.value], { type: 'text/plain' })); } catch (e) {}
      setStatus('Restored your original transcript.');
      outEl.focus();
    }
    undoBtn.hidden = true;
  });

  if (!navigator.mediaDevices || !window.MediaRecorder) {
    recEl.disabled = true;
    recEl.textContent = 'Recording not supported in this browser';
  }
})();
</script>
</body>
</html>`;

router.page = (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8').send(PAGE_HTML);
};

router.transcribeBuffer = transcribeBuffer;
module.exports = router;
