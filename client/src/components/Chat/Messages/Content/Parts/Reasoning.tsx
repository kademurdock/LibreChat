import { memo, useMemo, useState, useCallback, useRef, useId } from 'react';
import { useAtomValue } from 'jotai';
import { ContentTypes } from 'librechat-data-provider';
import type { MouseEvent, FocusEvent } from 'react';
import { ThinkingContent, ThinkingButton, FloatingThinkingBar } from './Thinking';
import { useLocalize, useExpandCollapse } from '~/hooks';
import { showThinkingAtom } from '~/store/showThinking';
import { useMessageContext } from '~/Providers';
import { cn } from '~/utils';

type ReasoningProps = {
  reasoning: string;
  isLast: boolean;
};

/** localStorage key tracking whether the user manually collapsed a reasoning bubble. */
const REASONING_COLLAPSED_KEY = 'reasoningUserCollapsed';

/**
 * KADE PATCH (2026-07-01): per-bubble expansion memory, held at module level,
 * keyed by message + content-part index. `useState` re-runs its lazy
 * initializer on every MOUNT, so any re-mount of this component while
 * reasoning deltas are still streaming (message re-keying on finalization,
 * list re-renders, etc.) used to snap a just-collapsed bubble back open.
 * Consulting this map first means the user's explicit toggle on a specific
 * bubble always outlives the component instance — a collapsed bubble can
 * never re-expand on its own, no matter how many times React re-mounts it.
 */
const expansionMemory = new Map<string, boolean>();
const EXPANSION_MEMORY_MAX = 500;

function rememberExpansion(key: string, value: boolean) {
  if (expansionMemory.size >= EXPANSION_MEMORY_MAX && !expansionMemory.has(key)) {
    expansionMemory.clear();
  }
  expansionMemory.set(key, value);
}

/**
 * Reasoning Component (MODERN SYSTEM)
 *
 * Used for structured content parts with ContentTypes.THINK type.
 * This handles modern message format where content is an array of typed parts.
 *
 * Pattern: `{ content: [{ type: "think", think: "<think>content</think>" }, ...] }`
 *
 * Used by:
 * - ContentParts.tsx → Part.tsx for structured messages
 * - Agent/Assistant responses (OpenAI Assistants, custom agents)
 * - O-series models (o1, o3) with reasoning capabilities
 * - Modern Claude responses with thinking blocks
 *
 * Key differences from legacy Thinking.tsx:
 * - Works with content parts array instead of plain text
 * - Strips `<think>` tags instead of `:::thinking:::` markers
 * - Each THINK part has its own independent toggle button
 * - Can be interleaved with other content types
 *
 * For legacy text-based messages, see Thinking.tsx component.
 *
 * KADE PATCH C2: respect the user's last manual collapse action.
 * If `showThinking` is true but the user has collapsed a bubble, new bubbles
 * start collapsed. Expanding a bubble clears the flag so next bubble opens.
 */
const Reasoning = memo(({ reasoning, isLast }: ReasoningProps) => {
  const contentId = useId();
  const localize = useLocalize();
  const showThinking = useAtomValue(showThinkingAtom);
  const { isSubmitting, isLatestMessage, nextType, messageId, partIndex } = useMessageContext();
  /** Stable identity for THIS bubble across re-mounts (see expansionMemory above). */
  const memoryKey = `${messageId}:${partIndex ?? 0}`;
  const [isExpanded, setIsExpanded] = useState(() => {
    const remembered = expansionMemory.get(memoryKey);
    if (remembered !== undefined) return remembered;
    if (!showThinking) return false;
    try {
      return localStorage.getItem(REASONING_COLLAPSED_KEY) !== 'true';
    } catch {
      return true;
    }
  });
  const [isBarVisible, setIsBarVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { style: expandStyle, ref: expandRef } = useExpandCollapse(isExpanded);

  // Strip <think> tags from the reasoning content (modern format)
  const reasoningText = useMemo(() => {
    return reasoning
      .replace(/^<think>\s*/, '')
      .replace(/\s*<\/think>$/, '')
      .trim();
  }, [reasoning]);

  const handleClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      setIsExpanded((prev) => {
        const next = !prev;
        rememberExpansion(memoryKey, next);
        try {
          localStorage.setItem(REASONING_COLLAPSED_KEY, next ? 'false' : 'true');
        } catch {}
        return next;
      });
    },
    [memoryKey],
  );

  const handleFocus = useCallback(() => {
    setIsBarVisible(true);
  }, []);

  const handleBlur = useCallback((e: FocusEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setIsBarVisible(false);
    }
  }, []);

  const handleMouseEnter = useCallback(() => {
    setIsBarVisible(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (!containerRef.current?.contains(document.activeElement)) {
      setIsBarVisible(false);
    }
  }, []);

  const effectiveIsSubmitting = isLatestMessage ? isSubmitting : false;

  const label = useMemo(
    () =>
      effectiveIsSubmitting && isLast ? localize('com_ui_thinking') : localize('com_ui_thoughts'),
    [effectiveIsSubmitting, localize, isLast],
  );

  if (!reasoningText) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className="group/reasoning"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <div className="group/thinking-container">
        <div className="mb-2 pb-2 pt-2">
          <ThinkingButton
            isExpanded={isExpanded}
            onClick={handleClick}
            label={label}
            content={reasoningText}
            contentId={contentId}
          />
        </div>
        <div
          id={contentId}
          role="group"
          aria-label={label}
          aria-hidden={!isExpanded || undefined}
          className={cn(nextType !== ContentTypes.THINK && isExpanded && 'mb-4')}
          style={expandStyle}
        >
          <div className="relative overflow-hidden" ref={expandRef}>
            <ThinkingContent>{reasoningText}</ThinkingContent>
            <FloatingThinkingBar
              isVisible={isBarVisible && isExpanded}
              isExpanded={isExpanded}
              onClick={handleClick}
              content={reasoningText}
              contentId={contentId}
            />
          </div>
        </div>
      </div>
    </div>
  );
});

export default Reasoning;
