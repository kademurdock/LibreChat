import { useLocalize } from '~/hooks';
import { useVoicePortraitPreference } from '~/components/Chat/character/useVoicePortraitPreference';
import { useGetCustomConfigSpeechQuery } from 'librechat-data-provider/react-query';
import { EngineSTTDropdown } from '../SettingsTabs/Speech/STT';
import { EngineTTSDropdown } from '../SettingsTabs/Speech/TTS';

export function EngineSTTSetting() {
  const { data } = useGetCustomConfigSpeechQuery();
  return <EngineSTTDropdown external={Boolean(data?.sttExternal)} />;
}

export function EngineTTSSetting() {
  const { data } = useGetCustomConfigSpeechQuery();
  return <EngineTTSDropdown external={Boolean(data?.ttsExternal)} />;
}

export function VoicePortraitSetting() {
  const [enabled, setEnabled] = useVoicePortraitPreference();
  const localize = useLocalize();
  return (
    <label className="flex min-h-[44px] cursor-pointer items-center gap-3">
      <input
        type="checkbox"
        checked={enabled}
        onChange={(event) => setEnabled(event.target.checked)}
      />
      <span>{localize('com_ui_voice_portraits')}</span>
    </label>
  );
}
