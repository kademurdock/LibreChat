import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import useCallCharacter from '../../client/src/components/Chat/character/useCallCharacter';
import {KIANA_ID,KIANA_PORTRAIT_FILE} from '../../client/src/components/Chat/character/portrait-rig.mjs';
import {observePlayback} from '../../client/src/components/Chat/character/playback';
let ctx:AudioContext, source:AudioBufferSourceNode|undefined;
function App(){
 const [open,setOpen]=useState(true),[status,setStatus]=useState<any>('listening'),[liveMode,setLive]=useState(false);
 const character=useCallCharacter({open,agentId:KIANA_ID,avatarUrl:'https://authorized.invalid/'+KIANA_PORTRAIT_FILE,liveMode,status});
 const stop=()=>{character.presentation.clear();source?.stop();source=undefined;setStatus('listening')};
 const play=async(speech=true,id:string|null=KIANA_ID)=>{
  stop();ctx ||= new AudioContext();await ctx.resume();const b=await ctx.decodeAudioData(await fetch('sample.wav').then(r=>r.arrayBuffer()));
  source=ctx.createBufferSource();source.buffer=b;source.connect(ctx.destination);const start=ctx.currentTime+.1;source.start(start);
  observePlayback(character.presentation,source,{buffer:b,start,clock:()=>ctx.currentTime,speech,agentId:id});setStatus('speaking');
 };
 (window as any).test={character,play,stop,setLive,setOpen,setStatus};
 return <main><p>Character call · Development preview</p><h1>Kiana, in the conversation</h1><p>A fixed portrait with a local mouth layer. This preview uses the actual call-screen controller with a local test recording. The sample voice is not Kiana’s.</p>
 {open&&<div role="dialog" aria-label="Character call preview">
 <div className="stage" aria-hidden="true">{character.showPortrait&&<img alt="" src="/assets/characters/kiana/portrait.png"/>}<canvas ref={character.setCanvas} hidden aria-hidden="true"/></div>
 <label><input type="checkbox" checked={character.enabled} onChange={e=>character.toggle(e.target.checked)}/> Animate character during calls</label>
 <button onClick={()=>{stop();setStatus('listening')}}>Listen</button><button onClick={()=>play()}>Play sample</button><button onClick={()=>play(false)}>Sound effect</button><button onClick={stop}>Interrupt</button><button onClick={()=>{stop();setOpen(false)}}>End preview</button>
 <p role="status">{status}</p></div>}
 {!open&&<button onClick={()=>{setOpen(true);setStatus('listening')}}>Open preview</button>}
 <p>Motion starts off, remembers your choice on this browser, and stops for reduced motion or a hidden tab. The picture is decorative; it adds no screen-reader speech.</p><p>Sample: I am listening. We can take our time. Here is a short pause. Now I am speaking again.</p>
 </main>;
}createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
