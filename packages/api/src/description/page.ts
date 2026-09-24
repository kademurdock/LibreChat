export function describedVideoPage(sharedHead: string): string {
  return `<!doctype html><html lang="en"><head><title>Described video — Kade-AI</title>${sharedHead}
<style>
  [hidden]{display:none!important} main{max-width:760px;margin:auto} h1{font-size:2rem} label{display:block;font-weight:650;margin-top:1rem}
  select,input,button{font:inherit} select,input[type=file]{max-width:100%;width:100%;padding:.65rem;border:1px solid #8a929f;border-radius:8px;background:Canvas;color:CanvasText}
  button,.download{display:inline-block;border:1px solid #65748a;border-radius:9px;padding:.75rem 1rem;min-height:46px;cursor:pointer;background:Canvas;color:CanvasText;text-decoration:none;margin:.3rem .3rem .3rem 0}
  button.primary{background:#174ab0;color:white;border-color:#174ab0;font-weight:700} button:disabled{opacity:.55;cursor:default}
  :focus-visible{outline:3px solid #dd9900;outline-offset:3px}.settings{display:grid;grid-template-columns:1fr 1fr;gap:1rem} .hint{font-size:.94rem;margin:.4rem 0;color:inherit;opacity:.85}
  progress{width:100%;height:1.25rem}video,audio{width:100%;margin:.7rem 0}video{max-height:65vh;background:#111} ul{padding-left:1.4rem}.eyebrow{font-size:.85rem;letter-spacing:.1em;text-transform:uppercase;color:#426494}
  @media(max-width:500px){.settings{grid-template-columns:1fr}}@media(prefers-color-scheme:dark){.eyebrow{color:#b7d1ff}}
</style></head><body><main>
<a class="back" href="/describe">Back to Describe</a><p class="eyebrow">Kade-AI · Audio description</p>
<h1>Make a described video</h1>
<p>Keep the actors, music, and sounds. Add a narrator who explains what happens on screen. Download the finished video or listen to an audio copy.</p>
<div id="dv-status" class="status" role="status" aria-live="polite">Signing you in…</div>
<p id="dv-error" role="alert" hidden></p><p id="dv-signin" hidden><a href="/login">Sign in to Kade-AI</a>, then return to this page.</p>
<section class="card" aria-labelledby="upload-heading"><h2 id="upload-heading">1. Choose your video</h2>
<label for="dv-file">Video file</label><input id="dv-file" type="file" accept="video/*,.mkv,.avi,.mov,.mp4,.webm,.m4v" disabled aria-describedby="dv-limits">
<p class="hint" id="dv-limits">Checking upload limits…</p><button id="dv-upload" class="primary" type="button" disabled>Upload and check video</button>
<progress id="dv-upload-progress" max="100" value="0" aria-label="Video upload progress" hidden></progress>
<button id="dv-stop-upload" type="button" hidden>Stop upload</button>
<p class="hint">Uploading and checking the duration do not start AI processing. After upload, the job stays here if you close the page.</p>
<label for="dv-youtube">Or paste a YouTube video link</label><input id="dv-youtube" type="url" placeholder="https://www.youtube.com/watch?v=…" aria-describedby="dv-youtube-help" disabled>
<p id="dv-youtube-help" class="hint">Import one finished video, then review the duration and processing estimate. Restricted videos or links that cannot be downloaded may need a file upload.</p><button id="dv-import" type="button" disabled>Import YouTube video</button>
</section>
<section class="card" aria-labelledby="settings-heading"><h2 id="settings-heading">2. Choose the narration</h2>
<fieldset id="dv-settings" disabled style="border:0;padding:0;margin:0"><legend class="hint">These settings are baked into the finished copy.</legend>
<label for="dv-voice">Narrator voice</label><select id="dv-voice" aria-describedby="dv-voice-description"><option>Loading your platform voices…</option></select><p id="dv-voice-description" class="hint"></p>
<div class="settings"><div><label for="dv-rate">Preferred narration speed</label><select id="dv-rate"><option value="1">1× — original voice rate</option><option value="1.25">1.25×</option><option value="1.5" selected>1.5×</option><option value="1.75">1.75×</option><option value="2">2×</option><option value="2.5">2.5×</option><option value="3">3×</option></select></div>
<div><label for="dv-max-rate">Fastest comfortable narration</label><select id="dv-max-rate"><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="1.75">1.75×</option><option value="2">2×</option><option value="2.25" selected>2.25×</option><option value="2.5">2.5×</option><option value="3">3×</option></select></div></div>
<p class="hint">The narrator speeds up within your limit when needed to fit a gap. The original dialogue stays at its original speed. Faster narration preserves the voice’s pitch.</p>
<label for="dv-mode">When a description cannot fit</label><select id="dv-mode" aria-describedby="dv-mode-help"><option value="extended">Pause the scene and add the description</option><option value="standard">Keep the original runtime; omit descriptions that cannot fit</option></select>
<p id="dv-mode-help" class="hint">Pause mode briefly freezes the picture and pauses the original soundtrack, then resumes both. The finished copy may be longer.</p>
</fieldset><p id="dv-estimate">Upload a video to see the estimated processing cost.</p>
<button id="dv-start" class="primary" type="button" disabled>Create described copy</button>
<p class="hint">AI can miss or misinterpret details. A transcript and timing report accompany each finished copy so omissions are visible.</p>
</section>
<section id="dv-job-section" class="card" aria-labelledby="dv-job-title" hidden><h2 id="dv-job-title">Your video</h2>
<p id="dv-stage"></p><progress id="dv-progress" max="100" value="0" aria-label="Description progress"></progress>
<p id="dv-cost" class="hint"></p><button id="dv-cancel" type="button">Cancel processing</button><button id="dv-delete" type="button" hidden>Delete this job and its files</button>
</section>
<section id="dv-results" class="card" aria-labelledby="dv-result-title" hidden><h2 id="dv-result-title" tabindex="-1">Your described copy</h2><p id="dv-summary"></p>
<video id="dv-video" controls preload="metadata" playsinline aria-label="Video with audio description"></video>
<label for="dv-playback-rate">Playback speed for the whole described copy</label><select id="dv-playback-rate"><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select>
<p class="hint">This changes the picture, original soundtrack, and narration together, keeping them synchronized.</p>
<p><a id="dv-video-download" class="download">Download described video</a> <a id="dv-audio-download" class="download">Download described audio</a> <a id="dv-script-download" class="download">Download script and timing report</a></p>
<details><summary>Listen to the audio copy</summary><audio id="dv-audio" controls preload="none" aria-label="Original soundtrack with audio description"></audio></details>
<button id="dv-refresh-files" type="button">Refresh playback and download links</button><p class="hint">Links last one hour. Finished copies are kept for seven days; download yours to keep it.</p>
</section>
<section class="card" aria-labelledby="history-heading"><h2 id="history-heading">Your recent videos</h2><button id="dv-refresh" type="button" disabled>Refresh video list</button><ul id="dv-history"></ul></section>
</main><script>${descriptionBrowserScript}</script></body></html>`;
}

export const descriptionBrowserScript: string = String.raw`
(function(){
  'use strict';
  var token='', job=null, catalog={}, timer=null, xhr=null, uploading=false, loadedFiles='', stopped=false, config=null;
  var $=function(id){return document.getElementById('dv-'+id);};
  function status(text){if($('status').textContent!==text)$('status').textContent=text;}
  function failure(error){$('error').hidden=false;$('error').textContent=error.message||String(error);}
  function clearError(){$('error').hidden=true;$('error').textContent='';}
  function duration(seconds){var n=Math.round(seconds||0);return Math.floor(n/60)+' minutes '+(n%60)+' seconds';}
  function money(value){return '$'+Number(value||0).toFixed(2);}
  async function refreshToken(){var response=await fetch('/api/auth/refresh',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw new Error('Please sign in to continue.');var data=await response.json().catch(function(){return null;});if(!data||!data.token)throw new Error('Please sign in to continue.');token=data.token;}
  async function api(path,method,body,retry){
    var response=await fetch('/api/kade/described-video'+path,{method:method||'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    if(response.status===401&&!retry){await refreshToken();return api(path,method,body,true);}
    var data=await response.json().catch(function(){return null;});if(!response.ok||!data){if(response.status===403)stopped=true;throw new Error(data&&data.error||'The request did not complete. Please refresh the page.');}return data;
  }
  function remember(){try{localStorage.setItem('kade-description-settings',JSON.stringify({voice:$('voice').value,rate:$('rate').value,maxRate:$('max-rate').value,mode:$('mode').value}));}catch(e){}}
  function settings(){return {voice:$('voice').value,rate:Number($('rate').value),maxRate:Number($('max-rate').value),mode:$('mode').value};}
  function controls(){
    var active=job&&!['done','failed','cancelled'].includes(job.state);
    var ready=job&&job.state==='ready';
    var processing=active&&job.state!=='uploading';
    $('upload').disabled=uploading||!!processing||!$('file').files.length||!config||!config.enabled;
    $('file').disabled=uploading||!!processing||!config||!config.enabled;
    $('youtube').disabled=uploading||!!active||!config||!config.enabled;
    $('import').disabled=uploading||!!active||!config||!config.enabled||!$('youtube').value.trim();
    $('upload').textContent=job&&job.state==='uploading'?'Resume upload and check video':'Upload and check video';
    $('settings').disabled=!config||!!(active&&!ready&&job.state!=='uploading'&&job.state!=='checking');
    $('start').disabled=!ready||Number($('max-rate').value)<Number($('rate').value);
    $('cancel').hidden=!active;$('cancel').disabled=!!(job&&job.cancelRequested);
    $('delete').hidden=!job||!['ready','uploading','done','failed','cancelled'].includes(job.state);
  }
  async function files(focus){
    if(!job||job.state!=='done')return;
    var result=await api('/jobs/'+job.id+'/files');
    $('video').src=result.video;$('audio').src=result.audio;
    $('video-download').href=result.videoDownload;$('audio-download').href=result.audioDownload;$('script-download').href=result.scriptDownload;
    $('results').hidden=false;loadedFiles=job.id;
    if(focus)$('result-title').focus();
  }
  async function show(data,focus){
    var changed=!job||job.id!==data.id;var previous=job&&job.state;job=data;
    if(changed){$('video').pause();$('audio').pause();$('results').hidden=true;loadedFiles='';}
    var url=new URL(location.href);url.searchParams.set('id',job.id);history.replaceState(null,'',url);
    $('job-section').hidden=false;$('job-title').textContent=job.name;$('stage').textContent=job.stage||job.state;$('progress').value=job.progress||0;
    $('cost').textContent='Processing usage so far: '+money(job.costUSD)+'. Speech and transcription amounts are conservative estimates; an interrupted provider request may still be charged.';
    if(job.seconds)$('estimate').textContent='Video length: '+duration(job.seconds)+'. Estimated processing: '+money(job.estimatedUSD)+'. This trial is paid by the platform, with a '+money(config.limitUSD)+' processing allowance per job and '+money(config.dailyUSD)+' daily allowance. Storage and downloads are separate. Pressing Create described copy starts paid processing.';
    if(job.error)failure(new Error(job.error));
    status(job.state==='ready'?'Video checked. Choose your narration settings, then create the described copy.':(job.stage||job.state));
    if(job.state==='done'){
      $('summary').textContent=job.descriptions+' spoken descriptions. Original length: '+duration(job.seconds)+'. Described length: '+duration(job.outputSeconds)+'. '+(job.skipped?job.skipped+' descriptions did not fit and were omitted; their text is in the report.':'No generated descriptions were omitted for lack of space.');
      if(loadedFiles!==job.id)await files(focus||previous==='running');
    }
    controls();
    if(job.state==='ready'&&previous!=='ready'&&focus)$('start').focus();
    if(timer)clearTimeout(timer);
    if(!stopped&&['checking','importing','reserving','queued','running'].includes(job.state))timer=setTimeout(poll,10000);
  }
  async function poll(){if(!job||stopped)return;try{await show(await api('/jobs/'+job.id),false);}catch(e){failure(e);if(!stopped)timer=setTimeout(poll,20000);}}
  async function list(){
    var data=await api('/jobs');$('history').textContent='';
    if(!data.jobs.length){var empty=document.createElement('li');empty.textContent='No videos yet.';$('history').appendChild(empty);}
    data.jobs.forEach(function(item){var li=document.createElement('li');var button=document.createElement('button');button.type='button';button.textContent=item.name+' — '+item.state;button.onclick=function(){clearError();api('/jobs/'+item.id).then(function(current){return show(current,true);}).catch(failure);};li.appendChild(button);$('history').appendChild(li);});
    return data.jobs;
  }
  $('file').addEventListener('change',controls);
  $('youtube').addEventListener('input',controls);
  $('import').onclick=async function(){
    clearError();var url=$('youtube').value.trim();if(!url)return;$('import').disabled=true;
    var key='kade-youtube-import:'+url;var requestId;try{requestId=sessionStorage.getItem(key);}catch(e){}
    requestId=requestId||crypto.randomUUID();try{sessionStorage.setItem(key,requestId);}catch(e){}
    try{
      var imported=await api('/imports','POST',{url:url,requestId:requestId});
      if(['failed','cancelled'].includes(imported.state)){requestId=crypto.randomUUID();try{sessionStorage.setItem(key,requestId);}catch(e){}imported=await api('/imports','POST',{url:url,requestId:requestId});}
      await show(imported,true);await list();
    }catch(e){failure(e);controls();}
  };
  ['voice','rate','max-rate','mode'].forEach(function(id){$(id).addEventListener('change',function(){
    if(id==='rate'&&Number($('max-rate').value)<Number($('rate').value))$('max-rate').value=$('rate').value;
    $('voice-description').textContent=(catalog.describe||{})[$('voice').value]||'Uses your existing Inworld or Fish platform voice.';
    $('mode-help').textContent=$('mode').value==='extended'?'Pause mode briefly freezes the picture and pauses the original soundtrack, then resumes both. The finished copy may be longer.':'The episode keeps its original runtime. Descriptions that cannot fit are omitted and listed in the report.';
    remember();controls();
  });});
  $('upload').onclick=async function(){
    clearError();var file=$('file').files[0];if(!file)return;
    if(file.size>config.maxBytes){failure(new Error('Choose a video no larger than 2 GB.'));return;}
    uploading=true;controls();
    try{
      var recoveryKey='kade-video-upload:'+file.name+':'+file.size+':'+file.lastModified;
      var requestId;try{requestId=sessionStorage.getItem(recoveryKey);}catch(e){}
      requestId=requestId||crypto.randomUUID();try{sessionStorage.setItem(recoveryKey,requestId);}catch(e){}
      var created=await api('/uploads','POST',{requestId:requestId,name:file.name,bytes:file.size,resumeId:job&&job.state==='uploading'?job.id:undefined});
      if(['failed','cancelled','done'].includes(created.job.state)){
        requestId=crypto.randomUUID();try{sessionStorage.setItem(recoveryKey,requestId);}catch(e){}
        created=await api('/uploads','POST',{requestId:requestId,name:file.name,bytes:file.size});
      }
      job=created.job;
      if(job.state==='uploading'){
        $('upload-progress').hidden=false;$('stop-upload').hidden=false;$('upload-progress').value=0;status('Uploading '+file.name+'.');
        var size=created.chunkBytes;var offset=job.uploadedBytes?Math.floor((job.uploadedBytes-1)/size)*size:0;var last=-1;
        while(offset<file.size){
          var result;
          for(var attempt=0;attempt<2;attempt++){
            result=await new Promise(function(resolve,reject){xhr=new XMLHttpRequest();xhr.open('POST','/api/kade/described-video/jobs/'+job.id+'/chunks');xhr.setRequestHeader('Authorization','Bearer '+token);xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.setRequestHeader('X-Part-Number',String(Math.floor(offset/size)+1));xhr.timeout=120000;
              xhr.upload.onprogress=function(event){if(event.lengthComputable){var value=Math.floor((offset+event.loaded)/file.size*100);$('upload-progress').value=value;if(Math.floor(value/10)!==last){last=Math.floor(value/10);status('Uploading: '+value+' percent.');}}};
              xhr.onload=function(){if(xhr.status===401){resolve(null);return;}var data;try{data=JSON.parse(xhr.responseText);}catch(e){}if(xhr.status>=200&&xhr.status<300&&data){resolve(data);return;}if(xhr.status===403)stopped=true;reject(new Error(data&&data.error||'Upload did not complete. Choose the same file to resume.'));};
              xhr.onerror=function(){reject(new Error('Upload connection lost. Choose the same file to resume.'));};xhr.onabort=function(){reject(new Error('Upload stopped. Your saved chunks can be resumed.'));};xhr.ontimeout=function(){reject(new Error('Upload timed out. Choose the same file to resume.'));};xhr.send(file.slice(offset,Math.min(file.size,offset+size)));
            });
            if(result)break;await refreshToken();
          }
          if(!result)throw new Error('Please sign in again to resume the upload.');
          job=result;offset+=size;
        }
      }
      await show(await api('/jobs/'+job.id+'/prepare','POST',{}),true);await list();
      try{sessionStorage.removeItem(recoveryKey);}catch(e){}
    }catch(e){failure(e);if(job)await show(job,false).catch(failure);}
    finally{uploading=false;xhr=null;$('upload-progress').hidden=true;$('stop-upload').hidden=true;controls();}
  };
  $('stop-upload').onclick=function(){if(xhr)xhr.abort();};
  $('start').onclick=async function(){clearError();$('start').disabled=true;try{remember();await show(await api('/jobs/'+job.id+'/start','POST',settings()),false);}catch(e){failure(e);controls();}};
  $('cancel').onclick=async function(){if(!job)return;clearError();$('cancel').disabled=true;try{await show(await api('/jobs/'+job.id+'/cancel','POST',{}),false);await list();}catch(e){failure(e);controls();}};
  $('delete').onclick=async function(){if(!job)return;clearError();$('delete').disabled=true;try{await api('/jobs/'+job.id,'DELETE');job=null;$('job-section').hidden=true;$('results').hidden=true;$('video').pause();$('audio').pause();history.replaceState(null,'',location.pathname);await list();status('Video job and its files deleted.');controls();}catch(e){failure(e);}finally{$('delete').disabled=false;}};
  $('refresh').onclick=function(){clearError();list().then(function(){if(job)return poll();}).catch(failure);};
  $('refresh-files').onclick=function(){files(false).catch(failure);};
  $('playback-rate').onchange=function(){var rate=Number(this.value);$('video').playbackRate=rate;$('audio').playbackRate=rate;};
  $('video').onplay=function(){$('audio').pause();};$('audio').onplay=function(){$('video').pause();};
  document.addEventListener('visibilitychange',function(){if(!document.hidden&&job&&!stopped)poll();});
  (async function(){try{
    await refreshToken();config=await api('/config');catalog=config;
    $('limits').textContent='Up to '+config.maxMinutes+' minutes and 2 GB. Your upload is private to your account and is sent to the video and voice services only when you create a described copy.';
    $('voice').textContent='';config.voices.forEach(function(voice){var option=document.createElement('option');option.value=voice;option.textContent=voice;$('voice').appendChild(option);});
    try{var saved=JSON.parse(localStorage.getItem('kade-description-settings')||'null');if(saved){if(config.voices.includes(saved.voice))$('voice').value=saved.voice;['rate','maxRate','mode'].forEach(function(key){var el=$(key==='maxRate'?'max-rate':key);if(Array.from(el.options).some(function(option){return option.value===String(saved[key]);}))el.value=String(saved[key]);});}}catch(e){}
    $('voice-description').textContent=(catalog.describe||{})[$('voice').value]||'Uses your existing Inworld or Fish platform voice.';
    $('refresh').disabled=false;var jobs=await list();var selected=new URLSearchParams(location.search).get('id');var current=jobs.find(function(item){return item.id===selected;})||jobs.find(function(item){return !['done','failed','cancelled'].includes(item.state);});
    if(current)await show(current,false);else status(config.enabled?'Choose a video to get started.':'The describer is not configured yet.');controls();
  }catch(e){failure(e);$('signin').hidden=!/sign in/i.test(e.message);status('Could not open the video describer.');}})();
})();`;
