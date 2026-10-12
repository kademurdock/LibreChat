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
 *      (`direction`, or `direction_note` when none could be made). The box is
 *      filled only while it is empty or still holds a description this feature
 *      wrote and she has not touched. Text she typed is never replaced: she is
 *      told a description is ready and which button uses it.
 *   2. Describe the sound of the recording is her explicit request. It always
 *      replaces the box, says so in the status line, and Undo writing change
 *      brings back what the box held.
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
 * focus lands on the Music direction box after a fill and on the button after a
 * failure. Nothing is spoken twice and no focus trap is made.
 * -------------------------------------------------------------------------- */

/** On unless KADE_DESCRIBE_SOUND is exactly the string 0 (the rule of describeSoundEnabled in packages/api music/lyrics.ts). */
function describeSoundEnabled(env) {
  const source = env || (typeof process !== 'undefined' && process.env) || {};
  return source.KADE_DESCRIBE_SOUND !== '0';
}

/* Inside renderSettings, after the Transcribe reference lyrics button of a YuE2 cover with a recording. */
const BUTTON = `
        extras.insertAdjacentHTML('beforeend','<button type="button" class="act" id="btnDescribe" aria-describedby="describeHint">Describe the sound of the recording</button><p class="hint" id="describeHint">Fills Music direction with what the recording sounds like, for a cover in the same style. Change or clear it to move the cover to another genre.</p>');
        document.getElementById('btnDescribe').disabled=busy();
        document.getElementById('btnDescribe').onclick=describeSound;`;

/* Inside transcribeLyrics, after the words are in the lyrics box: fill the direction (or note why not), say it with the warning. */
const HEARD = `var heard=heardSound(result.data);`;
const SAID = `+heard`;

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
    /* What Transcribe reference lyrics adds to its status sentence. The direction is looked at again when the answer comes, so
     * anything she typed while the recording was being heard is kept. */
    function heardSound(data){
      var line=typeof data.direction==='string'?data.direction.trim():'';
      var note=typeof data.direction_note==='string'?data.direction_note.trim():'';
      if(!line)return note?' '+note:'';
      if(!directionIsFree(directionBox()))return ' A description of the sound is ready, but your Music direction was kept. Choose Describe the sound of the recording to use it.';
      fillDirection(line);
      return ' Music direction filled with what the recording sounds like. Change it or clear it if you want a different style.';
    }
    async function describeSound(){
      if(busy() || !referenceReady() || !state.clips.length)return;
      var sourceEngine=state.engine,reference=state.clips[0].url;
      state.writing=true;renderSettings();say('Listening to how the recording sounds. Your Music direction is kept until the description is ready.');
      var result=await post('/api/kade/sound-booth/reference/describe',{url:reference});
      state.writing=false;
      if(state.engine!==sourceEngine || !state.clips.length || state.clips[0].url!==reference){renderSettings();return;}
      var line=result.ok&&typeof result.data.direction==='string'?result.data.direction.trim():'';
      if(!line){renderSettings();focusById('btnDescribe');say(result.data.error||'I could not describe the sound this time. Your Music direction is kept; type it yourself.',true);return;}
      var box=directionBox();
      writingUndo={engine:state.engine,text:box.value};
      fillDirection(line);invalidateQuote();renderSettings();
      document.getElementById('btnUndoWriting').hidden=false;
      box.focus();say('Music direction replaced with what the recording sounds like. Change it or clear it to move the cover to another genre. Undo writing change brings back your previous direction.');
    }
    directionBox().addEventListener('input',function(){this.removeAttribute('data-auto-direction');});`;

const OFF = { button: '', heard: '', said: '', functions: '' };

/** The four pieces of page source, or four empty strings while KADE_DESCRIBE_SOUND=0. */
function pageParts(env) {
  if (!describeSoundEnabled(env)) return OFF;
  return { button: BUTTON, heard: HEARD, said: SAID, functions: FUNCTIONS };
}

module.exports = { describeSoundEnabled, pageParts };
