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
        <button type="button" class="act quiet" id="ovDownloadVoice" hidden>Download this voice</button>
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
      <div id="ovTuneBox" hidden>
        <div id="ovStepsWrap">
          <label class="field" for="ovSteps" id="ovStepsLabel">Quality</label>
          <select id="ovSteps" aria-describedby="ovStepsHint"></select>
          <p class="hint" id="ovStepsHint"></p>
        </div>
        <label class="field" for="ovCfg" id="ovCfgLabel">How closely it follows</label>
        <select id="ovCfg" aria-describedby="ovCfgHint"></select>
        <p class="hint" id="ovCfgHint"></p>
      </div>
      <div id="ovWriterBox" role="group" aria-labelledby="ovWriterHeading">
        <h4 id="ovWriterHeading">The writer</h4>
        <label class="field" for="ovIdea">What should it say? (for Write it for me)</label>
        <textarea id="ovIdea" maxlength="3000" aria-describedby="ovIdeaHint" style="min-height:3rem"></textarea>
        <p class="hint" id="ovIdeaHint"></p>
        <button type="button" class="act" id="ovWrite">Write it for me</button>
        <button type="button" class="act quiet" id="ovFormat">Format my words for this engine</button>
        <button type="button" class="act quiet" id="ovUndoWrite" hidden>Put back the words I had</button>
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
      <label class="field" for="ovCount">Takes per press</label>
      <select id="ovCount" aria-describedby="ovCountHint"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select>
      <p class="hint" id="ovCountHint">Makes this many takes one after another, each a new voice. Stop this take ends the rest too. Each take is billed GPU time: once the engine is running, about 1 to 2 cents a take.</p>
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
    async function call(path, body, waitMs){
      try {
        var r = await fetch('/api/kade/sound-booth' + path, { method: body === undefined ? 'GET' : 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(waitMs || 60000) });
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
      showSettings(e);
      if(cb && v){
        $('ovVersionHint').textContent = v.about;
        $('ovVarietyHint').textContent = 'How much each take varies. Empty is the usual 0.8. From ' + v.variety[0] + ' to ' + v.variety[1] + '.';
        $('ovVariety').max = v.variety[1];
      }
      var tags = (m && ov.mode === 'speak') || turbo;
      if(tags) fillTags(turbo ? 'chatterbox' : 'ming');
      $('ovTagsBox').hidden = !tags;
      $('ovTextLabel').textContent = (e && e.textLabel) || 'Words to say';
      $('ovIdeaHint').textContent = writerHint(e, cb, db, turbo, v);
      if(e && e.textHint) $('ovTextHint').textContent = e.textHint;
      $('ovText').maxLength = maxText();
    }
    /* Nov 16 2026: Quality (steps) and How closely it follows (cfg), from the engine's own settings
     * list. The menus are refilled only when the engine changes; a choice the new engine also has is
     * kept, anything else goes back to the usual. Only what is shown is sent. */
    function fillSetting(id, s){
      var was = $(id).value; $(id).textContent = '';
      fillSelect(id, s ? s.options : []);
      $(id).value = s && s.options.some(function(o){ return o.value === was; }) ? was : '';
    }
    function showSettings(e){
      var s = (e && e.settings) || null;
      $('ovTuneBox').hidden = !s;
      if(!s || ov.settingsFor === e.id) return;
      ov.settingsFor = e.id;
      $('ovStepsWrap').hidden = !s.steps;
      fillSetting('ovSteps', s.steps); fillSetting('ovCfg', s.cfg);
      if(s.steps){ $('ovStepsLabel').textContent = s.steps.label; $('ovStepsHint').textContent = s.steps.hint; }
      if(s.cfg){ $('ovCfgLabel').textContent = s.cfg.label; $('ovCfgHint').textContent = s.cfg.hint; }
    }
    /* Said when an engine with these menus is picked, so VoiceOver hears that they appeared. */
    function settingsShown(e){
      var s = e && e.settings;
      if(!s) return '';
      var names = [s.steps, s.cfg].filter(Boolean).map(function(x){ return x.label; });
      return ' ' + names.join(' and ') + (names.length > 1 ? ' menus are' : ' menu is') + ' shown.';
    }
    function addSettings(body){
      var s = cur() && cur().settings;
      if(!s) return;
      if(s.steps && $('ovSteps').value) body.steps = $('ovSteps').value;
      if(s.cfg && $('ovCfg').value) body.cfg = $('ovCfg').value;
    }
    /* What the writer does for the engine picked, in one plain sentence. */
    function writerHint(e, cb, db, turbo, v){
      var name = e ? e.label : 'this engine';
      if(db) return 'For example: write a script about a tired sailor saying goodbye in a storm. The writer puts the spoken words in quotes, and the acting and background sounds around them. The scene goes in Scene.';
      if(turbo) return 'For example: a friend telling a funny story about a lost dog. The writer writes words for Chatterbox Turbo and adds sound tags like laugh or sigh where they fit. They go in Words to say.';
      if(cb) return 'For example: a radio host welcoming listeners on a rainy morning. The writer writes plain words for Chatterbox ' + (v ? v.label : '') + (v && v.value === 'multilingual' ? ', in the language picked below' : '') + '. They go in Words to say.';
      return 'For example: a grandmother reading a bedtime story. The writer writes plain words for ' + name + ' to say' + (ov.mode === 'design' && !builtinOn() ? ', and a voice description if yours is empty' : '') + '. They go in Words to say.';
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
      else if(isDb()) say(e.label + ' picked. Words to say is now Scene.' + mingShown() + settingsShown(e));
      else say(e.label + ' picked.' + (isMing() ? (ov.mode === 'design' ? ' You can pick a built-in voice.' : ' Emotion, speed, pitch, volume, language and sound tags are shown.') : '') + settingsShown(e));
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
      var clip = $('ovVoice').value === 'clip'; $('ovClipBox').hidden = !clip; $('ovForget').hidden = clip; $('ovDownloadVoice').hidden = clip;
      if(!clip){
        $('ovForget').textContent = 'Remove ' + voiceName($('ovVoice').value) + ' from my list';
        $('ovDownloadVoice').textContent = 'Download ' + voiceName($('ovVoice').value);
      }
    }
    $('ovVoice').onchange = showVoice;
    /* Nov 16 2026, her words: "It won't let me just download the mp3 ... I like to collect/save my voice samples on my pc."
     * The file comes through the site's own download route (the owner's asset, re-signed from storage) and is saved
     * under the voice's own name. */
    function fileName(name){ return String(name || 'voice').replace(/[^A-Za-z0-9 ._,'()-]+/g, ' ').replace(/ +/g, ' ').trim().slice(0, 80) || 'voice'; }
    async function download(assetId, name){
      say('Downloading ' + name + '…');
      try {
        var r = await fetch('/api/kade/asset-download/' + encodeURIComponent(assetId), { headers: { 'Authorization': 'Bearer ' + token }, signal: AbortSignal.timeout(120000) });
        if(!r.ok) throw new Error('not ok');
        var blob = await r.blob();
        var ext = /wav/.test(blob.type) ? 'wav' : /ogg/.test(blob.type) ? 'ogg' : /mp4|m4a|aac/.test(blob.type) ? 'm4a' : 'mp3';
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fileName(name) + '.' + ext;
        document.body.appendChild(a); a.click();
        setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 60000);
        say('Saved ' + a.download + ' to your downloads.');
      } catch(e) { say('The download did not work. Try again.', true); }
    }
    $('ovDownloadVoice').onclick = function(){
      var id = $('ovVoice').value; if(!id || id === 'clip') return;
      return download(id, voiceName(id));
    };
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
      if(msg) say(msg); clearTimeout(ov.timer); ov.timer = setTimeout(poll, 3000);
    }
    /* A refusal names the control to change (the route's field); focus goes there when it is shown. */
    function focusField(field){
      var clip = $('ovVoice').value === 'clip';
      var ids = { text: 'ovText', language: 'ovLanguage', style: 'ovStyle', emotion: 'ovEmotion', speed: 'ovSpeed', pitch: 'ovPitch',
        volume: 'ovVolume', description: 'ovDescription', voice: 'ovBuiltin', clipWords: clip ? 'ovClipWords' : 'ovVoice',
        engine: 'ovEngine', seed: 'ovSeed', version: 'ovVersion', temperature: 'ovVariety', exaggeration: 'ovExaggeration', cfg_weight: 'ovSteadiness',
        language_id: 'ovCbLanguage', duration: 'ovDuration', steps: 'ovSteps', cfg: 'ovCfg', reference: clip ? 'ovClip' : 'ovVoice' };
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
    /* Nov 16 2026: the writer. Write it for me turns the idea into words in this engine's own format;
     * Format my words keeps her words and only shapes them. The answer replaces Words to say (or Scene),
     * and Put back the words I had restores what was there. Nothing is rendered and no GPU time is used. */
    ov.writing = false; ov.before = null;
    async function runWriter(how){
      if(ov.writing){ say('The writer is still working.'); return; }
      var body = { engine: $('ovEngine').value, mode: ov.mode, how: how, idea: $('ovIdea').value, words: $('ovText').value };
      if(isMing() && ov.mode === 'design') body.voice = $('ovBuiltin').value;
      if(ov.mode === 'design' && !builtinOn() && !isCb() && !isDb()) body.description = $('ovDescription').value;
      if(isCb()){ body.version = version().value; if(body.version === 'multilingual') body.language_id = $('ovCbLanguage').value; }
      if(isDb()) body.duration = $('ovDuration').value;
      if(how === 'write' && body.idea.trim().length < 3){ say('Type what it should say in the idea box first. One sentence is enough.', true); $('ovIdea').focus(); return; }
      if(how === 'format' && !body.words.trim()){ say('Type your words in ' + $('ovTextLabel').textContent + ' first.', true); $('ovText').focus(); return; }
      ov.writing = true; $('ovWrite').setAttribute('aria-disabled', 'true'); $('ovFormat').setAttribute('aria-disabled', 'true');
      say(how === 'write' ? 'Writing. This can take up to a minute or two.' : 'Formatting your words.');
      var r = await call('/open-voices/write', body, 150000);
      ov.writing = false; $('ovWrite').removeAttribute('aria-disabled'); $('ovFormat').removeAttribute('aria-disabled');
      if(!r.ok){ say(r.data.error || 'The writer had trouble. Try again.', true); if(r.data.field === 'idea') $('ovIdea').focus(); else focusField(r.data.field); return; }
      var had = $('ovText').value;
      if(had.trim() && had !== r.data.text){ ov.before = had; $('ovUndoWrite').hidden = false; }
      $('ovText').value = r.data.text || '';
      if(r.data.voice && !$('ovDescription').value.trim() && !ownHidden($('ovDescription'))) $('ovDescription').value = r.data.voice;
      say(r.data.spoken || 'Done. Read it over, then Make a take.');
      $('ovText').focus(); $('ovText').setSelectionRange(0, 0);
    }
    $('ovWrite').onclick = function(){ runWriter('write'); };
    $('ovFormat').onclick = function(){ runWriter('format'); };
    $('ovUndoWrite').onclick = function(){
      if(ov.before === null) return;
      $('ovText').value = ov.before; ov.before = null; $('ovUndoWrite').hidden = true;
      say('Your words are back in ' + $('ovTextLabel').textContent + '.'); $('ovText').focus();
    };
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
      addSettings(body);
      var own = isCb() || isDb();
      if(ov.mode === 'design'){ if(!builtinOn() && !own) body.description = $('ovDescription').value; }
      else {
        if(!own) body.style = $('ovStyle').value;
        if($('ovVoice').value === 'clip'){ if(!ov.clip){ say('Import a clip first, or pick a saved voice.', true); $('ovClip').focus(); return; } body.clipUrl = ov.clip.url; body.clipWords = $('ovClipWords').value; body.clipSeconds = ov.clip.seconds; }
        else body.voiceId = $('ovVoice').value;
      }
      /* Nov 16 2026: Takes per press makes up to four takes one after another (the bridge runs one take per person at
       * a time). A typed voice number goes up by one for each take after the first, so no two are the same. */
      var count = Math.max(1, Math.min(4, Number($('ovCount').value) || 1));
      ov.queue = count > 1 ? { body: body, total: count, made: 0 } : null;
      setBusy(true); $('ovStop').focus();
      await startTake(body, count > 1 ? 'Starting take 1 of ' + count + '…' : 'Starting a take…');
    };
    async function startTake(body, first){
      if(first) say(first);
      var r = await call('/open-voices/take', body);
      if(r.status === 409 && r.data.jobId){ ov.queue = null; follow(r.data.jobId, r.data.error || 'Your last take is still being made. The page will say when it is ready.'); return; }
      if(!r.ok){
        var q = ov.queue; ov.queue = null; setBusy(false);
        say((q && q.made ? q.made + ' of ' + q.total + ' takes were made. ' : '') + (r.data.error || 'The take could not start.'), true);
        if(!q || !q.made) focusField(r.data.field);
        return;
      }
      var msg = ov.queue && ov.queue.made ? '' : 'Making ' + (ov.queue ? ov.queue.total + ' takes, one after another.' : 'a take.');
      if(r.data.coldLikely && !ov.coldSaid[body.engine]){ ov.coldSaid[body.engine] = true; msg += ' ' + (r.data.coldNote || (cur() && cur().coldNote) || ov.coldNote); }
      follow(r.data.jobId, msg ? msg + ' The page will say when ' + (ov.queue ? 'each one is' : 'it is') + ' ready.' : '');
    }
    $('ovStop').onclick = async function(){
      if(!ov.jobId) return;
      var r = await call('/open-voices/stop', { jobId: ov.jobId });
      if(!r.ok){ say(r.data.error || 'Stop was not confirmed.', true); return; }
      var q = ov.queue; ov.queue = null;
      clearTimeout(ov.timer); ov.jobId = null; setBusy(false);
      say('Stopped. Nothing was kept from this take.' + (q && q.made ? ' The ' + q.made + ' already made are kept.' : ''));
    };
    async function poll(){
      if(!ov.jobId) return;
      var id = ov.jobId;
      var r = await call('/open-voices/take/' + encodeURIComponent(id));
      var d = r.data || {};
      if(id !== ov.jobId) return;
      if(r.ok && d.state === 'done' && d.url){
        ov.jobId = null;
        var q = ov.queue; if(q) q.made++;
        var more = !!q && q.made < q.total;
        if(!more){ ov.queue = null; setBusy(false); }
        addTake(d, id, q, more);
        if(more){
          var nb = Object.assign({}, q.body);
          if(String(nb.seed || '').trim() !== '') nb.seed = String(Number(nb.seed) + q.made);
          startTake(nb, '');
        }
        return;
      }
      /* A lost connection, a slow answer or a server hiccup is not the end of a take: keep checking.
       * Only a clear failed or stopped state, or a take the server no longer knows, ends it here. */
      var gone = r.status >= 400 && r.status < 500;
      if(gone || d.state === 'failed' || d.state === 'cancelled'){
        var fq = ov.queue; ov.queue = null; ov.jobId = null; setBusy(false);
        say((fq && fq.made ? fq.made + ' of ' + fq.total + ' takes were made. ' : '') + (d.error || 'The take did not finish.'), true); return;
      }
      if(d.spoken && Date.now() - ov.lastSpoken > 20000){ ov.lastSpoken = Date.now(); say(d.spoken); }
      ov.timer = setTimeout(poll, 3000);
    }
    function addTake(d, jobId, q, more){
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
      var assetId = d.assetId || null;
      var dl = document.createElement('button'); dl.type = 'button'; dl.className = 'act quiet'; dl.textContent = 'Download take ' + n;
      dl.onclick = async function(){
        if(!assetId){
          var r = await call('/open-voices/take/' + encodeURIComponent(jobId));
          assetId = (r.data && r.data.assetId) || null;
          if(!assetId){ say('Take ' + n + ' is still being saved. Try Download again in a moment.', true); return; }
        }
        return download(assetId, (name.value.trim() || (engine + ' take ' + n + ' voice ' + d.seed)));
      };
      li.appendChild(lab); li.appendChild(name); li.appendChild(keep); li.appendChild(dl);
      $('ovTakes').insertBefore(li, $('ovTakes').firstChild); $('ovTakesHeading').hidden = false;
      if(more){ say('Take ' + n + ' is ready, ' + q.made + ' of ' + q.total + '. Making the next one.'); return; }
      say('Take ' + n + ' is ready' + (q ? ', the last of ' + q.total : '') + '. Play it, download it, or keep it as a saved voice.');
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
