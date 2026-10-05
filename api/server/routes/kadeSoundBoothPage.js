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
/* Sep 25 2026: the three-box paste splitter, as source text, so the page runs
 * the very functions the server runs (see kadeSoundBoothPaste.js). Spliced in
 * by interpolation, so none of it passes through this file's template-literal
 * escaping. */
const { PAGE_SOURCE: SONG_PASTE_SOURCE } = require('./kadeSoundBoothPaste');

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
  select[disabled] { opacity:.55; cursor:default; }
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
  <p class="muted">Make speech with AuK, music with Lyria or YuE2, sounds with Stable Audio, or a scene with Seed Audio. Each engine keeps its own draft.</p>

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
    <details id="starterDrawer"><summary>Starting points and fresh drafts</summary><fieldset id="starterPanel"><legend>Start something</legend>
      <label class="field" for="starter" id="starterLabel">A starting script</label>
      <select id="starter"><option value="">Choose a starting point</option></select>
      <button type="button" class="act quiet" id="btnStarter">Use this starting point</button>
      <button type="button" class="act quiet" id="btnBlank">New blank draft</button>
      <p class="hint" id="starterHint">Free to load, and nothing is made until you generate. Loading one replaces your current draft.</p>
    </fieldset>


    </details>
    <details id="writingDrawer"><summary>Writing desk: ideas, exact words, and formatting</summary>
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

    </details>
    <details id="settingsDrawer"><summary>Voice, references, and all settings</summary>
    <fieldset id="settingsPanel"><legend id="settingsLegend">Voice and sound</legend>
      <div id="settings"></div>

      <div id="moodPanel"><label class="field" for="mood">Performance mood</label>
      <p class="hint">A note to the actor about what they feel. It is never spoken.</p>
      <select id="mood"><option value="">No particular mood</option></select></div>
      <div id="moreSettings"></div>

    </fieldset>

    </details>
    <fieldset id="editorPanel">
      <legend id="editorLegend">The script</legend>
      <p class="hint" id="scriptHint">Write only the words to perform. For sound effects, use Seed Audio.</p>
      <label class="field" for="trackTitle">Track title</label><input type="text" id="trackTitle" maxlength="80" aria-describedby="trackTitleHint"><p class="hint" id="trackTitleHint">Optional. A song draft fills an empty title with the writer's title. Your own title is kept. Other recordings use the first few words when left blank.</p>
      <label class="field" for="script" id="editorLabel">Script</label>
      <textarea id="script" aria-describedby="scriptHint" spellcheck="false"></textarea>
      <div class="quick-actions" role="group" aria-label="Writing help" id="quickWriting">
        <button type="button" class="act" id="btnDraft">Help write this</button>
        <button type="button" class="act quiet" id="btnInspire"><span aria-hidden="true">&#127922; </span>Surprise me</button>
        <button type="button" class="act quiet" id="btnUndoWriting" hidden>Undo writing change</button>
        <button type="button" class="act quiet" id="btnThink" aria-label="Writing thought: Auto" aria-describedby="writingThinkHint">Think: Auto</button>
      </div>
      <p class="hint" id="quickWritingHint">Neither button makes audio. Drafts and song ideas use the writing model; Surprise me is free for other ideas.</p>
      <p class="hint" id="writingThinkHint">Auto chooses up to Medium thought. Low is quicker; Medium develops the writing longer; High gives the lyric writer more room to reason and can take longer. Song length follows your idea.</p>
      <details id="codeBox" hidden><summary>Show the engine's code for this script</summary><pre class="script" id="codeView" aria-label="The engine code, read only"></pre></details>
      <p id="readback" class="hint"></p>
      <div id="renderActions">
        <button type="button" class="act quiet" id="btnPreview" hidden>Hear this voice first (short paid preview)</button>
        <button type="button" class="act quiet" id="btnNewVoice" hidden>Cast a different voice</button>
        <button type="button" class="act primary" id="btnRender">Render</button>
        <button type="button" class="act" id="btnCancel" hidden>Stop this render</button>
      </div>
      <p class="hint" id="renderHint">Generation starts with one press. Cost information is shown here before you start.</p>
      <dialog id="renderFailure" role="alertdialog" aria-labelledby="renderFailureTitle" aria-describedby="renderFailureMessage">
        <h2 id="renderFailureTitle">Generation stopped</h2>
        <p id="renderFailureMessage"></p>
        <button type="button" class="act" id="btnFailureOK" aria-describedby="renderFailureMessage">OK</button>
      </dialog>
    </fieldset>

    <div id="draftTransfer" role="group" aria-label="Copy current draft">
      <label for="copyEngine">Try this draft in</label><select id="copyEngine" aria-describedby="copyHint"></select>
      <button type="button" class="act quiet" id="btnCopyDraft">Copy and open</button>
      <button type="button" class="act quiet" id="btnUndoCopy" hidden>Restore previous draft in this tab</button>
      <p class="hint" id="copyHint">Copy the current idea, script, lyrics and compatible references. Free; no project is saved and no audio is generated. Your source draft stays in its tab.</p>
    </div>
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
        <div id="mixResult" hidden><audio id="mixPlayer" controls aria-label="Finished local mix"></audio><p><a id="mixDownload" download="sound-booth-mix.wav">Download the mix as WAV</a></p><button type="button" class="act quiet" id="mixUse">Use mix as reference in current engine (uploads)</button><p class="hint">Choose AuK, Seed Audio or YuE2 first. Reference uploads accept up to 20 MB; trim a shorter mix if needed.</p></div>
      </form>
    </details>

    <details id="recentDrawer"><summary>Recent work and recordings</summary>
    <p class="hint">Generation attempts are grouped here so you can reopen a script or compare takes. You do not need to organize projects to use the booth. Saved recordings stay in My Creations until you delete them there.</p>
    <label><input type="checkbox" id="showFailed"> Show failed and stopped attempts without audio</label>
    <div id="library" aria-live="off"><p class="muted">Nothing here yet.</p></div>
    </details>
  </main>

  <footer class="muted">Finished audio also lands in <a href="/my-creations">My Creations</a>, where it can be downloaded and shared. &mdash; &copy; 2026 Kade Murdock &middot; Kade-AI</footer>

  <script>
  (async function(){
    var status = document.getElementById('status');
    var app = document.getElementById('app');
    var token = null; try { token = await getToken(); } catch(e) {}
    if(!token){ status.className='status err'; status.textContent='Please sign in at the chat site first, then reload this page.'; return; }

    var drafts = {}, copyUndo = {};
    var state = { importError:'', quoteRevision:0, titleRevision:0, engine:'scenema', mode:'easy', pendingRender:null, jobId:null, projectId:null, poll:null, guide:null, clips:[], values:{}, lastWait:null, cancelArmed:null, voiceSeed:null, rerollVoice:false };
    var writingThink='auto';try{var savedThink=localStorage.getItem('kadeSoundBoothThinkMode');if(['auto','low','medium','high'].indexOf(savedThink)>=0)writingThink=savedThink;}catch(e){}
    function nextWritingThink(mode){var modes=['auto','low','medium','high'];return modes[(modes.indexOf(mode)+1)%modes.length];}
    function showWritingThink(){state.writingThink=writingThink;var label='Writing thought: '+writingThink.charAt(0).toUpperCase()+writingThink.slice(1),button=document.getElementById('btnThink');button.textContent=label.replace('Writing thought','Think');button.setAttribute('aria-label',label);button.title=label;button.disabled=!!state.writing;}
    document.getElementById('btnThink').onclick=function(){if(busy())return;writingThink=nextWritingThink(writingThink);try{localStorage.setItem('kadeSoundBoothThinkMode',writingThink);}catch(e){}showWritingThink();say('Writing thought: '+writingThink.charAt(0).toUpperCase()+writingThink.slice(1)+'.');};
    showWritingThink();
    function say(msg, isErr){ status.className = 'status' + (isErr ? ' err' : ''); status.textContent = msg; }
    function showCode(xml){ var box = document.getElementById('codeBox'); var view = document.getElementById('codeView'); if(!box||!view) return; if(state.engine==='scenema' && xml && /<speak/i.test(xml) && state.mode==='advanced'){ view.textContent = xml; box.hidden = false; } else { box.hidden = true; view.textContent=''; } }
    function esc(s){ var d=document.createElement('div'); d.textContent = s==null?'':s; return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    async function request(path, body, method){
      try {
        var r = await fetch(path, {method:method || (body === undefined ? 'GET':'POST'), headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'}, body:body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(240000)});
        var j = null; try { j = await r.json(); } catch(e) {}
        return {ok:r.ok,status:r.status,data:j||{}};
      } catch(e) { return {ok:false,status:0,data:{error:'Connection lost. Check the library before retrying a render; it may still be working.'}}; }
    }
    function post(path, body){ return request(path,body||{}); }
    function get(path){ return request(path); }
    function renderLabel(){ if(state.engine==='scenema' && state.values.auk_task==='edit') return 'Edit recording'; if(isUpload()) return uploadUi().render||'Render'; return state.engine==='stable' ? 'Generate sounds' : (state.engine==='lyria'||state.engine==='yue2') ? 'Make music' : state.engine==='seed' ? 'Generate scene' : 'Perform script'; }
    function busy(){ return state.rendering || state.jobId || state.writing || state.importing || state.copying; }
    /* Sep 27 2026: an engine whose guide entry says flow 'upload' has no script: the imported recording is the input. Only an
     * account the server gives one to ever has it (Sing it in my voice), and its words come from its guide entry. */
    function isUpload(e){ var g=state.guide&&state.guide.engines[e||state.engine]; return !!(g && g.flow==='upload'); }
    function uploadEngine(){ var ks=Object.keys((state.guide&&state.guide.engines)||{}).filter(function(k){ return isUpload(k); }); return ks[0]||null; }
    function uploadUi(e){ var g=state.guide.engines[e||state.engine]||{}; return g.ui||{}; }
    function focusWork(){ if(!isUpload()){ document.getElementById('script').focus(); return; } var pick=document.querySelector('#settings input[type=file]'); (pick && !pick.disabled ? pick : document.getElementById('btnRender')).focus(); }
    function invalidateQuote(event){ if(event&&event.target&&event.target.id==='trackTitle'){state.titleRevision++;return;}state.quoteRevision++; state.pendingRender=null; state.estimate=null; document.getElementById('btnRender').textContent=renderLabel(); }
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
    var engineOrder=['scenema','lyria','yue2','stable','seed'];
    Object.keys(state.guide.engines).forEach(function(k){ if(engineOrder.indexOf(k)<0) engineOrder.push(k); });
    engineOrder.forEach(function(k){
      var g = state.guide.engines[k];if(!g)return;
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
    var ENG_NAME = { seed:'Seed Audio', scenema:'AuK HQ', lyria:'Lyria', yue2:'YuE2', stable:'Stable Audio' };
    document.getElementById('chooserRules').innerHTML = ch.rules.map(function(r){ return '<li><strong>'+(ENG_NAME[r.pick]||(state.guide.engines[r.pick]||{}).name||r.pick)+'</strong> when '+esc(r.when)+'.</li>'; }).join('');

    document.getElementById('btnSuggest').onclick = async function(){
      if(busy())return;
      var sourceEngine=state.engine, revision=state.quoteRevision;
      var t = document.getElementById((state.engine==='lyria'||state.engine==='yue2')?'script':'text').value.trim();
      if(t.length < 3){ say('Type something in the box first, then I can suggest.', true); return; }
      var r = await post('/api/kade/sound-booth/suggest', {text:t});
      if(state.engine!==sourceEngine || state.quoteRevision!==revision || busy())return;
      if(!r.ok){ say('Could not suggest right now.', true); return; }
      var hasDraft=!!drafts[r.data.engine] || r.data.engine===state.engine;
      if(!setEngine(r.data.engine))return;
      if(!hasDraft){if((state.engine==='lyria'||state.engine==='yue2'))document.getElementById('script').value=t;else{document.getElementById('text').value=t;setInput('brief');}}
      say(r.data.reason + (r.data.sure ? '' : ' Change it if that is not what you meant.'));
    };

    function saveDraft(){
      drafts[state.engine]={title:document.getElementById('trackTitle').value,mode:state.mode,input:state.input,text:document.getElementById('text').value,script:document.getElementById('script').value,mood:document.getElementById('mood').value,readback:document.getElementById('readback').textContent,values:Object.assign({},state.values),clips:state.clips.slice(),importError:state.importError,projectId:state.projectId,voiceSeed:state.voiceSeed,rerollVoice:state.rerollVoice,lastXml:state.lastXml};
    }
    function copyDestinations(){
      var music=['lyria','yue2'], sound=['scenema','seed','stable'];
      return (music.indexOf(state.engine)>=0?music:sound.indexOf(state.engine)>=0?sound:[]).filter(function(e){return e!==state.engine && state.guide.engines[e];});
    }
    function showDraftTransfer(){
      var choices=copyDestinations(), select=document.getElementById('copyEngine');
      document.getElementById('draftTransfer').hidden=!choices.length;
      select.innerHTML=choices.map(function(e){return '<option value="'+esc(e)+'">'+esc(state.guide.engines[e].name)+'</option>';}).join('');
      document.getElementById('btnUndoCopy').hidden=!copyUndo[state.engine];
    }
    function applyCopiedDraft(draft, sourceClips){
      state.projectId=null;state.voiceSeed=null;state.rerollVoice=false;state.lastXml='';state.deskVoice=null;state.importError='';
      state.values=Object.assign({},draft.options||{});
      var urls=state.values.audio_urls || (state.values.reference_voice_url?[state.values.reference_voice_url]:[]);
      state.clips=urls.map(function(url,i){return sourceClips.find(function(c){return c.url===url;})||{url:url,name:'Copied reference '+(i+1)};});
      document.getElementById('trackTitle').value=draft.title||'';document.getElementById('text').value=draft.sourceText||'';
      document.getElementById('script').value=draft.script||'';document.getElementById('readback').textContent='';document.getElementById('mood').value='';
      state.input=draft.sourceText?'brief':'words';setMode('easy');setInput(state.input);invalidateQuote();showCode('');
      document.getElementById('settingsDrawer').open=!!(state.values.lyrics||state.clips.length);
      showDraftTransfer();focusWork();
    }
    document.getElementById('btnCopyDraft').onclick=async function(){
      if(busy())return;
      var to=document.getElementById('copyEngine').value, from=state.engine, revision=state.quoteRevision;
      saveDraft();var source=drafts[from], clips=source.clips.slice();
      var options=Object.assign({},state.values,collect());
      if(!source.script.trim()&&!source.text.trim()&&!String(options.lyrics||'').trim()&&!clips.length){say('Add an idea, script, lyrics or a recording to copy first.',true);return;}
      state.copying=true;this.disabled=true;updateRenderControls();
      var result=await post('/api/kade/sound-booth/carry',{engine:to,draft:{engine:from,title:source.title,sourceText:source.text,script:source.script,mode:source.mode,options:options}});
      state.copying=false;this.disabled=false;updateRenderControls();
      if(state.engine!==from||state.quoteRevision!==revision){say('Your draft changed while copying. Copy it again to include those changes.',true);return;}
      if(!result.ok||!result.data.draft){say(result.data.error||'Could not copy this draft.',true);return;}
      copyUndo[to]=drafts[to]||{values:{},clips:[]};
      if(!setEngine(to,true))return;
      applyCopiedDraft(result.data.draft,clips);
      say('Copied to '+state.guide.engines[to].name+'. '+(result.data.notes||[]).join(' ')+' Nothing was generated or saved. Restore previous draft brings back what was in this tab.');
    };
    document.getElementById('btnUndoCopy').onclick=function(){
      if(busy()||!copyUndo[state.engine])return;
      var engine=state.engine, previous=copyUndo[engine];delete copyUndo[engine];
      drafts[engine]=previous;state.engine='';setEngine(engine,true);
      say('Previous draft restored in '+state.guide.engines[engine].name+'.');focusWork();
    };
    function setEngine(e, quiet){
      if(busy()){say('Finish the current operation or stop the render before switching workspaces.',true);return false;}
      if(e!==state.engine){
        if(state.engine)saveDraft();
        var d=drafts[e]||{};state.engine=e;
        state.mode=d.mode||'easy';state.input=d.input||'words';state.values=Object.assign({},d.values||{});state.clips=(d.clips||[]).slice();state.importError=d.importError||'';state.projectId=d.projectId||null;state.voiceSeed=d.voiceSeed;state.rerollVoice=!!d.rerollVoice;state.lastXml=d.lastXml||'';
        document.getElementById('trackTitle').value=d.title||'';document.getElementById('text').value=d.text||'';document.getElementById('script').value=d.script||'';document.getElementById('mood').value=d.mood||'';document.getElementById('readback').textContent=d.readback||'';
      }
      state.engine = e;
      showDraftTransfer();
      document.getElementById('btnUndoWriting').hidden=!writingUndo || writingUndo.engine!==e;
      Array.prototype.forEach.call(engBox.children, function(c){ c.setAttribute('aria-pressed', c.dataset.engine===e); });
      var g = state.guide.engines[e];
      document.querySelector('#howto summary').textContent = (isUpload(e) ? 'How to use ' : 'How to write for ') + g.name;
      document.getElementById('howtoList').innerHTML = g.howToWrite.map(function(x){ return '<li>'+esc(x)+'</li>'; }).join('');
      document.getElementById('btnPreview').hidden = (e !== 'scenema');
      document.getElementById('btnNewVoice').hidden = (e !== 'scenema');
      invalidateQuote();setMode(state.mode);setInput(state.input||'words');applyWorkflow();showCode(state.lastXml);
      if(isUpload(e)){ document.getElementById('settingsDrawer').open=true; if(!quiet) say(uploadUi(e).select||g.name); if(state.clips.length) quoteUpload(); return true; }
      say(g.name+'. '+(e==='lyria'?'Describe your music, add optional lyrics, then choose Make music.':e==='yue2'?'Describe the style, add lyrics, then choose Make music.':e==='stable'?'Describe your sounds, then choose Generate sounds.':e==='seed'?'Build a scene with dialogue, sounds and up to three reference voices.':'Write a performance and direct its voice.'));return true;
    }
    function updateRenderControls(){
      var blocked=!!(state.importing || state.importError || state.writing || state.rendering || state.jobId || state.copying);
      document.getElementById('btnRender').disabled=blocked;
      document.getElementById('btnPreview').disabled=blocked;
      document.getElementById('btnThink').disabled=!!busy();
    }
    function referenceReady(){
      if(state.importing){say('Wait for the reference clip to finish importing.',true);return false;}
      if(state.importError){say('The reference import failed. Retry it or choose Discard failed import before generating.',true);return false;}
      return true;
    }
    function applyWorkflow(){
      updateRenderControls();
      var music=(state.engine==='lyria'||state.engine==='yue2'), scene=state.engine==='seed', effects=state.engine==='stable', upload=isUpload(), editing=state.engine==='scenema'&&state.values.auk_task==='edit';
      var g=state.guide.engines[state.engine];
      document.getElementById('renderHint').textContent=g.cost + ' Generation starts with one press.';
      document.getElementById('btnRender').setAttribute('aria-describedby','renderHint');
      document.getElementById('engineSummary').textContent=g.tagline;
      document.querySelector('#engineDetails summary').textContent='About '+g.name;
      document.getElementById('engineWhere').textContent=g.where;document.getElementById('engineCost').textContent=g.cost;
      document.getElementById('engineBest').textContent='Best for: '+g.bestFor.join('; ')+'.';document.getElementById('engineNotFor').textContent='Not for: '+g.notFor.join('; ')+'.';
      document.getElementById('engineDetails').open=false;
      document.getElementById('starterDrawer').before(document.getElementById('editorPanel'));
      document.getElementById('renderActions').before(document.getElementById('settingsDrawer'));
      document.querySelector('#settingsDrawer summary').textContent=effects?'Sound settings':music?'Lyrics and song settings':scene?'Voices, references, and scene settings':'Voice, reference recording, and performance settings';
      document.getElementById('btnDraft').textContent=state.engine==='yue2'?'Write my song idea':music?'Shape my music idea':'Write a script from this';
      document.getElementById('writingDrawer').hidden=music||effects||upload;
      document.getElementById('writingPanel').hidden=music||effects||upload;
      document.getElementById('modePanel').hidden=music||effects||upload;
      document.getElementById('moodPanel').hidden=music||effects||upload;
      ['editorLabel','script','quickWriting','quickWritingHint','readback','btnScriptFile','starterDrawer'].forEach(function(id){ document.getElementById(id).hidden=upload; });
      if(upload) document.getElementById('codeBox').hidden=true;
      document.getElementById('writingLegend').textContent=scene?'Build your scene':'Prepare the performance';
      document.getElementById('settingsLegend').textContent=effects?'Sound options':music?'Song options':scene?'Voices and scene sound':'Voice and performance';
      document.getElementById('editorLegend').textContent=effects?'Describe your sounds':music?'Describe your music':scene?'Scene script':'Performance script';
      document.getElementById('editorLabel').textContent=effects?'Sound description':music?'Music direction':scene?'Scene script':'Performance script';
      document.getElementById('scriptHint').textContent=music?'Describe the genre, instruments, mood, voice, shape and length. Exact words to sing go in Your own lyrics.':scene?'Describe the setting, sounds and each voice, with the exact lines. Imported voices are @Audio1 to @Audio3.':'Write only the words to perform. For sound effects, use Seed Audio.';
      document.getElementById('script').setAttribute('aria-label',effects?'Sound description':music?'Music direction':scene?'Scene script':'Performance script');
      document.getElementById('btnScriptFile').textContent=music?'Download direction and lyrics':'Download this script as text';
      document.getElementById('starterLabel').textContent=effects?'A sound starting point':music?'A music starting point':scene?'A scene starting point':'A performance starting point';
      if(state.engine==='yue2')document.getElementById('scriptHint').textContent='Describe the style and singing voice. Lyrics and any song to cover go in song settings; Write my song idea drafts the direction and the lyrics.';
      document.getElementById('quickWriting').hidden=effects||upload;document.getElementById('quickWritingHint').hidden=effects||upload;
      if(effects)document.getElementById('scriptHint').textContent='Describe the main sound, then quieter layers and the space around them. Say no speech or music if you want neither.';
      if(editing){
        ['editorLabel','script','quickWriting','quickWritingHint','readback','btnScriptFile','writingDrawer','moodPanel','btnPreview','btnNewVoice','codeBox'].forEach(function(id){document.getElementById(id).hidden=true;});
        document.getElementById('editorLegend').textContent='Edit a recording';
        document.getElementById('scriptHint').textContent='Import the recording and describe the change below. Select a short time range for a precise word or lyric edit; audio outside it is kept.';
        document.querySelector('#settingsDrawer summary').textContent='Recording and edit instructions';
        document.getElementById('settingsDrawer').open=true;
      } else if(state.engine==='scenema'){
        document.getElementById('btnPreview').hidden=false;document.getElementById('btnNewVoice').hidden=false;
      }
      if(upload){
        document.getElementById('editorLegend').textContent=g.name;
        document.getElementById('scriptHint').textContent=g.tagline;
        document.querySelector('#settingsDrawer summary').textContent=(g.settings[0]&&g.settings[0].label||'Recording')+' and settings';
        document.getElementById('settingsLegend').textContent=g.name;
      }
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
        : 'Advanced: edit the script yourself, with the engine code shown under it.';
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
      if((state.engine!=='lyria'&&state.engine!=='yue2'&&state.engine!=='stable')) say(m.boxLabel + '. ' + m.boxHint);
    }

    /* ---- settings, from the guide: only what THIS engine has ---- */
    /* Part 296, her ask (Sep 27 2026): the booth was "super wordy and cluttered". A setting the
     * guide marks advanced (seed, steps, pace and the like) goes inside ONE collapsed group,
     * "More settings", after everything else in the panel: a real details disclosure, so it reads
     * as collapsed or expanded, and nothing in it is hidden for good. A Family feature pack
     * setting stays greyed out wherever it sits. The group remembers being opened per engine,
     * because every re-render rebuilds it. A slider's number beside it is aria-hidden: the slider
     * already says its value, and an output element is a live region that said it twice. */
    var moreOpen = {};
    function settingField(s){
        var id = 'set_'+s.key, v = state.values[s.key];
        var head = '<label class="field" for="'+id+'">'+esc(s.label)+'</label><p class="hint" id="'+id+'_h">'+esc(s.hint)+'</p>';
        if(s.key==='lyrics'||s.key==='instruction') return head+'<textarea id="'+id+'" data-key="'+s.key+'" aria-describedby="'+id+'_h" rows="8">'+esc(v||'')+'</textarea>';
        if(s.kind==='text') return head+'<input type="text" id="'+id+'" data-key="'+s.key+'" aria-describedby="'+id+'_h" value="'+esc(v||'')+'">';
        if(s.kind==='range') return head+'<input type="range" id="'+id+'" data-key="'+s.key+'" min="'+s.min+'" max="'+s.max+'" step="'+(s.step||1)+'" aria-describedby="'+id+'_h" value="'+(v!=null?esc(v):s.default)+'"><output id="'+id+'_value" for="'+id+'" aria-hidden="true">'+(v!=null?esc(v):s.default)+'</output>';
        if(s.kind==='number') return head+'<input type="number" id="'+id+'" data-key="'+s.key+'" aria-describedby="'+id+'_h" step="'+(s.step||'any')+'"'+(s.min!=null?' min="'+s.min+'"':'')+(s.max!=null?' max="'+s.max+'"':'')+' placeholder="'+(s.default!=null?esc('normal is '+s.default):'leave empty')+'" value="'+(v!=null?esc(v):'')+'">';
        if(s.kind==='toggle') return '<label class="field"><input type="checkbox" id="'+id+'" data-key="'+s.key+'"'+(((v!=null)?v:s.default)?' checked':'')+' aria-describedby="'+id+'_h"> '+esc(s.label)+'</label><p class="hint" id="'+id+'_h">'+esc(s.hint)+'</p>';
        /* Part 295: a Family feature pack choice outside the pack (the YuE2 Style) comes with
         * locked. It is shown greyed out, never hidden: its label, every option and a hint that
         * says "Part of the Family feature pack" (the server wrote that sentence), the select
         * disabled on its default, and collect() never sends it. */
        if(s.kind==='choice'){
          var locked=!!s.locked, chosen=locked?s.default:(v!=null?v:s.default);
          var choiceHead=locked?'<label class="field" for="'+id+'">'+esc(s.label)+'</label><p class="hint locked" id="'+id+'_h">'+esc(s.hint)+'</p>':head;
          return choiceHead+'<select id="'+id+'" data-key="'+s.key+'" aria-describedby="'+id+'_h"'+(locked?' disabled':'')+'>'+s.options.map(function(o){ var lab = o===''?'None':o.replace(/_/g,' '); return '<option value="'+esc(o)+'"'+(chosen===o?' selected':'')+'>'+esc(lab.charAt(0).toUpperCase()+lab.slice(1))+'</option>'; }).join('')+'</select>';
        }
        if(s.kind==='clip'){
          /* Explicit extensions, not audio/* — a .ogg is typed video/ogg or
           * application/ogg as often as audio/ogg, so a wildcard filter can
           * hide the file she is trying to pick. And each clip gets a PLAYER,
           * her ask: hearing what is attached is the only way to know. */
          var accept = isUpload() ? '.wav,.mp3,.m4a,.ogg,.flac,audio/*' : (state.engine==='seed'||state.engine==='yue2') ? '.wav,.mp3,.m4a,.ogg,audio/*' : '.wav,.mp3,.m4a,audio/*';
          var list = state.clips.slice(0, s.max).map(function(c,i){
            var covering = state.engine==='yue2' && s.max===1;
            return '<li>'+(s.max>1?'@Audio'+(i+1)+': ':covering?'Covering: ':isUpload()?(uploadUi().clip||''):'')+esc(c.name)+((covering||isUpload())&&c.seconds?' ('+clock(c.seconds)+')':'')+
              '<audio controls preload="none" aria-label="Play the imported clip, '+esc(c.name)+'"><source src="'+esc(c.url)+'"></audio>'+
              '<button type="button" class="act quiet" data-rmclip="'+i+'">Remove '+esc(c.name)+'</button></li>';
          }).join('');
          return head+'<input type="file" id="'+id+'" accept="'+accept+'" aria-describedby="'+id+'_h"'+(state.importing || state.rendering || state.jobId || state.clips.length>=s.max?' disabled':'')+'>'+linkField(s,id)+'<ul class="clips">'+list+'</ul>';
        }
        return '';
    }
    function renderSettings(){
      var g = state.guide.engines[state.engine], engine = state.engine;
      var box = document.getElementById('settings'), more = document.getElementById('moreSettings'), panel = document.getElementById('settingsPanel');
      var show = g.settings.filter(function(s){
        if(state.engine==='scenema'){
          var editing=state.values.auk_task==='edit';
          if(!editing&&['instruction','edit_start','edit_end','gen_seconds'].indexOf(s.key)>=0)return false;
          if(editing&&['voice_description','pace'].indexOf(s.key)>=0)return false;
        }
        if((state.engine==='lyria'||state.engine==='yue2') && state.values.instrumental && (s.key==='lyrics'||s.key==='keep_lyrics')) return false; return true;
      });
      var advanced = show.filter(function(s){ return !!s.advanced; });
      box.innerHTML = show.filter(function(s){ return !s.advanced; }).map(settingField).join('') + '<div id="settingsExtras"></div>';
      more.innerHTML = advanced.length ? '<details id="moreSettingsGroup"'+(moreOpen[engine]?' open':'')+'><summary>More settings</summary>'+advanced.map(settingField).join('')+'</details>' : '';
      var group = document.getElementById('moreSettingsGroup');
      if(group) group.addEventListener('toggle', function(){ moreOpen[engine] = group.open; });
      var extras = document.getElementById('settingsExtras');
      if(state.engine==='yue2' && state.clips.length){
        extras.insertAdjacentHTML('beforeend','<button type="button" class="act" id="btnLyrics">Transcribe reference lyrics</button><p class="hint">Free. Drafts the sung words into Lyrics for you to check, since singing is often misheard; Undo writing change brings back your lyrics.</p>');
        document.getElementById('btnLyrics').disabled=busy();
        document.getElementById('btnLyrics').onclick=transcribeLyrics;
      }
      if(state.importError){
        extras.insertAdjacentHTML('beforeend','<p role="alert">'+esc(state.importError)+' Retry the import or discard this failed attempt before generating.</p><button type="button" class="act quiet" id="discardImport">Discard failed import</button>');
        document.getElementById('discardImport').onclick=function(){state.importError='';invalidateQuote();renderSettings();say('Failed import discarded. Review the attached clips before generating.');};
      }
      updateRenderControls();
      if(g.recipes && g.recipes.length){
        extras.insertAdjacentHTML('beforeend','<details><summary>Voice design and editing ideas</summary><p>Each one fills in an example to edit. Nothing is made or charged.</p>'+g.recipes.map(function(r,i){return '<button type="button" class="act quiet" data-recipe="'+i+'">'+esc(r.label)+'</button>';}).join('')+'</details>');
        Array.prototype.forEach.call(extras.querySelectorAll('[data-recipe]'),function(button){button.onclick=function(){
          if(busy())return;
          var recipe=g.recipes[Number(button.dataset.recipe)];
          state.values.auk_task=recipe.task;
          if(recipe.task==='speech')state.clips=[];
          var key=recipe.task==='speech'?'voice_description':'instruction';
          state.values[key]=recipe.text; invalidateQuote(); renderSettings();
          document.getElementById('set_'+key).focus();
          say('Example filled in. Edit it to suit your idea. No generation started.');
        };});
      }
      /* Handlers over the whole panel: a setting may sit in More settings. */
      Array.prototype.forEach.call(panel.querySelectorAll('[data-key]'), function(el){
        if(state.transcribing && el.dataset.key==='lyrics')el.disabled=true;
        el.oninput = el.onchange = function(){ state.values[el.dataset.key] = (el.type==='checkbox') ? el.checked : el.value; var output=document.getElementById(el.id+'_value');if(output)output.textContent=el.value; invalidateQuote(); if(el.dataset.key==='instrumental'||el.dataset.key==='auk_task'){renderSettings();document.getElementById(el.id).focus();} if(isUpload() && el.dataset.key==='voice_source' && state.clips.length) quoteUpload(); };
      });
      Array.prototype.forEach.call(panel.querySelectorAll('input[type=file]'), function(el){
        el.onchange = function(){ if(el.files && el.files[0]) importClip(el.files[0]); };
      });
      var linkBox = document.getElementById('set_reference_voice_url_link');
      if(linkBox){
        linkBox.oninput = function(){ state.linkDraft = linkBox.value; };
        linkBox.onkeydown = function(e){ if(e.key==='Enter'){ e.preventDefault(); importLink(); } };
        document.getElementById('btnLinkImport').onclick = importLink;
      }
      Array.prototype.forEach.call(panel.querySelectorAll('[data-rmclip]'), function(btn){
        btn.onclick = function(){ if(busy())return; invalidateQuote();state.clips.splice(parseInt(btn.dataset.rmclip,10),1); say('Clip removed.'); renderSettings(); };
      });
      applyWorkflow();
    }

    async function transcribeLyrics(){
      if(busy() || !referenceReady() || !state.clips.length)return;
      var sourceEngine=state.engine,reference=state.clips[0].url;
      writingUndo={engine:state.engine,text:document.getElementById('script').value,lyrics:state.values.lyrics||''};
      state.transcribing=true;state.writing=true;renderSettings();say('Listening for the sung words. Your current lyrics are kept until the draft is ready.');
      var result=await post('/api/kade/sound-booth/reference/lyrics',{url:reference});
      state.transcribing=false;state.writing=false;
      if(state.engine!==sourceEngine || !state.clips.length || state.clips[0].url!==reference){renderSettings();return;}
      if(!result.ok){renderSettings();say(result.data.error||'Could not hear the words. Your lyrics are kept.',true);return;}
      state.values.lyrics=result.data.transcript;invalidateQuote();renderSettings();
      document.getElementById('btnUndoWriting').hidden=false;
      document.getElementById('set_lyrics').focus();say(result.data.warning);
    }
    async function importClip(file){
      if(busy())return;
      invalidateQuote();state.importError='';
      if(file.size > 20*1024*1024){state.importError='That clip is over twenty megabytes.';renderSettings();say(state.importError,true);return;}
      state.importing=true;renderSettings();
      try {
        say('Importing ' + file.name + '…');
        var fd = new FormData(); fd.append('clip', file, file.name); fd.append('engine', state.engine);
        var r = await fetch('/api/kade/sound-booth/reference', {method:'POST', headers:{'Authorization':'Bearer '+token}, body:fd, signal:AbortSignal.timeout(240000)});
        var j = null; try { j = await r.json(); } catch(e) {}
        if(!r.ok || !j || !j.url)throw new Error((j&&j.error)||'That clip could not be imported.');
        state.clips.push({url:j.url, name:j.name||file.name, seconds:j.seconds||null});
        say((j.spoken||'Clip imported.') + (state.engine==='seed' ? ' It is @Audio'+state.clips.length+'.' : ''));
      } catch(e){state.importError=e.message||'Could not import that clip.';say(state.importError,true);}
      finally {state.importing=false;invalidateQuote();renderSettings();if(isUpload()&&state.clips.length&&!state.importError)quoteUpload();}
    }
    window.addEventListener('soundbooth:use-mix',function(event){
      if(busy()){say('Finish the current operation before attaching the mix.',true);return;}
      var setting=state.guide.engines[state.engine].settings.find(function(s){return s.kind==='clip';});
      if(!setting){say('This engine does not accept recordings. Choose AuK, Seed Audio or YuE2, then use the mix.',true);return;}
      if(state.clips.length>=setting.max){say('Remove the current reference first, or choose another engine, before attaching the mix.',true);return;}
      document.getElementById('settingsDrawer').open=true;importClip(event.detail.file);
    });
    /* The price for this recording, asked of the server (the same estimate the render answers with) and shown by the button
     * before anything is spent. Nothing is said aloud, so it never talks over the import's own sentence. */
    async function quoteUpload(){
      if(!isUpload() || !state.clips.length) return;
      var engine=state.engine, revision=state.quoteRevision, body=collect(); body.estimateOnly=true;
      var r=await post('/api/kade/sound-booth/render', body);
      if(state.engine!==engine || state.quoteRevision!==revision) return;
      if(r.ok && r.data && r.data.estimate && r.data.estimate.spoken) document.getElementById('renderHint').textContent=r.data.estimate.spoken+' Generation starts with one press.';
    }

    /* Part 293: a media link (YouTube and other sites, or a direct audio file)
     * for a YuE2 cover. The field exists when the server's guide gives the cover
     * setting a link (usable) or a lockedLink. Without the Family feature
     * pack the guide sends only lockedLink and the field is GREYED OUT, never
     * hidden: the label, a disabled box and button, and a visible note ("Part of
     * the Family feature pack...") that both controls name as their description.
     * With the pack the
     * server brings in the sound and answers exactly as a file import does, plus
     * the song's title, length and site. Every result is said in the status line,
     * and focus stays on the import button while it works, returns to the link
     * after a failure, and moves to Transcribe reference lyrics after a success. */
    function clock(seconds){ var t=Math.round(Number(seconds)||0); var ss=t%60; return Math.floor(t/60)+':'+(ss<10?'0':'')+ss; }
    function focusById(id){ var el=document.getElementById(id); if(el) el.focus(); }
    function linkField(s, id){
      var locked=!s.link||s.link.available===false, field=s.link||s.lockedLink;
      if(!field || state.clips.length>=s.max) return '';
      var lid=id+'_link', off=(state.rendering||state.jobId)?' disabled':'', working=state.importing&&state.linkImporting;
      if(locked){
        return '<label class="field" for="'+lid+'">'+esc(field.label)+'</label><p class="hint locked" id="'+lid+'_lock">'+esc(lockedLinkNote(field))+'</p>'+
          '<input type="text" inputmode="url" id="'+lid+'" autocomplete="off" disabled aria-describedby="'+lid+'_lock">'+
          '<button type="button" class="act" id="btnLinkImport" disabled aria-describedby="'+lid+'_lock">'+esc(field.button)+'</button>';
      }
      return '<label class="field" for="'+lid+'">'+esc(s.link.label)+'</label><p class="hint" id="'+lid+'_h">'+esc(s.link.hint)+'</p>'+
        '<input type="text" inputmode="url" id="'+lid+'" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://" aria-describedby="'+lid+'_h" value="'+esc(state.linkDraft||'')+'"'+(working?' readonly':'')+off+'>'+
        '<button type="button" class="act" id="btnLinkImport"'+(working?' aria-disabled="true"':'')+off+'>'+(working?'Importing from the link…':esc(s.link.button))+'</button>';
    }
    function lockedLinkNote(field){ return ((field&&field.locked)||'Part of the Family feature pack')+'. Ask Kade to add it to your account.'; }
    async function importLink(){
      var box=document.getElementById('set_reference_voice_url_link');
      var setting=state.guide.engines[state.engine].settings.filter(function(s){return s.kind==='clip'&&(s.link||s.lockedLink);})[0];
      if(!box || !setting)return;
      if(!setting.link || setting.link.available===false){say(lockedLinkNote(setting.link||setting.lockedLink),true);return;}
      if(state.importing){say(state.linkImporting?'Still bringing in the song. This can take up to two minutes.':'Wait for the clip to finish importing.');return;}
      if(busy()){say('Finish the current operation before importing a reference.',true);return;}
      var link=box.value.trim();state.linkDraft=box.value;
      if(!link){say('Paste a media link first.',true);box.focus();return;}
      invalidateQuote();state.importError='';state.importing=true;state.linkImporting=true;renderSettings();focusById('btnLinkImport');
      say('Bringing in the sound from the link. This can take up to two minutes.');
      var r=await post(setting.link.path||'/api/kade/sound-booth/reference/link',{engine:state.engine,url:link});
      state.importing=false;state.linkImporting=false;
      if(!r.ok || !r.data || !r.data.url){
        state.importError=r.status===0?'The connection dropped while the song was coming in. Try again.':(r.data&&r.data.error)||'The song could not be brought in from that link.';
        invalidateQuote();renderSettings();say(state.importError,true);focusById('set_reference_voice_url_link');return;
      }
      var source=r.data.source||{};
      state.linkDraft='';
      state.clips.push({url:r.data.url,name:source.title||r.data.name||'Linked song',seconds:r.data.seconds||source.seconds||null});
      invalidateQuote();renderSettings();
      say(r.data.spoken||'Song imported from the link.');
      focusById('btnLyrics');
    }

    function collect(){
      var b = { title:document.getElementById('trackTitle').value.trim(), engine: state.engine, mode: state.mode, text: document.getElementById('text').value };
      var g = state.guide.engines[state.engine];
      g.settings.forEach(function(s){
        var v = state.values[s.key];
        if(s.kind==='clip' || s.locked) return;
        if(s.kind==='toggle'){ if(s.key==='validate'){ b.validate = (v===undefined || v===null) ? true : !!v; return; } b[s.key] = (v===undefined || v===null) ? !!s.default : !!v; return; }
        if(s.kind==='number'||s.kind==='range'){ var n = parseFloat(v); if(!isNaN(n)) b[s.key] = (s.key==='seed'||s.key==='pitch') ? Math.round(n) : n; return; }
        if(v!=null && String(v).trim()!=='') b[s.key] = v;
      });
      if((state.engine!=='lyria'&&state.engine!=='yue2'&&state.engine!=='stable'&&!isUpload()) && !b.gender) b.gender = 'female';
      if((state.engine==='lyria'||state.engine==='yue2') && b.instrumental){delete b.lyrics;delete b.keep_lyrics;}
      var mood = document.getElementById('mood').value; if(mood && (state.engine!=='lyria'&&state.engine!=='yue2'&&state.engine!=='stable'&&!isUpload())) b.mood = mood;
      /* Lyria clones nothing, so a clip left over from another engine must not
       * ride along with a music render. */
      if(state.clips.length && state.engine!=='lyria'){ b.referenceExpected=true; if(state.engine==='seed') b.audio_urls = state.clips.slice(0,3).map(function(c){return c.url;}); else b.reference_voice_url = state.clips[0].url; }
      if(state.engine==='seed' && b.audio_quality===true) b.audio_quality='high';
      if(b.audio_quality===true) b.audio_quality='high';
      return b;
    }

    async function makeScript(which){
      if((state.engine==='lyria'||state.engine==='yue2') || busy()) return;
      var b = forDesk(collect()); b.mode = which;
      if(!b.text || b.text.trim().length < 3){ say(which==='write' ? 'Say what you want made first.' : 'Type the words you want performed first.', true); document.getElementById('text').focus(); return; }
      state.writing=true;showWritingThink();document.getElementById('btnMake').disabled = true;
      say(which==='write' ? 'Writing it\\u2026' : 'Shaping your words\\u2026');
      var r = await post('/api/kade/sound-booth/script', b);
      state.writing=false;showWritingThink();document.getElementById('btnMake').disabled = false;
      if(!r.ok){ say(r.data.error || 'The script desk had trouble. Try again.', true); return; }
      /* Part 126: the person sees the screenplay; the engine's XML sits behind
       * a disclosure for anyone who wants it. Seed scripts are already prose. */
      document.getElementById('script').value = deskScript(r.data);
      var voiceLead = takeDeskVoice(r.data);
      state.lastXml = r.data.script || '';
      showCode(state.lastXml);
      document.getElementById('readback').textContent = r.data.readback || '';
      state.estimate = r.data.estimate || null;
      var parts = [];
      /* The mismatch question comes FIRST: it is the one thing that can make
       * everything after it wrong. */
      if(r.data.mismatch) parts.push(r.data.mismatch);
      if(voiceLead) parts.push(voiceLead);
      if(r.data.readback) parts.push(r.data.readback);
      if(r.data.estimate && r.data.estimate.spoken) parts.push(r.data.estimate.spoken);
      if(r.data.problem) parts.push('One thing to fix first: ' + r.data.problem);
      say(parts.join(' ') || 'Script ready.');
      document.getElementById('script').focus();
    }
    document.getElementById('btnMake').onclick = function(){ makeScript(state.input === 'brief' ? 'write' : 'format'); };
    /* Oct 2 2026, her report: "it writes things in the wrong places like voice descriptions".
     * An AuK draft comes back as the performance (directions in square brackets and spoken words)
     * and, apart from it, the voice it was written for. The script box gets the performance. The
     * voice goes in Describe a new voice only when that box is empty and no recording is attached
     * (a recording sets the voice by itself); a voice she typed is never replaced. A voice the
     * desk put there and she left alone is not held against the next idea: it is not sent as her
     * choice, and the next draft's voice replaces it. Other engines, and a server without these
     * fields, keep the screenplay as before. */
    function deskScript(data){ return data && typeof data.performance==='string' ? data.performance : (data && (data.screenplay || data.script)) || ''; }
    function deskVoiceUntouched(){ var v=String(state.values.voice_description||'').trim(); return !!v && v===state.deskVoice; }
    function forDesk(body){ body.thinkMode=state.writingThink||'auto';if(state.engine==='scenema' && deskVoiceUntouched()) delete body.voice_description; return body; }
    function takeDeskVoice(data, undoable){
      if(state.engine!=='scenema' || !data || !data.voice_description) return '';
      if((String(state.values.voice_description||'').trim() && !deskVoiceUntouched()) || state.clips.length) return '';
      if(undoable && writingUndo && writingUndo.engine==='scenema'){ writingUndo.voice=state.values.voice_description||''; writingUndo.deskVoice=state.deskVoice||null; }
      state.values.voice_description=data.voice_description; state.deskVoice=data.voice_description; renderSettings();
      return 'The voice it wrote for is now in Describe a new voice.';
    }
    function takeDeskTitle(data, originalTitle, titleRevision){
      var box=document.getElementById('trackTitle'), title=data&&typeof data.title==='string'?data.title.trim().slice(0,80):'';
      if((state.engine!=='lyria'&&state.engine!=='yue2') || state.titleRevision!==titleRevision || String(originalTitle||'').trim() || box.value.trim() || !title)return '';
      if(writingUndo){writingUndo.title=box.value;writingUndo.generatedTitle=title;}
      box.value=title;
      return 'Track title: '+title+'. ';
    }
    ${SONG_PASTE_SOURCE || ''}
    var writingUndo=null, writingLyrics;
    function changeWriting(value){
      var box=document.getElementById('script');
      writingUndo={engine:state.engine,text:box.value,lyrics:writingLyrics};writingLyrics=undefined;
      box.value=value;invalidateQuote();state.lastXml=null;showCode(null);
      document.getElementById('btnUndoWriting').hidden=false;box.focus();
    }
    /* Sep 25 2026: a Lyria draft is split the same way as a YuE2 one, so its
     * words land in Your own lyrics instead of inside the Music direction. An
     * instrumental has no Lyrics heading and stays whole; only YuE2 insists on
     * words. A pasted song (data.pasted) was sorted by the server, not written,
     * so a missing Lyrics Box is its problem to say, not the writer's, and its
     * Lyrics Box wins over the lyrics box. For Lyria her own words win over a
     * desk draft's copy of them (the server takes that copy out; this holds if
     * one slips through), so a desk's words only move into an empty Lyria box.
     * Whenever the lyrics box changes, she is told. Returns the direction for
     * the editor and what to say before "Draft ready". */
    function sortDraft(engine, data, result){
      var pastedDraft=!!data.pasted, lead='';
      if(engine==='yue2'||engine==='lyria'){
        var split=result.split(/\\nLyrics:\\s*/i);
        if(split.length<2){
          if(engine==='yue2'&&!pastedDraft&&!state.values.instrumental&&!/^instrumental/i.test(String(state.values.singing||'')))throw new Error('The writer did not provide separate lyrics. Your idea is kept; try again or add your lyrics in song settings.');
        } else {
          var deskWords=split.slice(1).join('\\n').trim(), mine=(state.values.lyrics||'').trim();
          result=split[0].trim();
          if(engine==='lyria'&&!pastedDraft&&mine){
            if(deskWords!==mine)lead='Your own lyrics were kept as you wrote them; the copy the desk put in its draft was left out. ';
          } else {
            writingLyrics=state.values.lyrics||'';state.values.lyrics=deskWords;renderSettings();
            if(!pastedDraft&&deskWords){
              var box=engine==='lyria'?'Your own lyrics':'Lyrics';
              if(!mine)lead='The words the desk wrote are now in '+box+', under Lyrics and song settings. ';
              else if(deskWords!==mine)lead=box+' now holds the desk version of your words; Undo brings back yours. ';
            }
          }
        }
      }
      if(data.note)lead+=data.note+' ';
      if(pastedDraft&&data.problem)lead+='One thing to fix first: '+data.problem+' ';
      return {result:result, lead:lead};
    }
    document.getElementById('btnUndoWriting').onclick=function(){
      if(busy() || !writingUndo || writingUndo.engine!==state.engine)return;
      document.getElementById('script').value=writingUndo.text;if(writingUndo.idea!==undefined){document.getElementById('text').value=writingUndo.idea;setInput(writingUndo.input||'words');}if(writingUndo.lyrics!==undefined){state.values.lyrics=writingUndo.lyrics;renderSettings();}if(writingUndo.voice!==undefined){state.values.voice_description=writingUndo.voice;state.deskVoice=writingUndo.deskVoice;renderSettings();}if(writingUndo.title!==undefined&&document.getElementById('trackTitle').value===writingUndo.generatedTitle)document.getElementById('trackTitle').value=writingUndo.title;writingUndo=null;
      this.hidden=true;invalidateQuote();document.getElementById('script').focus();say('Previous writing restored.');
    };
    document.getElementById('btnInspire').onclick=function(){
      if(busy())return;
      function pick(xs){return xs[crypto.getRandomValues(new Uint32Array(1))[0]%xs.length];}
      var place=pick(['a train leaving at midnight','a seaside town after the tourists leave','a kitchen during a thunderstorm','an old theatre before opening night','a road trip with no destination']);
      var turn=pick(['an unexpected reunion','a promise finally kept','a secret that changes everything','a small act of courage','finding something you thought was lost']);
      var idea=(state.engine==='lyria'||state.engine==='yue2')
        ? pick(['Soulful acoustic folk','Dreamy synth pop','Warm country soul','Intimate piano jazz','Driving indie rock'])+', about '+place+' and '+turn+'. A memorable chorus, expressive lead vocal, a quiet opening that builds to a full band, about four minutes.'
        : state.engine==='seed' ? 'A short scene at '+place+'. Two people discover '+turn+'. Include natural dialogue and the sounds around them.'
        : 'Write a short, vivid first-person story about '+place+' and '+turn+'. Give it a strong opening and a satisfying ending.';
      var song=(state.engine==='lyria'||state.engine==='yue2');
      if(!song){writingUndo={engine:state.engine,text:document.getElementById('script').value,idea:document.getElementById('text').value,input:state.input};document.getElementById('text').value=idea;setInput('brief');document.getElementById('writingDrawer').open=true;document.getElementById('btnUndoWriting').hidden=false;invalidateQuote();document.getElementById('text').focus();say('New idea in the writing desk. Your performance script is kept. Choose Write a script from this to draft it; Undo restores the previous idea.');return;}
      /* Part 228: for songs the writer invents the idea from sparks drawn on the
       * server. The list above is only what she gets if the writer cannot be reached. */
      var btn=this, label=btn.textContent, engine=state.engine, box=document.getElementById('script'), original=box.value;
      state.writing=true;btn.disabled=true;document.getElementById('btnDraft').disabled=true;updateRenderControls();
      say('Thinking up a new song idea.');
      /* Part 293: the Style rides along (Sep 27 2026: it no longer makes a pitch clean; the account decides).
       * Part 295 review: never a locked Style (outside the Family feature pack), which an opened
       * project can still hold in state.values; collect() never sends one either. */
      var styleOpen=engine==='yue2'&&!state.guide.engines.yue2.settings.some(function(s){return s.key==='band'&&s.locked;});
      post('/api/kade/sound-booth/idea',{band:styleOpen?state.values.band:undefined,thinkMode:writingThink}).then(function(r){
        if(state.engine!==engine || box.value!==original){say('Your editor changed while the idea was being made. Your current text is kept.',true);return;}
        if(r.ok&&r.data&&r.data.idea){changeWriting(r.data.idea);say('New song idea in the editor. Change it, press Surprise me again for another, or choose Help write this. Undo restores your previous writing.');}
        else {changeWriting(idea);say('The writer could not be reached, so this idea came from the short list. Change it or choose Help write this. Undo restores your previous writing.');}
      }).catch(function(){
        if(state.engine===engine && box.value===original){changeWriting(idea);say('The writer could not be reached, so this idea came from the short list. Undo restores your previous writing.');}
      }).then(function(){state.writing=false;btn.disabled=false;btn.textContent=label;document.getElementById('btnDraft').disabled=false;updateRenderControls();});
    };
    /* Part 218: the deep lane. The server takes the song draft as a job and the
     * page asks after it, so the writer can think for minutes. The job id is kept
     * in this browser so leaving the page and coming back finds the draft. */
    var DRAFT_KEY='kadeSoundBoothDraftJob';
    function draftJob(v){try{if(v===undefined)return localStorage.getItem(DRAFT_KEY)||'';if(v)localStorage.setItem(DRAFT_KEY,v);else localStorage.removeItem(DRAFT_KEY);}catch(e){}return '';}
    async function waitDraft(id){
      var misses=0, lastSaid=0;
      for(var i=0;i<100;i++){
        var g=await get('/api/kade/sound-booth/script/job/'+encodeURIComponent(id));
        if(g.status===404){draftJob('');return {ok:false,data:g.data};}
        if(!g.ok){misses++;if(misses>6)return {ok:false,data:{error:'Connection lost while waiting for the draft. Choose Help write this again to pick it back up.'}};}
        else if(g.data.state==='done'){draftJob('');return {ok:true,data:g.data.result||{}};}
        else if(g.data.state==='failed'){draftJob('');return {ok:false,data:{error:g.data.error}};}
        else {misses=0;var mins=Math.floor((g.data.seconds||0)/60);if(mins>lastSaid){lastSaid=mins;say('Still writing. '+mins+(mins===1?' minute':' minutes')+' so far.');}}
        await new Promise(function(done){setTimeout(done,8000);});
      }
      return {ok:false,data:{error:'The writer is taking far too long. Your idea is kept; try again.'}};
    }
    document.getElementById('btnDraft').onclick=async function(){
      if(busy())return;
      /* Part 219: one press. Coming back to the page picks the waiting draft up by
       * itself (see the resume below); nobody presses this twice. */
      var resume=this.getAttribute('data-resume')==='1';this.removeAttribute('data-resume');
      var box=document.getElementById('script'), original=box.value, originalTitle=document.getElementById('trackTitle').value, titleRevision=state.titleRevision;
      var idea=document.getElementById('text').value.trim();
      var text=state.input==='brief'&&state.engine!=='lyria'&&state.engine!=='yue2'&&idea?idea:original.trim()||idea;
      if(!resume&&text.length<3){say('Write an idea first, or choose Surprise me.',true);box.focus();return;}
      var engine=state.engine, revision=state.quoteRevision, body=forDesk(collect());body.text=text;body.mode='write';body.patient=true;
      var song=(engine==='lyria'||engine==='yue2'), deep=song;
      if(deep)body.background=true;
      if(resume)deep=true;
      var label=this.textContent;if(deep)this.textContent='Writing your song\u2026';
      state.writing=true;box.readOnly=true;this.disabled=true;
      showWritingThink();
      document.getElementById('btnInspire').disabled=true;updateRenderControls();
      say(resume ? 'Your song is still being written. The draft will appear here by itself when it is ready.' : deep ? 'Writing your song. The draft will appear here when it is ready. You can leave and come back; a notice arrives when it is ready, and this page picks it up on its own.' : 'Writing a draft from your idea.');
      try {
        var r=null, waiting=deep?draftJob().split('|')[0]:'';
        if(waiting){r=await waitDraft(waiting);if(!r.ok&&r.data&&/gone/i.test(r.data.error||'')&&!resume)r=null;}
        if(!r){
          r=await post('/api/kade/sound-booth/script',body);
          if(r.data&&r.data.job&&(r.status===202||r.status===409)){draftJob(r.data.job+'|'+engine);r=await waitDraft(r.data.job);}
        }
        if(!r.ok)throw new Error(r.data.error||'The writing desk could not finish. Your text is kept.');
        if(state.engine!==engine || box.value!==original || state.quoteRevision!==revision){say('Your editor or settings changed while the draft was being written. Your current text is kept.',true);return;}
        var result=deskScript(r.data);
        if(!result)throw new Error('The writing desk returned no draft. Your text is kept.');
        var sorted=sortDraft(engine,r.data,result);
        changeWriting(sorted.result);document.getElementById('readback').textContent=r.data.readback||'';
        var titleLead=takeDeskTitle(r.data,originalTitle,titleRevision);
        var voiceLead=takeDeskVoice(r.data,true);
        say(sorted.lead+titleLead+(voiceLead?voiceLead+' ':'')+'Draft ready in the editor. You can change it or undo. No audio has been generated.');
      } catch(e){say(e.message||'The writing desk could not finish. Your text is kept.',true);}
      finally {state.writing=false;box.readOnly=false;this.disabled=false;this.textContent=label;showWritingThink();document.getElementById('btnInspire').disabled=false;updateRenderControls();}
    };
    setTimeout(function(){
      var kept=draftJob().split('|');
      if(!kept[0]||busy())return;
      if((kept[1]==='lyria'||kept[1]==='yue2')&&state.engine!==kept[1]&&setEngine(kept[1])===false)return;
      var button=document.getElementById('btnDraft');button.setAttribute('data-resume','1');button.click();
    },800);

    document.getElementById('script').addEventListener('input', function(){ state.pendingRender=null; document.getElementById('btnRender').textContent=renderLabel(); });
    /* Sep 25 2026: a song pasted whole from ChatGPT (Lyrics Box, Tag Box,
     * Negative Tag Box) is sorted the moment it lands: the Tag Box becomes the
     * Music direction, the Lyrics Box goes to the lyrics box, and the negative
     * tags go nowhere, because neither music engine has a place for them. No
     * writer is asked, nothing is charged, and Undo puts back what was there.
     * It is caught in the lyrics box too, where "Paste words you have already
     * written" invites it. placeSongPaste (shared with the server) decides:
     * a Tag Box replaces the direction only when pasted into Music direction or
     * when the direction is empty, and a paste with no Tag Box keeps hers. */
    function sortPastedSong(e, field){
      if((state.engine!=='lyria'&&state.engine!=='yue2')||busy()||typeof splitSongPaste!=='function')return;
      var clip=e.clipboardData||window.clipboardData;var text=clip&&clip.getData?clip.getData('text'):'';
      var pasted=splitSongPaste(text);
      if(!pasted)return;
      e.preventDefault();
      var box=document.getElementById('script'), direction=box.value;
      var placed=placeSongPaste(pasted,{field:field,direction:direction,lyrics:state.values.lyrics||'',instrumental:!!state.values.instrumental,holdLyrics:true});
      writingLyrics=state.values.lyrics||'';
      state.values.lyrics=placed.lyrics;
      renderSettings();
      changeWriting(placed.script);
      if(placed.script!==direction)document.getElementById('readback').textContent='';
      state.pendingRender=null;document.getElementById('btnRender').textContent=renderLabel();
      if(field==='lyrics'){var words=document.getElementById('set_lyrics');if(words)words.focus();}
      say(placed.note+' Undo restores what was there. Nothing has been generated.');
    }
    document.getElementById('script').addEventListener('paste', function(e){ sortPastedSong(e,'script'); });
    document.getElementById('settings').addEventListener('paste', function(e){ if(e.target&&e.target.id==='set_lyrics')sortPastedSong(e,'lyrics'); });

    async function doRender(preview){
      if(state.writing || !referenceReady())return;
      if(state.rendering || state.jobId){ say('A render is already in progress. Wait for it or press Stop.', true); return; }
      state.rendering = true;updateRenderControls();
      document.getElementById('btnPreview').disabled = true;
      try {
      var script = document.getElementById('script').value.trim();
      var b = collect();
      if(!script && !preview && b.auk_task!=='edit' && !isUpload()){ say(state.engine==='stable'?'Describe your sounds first.':(state.engine==='lyria'||state.engine==='yue2')?'Describe the music you want first.':'There is nothing to render yet. Write a script first.', true); document.getElementById('script').focus(); return; }
      if(preview && !script && !b.voice_description){ say('Describe the voice first, or write a script, so there is a voice to preview.', true); return; }
      /* Part 122.1: this line used to invent a THIRD sample sentence ("Here is
       * how I sound."), different again from the two on the server, so what a
       * preview performed depended on which path fired. The server builds the
       * sample from her script now; the page sends an empty speak tag carrying
       * only the voice, and lets it decide. */
      b.script = isUpload() ? undefined : script || ('<speak voice="'+(b.voice_description||'A warm, clear adult voice.').replace(/"/g,'&quot;')+'" gender="'+(b.gender||'female')+'"></speak>');
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
      /* Review 1: a voice the desk filled in is hers once she renders with it, so the next
       * Help write this sends it as her choice and never swaps it for another. */
      state.deskVoice = null;
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
        /* Oct 2 2026: a Seed clip that was shortened on the way is said first (the answer's note). */
        say(r.data.spoken || (r.data.note ? r.data.note + ' ' : '') + 'Ready. ' + r.data.seconds + ' seconds of audio, about ' + Math.max(1, Math.round((r.data.costUSD||0)*100)) + ' cents. It is in your library below and in My Creations.');
        loadLibrary();
      }
      } finally { state.rendering=false;updateRenderControls(); }
    }
    var btnRender = document.getElementById('btnRender');
    document.getElementById('btnFailureOK').onclick=function(){document.getElementById('renderFailure').close();};
    async function confirmRender(preview){
      if(state.writing || !referenceReady())return;
      /* Part 295: an instrumental needs no words (Singing or instrumental, when the server offers it). */
      var sent=collect();
      if(isUpload() && !state.clips.length){ document.getElementById('settingsDrawer').open=true; var pick=document.querySelector('#settings input[type=file]'); if(pick) pick.focus(); say(uploadUi().needClip||'Import a recording first.',true); return; }
      if(state.engine==='yue2' && !sent.lyrics && String(sent.singing||'').trim().toLowerCase().indexOf('instrumental')!==0){document.getElementById('settingsDrawer').open=true;document.getElementById('set_lyrics').focus();say('Add the words to sing, or use Write my song idea to draft lyrics.',true);return;}
      return doRender(preview);
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
      state.jobId=null;updateRenderControls(); say(result.data.spoken || 'Stopped. Completed takes are kept. GPU time already used may still be charged.');
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
          stopPoll(); state.jobId = null;updateRenderControls(); state.lastWait = null; state.cancelArmed = null; document.getElementById('btnCancel').hidden = true;
          if(s === 'failed'){
            document.getElementById('showFailed').checked=true;
            document.getElementById('recentDrawer').open=true;
            document.getElementById('renderFailureMessage').textContent=r.data.error || r.data.spoken || 'No finished recording was returned. Your saved attempt remains in the library.';
            document.getElementById('renderFailure').showModal();
            document.getElementById('btnFailureOK').focus();
          }
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
        var upload = isUpload(p.engine), ue = uploadEngine(), eg = state.guide.engines[p.engine] || {};
        var aukEdit = p.engine === 'scenema' && !!p.options && p.options.auk_task === 'edit';
        var engine = upload ? eg.name : p.engine === 'stable' ? 'Stable Audio' : p.engine === 'yue2' ? 'YuE2' : p.engine === 'lyria' ? 'Lyria' : p.engine === 'seed' ? 'Seed Audio' : 'AuK HQ';
        var stateWord = p.state === 'done' ? 'finished' : p.state;
        return '<div class="proj"><h3>' + esc(p.title) + '</h3>' +
          '<p class="hint">' + esc(p.why || engine) + ' \\u00b7 ' + esc(stateWord) + ' \\u00b7 ' + esc(when) + (p.costUSD ? ' \\u00b7 about ' + Math.max(1, Math.round(p.costUSD*100)) + ' cents'+((p.engine==='yue2'||upload)?' of execution; startup and idle are extra':'') : '') + '</p>' +
          (p.lastError ? '<p role="note">'+esc(p.lastError)+'</p>' : '') +
          (p.readback ? '<p>' + esc(p.readback) + '</p>' : '') +
          (p.sungLyrics ? '<details><summary>Words it sang</summary><pre class="script">' + esc(p.sungLyrics) + '</pre></details>' : '') +
          (p.takes||[]).map(function(t, n){
            var lbl = 'Take ' + ((p.takes.length) - n) + (t.seconds ? ', ' + t.seconds + ' seconds' : '') + (t.description ? '. ' + t.description : '');
            return '<audio controls preload="none" aria-label="' + esc(lbl) + '"><source src="' + esc(t.url) + '">' + (t.backupUrl ? '<source src="' + esc(t.backupUrl) + '">' : '') + '</audio>' +
                   '<p class="hint"><a href="' + esc(t.url) + '" download target="_blank" rel="noreferrer">Download this take</a>' + (t.masterUrl ? ' · <a href="' + esc(t.masterUrl) + '" download target="_blank" rel="noreferrer">Download WAV master</a>' : '') + (t.scoreUrl ? ' · <a href="'+esc(t.scoreUrl)+'" download target="_blank" rel="noreferrer">Download composition score</a>' : '') + (t.vocalUrl ? ' · <a href="'+esc(t.vocalUrl)+'" download target="_blank" rel="noreferrer">'+esc((ue && uploadUi(ue).vocal) || 'Download the voice on its own')+'</a>' : '') + (t.vocalFxUrl ? ' · <a href="'+esc(t.vocalFxUrl)+'" download target="_blank" rel="noreferrer">'+esc((ue && uploadUi(ue).vocalFx) || 'Download the voice with its effect')+'</a>' : '') + (t.seconds ? ' \\u00b7 ' + t.seconds + ' seconds' : '') + '</p>' +
                   (t.note ? '<p class="hint">' + esc(t.note) + '</p>' : '') +
                   (t.voiceNote ? '<p class="hint">' + esc(t.voiceNote) + '</p>' : '') +
                   (ue && !t.voiceOf && (state.guide.engines[ue].takesFrom||[]).indexOf(p.engine)>=0 ? '<button type="button" class="act quiet" data-take-project="'+esc(p.id)+'" data-take="'+n+'" data-use="upload">'+esc(uploadUi(ue).useTake||'Use this take')+'</button> ' : '') +
                   (p.engine==='stable' || upload ? '' : (p.engine==='lyria'||p.engine==='yue2') ? '<button type="button" class="act quiet" data-take-project="'+esc(p.id)+'" data-take="'+n+'" data-use="cover">Cover this take</button>' : '<button type="button" class="act quiet" data-take-project="'+esc(p.id)+'" data-take="'+n+'" data-use="speech">Use this voice</button> <button type="button" class="act quiet" data-take-project="'+esc(p.id)+'" data-take="'+n+'" data-use="edit">Edit this take</button>');
          }).join('') +
          (upload ? '' : '<details><summary>'+(aukEdit?'Edit instructions':p.engine==='stable'?'Sound description':p.engine==='lyria'?'Music direction':'Script')+'</summary><pre class="script">' + esc(aukEdit ? (p.options.instruction || p.script) : (p.screenplay || p.script)) + '</pre></details>') +
          ((p.carryTo||[]).length ?
            '<details class="carry"><summary>Copy this saved work to another engine</summary>' +
            '<p class="hint">Copies the script, lyrics and compatible references to a saved draft. Open it first to copy your current edits instead.</p>' +
            '<label><input type="checkbox" id="carryrw_'+esc(p.id)+'"> Also have the script desk rewrite the description in the new format</label>' +
            (p.carryTo||[]).map(function(d){
              return '<button type="button" class="act quiet" data-carry="'+esc(p.id)+'" data-carryto="'+esc(d.engine)+'">Carry this to '+esc(d.label)+'</button>';
            }).join(' ') + '</details>' : '') +
          (p.carriedFrom ? '<p class="hint">Carried over from a '+esc(p.carriedFrom.engine==='yue2'?'YuE2':p.carriedFrom.engine==='lyria'?'Lyria':p.carriedFrom.engine==='seed'?'Seed Audio':p.carriedFrom.engine==='stable'?'Stable Audio':'AuK')+' project.</p>' : '') +
          '<details><summary>Rename saved work</summary><label for="rename_'+esc(p.id)+'">Track title</label><input id="rename_'+esc(p.id)+'" maxlength="80" value="'+esc(p.title)+'"><button type="button" class="act quiet" data-rename="'+esc(p.id)+'">Save title</button></details>'+
          '<button type="button" class="act" data-open="' + esc(p.id) + '">Open this in the booth</button></div>';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('[data-rename]'),function(button){button.onclick=async function(){
        var id=button.dataset.rename,title=document.getElementById('rename_'+id).value.trim();
        if(!title){say('Enter a title first.',true);return;}
        button.disabled=true;
        var result=await request('/api/kade/sound-booth/projects/'+encodeURIComponent(id),{title:title},'PATCH');
        button.disabled=false;
        if(!result.ok){say(result.data.error||'Could not save the title.',true);return;}
        if(state.projectId===id)document.getElementById('trackTitle').value=title;
        say('Title saved: '+title);await loadLibrary();
      };});
      Array.prototype.forEach.call(box.querySelectorAll('[data-carry]'),function(button){button.onclick=async function(){
        if(busy()){say('Finish the current operation first.',true);return;}
        var id=button.dataset.carry, to=button.dataset.carryto;
        var box2=document.getElementById('carryrw_'+id);
        var rewrite=!!(box2 && box2.checked);
        button.disabled=true;
        say(rewrite?'Carrying it over and asking the desk to rewrite the description. This takes a moment.':'Carrying it over.');
        var result=await request('/api/kade/sound-booth/projects/'+encodeURIComponent(id)+'/carry',{engine:to,rewrite:rewrite},'POST');
        button.disabled=false;
        if(!result.ok){say((result.data&&result.data.error)||'Could not carry that over.',true);return;}
        var notes=(result.data.notes||[]).join(' ');
        say('Carried over as "'+result.data.project.title+'". '+notes+' The original is untouched and still in your library.');
        await loadLibrary();
      };});
      Array.prototype.forEach.call(box.querySelectorAll('[data-take-project]'),function(button){button.onclick=function(){
        if(busy()){say('Finish the current operation first.',true);return;}
        var project=ps.filter(function(p){return p.id===button.dataset.takeProject;})[0];
        var take=project && project.takes[Number(button.dataset.take)];
        if(take && button.dataset.use==='upload'){
          var ue=uploadEngine(); if(!ue || !setEngine(ue, true)) return;
          var first=(state.guide.engines[ue].settings||[]).filter(function(x){ return x.kind==='choice'; })[0];
          state.projectId=null; state.values={}; if(first) state.values[first.key]=first.default;
          document.getElementById('trackTitle').value=(project.title+' (in my voice)').slice(0,80);
          /* The listening MP3, not the WAV master: the booth checks a recording's length by reading it, up to twenty megabytes. */
          state.importError=''; state.clips=[{url:take.url, name:project.title, seconds:take.seconds||null}];
          invalidateQuote(); renderSettings(); quoteUpload();
          say(uploadUi(ue).fromTake||uploadUi(ue).select||''); document.getElementById('btnRender').focus(); return;
        }
        var covering=button.dataset.use==='cover';
        if(!take || !setEngine(covering?'yue2':'scenema'))return;
        state.projectId=null; state.values.auk_task=button.dataset.use;
        if(covering){document.getElementById('trackTitle').value=project.title+' (cover)';state.values={lyrics:project.options&&project.options.lyrics||''};document.getElementById('script').value=project.screenplay||project.script||'';}
        if(button.dataset.use==='edit'){state.values.instruction='';delete state.values.gen_seconds;}
        state.importError='';state.clips=[{url:take.masterUrl||take.url,name:project.title}];
        invalidateQuote();renderSettings();
        say(covering?'Song attached for a YuE2 cover. Describe the new style and check the lyrics. The original is kept.':button.dataset.use==='edit'?'Take attached. Describe the edit you want. The original is kept.':'Voice reference attached. Write the words you want this voice to say.');
        document.getElementById(button.dataset.use==='edit'?'set_instruction':'script').focus();
      };});
      Array.prototype.forEach.call(box.querySelectorAll('[data-open]'), function(btn){
        btn.onclick = function(){
          var p = ps.filter(function(x){ return x.id === btn.getAttribute('data-open'); })[0];
          if(!p) return;
          if(!setEngine(p.engine)) return;
          state.projectId = p.id; setMode(p.mode === 'advanced' ? 'advanced' : 'easy');
          document.getElementById('trackTitle').value = p.title || '';
          document.getElementById('text').value = p.sourceText || '';
          document.getElementById('script').value = deskScript(p);
          state.lastXml = p.script || ''; showCode(state.lastXml);
          document.getElementById('readback').textContent = p.readback || '';
          state.values={}; state.clips=[];state.importError=''; state.voiceSeed=p.voiceSeed; state.rerollVoice=false; state.deskVoice=null;
          if(p.options){
            Object.keys(p.options).forEach(function(k){ if(typeof p.options[k] !== 'object') state.values[k]=p.options[k]; });
            var urls=p.engine==='lyria' ? [] : p.engine==='seed' ? p.options.audio_urls||[] : (p.options.reference_voice_url?[p.options.reference_voice_url]:[]);
            state.clips=urls.map(function(url,i){return {url:url,name:'Saved reference '+(i+1)};});
          }
          /* Oct 2 2026: a speech project saved with the voice inside its script shows that voice
           * in Describe a new voice, so the script box holds only the performance. */
          if(p.engine==='scenema' && state.values.auk_task!=='edit' && !String(state.values.voice_description||'').trim() && p.voice_description && !state.clips.length) state.values.voice_description=p.voice_description;
          /* Part 296: a saved score sits in More settings, so the group opens to show it. */
          if(state.guide.engines[p.engine].settings.some(function(s){ var v=state.values[s.key]; return s.advanced && s.kind==='text' && typeof v==='string' && v.trim(); })) moreOpen[p.engine]=true;
          invalidateQuote(); renderSettings(); if(isUpload() && state.clips.length) quoteUpload();
          say('Opened "' + p.title + '". Change what you like, then '+(isUpload() ? 'choose '+(uploadUi().render||'Render') : 'generate another take')+'.');
          focusWork();
        };
      });
      var listen = ps.filter(function(p){ return p.state === 'queued' || p.state === 'running'; })[0];
      if(listen && listen.jobs && listen.jobs.length && !state.jobId){ state.jobId = listen.jobs[listen.jobs.length-1]; document.getElementById('btnCancel').hidden = false; startPoll(); }
    }
    var starters=state.guide.starters||[];

    function newProject(starter){
      if(busy()){say('Finish the current operation first.',true);return;}
      if(starter && !setEngine(starter.engine))return;
      state.projectId=null;state.voiceSeed=null;state.rerollVoice=false;state.values={};state.clips=[];state.importError='';state.deskVoice=null;
      if(starter && starter.engine==='lyria')state.values.instrumental=starter.script.indexOf('Instrumental only, no vocals.')!==-1;
      document.getElementById('trackTitle').value=starter?starter.title:'';
      document.getElementById('mood').value='';
      setInput('words');
      document.getElementById('text').value='';document.getElementById('script').value=starter?starter.script:'';
      document.getElementById('readback').textContent='';state.lastXml='';showCode('');invalidateQuote();renderSettings();applyWorkflow();
      say(starter?'Starting '+starter.title+'. The starting point is ready to edit. Nothing has been generated.':'New blank draft.');
      focusWork();
    }
    document.getElementById('btnStarter').onclick=function(){var s=starters.find(function(s){return s.id===document.getElementById('starter').value;});if(s)newProject(s);};
    document.getElementById('btnBlank').onclick=function(){newProject(null);};
    document.getElementById('btnScriptFile').onclick=function(){
      var music=state.engine==='lyria'||state.engine==='yue2', text=document.getElementById('script').value;
      if(music&&state.values.lyrics)text+='\\n\\nLyrics:\\n'+state.values.lyrics;
      var url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));
      var a=document.createElement('a');a.href=url;a.download=(state.engine==='lyria'||state.engine==='yue2')?'music-direction.txt':'sound-booth-script.txt';a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);
      say(music?'Music direction and any lyrics downloaded.':'Script downloaded as text.');
    };
    setEngine('scenema'); setMode('easy'); setInput('words');
    loadLibrary();
    say('Ready. ' + state.guide.chooser.answer);
  })();
  </script>
<script src="/assets/soundbooth/workbench.js"></script>
</body></html>`;

module.exports = { soundBoothHtml };

