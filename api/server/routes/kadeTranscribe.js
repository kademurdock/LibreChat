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

const router = express.Router();

const MAX_UPLOAD = '150mb';
const DG_URL = 'https://api.deepgram.com/v1/listen';

function dgParams() {
  const model = process.env.KADE_DG_MODEL || 'nova-3';
  return `model=${encodeURIComponent(model)}&smart_format=true&punctuate=true&paragraphs=true&diarize=true`;
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
async function transcribeBuffer(buf, contentType) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    throw new Error('Transcription is not configured on the server (no Deepgram key).');
  }
  if (!buf || !buf.length) {
    throw new Error('No audio received.');
  }
  const resp = await fetch(`${DG_URL}?${dgParams()}`, {
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
      const out = await transcribeBuffer(req.body, req.get('content-type') || '');
      logger.info(`[kadeTranscribe] ${req.user?.email || req.user?.id}: ${out.seconds}s transcribed`);
      return res.json(out);
    } catch (e) {
      logger.warn('[kadeTranscribe] failed: ' + (e && e.message));
      return res.status(400).json({ error: e.message || 'Transcription failed.' });
    }
  },
);

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
</style>
</head>
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
