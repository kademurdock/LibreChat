import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { AnnounceOptions } from '~/common';
import AnnouncerContext from '~/Providers/AnnouncerContext';
import { INVALID_CITATION_REGEX, CLEANUP_REGEX, LITERAL_NBSP_REGEX } from '~/utils/citations';
import { stripGameSoundTags, stripDeepThinkTag } from '~/utils/gameSounds';
import { stripVoiceTags } from '~/utils/voiceTags';
import { useLocalize } from '~/hooks';
import Announcer from './Announcer';
import type { LogEntry } from './Announcer';

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
  // Nov 12 2026 (WEB-4): inline <think> tags are reasoning too, never announced.
  return (
    stripGameSoundTags(
      stripVoiceTags(stripDeepThinkTag(text.replace(/<think>[\s\S]*?<\/think>/gi, ''))),
    )
      .replace(THINKING_BLOCK_RE, '')
      .replace(INVALID_CITATION_REGEX, '')
      .replace(CLEANUP_REGEX, '')
      /* July 13 2026: bare anchors with NO marker glyph ("turn0search3" typed
       * plain) — the TTS proxy already catch-alls these; the announcer must too. */
      .replace(/turn\d+(?:search|image|news|video|ref|file)\d+/g, '')
      .replace(LITERAL_NBSP_REGEX, ' ')
      .replace(PUA_CHARS_RE, '')
      .replace(MD_IMAGE_RE, '$1')
      .replace(MD_LINK_RE, '$1')
      .replace(/[*`_#]/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  );
}

interface LiveAnnouncerProps {
  children: React.ReactNode;
}

type Timer = ReturnType<typeof setTimeout>;

/* Nov 12 2026 (WEB-14): the announcer used one slot per region. Silenced events wrote '' and
 * wiped "Generating reply..." about a round trip after it was written, and each log
 * announcement replaced the one before it ("Memory saved." over the reply, an identical reply
 * never spoken again, the last reply sitting at the end of the page for good). */
const STATUS_TTL_MS = 1000;
/** Gap between clearing and re-writing a status whose words are already showing. */
const STATUS_REPEAT_GAP_MS = 50;
const LOG_MAX = 4;
/** A log line stays long enough to be picked up, longer for long replies, never for good. */
const LOG_TTL_MIN_MS = 8000;
const LOG_TTL_MAX_MS = 60000;
const LOG_TTL_PER_CHAR_MS = 50;

const LiveAnnouncer: React.FC<LiveAnnouncerProps> = ({ children }) => {
  const [statusMessage, setStatusMessage] = useState('');
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);

  const statusTimeoutRef = useRef<Timer | null>(null);
  const statusTextRef = useRef('');
  const logTimersRef = useRef(new Set<Timer>());
  const nextLogIdRef = useRef(0);

  const localize = useLocalize();

  const events: Record<string, string | undefined> = useMemo(
    () => ({
      /* KADE July 13 2026 — reply-status announcements are owned SOLELY by
       * useCompletionChime (one "Generating reply..." at start, one late
       * "Still generating..." reassurance on long turns, one "Reply ready"
       * at the end). The built-in start/composing/end duplicated that, and
       * the throttled "composing" re-fired every 7s (MESSAGE_UPDATE_INTERVAL)
       * = obsessive screen-reader repetition (Kade's report). Silenced to ''
       * so the SSE handlers keep calling them harmlessly; restore the
       * localize() calls to revert. summarize_* stay (infrequent + useful). */
      start: '',
      end: '',
      composing: '',
      summarize_started: localize('com_a11y_summarize_started'),
      summarize_completed: localize('com_a11y_summarize_completed'),
      summarize_failed: localize('com_a11y_summarize_failed'),
    }),
    [localize],
  );

  const showStatus = useCallback((message: string) => {
    statusTextRef.current = message;
    setStatusMessage(message);
    statusTimeoutRef.current = setTimeout(() => {
      statusTextRef.current = '';
      setStatusMessage('');
    }, STATUS_TTL_MS);
  }, []);

  /** A new status is written at once. Only when the same words are already showing is the
   *  region cleared first and re-written a moment later, so the repeat is still spoken. */
  const announceStatus = useCallback(
    (message: string) => {
      if (statusTimeoutRef.current) {
        clearTimeout(statusTimeoutRef.current);
      }

      if (statusTextRef.current !== message) {
        showStatus(message);
        return;
      }

      statusTextRef.current = '';
      setStatusMessage('');
      statusTimeoutRef.current = setTimeout(() => showStatus(message), STATUS_REPEAT_GAP_MS);
    },
    [showStatus],
  );

  /** Each announcement is its own line: one never overwrites another, the same words twice
   *  are two lines, and each line leaves after a while instead of sitting at the end of the
   *  page for browse mode to find. */
  const announceLog = useCallback((message: string) => {
    nextLogIdRef.current += 1;
    const id = nextLogIdRef.current;
    setLogEntries((entries) => [...entries.slice(-(LOG_MAX - 1)), { id, text: message }]);

    const ttl = Math.min(
      LOG_TTL_MAX_MS,
      Math.max(LOG_TTL_MIN_MS, message.length * LOG_TTL_PER_CHAR_MS),
    );
    const timer = setTimeout(() => {
      logTimersRef.current.delete(timer);
      setLogEntries((entries) =>
        entries.some((entry) => entry.id === id)
          ? entries.filter((entry) => entry.id !== id)
          : entries,
      );
    }, ttl);
    logTimersRef.current.add(timer);
  }, []);

  const announcePolite = useCallback(
    ({ message, isStatus = false }: AnnounceOptions) => {
      /* Event keys ('start', 'composing', ...) are status-only; a reply whose whole text is
       * "end" must still be announced. */
      const finalMessage = scrubAnnouncement(isStatus ? (events[message] ?? message) : message);

      /* Silenced events and empty scrubs must not wipe a status that is still being read. */
      if (!finalMessage) {
        return;
      }

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
    const logTimers = logTimersRef.current;
    return () => {
      if (statusTimeoutRef.current) {
        clearTimeout(statusTimeoutRef.current);
      }
      logTimers.forEach((timer) => clearTimeout(timer));
      logTimers.clear();
    };
  }, []);

  return (
    <AnnouncerContext.Provider value={contextValue}>
      {children}
      <Announcer statusMessage={statusMessage} logEntries={logEntries} />
    </AnnouncerContext.Provider>
  );
};

export default LiveAnnouncer;
