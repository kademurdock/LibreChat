import { useLocalize } from '~/hooks';
import { useCharacterLook } from './useCharacterLook';

/**
 * The "Describe character" disclosure, kept on the message rather than inside the voice
 * card (which exists only while that message's audio plays): a screen-reader user reading
 * it no longer loses it, and their place, the moment the clip ends. Message.tsx shows it
 * on the latest message of a branch only, so a long chat does not repeat it on every reply.
 */
export default function CharacterDescription({
  messageId,
  agentId,
}: {
  messageId: string;
  agentId: string;
}) {
  const localize = useLocalize();
  const { appearanceKey, bodyDescription } = useCharacterLook(agentId, true);
  const words = appearanceKey ? localize(appearanceKey) : bodyDescription;
  if (!words) return null;
  return (
    <details
      data-character-description={messageId}
      className="my-2 max-w-md rounded-xl px-3 text-sm text-text-primary"
    >
      <summary className="min-h-[44px] cursor-pointer py-3 focus-visible:outline focus-visible:outline-2">
        {localize('com_ui_character_describe')}
      </summary>
      <p className="pb-3 leading-relaxed">{words}</p>
    </details>
  );
}
