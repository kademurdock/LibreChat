/* The Sound Booth page's Open voices panel (Nov 15 2026): VoxCPM2 and Ming, Design a voice and
 * Speak with a voice. Nov 16 2026: Chatterbox (a Version and only that version's controls, its own
 * built-in voice in Design a voice) and DramaBox (Words to say becomes the Scene), each listed only
 * when the server says the bridge runs it. Spliced into kadeSoundBoothPage.js by interpolation, so none of this passes
 * through that file's template-literal escaping. Routes: kadeSoundBoothOpenVoices.js.
 *
 * Screen-reader shape (her rule): real labelled controls, the page's ONE live region (#status),
 * nothing auto-plays. The panel stays hidden until the server lists at least one engine. Typing
 * here does not touch the main render's quote (events stop at the panel). */

const OPEN_VOICES_HTML = `
    <div id="openVoicesDrawer" hidden><h3 id="ovSummary">Open voices</h3>
    <fieldset id="openVoicesPanel"><legend>Design a voice, or speak with a saved one</legend>
      <label class="field" for="ovEngine">Voice engine</label>
      <select id="ovEngine" aria-describedby="ovEngineHint"></select>
      <p class="hint" id="ovEngineHint"></p>
      <div class="seg" role="group" aria-label="Design a voice or speak with one">
        <button type="button" id="ovModeDesign" aria-pressed="true">Design a voice</button>
        <button type="button" id="ovModeSpeak" aria-pressed="false">Speak with a voice</button>
      </div>
      <div id="ovDesignBox">
        <p class="hint" id="ovDesignNote" hidden></p>
        <div id="ovMingDesign" hidden>
          <label class="field" for="ovBuiltin">Built-in voice</label>
          <select id="ovBuiltin" aria-describedby="ovBuiltinHint"><option value="">None. Use my description</option></select>
          <p class="hint" id="ovBuiltinHint">A ready-made Ming voice instead of a description. Picking one hides Describe the voice; set this back to None to describe one.</p>
        </div>
        <div id="ovDescWrap">
        <label class="field" for="ovDescription">Describe the voice</label>
        <p class="hint" id="ovDescriptionHint">For example: a warm older man with a slow Southern drawl and a little gravel. Each try makes a new voice.</p>
        <textarea id="ovDescription" aria-describedby="ovDescriptionHint" style="min-height:4.5rem"></textarea>
        </div>
      </div>
      <div id="ovSpeakBox" hidden>
        <label class="field" for="ovVoice">Saved voice</label>
        <select id="ovVoice" aria-describedby="ovVoiceHint"></select>
        <p class="hint" id="ovVoiceHint">Your saved voices, newest first. Or choose An imported clip and import one below.</p>
        <button type="button" class="act quiet" id="ovForget" hidden>Remove this voice from my list</button>
        <div id="ovClipBox" hidden>
          <label class="field" for="ovClip">Import a clip: WAV, MP3 or M4A</label>
          <input type="file" id="ovClip" accept="audio/*,.wav,.mp3,.m4a" aria-describedby="ovClipHint">
          <p class="hint" id="ovClipHint">A clear recording of one person talking. Ten to thirty seconds works best.</p>
          <label class="field" for="ovClipWords">What the clip says, word for word (optional)</label>
          <input type="text" id="ovClipWords" maxlength="1000" aria-describedby="ovClipWordsHint">
          <p class="hint" id="ovClipWordsHint">Only for a clip of thirty seconds or less. Exact words make the copy closer. Leave it empty if unsure.</p>
          <label class="field" for="ovClipName">Name for this clip's voice</label>
          <input type="text" id="ovClipName" maxlength="80">
          <button type="button" class="act quiet" id="ovKeepClip">Keep this clip as a saved voice</button>
        </div>
        <div id="ovStyleWrap">
        <label class="field" for="ovStyle">Style (optional)</label>
        <input type="text" id="ovStyle" maxlength="400" aria-describedby="ovStyleHint">
        <p class="hint" id="ovStyleHint">Plain words, for example: slightly faster, cheerful tone.</p>
        </div>
        <div id="ovMingSpeak" hidden>
          <p class="hint" id="ovMingSpeakHint">Ming takes one of these per take: a style, an emotion, or speed, pitch and volume.</p>
          <label class="field" for="ovEmotion">Emotion</label>
          <select id="ovEmotion" aria-describedby="ovMingSpeakHint"><option value="">Not set</option></select>
          <label class="field" for="ovSpeed">Speed</label>
          <select id="ovSpeed" aria-describedby="ovMingSpeakHint"><option value="">Not set</option></select>
          <label class="field" for="ovPitch">Pitch</label>
          <select id="ovPitch" aria-describedby="ovMingSpeakHint"><option value="">Not set</option></select>
          <label class="field" for="ovVolume">Volume</label>
          <select id="ovVolume" aria-describedby="ovMingSpeakHint"><option value="">Not set</option></select>
          <label class="field" for="ovLanguage">Language of the words to say</label>
          <select id="ovLanguage" aria-describedby="ovLanguageHint"><option value="">Found from the words</option></select>
          <p class="hint" id="ovLanguageHint">German, Spanish, French, Korean and Japanese need a clip of thirty seconds or less whose words are typed in, and no style, emotion, speed, pitch or volume.</p>
        </div>
      </div>
      <div id="ovCbBox" hidden>
        <label class="field" for="ovVersion">Version</label>
        <select id="ovVersion" aria-describedby="ovVersionHint"></select>
        <p class="hint" id="ovVersionHint"></p>
        <div id="ovCbTuning" hidden>
          <label class="field" for="ovExaggeration">Expressiveness (optional)</label>
          <input type="number" id="ovExaggeration" min="0.25" max="2" step="0.05" aria-describedby="ovExaggerationHint">
          <p class="hint" id="ovExaggerationHint">How lively and dramatic it sounds. Empty is the usual 0.5. From 0.25 to 2.</p>
          <label class="field" for="ovSteadiness">Steadiness (optional)</label>
          <input type="number" id="ovSteadiness" min="0" max="1" step="0.05" aria-describedby="ovSteadinessHint">
          <p class="hint" id="ovSteadinessHint">How closely it keeps to the voice and an even pace. Empty is the usual 0.5. Lower is slower and looser. At most 1.</p>
        </div>
        <div id="ovCbLangBox" hidden>
          <label class="field" for="ovCbLanguage">Language of the words to say</label>
          <select id="ovCbLanguage"></select>
        </div>
        <label class="field" for="ovVariety">Variety (optional)</label>
        <input type="number" id="ovVariety" min="0.05" max="5" step="0.05" aria-describedby="ovVarietyHint">
        <p class="hint" id="ovVarietyHint"></p>
      </div>
      <div id="ovDbBox" hidden>
        <label class="field" for="ovDuration">Scene length in seconds (optional)</label>
        <input type="number" id="ovDuration" min="3" max="45" step="1" aria-describedby="ovDurationHint">
        <p class="hint" id="ovDurationHint">Leave it empty and DramaBox decides. For a short scene, 3 to 45 seconds.</p>
      </div>
      <label class="field" for="ovText" id="ovTextLabel">Words to say</label>
      <textarea id="ovText" maxlength="5000" aria-describedby="ovTextHint" style="min-height:5rem"></textarea>
      <p class="hint" id="ovTextHint">Up to 5,000 characters. For a voice you plan to keep, a sentence or two is best.</p>
      <div id="ovTagsBox" hidden>
        <label class="field" for="ovTag">Sound tags</label>
        <select id="ovTag" aria-describedby="ovTagHint"></select>
        <button type="button" class="act quiet" id="ovInsertTag" aria-describedby="ovTagHint">Insert the sound tag in the words</button>
        <p class="hint" id="ovTagHint">Puts the tag where your cursor was in Words to say. Tags need a clip of thirty seconds or less whose words are typed in, and no style, emotion, speed, pitch or volume.</p>
      </div>
      <label class="field" for="ovSeed">Voice number (optional)</label>
      <input type="number" id="ovSeed" min="0" max="2147483647" step="1" aria-describedby="ovSeedHint">
      <p class="hint" id="ovSeedHint">Leave it empty for a new take every try. Type a take's number to hear that take again.</p>
      <button type="button" class="act primary" id="ovMake">Make a take</button>
      <button type="button" class="act" id="ovStop" hidden>Stop this take</button>
      <p class="hint">Each take is saved in My Creations. GPU time is billed.</p>
      <h3 id="ovTakesHeading" hidden>Takes</h3>
      <ul id="ovTakes" aria-labelledby="ovTakesHeading" style="list-style:none;padding:0"></ul>
    </fieldset>
    </div>`;

const OPEN_VOICES_SCRIPT = `
  <script>
  (async function(){
    var drawer = document.getElementById('openVoicesDrawer');
    var panel = document.getElementById('openVoicesPanel');
    if(!drawer || !panel) return;
    var status = document.getElementById('status');
    /* The same sentence twice would not change the live region, so screen readers would stay quiet
     * (a second tag insert, a second press after a refusal). A repeat gets a trailing no-break space,
     * on and off, so every say is heard. */
    function say(msg, isErr){
      status.className = 'status' + (isErr ? ' err' : '');
      status.textContent = status.textContent === msg ? msg + '\u00a0' : msg;
    }
    function $(id){ return document.getElementById(id); }
    ['input','change'].forEach(function(t){ panel.addEventListener(t, function(e){ e.stopPropagation(); }); });
    var token = null; try { token = await getToken(); } catch(e) {}
    if(!token) return;
    async function call(path, body){
      try {
        var r = await fetch('/api/kade/sound-booth' + path, { method: body === undefined ? 'GET' : 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
        var j = null; try { j = await r.json(); } catch(e) {}
        return { ok: r.ok, status: r.status, data: j || {} };
      } catch(e) { return { ok: false, status: 0, data: { error: 'Connection lost. Try again.' } }; }
    }
    var ov = { mode: 'design', engines: [], voices: [], clip: null, jobId: null, timer: null, coldSaid: {}, takes: 0, lastSpoken: 0, busy: false, tagsFor: '' };
    var first = await call('/open-voices');
    if(!first.ok || !first.data.engines || !first.data.engines.length) return;
    ov.engines = first.data.engines; ov.coldNote = first.data.coldNote || '';
    ov.engines.forEach(function(e){ var o = document.createElement('option'); o.value = e.id; o.textContent = e.label; $('ovEngine').appendChild(o); });
    var labels = ov.engines.map(function(e){ return e.label; }).join(' and ');
    $('ovSummary').textContent = 'Open voices: ' + labels;
    var intro = $('ovIntro'); if(intro) intro.textContent = ' Make a voice holds ' + labels + '.';
    /* Ming's own controls, filled from the server's list and shown only while Ming is picked. */
    var mingEngine = ov.engines.find(function(x){ return x.id === 'ming'; });
    var mc = (mingEngine && mingEngine.controls) || null;
    function fillSelect(id, list){ (list || []).forEach(function(o){ var op = document.createElement('option'); op.value = o.value; op.textContent = o.label; $(id).appendChild(op); }); }
    if(mc){
      fillSelect('ovBuiltin', mc.voices); fillSelect('ovEmotion', mc.emotions); fillSelect('ovSpeed', mc.speeds);
      fillSelect('ovPitch', mc.levels); fillSelect('ovVolume', mc.levels); fillSelect('ovLanguage', mc.languages);
    }
    /* Chatterbox's version list, languages and tags; DramaBox needs only the engine entry. */
    var cbEngine = ov.engines.find(function(x){ return x.id === 'chatterbox'; });
    var cbc = (cbEngine && cbEngine.controls) || null;
    if(cbc){
      fillSelect('ovVersion', cbc.versions); fillSelect('ovCbLanguage', cbc.languages);
      $('ovCbLanguage').value = 'en';
    }
    var mingTagHint = $('ovTagHint').textContent;
    function cur(){ return ov.engines.find(function(x){ return x.id === $('ovEngine').value; }) || ov.engines[0]; }
    function isMing(){ return !!mc && $('ovEngine').value === 'ming'; }
    function isCb(){ return !!cbc && $('ovEngine').value === 'chatterbox'; }
    function isDb(){ return $('ovEngine').value === 'dramabox'; }
    function version(){ return cbc ? (cbc.versions.find(function(v){ return v.value === $('ovVersion').value; }) || cbc.versions[0]) : null; }
    function maxText(){ var e = cur(); return (e && e.maxText) || 5000; }
    /* The Sound tags list belongs to the engine picked: refilled only when that changes. */
    function fillTags(which){
      if(ov.tagsFor === which) return;
      ov.tagsFor = which; $('ovTag').textContent = '';
      fillSelect('ovTag', which === 'chatterbox' ? cbc.tags : which === 'ming' && mc ? mc.tags : []);
      $('ovTagHint').textContent = which === 'chatterbox' ? cbc.tagNote : mingTagHint;
    }
    /* Nov 16 2026: a built-in voice and a description used to be refused together, and VoiceOver can
     * change a closed select while arrowing past it, so every Make sent her back to the description.
     * Now a built-in voice hides the description (it is kept, not sent) and None brings it back. */
    function builtinOn(){ return isMing() && ov.mode === 'design' && !!$('ovBuiltin').value; }
    /* Shows only what the picked engine (and Chatterbox version) uses. Hidden boxes keep their
     * values; only what is shown is sent. */
    function showMing(){
      var m = isMing(), cb = isCb(), db = isDb(), v = version(), e = cur();
      var turbo = cb && v && v.value === 'turbo';
      $('ovDescWrap').hidden = builtinOn() || cb || db;
      $('ovDesignNote').hidden = !(cb || db); $('ovDesignNote').textContent = (cb || db) && e.designNote ? e.designNote : '';
      $('ovStyleWrap').hidden = cb || db;
      $('ovMingDesign').hidden = !(m && ov.mode === 'design');
      $('ovMingSpeak').hidden = !(m && ov.mode === 'speak');
      $('ovCbBox').hidden = !cb;
      $('ovCbTuning').hidden = !(cb && !turbo);
      $('ovCbLangBox').hidden = !(cb && v && v.value === 'multilingual');
      $('ovDbBox').hidden = !db;
      if(cb && v){
        $('ovVersionHint').textContent = v.about;
        $('ovVarietyHint').textContent = 'How much each take varies. Empty is the usual 0.8. From ' + v.variety[0] + ' to ' + v.variety[1] + '.';
        $('ovVariety').max = v.variety[1];
      }
      var tags = (m && ov.mode === 'speak') || turbo;
      if(tags) fillTags(turbo ? 'chatterbox' : 'ming');
      $('ovTagsBox').hidden = !tags;
      $('ovTextLabel').textContent = (e && e.textLabel) || 'Words to say';
      if(e && e.textHint) $('ovTextHint').textContent = e.textHint;
      $('ovText').maxLength = maxText();
    }
    function showEngine(){
      var e = cur();
      $('ovEngineHint').textContent = e ? e.about + (e.controls && e.controls.about ? ' ' + e.controls.about : '') : '';
      showMing();
    }
    /* What switching mode or engine shows, said after the first sentence. */
    function mingShown(){
      if(isCb()) return ov.mode === 'design' ? ' Chatterbox uses its own built-in voice here.' : '';
      if(isDb()) return ov.mode === 'design' ? ' DramaBox picks the voice from your scene.' : ' Write the scene in the Scene box.';
      if(!isMing()) return '';
      return ov.mode === 'design' ? ' You can also pick a built-in voice.' : ' Emotion, speed, pitch, volume, language and sound tags are shown.';
    }
    $('ovBuiltin').onchange = function(){
      showMing();
      var sel = this;
      say(sel.value ? sel.options[sel.selectedIndex].textContent + ' picked. Describe the voice is hidden. Set Built-in voice to None to describe a voice.' : 'No built-in voice. Describe the voice is shown.');
    };
    $('ovEngine').onchange = function(){
      showEngine();
      var e = ov.engines.find(function(x){ return x.id === $('ovEngine').value; });
      if(!e) return;
      if(isCb()) say(e.label + ' picked. ' + version().label + ' version.' + mingShown());
      else if(isDb()) say(e.label + ' picked. Words to say is now Scene.' + mingShown());
      else say(e.label + ' picked.' + (isMing() ? (ov.mode === 'design' ? ' You can pick a built-in voice.' : ' Emotion, speed, pitch, volume, language and sound tags are shown.') : ''));
    };
    $('ovVersion').onchange = function(){
      showMing();
      var v = version(), shown = v.value === 'turbo' ? ' Sound tags are shown.' : ' Expressiveness and Steadiness are shown.' + (v.value === 'multilingual' ? ' Pick the language.' : '');
      say(v.label + ' picked.' + shown);
    };
    showEngine();
    /* Where the cursor was in Words to say, so a sound tag lands there. Before she has been in the
     * box, a tag goes at the end. */
    var caret = null;
    $('ovText').addEventListener('blur', function(){ caret = { start: this.selectionStart, end: this.selectionEnd }; });
    $('ovInsertTag').onclick = function(){
      var t = $('ovText'), sel = $('ovTag'), tag = sel.value;
      if(!tag){ say('Pick a sound tag first.', true); sel.focus(); return; }
      var name = sel.options[sel.selectedIndex].textContent, len = t.value.length;
      var s = caret ? Math.min(caret.start, len) : len, e = caret ? Math.min(Math.max(caret.end, s), len) : len;
      var before = t.value.slice(0, s), after = t.value.slice(e);
      var ins = (before && !/\\s$/.test(before) ? ' ' : '') + tag + (after && !/^\\s/.test(after) ? ' ' : '');
      if((before + ins + after).length > maxText()){ say('The words are at the ' + maxText().toLocaleString('en-US') + ' character limit. Nothing was inserted.', true); return; }
      t.value = before + ins + after;
      var pos = before.length + ins.length; caret = { start: pos, end: pos };
      t.focus(); t.setSelectionRange(pos, pos);
      say('Inserted the ' + name + ' tag. You are back in Words to say, just after it.');
    };
    function fillVoices(keep){
      var sel = $('ovVoice'); sel.textContent = '';
      ov.voices.forEach(function(v){ var o = document.createElement('option'); o.value = v.id; o.textContent = v.name + (v.seconds ? ', ' + Math.round(v.seconds) + ' seconds' : ''); sel.appendChild(o); });
      var c = document.createElement('option'); c.value = 'clip'; c.textContent = 'An imported clip'; sel.appendChild(c);
      if(keep && Array.prototype.some.call(sel.options, function(o){ return o.value === keep; })) sel.value = keep;
      showVoice();
    }
    function voiceName(id){ var v = ov.voices.find(function(x){ return x.id === id; }); return v ? v.name : 'this voice'; }
    function showVoice(){
      var clip = $('ovVoice').value === 'clip'; $('ovClipBox').hidden = !clip; $('ovForget').hidden = clip;
      if(!clip) $('ovForget').textContent = 'Remove ' + voiceName($('ovVoice').value) + ' from my list';
    }
    $('ovVoice').onchange = showVoice;
    async function reloadVoices(keep){ var r = await call('/open-voices'); if(r.ok){ ov.voices = r.data.voices || []; fillVoices(keep); } }
    ov.voices = first.data.voices || []; fillVoices();
    function setMode(m){
      ov.mode = m;
      $('ovModeDesign').setAttribute('aria-pressed', m === 'design'); $('ovModeSpeak').setAttribute('aria-pressed', m === 'speak');
      $('ovDesignBox').hidden = m !== 'design'; $('ovSpeakBox').hidden = m !== 'speak';
      showMing();
    }
    $('ovModeDesign').onclick = function(){ setMode('design'); say((isCb() || isDb() ? 'Design a voice.' : 'Design a voice. Describe it, then type the words to say.') + mingShown()); };
    $('ovModeSpeak').onclick = function(){ setMode('speak'); say((ov.voices.length ? 'Speak with a voice. Pick a saved voice or import a clip.' : 'Speak with a voice. You have no saved voices yet, so import a clip, or keep a designed take first.') + mingShown()); };
    drawer.hidden = false;

    $('ovClip').onchange = async function(){
      var f = this.files && this.files[0]; if(!f) return;
      if(f.size > 20*1024*1024){ say('That clip is over twenty megabytes.', true); return; }
      say('Importing ' + f.name + '…');
      try {
        var fd = new FormData(); fd.append('clip', f, f.name); fd.append('engine', 'scenema');
        var r = await fetch('/api/kade/sound-booth/reference', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, body: fd, signal: AbortSignal.timeout(240000) });
        var j = null; try { j = await r.json(); } catch(e) {}
        if(!r.ok || !j || !j.url) throw new Error((j && j.error) || 'That clip could not be imported.');
        ov.clip = { url: j.url, seconds: j.seconds || null, name: j.name || f.name };
        if(!$('ovClipName').value) $('ovClipName').value = String(ov.clip.name).replace(/\\.[a-z0-9]+$/i, '').slice(0, 80);
        say('Clip imported' + (j.seconds ? ', ' + j.seconds + ' seconds' : '') + '. It will be the voice for the next take.');
      } catch(e) { ov.clip = null; say(e.message || 'That clip could not be imported.', true); }
    };
    $('ovKeepClip').onclick = async function(){
      if(!ov.clip){ say('Import a clip first.', true); $('ovClip').focus(); return; }
      var name = $('ovClipName').value.trim(); if(!name){ say('Give the voice a name first.', true); $('ovClipName').focus(); return; }
      var r = await call('/open-voices/keep-clip', { clipUrl: ov.clip.url, name: name, clipWords: $('ovClipWords').value, seconds: ov.clip.seconds });
      if(!r.ok){ say(r.data.error || 'The voice did not save.', true); return; }
      await reloadVoices(r.data.voice && r.data.voice.id); say(r.data.spoken || 'Saved.'); $('ovVoice').focus();
    };
    $('ovForget').onclick = async function(){
      var id = $('ovVoice').value; if(!id || id === 'clip') return;
      var nm = voiceName(id);
      if(!window.confirm('Remove ' + nm + ' from your voices? The recording stays in My Creations.')) { say('Kept ' + nm + '.'); return; }
      var r = await call('/open-voices/forget', { voiceId: id });
      if(!r.ok){ say(r.data.error || 'Could not remove it.', true); return; }
      await reloadVoices(); say(r.data.spoken || 'Removed.'); $('ovVoice').focus();
    };

    /* Make stays focusable while a take runs (aria-disabled, and the busy check ignores a press), so
     * VoiceOver never loses its place. When the take ends, focus on Stop or nowhere goes back to Make. */
    function setBusy(b){
      ov.busy = b;
      if(b){ $('ovMake').setAttribute('aria-disabled', 'true'); $('ovStop').hidden = false; return; }
      $('ovMake').removeAttribute('aria-disabled');
      var a = document.activeElement;
      if(!a || a === document.body || a === $('ovStop')) $('ovMake').focus();
      $('ovStop').hidden = true;
    }
    function follow(jobId, msg){
      ov.jobId = jobId; ov.lastSpoken = Date.now(); setBusy(true);
      if(document.activeElement === $('ovMake')) $('ovStop').focus();
      say(msg); clearTimeout(ov.timer); ov.timer = setTimeout(poll, 3000);
    }
    /* A refusal names the control to change (the route's field); focus goes there when it is shown. */
    function focusField(field){
      var clip = $('ovVoice').value === 'clip';
      var ids = { text: 'ovText', language: 'ovLanguage', style: 'ovStyle', emotion: 'ovEmotion', speed: 'ovSpeed', pitch: 'ovPitch',
        volume: 'ovVolume', description: 'ovDescription', voice: 'ovBuiltin', clipWords: clip ? 'ovClipWords' : 'ovVoice',
        engine: 'ovEngine', seed: 'ovSeed', version: 'ovVersion', temperature: 'ovVariety', exaggeration: 'ovExaggeration', cfg_weight: 'ovSteadiness',
        language_id: 'ovCbLanguage', duration: 'ovDuration', reference: clip ? 'ovClip' : 'ovVoice' };
      var el = field && ids[field] ? $(ids[field]) : null;
      if(el && ownHidden(el) && field === 'description' && builtinOn()) el = $('ovBuiltin');
      if(el && !ownHidden(el)){ if(window.kadeBoothReveal) window.kadeBoothReveal(el); el.focus(); }
    }
    /* Hidden by Open voices itself. A closed booth section's region is hidden too, but that one is opened for this
     * visit (not saved) so the named field still gets focus. */
    function ownHidden(el){
      for(var p = el; p; p = p.parentElement){
        if(!p.hidden) continue;
        var sec = p.parentElement;
        if(!(p.getAttribute('role') === 'region' && sec && sec.classList.contains('section') && p.id === sec.id + '-body')) return true;
      }
      return false;
    }
    $('ovMake').onclick = async function(){
      if(ov.busy){ say('A take is still being made. Press Stop this take to end it.'); return; }
      var body = { engine: $('ovEngine').value, mode: ov.mode, text: $('ovText').value, seed: $('ovSeed').value };
      /* Ming's controls go only with Ming. Ming takes one choice per take, so a mix is named here
       * and focus goes to the control to change; the server checks the rest. */
      if(isMing()){
        if(ov.mode === 'design'){
          body.voice = $('ovBuiltin').value;
        } else {
          ['emotion', 'speed', 'pitch', 'volume', 'language'].forEach(function(k){ body[k] = $('ov' + k[0].toUpperCase() + k.slice(1)).value; });
          var level = body.speed || body.pitch || body.volume, style = $('ovStyle').value.trim();
          if([body.emotion, level, style].filter(Boolean).length > 1){
            say('Ming takes one of these per take: a style, an emotion, or speed, pitch and volume. Clear the others.', true);
            (body.emotion ? $('ovEmotion') : $('ovStyle')).focus(); return;
          }
        }
      }
      /* Chatterbox: the version and only its controls. DramaBox: the scene length. */
      if(isCb()){
        var v = version(); body.version = v.value; body.temperature = $('ovVariety').value;
        if(v.value !== 'turbo'){ body.exaggeration = $('ovExaggeration').value; body.cfg_weight = $('ovSteadiness').value; }
        if(v.value === 'multilingual') body.language_id = $('ovCbLanguage').value;
      }
      if(isDb()) body.duration = $('ovDuration').value;
      var own = isCb() || isDb();
      if(ov.mode === 'design'){ if(!builtinOn() && !own) body.description = $('ovDescription').value; }
      else {
        if(!own) body.style = $('ovStyle').value;
        if($('ovVoice').value === 'clip'){ if(!ov.clip){ say('Import a clip first, or pick a saved voice.', true); $('ovClip').focus(); return; } body.clipUrl = ov.clip.url; body.clipWords = $('ovClipWords').value; body.clipSeconds = ov.clip.seconds; }
        else body.voiceId = $('ovVoice').value;
      }
      setBusy(true); $('ovStop').focus(); say('Starting a take…');
      var r = await call('/open-voices/take', body);
      if(r.status === 409 && r.data.jobId){ follow(r.data.jobId, r.data.error || 'Your last take is still being made. The page will say when it is ready.'); return; }
      if(!r.ok){ setBusy(false); say(r.data.error || 'The take could not start.', true); focusField(r.data.field); return; }
      var msg = 'Making a take.';
      if(r.data.coldLikely && !ov.coldSaid[body.engine]){ ov.coldSaid[body.engine] = true; msg += ' ' + (r.data.coldNote || (cur() && cur().coldNote) || ov.coldNote); }
      follow(r.data.jobId, msg + ' The page will say when it is ready.');
    };
    $('ovStop').onclick = async function(){
      if(!ov.jobId) return;
      var r = await call('/open-voices/stop', { jobId: ov.jobId });
      if(!r.ok){ say(r.data.error || 'Stop was not confirmed.', true); return; }
      clearTimeout(ov.timer); ov.jobId = null; setBusy(false); say('Stopped. Nothing was kept from this take.');
    };
    async function poll(){
      if(!ov.jobId) return;
      var id = ov.jobId;
      var r = await call('/open-voices/take/' + encodeURIComponent(id));
      var d = r.data || {};
      if(id !== ov.jobId) return;
      if(r.ok && d.state === 'done' && d.url){ ov.jobId = null; setBusy(false); addTake(d, id); return; }
      /* A lost connection, a slow answer or a server hiccup is not the end of a take: keep checking.
       * Only a clear failed or stopped state, or a take the server no longer knows, ends it here. */
      var gone = r.status >= 400 && r.status < 500;
      if(gone || d.state === 'failed' || d.state === 'cancelled'){ ov.jobId = null; setBusy(false); say(d.error || 'The take did not finish.', true); return; }
      if(d.spoken && Date.now() - ov.lastSpoken > 20000){ ov.lastSpoken = Date.now(); say(d.spoken); }
      ov.timer = setTimeout(poll, 3000);
    }
    function addTake(d, jobId){
      ov.takes++;
      var n = ov.takes, engine = (ov.engines.find(function(e){ return e.id === d.engine; }) || {}).label || d.engine;
      var ver = d.version && cbc ? cbc.versions.find(function(v){ return v.value === d.version; }) : null;
      if(ver) engine += ' ' + ver.label;
      var li = document.createElement('li'); li.className = 'proj';
      var title = 'Take ' + n + ', ' + engine + ', voice number ' + d.seed + (d.seconds ? ', ' + Math.round(d.seconds) + ' seconds' : '');
      var h = document.createElement('h4'); h.tabIndex = -1; h.textContent = title; li.appendChild(h);
      var a = document.createElement('audio'); a.controls = true; a.preload = 'none'; a.src = d.url; a.setAttribute('aria-label', 'Play take ' + n); li.appendChild(a);
      var lab = document.createElement('label'); lab.className = 'field'; lab.htmlFor = 'ovName' + n; lab.textContent = 'Name for this voice';
      var name = document.createElement('input'); name.type = 'text'; name.id = 'ovName' + n; name.maxLength = 80;
      var keep = document.createElement('button'); keep.type = 'button'; keep.className = 'act quiet'; keep.textContent = 'Keep as a saved voice';
      keep.setAttribute('aria-label', 'Keep take ' + n + ' as a saved voice');
      keep.onclick = async function(){
        if(keep.getAttribute('aria-disabled') === 'true'){ say(keep.textContent + '.'); return; }
        var nm = name.value.trim(); if(!nm){ say('Give the voice a name first.', true); name.focus(); return; }
        var r = await call('/open-voices/keep', { jobId: jobId, name: nm });
        if(!r.ok){ say(r.data.error || 'The voice did not save.', true); return; }
        keep.setAttribute('aria-disabled', 'true'); keep.textContent = 'Kept as ' + nm; keep.removeAttribute('aria-label');
        await reloadVoices(); say(r.data.spoken || 'Saved.');
      };
      li.appendChild(lab); li.appendChild(name); li.appendChild(keep);
      $('ovTakes').insertBefore(li, $('ovTakes').firstChild); $('ovTakesHeading').hidden = false;
      say('Take ' + n + ' is ready. Play it, or keep it as a saved voice.');
      var a2 = document.activeElement;
      if(!a2 || a2 === document.body || a2 === $('ovMake') || a2 === $('ovStop')) h.focus();
    }
  })();
  </script>`;

/* The intro's Open voices sentence: an empty span the panel script fills in with the engines the
 * server lists, so VoiceOver never hears of an engine that is not there. */
const OPEN_VOICES_INTRO = '<span id="ovIntro"></span>';

/* All empty while KADE_OPEN_VOICES=0, so the page is then the text it was before. */
function pageParts(env = process.env) {
  return env.KADE_OPEN_VOICES === '0' ? { OPEN_VOICES_HTML: '', OPEN_VOICES_SCRIPT: '', OPEN_VOICES_INTRO: '' } : { OPEN_VOICES_HTML, OPEN_VOICES_SCRIPT, OPEN_VOICES_INTRO };
}

module.exports = { OPEN_VOICES_HTML, OPEN_VOICES_SCRIPT, OPEN_VOICES_INTRO, pageParts };
