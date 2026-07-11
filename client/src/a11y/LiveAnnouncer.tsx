import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { AnnounceOptions } from '~/common';
import AnnouncerContext from '~/Providers/AnnouncerContext';
import { INVALID_CITATION_REGEX, CLEANUP_REGEX } from '~/utils/citations';
import { stripGameSoundTags, stripDeepThinkTag } from '~/utils/gameSounds';
import { stripVoiceTags } from '~/utils/voiceTags';
import { useLocalize } from '~/hooks';
import Announcer from './Announcer';

/**
 * KADE July 11 2026 — screen-reader announcement scrub. The aria-live region
 * receives RAW message text, so VoiceOver was reading web-citation anchors
 * ("turn0search1"), %%%voice-performance%%% tags, [sound:]/[table:] game
 * cues, and :::thinking::: blocks out loud on every finished reply (Kade's
 * bug report: "it's reading the weird message tags"). Announcements must
 * hear like the visible bubble reads: scrub everything the renderers strip.
 */
const THINKING_BLOCK_RE = /:::thinking[\s\S]*?:::/g;
const PUA_CHARS_RE = /[\ue000-\uf8ff]/g;
const MD_IMAGE_RE = /!\[([^\]]*)\]\([^)]*\)/g;
const MD_LINK_RE = /\[([^\]]+)\]\(([^)]*)\)/g;

export function scrubAnnouncement(text: string): string {
  if (!text) {
    return text;
  }
  return stripGameSoundTags(stripVoiceTags(stripDeepThinkTag(text)))
    .replace(THINKING_BLOCK_RE, '')
    .replace(INVALID_CITATION_REGEX, '')
    .replace(CLEANUP_REGEX, '')
    .replace(PUA_CHARS_RE, '')
    .replace(MD_IMAGE_RE, '$1')
    .replace(MD_LINK_RE, '$1')
    .replace(/[*`_#]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

interface LiveAnnouncerProps {
  children: React.ReactNode;
}

const LiveAnnouncer: React.FC<LiveAnnouncerProps> = ({ children }) => {
  const [statusMessage, setStatusMessage] = useState('');
  const [logMessage, setLogMessage] = useState('');

  const statusTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const localize = useLocalize();

  const events: Record<string, string | undefined> = useMemo(
    () => ({
      start: localize('com_a11y_start'),
      end: localize('com_a11y_end'),
      composing: localize('com_a11y_ai_composing'),
      summarize_started: localize('com_a11y_summarize_started'),
      summarize_completed: localize('com_a11y_summarize_completed'),
      summarize_failed: localize('com_a11y_summarize_failed'),
    }),
    [localize],
  );

  const announceStatus = useCallback((message: string) => {
    if (statusTimeoutRef.current) {
      clearTimeout(statusTimeoutRef.current);
    }

    setStatusMessage(message);

    statusTimeoutRef.current = setTimeout(() => {
      setStatusMessage('');
    }, 1000);
  }, []);

  const announceLog = useCallback((message: string) => {
    setLogMessage(message);
  }, []);

  const announcePolite = useCallback(
    ({ message, isStatus = false }: AnnounceOptions) => {
      const finalMessage = scrubAnnouncement(events[message] ?? message);

      if (isStatus) {
        announceStatus(finalMessage);
      } else {
        announceLog(finalMessage);
      }
    },
    [events, announceStatus, announceLog],
  );

  const announceAssertive = announcePolite;

  const contextValue = useMemo(
    () => ({
      announcePolite,
      announceAssertive,
    }),
    [announcePolite, announceAssertive],
  );

  useEffect(() => {
    return () => {
      if (statusTimeoutRef.current) {
        clearTimeout(statusTimeoutRef.current);
      }
    };
  }, []);

  return (
    <AnnouncerContext.Provider value={contextValue}>
      {children}
      <Announcer statusMessage={statusMessage} logMessage={logMessage} />
    </AnnouncerContext.Provider>
  );
};

export default LiveAnnouncer;
