/* ----------------------------------------------------------------------------
 * THE SOUND BOOTH, ON THE WEB (Part 120, Sep 3 2026)
 *
 * The same screen as the phone's, against the same two routes. Her call when
 * asked phone-first or both: both tonight.
 *
 * Self-contained HTML, no server-side interpolation, no auth at the page level:
 * the client gets a token from /api/auth/refresh the way every other Kade page
 * does, then calls /api/kade/sound-booth/*.
 *
 * SCREEN-READER SHAPE (her rule, and the reason for most of what follows):
 *   - every control is a real labelled form control, never a styled div
 *   - the estimate and the render state live in ONE aria-live region, so a
 *     change is announced once rather than fought over by three polite regions
 *   - the cost is SPOKEN before the render, and the Render button is a
 *     two-step confirm -- her standing rule is the price is said, not shown
 *   - nothing auto-plays; a finished clip is announced, and she presses play
 * -------------------------------------------------------------------------- */
const { SHARED_HEAD } = require('./kadePages');

const soundBoothHtml = `<!doctype html><html lang="en"><head><title>Sound Booth — Kade-AI</title>${SHARED_HEAD}
<style>
  fieldset { border:1px solid #d9dde3; border-radius:12px; padding:.9rem 1rem 1.1rem; margin:1rem 0; }
  legend { font-weight:700; padding:0 .4rem; }
  label.field { display:block; font-weight:600; margin:.8rem 0 .25rem; }
  .hint { font-size:.9rem; opacity:.8; margin:.15rem 0 .35rem; }
  textarea, input[type=text], input[type=number], select {
    width:100%; font:inherit; padding:.6rem .7rem; border-radius:10px;
    border:1px solid #b9bfc9; background:#fff; color:inherit;
  }
  textarea { min-height:9rem; line-height:1.45; }
  button.act {
    font:inherit; font-weight:700; padding:.7rem 1.1rem; border-radius:10px;
    border:1px solid #1d55d0; background:#fff; color:#1d55d0; cursor:pointer;
    margin:.5rem .5rem .2rem 0;
  }
  button.act.primary { background:#1f7a49; border-color:#1f7a49; color:#fff; }
  button.act[disabled] { opacity:.55; cursor:default; }
  button.act:focus-visible, textarea:focus-visible, select:focus-visible, input:focus-visible { outline:3px solid #ffbf47; outline-offset:2px; }
  .seg { display:flex; gap:.5rem; flex-wrap:wrap; margin:.3rem 0 .2rem; }
  .seg button { font:inherit; font-weight:600; padding:.55rem 1rem; border-radius:999px; border:1px solid #b9bfc9; background:#fff; color:inherit; cursor:pointer; }
  .seg button[aria-pressed="true"] { background:#1d55d0; border-color:#1d55d0; color:#fff; }
  .row { display:flex; gap:1rem; flex-wrap:wrap; }
  .row > div { flex:1 1 12rem; }
  .proj { border:1px solid #e3e6ea; border-radius:12px; padding:.8rem .9rem; margin:.7rem 0; background:#fff; }
  .proj h3 { margin:0 0 .2rem; font-size:1.05rem; }
  .proj audio { width:100%; max-width:640px; display:block; margin:.5rem 0 .3rem; }
  pre.script { white-space:pre-wrap; word-wrap:break-word; font-size:.9rem; background:#f1f3f6; padding:.7rem .8rem; border-radius:10px; max-height:16rem; overflow:auto; }
  @media (prefers-color-scheme: dark) {
    textarea, input[type=text], input[type=number], select, .seg button { background:#1e2127; border-color:#3a3f49; }
    button.act { background:#1e2127; }
    button.act.primary { background:#1f7a49; }
    .proj { background:#1e2127; border-color:#2c2f37; }
    pre.script { background:#181b20; }
  }
</style>
</head>
<body>
  <p><a class="back" href="/home" aria-label="Back to home">&larr; Home</a> &nbsp;&middot;&nbsp; <a class="back" href="/my-creations">My Creations &rarr;</a></p>
  <h1>Sound Booth</h1>
  <p class="muted">Write something, or describe what you want, and have it performed. Two engines: <strong>Scenema</strong> renders one actor performing a script on Kade's own graphics card, about two cents a minute, and takes a few minutes. <strong>Seed Audio</strong> builds a whole scene &mdash; several voices, music, sound effects &mdash; in seconds, about nineteen cents a minute.</p>

  <div id="status" class="status" role="status" aria-live="polite">Loading the Sound Booth&hellip;</div>

  <main id="app" hidden>
    <fieldset>
      <legend>Engine</legend>
      <div class="seg" role="group" aria-label="Which engine">
        <button type="button" id="engScenema" aria-pressed="true">Scenema &mdash; one actor performing</button>
        <button type="button" id="engSeed" aria-pressed="false">Seed Audio &mdash; a whole scene</button>
      </div>
      <p class="hint" id="engineHint">Scenema: one voice, any length, stage directions, nothing leaves Kade's own machine. Queued &mdash; it takes about a minute and a half per minute of audio.</p>
    </fieldset>

    <fieldset>
      <legend>Mode</legend>
      <div class="seg" role="group" aria-label="Easy or advanced">
        <button type="button" id="modeEasy" aria-pressed="true">Easy</button>
        <button type="button" id="modeAdv" aria-pressed="false">Advanced</button>
      </div>
      <p class="hint" id="modeHint">Easy: type what you want said, pick a voice and a mood, and let the script desk shape it.</p>
    </fieldset>

    <fieldset>
      <legend>What should it say?</legend>
      <label class="field" for="text">Your words, or a description of what you want written</label>
      <p class="hint" id="textHint">Type the words you want performed. Or describe a piece &mdash; "a two minute bedtime story about a fox who is scared of the dark" &mdash; and press "Write me one".</p>
      <textarea id="text" aria-describedby="textHint"></textarea>

      <div id="easyFields">
        <label class="field" for="voice">Describe the voice</label>
        <p class="hint" id="voiceHint">Age, sex, build, accent, texture, manner &mdash; in one sentence. A reference clip beats a description every time for a specific person; a description misses the age more often than not.</p>
        <input type="text" id="voice" aria-describedby="voiceHint" placeholder="Woman in her sixties, Ozarks, warm and a little gravelly, unhurried.">

        <div class="row">
          <div>
            <label class="field" for="gender">Voice sex</label>
            <select id="gender"><option value="female">Female</option><option value="male">Male</option></select>
          </div>
          <div>
            <label class="field" for="mood">Mood</label>
            <select id="mood"><option value="">No particular mood</option></select>
          </div>
        </div>

        <label class="field" for="ref">Import a clip to clone (link)</label>
        <p class="hint" id="refHint">Paste a link to a ten to twenty second recording of the voice you want. This is the reliable way to get a specific person.</p>
        <input type="text" id="ref" aria-describedby="refHint" placeholder="https://…">
      </div>

      <div id="advFields" hidden>
        <div class="row">
          <div>
            <label class="field" for="scene">Scene</label>
            <input type="text" id="scene" placeholder="a kitchen at dawn, rain outside">
          </div>
          <div>
            <label class="field" for="shot">Shot</label>
            <select id="shot"><option value="">Not set</option><option value="closeup">Close up</option><option value="wide">Wide</option><option value="scene">Scene</option></select>
          </div>
        </div>
        <div class="row">
          <div>
            <label class="field" for="pace">Pace</label>
            <input type="number" id="pace" min="0.5" max="3" step="0.05" placeholder="1.0">
          </div>
          <div>
            <label class="field" for="seed">Seed</label>
            <input type="number" id="seed" min="0" step="1" placeholder="leave empty for a new take">
          </div>
        </div>
        <label class="field"><input type="checkbox" id="sfx"> Include scene sound around the voice</label>
        <label class="field"><input type="checkbox" id="hq"> Studio quality (48 kHz, same price)</label>
      </div>

      <div>
        <button type="button" class="act" id="btnFormat">Turn my words into a script</button>
        <button type="button" class="act" id="btnWrite">Write me one</button>
      </div>
    </fieldset>

    <fieldset>
      <legend>The script</legend>
      <p class="hint" id="scriptHint">This is what gets performed. You can edit it here before rendering.</p>
      <label class="field" for="script">Script</label>
      <textarea id="script" aria-describedby="scriptHint" spellcheck="false"></textarea>
      <p id="readback" class="hint"></p>
      <div>
        <button type="button" class="act primary" id="btnRender">Render</button>
        <button type="button" class="act" id="btnCancel" hidden>Stop this render</button>
      </div>
      <p class="hint" id="renderHint">The cost is said out loud before anything runs, and Render asks once more before it spends.</p>
    </fieldset>

    <h2>Library</h2>
    <div id="library" aria-live="off"><p class="muted">Nothing here yet.</p></div>
  </main>

  <footer class="muted">Finished audio also lands in <a href="/my-creations">My Creations</a>, where it can be downloaded and shared. &mdash; &copy; 2026 Kade Murdock &middot; Kade-AI</footer>

  <script>
  (async function(){
    var status = document.getElementById('status');
    var app = document.getElementById('app');
    var token = null; try { token = await getToken(); } catch(e) {}
    if(!token){ status.className='status err'; status.textContent='Please sign in at the chat site first, then reload this page.'; return; }

    var state = { engine:'scenema', mode:'easy', pendingRender:null, jobId:null, projectId:null, poll:null };
    function say(msg, isErr){ status.className = 'status' + (isErr ? ' err' : ''); status.textContent = msg; }
    function esc(s){ var d=document.createElement('div'); d.textContent = s==null?'':s; return d.innerHTML; }
    async function post(path, body){
      var r = await fetch(path, {method:'POST', headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'}, body: JSON.stringify(body||{})});
      var j = null; try { j = await r.json(); } catch(e) {}
      return { ok: r.ok, status: r.status, data: j || {} };
    }
    async function get(path){
      var r = await fetch(path, {headers:{'Authorization':'Bearer '+token}});
      var j = null; try { j = await r.json(); } catch(e) {}
      return { ok: r.ok, status: r.status, data: j || {} };
    }

    /* health first: it tells us the moods and whether both engines are live */
    var h = await get('/api/kade/sound-booth/health');
    if(!h.ok){ say('Could not open the Sound Booth right now. Try reloading in a moment.', true); return; }
    var moodSel = document.getElementById('mood');
    (h.data.moods||[]).forEach(function(m){
      var o = document.createElement('option'); o.value = m.key; o.textContent = m.label; moodSel.appendChild(o);
    });
    app.hidden = false;
    say('Ready. Scenema ' + (h.data.engines && h.data.engines.scenema.configured ? 'is available' : 'is not set up') +
        '; Seed Audio ' + (h.data.engines && h.data.engines.seed.configured ? 'is available' : 'is not set up') + '.');

    /* ---- segmented controls ---- */
    function setEngine(e){
      state.engine = e;
      document.getElementById('engScenema').setAttribute('aria-pressed', e==='scenema');
      document.getElementById('engSeed').setAttribute('aria-pressed', e==='seed');
      document.getElementById('engineHint').textContent = e==='scenema'
        ? 'Scenema: one voice, any length, stage directions, nothing leaves Kade\\u2019s own machine. Queued \\u2014 it takes about a minute and a half per minute of audio.'
        : 'Seed Audio: a whole scene in one pass \\u2014 up to three voices, music, sound effects, ambience. Comes back in seconds. The audio is made on fal\\u2019s servers, not here.';
      document.getElementById('easyFields').hidden = false;
    }
    function setMode(m){
      state.mode = m;
      document.getElementById('modeEasy').setAttribute('aria-pressed', m==='easy');
      document.getElementById('modeAdv').setAttribute('aria-pressed', m==='advanced');
      document.getElementById('advFields').hidden = (m !== 'advanced');
      document.getElementById('modeHint').textContent = m==='easy'
        ? 'Easy: type what you want said, pick a voice and a mood, and let the script desk shape it.'
        : 'Advanced: every field the engine has, and the raw script to edit yourself.';
    }
    document.getElementById('engScenema').onclick = function(){ setEngine('scenema'); };
    document.getElementById('engSeed').onclick = function(){ setEngine('seed'); };
    document.getElementById('modeEasy').onclick = function(){ setMode('easy'); };
    document.getElementById('modeAdv').onclick = function(){ setMode('advanced'); };

    function collect(){
      var b = { engine: state.engine, mode: state.mode };
      b.text = document.getElementById('text').value;
      var v = document.getElementById('voice').value.trim(); if(v) b.voice_description = v;
      b.gender = document.getElementById('gender').value;
      var mood = document.getElementById('mood').value; if(mood) b.mood = mood;
      if(state.mode === 'advanced'){
        var sc = document.getElementById('scene').value.trim(); if(sc) b.scene = sc;
        var sh = document.getElementById('shot').value; if(sh) b.shot = sh;
        var pc = parseFloat(document.getElementById('pace').value); if(!isNaN(pc)) b.pace = pc;
        var sd = parseInt(document.getElementById('seed').value, 10); if(!isNaN(sd)) b.seed = sd;
        if(document.getElementById('sfx').checked) b.background_sfx = true;
        if(document.getElementById('hq').checked) b.audio_quality = 'high';
      }
      var ref = document.getElementById('ref').value.trim(); if(ref) b.reference_voice_url = ref;
      return b;
    }

    async function makeScript(which){
      var b = collect(); b.mode = which;
      if(!b.text || b.text.trim().length < 3){ say(which==='write' ? 'Say what you want made first.' : 'Type the words you want performed first.', true); document.getElementById('text').focus(); return; }
      document.getElementById('btnFormat').disabled = true; document.getElementById('btnWrite').disabled = true;
      say(which==='write' ? 'Writing it\\u2026' : 'Shaping your words\\u2026');
      var r = await post('/api/kade/sound-booth/script', b);
      document.getElementById('btnFormat').disabled = false; document.getElementById('btnWrite').disabled = false;
      if(!r.ok){ say(r.data.error || 'The script desk had trouble. Try again.', true); return; }
      document.getElementById('script').value = r.data.script || '';
      document.getElementById('readback').textContent = r.data.readback || '';
      state.estimate = r.data.estimate || null;
      var parts = [];
      if(r.data.readback) parts.push(r.data.readback);
      if(r.data.estimate && r.data.estimate.spoken) parts.push(r.data.estimate.spoken);
      if(r.data.problem) parts.push('One thing to fix first: ' + r.data.problem);
      say(parts.join(' ') || 'Script ready.');
      document.getElementById('script').focus();
    }
    document.getElementById('btnFormat').onclick = function(){ makeScript('format'); };
    document.getElementById('btnWrite').onclick = function(){ makeScript('write'); };

    /* ---- render: say the price, then ask once ---- */
    var btnRender = document.getElementById('btnRender');
    btnRender.onclick = async function(){
      var script = document.getElementById('script').value.trim();
      if(!script){ say('There is nothing to render yet. Write a script first.', true); document.getElementById('script').focus(); return; }
      if(!state.pendingRender){
        state.pendingRender = true;
        var est = state.estimate;
        var words = script.replace(/<[^>]+>/g,' ').replace(/\\[[^\\]]*\\]/g,' ').split(/\\s+/).filter(Boolean).length;
        var secs = Math.max(1, Math.round(words/2.6));
        var spoken = est && est.spoken ? est.spoken :
          ('About ' + secs + ' seconds of audio, ' + (state.engine==='seed' ? 'a few seconds to make, about ' + Math.max(1, Math.round(secs/60*18.75)) + ' cents.' : 'a couple of minutes to make, about ' + Math.max(1, Math.round(secs/60*2)+2) + ' cents.'));
        say(spoken + ' Press Render again to go ahead.');
        btnRender.textContent = 'Render \\u2014 confirm';
        return;
      }
      state.pendingRender = false; btnRender.textContent = 'Render'; btnRender.disabled = true;
      var b = collect();
      b.script = script; b.sourceText = document.getElementById('text').value;
      b.readback = document.getElementById('readback').textContent;
      b.mode = state.mode; b.engine = state.engine;
      if(state.projectId) b.projectId = state.projectId;
      say('Sending it\\u2026');
      var r = await post('/api/kade/sound-booth/render', b);
      btnRender.disabled = false;
      if(!r.ok){ say(r.data.error || 'That render could not start.', true); return; }
      state.projectId = r.data.projectId || state.projectId;
      if(r.data.queued){
        state.jobId = r.data.jobId;
        document.getElementById('btnCancel').hidden = false;
        say('Queued. ' + ((r.data.estimate && r.data.estimate.spoken) || '') + ' The page will say when it is ready.');
        startPoll();
      } else {
        say('Ready. ' + r.data.seconds + ' seconds of audio, about ' + Math.max(1, Math.round((r.data.costUSD||0)*100)) + ' cents. It is in your library below and in My Creations.');
        loadLibrary();
      }
    };
    document.getElementById('btnCancel').onclick = async function(){
      if(!state.jobId) return;
      await post('/api/kade/sound-booth/cancel/' + encodeURIComponent(state.jobId), {});
      stopPoll(); say('Stopped.'); document.getElementById('btnCancel').hidden = true; loadLibrary();
    };

    function stopPoll(){ if(state.poll){ clearInterval(state.poll); state.poll = null; } }
    function startPoll(){
      stopPoll(); var last = '';
      state.poll = setInterval(async function(){
        if(!state.jobId) return;
        var r = await get('/api/kade/sound-booth/status/' + encodeURIComponent(state.jobId));
        if(!r.ok) return;
        var s = r.data.state;
        if(s !== last){ last = s; say(r.data.spoken || s); }
        if(s === 'done' || s === 'failed' || s === 'cancelled'){
          stopPoll(); state.jobId = null; document.getElementById('btnCancel').hidden = true; loadLibrary();
        }
      }, 15000);
    }

    /* ---- library ---- */
    async function loadLibrary(){
      var r = await get('/api/kade/sound-booth/projects');
      var box = document.getElementById('library');
      if(!r.ok){ box.innerHTML = '<p class="muted">Could not load your library.</p>'; return; }
      var ps = r.data.projects || [];
      if(!ps.length){ box.innerHTML = '<p class="muted">Nothing here yet.</p>'; return; }
      box.innerHTML = ps.map(function(p){
        var when = '';
        try { when = new Date(p.updatedAt).toLocaleString('en-US', {month:'long', day:'numeric', hour:'numeric', minute:'2-digit'}); } catch(e){}
        var engine = p.engine === 'seed' ? 'Seed Audio' : 'Scenema';
        var stateWord = p.state === 'done' ? 'finished' : p.state;
        return '<div class="proj">' +
          '<h3>' + esc(p.title) + '</h3>' +
          '<p class="hint">' + engine + ' \\u00b7 ' + esc(stateWord) + ' \\u00b7 ' + esc(when) + (p.costUSD ? ' \\u00b7 about ' + Math.max(1, Math.round(p.costUSD*100)) + ' cents' : '') + '</p>' +
          (p.readback ? '<p>' + esc(p.readback) + '</p>' : '') +
          '<details><summary>Script</summary><pre class="script">' + esc(p.script) + '</pre></details>' +
          '<button type="button" class="act" data-open="' + esc(p.id) + '">Open this in the booth</button>' +
          '</div>';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('[data-open]'), function(btn){
        btn.onclick = function(){
          var p = ps.filter(function(x){ return x.id === btn.getAttribute('data-open'); })[0];
          if(!p) return;
          state.projectId = p.id;
          setEngine(p.engine); setMode(p.mode === 'advanced' ? 'advanced' : 'easy');
          document.getElementById('text').value = p.sourceText || '';
          document.getElementById('script').value = p.script || '';
          document.getElementById('readback').textContent = p.readback || '';
          if(p.options && p.options.voice_description) document.getElementById('voice').value = p.options.voice_description;
          say('Opened "' + p.title + '". Edit it and render again, or change the voice first.');
          document.getElementById('script').focus();
        };
      });
      var listen = ps.filter(function(p){ return p.state === 'queued' || p.state === 'running'; })[0];
      if(listen && listen.jobs && listen.jobs.length && !state.jobId){
        state.jobId = listen.jobs[listen.jobs.length-1];
        document.getElementById('btnCancel').hidden = false;
        startPoll();
      }
    }
    loadLibrary();
    setEngine('scenema'); setMode('easy');
  })();
  </script>
</body></html>`;

module.exports = { soundBoothHtml };
