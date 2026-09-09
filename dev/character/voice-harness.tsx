import React from 'react';
import {createRoot} from 'react-dom/client';
import VoiceMessagePortrait from '../../client/src/components/Chat/character/VoiceMessagePortrait';
import {useVoicePortraitPreference} from '../../client/src/components/Chat/character/useVoicePortraitPreference';
import {watchVoiceAudio,voicePlayback} from '../../client/src/components/Chat/character/voice-playback.mjs';
const audio=new Audio(); let src='';
async function play(id:string){ audio.pause(); if(!src) src=URL.createObjectURL(await (await fetch('/sample.wav')).blob()); audio.src=src; watchVoiceAudio(audio,id); await audio.play(); }
function App(){const [enabled,setEnabled]=useVoicePortraitPreference();return <main className="p-4">
<h1>Voice-message playback check</h1><p>This saved recording is reused. No microphone or synthesis request.</p>
<label><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/> Animated voice portraits</label>
<div><button onClick={()=>play('one')}>Play saved voice</button><button onClick={()=>play('two')}>Play another character</button><button onClick={()=>play('della')}>Play Della</button><button onClick={()=>{audio.pause();audio.src='';}}>Interrupt</button></div>
<article><h2>Kiana</h2><VoiceMessagePortrait messageId="one" agentId="agent_6llV0eMu4fmIaj8f2x1Sb"/><p>The full text remains available while the voice plays.</p></article>
<article><h2>Generic test character</h2><VoiceMessagePortrait messageId="two" agentId="agent_fixture"/></article>
<article><h2>Della</h2><VoiceMessagePortrait messageId="della" agentId="agent_BSOLa3eNEZyjs-7abCjMt"/></article></main>}
(window as any).voiceFixture={audio,snapshot:voicePlayback.snapshot};createRoot(document.getElementById('root')!).render(<App/>);
