const speeds = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3];
/** Words a minute at 1×, measured on the platform voices (126–185, median about 150). */
const wordsPerMinute = 145;
const pace = (value: number): string =>
  `roughly ${Math.round((wordsPerMinute * value) / 10) * 10} words a minute`;
const speedOptions = (selected: number): string =>
  speeds
    .map(
      (value) =>
        `<option value="${value}"${value === selected ? ' selected' : ''}>${value}×${value === 1 ? ', the voice’s own pace' : ''}, ${pace(value)}</option>`,
    )
    .join('');
const uploadTypes =
  'video/*,.mkv,.avi,.mov,.mp4,.webm,.m4v,.wmv,.mpg,.mpeg,.ts,.mts,.m2ts,.vob,.dv,.3gp,.flv,.mxf,.mod,.tod';

export function describedVideoPage(sharedHead: string): string {
  return `<!doctype html><html lang="en"><head><title>Make a described video — Kade-AI</title>${sharedHead}
<style>
  *,*::before,*::after{box-sizing:border-box}
  details{margin:.7rem 0} summary{cursor:pointer;min-height:44px;padding:.4rem 0}
  [hidden]{display:none!important} main{max-width:780px;margin:auto;overflow-wrap:break-word} h1{font-size:2rem}
  label,.label{display:block;font-weight:650;margin-top:1rem}
  select,input,button,textarea{font:inherit;max-width:100%}
  select,input[type=file],input[type=url],input[type=text],input[type=search],textarea{width:100%;padding:.65rem;border:1px solid #8a929f;border-radius:8px;background:Canvas;color:CanvasText}
  textarea{min-height:5.5rem;resize:vertical}
  button,.download{display:inline-block;border:1px solid #65748a;border-radius:9px;padding:.7rem 1rem;min-height:46px;cursor:pointer;background:Canvas;color:CanvasText;text-decoration:none;margin:.3rem .35rem .3rem 0;white-space:normal;text-align:left}
  button.primary{background:#174ab0;color:#fff;border-color:#174ab0;font-weight:700}
  button.danger{border-color:#a3322a;color:#a3322a}
  button:disabled,button[aria-disabled=true]{opacity:.6;cursor:default}
  :focus-visible{outline:3px solid #174ab0;outline-offset:3px;box-shadow:0 0 0 3px #fff}
  fieldset{border:0;padding:0;margin:0;min-width:0}
  legend{font-weight:700;padding:0;margin-top:1rem}
  .settings{display:grid;grid-template-columns:1fr 1fr;gap:0 1rem} .settings>div{min-width:0}
  .hint{font-size:.94rem;margin:.35rem 0;opacity:.85}
  .field-error{font-weight:650;color:#a3322a;margin:.35rem 0}
  .row{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem}
  .check{display:flex;gap:.5rem;align-items:flex-start;font-weight:500;margin:.6rem 0}
  .check input{width:auto;margin-top:.35rem;flex:none}
  progress{width:100%;height:1.25rem}
  video,audio{width:100%;max-width:100%;margin:.7rem 0} video{max-height:65vh;background:#111;border-radius:10px}
  .transcript{max-height:28rem;overflow:auto;padding:.8rem;border:1px solid #8a929f;border-radius:8px}
  .transcript p{margin:.2rem 0}
  ul.jobs{list-style:none;padding:0;margin:.5rem 0} ul.jobs li{margin:.25rem 0} ul.jobs button{width:100%}
  .eyebrow{font-size:.85rem;letter-spacing:.1em;text-transform:uppercase;color:#426494;margin:.8rem 0 0}
  @media(max-width:560px){.settings{grid-template-columns:1fr} h1{font-size:1.6rem}}
  @media(prefers-color-scheme:dark){.eyebrow{color:#b7d1ff} button.danger,.field-error{color:#ff9b93;border-color:#ff9b93} :focus-visible{outline-color:#9cc2ff;box-shadow:0 0 0 3px #14161a}}
</style></head><body><main>
<a class="back" href="/describe">Back to Describe</a><p class="eyebrow">Kade-AI · Audio description</p>
<h1>Make a described video</h1>
<p>Keep the actors, music and sound. A narrator describes what happens on screen in the pauses. Then watch it here, download the video or the audio, or read the whole thing as a described transcript.</p>
<p id="dv-prices" class="hint" hidden></p>
<div id="dv-status" class="status" role="status" aria-live="polite">Signing you in…</div>
<p id="dv-error" role="alert" hidden></p><p id="dv-signin" hidden><a href="/login">Sign in to Kade-AI</a>, then come back to this page.</p>
<p id="dv-skip" hidden><a href="#dv-result-title">Go to your described copy</a></p>

<section id="dv-job-section" class="card" aria-labelledby="dv-job-title" hidden><h2 id="dv-job-title" tabindex="-1">Your video</h2>
<p id="dv-stage"></p><progress id="dv-progress" max="100" value="0" aria-label="Progress"></progress>
<p id="dv-eta" class="hint"></p><p id="dv-cost" class="hint"></p>
<div class="row"><button id="dv-cancel" type="button">Cancel processing</button><button id="dv-resume" class="primary" type="button" aria-describedby="dv-resume-price dv-resume-note" hidden>Continue where it stopped</button><button id="dv-allow-more" class="primary" type="button" aria-describedby="dv-over-quote" hidden>Allow more and continue</button><button id="dv-recheck" class="primary" type="button" aria-describedby="dv-recheck-help" hidden>Check again</button><button id="dv-abandon" type="button" aria-describedby="dv-abandon-help" hidden>Go back to the last finished version</button><button id="dv-rename" type="button">Rename</button><button id="dv-delete" class="danger" type="button" hidden>Delete this video and its files</button></div>
<p id="dv-over-quote" hidden></p><p id="dv-resume-price" class="hint" hidden></p><p id="dv-resume-note" class="hint" hidden></p><p id="dv-abandon-help" class="hint" hidden></p>
<p id="dv-recheck-help" class="hint" hidden>The check was interrupted before it finished. Checking again is free.</p>
<label for="dv-progress-pref">Tell me about progress</label><select id="dv-progress-pref"><option value="section">After every section</option><option value="quarter" selected>Every quarter of the way</option><option value="end">Only when it finishes</option></select>
</section>

<section id="dv-results" class="card" aria-labelledby="dv-result-title" hidden><h2 id="dv-result-title" tabindex="-1">Your described copy</h2>
<p id="dv-expiry"></p><button id="dv-keep" type="button" aria-describedby="dv-expiry" hidden>Keep 7 more days</button><p id="dv-summary"></p>
<div id="dv-preview-box" hidden><p id="dv-preview-note"></p><button id="dv-finish" class="primary" type="button" aria-describedby="dv-preview-note">Describe the rest</button><button id="dv-change-settings" type="button">Change settings and try the preview again</button></div>
<div id="dv-redo-box" hidden><button id="dv-redo" type="button" aria-describedby="dv-redo-help">Try again on the parts that could not be described</button><p id="dv-redo-help" class="hint">Only those parts are described again; everything else is reused.</p></div>
<div id="dv-new-version" hidden><p id="dv-new-version-note"></p><button id="dv-switch-version" type="button">Switch to the new version</button></div>
<h3>Watch or listen</h3>
<label for="dv-version">Finished version</label><select id="dv-version"></select>
<label for="dv-play-as">Play as</label><select id="dv-play-as"><option value="video">Video</option><option value="audio">Audio only (keeps playing with the screen locked)</option></select>
<video id="dv-video" controls preload="metadata" playsinline aria-label="Video with audio description"></video>
<audio id="dv-audio" controls preload="metadata" aria-label="Soundtrack with audio description" hidden></audio>
<div class="row" role="group" aria-label="Player">
<button id="dv-back" type="button">Back 10 seconds</button><button id="dv-play" type="button">Play</button><button id="dv-forward" type="button">Forward 10 seconds</button>
<button id="dv-prev-cue" type="button">Previous description</button><button id="dv-next-cue" type="button">Next description</button><button id="dv-read-cue" type="button">Read the current description</button><button id="dv-correct-cue" type="button">Correct this description</button></div>
<p id="dv-position-note" class="hint"></p>
<label for="dv-playback-rate">Playback speed for everything</label><select id="dv-playback-rate" aria-describedby="dv-playback-help"><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="1.75">1.75×</option><option value="2">2×</option></select>
<p id="dv-playback-help" class="hint">This speeds up the picture, the soundtrack and the narration together.</p>
<h3>Downloads</h3>
<p class="row"><a id="dv-video-download" class="download">Described video (MP4)</a><a id="dv-audio-download" class="download">Described audio (M4A)</a><a id="dv-transcript-download" class="download">Described transcript (text)</a><a id="dv-captions-download" class="download">Captions (WebVTT)</a><a id="dv-descriptions-download" class="download">Descriptions (WebVTT)</a><a id="dv-script-download" class="download">Timing report (JSON)</a></p>
<details id="dv-transcript-box"><summary>Read the described transcript</summary><h3>Described transcript</h3>
<label for="dv-find">Find in the transcript</label><input id="dv-find" type="search" aria-describedby="dv-find-help"><p id="dv-find-help" class="hint">Press Enter or Find next to move to the next line with these words.</p><button id="dv-find-next" type="button">Find next</button>
<div id="dv-transcript" class="transcript" role="region" aria-label="Described transcript lines" tabindex="0"></div></details>
<details id="dv-editor"><summary>Correct a description and make a new version</summary>
<p>Correct the full and short wording, leave a description out, or describe one part again with a note. Timing stays attached to the same scene. Changes are saved as a draft on this browser until you make the new version.</p>
<p id="dv-draft-note" class="hint" hidden></p>
<button id="dv-edit-load" type="button">Open the latest script</button><p id="dv-edit-problem" class="field-error" hidden></p>
<div id="dv-stale" hidden><p>These corrections were drafted for an earlier version and no longer match its descriptions. Enter again any you still need.</p><ol id="dv-stale-list"></ol><button id="dv-stale-forget" type="button">Forget these old corrections</button></div>
<fieldset id="dv-edit-fields" hidden><legend>Your script changes</legend>
<label for="dv-edit-show">Show</label><select id="dv-edit-show"><option value="all">Every description</option><option value="unspoken">Only descriptions that were not spoken</option><option value="changed">Only descriptions I changed</option></select>
<label for="dv-edit-cue">Description to correct</label><select id="dv-edit-cue"></select>
<div class="row"><button id="dv-edit-prev" type="button">Previous description</button><button id="dv-edit-next" type="button">Next description</button><button id="dv-edit-listen" type="button">Listen around this description</button></div>
<label for="dv-edit-text">Full description</label><textarea id="dv-edit-text" maxlength="420" aria-describedby="dv-edit-error dv-edit-status"></textarea>
<p id="dv-edit-error" class="field-error" hidden></p>
<label for="dv-edit-short">Short version for a tight gap</label><textarea id="dv-edit-short" maxlength="200"></textarea>
<label class="check"><input id="dv-edit-omit" type="checkbox"> Leave this description out</label>
<p id="dv-edit-status"></p><button id="dv-edit-copy-short" type="button" hidden>Use the corrected wording for the short version too</button>
<div class="row"><button id="dv-edit-save" class="primary" type="button">Make a new version with my corrections</button><button id="dv-edit-review" type="button">Review my changes</button><button id="dv-edit-undo" type="button">Undo changes to this description</button><button id="dv-edit-reset" type="button">Discard all draft changes</button></div>
<ol id="dv-edit-review-list" tabindex="-1" aria-label="Your changes" hidden></ol>
<label for="dv-edit-note">Note for describing this part again (optional)</label><input id="dv-edit-note" type="text" maxlength="300" aria-describedby="dv-edit-note-help"><p id="dv-edit-note-help" class="hint">For example: the woman is Aunt Carol; the sign says Meeks. Only this part is looked at again.</p>
<button id="dv-edit-redo" type="button">Describe this part again</button>
</fieldset></details>
<div id="dv-library-save-box" hidden><h3>Keep it in your Library</h3>
<label for="dv-folder">Library folder</label><input id="dv-folder" type="text" list="dv-folders" maxlength="400" aria-describedby="dv-folder-help"><datalist id="dv-folders"></datalist><p id="dv-folder-help" class="hint">Choose an existing folder or type a new folder path, such as Audio/Commercials/1996. Leave it empty to use the usual folder.</p>
<label class="check"><input id="dv-share" type="checkbox" checked aria-describedby="dv-share-help"> Share it with the family</label><p id="dv-share-help" class="hint" hidden></p>
<button id="dv-library-save" type="button">Save the described audio to my Library</button><p id="dv-library-note" class="hint"></p><p id="dv-library-save-error" class="field-error" hidden></p></div>
<button id="dv-refresh-files" type="button">Refresh playback and download links</button><p class="hint">Links refresh themselves when they get old; use this if playback still will not start. Finished copies are kept for seven days; download yours or save it to the Library to keep it.</p>
</section>

<section class="card" aria-labelledby="dv-source-heading"><h2 id="dv-source-heading">1. Choose a video</h2>
<label for="dv-file">A video file from this device</label><input id="dv-file" type="file" accept="${uploadTypes}" disabled aria-describedby="dv-limits dv-upload-error">
<p class="hint" id="dv-limits">Checking upload limits…</p>
<div class="row"><button id="dv-upload" class="primary" type="button" disabled>Upload and check video</button><button id="dv-stop-upload" type="button" hidden>Stop upload</button></div>
<progress id="dv-upload-progress" max="100" value="0" aria-label="Upload progress" hidden></progress><p id="dv-upload-error" class="field-error" hidden></p>
<h3>Or a YouTube link</h3>
<label for="dv-youtube">YouTube video link</label><input id="dv-youtube" type="url" inputmode="url" placeholder="https://www.youtube.com/watch?v=…" aria-describedby="dv-youtube-help" disabled>
<p id="dv-youtube-help" class="hint">One finished video, not a channel or playlist. If YouTube refuses the server, download it and upload the file instead.</p>
<button id="dv-import" type="button" disabled>Import YouTube video</button>
<div id="dv-library-box" hidden><h3>Or a video from your Library</h3>
<label for="dv-library">Library link</label><input id="dv-library" type="url" inputmode="url" placeholder="https://kademurdock.com/library?book=…" aria-describedby="dv-library-help dv-library-error">
<p id="dv-library-help" class="hint">Open the video in the Library and copy the page's address, or use Make a described copy on the video itself. Nothing is uploaded again.</p><p id="dv-library-error" class="field-error" hidden></p>
<button id="dv-library-use" type="button" disabled>Use this library video</button></div>
<p class="hint">Checking a video is free. Paid processing starts only when you choose to try a preview or create the described copy. You can line up to 10 videos.</p>
</section>

<section class="card" aria-labelledby="dv-settings-heading"><h2 id="dv-settings-heading" tabindex="-1">2. Choose the narration</h2>
<fieldset id="dv-settings" disabled><legend>Narration choices</legend>
<p class="hint">These choices are built into the finished copy.</p>
<fieldset id="dv-presets"><legend>What kind of video is it?</legend>
<label class="check"><input type="radio" name="dv-preset" id="dv-preset-commercials" value="commercials"> <span>Commercials and logos: rich detail, a closer look at text and logos, keeps the original length<span id="dv-preset-commercials-price"></span></span></label>
<label class="check"><input type="radio" name="dv-preset" id="dv-preset-tv" value="tv"> <span>TV show: standard detail, keeps the original length<span id="dv-preset-tv-price"></span></span></label>
<label class="check"><input type="radio" name="dv-preset" id="dv-preset-film" value="film"> <span>Film: standard detail, pauses the picture when a description needs room; the whole-film first look is offered below<span id="dv-preset-film-price"></span></span></label>
<label class="check"><input type="radio" name="dv-preset" id="dv-preset-custom" value="custom"> <span>My own choices (open Customize below)</span></label>
</fieldset>
<label for="dv-voice-kind">Kind of voice</label><select id="dv-voice-kind"><option value="all">All voices</option></select>
<label for="dv-voice">Narrator voice</label><select id="dv-voice" aria-describedby="dv-voice-description"><option>Loading your platform voices…</option></select>
<p id="dv-voice-description" class="hint"></p>
<div class="row"><button id="dv-sample-play" type="button">Play a sample of this voice</button><button id="dv-sample-fast" type="button">Play the sample at the fastest speed</button></div>
<audio id="dv-sample" controls hidden aria-label="Voice sample"></audio>
<details id="dv-pronounce"><summary>Test how the voice says a word or name</summary>
<label for="dv-say-text">Words to say</label><input id="dv-say-text" type="text" maxlength="200" aria-describedby="dv-say-help"><p id="dv-say-help" class="hint">Up to 200 characters, such as a name or a place. Narration and pronunciation samples are included.</p>
<button id="dv-say-play" type="button">Say these words</button></details>
<details id="dv-customize"><summary>Customize speed, detail, pauses and volume</summary>
<div class="settings">
<div><label for="dv-rate">Usual narration speed</label><select id="dv-rate">${speedOptions(1.5)}</select></div>
<div><label for="dv-max-rate">Fastest it may go to fit a gap</label><select id="dv-max-rate">${speedOptions(2.25)}</select></div>
</div>
<p class="hint">Only the narrator speeds up; dialogue keeps its own pace, and the voice keeps its pitch. Word rates differ a little from voice to voice.</p>
<label for="dv-detail">How much to describe</label><select id="dv-detail" aria-describedby="dv-detail-help">
<option value="essential">Essentials only: key actions, scene changes and on-screen text</option>
<option value="standard" selected>Standard: essentials plus people, places and expressions</option>
<option value="rich">Rich detail: colors, clothing, logos and more, as room allows</option></select>
<p id="dv-detail-help" class="hint">Rich detail suits commercials, logos and VHS openings; essentials suit dialogue-heavy shows.</p>
<label for="dv-mode">When a description doesn't fit between spoken lines</label><select id="dv-mode" aria-describedby="dv-mode-help"><option value="extended">Pause the picture and sound, describe, then carry on</option><option value="standard">Keep the original length and leave that description out</option></select>
<p id="dv-mode-help" class="hint">Pausing makes the copy a little longer. Minor details are left out rather than pausing for them.</p>
<label for="dv-volume">Narrator volume</label><select id="dv-volume"><option value="softer">Softer: a little below the dialogue</option><option value="balanced" selected>Balanced: just above the dialogue</option><option value="louder">Louder: well above it</option></select>
</details>
<fieldset id="dv-passes"><legend>Extra passes (cost more)</legend>
<label class="check"><input id="dv-close-look" type="checkbox" aria-describedby="dv-close-look-help"> Take a closer look at fast scenes, text and logos (costs more)</label>
<p id="dv-close-look-help" class="hint">Inspects a slower, larger copy. The finished video keeps its normal pace. Takes longer.</p>
<label class="check"><input id="dv-first-look" type="checkbox" aria-describedby="dv-first-look-help"> Look through the whole film first to learn who is who (costs more)</label>
<p id="dv-first-look-help" class="hint">An extra pass for consistent names and appearances. Names are still introduced only when the film reveals them. Not used for videos of two minutes or less.</p>
</fieldset>
<details id="dv-part"><summary>Describe only part of it</summary>
<p id="dv-part-help" class="hint">Type times as hours:minutes:seconds, like 1:12:30, or minutes:seconds, like 4:05. Leave From empty to start at the beginning, or To empty to go to the end.</p>
<div class="settings">
<div><label for="dv-part-from">From</label><input id="dv-part-from" type="text" inputmode="numeric" autocomplete="off" aria-describedby="dv-part-help dv-part-error"></div>
<div><label for="dv-part-to">To</label><input id="dv-part-to" type="text" inputmode="numeric" autocomplete="off" aria-describedby="dv-part-help dv-part-error"></div>
</div>
<p id="dv-part-error" class="field-error" hidden></p><p id="dv-part-summary" class="hint"></p></details>
<label for="dv-notes">Notes for the describer (optional)</label><textarea id="dv-notes" maxlength="600" aria-describedby="dv-notes-help"></textarea>
<p id="dv-notes-help" class="hint">What the video is and who is in it. For example: a 1996 VHS opening; the man in the red sweater is Uncle Bob. Notes belong to this video only.</p>
</fieldset>
<p id="dv-estimate">Choose a video to see the estimated cost.</p>
<div class="row"><button id="dv-preview" class="primary" type="button" aria-describedby="dv-estimate" hidden>Try the first 3 minutes</button><button id="dv-start" class="primary" type="button" aria-describedby="dv-estimate" hidden>Create described copy</button><button id="dv-preview-again" class="primary" type="button" aria-describedby="dv-estimate" hidden>Try the preview again with these choices</button><button id="dv-revoice" type="button" aria-describedby="dv-estimate dv-revoice-help dv-revoice-note" hidden>Make a new version with this narration</button><button id="dv-reanalyze" type="button" aria-describedby="dv-estimate" hidden>Write fresh descriptions with these choices</button><button id="dv-rehearse" type="button" aria-describedby="dv-rehearse-help" hidden>Free rehearsal (test tone, no paid services)</button></div>
<p id="dv-rehearse-help" class="hint" hidden>Runs every step with a test tone in place of the paid services, to check that storage, the notice and the player work. Nothing is charged, and the copy is labelled as a rehearsal.</p>
<p id="dv-revoice-help" class="hint" hidden>A new version with this narration reuses the descriptions already written, and narration is included. To change the detail, notes or extra passes, use Write fresh descriptions instead. Finished versions stay available until this video expires.</p>
<p id="dv-revoice-note" class="hint" hidden></p>
</section>

<section class="card" aria-labelledby="dv-history-heading"><h2 id="dv-history-heading" tabindex="-1">Your videos</h2><button id="dv-refresh" type="button" disabled>Refresh the list</button><ul id="dv-history" class="jobs"></ul></section>
</main><script>${descriptionBrowserScript}</script></body></html>`;
}

export const descriptionBrowserScript: string = String.raw`
(function(){
  'use strict';
  var SETTINGS_KEY='kade-description-settings',RECENT_KEY='kade-description-recent-voices',UPLOADS_KEY='kade-video-uploads',PROGRESS_KEY='kade-description-progress',PLAY_AS_KEY='kade-description-play-as';
  var LINK_AGE=5.5*3600*1000,BASE_TITLE='Make a described video — Kade-AI';
  var FORM_DEFAULTS={rate:1.5,maxRate:2.25,mode:'extended',detail:'standard',volume:'balanced'};
  var PRESETS={commercials:{detail:'rich',mode:'standard',closeLook:true,firstLook:false},tv:{detail:'standard',mode:'standard',closeLook:false,firstLook:false},film:{detail:'standard',mode:'extended',closeLook:false}};
  var PRESET_NAMES={commercials:'Commercials and logos',tv:'TV show',film:'Film'};
  var DETAIL_NAMES={essential:'Essentials only',standard:'Standard detail',rich:'Rich detail'};
  var BUSY=['checking','importing','reserving','queued','running'];
  var token='',job=null,shownId='',config=null,catalog={},timer=null,listTimer=null,pollController=null,openSeq=0,xhr=null,uploading=false,uploadId='',stopUpload=false,stopped=false,signedOutSaid=false,inflight=false,voicesOff=false;
  var loadedFiles='',fileRequest=0,filesAt=0,viewVersion=0,versionsSig='',lastLatest=0,pendingSwitch=0,cues=[],trackUrls=[],lastJump=null,refreshedErrorKey='',found=-1,lastSaved=0;
  var script=null,scriptJob='',edits={},editing='',shortTouched={},staleDrafts=[],warnedShort={};
  var lastSpoken='',lastSpokenAt=0,errorFrom='',estimates={},estimateSeq=0,estimateTimer=null,announceNext=false,announcePrefix='',presetSeq=0,presetSig='',redoSeq=0,redoTimer=null,redoEstimate=null;
  var listedIds='',listButtons={},listStates={},lastJobs=[],cancelSeenAt=0,lastQuarter=-1;
  var wakeLock=null,wakeWanted=false,nudge=null,pendingUpload=null,pendingJob='',toldKeepOpen='';
  var DEFAULT_FOLDER='Audio/Described Movies & TV/Described by Kade-AI';
  var $=function(id){return document.getElementById('dv-'+id);};
  function working(j){return !!j&&BUSY.indexOf(j.state)>=0;}
  function ended(m){return m.paused||m.ended;}
  function playing(){return !ended($('video'))||!ended($('audio'))||!ended($('sample'));}
  function media(){return $('play-as').value==='audio'?$('audio'):$('video');}
  function say(text,force){
    if(!text)return;var now=Date.now(),status=$('status');
    if(!force){if(text===lastSpoken||playing())return;if(now-lastSpokenAt<45000&&lastSpoken.split(' ')[0]===text.split(' ')[0])return;}
    if(force&&text===lastSpoken&&status.textContent===text){status.textContent='';setTimeout(function(){status.textContent=text;},100);}
    else status.textContent=text;
    lastSpoken=text;lastSpokenAt=now;
  }
  function showSignin(){$('signin').hidden=false;}
  function signedOut(){stopped=true;if(timer)clearTimeout(timer);timer=null;if(listTimer)clearTimeout(listTimer);listTimer=null;showSignin();if(!signedOutSaid){signedOutSaid=true;say('You were signed out. Sign in, then come back to this page.',true);}}
  function failure(error,where,from){
    if(error&&error.name==='AbortError')return;
    var message=error&&error.message||String(error);
    if(error&&error.auth){signedOut();return;}
    $('error').hidden=false;if($('error').textContent!==message)$('error').textContent=message;errorFrom=from||'action';
    if(/sign in/i.test(message))showSignin();
    if(where){var box=$(where);box.textContent=message;box.hidden=false;}
  }
  function clearError(){$('error').hidden=true;$('error').textContent='';errorFrom='';['upload-error','library-save-error','edit-problem'].forEach(function(id){$(id).hidden=true;$(id).textContent='';});}
  function plural(n,one,many){return n+' '+(n===1?one:many);}
  function length(seconds){var n=Math.round(seconds||0),h=Math.floor(n/3600),m=Math.floor(n%3600/60),s=n%60;var parts=[];if(h)parts.push(plural(h,'hour','hours'));if(m)parts.push(plural(m,'minute','minutes'));if(s||!parts.length)parts.push(plural(s,'second','seconds'));return parts.join(' ');}
  function clock(seconds){var n=Math.max(0,Math.floor(seconds||0)),h=Math.floor(n/3600),m=Math.floor(n%3600/60),s=('0'+n%60).slice(-2);return h?h+':'+('0'+m).slice(-2)+':'+s:m+':'+s;}
  function money(value){return '$'+Number(value||0).toFixed(2);}
  function when(value){if(!value)return '';var d=new Date(value);return d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' '+d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});}
  function voiceName(voice){var name=String(voice||'').split('·').pop().trim();return name?name.charAt(0).toUpperCase()+name.slice(1):'the narrator';}
  function pause(ms){return new Promise(function(resolve){var id=setTimeout(finish,ms);function finish(){clearTimeout(id);if(nudge===finish)nudge=null;resolve();}nudge=finish;});}
  async function holdScreen(){
    wakeWanted=true;if(wakeLock&&!wakeLock.released)return true;wakeLock=null;
    if(document.hidden||!navigator||!navigator.wakeLock||!navigator.wakeLock.request)return false;
    try{var lock=await navigator.wakeLock.request('screen');if(!wakeWanted){letGo(lock);return false;}wakeLock=lock;return true;}catch(e){return false;}
  }
  function letGo(lock){try{var released=lock.release();if(released&&released.catch)released.catch(function(){});}catch(e){}}
  function releaseScreen(){wakeWanted=false;var lock=wakeLock;wakeLock=null;if(lock&&!lock.released)letGo(lock);}
  function uuid(){return crypto.randomUUID();}
  function stored(key,fallback){try{var value=JSON.parse(localStorage.getItem(key)||'null');return value===null||value===undefined?fallback:value;}catch(e){return fallback;}}
  function store(key,value){try{localStorage.setItem(key,JSON.stringify(value));return true;}catch(e){return false;}}
  function forget(key){try{localStorage.removeItem(key);}catch(e){}}
  function focusable(el){return !!el&&el.offsetParent!==null;}
  function land(id,from){var target=$(id),current=document.activeElement;if(!target)return;if(!current||current===document.body||current===from||!focusable(current))target.focus();}
  function inField(){var el=document.activeElement;return !!el&&['INPUT','TEXTAREA','SELECT'].indexOf(el.tagName)>=0;}
  function lost(){var error=new Error('Could not reach Kade-AI. Check the connection and try again.');error.network=true;return error;}
  async function refreshToken(){
    var response;try{response=await fetch('/api/auth/refresh',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:'{}'});}catch(e){throw lost();}
    var data=response.ok?await response.json().catch(function(){return null;}):null;
    if(!data||!data.token){var error=new Error('You were signed out. Sign in, then come back to this page.');error.auth=true;signedOut();throw error;}
    token=data.token;
  }
  async function call(path,method,body,retry,kind,signal){
    var controller=new AbortController(),limit=setTimeout(function(){controller.abort();},30000);
    var relay=function(){controller.abort();};if(signal){if(signal.aborted)controller.abort();else signal.addEventListener('abort',relay);}
    var response;
    try{response=await fetch('/api/kade/described-video'+path,{method:method||'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});}
    catch(e){if(signal&&signal.aborted){var aborted=new Error('Stopped.');aborted.name='AbortError';throw aborted;}throw lost();}
    finally{clearTimeout(limit);if(signal)signal.removeEventListener('abort',relay);}
    if(response.status===401&&!retry){await refreshToken();return call(path,method,body,true,kind,signal);}
    if(response.ok&&kind==='text')return response.text();
    if(response.ok&&kind==='blob')return response.blob();
    var data=await response.json().catch(function(){return null;});
    if(response.ok&&data)return data;
    if(response.status===403)stopped=true;
    var error=new Error(data&&data.error||(response.status>=500?'Kade-AI had a problem with that request. Try again in a minute.':'The request did not complete. Please try again.'));
    error.status=response.status;error.field=data&&data.field;error.network=response.status>=500;
    if(response.status===401){error.auth=true;signedOut();}
    throw error;
  }
  function stageText(j){return String(j.stage||'').replace(/^First look:/,'Learning who is who:');}
  function waiting(j){
    if(j.stage==='Continuing after a server restart')return 'Continuing after a server restart';
    if(typeof j.queuePosition==='number')return j.queuePosition>0?'Waiting: '+plural(j.queuePosition,'video','videos')+' ahead of this one':'Waiting: this one is next';
    return 'Waiting for its turn';
  }
  function friendly(j){
    if(j.state==='uploading')return 'upload not finished';
    if(j.state==='checking')return 'checking the video';
    if(j.state==='importing')return 'importing';
    if(j.state==='ready')return 'ready to describe';
    if(j.state==='reserving'||j.state==='queued')return waiting(j).toLowerCase();
    if(j.state==='running')return 'describing, '+(j.progress||0)+' percent';
    if(j.state==='done')return j.preview?'preview finished':'finished';
    if(j.state==='failed')return 'stopped';
    if(j.state==='cancelled')return 'cancelled';
    if(j.state==='deleting')return 'being deleted';
    return j.state;
  }
  function stateLine(j){
    if(j.cancelRequested&&working(j))return cancelStuck(j)?'Still stopping. Press Cancel again if it does not stop.':'Cancelling after the current step…';
    if(j.state==='reserving'||j.state==='queued')return waiting(j)+'.';
    if(j.state==='failed')return j.overQuote?'Stopped because it is costing more than quoted.':j.recheckable?'The check was interrupted before it finished.':'Stopped before finishing.';
    if(j.state==='uploading')return uploadId===j.id?'Uploading.':'Upload not finished. Choose '+j.name+' again to carry on.';
    var stage=stageText(j);return stage?stage.replace(/\.?$/,'.'):friendly(j).charAt(0).toUpperCase()+friendly(j).slice(1)+'.';
  }
  function cancelStuck(j){return !!(j&&j.cancelRequested&&(j.cancelStuck||cancelSeenAt&&Date.now()-cancelSeenAt>30000));}
  function retryCount(j){if(!j)return 0;return Array.isArray(j.retryableSections)?j.retryableSections.length:Number(j.retryableSections)||0;}
  function copies(){return job&&(job.copies||[]).length?job.copies:job&&job.state==='done'?[{version:job.version||1,preview:job.preview,settings:job.settings,range:job.range,outputSeconds:job.outputSeconds,count:job.descriptions,skipped:job.skipped,failedSections:job.failedSections,savedToLibrary:job.savedToLibrary,finishedAt:job.finishedAt}]:[];}
  function latestVersion(){var list=copies();return list.length?list[list.length-1].version:0;}
  function viewedCopy(){return copies().filter(function(copy){return copy.version===viewVersion;})[0];}
  function versionLabel(copy){
    var s=copy.settings||{},parts=[];
    if(s.voice)parts.push(voiceName(s.voice)+' '+s.rate+'×');
    if(s.detail)parts.push(DETAIL_NAMES[s.detail]||s.detail);
    parts.push(plural(copy.count||0,'description','descriptions'));
    if(copy.range)parts.push('part '+clock(copy.range.start)+' to '+clock(copy.range.end));
    if(copy.failedSections)parts.push(plural(copy.failedSections,'part','parts')+' not described');
    if(copy.savedToLibrary)parts.push('saved to Library');
    if(copy.finishedAt)parts.push(when(copy.finishedAt));
    return 'Version '+copy.version+(copy.rehearsal?' rehearsal with a test tone':copy.preview?' preview':'')+': '+parts.join(', ');
  }
  function latestCopy(){var list=copies();return list[list.length-1];}
  function keptText(j){
    var done=Number(j&&j.done)||0,total=Number(j&&j.sections)||0;
    if(!total)return 'Finished sections are kept and not paid for again.';
    if(!done)return 'No section had finished, so it starts again from the beginning.';
    return done+' of '+plural(total,'section','sections')+' finished; they are kept and not paid for again.';
  }
  function resumeName(){
    var done=Number(job&&job.done)||0,total=Number(job&&job.sections)||0;
    if(!done)return 'Try again from the beginning';
    return 'Continue where it stopped'+(total>done?': '+(total-done)+' of '+plural(total,'section','sections')+' left':'');
  }
  function raiseTo(){
    var e=estimates.resume;if(!e)return 0;
    var limit=e.limitUSD||(config&&config.limitUSD)||Infinity,z=typeof e.allowUpToUSD==='number'?e.allowUpToUSD:typeof e.approvedUSD==='number'?e.approvedUSD:e.estimateUSD*1.5+0.1;
    return Math.min(limit,Math.round(z*100)/100);
  }
  function overQuoteText(j){return 'This is costing more than quoted: '+money(j.runCostUSD)+' spent of about '+money(j.estimatedUSD)+'.';}
  function renderVersions(){
    var list=copies(),select=$('version');
    var sig=JSON.stringify(list.map(function(c){return [c.version,!!c.preview,c.count,!!c.savedToLibrary,c.finishedAt,c.failedSections];}));
    if(sig!==versionsSig){versionsSig=sig;select.textContent='';list.forEach(function(copy){var option=document.createElement('option');option.value=String(copy.version);option.textContent=versionLabel(copy);select.appendChild(option);});}
    if(viewVersion&&select.value!==String(viewVersion))select.value=String(viewVersion);
    var pending=pendingSwitch&&pendingSwitch!==viewVersion;$('new-version').hidden=!pending;
    if(pending){$('new-version-note').textContent='Version '+pendingSwitch+' is ready. You are still on version '+viewVersion+'.';$('switch-version').textContent='Switch to version '+pendingSwitch;}
  }
  function defaults(){var saved=stored(SETTINGS_KEY,{});var out={};Object.keys(FORM_DEFAULTS).forEach(function(key){out[key]=saved&&saved[key]!==undefined?saved[key]:FORM_DEFAULTS[key];});out.voice=saved&&saved.voice;return out;}
  function remember(){var s=settings();store(SETTINGS_KEY,{voice:s.voice,rate:s.rate,maxRate:s.maxRate,mode:s.mode,detail:s.detail,volume:s.volume});}
  function setSelect(id,value){if(value===undefined||value===null)return false;var select=$(id);var ok=Array.prototype.some.call(select.options,function(option){return option.value===String(value);});if(ok)select.value=String(value);return ok;}
  function parseClock(text){
    var value=String(text||'').trim();if(!value)return null;
    var parts=value.split(':');if(parts.length>3||!parts.every(function(part,i){return i===parts.length-1?/^\d+(\.\d+)?$/.test(part):/^\d+$/.test(part);}))return NaN;
    return parts.reduce(function(total,part){return total*60+Number(part);},0);
  }
  function part(){
    var result={range:null,error:'',field:''};if(!job||!job.seconds)return result;
    var from=parseClock($('part-from').value),to=parseClock($('part-to').value),limit=((config&&config.maxMinutes)||90)*60;
    if(Number.isNaN(from))return {range:null,error:'Type the start as hours:minutes:seconds, like 1:12:30.',field:'part-from'};
    if(Number.isNaN(to))return {range:null,error:'Type the end as hours:minutes:seconds, like 1:16:00.',field:'part-to'};
    if(from===null&&to===null)return result;
    var start=from||0,end=to===null?job.seconds:to;
    if(start>=job.seconds)return {range:null,error:'The video is only '+clock(job.seconds)+' long, so the part must start before that.',field:'part-from'};
    if(end>job.seconds)return {range:null,error:'The video is only '+clock(job.seconds)+' long.',field:'part-to'};
    if(end-start<1)return {range:null,error:'The end must be at least one second after the start.',field:'part-to'};
    if(end-start>limit)return {range:null,error:'One run can describe up to '+length(limit)+'; this part is '+length(end-start)+'.',field:'part-to'};
    if(start===0&&end>=job.seconds)return result;
    result.range={start:start,end:end};return result;
  }
  function tooLong(){return !!(job&&job.seconds&&config&&job.seconds>config.maxMinutes*60&&!part().range);}
  function describing(){var p=part();return p.range?p.range.end-p.range.start:(job&&job.seconds)||0;}
  function previewSeconds(){return (config&&config.previewSeconds)||180;}
  function canPreview(){return describing()>previewSeconds()+60;}
  function previewName(){return 'Try the first '+length(previewSeconds())+(part().range?' of this part':'');}
  function settings(){var s={voice:$('voice').value,rate:Number($('rate').value),maxRate:Number($('max-rate').value),mode:$('mode').value,detail:$('detail').value,volume:$('volume').value,notes:$('notes').value.trim(),closeLook:$('close-look').checked,firstLook:$('first-look').checked};var p=part();if(p.range)s.range=p.range;return s;}
  function voiceFields(){var s=settings();return {voice:s.voice,rate:s.rate,maxRate:s.maxRate,mode:s.mode,volume:s.volume};}
  function renderPart(){
    var p=part();['part-from','part-to'].forEach(function(id){if(p.field===id)$(id).setAttribute('aria-invalid','true');else $(id).removeAttribute('aria-invalid');});
    $('part-error').hidden=!p.error;$('part-error').textContent=p.error;
    $('part-summary').textContent=p.range?'Describing '+clock(p.range.start)+' to '+clock(p.range.end)+', '+length(p.range.end-p.range.start)+'.':job&&job.seconds?'Describing the whole video, '+length(job.seconds)+'.':'';
    return p;
  }
  function currentPreset(){
    var detail=$('detail').value,mode=$('mode').value,close=$('close-look').checked,first=$('first-look').checked;
    return Object.keys(PRESETS).filter(function(name){var p=PRESETS[name];return p.detail===detail&&p.mode===mode&&p.closeLook===close&&(p.firstLook===undefined||p.firstLook===first);})[0]||'custom';
  }
  function showPreset(){var name=currentPreset();['commercials','tv','film','custom'].forEach(function(key){$('preset-'+key).checked=key===name;});}
  function applyPreset(name){var p=PRESETS[name];if(!p)return;setSelect('detail',p.detail);setSelect('mode',p.mode);$('close-look').checked=p.closeLook;if(p.firstLook!==undefined)$('first-look').checked=p.firstLook;}
  function presetSummary(name){
    if(name==='commercials')return 'Commercials and logos: rich detail, closer look on, keeping the original length.';
    if(name==='tv')return 'TV show: standard detail, keeping the original length, no extra passes.';
    return 'Film: standard detail, pausing the picture when needed. The whole-film first look is offered under Extra passes, and it is off.';
  }
  function describeVoice(){$('voice-description').textContent=voicesOff?'Narrator voices are unavailable right now. Playback and downloads still work.':(catalog.describe||{})[$('voice').value]||'One of your platform voices.';}
  function recentVoices(){var list=stored(RECENT_KEY,[]);return Array.isArray(list)&&config?list.filter(function(voice){return config.voices.indexOf(voice)>=0;}):[];}
  function rememberVoice(voice){store(RECENT_KEY,[voice].concat(recentVoices().filter(function(item){return item!==voice;})).slice(0,5));}
  function voiceOption(voice){var option=document.createElement('option');option.value=voice;var about=(catalog.describe||{})[voice];option.textContent=about?voice+' — '+about:voice;return option;}
  function fillKinds(){
    var kinds=$('voice-kind'),keep=kinds.value||'all';kinds.textContent='';
    var add=function(value,text){var option=document.createElement('option');option.value=value;option.textContent=text;kinds.appendChild(option);};
    add('all','All voices');if(recentVoices().length)add('recent','Recently used');
    (config.categories||[]).forEach(function(group){if(group.voices.some(function(voice){return config.voices.indexOf(voice)>=0;}))add('kind:'+group.name,group.name);});
    if(!setSelect('voice-kind',keep))kinds.value='all';
  }
  function fillVoices(){
    var select=$('voice'),kind=$('voice-kind').value||'all',keep=select.value;select.textContent='';
    if(voicesOff){var none=document.createElement('option');none.value='';none.textContent='Narrator voices are unavailable right now';select.appendChild(none);return;}
    if(kind==='recent'){recentVoices().forEach(function(voice){select.appendChild(voiceOption(voice));});}
    else if(kind.indexOf('kind:')===0){var group=(config.categories||[]).filter(function(item){return 'kind:'+item.name===kind;})[0];(group?group.voices:[]).forEach(function(voice){if(config.voices.indexOf(voice)>=0)select.appendChild(voiceOption(voice));});}
    else{
      var placed={};
      (config.categories||[]).forEach(function(group){var og=document.createElement('optgroup');og.label=group.name;group.voices.forEach(function(voice){if(config.voices.indexOf(voice)<0||placed[voice])return;placed[voice]=1;og.appendChild(voiceOption(voice));});if(og.children.length)select.appendChild(og);});
      var rest=config.voices.filter(function(voice){return !placed[voice];});
      if(rest.length){var og=document.createElement('optgroup');og.label='Other voices';rest.forEach(function(voice){og.appendChild(voiceOption(voice));});select.appendChild(og);}
    }
    if(keep)setSelect('voice',keep);
  }
  function setVoice(voice){if(voicesOff||!voice||config.voices.indexOf(voice)<0)return false;if(!setSelect('voice',voice)){$('voice-kind').value='all';fillVoices();setSelect('voice',voice);}describeVoice();return true;}
  function fillForm(saved){
    setVoice(saved.voice);[['rate','rate'],['maxRate','max-rate'],['mode','mode'],['detail','detail'],['volume','volume']].forEach(function(pair){setSelect(pair[1],saved[pair[0]]);});
    $('notes').value=saved.notes||'';$('close-look').checked=!!saved.closeLook;$('first-look').checked=!!saved.firstLook;
    $('part-from').value=saved.range?clock(saved.range.start):'';$('part-to').value=saved.range?clock(saved.range.end):'';$('part').open=!!saved.range;
  }
  function freshForm(){
    var cleared=!!$('notes').value.trim()||$('close-look').checked||$('first-look').checked||!!$('part-from').value.trim()||!!$('part-to').value.trim();
    var saved=defaults();fillForm({voice:saved.voice||(config&&config.defaultVoice),rate:saved.rate,maxRate:saved.maxRate,mode:saved.mode,detail:saved.detail,volume:saved.volume,notes:'',closeLook:false,firstLook:false});
    return cleared;
  }
  function estimateRequests(){
    if(!job||!job.seconds||!config)return [];
    var list=[],s=settings(),p=part(),state=job.state;
    if(state==='ready'){if(p.error||tooLong())return [];list.push({key:'start',body:{action:'start',settings:s}});if(canPreview())list.push({key:'preview',body:{action:'preview',settings:s}});return list;}
    if(state==='done'){
      if(job.preview){if(job.finishable)list.push({key:'finish',body:{action:'finish'}});if(!p.error)list.push({key:'preview',body:{action:'preview',settings:s}});}
      else{list.push({key:'revoice',body:{action:'revoice',settings:s}});if(!p.error)list.push({key:'reanalyze',body:{action:'reanalyze',settings:s}});}
      if(retryCount(job))list.push({key:'redo',body:{action:'redo'}});
      return list;
    }
    if(job.resumable)list.push({key:'resume',body:{action:'resume',settings:voiceFields()}});
    return list;
  }
  function mainKey(){if(!job)return '';if(job.state==='ready')return 'start';if(job.state==='done')return job.preview?'preview':'reanalyze';return job.resumable?'resume':'';}
  var LABELS={start:'Create described copy',preview:'Try the first 3 minutes',revoice:'Make a new version with this narration',reanalyze:'Write fresh descriptions',finish:'Describe the rest',redo:'Try again on the parts that could not be described',resume:'Continue where it stopped'};
  function allowance(e){var mode=e.billingMode||(config&&config.billingMode),maximum=typeof e.approvedUSD==='number'?'Maximum charge: '+money(e.approvedUSD)+'. ':'';if(mode==='platform')return 'Admin processing is paid by the platform. Narration is included.';if(mode==='balance')return maximum+money(e.remainingUSD)+' is available in your account. Narration is included.';return money(e.remainingUSD)+' of today’s '+money(e.dailyUSD)+' is left.';}
  function refusal(e){return e.reason||('This needs '+money(e.setAsideUSD)+' set aside, and '+allowance(e));}
  function scheduleEstimates(announce,prefix){
    if(announce)announceNext=true;if(prefix)announcePrefix=prefix;
    if(estimateTimer)clearTimeout(estimateTimer);
    estimateTimer=setTimeout(function(){estimateTimer=null;fetchEstimates();},announce?600:50);
  }
  async function fetchEstimates(){
    var seq=++estimateSeq,id=job&&job.id,wanted=estimateRequests(),speak=announceNext,prefix=announcePrefix;announceNext=false;announcePrefix='';
    if(!wanted.length){estimates={};renderEstimates();if(prefix&&speak)say(prefix,true);return;}
    try{
      var results=await Promise.all(wanted.map(function(item){return call('/jobs/'+id+'/estimate','POST',item.body).then(function(result){result.key=item.key;return result;});}));
      if(seq!==estimateSeq||shownId!==id)return;
      estimates={};results.forEach(function(result){estimates[result.key]=result;});
      if(typeof results[0].remainingUSD==='number')config.remainingUSD=results[0].remainingUSD;
      controls();
      if(speak){var main=estimates[mainKey()]||results[0];var text=(prefix?prefix+' ':'')+(job.state==='ready'&&main.key==='start'?'Create described copy':LABELS[main.key])+': about '+money(main.estimateUSD)+'.';if(!main.allowed)text+=' '+refusal(main);say(text,true);}
      presetPrices();
    }catch(e){
      if(seq!==estimateSeq||shownId!==id||e.name==='AbortError')return;
      estimates={};controls();$('estimate').textContent='The cost could not be worked out just now: '+e.message;if(speak)say((prefix?prefix+' ':'')+$('estimate').textContent,true);
    }
  }
  async function presetPrices(){
    var names=['commercials','tv','film'];
    if(!job||job.state!=='ready'||!job.seconds||part().error||tooLong()){presetSig='';names.forEach(function(name){$('preset-'+name+'-price').textContent='';});return;}
    var base=settings(),sig=job.id+'|'+JSON.stringify(base.range||null)+'|'+base.voice+'|'+base.rate;if(sig===presetSig)return;presetSig=sig;
    var seq=++presetSeq,id=job.id;
    try{
      var results=await Promise.all(names.map(function(name){var s=Object.assign({},base,PRESETS[name]);if(name==='film')s.firstLook=false;return call('/jobs/'+id+'/estimate','POST',{action:'start',settings:s});}));
      if(seq!==presetSeq||shownId!==id)return;
      results.forEach(function(result,i){$('preset-'+names[i]+'-price').textContent=', about '+money(result.estimateUSD);});
    }catch(e){presetSig='';}
  }
  async function freshEstimate(action,extra){var body=Object.assign({action:action},extra||{});return call('/jobs/'+job.id+'/estimate','POST',body);}
  function priced(key,text){var e=estimates[key];return text+(e?', about '+money(e.estimateUSD):'');}
  function gate(id,reason){var button=$(id);if(reason){button.setAttribute('aria-disabled','true');button.setAttribute('data-reason',reason);}else{button.removeAttribute('aria-disabled');button.removeAttribute('data-reason');}}
  function blocked(id){if(inflight)return true;var button=$(id);if(button.getAttribute('aria-disabled')==='true'){say(button.getAttribute('data-reason')||'That is not available right now.',true);return true;}return false;}
  function spendReason(key){
    if(!config||!config.enabled)return 'The describer is not set up yet.';
    if(voicesOff)return 'Narrator voices are unavailable right now, so new narration cannot be made. Playback and downloads still work. Try again in a few minutes.';
    var e=estimates[key];if(e&&!e.allowed)return refusal(e);
    return '';
  }
  function renderEstimates(){
    var e=estimates;
    $('start').textContent=priced('start','Create described copy');
    $('preview').textContent=priced('preview',previewName());
    $('preview-again').textContent=priced('preview','Try the preview again with these choices');
    $('revoice').textContent=priced('revoice','Make a new version with this narration');
    $('reanalyze').textContent=priced('reanalyze','Write fresh descriptions with these choices');
    $('finish').textContent=priced('finish','Describe the rest');
    var n=retryCount(job);$('redo').textContent=priced('redo','Try again on the '+(n===1?'part':plural(n,'part','parts'))+' that could not be described');
    $('resume').textContent=priced('resume',resumeName());
    renderSpendNotes();
    var text='Choose a video to see the estimated cost.';
    if(job&&working(job)&&job.state!=='checking'&&job.state!=='importing')text=costLine(job);
    else if(job&&!job.seconds)text=job.state==='uploading'||job.state==='checking'||job.state==='importing'?'The cost appears once the video is checked.':'';
    else if(job&&job.state==='ready'){
      var p=part();
      if(p.error)text=p.error;
      else if(tooLong())text='This video is '+length(job.seconds)+' long. One run can describe up to '+length(config.maxMinutes*60)+', so choose the part to describe under Describe only part of it.';
      else if(e.start){text='Video length: '+length(job.seconds)+(p.range?', describing '+length(p.range.end-p.range.start)+' of it':'')+'. Create described copy: about '+money(e.start.estimateUSD)+'; '+money(e.start.setAsideUSD)+' is set aside until it finishes, and anything unused comes back.'+(e.preview?' '+previewName()+': about '+money(e.preview.estimateUSD)+'.':'')+' '+allowance(e.start);if(!e.start.allowed)text+=' '+refusal(e.start);}
      else text='Video length: '+length(job.seconds)+'. Working out the cost…';
    }
    else if(job&&job.state==='done'){
      var parts=[];
      if(e.finish)parts.push('Describe the rest: about '+money(e.finish.estimateUSD)+'.');
      if(e.preview)parts.push('Try the preview again: about '+money(e.preview.estimateUSD)+'.');
      if(e.revoice)parts.push('Make a new version with this narration: about '+money(e.revoice.estimateUSD)+'.');
      if(e.reanalyze)parts.push('Write fresh descriptions: about '+money(e.reanalyze.estimateUSD)+'.');
      if(e.redo)parts.push('Try again on the parts that could not be described: about '+money(e.redo.estimateUSD)+'.');
      var any=e.finish||e.preview||e.revoice||e.reanalyze||e.redo;if(any)parts.push(''+allowance(any));
      text=parts.join(' ')||'Working out the cost…';
    }
    else if(job&&job.resumable&&job.overQuote)text=e.resume?overQuoteText(job)+' Carrying on is expected to cost about '+money(e.resume.estimateUSD)+' more, and it may spend up to '+money(raiseTo())+'. '+allowance(e.resume):overQuoteText(job)+' Working out the cost of carrying on…';
    else if(job&&job.resumable)text=e.resume?resumeName()+', about '+money(e.resume.estimateUSD)+'. '+allowance(e.resume):'Working out the cost of continuing…';
    else if(job)text=job.costUSD?'Processing cost for this video so far: '+money(job.costUSD)+'.':'';
    if($('estimate').textContent!==text)$('estimate').textContent=text;
  }
  function costLine(j){
    if(!working(j)||j.state==='checking'||j.state==='importing')return j.costUSD?'Processing cost for this video so far: '+money(j.costUSD)+'.':'';
    return 'This run so far: '+money(j.runCostUSD)+(j.estimatedUSD?' of about '+money(j.estimatedUSD):'')+(j.setAsideUSD?' ('+money(j.setAsideUSD)+' set aside)':'')+'.'+(j.costUSD?' All versions of this video: '+money(j.costUSD)+'.':'')+' Work already sent to a service may still be charged if you cancel.';
  }
  function setNote(id,text){var box=$(id);box.hidden=!text;if(box.textContent!==text)box.textContent=text;}
  function renderSpendNotes(){
    var e=estimates.resume,resumable=!!(job&&job.resumable),over=resumable&&!!job.overQuote,z=over?raiseTo():0;
    setNote('resume-price',resumable&&!over?(e?'About '+money(e.estimateUSD)+'; '+money(e.setAsideUSD)+' is set aside until it finishes. ':'')+keptText(job):'');
    setNote('over-quote',job&&job.state==='failed'&&job.overQuote?overQuoteText(job)+' It stopped so you can decide.'+(z?' Allowing up to '+money(z)+' more lets it carry on. ':' ')+keptText(job):'');
    $('allow-more').textContent=z?'Allow up to '+money(z)+' more and continue':'Allow more and continue';
    setNote('abandon-help',job&&job.abandonable?'Going back costs nothing. The stopped attempt is discarded'+(job.runCostUSD?', and the '+money(job.runCostUSD)+' it already cost is not returned':'')+'.':'');
    $('redo-help').textContent='Only those parts are described again; everything else is reused and not paid for again. The current version stays available.';
    $('preview-note').textContent=job&&job.preview?'This preview describes the first '+length(previewSeconds())+'. Describe the rest keeps the preview’s parts, so they are not paid for again.':'';
  }
  function revoiceNote(){
    if(!job||job.state!=='done'||job.preview||!job.settings)return '';
    var saved=job.settings,s=settings(),changed=[];
    if(s.detail!==saved.detail)changed.push('detail');if(s.notes!==(saved.notes||''))changed.push('notes');
    if(s.closeLook!==!!saved.closeLook)changed.push('closer look');if(s.firstLook!==!!saved.firstLook)changed.push('first look');
    if(JSON.stringify(s.range||null)!==JSON.stringify(saved.range||null))changed.push('part to describe');
    if(!changed.length)return '';
    return 'Your change to '+changed.join(', ').replace(/, ([^,]*)$/,' and $1')+' is only used by Write fresh descriptions.';
  }
  function controls(){
    var busy=working(job),state=job?job.state:'',ready=state==='ready',done=state==='done',off=!config||!config.enabled,preview=done&&!!job.preview;
    var resumeOnly=!!job&&!!job.resumable&&!done;
    $('file').disabled=uploading||off;
    $('upload').disabled=uploading||off||!$('file').files.length;
    $('upload').textContent=job&&job.state==='uploading'&&!uploading?'Resume upload and check video':'Upload and check video';
    $('youtube').disabled=uploading||off;
    $('import').disabled=uploading||off||!$('youtube').value.trim();
    $('library-use').disabled=uploading||off||!libraryLink($('library').value);
    $('settings').disabled=!config||busy||state==='deleting';
    ['detail','notes','close-look','first-look','part-from','part-to','preset-commercials','preset-tv','preset-film','preset-custom'].forEach(function(id){$(id).disabled=resumeOnly;});
    $('voice').disabled=voicesOff;$('voice-kind').disabled=voicesOff;$('sample-play').disabled=voicesOff;$('sample-fast').disabled=voicesOff;$('say-play').disabled=voicesOff;
    $('resume-note').hidden=!resumeOnly;
    if(resumeOnly){var saved=job.settings||{};$('resume-note').textContent='Continuing keeps the detail, notes and extra passes this attempt started with: '+(DETAIL_NAMES[saved.detail]||'Standard detail')+', closer look '+(saved.closeLook?'on':'off')+', first look '+(saved.firstLook?'on':'off')+'. You can change the voice, speeds, pauses and volume under Choose the narration before you continue.';}
    $('start').hidden=!ready;$('preview').hidden=!ready||!canPreview();
    $('revoice').hidden=!done||preview;$('reanalyze').hidden=!done||preview;$('revoice-help').hidden=!done||preview;
    $('preview-again').hidden=!preview;$('preview-box').hidden=!preview;$('finish').hidden=!preview||!job.finishable;
    var note=revoiceNote();$('revoice-note').hidden=!note;$('revoice-note').textContent=note;
    $('redo-box').hidden=!done||!retryCount(job);
    $('cancel').hidden=!busy;
    var cancelling=!!(job&&job.cancelRequested&&busy),stuck=cancelStuck(job);
    $('cancel').textContent=cancelling&&!stuck?'Cancelling…':'Cancel processing';
    if(cancelling&&!stuck)$('cancel').setAttribute('aria-disabled','true');else $('cancel').removeAttribute('aria-disabled');
    var over=!!(job&&job.resumable&&job.overQuote);
    $('resume').hidden=!(job&&job.resumable)||over;$('allow-more').hidden=!over;
    var recheck=!!(job&&job.recheckable&&state==='failed');$('recheck').hidden=!recheck;$('recheck-help').hidden=!recheck;
    var rehearse=ready&&!!config&&!!config.rehearsal;$('rehearse').hidden=!rehearse;$('rehearse-help').hidden=!rehearse;
    $('keep').hidden=!done||!job.keepable;
    var back=latestVersion();$('abandon').hidden=!(job&&job.abandonable&&back);$('abandon').textContent='Go back to version '+back;
    $('delete').hidden=!job||['ready','uploading','done','failed','cancelled','deleting'].indexOf(state)<0;
    $('delete').textContent=state==='deleting'?'Finish deleting':'Delete this video and its files';
    $('rename').hidden=!job;
    $('edit-load').disabled=!done;
    var partReason=ready?(part().error||(tooLong()?'Choose the part to describe first; one run can describe up to '+length(config.maxMinutes*60)+'.':'')):'';
    gate('start',partReason||spendReason('start'));gate('preview',partReason||spendReason('preview'));
    gate('preview-again',part().error||spendReason('preview'));gate('revoice',spendReason('revoice'));gate('reanalyze',part().error||spendReason('reanalyze'));
    gate('finish',spendReason('finish'));gate('redo',spendReason('redo'));gate('resume',spendReason('resume'));gate('allow-more',spendReason('resume'));
    gate('rehearse',!config||!config.enabled?'The describer is not set up yet.':partReason);
    gate('edit-save',voicesOff?spendReason('revoice'):'');gate('edit-redo',voicesOff?spendReason('redo'):'');
    showPreset();
    renderEstimates();
  }
  function libraryLink(value){try{var url=new URL(value.trim(),location.origin);var book=url.searchParams.get('book');if(!book||!/^[a-f0-9]{24}$/.test(book))return null;return {book:book,track:Math.max(0,Number(url.searchParams.get('track'))||0)};}catch(e){return null;}}
  function checkLibraryLink(){
    var value=$('library').value.trim(),bad=!!value&&!libraryLink(value);
    if(bad)$('library').setAttribute('aria-invalid','true');else $('library').removeAttribute('aria-invalid');
    $('library-error').hidden=!bad;$('library-error').textContent=bad?'That isn’t a Library video link. Open the video in the Library and copy its address, or use Make a described copy on the video.':'';
  }
  function vttText(text){return text.split('\n').map(function(line){return line.trim();}).filter(Boolean).join(' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');}
  function parseVtt(text){var list=[];String(text||'').replace(/\r\n?/g,'\n').split(/\n\n+/).forEach(function(block){var m=/(?:(\d+):)?(\d\d):(\d\d)\.(\d\d\d) --> [^\n]+\n([\s\S]+)/.exec(block);if(m)list.push({at:Number(m[1]||0)*3600+Number(m[2])*60+Number(m[3])+Number(m[4])/1000,text:vttText(m[5])});});return list;}
  function renderTranscript(text){
    var box=$('transcript'),original=false;box.textContent='';found=-1;
    if(!text){var none=document.createElement('p');none.textContent='The transcript could not be loaded. Use the download link instead.';box.appendChild(none);return;}
    text.split('\n').forEach(function(line){
      if(!line.trim())return;
      if(/^(Descriptions that did not fit|Parts that could not be described)/.test(line))original=true;
      var p=document.createElement('p');p.textContent=line;p.setAttribute('tabindex','-1');
      var m=/^(?:(\d+):)?(\d+):(\d\d) /.exec(line);if(m&&!original)p.setAttribute('data-at',String(Number(m[1]||0)*3600+Number(m[2])*60+Number(m[3])));
      box.appendChild(p);
    });
  }
  function positionKey(id,version){return 'kade-description-position:'+id+':'+version;}
  function savedPosition(id,version){var n=Number(stored(positionKey(id,version),0));return n>5?n:0;}
  function savePosition(seconds){if(!shownId||!viewVersion)return;store(positionKey(shownId,viewVersion),Math.floor(seconds||0));}
  function renderExpiry(){
    var box=$('expiry');if(!job||!job.expiresAt||job.state!=='done'){box.textContent='';return '';}
    var left=new Date(job.expiresAt).getTime()-Date.now(),text,keep=job.keepable?' You can also press Keep 7 more days.':'';
    if(left<=0)text='This copy has reached its end date and may be deleted at any moment. Download it or save it to your Library now.'+keep;
    else if(left<86400000)text='This copy will be deleted in about '+plural(Math.max(1,Math.round(left/3600000)),'hour','hours')+', on '+when(job.expiresAt)+'. Download it or save it to your Library to keep it.'+keep;
    else text='Available until '+when(job.expiresAt)+'. Download it or save it to your Library to keep it longer.'+keep;
    box.textContent=text;return left<86400000?text:'';
  }
  function shareDefaults(){
    if(!job)return;var other=job.sourceOwner==='someone else',closed=!!job.sourcePrivate||other,hints=[];
    $('share').checked=!closed;
    if(other)hints.push('The original belongs to someone else, so this copy starts private.');else if(closed)hints.push('The original is private, so this copy starts private.');
    if(job.sourceGrownUps)hints.push('The original is for grown-ups only, so this copy will be too.');
    $('share-help').textContent=hints.join(' ');$('share-help').hidden=!hints.length;
  }
  function mediaMetadata(){var session=navigator&&navigator.mediaSession;if(!session||!job)return;try{if(window.MediaMetadata)session.metadata=new window.MediaMetadata({title:job.name,artist:'Described by Kade-AI'});}catch(e){}}
  async function files(focus){
    var copy=viewedCopy();if(!copy||!job)return;
    var id=job.id,version=viewVersion,request=++fileRequest,base='/jobs/'+id,query='?version='+version;
    var result=await call(base+'/files'+query);
    var texts=await Promise.all(['descriptions','captions','transcript'].map(function(kind){return result[kind]?call(base+'/text/'+kind+query,'GET',undefined,false,'text').catch(function(){return '';}):Promise.resolve('');}));
    if(request!==fileRequest||shownId!==id||viewVersion!==version)return;
    filesAt=Date.now();refreshedErrorKey='';
    trackUrls.forEach(function(url){URL.revokeObjectURL(url);});trackUrls=[];cues=[];lastJump=null;
    Array.prototype.slice.call($('video').querySelectorAll('track')).forEach(function(el){el.remove();});
    var player=media(),same=loadedFiles===id+'/'+version,resumeAt=same?player.currentTime:savedPosition(id,version),resumePlay=same&&!ended(player);
    ['video','audio'].forEach(function(name){var el=$(name);el.onloadedmetadata=function(){if(resumeAt&&el===media())el.currentTime=Math.min(resumeAt,el.duration||resumeAt);el.playbackRate=Number($('playback-rate').value);if(resumePlay&&el===media())el.play().catch(function(){});};});
    $('video').src=result.video;$('audio').src=result.audio;
    ['video','audio','transcript','captions','descriptions','script'].forEach(function(kind){var link=$(kind+'-download');link.hidden=!result[kind+'Download'];if(result[kind+'Download'])link.href=result[kind+'Download'];});
    ['descriptions','captions'].forEach(function(kind,index){if(!texts[index])return;var url=URL.createObjectURL(new Blob([texts[index]],{type:'text/vtt'}));trackUrls.push(url);var track=document.createElement('track');track.kind=kind;track.label=kind==='descriptions'?'Audio descriptions':'Dialogue captions';track.srclang='en';track.src=url;$('video').appendChild(track);});
    cues=parseVtt(texts[0]);renderTranscript(texts[2]);
    $('results').hidden=false;$('skip').hidden=false;loadedFiles=id+'/'+version;
    $('library-save-box').hidden=!config.library;
    $('library-save').textContent='Save version '+version+'’s described audio to my Library';
    gate('library-save',copy.savedToLibrary?'This version is already saved to your Library.':'');$('library-note').textContent=copy.savedToLibrary?'This version is saved to your Library.':'';
    $('summary').textContent='Version '+version+(copy.rehearsal?' is a rehearsal with a test tone, made without paid services: ':copy.preview?' is a preview: ':': ')+plural(copy.count||0,'description','descriptions')+'. '+(copy.range?'Describes '+clock(copy.range.start)+' to '+clock(copy.range.end)+' of the original. ':'Original length '+length(job.seconds)+'; ')+'described copy '+length(copy.outputSeconds)+'. '+(copy.skipped?plural(copy.skipped,'description was','descriptions were')+' left out; see the transcript for the reasons. ':'')+(copy.failedSections?plural(copy.failedSections,'part','parts')+' could not be described. ':'');
    $('position-note').textContent=!same&&resumeAt?'Playback starts at '+clock(resumeAt)+', where you stopped last time.':'';
    renderExpiry();mediaMetadata();
    if(focus)$('result-title').focus();
  }
  function draftKey(id,version){return 'kade-description-draft:'+id+':'+version;}
  function readDraft(key){var draft=stored(key,{});return draft&&typeof draft==='object'&&!Array.isArray(draft)?draft:{};}
  function draftsFor(id){
    var out=[],prefix='kade-description-draft:'+id+':';
    try{for(var i=0;i<localStorage.length;i++){var key=localStorage.key(i);if(key&&key.indexOf(prefix)===0){var count=Object.keys(readDraft(key)).length;if(count)out.push({key:key,version:Number(key.slice(prefix.length)),count:count});}}}catch(e){}
    return out.sort(function(a,b){return a.version-b.version;});
  }
  function draftNotice(){
    if(!job||job.state!=='done')return '';
    var latest=job.version||latestVersion()||1,drafts=draftsFor(job.id);
    var current=drafts.filter(function(d){return d.version===latest;})[0],older=drafts.filter(function(d){return d.version<latest;});
    if(current)return 'You have '+plural(current.count,'unsent correction','unsent corrections')+' saved in this browser. Open the script to finish them.';
    if(older.length){var last=older[older.length-1];return 'You drafted '+plural(last.count,'correction','corrections')+' for version '+last.version+', which has since been replaced. Open the script to see them.';}
    return '';
  }
  function renderDraftNote(){var text=draftNotice();$('draft-note').hidden=!text;$('draft-note').textContent=text;return text;}
  function resetView(){
    ++fileRequest;$('video').pause();$('audio').pause();$('results').hidden=true;$('skip').hidden=true;loadedFiles='';cues=[];lastJump=null;viewVersion=0;versionsSig='';lastLatest=0;pendingSwitch=0;
    $('transcript').textContent='';script=null;edits={};editing='';scriptJob='';shortTouched={};warnedShort={};staleDrafts=[];$('edit-fields').hidden=true;$('stale').hidden=true;$('edit-review-list').hidden=true;$('edit-status').textContent='';
    estimates={};presetSig='';redoEstimate=null;cancelSeenAt=0;lastQuarter=-1;$('position-note').textContent='';$('new-version').hidden=true;
  }
  function markCurrent(){Object.keys(listButtons).forEach(function(id){if(id===shownId)listButtons[id].setAttribute('aria-current','true');else listButtons[id].removeAttribute('aria-current');});}
  function pageTitle(){if(!job){document.title=BASE_TITLE;return;}var state=job.state==='running'?'Describing, '+(job.progress||0)+' percent':job.state==='done'?(job.preview?'Preview ready':'Ready'):friendly(job).charAt(0).toUpperCase()+friendly(job).slice(1);document.title=state+' — '+job.name+' — '+BASE_TITLE;}
  function progressSpeech(j){
    var choice=$('progress-pref').value;if(choice==='end')return;
    if(choice==='section'){var m=/section (\d+) of (\d+)/.exec(j.stage||'');say(m?(/^First look/.test(j.stage||'')?'Learning who is who: section ':'Describing: section ')+m[1]+' of '+m[2]+'.':stateLine(j));return;}
    var quarter=Math.floor((j.progress||0)/25);if(lastQuarter<0){lastQuarter=quarter;return;}
    if(quarter>lastQuarter&&quarter<4){lastQuarter=quarter;say('Describing: '+quarter*25+' percent done'+(j.etaSeconds?', about '+length(Math.max(60,Math.round(j.etaSeconds/60)*60))+' left':'')+'.');}
  }
  function rehearsalEnd(j,old){var r=j&&j.lastRehearsal,was=old&&old.lastRehearsal;return r&&r.outcome&&(!was||was.at!==r.at)?r.outcome:'';}
  function rehearsalLine(outcome){
    if(outcome==='finished')return 'Rehearsal finished. Every step ran with a test tone and no paid services. Listen to check the player.';
    if(outcome==='cancelled')return 'Rehearsal cancelled. Nothing was charged, and the video is ready to describe.';
    return job.error?'':'The rehearsal stopped. The video is still ready to describe.';
  }
  async function show(data,focus,opening){
    var changed=shownId!==data.id,before=changed?null:job,previous=changed?'':job&&job.state,lines=[];
    if(changed&&pollController){pollController.abort();pollController=null;}
    job=data;shownId=data.id;
    if(changed){resetView();var cleared=false;if(data.settings){fillForm(data.settings);}else cleared=freshForm();if(cleared)lines.push('New video. Notes are empty and the extra passes are off.');shareDefaults();renderPart();$('folder').value=data.libraryPath||(config&&config.defaultLibraryPath)||DEFAULT_FOLDER;}
    if(job.cancelRequested&&!cancelSeenAt)cancelSeenAt=Date.now();if(!job.cancelRequested)cancelSeenAt=0;
    if(working(job)&&previous&&!working({state:previous}))lastQuarter=-1;
    var rehearsed=previous&&working({state:previous})&&job.state==='ready'?rehearsalEnd(job,before):'';
    var available=copies(),latest=latestVersion(),finishedNow=!changed&&!!previous&&(previous!=='done'&&job.state==='done'||rehearsed==='finished');
    if(available.length){
      if(!viewVersion||!available.some(function(c){return c.version===viewVersion;}))viewVersion=latest;
      else if(latest!==viewVersion&&latest!==lastLatest){if(playing()||inField()||viewVersion!==lastLatest)pendingSwitch=latest;else viewVersion=latest;}
      if(finishedNow&&script&&script.version!==latest){script=null;edits={};editing='';$('edit-fields').hidden=true;$('edit-status').textContent='';}
      lastLatest=latest;
    }
    renderVersions();
    var url=new URL(location.href);url.searchParams.set('id',job.id);url.searchParams.delete('book');url.searchParams.delete('track');history.replaceState(null,'',url);
    $('job-section').hidden=false;if($('job-title').textContent!==job.name)$('job-title').textContent=job.name;
    $('stage').textContent=stateLine(job);
    $('progress').value=job.progress||0;$('progress').hidden=!working(job);
    $('eta').textContent=job.etaSeconds&&working(job)?'About '+length(Math.max(60,Math.round(job.etaSeconds/60)*60))+' left.':'';
    $('cost').textContent=costLine(job);
    var quoteStop=job.state==='failed'&&!!job.overQuote;
    if(job.error&&!quoteStop){if(errorFrom!=='job'||$('error').textContent!==job.error)failure(new Error(job.error),'','job');}
    else if(errorFrom==='job')clearError();
    var name=job.name;
    if(changed){
      if(job.state==='ready'){var trial=!!job.lastRehearsal&&job.lastRehearsal.outcome==='finished'&&!!(latestCopy()||{}).rehearsal;lines.unshift(name+': checked and ready.'+(trial?' The rehearsal finished, and its test copy is below.':'')+' Choose the narration, then Create described copy.');if(tooLong()){$('part').open=true;lines.push('It is '+length(job.seconds)+' long, and one run can describe up to '+length(config.maxMinutes*60)+', so choose the part to describe under Describe only part of it.');}}
      else if(job.state==='done'){lines.unshift(name+': '+((latestCopy()||{}).rehearsal?'rehearsal finished.':job.preview?'preview finished.':'finished.'));var expiry=renderExpiry();if(expiry)lines.push(expiry);var draft=renderDraftNote();if(draft)lines.push(draft);}
      else lines.unshift(name+': '+stateLine(job));
      if(opening){lines.unshift(opening);if(available.some(function(c){return !c.rehearsal;}))lines.splice(2,0,'Your described copy is below.');}
      say(lines.join(' '),true);
      if(working(job))lastQuarter=Math.floor((job.progress||0)/25);
    }else if(opening)say(opening+' It is already open.',true);
    else if(previous!==job.state){
      if(rehearsed){var ending=rehearsalLine(rehearsed);if(ending)say(ending,true);}
      else if(job.state==='ready')say('Video checked. Choose the narration, then Create described copy.'+(tooLong()?' It is longer than one run can describe, so choose the part to describe.':''),true);
      else if(job.state==='done'){renderDraftNote();var newest=latestCopy()||{};say(newest.rehearsal?'Rehearsal finished. Every step ran with a test tone and no paid services. Listen to check the player.':job.preview?'Preview ready. Listen, then choose Describe the rest, or change the settings and try the preview again.':pendingSwitch?'Version '+pendingSwitch+' is ready. Press Switch to version '+pendingSwitch+' to hear it.':'Your described copy is ready.',true);}
      else if(job.state==='failed')say(stoppedLine(job),true);
      else if(job.state==='cancelled'){say('Cancelled. Finished sections are kept, so you can continue later.',true);land('job-title',$('cancel'));}
      else if(job.state==='running')progressSpeech(job);
      else say(stateLine(job));
    }else if(job.state==='running')progressSpeech(job);
    pageTitle();markCurrent();
    var resultFocus=!!focus&&job.state==='done';
    try{
      if(available.length&&loadedFiles!==job.id+'/'+viewVersion)await files(resultFocus||(finishedNow&&!pendingSwitch&&!playing()&&!inField()));
      else if(resultFocus&&!$('results').hidden)$('result-title').focus();
    }catch(e){failure(e);if(focus)$('job-title').focus();}
    finally{
      if(shownId===data.id){
        if(!available.length){$('results').hidden=true;$('skip').hidden=true;}
        controls();
        if(rehearsed)land('job-title',$('cancel'));
        if(changed||previous!==job.state)scheduleEstimates(false);
        if(focus&&!resultFocus)$(job.state==='ready'?'settings-heading':'job-title').focus();
        if(timer)clearTimeout(timer);timer=null;
        if(!stopped&&working(job))timer=setTimeout(poll,document.hidden?20000:5000);
      }
    }
  }
  function stoppedLine(j){
    if(j.overQuote)return j.name+' stopped because it is costing more than quoted: '+money(j.runCostUSD)+' spent of about '+money(j.estimatedUSD)+'. To let it carry on, press Allow more and continue; it asks before spending.';
    if(j.recheckable)return j.name+': the check was interrupted. Press Check again; checking is free.';
    return j.name+' stopped before finishing. '+(j.resumable?(Number(j.done)?'Press Continue where it stopped to carry on.':'Press Try again from the beginning to start over.'):'');
  }
  async function showIf(id,data,focus){if(shownId===id)await show(data,focus);}
  async function poll(){
    if(!job||stopped)return;var id=job.id;
    if(pollController)pollController.abort();var controller=pollController=new AbortController();
    try{
      var data=await call('/jobs/'+id,'GET',undefined,false,'',controller.signal);
      if(controller!==pollController||shownId!==id)return;pollController=null;
      if(errorFrom==='poll'){clearError();say('Reconnected.',true);}
      await show(data,false);
    }catch(e){
      if(e.name==='AbortError'||controller!==pollController||shownId!==id)return;pollController=null;
      if(e.auth)return;
      failure(e.network?new Error('Lost the connection to Kade-AI. Trying again; your video keeps processing on the server.'):e,'','poll');
      if(stopped)return;if(timer)clearTimeout(timer);timer=setTimeout(poll,20000);
    }
  }
  function listText(item){return item.name+', '+friendly(item)+(item.seconds?', '+length(item.seconds):'')+(item.createdAt?', '+when(item.createdAt):'');}
  function openJob(id){clearError();if(pollController){pollController.abort();pollController=null;}if(timer){clearTimeout(timer);timer=null;}var seq=++openSeq;call('/jobs/'+id).then(function(current){if(seq!==openSeq)return;return show(current,true);}).catch(function(e){failure(e);});}
  function scheduleList(jobs){if(listTimer)clearTimeout(listTimer);listTimer=null;if(stopped||!jobs.some(working))return;listTimer=setTimeout(function(){listTimer=null;list().catch(function(){scheduleList(jobs);});},document.hidden?120000:45000);}
  async function list(){
    var data=await call('/jobs');if(typeof data.remainingUSD==='number'&&config)config.remainingUSD=data.remainingUSD;
    var jobs=data.jobs||[],box=$('history'),ids=jobs.map(function(item){return item.id;}).join(',');
    var active=document.activeElement,focusedId=active&&active.getAttribute?active.getAttribute('data-job'):null;
    if(ids!==listedIds||!jobs.length){
      listedIds=ids;box.textContent='';listButtons={};
      if(!jobs.length){var empty=document.createElement('li');empty.textContent='No videos yet.';box.appendChild(empty);}
      jobs.forEach(function(item){var li=document.createElement('li'),button=document.createElement('button');button.type='button';button.setAttribute('data-job',item.id);button.onclick=function(){openJob(item.id);};li.appendChild(button);box.appendChild(li);listButtons[item.id]=button;});
      if(focusedId&&listButtons[focusedId])listButtons[focusedId].focus();
    }
    jobs.forEach(function(item){
      var button=listButtons[item.id],text=listText(item);if(button.textContent!==text)button.textContent=text;
      var before=listStates[item.id];
      if(before&&item.id!==shownId&&working({state:before})&&(item.state==='done'||item.state==='failed'))say('“'+item.name+'” '+(item.state==='done'?'is ready.':'stopped before finishing.'),true);
      listStates[item.id]=item.state;
    });
    lastJobs=jobs;markCurrent();scheduleList(jobs);
    return jobs;
  }
  function onSettingsChange(id){
    if(id==='rate'&&Number($('max-rate').value)<Number($('rate').value))$('max-rate').value=$('rate').value;
    if(id==='max-rate'&&Number($('max-rate').value)<Number($('rate').value))$('rate').value=$('max-rate').value;
    if(id==='voice'){describeVoice();$('sample').hidden=true;}
    if(['voice','rate','max-rate','mode','detail','volume'].indexOf(id)>=0)remember();
    var p=renderPart();controls();
    if(id==='notes')return;
    var prefix='';
    if(id==='close-look')prefix='Closer look '+($('close-look').checked?'on.':'off.');
    if(id==='first-look')prefix='First look '+($('first-look').checked?'on.':'off.');
    if(id==='part-from'||id==='part-to'){if(p.error){say(p.error,true);return;}prefix=p.range?'Part: '+length(p.range.end-p.range.start)+'.':'The whole video.';presetSig='';}
    var paid=['detail','mode','close-look','first-look','part-from','part-to'].indexOf(id)>=0;
    scheduleEstimates(paid&&!!job&&!!job.seconds,prefix);
  }
  ['voice','rate','max-rate','mode','detail','volume','notes','close-look','first-look','part-from','part-to'].forEach(function(id){$(id).addEventListener('change',function(){onSettingsChange(id);});});
  ['commercials','tv','film','custom'].forEach(function(name){$('preset-'+name).addEventListener('change',function(){
    if(!$('preset-'+name).checked)return;
    if(name==='custom'){$('customize').open=true;say('Customize is open below the voice choices.',true);return;}
    applyPreset(name);renderPart();controls();
    if(job&&job.seconds)scheduleEstimates(true,presetSummary(name));else say(presetSummary(name),true);
  });});
  $('voice-kind').addEventListener('change',function(){
    var before=$('voice').value;fillVoices();var count=$('voice').options.length;
    if(before!==$('voice').value){describeVoice();remember();controls();}
    say(plural(count,'voice','voices')+' in '+$('voice-kind').options[$('voice-kind').selectedIndex].textContent+'.',true);
  });
  $('progress-pref').addEventListener('change',function(){store(PROGRESS_KEY,$('progress-pref').value);lastQuarter=-1;});
  $('file').addEventListener('change',function(){$('file').removeAttribute('aria-invalid');$('upload-error').hidden=true;controls();});
  $('youtube').addEventListener('input',controls);
  $('library').addEventListener('input',function(){checkLibraryLink();controls();});
  async function playSample(rate,text,button){
    clearError();if(voicesOff)return;var audio=$('sample'),voice=$('voice').value;
    try{var unlock=audio.play();if(unlock&&unlock.catch)unlock.catch(function(){});}catch(e){}
    $('video').pause();$('audio').pause();button.disabled=true;
    say('Making a sample of '+voiceName(voice)+' at '+rate+'×'+(text?' saying your words':'')+'.',true);
    try{
      var body={voice:voice,rate:rate};if(text)body.text=text;
      var blob=await call('/sample','POST',body,false,'blob');
      if(audio.src)URL.revokeObjectURL(audio.src);audio.src=URL.createObjectURL(blob);audio.hidden=false;
      await audio.play().catch(function(){say('The sample is ready. Press Play on the voice sample player just below.',true);audio.focus();});
    }catch(e){failure(e);}finally{button.disabled=voicesOff;}
  }
  $('sample-play').onclick=function(){playSample(Number($('rate').value),'',$('sample-play'));};
  $('sample-fast').onclick=function(){playSample(Number($('max-rate').value),'',$('sample-fast'));};
  $('say-play').onclick=function(){var text=$('say-text').value.trim();if(!text){say('Type a word or name to hear first.',true);$('say-text').focus();return;}playSample(Number($('rate').value),text,$('say-play'));};
  $('import').onclick=function(){
    var url=$('youtube').value.trim();if(!url)return;
    act(async function(){
      clearError();var key='kade-youtube-import:'+url,id;try{id=sessionStorage.getItem(key);}catch(e){}
      id=id||uuid();try{sessionStorage.setItem(key,id);}catch(e){}
      var imported=await call('/imports','POST',{url:url,requestId:id});
      if(['failed','cancelled','done'].indexOf(imported.state)>=0){id=uuid();try{sessionStorage.setItem(key,id);}catch(e){}imported=await call('/imports','POST',{url:url,requestId:id});}
      $('youtube').value='';await show(imported,true);await list();
    });
  };
  $('library-use').onclick=function(){
    var link=libraryLink($('library').value);if(!link){checkLibraryLink();return;}
    act(async function(){
      clearError();var created=await call('/library-imports','POST',{book:link.book,track:link.track,requestId:uuid()});$('library').value='';checkLibraryLink();
      await show(created,true,created.existing?'You already have this video.':'');
      await list();
    });
  };
  async function act(fn,where){if(inflight)return;inflight=true;try{await fn();}catch(e){failure(e,where);}finally{inflight=false;controls();}}
  function durationOf(file){
    return new Promise(function(resolve){
      var url;try{url=URL.createObjectURL(file);}catch(e){resolve(0);return;}
      var probe=document.createElement('video'),settled=false,limit;
      var finish=function(value){if(settled)return;settled=true;clearTimeout(limit);probe.onloadedmetadata=null;probe.onerror=null;probe.removeAttribute('src');try{URL.revokeObjectURL(url);}catch(e){}resolve(value);};
      limit=setTimeout(function(){finish(0);},5000);
      probe.preload='metadata';probe.onloadedmetadata=function(){finish(isFinite(probe.duration)?probe.duration:0);};probe.onerror=function(){finish(0);};probe.src=url;
    });
  }
  function fileProblem(message){$('file').setAttribute('aria-invalid','true');failure(new Error(message),'upload-error');}
  function sendChunk(id,number,blob,progress){
    return new Promise(function(resolve,reject){
      var request=xhr=new XMLHttpRequest();
      request.open('POST','/api/kade/described-video/jobs/'+id+'/chunks');request.setRequestHeader('Authorization','Bearer '+token);request.setRequestHeader('Content-Type','application/octet-stream');request.setRequestHeader('X-Part-Number',String(number));request.timeout=180000;
      request.upload.onprogress=function(event){if(event.lengthComputable)progress(event.loaded);};
      request.onload=function(){var data=null;try{data=JSON.parse(request.responseText);}catch(e){}resolve({status:request.status,data:data});};
      request.onerror=function(){resolve({status:0,data:null});};request.ontimeout=function(){resolve({status:0,data:null});};
      request.onabort=function(){var error=new Error('Upload stopped. Choose the same file to carry on from where it stopped.');error.byYou=true;reject(error);};
      request.send(blob);
    });
  }
  var WAITS=[5,10,20,40,60,60];
  async function uploadPart(id,number,blob,progress){
    var refreshed=false,warned=false;
    for(var attempt=0;;){
      var result=await sendChunk(id,number,blob,progress);
      if(result.status>=200&&result.status<300&&result.data)return result.data;
      if(result.status===401&&!refreshed){refreshed=true;await refreshToken();continue;}
      var retryable=result.status===0||result.status===408||result.status===429||result.status>=500||result.status>=200&&result.status<300;
      if(!retryable){if(result.status===403)stopped=true;throw new Error(result.data&&result.data.error||'Upload did not complete. Choose the same file to carry on from where it stopped.');}
      if(attempt>=WAITS.length){var dropped=new Error('The upload connection keeps dropping. It carries on by itself when you come back to this page with the same file chosen, or choose the same file to carry on from where it stopped.');dropped.dropped=true;throw dropped;}
      if(!warned){warned=true;say('Connection lost, retrying…',true);}
      await pause(WAITS[attempt++]*1000);
      if(stopUpload){var halt=new Error('Upload stopped. Choose the same file to carry on from where it stopped.');halt.byYou=true;throw halt;}
    }
  }
  function uploadGone(file){say('The unfinished upload of '+file.name+' is no longer on Kade-AI, so it did not carry on. Press Upload and check video to send it again.');}
  function forgetUpload(gone){
    var recoveries=stored(UPLOADS_KEY,{})||{},dropped=false;
    Object.keys(recoveries).forEach(function(key){if(recoveries[key]&&recoveries[key].jobId===gone.id){delete recoveries[key];dropped=true;}});
    if(dropped)store(UPLOADS_KEY,recoveries);
    var file=pendingUpload;
    if(!file||!(pendingJob===gone.id||gone.state==='uploading'&&gone.name===file.name&&gone.bytes===file.size))return;
    pendingUpload=null;pendingJob='';if($('file').files[0]===file)$('file').value='';
  }
  async function upload(auto){
    var file=$('file').files[0];if(!file||uploading)return;
    if(auto){$('upload-error').hidden=true;$('upload-error').textContent='';}else clearError();
    $('file').removeAttribute('aria-invalid');pendingUpload=null;pendingJob='';
    if(file.size>config.maxBytes){fileProblem('Choose a video no larger than 2 GB.');return;}
    uploading=true;stopUpload=false;controls();
    var up=null,recoveries=stored(UPLOADS_KEY,{}),key=file.name+'|'+file.size+'|'+file.lastModified,byYou=false;
    try{
      if(!auto)say('Checking the length of '+file.name+'.',true);
      var seconds=await durationOf(file),limit=((config.maxSourceMinutes||config.maxMinutes)*60);
      if(seconds>limit){fileProblem('This video is '+length(seconds)+' long; the longest that can be checked is '+length(limit)+'.');return;}
      var saved=recoveries&&recoveries[key]||{},requestId=saved.requestId||uuid();
      var match=lastJobs.filter(function(item){return item.state==='uploading'&&item.bytes===file.size&&(item.id===saved.jobId||item.name===file.name);})[0];
      var resumeId=saved.jobId||(match&&match.id)||undefined,created;
      try{created=await call('/uploads','POST',{requestId:requestId,name:file.name,bytes:file.size,resumeId:resumeId});}
      catch(e){if(!resumeId||e.network||e.status>=500||e.auth)throw e;delete recoveries[key];store(UPLOADS_KEY,recoveries);if(auto){uploadGone(file);return;}requestId=uuid();created=await call('/uploads','POST',{requestId:requestId,name:file.name,bytes:file.size});}
      if(['failed','cancelled','done'].indexOf(created.job.state)>=0){if(auto){delete recoveries[key];store(UPLOADS_KEY,recoveries);uploadGone(file);return;}requestId=uuid();created=await call('/uploads','POST',{requestId:requestId,name:file.name,bytes:file.size});}
      up={id:created.job.id,name:created.job.name};uploadId=up.id;recoveries[key]={requestId:requestId,jobId:up.id};store(UPLOADS_KEY,recoveries);
      if(!auto||!shownId||shownId===up.id)await show(created.job,false);
      if(created.job.state==='uploading'){
        $('upload-progress').hidden=false;$('stop-upload').hidden=false;$('upload-progress').value=0;if(!auto)land('stop-upload',$('upload'));
        var size=created.chunkBytes||config.chunkBytes,done=created.job.uploadedBytes||0,offset=done?Math.floor((done-1)/size)*size:0,last=-1;
        var held=await holdScreen(),start=offset?'Carrying on'+(auto?' with '+file.name:'')+' from '+Math.floor(offset/file.size*100)+' percent.':'Uploading '+file.name+'.';
        if(toldKeepOpen!==key){toldKeepOpen=key;start+=held?' Keep this page open; the screen will stay on until the upload finishes.':' Keep this page open and the screen on until the upload finishes.';}
        say(start,!auto);
        while(offset<file.size){
          var from=offset;
          var result=await uploadPart(up.id,Math.floor(offset/size)+1,file.slice(offset,Math.min(file.size,offset+size)),function(loaded){var value=Math.floor((from+loaded)/file.size*100);$('upload-progress').value=value;if(Math.floor(value/10)!==last){last=Math.floor(value/10);if(!playing())say('Uploading: '+value+' percent.',true);}});
          if(result.id&&result.id!==up.id)throw new Error('The server answered for a different upload, so this one stopped. Choose the same file to carry on.');
          if(shownId===up.id)job=result;
          offset+=size;
        }
      }
      var prepared=await call('/jobs/'+up.id+'/prepare','POST',{});
      delete recoveries[key];store(UPLOADS_KEY,recoveries);$('file').value='';toldKeepOpen='';
      if(shownId===up.id)await show(prepared,true);else say('“'+up.name+'” is uploaded and being checked.',true);
      await list();
    }catch(e){
      byYou=!!e.byYou;failure(e,'upload-error');
      if(!byYou&&(e.dropped||e.network)){pendingUpload=file;pendingJob=up?up.id:'';}
      if(up&&shownId===up.id)await call('/jobs/'+up.id).then(function(current){return showIf(up.id,current,false);}).catch(function(){});
    }finally{
      releaseScreen();
      uploading=false;uploadId='';xhr=null;$('upload-progress').hidden=true;$('stop-upload').hidden=true;controls();
      if(byYou)land('upload',$('stop-upload'));
    }
  }
  $('upload').onclick=function(){upload();};
  function carryOnUpload(){
    if(uploading){holdScreen();if(nudge)nudge();return;}
    var file=pendingUpload;if(!file||$('file').files[0]!==file||!config||!config.enabled)return;
    upload(true);
  }
  $('stop-upload').onclick=function(){stopUpload=true;if(xhr)xhr.abort();};
  window.addEventListener('beforeunload',function(event){if(!uploading)return;event.preventDefault();event.returnValue='';});
  function describeRun(s){return voiceName(s.voice)+' at '+s.rate+'×, '+(DETAIL_NAMES[s.detail]||s.detail)+', '+(s.mode==='extended'?'pausing the picture when needed':'keeping the original length')+', closer look '+(s.closeLook?'on':'off')+', first look '+(s.firstLook?'on':'off')+', notes: '+(s.notes||'none');}
  function begin(preview){
    var id=preview?'preview':'start';if(!job||blocked(id))return;
    act(async function(){
      clearError();var jobId=job.id,s=settings(),e=await freshEstimate(id,{settings:s});
      if(shownId!==jobId)return;
      if(!e.allowed){say(refusal(e),true);return;}
      var text=(preview?previewName()+' of “':'Create a described copy of “')+job.name+'”'+(s.range?', '+clock(s.range.start)+' to '+clock(s.range.end):'')+': '+describeRun(s)+'. About '+money(e.estimateUSD)+'; '+money(e.setAsideUSD)+' is set aside until it finishes. '+(preview&&e.breakdown&&e.breakdown.dialogue>=0.05?'That includes '+money(e.breakdown.dialogue)+' to learn the dialogue of the whole '+(s.range?'part':'video')+'. ':'')+''+allowance(e)+' Go ahead?';
      if(!confirm(text))return;
      remember();rememberVoice(s.voice);
      var body=Object.assign({},s);if(preview)body.preview=true;
      var updated=await call('/jobs/'+jobId+'/start','POST',body);
      await showIf(jobId,updated,false);
      say(preview?'Started the preview. You will hear when it is ready.':'Started. You can leave this page; the job keeps going, and you will get a notice when it is done.',true);
      land('job-title',$(id));await list();
    });
  }
  $('start').onclick=function(){begin(false);};
  $('preview').onclick=function(){begin(true);};
  function cleanEdit(edit,original){var text=(edit.text||'').trim(),shortText=(edit.shortText||'').trim();if(edit.omit&&!text)text=original?original.text:'';if(!shortText)shortText=text.slice(0,200);return {id:edit.id,text:text,shortText:shortText,omit:!!edit.omit};}
  function scriptCue(id){return script?script.cues.filter(function(cue){return cue.id===id;})[0]:null;}
  function staleShort(edit){var original=scriptCue(edit.id);return !!original&&!edit.omit&&original.shortText!==original.text&&edit.text!==original.text&&edit.shortText===original.shortText;}
  function remake(withEdits){
    var button=withEdits?'edit-save':'revoice';if(!job||blocked(button))return;
    act(async function(){
      clearError();var id=job.id,s=settings(),body={voice:s.voice,rate:s.rate,maxRate:s.maxRate,mode:s.mode,volume:s.volume},list=[],expected=job.version||1;
      if(withEdits){
        if(!script||scriptJob!==id){say('Open the latest script first.',true);return;}
        if(!saveEdit())return;
        var bad=Object.keys(edits).map(function(key){return edits[key];}).filter(function(edit){return !edit.omit&&!(edit.text||'').trim();})[0];
        if(bad){pickCue(bad.id);saveEdit();return;}
        list=Object.keys(edits).map(function(key){return edits[key];});expected=script.version;
        if(!list.length){say('No changes yet.',true);return;}
      }else{
        var draft=draftsFor(id).filter(function(d){return d.version===expected;})[0];
        if(draft&&confirm('Include your '+plural(draft.count,'draft correction','draft corrections')+' in the new version? Choose Cancel to make it without them; the draft stays saved.')){var saved=readDraft(draft.key);list=Object.keys(saved).map(function(key){return saved[key];}).filter(function(edit){return edit.omit||(edit.text||'').trim();});}
      }
      var stale=list.filter(staleShort).length;
      if(list.length){body.edits=list.map(function(edit){return cleanEdit(edit,scriptCue(edit.id));});}
      body.expectedVersion=expected;
      var e=await freshEstimate('revoice',{settings:s,edits:body.edits});
      if(shownId!==id)return;if(!e.allowed){say(refusal(e),true);return;}
      var next=(job.version||1)+1;
      if(!confirm('Make version '+next+' of “'+job.name+'”'+(list.length?' with '+plural(list.length,'correction','corrections'):' with '+voiceName(s.voice)+' at '+s.rate+'×')+'? About '+money(e.estimateUSD)+'. '+allowance(e)+(stale?' '+plural(stale,'corrected description still has','corrected descriptions still have')+' the old short version, which is used when the gap is tight.':'')+' Earlier versions stay available.'))return;
      remember();rememberVoice(s.voice);
      var updated=await call('/jobs/'+id+'/revoice','POST',body);
      if(list.length){forget(draftKey(id,expected));if(shownId===id){edits={};script=null;$('edit-fields').hidden=true;$('edit-status').textContent='';renderDraftNote();}}
      await showIf(id,updated,false);
      say('Making version '+next+'. You can still play the earlier copy below.',true);
      land('job-title',$(button));await list();
    },withEdits?'edit-problem':'');
  }
  $('revoice').onclick=function(){remake(false);};
  function fresh(preview){
    var button=preview?'preview-again':'reanalyze';if(!job||blocked(button))return;
    act(async function(){
      clearError();var id=job.id,s=settings(),e=await freshEstimate(preview?'preview':'reanalyze',{settings:s});
      if(shownId!==id)return;if(!e.allowed){say(refusal(e),true);return;}
      if(!confirm((preview?'Try the preview of “'+job.name+'” again with ':'Write fresh descriptions for “'+job.name+'” with ')+describeRun(s)+'? This pays for looking at the video again. Narration is included. About '+money(e.estimateUSD)+'. '+allowance(e)+' Earlier versions stay available.'))return;
      remember();rememberVoice(s.voice);
      var body=Object.assign({},s,{expectedVersion:job.version||1});if(preview)body.preview=true;
      var updated=await call('/jobs/'+id+'/reanalyze','POST',body);
      if(shownId===id){script=null;edits={};$('edit-fields').hidden=true;}
      await showIf(id,updated,false);
      say(preview?'Trying the preview again. You will hear when it is ready.':'Writing fresh descriptions. Earlier versions are still available below.',true);
      land('job-title',$(button));await list();
    });
  }
  $('reanalyze').onclick=function(){fresh(false);};
  $('preview-again').onclick=function(){fresh(true);};
  $('change-settings').onclick=function(){$('settings-heading').focus();say('Change the choices, then press Try the preview again with these choices.',true);};
  $('finish').onclick=function(){
    if(!job||blocked('finish'))return;
    act(async function(){
      clearError();var id=job.id,e=await freshEstimate('finish');
      if(shownId!==id)return;if(!e.allowed){say(refusal(e),true);return;}
      if(!confirm('Describe the rest of “'+job.name+'” with the same choices? The preview’s parts are kept and not paid for again. About '+money(e.estimateUSD)+'; '+money(e.setAsideUSD)+' is set aside until it finishes, and anything unused comes back. '+allowance(e)+' Go ahead?'))return;
      var updated=await call('/jobs/'+id+'/finish','POST',{});
      await showIf(id,updated,false);say('Describing the rest. The preview parts are reused.',true);land('job-title',$('finish'));await list();
    });
  };
  $('redo').onclick=function(){
    if(!job||blocked('redo'))return;
    act(async function(){
      clearError();var id=job.id,n=retryCount(job),e=await freshEstimate('redo');
      if(shownId!==id)return;if(!e.allowed){say(refusal(e),true);return;}
      if(!confirm('Try again on the '+plural(n,'part','parts')+' of “'+job.name+'” that could not be described? Everything else is reused and not paid for again, and it makes version '+((job.version||1)+1)+'; version '+(job.version||1)+' stays available. About '+money(e.estimateUSD)+'. '+allowance(e)))return;
      var updated=await call('/jobs/'+id+'/redo','POST',{expectedVersion:job.version||1});
      await showIf(id,updated,false);say('Trying those parts again. The current version stays available.',true);land('job-title',$('redo'));await list();
    });
  };
  function cueTime(cue){var at=cue.outputAt!==undefined?cue.outputAt:cue.at,text=clock(at);if(cue.outputAt!==undefined&&Math.abs(cue.outputAt-cue.at)>=1)text+=', original '+clock(cue.at);return text;}
  function cueLabel(cue){
    var edit=edits[cue.id],text=(edit?edit.text:cue.text)||'',status=edit&&edit.omit||!edit&&cue.omit?'Left out: ':edit?'Changed: ':cue.spoken===false?'Not spoken: ':'';
    return status+cueTime(cue)+'. '+(text.length>60?text.slice(0,60)+'…':text);
  }
  function shownCues(){var filter=$('edit-show').value;return script.cues.filter(function(cue){if(filter==='unspoken')return cue.spoken===false;if(filter==='changed')return !!edits[cue.id];return true;});}
  function fillCues(){
    var select=$('edit-cue');select.textContent='';
    shownCues().forEach(function(cue){var option=document.createElement('option');option.value=cue.id;option.textContent=cueLabel(cue);select.appendChild(option);});
    if(editing&&setSelect('edit-cue',editing))return;
    editing=select.value;
  }
  function refreshOption(id){var cue=scriptCue(id);if(!cue)return;Array.prototype.forEach.call($('edit-cue').options,function(option){if(option.value===id)option.textContent=cueLabel(cue);});}
  function editError(text){
    $('edit-error').hidden=!text;$('edit-error').textContent=text;
    if(text)$('edit-text').setAttribute('aria-invalid','true');else $('edit-text').removeAttribute('aria-invalid');
  }
  function saveDraft(){var kept=true;if(!script)return true;var key=draftKey(scriptJob,script.version);if(Object.keys(edits).length)kept=store(key,edits);else forget(key);return kept;}
  function editStatus(kept){
    var count=Object.keys(edits).length,original=scriptCue(editing),edit=edits[editing],warn=!!edit&&staleShort(edit);
    var text=(count?plural(count,'description','descriptions')+' changed in your draft.'+(kept?' The draft is saved in this browser only.':' This browser cannot save the draft; keep this page open until you make the new version.'):'No changes yet.');
    if(warn){text+=' The short version still says: “'+original.shortText+'”. It is used when the gap is tight.';if(!warnedShort[editing]){warnedShort[editing]=true;say('The short version still has the old wording.',true);}}
    $('edit-copy-short').hidden=!warn;
    if($('edit-status').textContent!==text)$('edit-status').textContent=text;
    $('edit-reset').textContent=count?'Discard all '+plural(count,'draft change','draft changes'):'Discard all draft changes';
  }
  function saveEdit(){
    if(!script||!editing||!job||job.id!==scriptJob)return true;
    var original=scriptCue(editing);if(!original)return true;
    var text=$('edit-text').value.trim(),shortText=$('edit-short').value.trim(),omit=$('edit-omit').checked;
    if(!text&&!omit){editError('The description at '+cueTime(original)+' is empty. Type new wording or check Leave this description out.');$('edit-text').focus();return false;}
    editError('');
    if(omit&&!text)text=original.text;if(!shortText)shortText=text.slice(0,200);
    if(text===original.text&&shortText===original.shortText&&omit===!!original.omit)delete edits[editing];
    else edits[editing]={id:editing,text:text,shortText:shortText,omit:omit,was:original.text};
    var kept=saveDraft();refreshOption(editing);editStatus(kept);
    return true;
  }
  function editCue(){
    editing=$('edit-cue').value;var original=scriptCue(editing);if(!original)return;
    var value=edits[editing]||original;$('edit-text').value=value.text;$('edit-short').value=value.shortText;$('edit-omit').checked=!!value.omit;
    editError('');editStatus(true);scheduleRedoEstimate();
  }
  function pickCue(id){if(!setSelect('edit-cue',id)){$('edit-show').value='all';fillCues();setSelect('edit-cue',id);}editCue();}
  function renderStale(){
    var box=$('stale'),list=$('stale-list');list.textContent='';box.hidden=!staleDrafts.length;
    staleDrafts.forEach(function(edit){var li=document.createElement('li');li.textContent='Version '+edit.version+': '+(edit.omit?'leave out “'+(edit.was||edit.text)+'”':'“'+(edit.was||'')+'” became “'+edit.text+'”');list.appendChild(li);});
  }
  function carryDrafts(id){
    var byId={},moved=0;staleDrafts=[];script.cues.forEach(function(cue){byId[cue.id]=cue;});
    draftsFor(id).filter(function(d){return d.version<script.version;}).forEach(function(d){
      var old=readDraft(d.key),left={};
      Object.keys(old).forEach(function(key){var edit=old[key],cue=byId[edit.id];if(cue&&edit.was!==undefined&&edit.was===cue.text&&!edits[edit.id]){edits[edit.id]=edit;moved++;}else{left[key]=edit;staleDrafts.push(Object.assign({version:d.version},edit));}});
      if(Object.keys(left).length)store(d.key,left);else forget(d.key);
    });
    if(moved)saveDraft();renderStale();
    return moved;
  }
  async function loadScript(){
    var id=job.id,result=await call('/jobs/'+id+'/script');
    if(shownId!==id)return false;
    script=result;scriptJob=id;edits=readDraft(draftKey(id,script.version));shortTouched={};warnedShort={};editing='';
    var moved=carryDrafts(id);
    if(viewVersion!==script.version){viewVersion=script.version;pendingSwitch=0;renderVersions();await files(false);}
    fillCues();$('edit-fields').hidden=!script.cues.length;
    if(script.cues.length)editCue();
    renderDraftNote();
    return {moved:moved,count:Object.keys(edits).length};
  }
  $('edit-load').onclick=function(){
    if(!job)return;
    act(async function(){
      clearError();var loaded=await loadScript();if(!loaded)return;
      if(!script.cues.length){say('There are no descriptions to edit in this copy.',true);return;}
      $('edit-cue').focus();
      say(plural(script.cues.length,'description','descriptions')+' in version '+script.version+'.'+(loaded.moved?' '+plural(loaded.moved,'draft correction was','draft corrections were')+' carried over from the earlier version.':loaded.count?' '+plural(loaded.count,'draft correction was','draft corrections were')+' restored from this browser.':'')+(staleDrafts.length?' '+plural(staleDrafts.length,'older correction no longer matches','older corrections no longer match')+'; they are listed above.':''),true);
    },'edit-problem');
  };
  $('edit-cue').onchange=function(){if(!saveEdit()){setSelect('edit-cue',editing);return;}editCue();};
  $('edit-show').onchange=function(){if(!script)return;saveEdit();fillCues();editCue();say(plural($('edit-cue').options.length,'description','descriptions')+' shown.',true);};
  function stepCue(step){
    if(!script||!saveEdit())return;var select=$('edit-cue'),index=select.selectedIndex+step;
    if(index<0||index>=select.options.length){say(step>0?'That was the last description.':'That was the first description.',true);return;}
    select.selectedIndex=index;editCue();say(select.options[index].textContent,true);
  }
  $('edit-prev').onclick=function(){stepCue(-1);};$('edit-next').onclick=function(){stepCue(1);};
  $('edit-text').addEventListener('input',function(){var original=scriptCue(editing);if(original&&original.shortText===original.text&&!shortTouched[editing])$('edit-short').value=$('edit-text').value.trim().slice(0,200);saveEdit();});
  $('edit-short').addEventListener('input',function(){shortTouched[editing]=true;saveEdit();});
  $('edit-omit').addEventListener('change',function(){saveEdit();});
  $('edit-copy-short').onclick=function(){$('edit-short').value=$('edit-text').value.trim().slice(0,200);shortTouched[editing]=true;saveEdit();say('The short version now uses the corrected wording.',true);$('edit-short').focus();};
  $('edit-undo').onclick=function(){if(!script||!editing)return;delete edits[editing];shortTouched[editing]=false;var kept=saveDraft();editCue();refreshOption(editing);editStatus(kept);say('Changes to this description undone.',true);};
  $('edit-reset').onclick=function(){var count=Object.keys(edits).length;if(!script||!count){say('There are no draft changes.',true);return;}if(!confirm('Discard all '+plural(count,'draft change','draft changes')+'?'))return;edits={};shortTouched={};saveDraft();fillCues();editCue();renderDraftNote();say('Draft changes discarded.',true);};
  $('edit-review').onclick=function(){
    if(!script||!saveEdit())return;var list=$('edit-review-list');list.textContent='';
    var changed=script.cues.filter(function(cue){return !!edits[cue.id];});
    if(!changed.length){list.hidden=true;say('No changes yet.',true);return;}
    changed.forEach(function(cue){var edit=edits[cue.id],li=document.createElement('li');li.textContent=cueTime(cue)+': '+(edit.omit?'left out. It said “'+cue.text+'”.':'was “'+cue.text+'”, now “'+edit.text+'”'+(edit.shortText!==cue.shortText?'; short version “'+edit.shortText+'”':'')+'.');list.appendChild(li);});
    list.hidden=false;list.focus();
  };
  $('stale-forget').onclick=function(){if(!job)return;draftsFor(job.id).filter(function(d){return !script||d.version<script.version;}).forEach(function(d){forget(d.key);});staleDrafts=[];renderStale();renderDraftNote();say('The old corrections are forgotten.',true);$('edit-load').focus();};
  $('edit-listen').onclick=function(){
    if(!script)return;
    act(async function(){if(viewVersion!==script.version){viewVersion=script.version;pendingSwitch=0;renderVersions();await files(false);}var cue=scriptCue(editing);if(cue){var m=media();m.currentTime=Math.max(0,(cue.outputAt!==undefined?cue.outputAt:cue.at)-3);await m.play().catch(function(){failure(new Error('Playback could not start. Press Play in the player.'));});}},'edit-problem');
  };
  $('edit-save').onclick=function(){remake(true);};
  function scheduleRedoEstimate(){
    if(redoTimer)clearTimeout(redoTimer);var cue=scriptCue(editing);redoEstimate=null;$('edit-redo').textContent='Describe this part again';
    if(!cue||cue.section===undefined||!job)return;
    redoTimer=setTimeout(function(){redoTimer=null;var seq=++redoSeq,id=job.id;call('/jobs/'+id+'/estimate','POST',{action:'redo',sections:[cue.section]}).then(function(e){if(seq!==redoSeq||shownId!==id)return;redoEstimate=e;$('edit-redo').textContent='Describe this part again, about '+money(e.estimateUSD);}).catch(function(){});},600);
  }
  $('edit-redo').onclick=function(){
    if(!script||!job||blocked('edit-redo'))return;var cue=scriptCue(editing);if(!cue||cue.section===undefined){say('Choose a description first.',true);return;}
    act(async function(){
      clearError();var id=job.id,note=$('edit-note').value.trim(),e=await freshEstimate('redo',{sections:[cue.section]});
      if(shownId!==id)return;if(!e.allowed){say(refusal(e),true);return;}
      if(!confirm('Describe the part around '+cueTime(cue)+' again'+(note?' with your note: '+note:'')+'? Everything else is reused. About '+money(e.estimateUSD)+'. '+allowance(e)))return;
      var body={sections:[cue.section],expectedVersion:script.version};if(note)body.note=note;
      var updated=await call('/jobs/'+id+'/redo','POST',body);
      if(shownId===id){$('edit-note').value='';script=null;$('edit-fields').hidden=true;}
      await showIf(id,updated,false);say('Describing that part again. The current version stays available.',true);land('job-title',$('edit-redo'));await list();
    },'edit-problem');
  };
  $('version').onchange=function(){viewVersion=Number(this.value);if(pendingSwitch===viewVersion)pendingSwitch=0;$('video').pause();$('audio').pause();renderVersions();files(false).catch(failure);};
  $('switch-version').onclick=function(){if(!pendingSwitch)return;viewVersion=pendingSwitch;pendingSwitch=0;$('video').pause();$('audio').pause();renderVersions();files(true).catch(failure);};
  $('resume').onclick=function(){
    if(!job||blocked('resume'))return;
    act(async function(){
      clearError();var id=job.id,body=voiceFields(),e=await freshEstimate('resume',{settings:body});
      if(shownId!==id)return;if(!e.allowed){say(refusal(e),true);return;}
      var again=!Number(job.done);
      if(!confirm((again?'Try “'+job.name+'” again from the beginning':'Continue “'+job.name+'”')+' with '+voiceName(body.voice)+' at '+body.rate+'×? '+keptText(job)+' About '+money(e.estimateUSD)+'; '+money(e.setAsideUSD)+' is set aside until it finishes, and anything unused comes back. '+allowance(e)))return;
      remember();rememberVoice(body.voice);
      var updated=await call('/jobs/'+id+'/resume','POST',body);
      await showIf(id,updated,false);say(again?'Starting again from the beginning.':'Carrying on from where it stopped.',true);land('job-title',$('resume'));await list();
    });
  };
  $('allow-more').onclick=function(){
    if(!job||blocked('allow-more'))return;
    act(async function(){
      clearError();var id=job.id,body=voiceFields(),e=await freshEstimate('resume',{settings:body});
      if(shownId!==id)return;if(!e.allowed){say(refusal(e),true);return;}
      estimates.resume=e;var z=raiseTo();
      if(!confirm('Let “'+job.name+'” carry on? '+overQuoteText(job)+' Carrying on is expected to cost about '+money(e.estimateUSD)+' more. It may spend up to '+money(z)+' more, and it stops and asks again before going past that. '+keptText(job)+' '+allowance(e)))return;
      body.allowUpToUSD=z;
      var updated=await call('/jobs/'+id+'/resume','POST',body);
      await showIf(id,updated,false);say('Carrying on, up to '+money(typeof updated.approvedUSD==='number'?updated.approvedUSD:z)+' more.',true);land('job-title',$('allow-more'));await list();
    });
  };
  $('recheck').onclick=function(){
    if(!job)return;
    act(async function(){
      clearError();var id=job.id,updated=await call('/jobs/'+id+'/recheck','POST',{});
      await showIf(id,updated,false);say('Checking the video again. Checking is free.',true);land('job-title',$('recheck'));await list();
    });
  };
  $('rehearse').onclick=function(){
    if(!job||blocked('rehearse'))return;
    act(async function(){
      clearError();var id=job.id,body=settings();if(!body.voice)delete body.voice;
      var updated=await call('/jobs/'+id+'/rehearse','POST',body);
      await showIf(id,updated,false);say('Rehearsal started. It uses a test tone and no paid services, and you will hear when it is finished.',true);land('job-title',$('rehearse'));await list();
    });
  };
  $('keep').onclick=function(){
    if(!job)return;
    act(async function(){
      clearError();var id=job.id,updated=await call('/jobs/'+id+'/keep','POST',{});
      await showIf(id,updated,false);if(shownId!==id)return;renderExpiry();
      say('Kept until '+when(updated.expiresAt)+'.'+(updated.keepable?'':' That is as long as it can be kept here; download it or save it to your Library to keep it longer.'),true);
      land('result-title',$('keep'));
    });
  };
  $('abandon').onclick=function(){
    if(!job)return;var back=latestVersion();
    act(async function(){
      var id=job.id;if(!confirm('Go back to version '+back+' of “'+job.name+'”? Version '+back+' stays as it was, and going back costs nothing. The stopped attempt is discarded'+(job.runCostUSD?', and the '+money(job.runCostUSD)+' it already cost is not returned':'')+'.'))return;
      clearError();var updated=await call('/jobs/'+id+'/abandon','POST',{});
      await showIf(id,updated,false);say('Back to version '+back+'. You can make a new version again.',true);land($('results').hidden?'job-title':'result-title',$('abandon'));await list();
    });
  };
  $('cancel').onclick=function(){
    if(!job)return;if($('cancel').getAttribute('aria-disabled')==='true'){say('Already cancelling. It stops after the current step.',true);return;}
    act(async function(){
      var id=job.id;if(!confirm('Cancel processing “'+job.name+'”? Finished sections are kept, so you can continue later.'))return;
      clearError();var updated=await call('/jobs/'+id+'/cancel','POST',{});
      await showIf(id,updated,false);
      if(updated.state!=='ready')say(updated.state==='cancelled'?'Cancelled. Finished sections are kept, so you can continue later.':'Cancelling. Finished sections are kept; you can continue later.',true);
      if(!working(updated))land('job-title',$('cancel'));
      await list();
    });
  };
  $('rename').onclick=function(){
    if(!job)return;
    act(async function(){
      var id=job.id,name=prompt('New name for this video',job.name);if(!name||!name.trim()||name.trim()===job.name)return;
      clearError();var updated=await call('/jobs/'+id+'/rename','POST',{name:name.trim()});
      if(shownId!==id)return;loadedFiles='';await show(updated,false);await list();say('Renamed to '+updated.name+'.',true);
    });
  };
  $('delete').onclick=function(){
    if(!job)return;
    act(async function(){
      var id=job.id,gone=job,count=copies().length;
      if(!confirm('Delete “'+job.name+'” and all its files'+(count?', including '+plural(count,'finished version','finished versions'):'')+'? This cannot be undone.'))return;
      clearError();await call('/jobs/'+id,'DELETE');forgetUpload(gone);
      if(shownId===id){job=null;shownId='';resetView();if(timer)clearTimeout(timer);timer=null;$('job-section').hidden=true;history.replaceState(null,'',location.pathname);pageTitle();}
      await list();say('Deleted.',true);land('history-heading',$('delete'));
    });
  };
  $('library-save').onclick=function(){
    if(!job||blocked('library-save'))return;
    act(async function(){
      clearError();var id=job.id,version=viewVersion,path=$('folder').value.trim(),body={share:$('share').checked,version:version};if(path)body.path=path;
      var saved=await call('/jobs/'+id+'/library','POST',body);
      if(shownId!==id)return;
      var copy=copies().filter(function(item){return item.version===version;})[0];if(copy)copy.savedToLibrary=true;
      if(saved&&saved.id===id&&saved.copies)await show(saved,false);else renderVersions();
      if(viewVersion!==version)return;gate('library-save','This version is already saved to your Library.');
      $('library-note').textContent='Saved to your Library'+(saved.path?' in '+saved.path:'')+'.';say($('library-note').textContent,true);
    },'library-save-error');
  };
  $('refresh').onclick=function(){clearError();list().then(function(){if(job&&working(job))return poll();}).catch(failure);};
  $('refresh-files').onclick=function(){refreshedErrorKey='';files(false).catch(failure);};
  ['video','audio','transcript','captions','descriptions','script'].forEach(function(kind){$(kind+'-download').addEventListener('click',function(event){
    if(!filesAt||Date.now()-filesAt<LINK_AGE)return;event.preventDefault();
    files(false).then(function(){location.href=$(kind+'-download').href;}).catch(failure);
  });});
  $('playback-rate').onchange=function(){var rate=Number(this.value);$('video').playbackRate=rate;$('audio').playbackRate=rate;};
  function setPlayAs(value,quiet){
    var audio=value==='audio',from=audio?$('video'):$('audio'),to=media(),at=from.currentTime;
    if(!ended(from))from.pause();$('video').hidden=audio;$('audio').hidden=!audio;
    if(at&&to.currentTime!==at)to.currentTime=at;$('play').textContent=ended(to)?'Play':'Pause';
    store(PLAY_AS_KEY,value);if(!quiet)say(audio?'Playing the audio copy. It keeps playing with the screen locked.':'Playing the video.',true);
  }
  $('play-as').onchange=function(){setPlayAs($('play-as').value,false);};
  ['video','audio'].forEach(function(name){
    var el=$(name);
    el.onplay=function(){$('sample').pause();(name==='video'?$('audio'):$('video')).pause();if(el===media())$('play').textContent='Pause';if(navigator&&navigator.mediaSession)navigator.mediaSession.playbackState='playing';};
    el.onpause=function(){if(el===media()){$('play').textContent='Play';savePosition(el.currentTime);}if(navigator&&navigator.mediaSession)navigator.mediaSession.playbackState='paused';};
    el.addEventListener('timeupdate',function(){if(el!==media())return;var now=Date.now();if(now-lastSaved<5000)return;lastSaved=now;savePosition(el.currentTime);});
    el.addEventListener('ended',function(){if(shownId&&viewVersion)forget(positionKey(shownId,viewVersion));});
    el.onerror=function(){if(!job||!loadedFiles)return;var key=job.id+'/'+viewVersion+'/'+name;if(refreshedErrorKey===key){failure(new Error('Playback could not start. Try the other player, or download the copy.'));return;}refreshedErrorKey=key;files(false).catch(failure);};
  });
  function seek(step){var m=media();m.currentTime=Math.max(0,Math.min(m.duration||0,m.currentTime+step));say('At '+clock(m.currentTime)+'.',true);}
  $('play').onclick=function(){var m=media();if(m.paused)m.play().catch(function(){failure(new Error('Playback could not start. Try the other player, or download the copy.'));});else m.pause();};
  $('back').onclick=function(){seek(-10);};$('forward').onclick=function(){seek(10);};
  function currentCue(){var now=media().currentTime,best=-1;for(var i=0;i<cues.length;i++){if(cues[i].at<=now+0.5)best=i;else break;}return best;}
  function jump(step){
    var m=media();if(!cues.length){say('No descriptions are loaded yet.',true);return;}var now=m.currentTime,index=-1;
    if(lastJump&&Math.abs(now-lastJump.time)<1)index=lastJump.index+step;
    else if(step>0){for(var i=0;i<cues.length;i++)if(cues[i].at>now+0.05){index=i;break;}}
    else{for(var j=cues.length-1;j>=0;j--)if(cues[j].at<now-0.5){index=j;break;}}
    if(index<0||index>=cues.length){say(step>0?'That was the last description.':'That was the first description.',true);return;}
    var target=cues[index];m.currentTime=Math.max(0,target.at-0.3);lastJump={index:index,time:m.currentTime};
    say(ended(m)?clock(target.at)+'. '+target.text:clock(target.at)+'.',true);
  }
  $('next-cue').onclick=function(){jump(1);};$('prev-cue').onclick=function(){jump(-1);};
  $('read-cue').onclick=function(){var index=lastJump&&Math.abs(media().currentTime-lastJump.time)<1?lastJump.index:currentCue();if(index<0){say('No description has played yet.',true);return;}say(clock(cues[index].at)+'. '+cues[index].text,true);};
  $('correct-cue').onclick=function(){
    if(!job||job.state!=='done')return;var at=lastJump&&Math.abs(media().currentTime-lastJump.time)<1?cues[lastJump.index].at:media().currentTime;
    act(async function(){
      $('editor').open=true;
      if(!script||scriptJob!==job.id){var loaded=await loadScript();if(!loaded)return;}
      if(!script.cues.length){say('There are no descriptions to edit in this copy.',true);return;}
      var best=null;script.cues.forEach(function(cue){var t=cue.outputAt!==undefined?cue.outputAt:cue.at;if(t<=at+0.5&&(!best||t>=(best.outputAt!==undefined?best.outputAt:best.at)))best=cue;});
      best=best||script.cues[0];saveEdit();pickCue(best.id);$('edit-text').focus();
      say(clock(best.outputAt!==undefined?best.outputAt:best.at)+'. Editing: '+String((edits[best.id]||best).text).split(/\s+/).slice(0,8).join(' '),true);
    },'edit-problem');
  };
  function findLine(){
    var query=$('find').value.trim().toLowerCase(),lines=$('transcript').children;
    if(!query){say('Type a word to find.',true);$('find').focus();return;}
    if(!lines.length){say('The transcript is not loaded yet.',true);return;}
    for(var step=1;step<=lines.length;step++){
      var index=(found+step)%lines.length,line=lines[index];
      if(line.textContent.toLowerCase().indexOf(query)<0)continue;
      found=index;$('transcript-box').open=true;
      var at=line.getAttribute('data-at'),m=media();if(at!==null&&ended(m))m.currentTime=Number(at);
      line.focus();return;
    }
    say('No line contains '+$('find').value.trim()+'.',true);
  }
  $('find-next').onclick=findLine;
  $('find').addEventListener('keydown',function(event){if(event.key==='Enter'){event.preventDefault();findLine();}});
  $('find').addEventListener('input',function(){found=-1;});
  (function(){
    var session=navigator&&navigator.mediaSession;if(!session||!session.setActionHandler)return;
    var set=function(action,handler){try{session.setActionHandler(action,handler);}catch(e){}};
    set('play',function(){media().play().catch(function(){});});set('pause',function(){media().pause();});
    set('seekbackward',function(){seek(-10);});set('seekforward',function(){seek(10);});
    set('previoustrack',function(){jump(-1);});set('nexttrack',function(){jump(1);});
  })();
  document.addEventListener('visibilitychange',function(){
    if(document.hidden||stopped)return;
    carryOnUpload();
    if(job&&working(job))poll();
    if(filesAt&&Date.now()-filesAt>LINK_AGE&&!$('results').hidden)files(false).catch(failure);
  });
  (async function(){try{
    await refreshToken();config=await call('/config');catalog=config;
    voicesOff=config.voicesAvailable===false||!(config.voices||[]).length;config.voices=config.voices||[];
    var sourceLimit=(config.maxSourceMinutes||config.maxMinutes)*60;
    $('limits').textContent='Up to 2 GB and '+length(sourceLimit)+'. One run describes up to '+length(config.maxMinutes*60)+'; for a longer video, choose the part to describe. Any video file works: if yours is not listed, switch the file type to All files. Your video stays private to your account. Only when you choose to describe it does it go to three services: the picture and sound to the video model (Google Gemini, through OpenRouter) to write the descriptions, the soundtrack to Deepgram to time the dialogue, and the description text to the platform voices for the narration.';
    var perMinute=config.perMinuteUSD||{},extras=config.extrasPerMinuteUSD||{};
    if(perMinute.standard){var extra=(extras.closeLook||0)+(extras.firstLook||0);$('prices').textContent='Standard detail costs about '+Math.round(perMinute.standard*100)+' cents a minute of video'+(extra?'; the extra passes add about '+Math.round(extra*100)+' cents a minute':'')+'. Checking a video is free.';$('prices').hidden=false;}
    $('library-box').hidden=!config.library;
    $('folder').value=config.defaultLibraryPath||DEFAULT_FOLDER;
    if(config.library)call('/library-folders').then(function(data){data.folders.forEach(function(path){var option=document.createElement('option');option.value=path;$('folders').appendChild(option);});}).catch(function(){});
    setSelect('progress-pref',stored(PROGRESS_KEY,'quarter'));
    if(setSelect('play-as',stored(PLAY_AS_KEY,'video')))setPlayAs($('play-as').value,true);
    fillKinds();fillVoices();freshForm();describeVoice();$('refresh').disabled=false;
    if(voicesOff)say('Narrator voices are unavailable right now. You can still play and download finished copies.',true);
    var jobs=await list(),params=new URLSearchParams(location.search),selected=params.get('id');
    var current=jobs.filter(function(item){return item.id===selected;})[0]||jobs.filter(function(item){return working(item);})[0];
    if(params.get('book')&&config.library){$('library').value=location.origin+'/library?book='+params.get('book')+'&track='+(params.get('track')||0);controls();say('Library video chosen. Press Use this library video to check it.',true);$('library-use').focus();}
    if(current)await show(current,!!selected&&current.state==='done');
    else if(!params.get('book')){
      var unfinished=jobs.filter(function(item){return item.state==='uploading';})[0];
      say(!config.enabled?'The describer is not set up yet.':unfinished?'Your upload of “'+unfinished.name+'” did not finish. Choose the same file again to carry on from where it stopped.':'Choose a video to get started.',true);
    }
    controls();
  }catch(e){failure(e);try{controls();}catch(ignored){}if(!e.auth)say('Could not open the video describer. '+(e.message||''),true);}})();
})();`;
