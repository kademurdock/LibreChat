import { useRecoilState, useRecoilValue } from 'recoil';
import { Switch } from '@librechat/client';
import { useLocalize } from '~/hooks';
import store from '~/store';

/** Oct 16 2026: "Filler words and little sounds". A real switch with its name from the visible
 * label and its explanation read as the description, so a screen reader announces both. On by
 * default; off sends fillers:false on every chat and audition request. */
export default function VoiceFillersSwitch({
  onCheckedChange,
}: {
  onCheckedChange?: (value: boolean) => void;
}) {
  const localize = useLocalize();
  const textToSpeech = useRecoilValue(store.textToSpeech);
  const [fillers, setFillers] = useRecoilState(store.voiceFillers);

  const switchId = 'VoiceFillers';
  const labelId = `${switchId}-label`;
  const helpId = `${switchId}-help`;

  const handleCheckedChange = (value: boolean) => {
    setFillers(value);
    onCheckedChange?.(value);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <div id={labelId}>{localize('com_voice_fillers')}</div>
        <Switch
          id={switchId}
          checked={fillers}
          onCheckedChange={handleCheckedChange}
          disabled={!textToSpeech}
          className="ml-4"
          data-testid={switchId}
          aria-labelledby={labelId}
          aria-describedby={helpId}
        />
      </div>
      <p id={helpId} className="text-xs text-text-secondary">
        {localize('com_voice_fillers_help')}
      </p>
    </div>
  );
}
