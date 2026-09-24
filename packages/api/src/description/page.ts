const speeds = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3];
const speedOptions = (selected: number) =>
  speeds
    .map(
      (value) =>
        `<option value="${value}"${value === selected ? ' selected' : ''}>${value}×${value === 1 ? ' (the voice’s own pace)' : ''}</option>`,
    )
    .join('');

export function describedVideoPage(sharedHead: string): string {
  return `<!doctype html><html lang="en"><head><title>Make a described video — Kade-AI</title>${sharedHead}
<style>
  [hidden]{display:none!important} main{max-width:780px;margin:auto} h1{font-size:2rem}
  label,.label{display:block;font-weight:650;margin-top:1rem}
  select,input,button,textarea{font:inherit}
  select,input[type=file],input[type=url],input[type=text],textarea{max-width:100%;width:100%;padding:.65rem;border:1px solid #8a929f;border-radius:8px;background:Canvas;color:CanvasText}
  textarea{min-height:5.5rem;resize:vertical}
  button,.download{display:inline-block;border:1px solid #65748a;border-radius:9px;padding:.7rem 1rem;min-height:46px;cursor:pointer;background:Canvas;color:CanvasText;text-decoration:none;margin:.3rem .35rem .3rem 0}
  button.primary{background:#174ab0;color:#fff;border-color:#174ab0;font-weight:700}
  button.danger{border-color:#a3322a;color:#a3322a}
  button:disabled{opacity:.55;cursor:default}
  :focus-visible{outline:3px solid #dd9900;outline-offset:3px}
  .settings{display:grid;grid-template-columns:1fr 1fr;gap:0 1rem}
  .hint{font-size:.94rem;margin:.35rem 0;opacity:.85}
  .row{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem}
  .check{display:flex;gap:.5rem;align-items:center;font-weight:500;margin:.6rem 0}
  .check input{width:auto}
  progress{width:100%;height:1.25rem}
  video,audio{width:100%;margin:.7rem 0} video{max-height:65vh;background:#111;border-radius:10px}
  pre{white-space:pre-wrap;word-wrap:break-word;max-height:28rem;overflow:auto;padding:.8rem;border:1px solid #8a929f;border-radius:8px;font:inherit}
  ul.jobs{list-style:none;padding:0;margin:.5rem 0} ul.jobs li{margin:.25rem 0} ul.jobs button{width:100%;text-align:left}
  .eyebrow{font-size:.85rem;letter-spacing:.1em;text-transform:uppercase;color:#426494;margin:.8rem 0 0}
  .or{margin:1.4rem 0 .2rem;font-weight:700}
  @media(max-width:560px){.settings{grid-template-columns:1fr}}
  @media(prefers-color-scheme:dark){.eyebrow{color:#b7d1ff} button.danger{color:#ff9b93;border-color:#ff9b93}}
</style></head><body><main>
<a class="back" href="/describe">Back to Describe</a><p class="eyebrow">Kade-AI · Audio description</p>
<h1>Make a described video</h1>
<p>Keep the actors, music and sound. A narrator describes what happens on screen in the pauses. Then watch it here, download the video or the audio, or read the whole thing as a described transcript.</p>
<div id="dv-status" class="status" role="status" aria-live="polite">Signing you in…</div>
<p id="dv-error" role="alert" hidden></p><p id="dv-signin" hidden><a href="/login">Sign in to Kade-AI</a>, then come back to this page.</p>

<section class="card" aria-labelledby="source-heading"><h2 id="source-heading">1. Choose a video</h2>
<label for="dv-file">A video file from this device</label><input id="dv-file" type="file" accept="video/*,.mkv,.avi,.mov,.mp4,.webm,.m4v,.wmv,.mpg,.mpeg" disabled aria-describedby="dv-limits">
<p class="hint" id="dv-limits">Checking upload limits…</p>
<div class="row"><button id="dv-upload" class="primary" type="button" disabled>Upload and check video</button><button id="dv-stop-upload" type="button" hidden>Stop upload</button></div>
<progress id="dv-upload-progress" max="100" value="0" aria-label="Upload progress" hidden></progress>
<p class="or">Or a YouTube link</p>
<label for="dv-youtube">YouTube video link</label><input id="dv-youtube" type="url" inputmode="url" placeholder="https://www.youtube.com/watch?v=…" aria-describedby="dv-youtube-help" disabled>
<p id="dv-youtube-help" class="hint">One finished video, not a channel or playlist. If YouTube refuses the server, download it and upload the file instead.</p>
<button id="dv-import" type="button" disabled>Import YouTube video</button>
<div id="dv-library-box" hidden><p class="or">Or a video from your Library</p>
<label for="dv-library">Library link</label><input id="dv-library" type="url" inputmode="url" placeholder="https://kademurdock.com/library?book=…" aria-describedby="dv-library-help">
<p id="dv-library-help" class="hint">Open the video in the Library and copy the page's address, or use Make a described copy on the video itself. Nothing is uploaded again.</p>
<button id="dv-library-use" type="button" disabled>Use this library video</button></div>
<p class="hint">Checking a video is free. Paid processing starts only when you choose Create described copy. You can line up to 10 videos.</p>
</section>

<section class="card" aria-labelledby="settings-heading"><h2 id="settings-heading">2. Choose the narration</h2>
<fieldset id="dv-settings" disabled style="border:0;padding:0;margin:0"><legend class="hint">These choices are built into the finished copy.</legend>
<label for="dv-voice">Narrator voice</label><select id="dv-voice" aria-describedby="dv-voice-description"><option>Loading your platform voices…</option></select>
<p id="dv-voice-description" class="hint"></p>
<div class="row"><button id="dv-sample-play" type="button">Play a sample of this voice</button></div>
<audio id="dv-sample" controls hidden aria-label="Voice sample"></audio>
<div class="settings">
<div><label for="dv-rate">Usual narration speed</label><select id="dv-rate">${speedOptions(1.5)}</select></div>
<div><label for="dv-max-rate">Fastest it may go to fit a gap</label><select id="dv-max-rate">${speedOptions(2.25)}</select></div>
</div>
<p class="hint">Only the narrator speeds up; dialogue keeps its own pace, and the voice keeps its pitch.</p>
<label for="dv-detail">How much to describe</label><select id="dv-detail" aria-describedby="dv-detail-help">
<option value="essential">Essentials only: key actions, scene changes and on-screen text</option>
<option value="standard" selected>Standard: essentials plus people, places and expressions</option>
<option value="rich">Rich detail: colors, clothing, logos and more, as room allows</option></select>
<p id="dv-detail-help" class="hint">Rich detail suits commercials, logos and VHS openings; essentials suit dialogue-heavy shows.</p>
<label for="dv-mode">When a description cannot fit between lines</label><select id="dv-mode" aria-describedby="dv-mode-help"><option value="extended">Pause the picture and sound, describe, then carry on</option><option value="standard">Keep the original length and leave that description out</option></select>
<p id="dv-mode-help" class="hint">Pausing makes the copy a little longer. Minor details are left out rather than pausing for them.</p>
<label for="dv-volume">Narrator volume</label><select id="dv-volume"><option value="softer">Softer: about as loud as the dialogue</option><option value="balanced" selected>Balanced: a little above the dialogue</option><option value="louder">Louder: well above, with the video turned further down</option></select>
<label for="dv-notes">Notes for the describer (optional)</label><textarea id="dv-notes" maxlength="600" aria-describedby="dv-notes-help"></textarea>
<p id="dv-notes-help" class="hint">What the video is and who is in it. For example: a 1996 VHS opening; the man in the red sweater is Uncle Bob.</p>
</fieldset>
<p id="dv-estimate">Choose a video to see the estimated cost.</p>
<div class="row"><button id="dv-start" class="primary" type="button" disabled>Create described copy</button><button id="dv-revoice" type="button" hidden>Make a new version with this narration</button></div>
<p id="dv-revoice-help" class="hint" hidden>A new version reuses the descriptions already written, so it costs only the voice. How much to describe and the notes stay as they were. The new version replaces the current one when it finishes.</p>
</section>

<section id="dv-job-section" class="card" aria-labelledby="dv-job-title" hidden><h2 id="dv-job-title">Your video</h2>
<p id="dv-stage"></p><progress id="dv-progress" max="100" value="0" aria-label="Progress"></progress>
<p id="dv-eta" class="hint"></p><p id="dv-cost" class="hint"></p>
<div class="row"><button id="dv-cancel" type="button">Cancel processing</button><button id="dv-resume" class="primary" type="button" hidden>Continue where it stopped</button><button id="dv-rename" type="button">Rename</button><button id="dv-delete" class="danger" type="button" hidden>Delete this video and its files</button></div>
</section>

<section id="dv-results" class="card" aria-labelledby="dv-result-title" hidden><h2 id="dv-result-title" tabindex="-1">Your described copy</h2><p id="dv-summary"></p>
<video id="dv-video" controls preload="metadata" playsinline aria-label="Video with audio description"></video>
<div class="row" role="group" aria-label="Player">
<button id="dv-back" type="button">Back 10 seconds</button><button id="dv-play" type="button">Play</button><button id="dv-forward" type="button">Forward 10 seconds</button>
<button id="dv-prev-cue" type="button">Previous description</button><button id="dv-next-cue" type="button">Next description</button></div>
<label for="dv-playback-rate">Playback speed for everything</label><select id="dv-playback-rate"><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="1.75">1.75×</option><option value="2">2×</option></select>
<p class="hint">This speeds up the picture, the soundtrack and the narration together.</p>
<h3>Downloads</h3>
<p class="row"><a id="dv-video-download" class="download">Described video (MP4)</a><a id="dv-audio-download" class="download">Described audio (M4A)</a><a id="dv-transcript-download" class="download">Described transcript (text)</a><a id="dv-captions-download" class="download">Captions (WebVTT)</a><a id="dv-descriptions-download" class="download">Descriptions (WebVTT)</a><a id="dv-script-download" class="download">Timing report (JSON)</a></p>
<details id="dv-transcript-box"><summary>Read the described transcript</summary><pre id="dv-transcript" tabindex="0" aria-label="Described transcript"></pre></details>
<details><summary>Listen to the audio copy</summary><audio id="dv-audio" controls preload="none" aria-label="Soundtrack with audio description"></audio></details>
<div id="dv-library-save-box" hidden><h3>Keep it in your Library</h3>
<label class="check"><input id="dv-share" type="checkbox" checked> Share it with the family</label>
<button id="dv-library-save" type="button">Save the described audio to my Library</button><p id="dv-library-note" class="hint"></p></div>
<button id="dv-refresh-files" type="button">Refresh playback and download links</button><p class="hint">Finished copies are kept for seven days; download yours or save it to the Library to keep it.</p>
</section>

<section class="card" aria-labelledby="history-heading"><h2 id="history-heading">Your videos</h2><button id="dv-refresh" type="button" disabled>Refresh the list</button><ul id="dv-history" class="jobs"></ul></section>
</main><script>${descriptionBrowserScript}</script></body></html>`;
}

export const descriptionBrowserScript: string = String.raw`
(function(){
  'use strict';
  var token='', job=null, catalog={}, timer=null, xhr=null, uploading=false, loadedFiles='', stopped=false, config=null;
  var lastSpoken='', lastSpokenAt=0, cues=[], trackUrls=[];
  var $=function(id){return document.getElementById('dv-'+id);};
  var active=function(j){return j&&['uploading','checking','importing','ready','reserving','queued','running','deleting'].indexOf(j.state)>=0;};
  var working=function(j){return j&&['checking','importing','reserving','queued','running'].indexOf(j.state)>=0;};
  function say(text,force){var now=Date.now();if(!force&&text===lastSpoken)return;if(!force&&now-lastSpokenAt<45000&&lastSpoken.split(' ')[0]===text.split(' ')[0])return;lastSpoken=text;lastSpokenAt=now;$('status').textContent=text;}
  function failure(error){$('error').hidden=false;$('error').textContent=error.message||String(error);}
  function clearError(){$('error').hidden=true;$('error').textContent='';}
  function length(seconds){var n=Math.round(seconds||0),h=Math.floor(n/3600),m=Math.floor(n%3600/60),s=n%60;var parts=[];if(h)parts.push(h+(h===1?' hour':' hours'));if(m)parts.push(m+(m===1?' minute':' minutes'));if(s||!parts.length)parts.push(s+(s===1?' second':' seconds'));return parts.join(' ');}
  function clock(seconds){var n=Math.max(0,Math.floor(seconds||0)),h=Math.floor(n/3600),m=Math.floor(n%3600/60),s=('0'+n%60).slice(-2);return h?h+':'+('0'+m).slice(-2)+':'+s:m+':'+s;}
  function money(value){return '$'+Number(value||0).toFixed(2);}
  function when(value){if(!value)return '';var d=new Date(value);return d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' '+d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});}
  function friendly(j){
    if(j.state==='uploading')return 'upload not finished';
    if(j.state==='checking')return 'checking the video';
    if(j.state==='importing')return 'importing from YouTube';
    if(j.state==='ready')return 'ready to describe';
    if(j.state==='reserving'||j.state==='queued')return j.stage==='Continuing after a server restart'?'continuing after a server restart':'waiting for its turn';
    if(j.state==='running')return 'describing, '+(j.progress||0)+' percent';
    if(j.state==='done')return 'finished';
    if(j.state==='failed')return 'stopped';
    if(j.state==='cancelled')return 'cancelled';
    return j.state;
  }
  async function refreshToken(){var response=await fetch('/api/auth/refresh',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw new Error('Please sign in to continue.');var data=await response.json().catch(function(){return null;});if(!data||!data.token)throw new Error('Please sign in to continue.');token=data.token;}
  async function call(path,method,body,retry,kind){
    var response=await fetch('/api/kade/described-video'+path,{method:method||'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    if(response.status===401&&!retry){await refreshToken();return call(path,method,body,true,kind);}
    if(response.ok&&kind==='text')return response.text();
    if(response.ok&&kind==='blob')return response.blob();
    var data=await response.json().catch(function(){return null;});if(!response.ok||!data){if(response.status===403)stopped=true;throw new Error(data&&data.error||'The request did not complete. Please refresh the page.');}return data;
  }
  function remember(){try{localStorage.setItem('kade-description-settings',JSON.stringify(settings()));}catch(e){}}
  function settings(){return {voice:$('voice').value,rate:Number($('rate').value),maxRate:Number($('max-rate').value),mode:$('mode').value,detail:$('detail').value,volume:$('volume').value,notes:$('notes').value.trim()};}
  function estimate(){
    if(!job||!job.seconds||!config)return;
    var perMinute=(config.perMinuteUSD||{})[$('detail').value]||0.05;var cost=Math.ceil((job.seconds/60*perMinute+0.03)*100)/100;
    $('estimate').textContent=job.state==='done'?'A new version costs about '+money(Math.ceil((job.seconds/60*perMinute*0.5+0.02)*100)/100)+', the voice only.':'Video length: '+length(job.seconds)+'. Estimated cost: about '+money(cost)+'. Today\'s processing allowance has '+money(config.remainingUSD)+' of '+money(config.dailyUSD)+' left.';
  }
  function controls(){
    var busy=working(job), ready=job&&job.state==='ready', done=job&&job.state==='done';
    var off=!config||!config.enabled;
    $('file').disabled=uploading||off;
    $('upload').disabled=uploading||off||!$('file').files.length;
    $('upload').textContent=job&&job.state==='uploading'?'Resume upload and check video':'Upload and check video';
    $('youtube').disabled=uploading||off;
    $('import').disabled=uploading||off||!$('youtube').value.trim();
    $('library-use').disabled=uploading||off||!libraryLink($('library').value);
    $('settings').disabled=!config||(!!busy&&!ready);
    ['detail','notes'].forEach(function(id){$(id).disabled=!!done;});
    $('start').hidden=!!done;$('start').disabled=!ready||Number($('max-rate').value)<Number($('rate').value);
    $('revoice').hidden=!done;$('revoice-help').hidden=!done;$('revoice').disabled=!done||Number($('max-rate').value)<Number($('rate').value);
    $('cancel').hidden=!busy;$('cancel').disabled=!!(job&&job.cancelRequested);
    $('resume').hidden=!(job&&job.resumable);$('resume').textContent=job&&job.done?'Continue where it stopped':'Try again';
    $('delete').hidden=!job||['ready','uploading','done','failed','cancelled'].indexOf(job.state)<0;
    $('rename').hidden=!job;
    estimate();
  }
  function libraryLink(value){try{var url=new URL(value.trim(),location.origin);var book=url.searchParams.get('book');if(!book||!/^[a-f0-9]{24}$/.test(book))return null;return {book:book,track:Math.max(0,Number(url.searchParams.get('track'))||0)};}catch(e){return null;}}
  function parseVtt(text){var list=[];text.split(/\n\n+/).forEach(function(block){var m=/(\d\d):(\d\d):(\d\d)\.(\d\d\d) --> [^\n]+\n([\s\S]+)/.exec(block);if(m)list.push({at:Number(m[1])*3600+Number(m[2])*60+Number(m[3])+Number(m[4])/1000,text:m[5].trim()});});return list;}
  async function track(kind,label,show){
    var text=await call('/jobs/'+job.id+'/text/'+kind,'GET',undefined,false,'text');
    var url=URL.createObjectURL(new Blob([text],{type:'text/vtt'}));trackUrls.push(url);
    var el=document.createElement('track');el.kind=kind==='descriptions'?'descriptions':'captions';el.label=label;el.srclang='en';el.src=url;$('video').appendChild(el);
    if(kind==='descriptions')cues=parseVtt(text);
    return el;
  }
  async function files(focus){
    if(!job||job.state!=='done')return;
    var result=await call('/jobs/'+job.id+'/files');
    trackUrls.forEach(function(url){URL.revokeObjectURL(url);});trackUrls=[];
    Array.prototype.slice.call($('video').querySelectorAll('track')).forEach(function(el){el.remove();});
    $('video').src=result.video;$('audio').src=result.audio;
    [['video','video'],['audio','audio'],['transcript','transcript'],['captions','captions'],['descriptions','descriptions'],['script','script']].forEach(function(pair){var link=$(pair[0]+'-download');link.hidden=!result[pair[1]+'Download'];if(result[pair[1]+'Download'])link.href=result[pair[1]+'Download'];});
    $('results').hidden=false;loadedFiles=job.id;
    $('library-save-box').hidden=!config.library;
    $('library-save').disabled=!!job.savedToLibrary;$('library-note').textContent=job.savedToLibrary?'Saved to your Library.':'';
    await Promise.all([result.descriptions?track('descriptions','Audio descriptions'):null,result.captions?track('captions','Dialogue captions'):null]).catch(function(){});
    if(result.transcript)call('/jobs/'+job.id+'/text/transcript','GET',undefined,false,'text').then(function(text){$('transcript').textContent=text;}).catch(function(){$('transcript').textContent='The transcript could not be loaded. Use the download link instead.';});
    if(focus)$('result-title').focus();
  }
  async function show(data,focus){
    var changed=!job||job.id!==data.id;var previous=job&&job.state;job=data;
    if(changed){$('video').pause();$('audio').pause();$('results').hidden=true;loadedFiles='';cues=[];$('transcript').textContent='';}
    var url=new URL(location.href);url.searchParams.set('id',job.id);url.searchParams.delete('book');url.searchParams.delete('track');history.replaceState(null,'',url);
    $('job-section').hidden=false;$('job-title').textContent=job.name;
    $('stage').textContent=job.state==='failed'?'Stopped before finishing.':(job.stage||friendly(job));
    $('progress').value=job.progress||0;$('progress').hidden=!working(job);
    $('eta').textContent=job.etaSeconds?'About '+length(Math.max(60,Math.round(job.etaSeconds/60)*60))+' left.':'';
    $('cost').textContent=job.costUSD?'Processing cost so far: '+money(job.costUSD)+(job.estimatedUSD?' (estimate '+money(job.estimatedUSD)+')':'')+'. Work already sent to a service may still be charged if you cancel.':'';
    if(job.error)failure(new Error(job.error));
    if(job.state==='ready'){say('Video checked. Choose the narration, then Create described copy.');}
    else if(job.state==='running'){var section=/section (\d+) of (\d+)/.exec(job.stage||'');say(section?'Describing: section '+section[1]+' of '+section[2]+'.':(job.stage||'Describing.'));}
    else if(job.state!=='done')say(job.stage||friendly(job));
    if(job.state==='done'){
      $('summary').textContent=job.descriptions+' descriptions. Original length '+length(job.seconds)+'; described copy '+length(job.outputSeconds)+'. '+(job.skipped?job.skipped+' descriptions did not fit and are listed at the end of the transcript. ':'')+(job.failedSections?job.failedSections+' parts could not be described; the transcript says which. ':'')+(job.version>1?'This is version '+job.version+'.':'');
      if(previous&&previous!=='done')say('Your described copy is ready.',true);
      if(loadedFiles!==job.id)await files(focus||(!!previous&&previous!=='done'));
    }
    controls();
    if(job.state==='ready'&&previous!=='ready'&&focus)$('voice').focus();
    if(timer)clearTimeout(timer);
    if(!stopped&&working(job))timer=setTimeout(poll,document.hidden?20000:5000);
  }
  async function poll(){if(!job||stopped)return;try{await show(await call('/jobs/'+job.id),false);}catch(e){failure(e);if(!stopped)timer=setTimeout(poll,20000);}}
  async function list(){
    var data=await call('/jobs');$('history').textContent='';
    if(!data.jobs.length){var empty=document.createElement('li');empty.textContent='No videos yet.';$('history').appendChild(empty);}
    data.jobs.forEach(function(item){var li=document.createElement('li');var button=document.createElement('button');button.type='button';button.textContent=item.name+', '+friendly(item)+(item.seconds?', '+length(item.seconds):'')+(item.createdAt?', '+when(item.createdAt):'');if(job&&job.id===item.id)button.setAttribute('aria-current','true');button.onclick=function(){clearError();call('/jobs/'+item.id).then(function(current){return show(current,true);}).catch(failure);};li.appendChild(button);$('history').appendChild(li);});
    return data.jobs;
  }
  function describeVoice(){$('voice-description').textContent=(catalog.describe||{})[$('voice').value]||'One of your platform voices.';}
  function fillVoices(){
    var select=$('voice');select.textContent='';var placed={};
    (config.categories||[]).forEach(function(group){var og=document.createElement('optgroup');og.label=group.name;group.voices.forEach(function(voice){if(config.voices.indexOf(voice)<0||placed[voice])return;placed[voice]=1;var option=document.createElement('option');option.value=voice;option.textContent=voice;og.appendChild(option);});if(og.children.length)select.appendChild(og);});
    var rest=config.voices.filter(function(voice){return !placed[voice];});
    if(rest.length){var og=document.createElement('optgroup');og.label='Other voices';rest.forEach(function(voice){var option=document.createElement('option');option.value=voice;option.textContent=voice;og.appendChild(option);});select.appendChild(og);}
    if(config.defaultVoice)select.value=config.defaultVoice;
  }
  $('file').addEventListener('change',controls);
  $('youtube').addEventListener('input',controls);
  $('library').addEventListener('input',controls);
  ['voice','rate','max-rate','mode','detail','volume','notes'].forEach(function(id){$(id).addEventListener('change',function(){
    if(id==='rate'&&Number($('max-rate').value)<Number($('rate').value))$('max-rate').value=$('rate').value;
    if(id==='max-rate'&&Number($('max-rate').value)<Number($('rate').value))$('rate').value=$('max-rate').value;
    describeVoice();$('sample').hidden=true;remember();controls();
  });});
  $('sample-play').onclick=async function(){
    clearError();$('sample-play').disabled=true;say('Making a sample of '+$('voice').value+'.',true);
    try{var blob=await call('/sample','POST',{voice:$('voice').value,rate:Number($('rate').value)},false,'blob');var audio=$('sample');if(audio.src)URL.revokeObjectURL(audio.src);audio.src=URL.createObjectURL(blob);audio.hidden=false;await audio.play().catch(function(){});say('Playing the sample.',true);}
    catch(e){failure(e);}finally{$('sample-play').disabled=false;}
  };
  $('import').onclick=async function(){
    clearError();var url=$('youtube').value.trim();if(!url)return;$('import').disabled=true;
    var key='kade-youtube-import:'+url;var id;try{id=sessionStorage.getItem(key);}catch(e){}
    id=id||crypto.randomUUID();try{sessionStorage.setItem(key,id);}catch(e){}
    try{
      var imported=await call('/imports','POST',{url:url,requestId:id});
      if(['failed','cancelled','done'].indexOf(imported.state)>=0){id=crypto.randomUUID();try{sessionStorage.setItem(key,id);}catch(e){}imported=await call('/imports','POST',{url:url,requestId:id});}
      $('youtube').value='';await show(imported,true);await list();
    }catch(e){failure(e);controls();}
  };
  $('library-use').onclick=async function(){
    clearError();var link=libraryLink($('library').value);if(!link)return;$('library-use').disabled=true;
    try{var created=await call('/library-imports','POST',{book:link.book,track:link.track,requestId:crypto.randomUUID()});$('library').value='';await show(created,true);await list();}catch(e){failure(e);controls();}
  };
  $('upload').onclick=async function(){
    clearError();var file=$('file').files[0];if(!file)return;
    if(file.size>config.maxBytes){failure(new Error('Choose a video no larger than 2 GB.'));return;}
    uploading=true;controls();
    try{
      var recoveryKey='kade-video-upload:'+file.name+':'+file.size+':'+file.lastModified;
      var id;try{id=sessionStorage.getItem(recoveryKey);}catch(e){}
      id=id||crypto.randomUUID();try{sessionStorage.setItem(recoveryKey,id);}catch(e){}
      var created=await call('/uploads','POST',{requestId:id,name:file.name,bytes:file.size,resumeId:job&&job.state==='uploading'&&job.name===file.name&&job.bytes===file.size?job.id:undefined});
      if(['failed','cancelled','done'].indexOf(created.job.state)>=0){id=crypto.randomUUID();try{sessionStorage.setItem(recoveryKey,id);}catch(e){}created=await call('/uploads','POST',{requestId:id,name:file.name,bytes:file.size});}
      job=created.job;
      if(job.state==='uploading'){
        $('upload-progress').hidden=false;$('stop-upload').hidden=false;$('upload-progress').value=0;say('Uploading '+file.name+'.',true);
        var size=created.chunkBytes;var offset=job.uploadedBytes?Math.floor((job.uploadedBytes-1)/size)*size:0;var last=-1;
        while(offset<file.size){
          var result;
          for(var attempt=0;attempt<3;attempt++){
            result=await new Promise(function(resolve,reject){xhr=new XMLHttpRequest();xhr.open('POST','/api/kade/described-video/jobs/'+job.id+'/chunks');xhr.setRequestHeader('Authorization','Bearer '+token);xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.setRequestHeader('X-Part-Number',String(Math.floor(offset/size)+1));xhr.timeout=180000;
              xhr.upload.onprogress=function(event){if(event.lengthComputable){var value=Math.floor((offset+event.loaded)/file.size*100);$('upload-progress').value=value;if(Math.floor(value/10)!==last){last=Math.floor(value/10);say('Uploading: '+value+' percent.',true);}}};
              xhr.onload=function(){if(xhr.status===401){resolve(null);return;}var data;try{data=JSON.parse(xhr.responseText);}catch(e){}if(xhr.status>=200&&xhr.status<300&&data){resolve(data);return;}if(xhr.status===403)stopped=true;reject(new Error(data&&data.error||'Upload did not complete. Choose the same file to resume.'));};
              xhr.onerror=function(){resolve('retry');};xhr.onabort=function(){reject(new Error('Upload stopped. Choose the same file to carry on from where it stopped.'));};xhr.ontimeout=function(){resolve('retry');};xhr.send(file.slice(offset,Math.min(file.size,offset+size)));
            });
            if(result&&result!=='retry')break;
            if(result===null)await refreshToken();else await new Promise(function(r){setTimeout(r,3000*(attempt+1));});
          }
          if(!result||result==='retry')throw new Error('The upload connection keeps dropping. Choose the same file to carry on from where it stopped.');
          job=result;offset+=size;
        }
      }
      await show(await call('/jobs/'+job.id+'/prepare','POST',{}),true);await list();
      try{sessionStorage.removeItem(recoveryKey);}catch(e){}
      $('file').value='';
    }catch(e){failure(e);if(job)await show(job,false).catch(failure);}
    finally{uploading=false;xhr=null;$('upload-progress').hidden=true;$('stop-upload').hidden=true;controls();}
  };
  $('stop-upload').onclick=function(){if(xhr)xhr.abort();};
  $('start').onclick=async function(){clearError();$('start').disabled=true;try{remember();await show(await call('/jobs/'+job.id+'/start','POST',settings()),false);say('Started. You can leave this page; the job keeps going, and you will get a notice when it is done.',true);await list();}catch(e){failure(e);controls();}};
  $('revoice').onclick=async function(){
    if(!job)return;var s=settings();
    if(!confirm('Make a new version of "'+job.name+'" with '+s.voice+' at '+s.rate+'×? It replaces the current copy when it finishes, so download the current one first if you want to keep it.'))return;
    clearError();$('revoice').disabled=true;try{remember();await show(await call('/jobs/'+job.id+'/revoice','POST',s),false);$('results').hidden=true;loadedFiles='';say('Making the new version.',true);await list();}catch(e){failure(e);controls();}
  };
  $('resume').onclick=async function(){if(!job)return;clearError();$('resume').disabled=true;try{await show(await call('/jobs/'+job.id+'/resume','POST',{}),false);say('Carrying on from where it stopped.',true);await list();}catch(e){failure(e);}finally{$('resume').disabled=false;controls();}};
  $('cancel').onclick=async function(){if(!job)return;if(!confirm('Cancel processing "'+job.name+'"? Finished sections are kept, so you can continue later.'))return;clearError();$('cancel').disabled=true;try{await show(await call('/jobs/'+job.id+'/cancel','POST',{}),false);await list();}catch(e){failure(e);controls();}};
  $('rename').onclick=async function(){if(!job)return;var name=prompt('New name for this video',job.name);if(!name||!name.trim()||name.trim()===job.name)return;clearError();try{await show(await call('/jobs/'+job.id+'/rename','POST',{name:name.trim()}),false);loadedFiles='';if(job.state==='done')await files(false);await list();say('Renamed to '+job.name+'.',true);}catch(e){failure(e);}};
  $('delete').onclick=async function(){if(!job)return;if(!confirm('Delete "'+job.name+'" and all its files? This cannot be undone.'))return;clearError();$('delete').disabled=true;try{await call('/jobs/'+job.id,'DELETE');job=null;$('job-section').hidden=true;$('results').hidden=true;$('video').pause();$('audio').pause();history.replaceState(null,'',location.pathname);await list();say('Deleted.',true);controls();}catch(e){failure(e);}finally{$('delete').disabled=false;}};
  $('library-save').onclick=async function(){if(!job)return;clearError();$('library-save').disabled=true;try{var saved=await call('/jobs/'+job.id+'/library','POST',{share:$('share').checked});job.savedToLibrary=saved.savedToLibrary;$('library-note').textContent='Saved to your Library'+(saved.path?' in '+saved.path:'')+'.';say($('library-note').textContent,true);}catch(e){failure(e);$('library-save').disabled=false;}};
  $('refresh').onclick=function(){clearError();list().then(function(){if(job)return poll();}).catch(failure);};
  $('refresh-files').onclick=function(){loadedFiles='';files(false).catch(failure);};
  $('playback-rate').onchange=function(){var rate=Number(this.value);$('video').playbackRate=rate;$('audio').playbackRate=rate;};
  $('video').onplay=function(){$('audio').pause();$('play').textContent='Pause';};$('video').onpause=function(){$('play').textContent='Play';};
  $('audio').onplay=function(){$('video').pause();};
  var expired=false;$('video').onerror=function(){if(expired||!job)return;expired=true;loadedFiles='';files(false).then(function(){expired=false;}).catch(failure);};
  $('play').onclick=function(){var v=$('video');if(v.paused)v.play().catch(failure);else v.pause();};
  $('back').onclick=function(){var v=$('video');v.currentTime=Math.max(0,v.currentTime-10);say('At '+clock(v.currentTime)+'.',true);};
  $('forward').onclick=function(){var v=$('video');v.currentTime=Math.min(v.duration||0,v.currentTime+10);say('At '+clock(v.currentTime)+'.',true);};
  function jump(step){var v=$('video');if(!cues.length){say('No descriptions are loaded yet.',true);return;}var now=v.currentTime,target=null;
    if(step>0){for(var i=0;i<cues.length;i++)if(cues[i].at>now+0.6){target=cues[i];break;}}else{for(var j=cues.length-1;j>=0;j--)if(cues[j].at<now-1.2){target=cues[j];break;}}
    if(!target){say(step>0?'That was the last description.':'That was the first description.',true);return;}
    v.currentTime=Math.max(0,target.at-0.3);say(clock(target.at)+'. '+target.text,true);}
  $('next-cue').onclick=function(){jump(1);};$('prev-cue').onclick=function(){jump(-1);};
  document.addEventListener('visibilitychange',function(){if(!document.hidden&&job&&!stopped&&working(job))poll();});
  (async function(){try{
    await refreshToken();config=await call('/config');catalog=config;
    $('limits').textContent='Up to '+config.maxMinutes+' minutes and 2 GB. Your video stays private to your account and goes to the description and voice services only when you choose Create described copy.';
    $('library-box').hidden=!config.library;
    fillVoices();
    try{var saved=JSON.parse(localStorage.getItem('kade-description-settings')||'null');if(saved){if(config.voices.indexOf(saved.voice)>=0)$('voice').value=saved.voice;[['rate','rate'],['maxRate','max-rate'],['mode','mode'],['detail','detail'],['volume','volume']].forEach(function(pair){var el=$(pair[1]);if(Array.prototype.some.call(el.options,function(option){return option.value===String(saved[pair[0]]);}))el.value=String(saved[pair[0]]);});}}catch(e){}
    describeVoice();$('refresh').disabled=false;
    var jobs=await list();var params=new URLSearchParams(location.search);var selected=params.get('id');
    var current=jobs.filter(function(item){return item.id===selected;})[0]||jobs.filter(function(item){return working(item);})[0];
    if(params.get('book')&&config.library){$('library').value=location.origin+'/library?book='+params.get('book')+'&track='+(params.get('track')||0);say('Library video chosen. Press Use this library video to check it.',true);$('library-use').disabled=false;$('library-use').focus();}
    if(current)await show(current,false);else if(!params.get('book'))say(config.enabled?'Choose a video to get started.':'The describer is not set up yet.',true);
    controls();
  }catch(e){failure(e);$('signin').hidden=!/sign in/i.test(e.message);say('Could not open the video describer.',true);}})();
})();`;
