import React from 'react';
import { useRecoilState, useRecoilValue } from 'recoil';
import { useLocalize } from '~/hooks';
import { useVoiceCatalog } from '~/hooks/Audio/useVoiceCatalog';
import {
  fishPaces,
  fishPaceValue,
  generationRate,
  inworldRates,
  isFishVoice,
} from '~/utils/voicePace';
import store from '~/store';

export default function PlaybackRate() {
  const localize = useLocalize();
  const textToSpeech = useRecoilValue(store.textToSpeech);
  const voice = useRecoilValue(store.voice);
  const base = useRecoilValue(store.voiceSpeed);
  const [rate, setRate] = useRecoilState(store.playbackRate);
  const { providers } = useVoiceCatalog();
  const fish = isFishVoice(voice, providers);
  const value = generationRate(base, rate);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="voice-generation-pace">
        {localize(fish ? 'com_voice_pace_fish' : 'com_voice_speed_inworld')}
      </label>
      <select
        id="voice-generation-pace"
        className="rounded border border-border-medium bg-surface-secondary p-2"
        disabled={!textToSpeech}
        value={
          rate == null ? '' : String(fish ? fishPaceValue(value) : Math.round(value * 10) / 10)
        }
        onChange={(event) => setRate(event.target.value ? Number(event.target.value) : null)}
      >
        <option value="">{localize('com_voice_pace_agent')}</option>
        {fish
          ? fishPaces.map((pace) => (
              <option key={pace.value} value={pace.value}>
                {localize(pace.key)}
              </option>
            ))
          : inworldRates.map((speed) => (
              <option key={speed} value={speed}>
                {speed}×
              </option>
            ))}
      </select>
      <p className="text-xs text-text-secondary">
        {localize(fish ? 'com_voice_pace_fish_help' : 'com_voice_speed_inworld_help')}
      </p>
    </div>
  );
}
