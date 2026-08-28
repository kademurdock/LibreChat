/* KADE — CHATGPT IMPORT routes + page (Aug 28 2026). See
 * services/kadeGptImport.js for what the lanes actually do and the rails.
 *
 * API (JWT):
 *   POST /api/kade/gpt-import/zip       raw application/zip body (≤80 MB)
 *   POST /api/kade/gpt-import/memories  { text } → keeper distill into cards
 *   POST /api/kade/gpt-import/mine      start reading stored conversations
 *   GET  /api/kade/gpt-import/status    counts + run state (own rows only)
 * Page (no server auth; client fetches the refresh token, house pattern):
 *   GET /import
 */
const express = require('express');
const { requireJwtAuth } = require('~/server/middleware');
const {
  storeZip,
  importMemoriesText,
  startImportMining,
  importStatus,
  importCounts,
} = require('~/server/services/kadeGptImport');
const { SHARED_HEAD } = require('./kadePages');

const router = express.Router();

router.post(
  '/zip',
  requireJwtAuth,
  express.raw({ type: ['application/zip', 'application/octet-stream', 'application/x-zip-compressed'], limit: '82mb' }),
  async (req, res) => {
    try {
      const result = await storeZip({ userId: req.user.id, zipBuffer: req.body });
      res.status(result.ok ? 200 : 400).json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  },
);

router.post('/memories', requireJwtAuth, express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const result = await importMemoriesText({ userId: req.user.id, text: (req.body || {}).text });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/mine', requireJwtAuth, async (req, res) => {
  try {
    const result = await startImportMining({ userId: req.user.id });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/status', requireJwtAuth, async (req, res) => {
  try {
    const counts = await importCounts(req.user.id);
    const run = importStatus();
    /* Only surface the live run to the person it belongs to. */
    const mine = run.userId === String(req.user.id) ? run : { running: false };
    res.json({ ok: true, counts, run: { running: mine.running, processed: mine.processed || 0, total: mine.total || 0, entriesLogged: mine.entriesLogged || 0 } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ── The page ──────────────────────────────────────────────────────────── */
const IMPORT_HTML = `<!doctype html>
<html lang="en">
<head>
<title>Bring your ChatGPT memories — Kade-AI</title>
${SHARED_HEAD}
</head>
<body>
<main>
  <h1>Bring your ChatGPT memories</h1>
  <p class="muted">Moving in? Your companions here can start out already knowing you. Two ways, use either or both.</p>

  <div class="card">
    <h2>1. Paste your saved memories</h2>
    <p>In ChatGPT, open <strong>Settings, then Personalization, then Manage memories</strong> — or just ask ChatGPT: <em>"List everything you remember about me."</em> Copy it all, paste it here.</p>
    <label for="memtext">Your ChatGPT memory list</label>
    <textarea id="memtext" rows="8" style="width:100%;font-size:1rem;padding:.6rem;border-radius:10px;border:1px solid #c9ced6;background:inherit;color:inherit" placeholder="Paste the whole list here."></textarea>
    <button id="membtn" class="btn" style="border:0;cursor:pointer;font-size:1rem">Save these as my memories</button>
    <p id="memstatus" role="status" aria-live="polite" class="muted"></p>
  </div>

  <div class="card">
    <h2>2. Upload your ChatGPT export</h2>
    <p>In ChatGPT: <strong>Settings, then Data controls, then Export data</strong>. ChatGPT emails you a zip file — download it, then pick it here. Your old conversations come along inside it.</p>
    <label for="zipfile">Your export zip file</label>
    <input id="zipfile" type="file" accept=".zip,application/zip" style="display:block;margin:.5rem 0;font-size:1rem">
    <label style="display:block;margin:.8rem 0 .4rem">
      <input id="minecheck" type="checkbox" style="width:1.2rem;height:1.2rem;vertical-align:middle">
      Also read my old conversations into my logbook, so my companions remember my life from back then. (Takes a while, runs in the background.)
    </label>
    <button id="zipbtn" class="btn" style="border:0;cursor:pointer;font-size:1rem">Upload and import</button>
    <p id="zipstatus" role="status" aria-live="polite" class="muted"></p>
  </div>

  <div class="card">
    <h2>What happens to it</h2>
    <p>Your memories become the same kind of memory cards your companions already keep — yours to hear, edit, or delete any time on the Memories screen. Old conversations are read once by the platform's own memory keeper (no person reads them), remembered as dated journal entries, and the upload itself is never shown to anyone.</p>
  </div>
</main>
<script>
  async function getToken(){
    try{
      const r = await fetch('/api/auth/refresh', {method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body:'{}'});
      if(!r.ok) return null;
      const j = await r.json();
      return j && j.token ? j.token : null;
    }catch(e){ return null; }
  }
  function say(el, msg){ document.getElementById(el).textContent = msg; }
  let polling = null;
  async function poll(token){
    try{
      const r = await fetch('/api/kade/gpt-import/status', {headers:{'Authorization':'Bearer '+token}});
      const j = await r.json();
      if(j.run && j.run.running){
        say('zipstatus', 'Reading your conversations: ' + j.run.processed + ' of ' + j.run.total + ' read, ' + j.run.entriesLogged + ' journal entries written so far. You can close this page — it keeps going.');
      } else if (polling) {
        clearInterval(polling); polling = null;
        say('zipstatus', 'All done reading. ' + (j.counts ? j.counts.done + ' conversations remembered.' : ''));
      }
    }catch(e){}
  }
  document.getElementById('membtn').addEventListener('click', async () => {
    const text = document.getElementById('memtext').value.trim();
    if(!text){ say('memstatus','Paste your memory list first.'); return; }
    say('memstatus','Saving…');
    const token = await getToken();
    if(!token){ say('memstatus','You need to be signed in — open the main app, sign in, then come back.'); return; }
    try{
      const r = await fetch('/api/kade/gpt-import/memories', {method:'POST', headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'}, body: JSON.stringify({text})});
      const j = await r.json();
      say('memstatus', j.ok ? 'Saved. Your companions know you now — check the Memories screen to hear the cards.' : (j.error || 'That did not work. Try again.'));
    }catch(e){ say('memstatus','That did not work. Try again.'); }
  });
  document.getElementById('zipbtn').addEventListener('click', async () => {
    const f = document.getElementById('zipfile').files[0];
    if(!f){ say('zipstatus','Pick your export zip first.'); return; }
    say('zipstatus','Uploading ' + f.name + '…');
    const token = await getToken();
    if(!token){ say('zipstatus','You need to be signed in — open the main app, sign in, then come back.'); return; }
    try{
      const r = await fetch('/api/kade/gpt-import/zip', {method:'POST', headers:{'Authorization':'Bearer '+token,'Content-Type':'application/zip'}, body: f});
      const j = await r.json();
      if(!j.ok){ say('zipstatus', j.error || 'That did not work. Try again.'); return; }
      let msg = j.conversationsStored + ' conversations stored' + (j.alreadyHad ? ' (' + j.alreadyHad + ' were already here)' : '') + '.';
      if(j.foundMemoryFile){
        say('zipstatus', msg + ' Found a memory file inside — saving those too…');
        try{
          await fetch('/api/kade/gpt-import/memories', {method:'POST', headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'}, body: JSON.stringify({text: j.memoryText})});
          msg += ' Memory file saved as cards.';
        }catch(e){}
      }
      if(document.getElementById('minecheck').checked && (j.conversationsStored || j.alreadyHad)){
        const m = await fetch('/api/kade/gpt-import/mine', {method:'POST', headers:{'Authorization':'Bearer '+token}});
        const mj = await m.json();
        if(mj.ok){
          say('zipstatus', msg + ' Now reading them into your logbook…');
          if(!polling){ polling = setInterval(() => poll(token), 5000); }
        } else {
          say('zipstatus', msg + ' ' + (mj.error || 'Could not start the logbook read.'));
        }
      } else {
        say('zipstatus', msg + (j.hadConversationsFile ? ' (Logbook read not requested — tick the box and press again any time.)' : ' No conversations.json found in that zip.'));
      }
    }catch(e){ say('zipstatus','Upload failed. Try again.'); }
  });
</script>
</body>
</html>`;

router.importPage = (req, res) => res.type('html').send(IMPORT_HTML);

module.exports = router;
