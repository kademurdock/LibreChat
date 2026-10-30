import React from 'react';
import { useRecoilState, useRecoilValue } from 'recoil';
import { useLocalize } from '~/hooks';
import VoiceSpeedSelect from '~/components/Audio/VoiceSpeedSelect';
import { generationRate, speedLabel, speedSpoken } from '~/utils/voicePace';
import store from '~/store';

export default function PlaybackRate() {
  const localize = useLocalize();
  const textToSpeech = useRecoilValue(store.textToSpeech);
  const base = useRecoilValue(store.voiceSpeed);
  const [rate, setRate] = useRecoilState(store.voicePacePreference);
  const character = generationRate(base, null);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="voice-generation-pace">{localize('com_voice_speed')}</label>
      <VoiceSpeedSelect
        id="voice-generation-pace"
        value={rate}
        onChange={setRate}
        disabled={!textToSpeech}
        describedBy="voice-generation-pace-help"
        emptyText={localize('com_voice_speed_character', { speed: speedLabel(character) })}
        emptySpoken={localize('com_voice_speed_character', { speed: speedSpoken(character) })}
      />
      <p id="voice-generation-pace-help" className="text-xs text-text-secondary">
        {localize('com_voice_speed_help')}
      </p>
    </div>
  );
}
