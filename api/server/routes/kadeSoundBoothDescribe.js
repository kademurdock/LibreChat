'use strict';
/* ----------------------------------------------------------------------------
 * DESCRIBE THE SOUND OF THE RECORDING, on the Sound Booth web page (Oct 11 2026)
 *
 * Her ask: a YuE2 cover should be able to start from what the recording sounds
 * like, so the Music direction box fills up with it (a cover in the same style),
 * and she can delete it and type something else (a cover into another genre).
 *
 * Two ways in, both on the page of a YuE2 cover with a recording attached:
 *   1. Transcribe reference lyrics also brings back a one-line description
 *      (`direction`, or `direction_note` when none could be made). The page asks
 *      for it with `describe: true`; an app that does not is answered as it always
 *      was. The box is filled only while it is empty or still holds a description
 *      this feature wrote and she has not touched. Text she typed is never
 *      replaced: she is told a description is ready and which button uses it.
 *   2. Describe the sound of the recording is her explicit request. It always
 *      replaces the box, says so in the status line, and Undo writing change
 *      brings back what the box held.
 * Either way, an untitled cover is named after its recording ("<name> (cover)", as
 * Cover this take does), so covers do not all take the first words of their
 * description as a title; Undo brings the empty title back.
 *
 * The page source below is spliced into kadeSoundBoothPage.js by interpolation,
 * like the paste splitter (kadeSoundBoothPaste.js), so none of it passes through
 * that file's template-literal escaping and it carries no backslash or backtick.
 * KADE_DESCRIBE_SOUND=0 makes every part an empty string: the page is then the
 * same text it was before this feature. A harness that stubs this module away
 * (require returning one fixed object) gets no parts either.
 *
 * Screen-reader shape (her rule): a real button with a text label and a hint
 * that names it, the existing status line (role=status) says every result, and
 * focus lands on the Music direction box after a fill. While a call is out the
 * pressed button keeps focus (it is marked unavailable with aria-disabled, not
 * rebuilt), the other buttons are disabled in place, and on every way out that
 * is not a fill focus is put back on the pressed button if it was there. Nothing
 * is spoken twice and no focus trap is made.
 * -------------------------------------------------------------------------- */

/** On unless KADE_DESCRIBE_SOUND is exactly the string 0 (the rule of describeSoundEnabled in packages/api music/lyrics.ts). */
function describeSoundEnabled(env) {
  const source = env || (typeof process !== 'undefined' && process.env) || {};
  return source.KADE_DESCRIBE_SOUND !== '0';
}

/* Inside renderSettings, after the Transcribe reference lyrics button of a YuE2 cover with a recording. */
const BUTTON = `
        extras.insertAdjacentHTML('beforeend','<button type="button" class="act" id="btnDescribe" aria-describedby="describeHint">Describe the sound of the recording</button><p class="hint" id="describeHint">Free. Fills Music direction with what the recording sounds like, for a cover in the same style. Change or clear it to move the cover to another genre.</p>');
        document.getElementById('btnDescribe').disabled=busy();
        document.getElementById('btnDescribe').onclick=describeSound;`;

/* In the body of the Transcribe reference lyrics request: the page asks for a description (an app that does not is not given one). */
const ASK = `,describe:true`;

/* The end of the Transcribe reference lyrics hint: the button now does a second thing. */
const HINT = ` Also fills an empty Music direction with what the recording sounds like.`;

/* In transcribeLyrics, before its Undo is armed: whether the button has focus, and the Undo from an earlier fill, if the box
 * still holds what that fill wrote (so a second press does not make Undo bring back the feature's own line). */
const TOP = `var hadFocus=focusedId()==='btnLyrics',priorUndo=earlierUndo();`;

/* In transcribeLyrics, right after its Undo is armed. */
const REARM = `keepEarlier(priorUndo);`;

/* In transcribeLyrics, right after the panel is rebuilt for the wait: the button keeps its place and says it is unavailable. */
const HOLD = `holdWith('btnLyrics',hadFocus);`;

/* In transcribeLyrics, on the way out when the answer is stale or failed: other buttons back on, focus back on the button. */
const SETTLE = `releaseHold();settleFocus('btnLyrics',hadFocus);`;

/* In transcribeLyrics, after the words are in the lyrics box: the other buttons back on, then fill the direction (or note why not). */
const HEARD = `releaseHold();var heard=heardSound(result.data);`;

/* In front of the lyric warning in the one status sentence, so the part about Music direction comes first and is not cut off. */
const AHEAD = `(heard?heard+' ':'')+`;

/* After transcribeLyrics, at the level of the page's other functions. */
const FUNCTIONS = `
    /* Oct 11 2026: Describe the sound of the recording. data-auto-direction on the Music direction box holds the exact line this
     * feature wrote there. The box counts as free while it is empty or still holds exactly that line, whatever has happened to it
     * since (typing clears the flag, and a changed box no longer matches it), so text she wrote can never be replaced by it. */
    function directionBox(){return document.getElementById('script');}
    function directionIsFree(box){
      var held=box.value.trim();
      return !held||held===(box.getAttribute('data-auto-direction')||'').trim();
    }
    function fillDirection(line){
      var box=directionBox();
      box.value=line;box.setAttribute('data-auto-direction',line);
      document.getElementById('readback').textContent='';
    }
    function focusedId(){var el=document.activeElement;return el&&el.id?el.id:'';}
    /* The Undo to build on. While the box still holds exactly the line this feature wrote, the text Undo should bring back is
     * the text from before its first fill, with its title, not the feature's own line; otherwise there is none to keep. */
    function earlierUndo(){
      var box=directionBox(),held=box.value.trim();
      if(!held||held!==(box.getAttribute('data-auto-direction')||'').trim())return null;
      return writingUndo&&writingUndo.engine===state.engine&&typeof writingUndo.text==='string'?writingUndo:null;
    }
    function keepEarlier(prior){
      if(!prior||!writingUndo)return;
      writingUndo.text=prior.text;
      if(prior.title!==undefined){writingUndo.title=prior.title;writingUndo.generatedTitle=prior.generatedTitle;}
    }
    /* While a call is out. The pressed button stays focusable and is marked unavailable; the other buttons that start work are
     * disabled in place, so the page is not rebuilt around the person using it. releaseHold undoes the part a rebuild does not. */
    function holdWith(pressed,had){
      ['btnLyrics','btnDescribe','btnDraft','btnInspire'].forEach(function(id){
        var el=document.getElementById(id);
        if(!el)return;
        if(id!==pressed){el.disabled=true;return;}
        el.disabled=false;el.setAttribute('aria-disabled','true');
      });
      updateRenderControls();
      if(had)focusById(pressed);
    }
    function releaseHold(){
      ['btnDraft','btnInspire'].forEach(function(id){var el=document.getElementById(id);if(el)el.disabled=false;});
    }
    /* After a rebuild, if focus was on the pressed button and nothing else has it now, put it back. */
    function settleFocus(id,had){
      if(!had)return;
      var el=document.activeElement;
      if(!el||el===document.body)focusById(id);
    }
    /* An untitled cover is named after its recording, as Cover this take does. A title she wrote is never replaced; one this
     * function wrote and she left alone is replaced when the recording changes. Undo brings the title back with the direction. */
    function nameCover(){
      var titleBox=document.getElementById('trackTitle'),held=titleBox.value.trim();
      if(!state.clips.length||(held&&held!==state.coverTitle))return '';
      var name=String(state.clips[0].name||'').trim(),dot=name.lastIndexOf('.');
      if(dot>0&&name.length-dot<=5)name=name.slice(0,dot).trim();
      if(!name)return '';
      var title=name.slice(0,71)+' (cover)';
      if(held===title){state.coverTitle=title;return '';}
      if(writingUndo&&writingUndo.engine===state.engine){
        if(writingUndo.generatedTitle===undefined||writingUndo.generatedTitle!==held)writingUndo.title=titleBox.value;
        writingUndo.generatedTitle=title;
      }
      titleBox.value=title;state.coverTitle=title;
      return ' Track title: '+title+'.';
    }
    /* What Transcribe reference lyrics adds to its status sentence. The direction is looked at again when the answer comes, so
     * anything she typed while the recording was being heard is kept. */
    function heardSound(data){
      var line=typeof data.direction==='string'?data.direction.trim():'';
      var note=typeof data.direction_note==='string'?data.direction_note.trim():'';
      if(!line)return note;
      if(!directionIsFree(directionBox()))return 'A description of the sound is ready, but your Music direction was kept. Choose Describe the sound of the recording to use it.';
      fillDirection(line);
      return 'Music direction filled with what the recording sounds like. Change it or clear it if you want a different style.'+nameCover();
    }
    async function describeSound(){
      if(busy() || !referenceReady() || !state.clips.length)return;
      var sourceEngine=state.engine,reference=state.clips[0].url,box=directionBox(),hadFocus=focusedId()==='btnDescribe',result;
      state.writing=true;box.readOnly=true;holdWith('btnDescribe',hadFocus);
      say('Listening to how the recording sounds. Your Music direction is kept until the description is ready.');
      try{result=await post('/api/kade/sound-booth/reference/describe',{url:reference});}
      finally{state.writing=false;box.readOnly=false;releaseHold();}
      if(state.engine!==sourceEngine || !state.clips.length || state.clips[0].url!==reference){renderSettings();settleFocus('btnDescribe',hadFocus);return;}
      var line=result.ok&&typeof result.data.direction==='string'?result.data.direction.trim():'';
      if(!line){renderSettings();settleFocus('btnDescribe',hadFocus);say(result.data.error||'I could not describe the sound this time. Your Music direction is kept; type it yourself.',true);return;}
      var earlier=earlierUndo();
      writingUndo=earlier?{engine:state.engine,text:earlier.text,title:earlier.title,generatedTitle:earlier.generatedTitle}:{engine:state.engine,text:box.value};
      fillDirection(line);
      var named=nameCover();
      invalidateQuote();renderSettings();
      document.getElementById('btnUndoWriting').hidden=false;
      box.focus();say('Music direction replaced with what the recording sounds like. Change it or clear it to move the cover to another genre.'+named+' Undo writing change brings back your previous direction.');
    }
    directionBox().addEventListener('input',function(){this.removeAttribute('data-auto-direction');});`;

const OFF = {
  ask: '',
  hint: '',
  button: '',
  top: '',
  rearm: '',
  hold: '',
  settle: '',
  heard: '',
  ahead: '',
  functions: '',
};

/** The pieces of page source, or empty strings for all of them while KADE_DESCRIBE_SOUND=0. */
function pageParts(env) {
  if (!describeSoundEnabled(env)) return OFF;
  return {
    ask: ASK,
    hint: HINT,
    button: BUTTON,
    top: TOP,
    rearm: REARM,
    hold: HOLD,
    settle: SETTLE,
    heard: HEARD,
    ahead: AHEAD,
    functions: FUNCTIONS,
  };
}

module.exports = { describeSoundEnabled, pageParts };
