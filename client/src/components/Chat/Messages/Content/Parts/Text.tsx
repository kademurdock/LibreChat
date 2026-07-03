import { memo, useMemo, useEffect, ReactElement } from 'react';
import { useRecoilValue } from 'recoil';
import MarkdownLite from '~/components/Chat/Messages/Content/MarkdownLite';
import Markdown from '~/components/Chat/Messages/Content/Markdown';
import { stripVoiceTags } from '~/utils/voiceTags';
import { stripGameSoundTags, maybePlayGameSounds, gameTableIdIn } from '~/utils/gameSounds';
import GameTable from '~/components/Chat/Messages/Content/GameTable';
import { useMessageContext } from '~/Providers';
import { cn } from '~/utils';
import store from '~/store';

type TextPartProps = {
  text: string;
  showCursor: boolean;
  isCreatedByUser: boolean;
};

type ContentType =
  | ReactElement<React.ComponentProps<typeof Markdown>>
  | ReactElement<React.ComponentProps<typeof MarkdownLite>>
  | ReactElement;

const TextPart = memo(function TextPart({ text, isCreatedByUser, showCursor }: TextPartProps) {
  const { messageId, isSubmitting = false, isLatestMessage = false } = useMessageContext();
  const enableUserMsgMarkdown = useRecoilValue(store.enableUserMsgMarkdown);
  const showCursorState = useMemo(() => showCursor && isSubmitting, [showCursor, isSubmitting]);

  // Assistant text can carry invisible TTS-2 voice performance tags (see
  // utils/voiceTags.ts) -- strip them here so they never reach the visible
  // chat bubble. User-authored text never contains them, so it's left alone.
  const displayText = useMemo(
    () => (isCreatedByUser ? text : stripGameSoundTags(stripVoiceTags(text))),
    [isCreatedByUser, text],
  );

  // Game Parlor sound cues: while THIS message is actively streaming, play
  // any completed [sound:x] tokens exactly once each (see utils/gameSounds).
  // Old conversations reopening never fire — the gate below is false there.
  useEffect(() => {
    if (!isCreatedByUser && isSubmitting && isLatestMessage) {
      maybePlayGameSounds(messageId, text);
    }
  }, [isCreatedByUser, isSubmitting, isLatestMessage, messageId, text]);

  // Game Parlor visual table: an invisible [table:id] token in the latest
  // assistant message mounts the live table widget (aria-hidden — screen
  // reader flow is untouched; see GameTable.tsx).
  const tableId = useMemo(
    () => (isCreatedByUser ? null : gameTableIdIn(text)),
    [isCreatedByUser, text],
  );

  const content: ContentType = useMemo(() => {
    if (!isCreatedByUser) {
      return <Markdown content={displayText} isLatestMessage={isLatestMessage} />;
    } else if (enableUserMsgMarkdown) {
      return <MarkdownLite content={displayText} />;
    } else {
      return <>{displayText}</>;
    }
  }, [isCreatedByUser, enableUserMsgMarkdown, displayText, isLatestMessage]);

  return (
    <div
      className={cn(
        isSubmitting ? 'submitting' : '',
        showCursorState && !!text.length ? 'result-streaming' : '',
        'markdown prose message-content dark:prose-invert light w-full break-words',
        isCreatedByUser && !enableUserMsgMarkdown && 'whitespace-pre-wrap',
        isCreatedByUser ? 'dark:text-gray-20' : 'dark:text-gray-100',
      )}
    >
      {content}
      {tableId != null && isLatestMessage && <GameTable gameId={tableId} refreshKey={messageId} />}
    </div>
  );
});
TextPart.displayName = 'TextPart';

export default TextPart;
