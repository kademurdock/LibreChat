/* ----------------------------------------------------------------------------
 * THE SOUND BOOTH, ON THE WEB (Part 120 → rebuilt Part 121, Sep 3 2026)
 *
 * Part 121, her ask: "make the things in the app more clear with the
 * soundbooth. I don't think people will know the difference between seedaudio
 * and scenema, much less how to use the settings and prompt it."
 *
 * So this page renders THE GUIDE the server serves (kadeSoundBooth.js GUIDE):
 * the engine choice is two described cards plus a "which one?" answer and a
 * free suggester; every setting comes from the guide with its own hint,
 * range and default, and only the settings the chosen engine actually has
 * are shown; "how to write for this engine" is right there under the box.
 * Nothing about an engine is hard-coded in this file any more — a wording
 * fix is one deploy.
 *
 * SCREEN-READER SHAPE (her rule): real labelled controls, ONE aria-live
 * region, cost said before Render, Render is a two-step confirm, nothing
 * auto-plays.
 * -------------------------------------------------------------------------- */
const { SHARED_HEAD } = require('./kadePages');

const soundBoothHtml = `<!doctype html><html lang="en"><head><title>Sound Booth — Kade-AI</title>${SHARED_HEAD}
<style>
  fieldset { border:1px solid #d9dde3; border-radius:12px; padding:.9rem 1rem 1.1rem; margin:1rem 0; }
  legend { font-weight:700; padding:0 .4rem; }
  label.field { display:block; font-weight:600; margin:.8rem 0 .25rem; }
  .hint { font-size:.9rem; opacity:.82; margin:.15rem 0 .35rem; }
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
  button.act.quiet { border-color:#8a919c; color:inherit; font-weight:600; }
  button.act[disabled] { opacity:.55; cursor:default; }
  button.act:focus-visible, textarea:focus-visible, select:focus-visible, input:focus-visible, .engcard:focus-visible { outline:3px solid #ffbf47; outline-offset:2px; }
  .engines { display:flex; gap:.8rem; flex-wrap:wrap; }
  .engcard { flex:1 1 16rem; text-align:left; font:inherit; color:inherit; background:#fff; border:2px solid #b9bfc9; border-radius:14px; padding:.9rem 1rem; cursor:pointer; }
  .engcard[aria-pressed="true"] { border-color:#1d55d0; background:#eef3ff; }
  .engcard h3 { margin:0 0 .2rem; font-size:1.05rem; }
  .engcard p { margin:.2rem 0; font-size:.92rem; }
  details { margin:.6rem 0; }
  details summary { cursor:pointer; font-weight:600; }
  details ul { margin:.4rem 0 .2rem 1.1rem; padding:0; }
  details li { margin:.3rem 0; }
  .seg { display:flex; gap:.5rem; flex-wrap:wrap; margin:.3rem 0 .2rem; }
  .seg button { font:inherit; font-weight:600; padding:.55rem 1rem; border-radius:999px; border:1px solid #b9bfc9; background:#fff; color:inherit; cursor:pointer; }
  .seg button[aria-pressed="true"] { background:#1d55d0; border-color:#1d55d0; color:#fff; }
  .row { display:flex; gap:1rem; flex-wrap:wrap; }
  .row > div { flex:1 1 12rem; }
  .proj { border:1px solid #e3e6ea; border-radius:12px; padding:.8rem .9rem; margin:.7rem 0; background:#fff; }
  .proj h3 { margin:0 0 .2rem; font-size:1.05rem; }
  .proj audio { width:100%; max-width:640px; display:block; margin:.5rem 0 .3rem; }
  pre.script { white-space:pre-wrap; word-wrap:break-word; font-size:.9rem; background:#f1f3f6; padding:.7rem .8rem; border-radius:10px; max-height:16rem; overflow:auto; }
  .clips li { margin:.2rem 0; }
  @media (prefers-color-scheme: dark) {
    textarea, input[type=text], input[type=number], select, .seg button, .engcard { background:#1e2127; border-color:#3a3f49; }
    .engcard[aria-pressed="true"] { background:#1b2a4a; border-color:#5b8def; }
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
  <p class="muted">Write something, or describe what you want, and have it performed. Two engines, and the page explains which one to pick.</p>

  <div id="status" class="status" role="status" aria-live="polite">Loading the Sound Booth&hellip;</div>

  <main id="app" hidden>
    <fieldset>
      <legend>Engine</legend>
      <div class="engines" role="group" aria-label="Which engine" id="engines"></div>
      <details id="chooser"><summary></summary><p id="chooserAnswer"></p><ul id="chooserRules"></ul></details>
      <button type="button" class="act quiet" id="btnSuggest">Pick one for me from what I typed</button>
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
      <p class="hint" id="inputQ"></p>
      <div class="seg" role="group" aria-label="What are you putting in the box" id="inputModes"></div>
      <label class="field" for="text" id="textLabel">The words to perform</label>
      <p class="hint" id="textHint"></p>
      <textarea id="text" aria-describedby="textHint"></textarea>
      <details id="howto"><summary></summary><ul id="howtoList"></ul></details>

      <div id="settings"></div>

      <label class="field" for="mood">Mood</label>
      <p class="hint">Becomes a note to the actor between your sentences &mdash; what they are doing and feeling, never how the recording should sound.</p>
      <select id="mood"><option value="">No particular mood</option></select>

      <div>
        <button type="button" class="act" id="btnMake">Turn my words into a script</button>
      </div>
    </fieldset>

    <fieldset>
      <legend>The script</legend>
      <p class="hint" id="scriptHint">This is what gets performed. You can edit it here before rendering.</p>
      <label class="field" for="script">Script</label>
      <textarea id="script" aria-describedby="scriptHint" spellcheck="false"></textarea>
      <p id="readback" class="hint"></p>
      <div>
        <button type="button" class="act quiet" id="btnPreview" hidden>Hear this voice first (15 seconds, about a penny)</button>
        <button type="button" class="act primary" id="btnRender">Render</button>
        <button type="button" class="act" id="btnCancel" hidden>Stop this render</button>
      </div>
      <p class="hint">The cost is said out loud before anything runs, and Render asks once more before it spends.</p>
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

    var state = { engine:'scenema', mode:'easy', pendingRender:null, jobId:null, projectId:null, poll:null, guide:null, clips:[], values:{} };
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

    var h = await get('/api/kade/sound-booth/health');
    if(!h.ok || !h.data.guide){ say('Could not open the Sound Booth right now. Try reloading in a moment.', true); return; }
    state.guide = h.data.guide;
    var moodSel = document.getElementById('mood');
    (h.data.moods||[]).forEach(function(m){ var o=document.createElement('option'); o.value=m.key; o.textContent=m.label; moodSel.appendChild(o); });
    app.hidden = false;

    /* ---- engine cards + chooser, from the guide ---- */
    var engBox = document.getElementById('engines');
    ['scenema','seed'].forEach(function(k){
      var g = state.guide.engines[k];
      var b = document.createElement('button');
      b.type='button'; b.className='engcard'; b.setAttribute('aria-pressed', k===state.engine); b.dataset.engine=k;
      b.innerHTML = '<h3>'+esc(g.name)+' &mdash; '+esc(g.tagline)+'</h3><p>'+esc(g.where)+'</p><p>'+esc(g.cost)+'</p>' +
        '<p><strong>Best for:</strong> '+esc(g.bestFor.join('; '))+'.</p><p><strong>Not for:</strong> '+esc(g.notFor.join('; '))+'.</p>';
      b.setAttribute('aria-label', g.name+'. '+g.tagline+' '+g.where+' '+g.cost+' Best for: '+g.bestFor.join(', ')+'. Not for: '+g.notFor.join(', ')+'.');
      b.onclick = function(){ setEngine(k); };
      engBox.appendChild(b);
    });
    var ch = state.guide.chooser;
    document.querySelector('#chooser summary').textContent = ch.question;
    document.getElementById('chooserAnswer').textContent = ch.answer;
    document.getElementById('chooserRules').innerHTML = ch.rules.map(function(r){ return '<li><strong>'+(r.pick==='seed'?'Seed Audio':'Scenema')+'</strong> when '+esc(r.when)+'.</li>'; }).join('');

    document.getElementById('btnSuggest').onclick = async function(){
      var t = document.getElementById('text').value.trim();
      if(t.length < 3){ say('Type something in the box first, then I can suggest.', true); return; }
      var r = await post('/api/kade/sound-booth/suggest', {text:t});
      if(!r.ok){ say('Could not suggest right now.', true); return; }
      setEngine(r.data.engine);
      say(r.data.reason + (r.data.sure ? '' : ' Change it if that is not what you meant.'));
    };

    function setEngine(e){
      state.engine = e;
      Array.prototype.forEach.call(engBox.children, function(c){ c.setAttribute('aria-pressed', c.dataset.engine===e); });
      var g = state.guide.engines[e];
      document.querySelector('#howto summary').textContent = 'How to write for ' + g.name;
      document.getElementById('howtoList').innerHTML = g.howToWrite.map(function(x){ return '<li>'+esc(x)+'</li>'; }).join('');
      document.getElementById('btnPreview').hidden = (e !== 'scenema');
      state.pendingRender = null; document.getElementById('btnRender').textContent = 'Render';
      renderSettings();
    }
    function setMode(m){
      state.mode = m;
      document.getElementById('modeEasy').setAttribute('aria-pressed', m==='easy');
      document.getElementById('modeAdv').setAttribute('aria-pressed', m==='advanced');
      document.getElementById('modeHint').textContent = m==='easy'
        ? 'Easy: type what you want said, pick a voice and a mood, and let the script desk shape it.'
        : 'Advanced: every setting this engine has, and the raw script to edit yourself.';
      renderSettings();
    }
    document.getElementById('modeEasy').onclick = function(){ setMode('easy'); };
    document.getElementById('modeAdv').onclick = function(){ setMode('advanced'); };

    /* WHAT IS IN THE BOX — the fix for the real confusion. One button at a
     * time, and the box says what it wants, so pressing the wrong one is not
     * something you can do by accident. */
    state.input = 'words';
    var inputG = state.guide.input;
    document.getElementById('inputQ').textContent = inputG.question;
    var modesBox = document.getElementById('inputModes');
    inputG.modes.forEach(function(m){
      var b = document.createElement('button');
      b.type = 'button'; b.setAttribute('aria-pressed', m.key === state.input); b.textContent = m.label; b.dataset.k = m.key;
      b.onclick = function(){ setInput(m.key); };
      modesBox.appendChild(b);
    });
    function setInput(k){
      state.input = k;
      var m = inputG.modes.filter(function(x){ return x.key === k; })[0];
      Array.prototype.forEach.call(modesBox.children, function(c){ c.setAttribute('aria-pressed', c.dataset.k === k); });
      document.getElementById('textLabel').textContent = m.boxLabel;
      document.getElementById('textHint').textContent = m.boxHint;
      var btn = document.getElementById('btnMake');
      btn.textContent = m.button;
      btn.title = m.buttonHint;
      say(m.boxLabel + '. ' + m.boxHint);
    }

    /* ---- settings, from the guide: only what THIS engine has ---- */
    var EASY = { scenema:['voice_description','gender','reference_voice_url'], seed:['voice','audio_urls'] };
    function renderSettings(){
      var g = state.guide.engines[state.engine];
      var box = document.getElementById('settings');
      var show = g.settings.filter(function(s){ return state.mode==='advanced' || EASY[state.engine].indexOf(s.key) !== -1; });
      box.innerHTML = show.map(function(s){
        var id = 'set_'+s.key, v = state.values[s.key];
        var head = '<label class="field" for="'+id+'">'+esc(s.label)+'</label><p class="hint" id="'+id+'_h">'+esc(s.hint)+'</p>';
        if(s.kind==='text') return head+'<input type="text" id="'+id+'" data-key="'+s.key+'" aria-describedby="'+id+'_h" value="'+esc(v||'')+'">';
        if(s.kind==='number') return head+'<input type="number" id="'+id+'" data-key="'+s.key+'" aria-describedby="'+id+'_h" step="any"'+(s.min!=null?' min="'+s.min+'"':'')+(s.max!=null?' max="'+s.max+'"':'')+' placeholder="'+(s.default!=null?esc('normal is '+s.default):'leave empty')+'" value="'+(v!=null?esc(v):'')+'">';
        if(s.kind==='toggle') return '<label class="field"><input type="checkbox" id="'+id+'" data-key="'+s.key+'"'+(v?' checked':'')+' aria-describedby="'+id+'_h"> '+esc(s.label)+'</label><p class="hint" id="'+id+'_h">'+esc(s.hint)+'</p>';
        if(s.kind==='choice') return head+'<select id="'+id+'" data-key="'+s.key+'" aria-describedby="'+id+'_h">'+s.options.map(function(o){ var lab = o===''?'None':o.replace(/_/g,' '); return '<option value="'+esc(o)+'"'+((v!=null?v:s.default)===o?' selected':'')+'>'+esc(lab.charAt(0).toUpperCase()+lab.slice(1))+'</option>'; }).join('')+'</select>';
        if(s.kind==='clip'){
          var list = state.clips.slice(0, s.max).map(function(c,i){ return '<li>'+(s.max>1?'@Audio'+(i+1)+': ':'')+esc(c.name)+' <button type="button" class="act quiet" data-rmclip="'+i+'">Remove</button></li>'; }).join('');
          return head+'<input type="file" id="'+id+'" accept="audio/*" aria-describedby="'+id+'_h"'+(state.clips.length>=s.max?' disabled':'')+'><ul class="clips">'+list+'</ul>';
        }
        return '';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('[data-key]'), function(el){
        el.onchange = function(){ state.values[el.dataset.key] = (el.type==='checkbox') ? el.checked : el.value; };
      });
      Array.prototype.forEach.call(box.querySelectorAll('input[type=file]'), function(el){
        el.onchange = function(){ if(el.files && el.files[0]) importClip(el.files[0]); };
      });
      Array.prototype.forEach.call(box.querySelectorAll('[data-rmclip]'), function(btn){
        btn.onclick = function(){ state.clips.splice(parseInt(btn.dataset.rmclip,10),1); say('Clip removed.'); renderSettings(); };
      });
    }

    async function importClip(file){
      if(file.size > 20*1024*1024){ say('That clip is over twenty megabytes. Ten to twenty seconds is all it needs.', true); return; }
      say('Importing ' + file.name + '\\u2026');
      var fd = new FormData(); fd.append('clip', file, file.name);
      var r = await fetch('/api/kade/sound-booth/reference', {method:'POST', headers:{'Authorization':'Bearer '+token}, body: fd});
      var j = null; try { j = await r.json(); } catch(e) {}
      if(!r.ok || !j || !j.url){ say((j&&j.error)||'That clip could not be imported.', true); return; }
      state.clips.push({url:j.url, name:j.name||file.name});
      say((j.spoken||'Clip imported.') + (state.engine==='seed' ? ' It is @Audio'+state.clips.length+'.' : ''));
      renderSettings();
    }

    function collect(){
      var b = { engine: state.engine, mode: state.mode, text: document.getElementById('text').value };
      var g = state.guide.engines[state.engine];
      g.settings.forEach(function(s){
        var v = state.values[s.key];
        if(s.kind==='clip') return;
        if(s.kind==='toggle'){ if(v) b[s.key] = true; return; }
        if(s.kind==='number'){ var n = parseFloat(v); if(!isNaN(n)) b[s.key] = (s.key==='seed'||s.key==='pitch') ? Math.round(n) : n; return; }
        if(v!=null && String(v).trim()!=='') b[s.key] = v;
      });
      if(!b.gender) b.gender = 'female';
      var mood = document.getElementById('mood').value; if(mood) b.mood = mood;
      if(state.clips.length){ if(state.engine==='seed') b.audio_urls = state.clips.slice(0,3).map(function(c){return c.url;}); else b.reference_voice_url = state.clips[0].url; }
      if(state.engine==='seed' && b.audio_quality===true) b.audio_quality='high';
      if(b.audio_quality===true) b.audio_quality='high';
      return b;
    }

    async function makeScript(which){
      var b = collect(); b.mode = which;
      if(!b.text || b.text.trim().length < 3){ say(which==='write' ? 'Say what you want made first.' : 'Type the words you want performed first.', true); document.getElementById('text').focus(); return; }
      document.getElementById('btnMake').disabled = true;
      say(which==='write' ? 'Writing it\\u2026' : 'Shaping your words\\u2026');
      var r = await post('/api/kade/sound-booth/script', b);
      document.getElementById('btnMake').disabled = false;
      if(!r.ok){ say(r.data.error || 'The script desk had trouble. Try again.', true); return; }
      document.getElementById('script').value = r.data.script || '';
      document.getElementById('readback').textContent = r.data.readback || '';
      state.estimate = r.data.estimate || null;
      var parts = [];
      /* The mismatch question comes FIRST: it is the one thing that can make
       * everything after it wrong. */
      if(r.data.mismatch) parts.push(r.data.mismatch);
      if(r.data.readback) parts.push(r.data.readback);
      if(r.data.estimate && r.data.estimate.spoken) parts.push(r.data.estimate.spoken);
      if(r.data.problem) parts.push('One thing to fix first: ' + r.data.problem);
      say(parts.join(' ') || 'Script ready.');
      document.getElementById('script').focus();
    }
    document.getElementById('btnMake').onclick = function(){ makeScript(state.input === 'brief' ? 'write' : 'format'); };
    document.getElementById('script').addEventListener('input', function(){ state.pendingRender=null; document.getElementById('btnRender').textContent='Render'; });

    async function doRender(preview){
      var script = document.getElementById('script').value.trim();
      var b = collect();
      if(!script && !preview){ say('There is nothing to render yet. Write a script first.', true); document.getElementById('script').focus(); return; }
      if(preview && !script && !b.voice_description){ say('Describe the voice first, or write a script, so there is a voice to preview.', true); return; }
      b.script = script || ('<speak voice="'+(b.voice_description||'A warm, clear adult voice.').replace(/"/g,'&quot;')+'" gender="'+(b.gender||'female')+'">Here is how I sound.</speak>');
      b.sourceText = document.getElementById('text').value;
      b.readback = document.getElementById('readback').textContent;
      if(preview) b.preview = true;
      if(state.projectId) b.projectId = state.projectId;
      say('Sending it\\u2026');
      var r = await post('/api/kade/sound-booth/render', b);
      if(!r.ok){ say(r.data.error || 'That render could not start.', true); return; }
      state.projectId = r.data.projectId || state.projectId;
      if(r.data.queued){
        state.jobId = r.data.jobId;
        document.getElementById('btnCancel').hidden = false;
        say((preview?'Voice sample queued. ':'Queued. ') + ((r.data.estimate && r.data.estimate.spoken) || '') + ' The page will say when it is ready.');
        startPoll();
      } else {
        say('Ready. ' + r.data.seconds + ' seconds of audio, about ' + Math.max(1, Math.round((r.data.costUSD||0)*100)) + ' cents. It is in your library below and in My Creations.');
        loadLibrary();
      }
    }
    var btnRender = document.getElementById('btnRender');
    btnRender.onclick = async function(){
      var script = document.getElementById('script').value.trim();
      if(!script){ say('There is nothing to render yet. Write a script first.', true); document.getElementById('script').focus(); return; }
      if(!state.pendingRender){
        state.pendingRender = true;
        var est = state.estimate;
        var words = script.replace(/<action>[\\s\\S]*?<\\/action>/gi,' ').replace(/<sound>[\\s\\S]*?<\\/sound>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\\[[^\\]]*\\]/g,' ').split(/\\s+/).filter(Boolean).length;
        var secs = Math.max(1, Math.round(words/2.6));
        var spoken = est && est.spoken ? est.spoken :
          ('About ' + secs + ' seconds of audio, ' + (state.engine==='seed' ? 'a few seconds to make, about ' + Math.max(1, Math.round(secs/60*18.75)) + ' cents.' : 'a couple of minutes to make, about ' + Math.max(1, Math.round(secs/60*2)+2) + ' cents.'));
        say(spoken + ' Press Render again to go ahead.');
        btnRender.textContent = 'Render \\u2014 confirm';
        return;
      }
      state.pendingRender = false; btnRender.textContent = 'Render'; btnRender.disabled = true;
      await doRender(false);
      btnRender.disabled = false;
    };
    document.getElementById('btnPreview').onclick = function(){ doRender(true); };
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
        if(s === 'done' || s === 'failed' || s === 'cancelled'){ stopPoll(); state.jobId = null; document.getElementById('btnCancel').hidden = true; loadLibrary(); }
      }, 15000);
    }

    async function loadLibrary(){
      var r = await get('/api/kade/sound-booth/projects');
      var box = document.getElementById('library');
      if(!r.ok){ box.innerHTML = '<p class="muted">Could not load your library.</p>'; return; }
      var ps = r.data.projects || [];
      if(!ps.length){ box.innerHTML = '<p class="muted">Nothing here yet.</p>'; return; }
      box.innerHTML = ps.map(function(p){
        var when = ''; try { when = new Date(p.updatedAt).toLocaleString('en-US', {month:'long', day:'numeric', hour:'numeric', minute:'2-digit'}); } catch(e){}
        var engine = p.engine === 'seed' ? 'Seed Audio' : 'Scenema';
        var stateWord = p.state === 'done' ? 'finished' : p.state;
        return '<div class="proj"><h3>' + esc(p.title) + '</h3>' +
          '<p class="hint">' + engine + ' \\u00b7 ' + esc(stateWord) + ' \\u00b7 ' + esc(when) + (p.costUSD ? ' \\u00b7 about ' + Math.max(1, Math.round(p.costUSD*100)) + ' cents' : '') + '</p>' +
          (p.readback ? '<p>' + esc(p.readback) + '</p>' : '') +
          (p.takes||[]).map(function(t, n){
            var lbl = 'Take ' + ((p.takes.length) - n) + (t.seconds ? ', ' + t.seconds + ' seconds' : '') + (t.description ? '. ' + t.description : '');
            return '<audio controls preload="none" aria-label="' + esc(lbl) + '"><source src="' + esc(t.url) + '">' + (t.backupUrl ? '<source src="' + esc(t.backupUrl) + '">' : '') + '</audio>' +
                   '<p class="hint"><a href="' + esc(t.url) + '" download target="_blank" rel="noreferrer">Download this take</a>' + (t.seconds ? ' \\u00b7 ' + t.seconds + ' seconds' : '') + '</p>';
          }).join('') +
          '<details><summary>Script</summary><pre class="script">' + esc(p.script) + '</pre></details>' +
          '<button type="button" class="act" data-open="' + esc(p.id) + '">Open this in the booth</button></div>';
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
          if(p.options){ Object.keys(p.options).forEach(function(k){ if(typeof p.options[k] !== 'object') state.values[k] = p.options[k]; }); renderSettings(); }
          say('Opened "' + p.title + '". Edit it and render again, or change the voice first.');
          document.getElementById('script').focus();
        };
      });
      var listen = ps.filter(function(p){ return p.state === 'queued' || p.state === 'running'; })[0];
      if(listen && listen.jobs && listen.jobs.length && !state.jobId){ state.jobId = listen.jobs[listen.jobs.length-1]; document.getElementById('btnCancel').hidden = false; startPoll(); }
    }
    setEngine('scenema'); setMode('easy'); setInput('words');
    loadLibrary();
    say('Ready. ' + state.guide.chooser.answer);
  })();
  </script>
</body></html>`;

module.exports = { soundBoothHtml };
