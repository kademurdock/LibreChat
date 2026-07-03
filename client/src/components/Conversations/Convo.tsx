import React, { memo, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Pin } from 'lucide-react';
import { useRecoilValue } from 'recoil';
import { useParams } from 'react-router-dom';
import { Constants } from 'librechat-data-provider';
import { useToastContext } from '@librechat/client';
import type { TConversation } from 'librechat-data-provider';
import { useNavigateToConvo, useLocalize, useShiftKey } from '~/hooks';
import ConversationEndpointIcon from './ConversationEndpointIcon';
import { useUpdateConversationMutation } from '~/data-provider';
import { areConversationRenderPropsEqual } from './utils';
import { NotificationSeverity } from '~/common';
import { ConvoOptions } from './ConvoOptions';
import RenameForm from './RenameForm';
import { cn, logger } from '~/utils';
import ConvoLink from './ConvoLink';
import store from '~/store';

/* ♿ KADE July 2 2026 (evening 2): screen-reader rework of the history row.
   Before: the whole row was a div role="button" whose contents CHANGED the
   moment it received focus (the options menu only mounted on hover/focus),
   which is exactly the kind of DOM churn that makes iOS VoiceOver drop
   double-tap activations. Now: the row is a plain container, navigation is a
   real <a> link (ConvoLink), and the options button is ALWAYS mounted — it is
   revealed visually on hover/focus/active exactly as before, but hidden rows
   use `invisible` (visibility:hidden), so screen readers don't hit ghost
   buttons on every row. The active conversation's options stay reachable. */

interface ConversationProps {
  conversation: TConversation;
  retainView: () => void;
  toggleNav: () => void;
  isGenerating?: boolean;
}

function Conversation({
  conversation,
  retainView,
  toggleNav,
  isGenerating = false,
}: ConversationProps) {
  const params = useParams();
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { navigateToConvo } = useNavigateToConvo();
  const currentConvoId = useMemo(() => params.conversationId, [params.conversationId]);
  const updateConvoMutation = useUpdateConversationMutation(currentConvoId ?? '');
  const activeConvos = useRecoilValue(store.allConversationsSelector);
  const isShiftHeld = useShiftKey();
  const { conversationId, title = '' } = conversation;

  const [titleInput, setTitleInput] = useState(title || '');
  const [renaming, setRenaming] = useState(false);
  const [isPopoverActive, setIsPopoverActive] = useState(false);

  const previousTitle = useRef(title);

  useEffect(() => {
    if (title !== previousTitle.current) {
      setTitleInput(title as string);
      previousTitle.current = title;
    }
  }, [title]);

  const isActiveConvo = useMemo(() => {
    if (conversationId === Constants.NEW_CONVO) {
      return currentConvoId === Constants.NEW_CONVO;
    }

    if (currentConvoId !== Constants.NEW_CONVO) {
      return currentConvoId === conversationId;
    } else {
      const latestConvo = activeConvos?.[0];
      return latestConvo === conversationId;
    }
  }, [currentConvoId, conversationId, activeConvos]);

  const handleRename = () => {
    setIsPopoverActive(false);
    setTitleInput(title as string);
    setRenaming(true);
  };

  const handleRenameSubmit = async (newTitle: string) => {
    if (!conversationId || newTitle === title) {
      setRenaming(false);
      return;
    }

    try {
      await updateConvoMutation.mutateAsync({
        conversationId,
        title: newTitle.trim() || localize('com_ui_untitled'),
      });
      setRenaming(false);
    } catch (error) {
      logger.error('Error renaming conversation', error);
      setTitleInput(title as string);
      showToast({
        message: localize('com_ui_rename_failed'),
        severity: NotificationSeverity.ERROR,
        showIcon: true,
      });
      setRenaming(false);
    }
  };

  const handleCancelRename = () => {
    setTitleInput(title as string);
    setRenaming(false);
  };

  const handlePopoverOpenChange = useCallback((open: boolean) => {
    setIsPopoverActive(open);
  }, []);

  const handleLinkClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (renaming) {
      e.preventDefault();
      return;
    }
    // Real href: let the browser handle new-tab/window clicks natively.
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      return;
    }
    e.preventDefault();
    if (currentConvoId === conversationId || isPopoverActive) {
      return;
    }

    toggleNav();

    if (typeof title === 'string' && title.length > 0) {
      document.title = title;
    }

    navigateToConvo(conversation, {
      currentConvoId,
    });
  };

  const convoOptionsProps = {
    title,
    isPinned: conversation.pinned,
    retainView,
    renameHandler: handleRename,
    isActiveConvo,
    conversationId,
    chatProjectId: conversation.chatProjectId,
    isPopoverActive,
    setIsPopoverActive: handlePopoverOpenChange,
    isShiftHeld: isActiveConvo ? isShiftHeld : false,
  };

  const generatingSpinner = (
    <svg
      className="h-5 w-5 flex-shrink-0 animate-spin text-text-primary"
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label={localize('com_ui_generating')}
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );

  /* `invisible` (not just opacity-0) keeps hidden option buttons out of the
     accessibility tree AND out of the tab order; hover/focus-within/active
     states reveal them exactly as before. */
  let actionVisibilityClassName =
    'invisible max-w-0 scale-x-0 opacity-0 group-focus-within:visible group-focus-within:max-w-[60px] group-focus-within:scale-x-100 group-focus-within:opacity-100 group-hover:visible group-hover:max-w-[60px] group-hover:scale-x-100 group-hover:opacity-100';
  if (isGenerating) {
    actionVisibilityClassName = 'visible pointer-events-none w-5 scale-x-100 opacity-100';
  } else if (isPopoverActive || isActiveConvo) {
    actionVisibilityClassName = 'visible scale-x-100 opacity-100';
  }

  let actionWidthClassName = '';
  if (!isGenerating && !isPopoverActive && isActiveConvo && isShiftHeld) {
    actionWidthClassName = 'max-w-[60px]';
  } else if (!isGenerating) {
    actionWidthClassName = 'max-w-[28px]';
  }

  const actionContent = isGenerating
    ? generatingSpinner
    : !renaming && <ConvoOptions {...convoOptionsProps} />;

  return (
    <div
      className={cn(
        'group relative flex h-12 w-full items-center rounded-lg md:h-9',
        isActiveConvo || isPopoverActive
          ? 'bg-surface-active-alt before:absolute before:bottom-1 before:left-0 before:top-1 before:w-0.5 before:rounded-full before:bg-black dark:before:bg-white'
          : 'hover:bg-surface-active-alt focus-within:bg-surface-active-alt',
      )}
      data-testid="convo-item"
    >
      {renaming ? (
        <RenameForm
          titleInput={titleInput}
          setTitleInput={setTitleInput}
          onSubmit={handleRenameSubmit}
          onCancel={handleCancelRename}
          localize={localize}
        />
      ) : (
        <ConvoLink
          href={`/c/${conversationId}`}
          onClick={handleLinkClick}
          isActiveConvo={isActiveConvo}
          isPopoverActive={isPopoverActive}
          title={title}
          ariaLabel={localize('com_ui_conversation_label', {
            title: title || localize('com_ui_untitled'),
          })}
          localize={localize}
        >
          <ConversationEndpointIcon conversation={conversation} size={20} context="menu-item" />
        </ConvoLink>
      )}
      {conversation.pinned === true && (
        <Pin className="icon-sm mr-1 shrink-0 text-text-primary" aria-hidden="true" />
      )}
      <div
        className={cn(
          'mr-2 flex origin-left items-center justify-center',
          actionVisibilityClassName,
          actionWidthClassName,
        )}
      >
        {actionContent}
      </div>
    </div>
  );
}

export default memo(Conversation, areConversationRenderPropsEqual);
