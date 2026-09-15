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
  <p class="muted">Choose a performance with AuK HQ, a scene with Seed Audio, or music with Lyria. Each engine has its own workspace. Switching engines keeps your drafts in this tab.</p>

  <div id="status" class="status" role="status" aria-live="polite">Loading the Sound Booth&hellip;</div>

  <main id="app" hidden>
    <fieldset>
      <legend>Engine</legend>
      <div class="engines" role="group" aria-label="Which engine" id="engines"></div>
      <p id="engineSummary" class="hint"></p>
      <details id="engineDetails"><summary>About this engine</summary><p id="engineWhere"></p><p id="engineCost"></p><p id="engineBest"></p><p id="engineNotFor"></p></details>
      <details id="chooser"><summary></summary><p id="chooserAnswer"></p><ul id="chooserRules"></ul></details>
      <button type="button" class="act quiet" id="btnSuggest">Pick one for me from what I typed</button>
    </fieldset>
    <fieldset id="starterPanel"><legend>Start something</legend>
      <label class="field" for="starter" id="starterLabel">A starting script</label>
      <select id="starter"><option value="">Choose a starting point</option></select>
      <button type="button" class="act quiet" id="btnStarter">Start a new project from this</button>
      <button type="button" class="act quiet" id="btnBlank">New blank project</button>
      <p class="hint" id="starterHint">Starting points are free to load. Save your current draft before replacing it. Generation starts only after you confirm the price.</p>
    </fieldset>


    <fieldset id="modePanel">
      <legend>Mode</legend>
      <div class="seg" role="group" aria-label="Easy or advanced">
        <button type="button" id="modeEasy" aria-pressed="true">Easy</button>
        <button type="button" id="modeAdv" aria-pressed="false">Advanced</button>
      </div>
      <p class="hint" id="modeHint">Easy: type what you want said, pick a voice and a mood, and let the script desk shape it.</p>
    </fieldset>

    <fieldset id="writingPanel">
      <legend id="writingLegend">What should it say?</legend>
      <p class="hint" id="inputQ"></p>
      <div class="seg" role="group" aria-label="What are you putting in the box" id="inputModes"></div>
      <label class="field" for="text" id="textLabel">The words to perform</label>
      <p class="hint" id="textHint"></p>
      <textarea id="text" aria-describedby="textHint"></textarea>
      <details id="howto"><summary></summary><ul id="howtoList"></ul></details>

      <div>
        <button type="button" class="act" id="btnMake">Turn my words into a script</button>
      </div>
    </fieldset>

    <fieldset id="settingsPanel"><legend id="settingsLegend">Voice and sound</legend>
      <div id="settings"></div>

      <div id="moodPanel"><label class="field" for="mood">Performance mood</label>
      <p class="hint">Becomes a note to the actor between your sentences &mdash; what they are doing and feeling, never how the recording should sound.</p>
      <select id="mood"><option value="">No particular mood</option></select></div>

    </fieldset>

    <fieldset id="editorPanel">
      <legend id="editorLegend">The script</legend>
      <p class="hint" id="scriptHint">This is what gets performed, written like a script. Square brackets are a direction for the actor and are never spoken: [Voice tightens.] Double parentheses are a sound in the room: ((thunder)). Everything else is spoken. Edit it here before rendering; the engine's own code is built from it behind the scenes.</p>
      <label class="field" for="script" id="editorLabel">Script</label>
      <textarea id="script" aria-describedby="scriptHint" spellcheck="false"></textarea>
      <details id="codeBox" hidden><summary>Show the engine's code for this script</summary><pre class="script" id="codeView" aria-label="The engine code, read only"></pre></details>
      <p id="readback" class="hint"></p>
      <div id="renderActions">
        <button type="button" class="act quiet" id="btnPreview" hidden>Hear this voice first (short paid preview)</button>
        <button type="button" class="act quiet" id="btnNewVoice" hidden>Cast a different voice</button>
        <button type="button" class="act primary" id="btnRender">Render</button>
        <button type="button" class="act" id="btnCancel" hidden>Stop this render</button>
      </div>
      <p class="hint">The cost is announced first. Press the generation button again to confirm the price and start.</p>
    </fieldset>

    <button type="button" class="act quiet" id="btnScriptFile">Download this script as text</button>
    <details><summary>Free audio workbench: trim, fade, and add a background</summary>
      <form id="audioWorkbench"><p>Choose recordings from your device. Make a stereo WAV up to five minutes long. Files stay on this device; there is no generation charge.</p>
        <label class="field" for="mixMain">Main recording</label><input id="mixMain" type="file" accept="audio/*,.wav,.mp3,.m4a" required>
        <audio id="mixOriginal" controls preload="metadata" aria-label="Original recording"></audio>
        <div class="row"><div><label for="mixStart">Keep from, seconds</label><input id="mixStart" type="number" step="any" min="0" value="0" aria-label="Start time"></div><div><label for="mixEnd">Keep until, seconds</label><input id="mixEnd" type="number" step="any" min="0.01" value="10" aria-label="End time"></div></div>
        <label for="mixGain">Main volume, decibels</label><input id="mixGain" type="number" min="-36" max="12" value="0" aria-label="Main volume">
        <label for="mixFadeIn">Fade in, seconds</label><input id="mixFadeIn" type="number" min="0" max="30" step="0.1" value="0" aria-label="Fade in">
        <label for="mixFadeOut">Fade out, seconds</label><input id="mixFadeOut" type="number" min="0" max="30" step="0.1" value="0" aria-label="Fade out">
        <label class="field" for="mixBed">Optional background music or ambience</label><input id="mixBed" type="file" accept="audio/*,.wav,.mp3,.m4a">
        <label for="mixBedGain">Background volume, decibels</label><input id="mixBedGain" type="number" min="-48" max="0" value="-18" aria-label="Background volume">
        <label><input id="mixLoop" type="checkbox" checked> Repeat the background to fit</label>
        <button class="act" id="mixBuild" type="submit">Make this mix — free</button>
        <p id="mixStatus" role="status" aria-live="polite"></p>
        <div id="mixResult" hidden><audio id="mixPlayer" controls aria-label="Finished local mix"></audio><p><a id="mixDownload" download="sound-booth-mix.wav">Download the mix as WAV</a></p></div>
      </form>
    </details>

    <h2>Library</h2>
    <label><input type="checkbox" id="showFailed"> Show failed and stopped attempts without audio</label>
    <div id="library" aria-live="off"><p class="muted">Nothing here yet.</p></div>
  </main>

  <footer class="muted">Finished audio also lands in <a href="/my-creations">My Creations</a>, where it can be downloaded and shared. &mdash; &copy; 2026 Kade Murdock &middot; Kade-AI</footer>

  <script>
  (async function(){
    var status = document.getElementById('status');
    var app = document.getElementById('app');
    var token = null; try { token = await getToken(); } catch(e) {}
    if(!token){ status.className='status err'; status.textContent='Please sign in at the chat site first, then reload this page.'; return; }

    var drafts = {};
    var state = { quoteRevision:0, engine:'scenema', mode:'easy', pendingRender:null, jobId:null, projectId:null, poll:null, guide:null, clips:[], values:{}, lastWait:null, cancelArmed:null, voiceSeed:null, rerollVoice:false };
    function say(msg, isErr){ status.className = 'status' + (isErr ? ' err' : ''); status.textContent = msg; }
    function showCode(xml){ var box = document.getElementById('codeBox'); var view = document.getElementById('codeView'); if(!box||!view) return; if(state.engine==='scenema' && xml && /<speak/i.test(xml) && state.mode==='advanced'){ view.textContent = xml; box.hidden = false; } else { box.hidden = true; view.textContent=''; } }
    function esc(s){ var d=document.createElement('div'); d.textContent = s==null?'':s; return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    async function request(path, body){
      try {
        var r = await fetch(path, {method:body === undefined ? 'GET':'POST', headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'}, body:body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(240000)});
        var j = null; try { j = await r.json(); } catch(e) {}
        return {ok:r.ok,status:r.status,data:j||{}};
      } catch(e) { return {ok:false,status:0,data:{error:'Connection lost. Check the library before retrying a render; it may still be working.'}}; }
    }
    function post(path, body){ return request(path,body||{}); }
    function get(path){ return request(path); }
    function renderLabel(){ if(state.engine==='scenema' && state.values.auk_task==='edit') return 'Edit recording'; return state.engine==='lyria' ? 'Make music' : state.engine==='seed' ? 'Generate scene' : 'Perform script'; }
    function busy(){ return state.rendering || state.jobId || state.writing || state.importing; }
    function invalidateQuote(){ state.quoteRevision++; state.pendingRender=null; state.estimate=null; document.getElementById('btnRender').textContent=renderLabel(); }
    app.addEventListener('input', invalidateQuote);
    app.addEventListener('change', invalidateQuote);

    var h = await get('/api/kade/sound-booth/health');
    if(!h.ok || !h.data.guide){ say('Could not open the Sound Booth right now. Try reloading in a moment.', true); return; }
    state.guide = h.data.guide;
    var moodSel = document.getElementById('mood');
    (h.data.moods||[]).forEach(function(m){ var o=document.createElement('option'); o.value=m.key; o.textContent=m.label; moodSel.appendChild(o); });
    app.hidden = false;

    /* ---- engine cards + chooser, from the guide ---- */
    var engBox = document.getElementById('engines');
    ['scenema','seed','lyria'].forEach(function(k){
      var g = state.guide.engines[k];
      var b = document.createElement('button');
      b.type='button'; b.className='engcard'; b.setAttribute('aria-pressed', k===state.engine); b.dataset.engine=k;
      b.innerHTML = '<strong>'+esc(g.name)+'</strong><p>'+esc(g.tagline)+'</p>';
      b.setAttribute('aria-label', g.name+'. '+g.tagline);
      b.onclick = function(){ setEngine(k); };
      engBox.appendChild(b);
    });
    var ch = state.guide.chooser;
    document.querySelector('#chooser summary').textContent = ch.question;
    document.getElementById('chooserAnswer').textContent = ch.answer;
    var ENG_NAME = { seed:'Seed Audio', scenema:'AuK HQ', lyria:'Lyria' };
    document.getElementById('chooserRules').innerHTML = ch.rules.map(function(r){ return '<li><strong>'+(ENG_NAME[r.pick]||r.pick)+'</strong> when '+esc(r.when)+'.</li>'; }).join('');

    document.getElementById('btnSuggest').onclick = async function(){
      if(busy())return;
      var sourceEngine=state.engine, revision=state.quoteRevision;
      var t = document.getElementById(state.engine==='lyria'?'script':'text').value.trim();
      if(t.length < 3){ say('Type something in the box first, then I can suggest.', true); return; }
      var r = await post('/api/kade/sound-booth/suggest', {text:t});
      if(state.engine!==sourceEngine || state.quoteRevision!==revision || busy())return;
      if(!r.ok){ say('Could not suggest right now.', true); return; }
      var hasDraft=!!drafts[r.data.engine] || r.data.engine===state.engine;
      if(!setEngine(r.data.engine))return;
      if(!hasDraft){if(state.engine==='lyria')document.getElementById('script').value=t;else{document.getElementById('text').value=t;setInput('brief');}}
      say(r.data.reason + (r.data.sure ? '' : ' Change it if that is not what you meant.'));
    };

    function saveDraft(){
      drafts[state.engine]={mode:state.mode,input:state.input,text:document.getElementById('text').value,script:document.getElementById('script').value,mood:document.getElementById('mood').value,readback:document.getElementById('readback').textContent,values:Object.assign({},state.values),clips:state.clips.slice(),projectId:state.projectId,voiceSeed:state.voiceSeed,rerollVoice:state.rerollVoice,lastXml:state.lastXml};
    }
    function setEngine(e){
      if(busy()){say('Finish the current operation or stop the render before switching workspaces.',true);return false;}
      if(e!==state.engine){
        saveDraft();
        var d=drafts[e]||{};state.engine=e;
        state.mode=d.mode||'easy';state.input=d.input||'words';state.values=Object.assign({},d.values||{});state.clips=(d.clips||[]).slice();state.projectId=d.projectId||null;state.voiceSeed=d.voiceSeed;state.rerollVoice=!!d.rerollVoice;state.lastXml=d.lastXml||'';
        document.getElementById('text').value=d.text||'';document.getElementById('script').value=d.script||'';document.getElementById('mood').value=d.mood||'';document.getElementById('readback').textContent=d.readback||'';
      }
      state.engine = e;
      Array.prototype.forEach.call(engBox.children, function(c){ c.setAttribute('aria-pressed', c.dataset.engine===e); });
      var g = state.guide.engines[e];
      document.querySelector('#howto summary').textContent = 'How to write for ' + g.name;
      document.getElementById('howtoList').innerHTML = g.howToWrite.map(function(x){ return '<li>'+esc(x)+'</li>'; }).join('');
      document.getElementById('btnPreview').hidden = (e !== 'scenema');
      document.getElementById('btnNewVoice').hidden = (e !== 'scenema');
      invalidateQuote();setMode(state.mode);setInput(state.input||'words');applyWorkflow();showCode(state.lastXml);
      say(g.name+'. '+(e==='lyria'?'Describe your music, add optional lyrics, then choose Make music.':e==='seed'?'Build a scene with dialogue, sounds and up to three reference voices.':'Write a performance and direct its voice.'));return true;
    }
    function applyWorkflow(){
      var music=state.engine==='lyria', scene=state.engine==='seed';
      var g=state.guide.engines[state.engine];
      document.getElementById('engineSummary').textContent=g.tagline;
      document.querySelector('#engineDetails summary').textContent='About '+g.name;
      document.getElementById('engineWhere').textContent=g.where;document.getElementById('engineCost').textContent=g.cost;
      document.getElementById('engineBest').textContent='Best for: '+g.bestFor.join('; ')+'.';document.getElementById('engineNotFor').textContent='Not for: '+g.notFor.join('; ')+'.';
      document.getElementById('engineDetails').open=false;
      if(music) document.getElementById('renderActions').before(document.getElementById('settingsPanel'));
      else document.getElementById('editorPanel').before(document.getElementById('settingsPanel'));
      document.getElementById('writingPanel').hidden=music;
      document.getElementById('modePanel').hidden=music;
      document.getElementById('moodPanel').hidden=music;
      document.getElementById('writingLegend').textContent=scene?'Build your scene':'Prepare the performance';
      document.getElementById('settingsLegend').textContent=music?'Song options':scene?'Voices and scene sound':'Voice and performance';
      document.getElementById('editorLegend').textContent=music?'Describe your music':scene?'Scene script':'Performance script';
      document.getElementById('editorLabel').textContent=music?'Music direction':scene?'Scene script':'Performance script';
      document.getElementById('scriptHint').textContent=music?'Describe the genre, instruments, mood, singing voice if wanted, structure and length. Send this direction straight to Lyria; no script-writing step is needed. Put any exact words to sing in Your own lyrics.':scene?'Describe the setting, sounds and each voice. Include the exact dialogue and identify reference voices as @Audio1, @Audio2 or @Audio3.':'Write the words to perform. Square brackets give actor directions, such as [Whispers.]. Double parentheses describe sounds, such as ((thunder)).';
      document.getElementById('script').setAttribute('aria-label',music?'Music direction':scene?'Scene script':'Performance script');
      document.getElementById('btnScriptFile').textContent=music?'Download music direction as text':'Download this script as text';
      document.getElementById('starterLabel').textContent=music?'A music starting point':scene?'A scene starting point':'A performance starting point';
      var select=document.getElementById('starter'), selected=select.value;
      select.innerHTML='<option value="">Choose a starting point</option>';
      (state.guide.starters||[]).filter(function(x){return x.engine===state.engine;}).forEach(function(x){var o=document.createElement('option');o.value=x.id;o.textContent=x.title;select.appendChild(o);});
      select.value=selected;
      var howto=document.getElementById('howto');
      document.getElementById('editorLabel').before(howto);
    }
    function setMode(m){
      state.mode = m;
      document.getElementById('modeEasy').setAttribute('aria-pressed', m==='easy');
      document.getElementById('modeAdv').setAttribute('aria-pressed', m==='advanced');
      document.getElementById('modeHint').textContent = m==='easy'
        ? 'Easy: type what you want said, pick a voice and a mood, and let the script desk shape it.'
        : 'Advanced: every setting this engine has, the script to edit yourself, and the code this engine uses shown underneath it.';
      showCode(state.lastXml);
      renderSettings();applyWorkflow();
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
      if(state.engine!=='lyria') say(m.boxLabel + '. ' + m.boxHint);
    }

    /* ---- settings, from the guide: only what THIS engine has ---- */
    /* Lyria has three knobs and they all belong on the easy side: there is
     * nothing advanced about it, because the brief IS the control. */
    var EASY = { scenema:['auk_task','instruction','voice_description','reference_voice_url','gen_seconds'], seed:['voice','audio_urls'], lyria:['instrumental','lyrics','keep_lyrics'] };
    function renderSettings(){
      var g = state.guide.engines[state.engine];
      var box = document.getElementById('settings');
      var show = g.settings.filter(function(s){ if(state.engine==='lyria' && state.values.instrumental && (s.key==='lyrics'||s.key==='keep_lyrics')) return false; return state.engine==='lyria' || state.mode==='advanced' || EASY[state.engine].indexOf(s.key) !== -1; });
      box.innerHTML = show.map(function(s){
        var id = 'set_'+s.key, v = state.values[s.key];
        var head = '<label class="field" for="'+id+'">'+esc(s.label)+'</label><p class="hint" id="'+id+'_h">'+esc(s.hint)+'</p>';
        if(s.key==='lyrics') return head+'<textarea id="'+id+'" data-key="'+s.key+'" aria-describedby="'+id+'_h" rows="8">'+esc(v||'')+'</textarea>';
        if(s.kind==='text') return head+'<input type="text" id="'+id+'" data-key="'+s.key+'" aria-describedby="'+id+'_h" value="'+esc(v||'')+'">';
        if(s.kind==='number') return head+'<input type="number" id="'+id+'" data-key="'+s.key+'" aria-describedby="'+id+'_h" step="any"'+(s.min!=null?' min="'+s.min+'"':'')+(s.max!=null?' max="'+s.max+'"':'')+' placeholder="'+(s.default!=null?esc('normal is '+s.default):'leave empty')+'" value="'+(v!=null?esc(v):'')+'">';
        if(s.kind==='toggle') return '<label class="field"><input type="checkbox" id="'+id+'" data-key="'+s.key+'"'+(((v!=null)?v:s.default)?' checked':'')+' aria-describedby="'+id+'_h"> '+esc(s.label)+'</label><p class="hint" id="'+id+'_h">'+esc(s.hint)+'</p>';
        if(s.kind==='choice') return head+'<select id="'+id+'" data-key="'+s.key+'" aria-describedby="'+id+'_h">'+s.options.map(function(o){ var lab = o===''?'None':o.replace(/_/g,' '); return '<option value="'+esc(o)+'"'+((v!=null?v:s.default)===o?' selected':'')+'>'+esc(lab.charAt(0).toUpperCase()+lab.slice(1))+'</option>'; }).join('')+'</select>';
        if(s.kind==='clip'){
          /* Explicit extensions, not audio/* — a .ogg is typed video/ogg or
           * application/ogg as often as audio/ogg, so a wildcard filter can
           * hide the file she is trying to pick. And each clip gets a PLAYER,
           * her ask: hearing what is attached is the only way to know. */
          var accept = state.engine==='seed' ? '.wav,.mp3,.m4a,.ogg,audio/*' : '.wav,.mp3,.m4a,audio/*';
          var list = state.clips.slice(0, s.max).map(function(c,i){
            return '<li>'+(s.max>1?'@Audio'+(i+1)+': ':'')+esc(c.name)+
              '<audio controls preload="none" aria-label="Play the imported clip, '+esc(c.name)+'"><source src="'+esc(c.url)+'"></audio>'+
              '<button type="button" class="act quiet" data-rmclip="'+i+'">Remove '+esc(c.name)+'</button></li>';
          }).join('');
          return head+'<input type="file" id="'+id+'" accept="'+accept+'" aria-describedby="'+id+'_h"'+(state.clips.length>=s.max?' disabled':'')+'><ul class="clips">'+list+'</ul>';
        }
        return '';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('[data-key]'), function(el){
        el.oninput = el.onchange = function(){ state.values[el.dataset.key] = (el.type==='checkbox') ? el.checked : el.value; invalidateQuote(); if(el.dataset.key==='instrumental'){renderSettings();document.getElementById('set_instrumental').focus();} };
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
      state.importing=true;try {
      say('Importing ' + file.name + '\\u2026');
      var fd = new FormData(); fd.append('clip', file, file.name); fd.append('engine', state.engine);
      var r = await fetch('/api/kade/sound-booth/reference', {method:'POST', headers:{'Authorization':'Bearer '+token}, body: fd});
      var j = null; try { j = await r.json(); } catch(e) {}
      if(!r.ok || !j || !j.url){ say((j&&j.error)||'That clip could not be imported.', true); return; }
      /* A silent success on an upload is indistinguishable from nothing
       * happening, so this says the file name back and points at the player. */
      state.clips.push({url:j.url, name:j.name||file.name});
      say((j.spoken||'Clip imported.') + (state.engine==='seed' ? ' It is @Audio'+state.clips.length+'.' : ''));
      renderSettings();
      } catch(e){say('Could not import that clip.',true);} finally {state.importing=false;}
    }

    function collect(){
      var b = { engine: state.engine, mode: state.mode, text: document.getElementById('text').value };
      var g = state.guide.engines[state.engine];
      g.settings.forEach(function(s){
        var v = state.values[s.key];
        if(s.kind==='clip') return;
        if(s.kind==='toggle'){ if(s.key==='validate'){ b.validate = (v===undefined || v===null) ? true : !!v; return; } b[s.key] = (v===undefined || v===null) ? !!s.default : !!v; return; }
        if(s.kind==='number'){ var n = parseFloat(v); if(!isNaN(n)) b[s.key] = (s.key==='seed'||s.key==='pitch') ? Math.round(n) : n; return; }
        if(v!=null && String(v).trim()!=='') b[s.key] = v;
      });
      if(state.engine!=='lyria' && !b.gender) b.gender = 'female';
      if(state.engine==='lyria' && b.instrumental){delete b.lyrics;delete b.keep_lyrics;}
      var mood = document.getElementById('mood').value; if(mood && state.engine!=='lyria') b.mood = mood;
      /* Lyria clones nothing, so a clip left over from another engine must not
       * ride along with a music render. */
      if(state.clips.length && state.engine!=='lyria'){ if(state.engine==='seed') b.audio_urls = state.clips.slice(0,3).map(function(c){return c.url;}); else b.reference_voice_url = state.clips[0].url; }
      if(state.engine==='seed' && b.audio_quality===true) b.audio_quality='high';
      if(b.audio_quality===true) b.audio_quality='high';
      return b;
    }

    async function makeScript(which){
      if(state.engine==='lyria' || busy()) return;
      var b = collect(); b.mode = which;
      if(!b.text || b.text.trim().length < 3){ say(which==='write' ? 'Say what you want made first.' : 'Type the words you want performed first.', true); document.getElementById('text').focus(); return; }
      state.writing=true;document.getElementById('btnMake').disabled = true;
      say(which==='write' ? 'Writing it\\u2026' : 'Shaping your words\\u2026');
      var r = await post('/api/kade/sound-booth/script', b);
      state.writing=false;document.getElementById('btnMake').disabled = false;
      if(!r.ok){ say(r.data.error || 'The script desk had trouble. Try again.', true); return; }
      /* Part 126: the person sees the screenplay; the engine's XML sits behind
       * a disclosure for anyone who wants it. Seed scripts are already prose. */
      document.getElementById('script').value = r.data.screenplay || r.data.script || '';
      state.lastXml = r.data.script || '';
      showCode(state.lastXml);
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
    document.getElementById('script').addEventListener('input', function(){ state.pendingRender=null; document.getElementById('btnRender').textContent=renderLabel(); });

    async function doRender(preview){
      if(state.rendering || state.jobId){ say('A render is already in progress. Wait for it or press Stop.', true); return; }
      state.rendering = true;
      document.getElementById('btnPreview').disabled = true;
      try {
      var script = document.getElementById('script').value.trim();
      var b = collect();
      if(!script && !preview && b.auk_task!=='edit'){ say(state.engine==='lyria'?'Describe the music you want first.':'There is nothing to render yet. Write a script first.', true); document.getElementById('script').focus(); return; }
      if(preview && !script && !b.voice_description){ say('Describe the voice first, or write a script, so there is a voice to preview.', true); return; }
      /* Part 122.1: this line used to invent a THIRD sample sentence ("Here is
       * how I sound."), different again from the two on the server, so what a
       * preview performed depended on which path fired. The server builds the
       * sample from her script now; the page sends an empty speak tag carrying
       * only the voice, and lets it decide. */
      b.script = script || ('<speak voice="'+(b.voice_description||'A warm, clear adult voice.').replace(/"/g,'&quot;')+'" gender="'+(b.gender||'female')+'"></speak>');
      b.sourceText = document.getElementById('text').value;
      b.readback = document.getElementById('readback').textContent;
      if(preview) b.preview = true;
      if(state.projectId) b.projectId = state.projectId;
      /* THE SEED IS THE VOICE. Without this the penny she spent auditioning a
       * voice bought her nothing — the render cast a different actor. */
      if(!preview && Number.isInteger(state.voiceSeed) && b.seed === undefined) b.seed = state.voiceSeed;
      if(state.rerollVoice) b.newVoice = true;
      say('Sending it\\u2026');
      var r = await post('/api/kade/sound-booth/render', b);
      if(!r.ok){ say(r.data.error || 'That render could not start.', true); return; }
      state.rerollVoice = false;
      state.projectId = r.data.projectId || state.projectId;
      if(Number.isInteger(r.data.voiceSeed)) state.voiceSeed = r.data.voiceSeed;
      if(r.data.queued){
        state.jobId = r.data.jobId;
        state.previewJob = !!preview;
        document.getElementById('btnCancel').hidden = false;
        say((preview?'Voice sample queued. ':'Queued. ') + ((r.data.estimate && r.data.estimate.spoken) || '') + ' The page will say when it is ready.');
        startPoll();
      } else {
        say(r.data.spoken || 'Ready. ' + r.data.seconds + ' seconds of audio, about ' + Math.max(1, Math.round((r.data.costUSD||0)*100)) + ' cents. It is in your library below and in My Creations.');
        loadLibrary();
      }
      } finally { state.rendering=false; document.getElementById('btnPreview').disabled=false; }
    }
    var btnRender = document.getElementById('btnRender');
    async function confirmRender(preview){
      if(state.rendering || state.jobId) { say('A render is already in progress. Wait for it or press Stop.',true); return; }
      var script=document.getElementById('script').value.trim();
      var b=collect();
      if(!script && !preview && b.auk_task!=='edit'){ say(state.engine==='lyria'?'Describe the music you want first.':'Write a script first.',true); return; }
      b.script=script || '<speak voice="'+esc(b.voice_description||'A warm clear voice')+'" gender="'+(b.gender||'female')+'"></speak>';
      b.preview=preview; b.estimateOnly=true;
      var key=JSON.stringify(b);
      if(state.pendingRender!==key){
        var quoteRevision=state.quoteRevision;btnRender.disabled=true;
        var r=await post('/api/kade/sound-booth/render',b);
        btnRender.disabled=false;
        if(!r.ok){say(r.data.error||'Could not estimate that script.',true);return;}
        if(quoteRevision!==state.quoteRevision){say('The draft or settings changed. Choose '+renderLabel()+' again for the current price.');return;}
        state.pendingRender=key;
        var cloneLine=state.engine==='lyria' ? '' : state.clips.length ? (b.auk_task==='edit'?' Editing ':' Cloning ')+state.clips.map(function(c){return c.name;}).join(', ')+'.' : ' No reference clip attached.';
        say((r.data.estimate.spoken||'')+cloneLine+' Press '+(preview?'Hear this voice first':renderLabel())+' again to confirm.');
        if(!preview) btnRender.textContent=renderLabel()+' — confirm';
        return;
      }
      invalidateQuote(); btnRender.disabled=true;
      try { await doRender(preview); } finally { btnRender.disabled=false; }
    }
    btnRender.onclick=function(){return confirmRender(false);};
    document.getElementById('btnPreview').onclick=function(){return confirmRender(true);};
    /* The seed is pinned per project so a render sounds like its audition. That
     * is only kind if there is also a way OUT of a voice she does not like —
     * otherwise a project is stuck with the first actor it was ever cast. */
    document.getElementById('btnNewVoice').onclick = function(){
      state.rerollVoice = true; state.voiceSeed = null; delete state.values.seed; invalidateQuote();
      say('Next preview or render will cast a different voice from the same description. Press Hear this voice first to audition it before you spend on the whole thing.');
    };
    /* Part 122 -- STOP ASKS ONCE while the wait is still earned. Three renders
     * on Sep 3 were stopped by hand at fifty seconds and at four minutes, both
     * inside a cold wake that had not finished; the booth had promised three
     * minutes and then said nothing, so stopping was the reasonable thing to
     * do. It asks, it does not refuse -- a render she means to kill still dies
     * on the second press. */
    document.getElementById('btnCancel').onclick = async function(){
      if(!state.jobId) return;
      var w = state.lastWait;
      if(state.cancelArmed !== state.jobId && w && w.phase !== 'rendering'){
        state.cancelArmed = state.jobId;
        say((w.spoken || 'Still waiting for the render.') + ' Press Stop again to cancel.');
        return;
      }
      var result = await post('/api/kade/sound-booth/cancel/' + encodeURIComponent(state.jobId), {});
      if(!result.ok){ say(result.data.error || 'Stop did not reach the render service. Still checking its status.',true); return; }
      if(result.data.state==='done'){ say(result.data.spoken || 'That take just finished. Checking its result.'); return; }
      stopPoll(); state.lastWait = null; state.cancelArmed = null;
      state.jobId=null; say(result.data.spoken || 'Stopped. Completed takes are kept. GPU time already used may still be charged.');
      document.getElementById('btnCancel').hidden = true; loadLibrary();
    };

    function stopPoll(){ if(state.poll){ clearInterval(state.poll); state.poll = null; } }
    /* Part 122. This used to speak ONLY when the state word changed, and queued
     * to running is the only change before done -- so a cold wake (six and a
     * half minutes, measured) was one sentence and then total silence, which by
     * ear is a hung app. It is why three of her renders got stopped by hand. It
     * talks every other poll now, and the line it speaks carries elapsed time
     * and how long until it gives up, so the wait always sounds alive. */
    function startPoll(){
      stopPoll(); var last = '', ticks = 0, reading = false, failures = 0;
      state.poll = setInterval(async function(){
        if(!state.jobId || reading) return;
        reading=true;
        var r = await get('/api/kade/sound-booth/status/' + encodeURIComponent(state.jobId));
        reading=false;
        if(!r.ok){ failures++; if(failures===1 || failures%4===0) say(r.data.error || 'Cannot check progress right now. The render may still be working; checking again shortly.',true); return; }
        failures=0;
        var s = r.data.state; ticks++;
        state.lastWait = r.data.wait || null;
        var finished = (s === 'done' || s === 'failed' || s === 'cancelled');
        if(s !== last || finished || ticks % 2 === 0){ last = s; say(r.data.spoken || s, s === 'failed'); }
        if(finished){
          stopPoll(); state.jobId = null; state.lastWait = null; state.cancelArmed = null; document.getElementById('btnCancel').hidden = true;
          /* Part 123. "Hear this voice first" means HEAR it: a finished preview
           * plays itself, instead of landing as one more audio element she has
           * to find in the library by tab. The library still gets it. */
          if(s === 'done' && state.previewJob && r.data.url){
            say('Here is the voice. ' + (r.data.spoken || ''));
            try {
              var a = document.getElementById('previewPlayer');
              if(!a){ a = document.createElement('audio'); a.id = 'previewPlayer'; a.controls = true; a.setAttribute('aria-label', 'Voice sample'); status.parentNode.insertBefore(a, status.nextSibling); }
              a.src = r.data.url; var pl = a.play(); if(pl && pl.catch) pl.catch(function(){ say('Here is the voice. Press play on the sample player just below this line.'); });
            } catch(e){}
          }
          state.previewJob = false;
          loadLibrary();
        }
      }, 15000);
    }

    document.getElementById('showFailed').onchange=function(){ loadLibrary(); };
    async function loadLibrary(){
      var r = await get('/api/kade/sound-booth/projects');
      var box = document.getElementById('library');
      if(!r.ok){ box.innerHTML = '<p class="muted">Could not load your library.</p>'; return; }
      var ps = (r.data.projects || []).filter(function(p){ return document.getElementById('showFailed').checked || ['failed','cancelled'].indexOf(p.state)<0 || (p.takes||[]).length || p.hasRecoverableAudio; });
      if(!ps.length){ box.innerHTML = '<p class="muted">Nothing here yet.</p>'; return; }
      box.innerHTML = ps.map(function(p){
        var when = ''; try { when = new Date(p.updatedAt).toLocaleString('en-US', {month:'long', day:'numeric', hour:'numeric', minute:'2-digit'}); } catch(e){}
        var engine = p.engine === 'lyria' ? 'Lyria' : p.engine === 'seed' ? 'Seed Audio' : 'AuK HQ';
        var stateWord = p.state === 'done' ? 'finished' : p.state;
        return '<div class="proj"><h3>' + esc(p.title) + '</h3>' +
          '<p class="hint">' + esc(p.why || engine) + ' \\u00b7 ' + esc(stateWord) + ' \\u00b7 ' + esc(when) + (p.costUSD ? ' \\u00b7 about ' + Math.max(1, Math.round(p.costUSD*100)) + ' cents' : '') + '</p>' +
          (p.lastError ? '<p role="note">'+esc(p.lastError)+'</p>' : '') +
          (p.readback ? '<p>' + esc(p.readback) + '</p>' : '') +
          (p.takes||[]).map(function(t, n){
            var lbl = 'Take ' + ((p.takes.length) - n) + (t.seconds ? ', ' + t.seconds + ' seconds' : '') + (t.description ? '. ' + t.description : '');
            return '<audio controls preload="none" aria-label="' + esc(lbl) + '"><source src="' + esc(t.url) + '">' + (t.backupUrl ? '<source src="' + esc(t.backupUrl) + '">' : '') + '</audio>' +
                   '<p class="hint"><a href="' + esc(t.url) + '" download target="_blank" rel="noreferrer">Download this take</a>' + (t.masterUrl ? ' · <a href="' + esc(t.masterUrl) + '" download target="_blank" rel="noreferrer">Download WAV master</a>' : '') + (t.seconds ? ' \\u00b7 ' + t.seconds + ' seconds' : '') + '</p>';
          }).join('') +
          '<details><summary>'+(p.engine==='lyria'?'Music direction':'Script')+'</summary><pre class="script">' + esc(p.screenplay || p.script) + '</pre></details>' +
          '<button type="button" class="act" data-open="' + esc(p.id) + '">Open this in the booth</button></div>';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('[data-open]'), function(btn){
        btn.onclick = function(){
          var p = ps.filter(function(x){ return x.id === btn.getAttribute('data-open'); })[0];
          if(!p) return;
          if(!setEngine(p.engine)) return;
          state.projectId = p.id; setMode(p.mode === 'advanced' ? 'advanced' : 'easy');
          document.getElementById('text').value = p.sourceText || '';
          document.getElementById('script').value = p.screenplay || p.script || '';
          state.lastXml = p.script || ''; showCode(state.lastXml);
          document.getElementById('readback').textContent = p.readback || '';
          state.values={}; state.clips=[]; state.voiceSeed=p.voiceSeed; state.rerollVoice=false;
          if(p.options){
            Object.keys(p.options).forEach(function(k){ if(typeof p.options[k] !== 'object') state.values[k]=p.options[k]; });
            var urls=p.engine==='lyria' ? [] : p.engine==='seed' ? p.options.audio_urls||[] : (p.options.reference_voice_url?[p.options.reference_voice_url]:[]);
            state.clips=urls.map(function(url,i){return {url:url,name:'Saved reference '+(i+1)};});
          }
          invalidateQuote(); renderSettings();
          say('Opened "' + p.title + '". Change what you like, then generate another take.');
          document.getElementById('script').focus();
        };
      });
      var listen = ps.filter(function(p){ return p.state === 'queued' || p.state === 'running'; })[0];
      if(listen && listen.jobs && listen.jobs.length && !state.jobId){ state.jobId = listen.jobs[listen.jobs.length-1]; document.getElementById('btnCancel').hidden = false; startPoll(); }
    }
    var starters=state.guide.starters||[];

    function newProject(starter){
      if(busy()){say('Finish the current operation first.',true);return;}
      if(starter && !setEngine(starter.engine))return;
      state.projectId=null;state.voiceSeed=null;state.rerollVoice=false;state.values={};state.clips=[];
      if(starter && starter.engine==='lyria')state.values.instrumental=starter.script.indexOf('Instrumental only, no vocals.')!==-1;
      document.getElementById('mood').value='';
      setInput('words');
      document.getElementById('text').value='';document.getElementById('script').value=starter?starter.script:'';
      document.getElementById('readback').textContent='';state.lastXml='';showCode('');invalidateQuote();renderSettings();applyWorkflow();
      say(starter?'Starting '+starter.title+'. The starting point is ready to edit. Nothing has been generated.':'New blank project.');
      document.getElementById('script').focus();
    }
    document.getElementById('btnStarter').onclick=function(){var s=starters.find(function(s){return s.id===document.getElementById('starter').value;});if(s)newProject(s);};
    document.getElementById('btnBlank').onclick=function(){newProject(null);};
    document.getElementById('btnScriptFile').onclick=function(){
      var url=URL.createObjectURL(new Blob([document.getElementById('script').value],{type:'text/plain;charset=utf-8'}));
      var a=document.createElement('a');a.href=url;a.download=state.engine==='lyria'?'music-direction.txt':'sound-booth-script.txt';a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);
      say(state.engine==='lyria'?'Music direction downloaded.':'Script downloaded as text.');
    };
    setEngine('scenema'); setMode('easy'); setInput('words');
    loadLibrary();
    say('Ready. ' + state.guide.chooser.answer);
  })();
  </script>
<script src="/assets/soundbooth/workbench.js"></script>
</body></html>`;

module.exports = { soundBoothHtml };

